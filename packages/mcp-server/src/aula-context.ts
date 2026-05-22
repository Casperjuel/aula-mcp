/**
 * Lazy AulaClient + WidgetTokenManager that the MCP tools share. Tokens are
 * loaded on first use and refreshed transparently.
 *
 * The MCP server is deliberately stateless across restarts: it always reads
 * the same EncryptedFileTokenStore that the CLI writes to. This means
 * `aula login` from the terminal "just works" with any running server.
 */

import { type FSWatcher, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AulaHttpClient,
  EncryptedFileTokenStore,
  isTokenExpired,
  KeychainTokenStore,
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
  withFreshTokens,
} from '@aula-mcp/aula-auth';
import {
  AulaClient,
  EasyIqClient,
  EasyIqLektierClient,
  EasyIqSkoleportalClient,
  MeebookClient,
  MinUddannelseClient,
  SystematicClient,
  WidgetTokenManager,
} from '@aula-mcp/aula-client';

export interface AulaContextOptions {
  store?: TokenStore;
  logger?: Logger;
}

export class AulaContext {
  private readonly store: TokenStore;
  private readonly logger: Logger;
  private readonly http: AulaHttpClient;
  // Fields below are declared as `T | undefined` (not just `T?`) so we can
  // explicitly assign `undefined` to invalidate the cache (the strict
  // `exactOptionalPropertyTypes` flag forbids `field = undefined` on `T?`).
  private clientPromise: Promise<AulaClient> | undefined;
  private widgetManagerPromise: Promise<WidgetTokenManager> | undefined;
  private cachedRecord: StoredTokenRecord | undefined;
  /** Guardian user-id from getProfileContext. Used as the
   *  sessionId/sessionUUID/sessionuuid parameter by the third-party
   *  integrations. Stored as string — Aula returns either a numeric id
   *  or an opaque alphanumeric token; we treat it as opaque to match
   *  upstream Python's `str(child["userId"])` handling. */
  private cachedGuardianUserId: string | undefined;
  private tokenFileWatcher: FSWatcher | undefined;
  private tokenFileChangeDebounce: NodeJS.Timeout | undefined;

  constructor(options: AulaContextOptions = {}) {
    this.store = options.store ?? defaultStore();
    this.logger = options.logger ?? silentLogger;
    this.http = new AulaHttpClient({ logger: this.logger });
    this.watchTokenFile();
  }

  /**
   * If the underlying store is file-backed, watch its path and invalidate the
   * cached client whenever the file changes (e.g. an out-of-band `aula login`
   * or `aula refresh-stepup` rotates tokens). Without this, the cached client
   * keeps serving 401/403 against the rotated session until its access token
   * naturally expires (~60min).
   *
   * Best-effort: errors here are non-fatal. The original token-expiry
   * invalidation in `getClient()` is still the backstop.
   *
   * Duck-typed (`'filePath' in store && typeof string`) rather than
   * `instanceof EncryptedFileTokenStore`: Bun's `--compile` bundler can
   * produce two copies of the same class when the package is imported via
   * different specifiers across the bundled graph, breaking `instanceof`
   * silently — the watcher then never gets attached and stale tokens linger.
   */
  private watchTokenFile(): void {
    const filePath = (this.store as { filePath?: unknown }).filePath;
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    const path = filePath;
    try {
      this.tokenFileWatcher = watch(path, { persistent: false }, (eventType) => {
        // fs.watch tends to fire multiple events per write (the writer does
        // write + close + chmod). Debounce so we only invalidate once.
        if (this.tokenFileChangeDebounce) clearTimeout(this.tokenFileChangeDebounce);
        this.tokenFileChangeDebounce = setTimeout(() => {
          this.tokenFileChangeDebounce = undefined;
          this.logger.info('aula-context.token_file_changed_invalidating', {
            path,
            eventType,
          });
          this.invalidate();
        }, 250);
      });
      this.tokenFileWatcher.on('error', (err) => {
        this.logger.warn('aula-context.token_file_watch_error', {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.logger.warn('aula-context.token_file_watch_setup_failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Close the token-file watcher. Tests should call this; long-lived servers
   *  can leave it until process exit. */
  dispose(): void {
    if (this.tokenFileChangeDebounce) {
      clearTimeout(this.tokenFileChangeDebounce);
      this.tokenFileChangeDebounce = undefined;
    }
    this.tokenFileWatcher?.close();
    this.tokenFileWatcher = undefined;
  }

  /**
   * Get the AulaClient, refreshing tokens if expired.
   *
   * Concurrency-safe (J5 fix): the in-flight `clientPromise` is shared across
   * concurrent callers, so a refresh fires once and everyone waits on it.
   *
   * Auto-recovery (Q8): if the cached tokens have expired since the client
   * was built, we drop the cached promise and rebuild — which re-reads the
   * token store from disk. This means a fresh `aula login` from the CLI
   * recovers a server with bad tokens without restarting the server process.
   */
  async getClient(): Promise<AulaClient> {
    if (this.cachedRecord && isTokenExpired(this.cachedRecord.tokens, 60)) {
      this.logger.info('aula-context.token_expired_invalidating');
      this.clientPromise = undefined;
    }
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient().catch((err: unknown) => {
        // On failure, clear the cached promise so the next call retries
        // rather than re-throwing the same stale rejection forever.
        this.clientPromise = undefined;
        throw err;
      });
    }
    return this.clientPromise;
  }

  /** Drop all cached state. Useful for tests; also called when an upstream
   *  401/403 indicates the server's view of our tokens is wrong. */
  invalidate(): void {
    this.clientPromise = undefined;
    this.widgetManagerPromise = undefined;
    this.cachedRecord = undefined;
    this.cachedGuardianUserId = undefined;
  }

  /**
   * Guardian user-id (from `profiles.getProfileContext.data.userId`).
   * Required as the `sessionId` / `sessionUUID` / `sessionuuid` parameter for
   * EasyIQ, Min Uddannelse, and Meebook. Cached after the first call.
   *
   * Per Python `client.py:670/757` — the integration calls fail without it.
   * Aula returns this as either a number or an opaque alphanumeric token;
   * we coerce to string and pass through verbatim.
   */
  async getGuardianUserId(): Promise<string> {
    if (this.cachedGuardianUserId !== undefined) return this.cachedGuardianUserId;
    const client = await this.getClient();
    const ctx = await client.getProfileContext('guardian');
    if (ctx.userId == null || ctx.userId === '') {
      throw new Error('profiles.getProfileContext returned no userId');
    }
    this.cachedGuardianUserId = String(ctx.userId);
    return this.cachedGuardianUserId;
  }

  async getWidgetManager(): Promise<WidgetTokenManager> {
    if (!this.widgetManagerPromise) {
      this.widgetManagerPromise = (async () =>
        new WidgetTokenManager({ client: await this.getClient() }))();
    }
    return this.widgetManagerPromise;
  }

  async getEasyIq(): Promise<EasyIqClient> {
    return new EasyIqClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getEasyIqSkoleportal(): Promise<EasyIqSkoleportalClient> {
    return new EasyIqSkoleportalClient({
      http: this.http,
      widgets: await this.getWidgetManager(),
    });
  }

  async getEasyIqLektier(): Promise<EasyIqLektierClient> {
    return new EasyIqLektierClient({
      http: this.http,
      widgets: await this.getWidgetManager(),
    });
  }

  async getMeebook(): Promise<MeebookClient> {
    return new MeebookClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getMinUddannelse(): Promise<MinUddannelseClient> {
    return new MinUddannelseClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getSystematic(): Promise<SystematicClient> {
    return new SystematicClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  /** The currently-loaded record (after first getClient()). */
  get record(): StoredTokenRecord | undefined {
    return this.cachedRecord;
  }

  private async buildClient(): Promise<AulaClient> {
    // Plain refresh_token grant. The scaarup/aula HA integration has
    // proven empirically that Aula's OAuth server preserves the
    // `aula-sensitive` scope through refresh_token grants — HA reads
    // sensitive endpoints (messaging.getMessagesForThread) for months
    // from a single MitID login using nothing but
    // `grant_type=refresh_token` against simplesaml/.../token.php.
    // Earlier suspicion that step-up assurance was bound to the
    // broker session at unilogin.dk was a misdiagnosis — the 403s we
    // were seeing were the v22→v23 apiVersion deprecation (fixed in
    // 60c4246), not step-up loss. Silent SSO was "working" via side
    // effect (each reauth rebuilt AulaContext via fs.watch
    // invalidation, which re-probed apiVersion to v23). The `aula
    // refresh-stepup` CLI command is kept as a manual recovery tool
    // when the refresh_token chain breaks (e.g. after a long
    // downtime), but the MCP child no longer invokes it.
    const record = await withFreshTokens({
      store: this.store,
      http: this.http,
      logger: this.logger,
    });
    this.cachedRecord = record;
    return new AulaClient({ tokens: record.tokens, http: this.http, logger: this.logger });
  }
}

/**
 * Mirror the CLI's backend selection (apps/cli/src/store.ts) so the server
 * reads from the same place `aula login` writes to:
 *   1. AULA_MCP_NO_KEYCHAIN=1 → file backend regardless of platform.
 *   2. macOS + `security` available → KeychainTokenStore.
 *   3. Everything else → EncryptedFileTokenStore at AULA_MCP_DIR.
 */
function defaultStore(): TokenStore {
  if (KeychainTokenStore.isSupported() && process.env.AULA_MCP_NO_KEYCHAIN !== '1') {
    return new KeychainTokenStore();
  }
  const dir = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}
