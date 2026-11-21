/**
 * Local storage of Aula data, so it can be read without Aula and kept after
 * Aula drops it. Rows are keyed by parent: every read and write goes through
 * `forParent(parentId)`. The one read across parents is `sharedWith`: a
 * read-only view of what a parent chose to share (`shares`), without the
 * items the viewer has stored themselves.
 *
 * Env:
 *   AULA_MCP_STORAGE      — `sqlite` (default), `postgres`, or `none` to turn
 *                           local storage off
 *   AULA_MCP_SQLITE_PATH  — SQLite file (default <AULA_MCP_DIR>/aula.db)
 *   AULA_MCP_DATABASE_URL — PostgreSQL connection URL; required for postgres
 *   AULA_MCP_STORAGE_KEY  — base64 key the stored data is encrypted with
 *                           (default: generated into <AULA_MCP_DIR>/storage.key)
 *   AULA_MCP_STORAGE_PREVIOUS_KEYS — earlier keys, which still open the rows
 *                           they sealed until reencrypt() seals them again
 *   AULA_MCP_STORAGE_IMPORT — `0` to not import the SQLite file when
 *                           switching to postgres (see openStorage)
 *   AULA_MCP_AUDIT_DAYS   — days the audit log keeps (default 30)
 *
 * Kept forever: nothing is deleted unless a parent deletes it. The audit log
 * is the exception: it keeps AULA_MCP_AUDIT_DAYS.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  keyId,
  loadStorageKeys,
  type ParentCipher,
  parentCipher,
  type StorageKeys,
} from './storage-crypto.ts';
import { postgresDriver, type SqlDriver, sqliteDriver } from './storage-sql.ts';

/** The parent id rows are stored under in single-parent mode. */
export const SINGLE_PARENT_ID = 'default';

/** What a stored item is. */
export const ITEM_KINDS = [
  'message_thread',
  'message',
  'post',
  'notification',
  'calendar_event',
  'presence',
  'weekly_plan',
  'task',
  'contact',
  'group',
  'gallery_album',
  'gallery_media',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface ItemInput {
  kind: ItemKind;
  /** Aula's id for it, unique within the kind. */
  id: string;
  childId?: string | null;
  /** When it happened in Aula (sent, posted, starts). */
  occurredAt?: Date | number | string | null;
  /** The item as Aula returned it. Stored encrypted. */
  data: unknown;
}

export interface StoredItem {
  kind: ItemKind;
  id: string;
  childId: string | null;
  /** Unix seconds. */
  occurredAt: number | null;
  firstSeenAt: number;
  updatedAt: number;
  data: unknown;
}

export interface KindStats {
  kind: ItemKind;
  count: number;
  oldest: number | null;
  newest: number | null;
  lastUpdated: number;
}

export interface ListQuery {
  kind?: ItemKind;
  childId?: string;
  /** Unix seconds, inclusive. */
  since?: number;
  until?: number;
  /** Ids that start with this, e.g. `123:` for the messages of thread 123. */
  idPrefix?: string;
  limit?: number;
  offset?: number;
}

/** Where a sync job for one parent stands. Times are unix seconds. */
export interface SyncState {
  job: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  /** Failures in a row; 0 after a success. */
  failures: number;
  lastError: string | null;
  fetched: number;
  changed: number;
}

/** What the audit log records: the processes and actions, never Aula content. */
export const AUDIT_CATEGORIES = ['sync', 'aula', 'account', 'sharing', 'data', 'storage'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Counts, ids, short codes and error messages only; strings are cut to 300 characters. */
export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  category: AuditCategory;
  /** The job or action, e.g. `messages`, `mark_read`, `login`. */
  action: string;
  ok: boolean;
  durationMs?: number | null;
  details?: AuditDetails;
}

export interface AuditEvent extends Required<AuditEntry> {
  id: string;
  /** Unix milliseconds. */
  at: number;
}

export interface AuditQuery {
  category?: AuditCategory;
  ok?: boolean;
  /** Unix milliseconds: only events before it, for the next page. */
  before?: number;
  limit?: number;
  /** Events to skip, newest first, for numbered pages. */
  offset?: number;
}

/** Which key seals a parent's rows, and how many still wait for it. */
export interface KeyStatus {
  keyId: string;
  previousKeys: number;
  /** Rows sealed with an earlier key, or before key ids. */
  stale: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
let lastAuditAt = 0;

export interface StorageInfo {
  type: 'sqlite' | 'postgres';
  /** Where it is, without credentials. */
  location: string;
}

/** A parent who shares their data with the viewer. */
export interface SharedFrom {
  ownerId: string;
  /** The owner's name when they shared, for display only. */
  ownerName: string;
  /** Unix seconds. */
  since: number;
}

/** Someone a parent shares their data with, by the email they sign in with. */
export interface ShareGrant {
  email: string;
  /** They have signed in with that email since, so the share is in use. */
  active: boolean;
  /** Unix seconds. */
  since: number;
}

export interface Storage {
  readonly info: StorageInfo;
  forParent(parentId: string): ParentStorage;
  /** Who shares with whom. */
  readonly shares: Shares;
  /** The secret links to a parent's calendar feed. */
  readonly feeds: FeedTokens;
  /**
   * The owner's items that the viewer has not stored themselves, read-only;
   * null unless the owner shares with the viewer.
   */
  sharedWith(viewerId: string, ownerId: string): Promise<ParentStorage | null>;
  /** Every parent with stored data. */
  parents(): Promise<string[]>;
  /**
   * Seals every row not sealed with the current key again, after a key
   * change. Rows no key opens are left as they are and counted.
   */
  reencrypt(): Promise<{ parents: number; reencrypted: number; unreadable: number }>;
  close(): Promise<void>;
}

export class StorageConfigError extends Error {
  override name = 'StorageConfigError';
}

/**
 * Opens and migrates the configured storage; null when it is turned off.
 *
 * Switching from sqlite to postgres moves the data: when the SQLite file
 * (AULA_MCP_SQLITE_PATH, default <AULA_MCP_DIR>/aula.db) is there, its rows
 * are copied into postgres before the server starts, and the file is renamed
 * to <file>.imported so it is not copied again. Rows postgres already has are
 * kept. The rows stay sealed with the key that wrote them; give that key as a
 * previous key (the old key file is used by itself) and reencrypt() seals
 * them with the new one.
 */
export async function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage | null> {
  const type = env.AULA_MCP_STORAGE ?? 'sqlite';
  const dir = env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  if (type === 'none') return null;
  if (type !== 'sqlite' && type !== 'postgres') {
    throw new StorageConfigError(
      `AULA_MCP_STORAGE must be sqlite, postgres or none, not "${type}".`,
    );
  }
  const keys = await loadStorageKeys(env, join(dir, 'storage.key'));
  const path = env.AULA_MCP_SQLITE_PATH ?? join(dir, 'aula.db');
  const options = { auditDays: auditDays(env.AULA_MCP_AUDIT_DAYS) };
  if (type === 'postgres') {
    const url = env.AULA_MCP_DATABASE_URL;
    if (!url)
      throw new StorageConfigError('AULA_MCP_STORAGE=postgres needs AULA_MCP_DATABASE_URL.');
    const driver = postgresDriver(url);
    if (env.AULA_MCP_STORAGE_IMPORT !== '0' && existsSync(path)) {
      const { importSqlite } = await import('./storage-copy.ts');
      await importSqlite(path, driver, keys);
    }
    return createStorage(driver, keys, { type, location: redactUrl(url) }, options);
  }
  return createStorage(sqliteDriver(path), keys, { type, location: path }, options);
}

export async function createStorage(
  driver: SqlDriver,
  storageKeys: Buffer | StorageKeys,
  info: StorageInfo,
  options: { auditDays?: number } = {},
): Promise<Storage> {
  await migrate(driver);
  const shares = new Shares(driver);
  const feeds = new FeedTokens(driver);
  const keys = Buffer.isBuffer(storageKeys) ? { current: storageKeys, previous: [] } : storageKeys;
  const audit = { days: options.auditDays ?? 30, previousKeys: keys.previous.length };
  const forParent = (parentId: string) =>
    new ParentStorage(driver, parentCipher(keys, parentId), parentId, null, audit);
  const parents = async () =>
    (
      await driver.all<{ parent_id: string }>(
        'SELECT DISTINCT parent_id FROM items ORDER BY parent_id',
      )
    ).map((row) => row.parent_id);
  return {
    info,
    forParent,
    shares,
    feeds,
    sharedWith: async (viewerId, ownerId) =>
      viewerId !== ownerId && (await shares.allows(ownerId, viewerId))
        ? new ParentStorage(driver, parentCipher(keys, ownerId), ownerId, viewerId, audit)
        : null,
    parents,
    reencrypt: async () => {
      const result = { parents: 0, reencrypted: 0, unreadable: 0 };
      for (const parentId of await parents()) {
        const store = forParent(parentId);
        const started = Date.now();
        const done = await store.reencrypt();
        if (done.reencrypted === 0 && done.unreadable === 0) continue;
        result.parents += 1;
        result.reencrypted += done.reencrypted;
        result.unreadable += done.unreadable;
        await store
          .audit({
            category: 'storage',
            action: 'reencrypt',
            ok: done.unreadable === 0,
            durationMs: Date.now() - started,
            details: { keyId: keyId(keys.current), ...done },
          })
          .catch(() => {});
      }
      return result;
    },
    close: () => driver.close(),
  };
}

function auditDays(value: string | undefined): number {
  const days = Number(value);
  return value && Number.isFinite(days) && days > 0 ? days : 30;
}

/**
 * Sharing is granted by email, the one thing a parent knows about the other
 * parent's sign-in. The grant is tied to the viewer's parent id the first
 * time they sign in with a verified email that matches (`claim`), and from
 * then on only that parent id can read it.
 */
/** A parent's calendar feed link, without the secret. Times are unix seconds. */
export interface FeedStatus {
  since: number;
  lastUsedAt: number | null;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * One secret link per parent to read their stored calendar from a calendar
 * app, which cannot sign in. Only a hash of the secret is stored: the link is
 * shown once, and a new one replaces it.
 */
export class FeedTokens {
  constructor(private readonly db: SqlDriver) {}

  /** A new secret for the parent; the previous one stops working. */
  async create(parentId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.run(
      `INSERT INTO feed_tokens (parent_id, token_hash, created_at, last_used_at)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (parent_id) DO UPDATE SET token_hash = excluded.token_hash,
         created_at = excluded.created_at, last_used_at = NULL`,
      [parentId, hashToken(token), Math.floor(Date.now() / 1000)],
    );
    return token;
  }

  /** Resolves to whether there was a link to remove. */
  async revoke(parentId: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM feed_tokens WHERE parent_id = $1', [parentId])) > 0;
  }

  async status(parentId: string): Promise<FeedStatus | null> {
    const [row] = await this.db.all<Record<string, unknown>>(
      'SELECT created_at, last_used_at FROM feed_tokens WHERE parent_id = $1',
      [parentId],
    );
    return row
      ? { since: Number(row.created_at), lastUsedAt: numberOrNull(row.last_used_at) }
      : null;
  }

  /** The parent the secret belongs to, or null; notes that it was used. */
  async resolve(token: string): Promise<string | null> {
    if (!/^[\w-]{43}$/.test(token)) return null;
    const hash = hashToken(token);
    const [row] = await this.db.all<{ parent_id: string }>(
      'SELECT parent_id FROM feed_tokens WHERE token_hash = $1',
      [hash],
    );
    if (!row) return null;
    await this.db.run('UPDATE feed_tokens SET last_used_at = $1 WHERE token_hash = $2', [
      Math.floor(Date.now() / 1000),
      hash,
    ]);
    return row.parent_id;
  }
}

export class Shares {
  constructor(private readonly db: SqlDriver) {}

  /** Whom the owner shares with. */
  async granted(ownerId: string): Promise<ShareGrant[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      'SELECT email, viewer_id, created_at FROM shares WHERE owner_id = $1 ORDER BY created_at, email',
      [ownerId],
    );
    return rows.map((row) => ({
      email: String(row.email),
      active: row.viewer_id !== null && row.viewer_id !== undefined,
      since: Number(row.created_at),
    }));
  }

  /** Shares the owner's data with whoever signs in with `email`. */
  async grant(ownerId: string, ownerName: string, email: string): Promise<void> {
    await this.db.run(
      `INSERT INTO shares (owner_id, email, owner_name, viewer_id, created_at)
       VALUES ($1, $2, $3, NULL, $4)
       ON CONFLICT (owner_id, email) DO UPDATE SET owner_name = excluded.owner_name`,
      [ownerId, normalEmail(email), ownerName, Math.floor(Date.now() / 1000)],
    );
  }

  /** Stops sharing with `email`. Resolves to whether there was such a share. */
  async revoke(ownerId: string, email: string): Promise<boolean> {
    return (
      (await this.db.run('DELETE FROM shares WHERE owner_id = $1 AND email = $2', [
        ownerId,
        normalEmail(email),
      ])) > 0
    );
  }

  /** Ties the shares waiting for `email` to the parent who signed in with it. */
  async claim(viewerId: string, email: string): Promise<number> {
    return this.db.run(
      'UPDATE shares SET viewer_id = $1 WHERE email = $2 AND viewer_id IS NULL AND owner_id <> $1',
      [viewerId, normalEmail(email)],
    );
  }

  /** The parents who share with the viewer. */
  async owners(viewerId: string): Promise<SharedFrom[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      'SELECT owner_id, owner_name, created_at FROM shares WHERE viewer_id = $1 ORDER BY created_at, owner_id',
      [viewerId],
    );
    return rows.map((row) => ({
      ownerId: String(row.owner_id),
      ownerName: String(row.owner_name),
      since: Number(row.created_at),
    }));
  }

  async allows(ownerId: string, viewerId: string): Promise<boolean> {
    const rows = await this.db.all<{ owner_id: string }>(
      'SELECT owner_id FROM shares WHERE owner_id = $1 AND viewer_id = $2',
      [ownerId, viewerId],
    );
    return rows.length > 0;
  }
}

export function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class ParentStorage {
  constructor(
    private readonly db: SqlDriver,
    private readonly cipher: ParentCipher,
    readonly parentId: string,
    /** A shared view: hide what this parent has stored, and change nothing. */
    readonly viewerId: string | null = null,
    private readonly auditOptions: { days: number; previousKeys: number } = {
      days: 30,
      previousKeys: 0,
    },
  ) {}

  /** Read-only: a view of another parent's data. */
  get shared(): boolean {
    return this.viewerId !== null;
  }

  /**
   * The rows this storage reads: the parent's, and in a shared view only
   * those the viewer has no row of the same kind and id for. Adds the parent
   * id as $1, so call it first.
   */
  private visible(params: Array<string | number>): string {
    params.push(this.parentId);
    if (this.viewerId === null) return 'items.parent_id = $1';
    params.push(this.viewerId);
    return `items.parent_id = $1 AND NOT EXISTS (SELECT 1 FROM items mine
      WHERE mine.parent_id = $${params.length} AND mine.kind = items.kind AND mine.id = items.id)`;
  }

  private writable(): void {
    if (this.viewerId !== null) throw new Error('Shared data is read-only.');
  }

  /** Inserts new items and updates changed ones; unchanged ones are left alone. */
  async put(items: ItemInput[]): Promise<{ changed: number; unchanged: number }> {
    this.writable();
    const now = Math.floor(Date.now() / 1000);
    let changed = 0;
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        const plaintext = JSON.stringify(item.data ?? null);
        changed += await tx.run(
          `INSERT INTO items (parent_id, kind, id, child_id, occurred_at, content_hash, payload, first_seen_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           ON CONFLICT (parent_id, kind, id) DO UPDATE SET
             child_id = excluded.child_id,
             occurred_at = excluded.occurred_at,
             content_hash = excluded.content_hash,
             payload = excluded.payload,
             updated_at = excluded.updated_at
           WHERE items.content_hash <> excluded.content_hash`,
          [
            this.parentId,
            item.kind,
            item.id,
            item.childId ?? null,
            toEpoch(item.occurredAt),
            this.cipher.hash(plaintext),
            this.cipher.seal(this.aad(item.kind, item.id), plaintext),
            now,
          ],
        );
      }
    });
    return { changed, unchanged: items.length - changed };
  }

  async get(kind: ItemKind, id: string): Promise<StoredItem | null> {
    const params: Array<string | number> = [];
    const where = this.visible(params);
    params.push(kind, id);
    const rows = await this.db.all<ItemRow>(
      `SELECT ${COLUMNS} FROM items WHERE ${where} AND kind = $${params.length - 1} AND id = $${params.length}`,
      params,
    );
    return rows[0] ? this.decode(rows[0]) : null;
  }

  /** Newest first. */
  async list(query: ListQuery = {}): Promise<StoredItem[]> {
    const params: Array<string | number> = [];
    const where = [this.visible(params)];
    const add = (clause: string, value: string | number) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (query.kind) add('kind = ?', query.kind);
    if (query.childId) add('child_id = ?', query.childId);
    if (query.since !== undefined) add('occurred_at >= ?', query.since);
    if (query.until !== undefined) add('occurred_at <= ?', query.until);
    if (query.idPrefix)
      add("id LIKE ? ESCAPE '\\'", `${query.idPrefix.replace(/[\\%_]/g, '\\$&')}%`);
    params.push(Math.min(Math.max(query.limit ?? 50, 1), 500), Math.max(query.offset ?? 0, 0));
    const rows = await this.db.all<ItemRow>(
      `SELECT ${COLUMNS} FROM items WHERE ${where.join(' AND ')}
       ORDER BY occurred_at IS NULL, occurred_at DESC, updated_at DESC, id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((row) => this.decode(row));
  }

  /**
   * When each item of these kinds happened, between `since` and `until`
   * (unix seconds, inclusive). Reads only kind and time, never the content.
   */
  async occurrences(
    kinds: readonly ItemKind[],
    since: number,
    until: number,
  ): Promise<Array<{ kind: ItemKind; at: number }>> {
    if (!kinds.length) return [];
    const params: Array<string | number> = [];
    const where = this.visible(params);
    params.push(since, until);
    const first = params.length + 1;
    params.push(...kinds);
    const marks = kinds.map((_, i) => `$${first + i}`).join(', ');
    const rows = await this.db.all<{ kind: ItemKind; occurred_at: unknown }>(
      `SELECT kind, occurred_at FROM items
       WHERE ${where} AND occurred_at >= $${first - 2} AND occurred_at <= $${first - 1} AND kind IN (${marks})`,
      params,
    );
    return rows.map((row) => ({ kind: row.kind, at: Number(row.occurred_at) }));
  }

  async stats(): Promise<KindStats[]> {
    const params: Array<string | number> = [];
    const where = this.visible(params);
    const rows = await this.db.all<{
      kind: ItemKind;
      count: unknown;
      oldest: unknown;
      newest: unknown;
      last_updated: unknown;
    }>(
      `SELECT kind, COUNT(*) AS count, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest,
              MAX(updated_at) AS last_updated
       FROM items WHERE ${where} GROUP BY kind ORDER BY kind`,
      params,
    );
    return rows.map((row) => ({
      kind: row.kind,
      count: Number(row.count),
      oldest: numberOrNull(row.oldest),
      newest: numberOrNull(row.newest),
      lastUpdated: Number(row.last_updated),
    }));
  }

  /**
   * Deletes this parent's items: one item (kind and id), one kind, or all.
   * Resolves to how many.
   */
  async delete(options: { kind?: ItemKind; id?: string } = {}): Promise<number> {
    this.writable();
    if (options.kind && options.id !== undefined) {
      return this.db.run('DELETE FROM items WHERE parent_id = $1 AND kind = $2 AND id = $3', [
        this.parentId,
        options.kind,
        options.id,
      ]);
    }
    return options.kind
      ? this.db.run('DELETE FROM items WHERE parent_id = $1 AND kind = $2', [
          this.parentId,
          options.kind,
        ])
      : this.db.run('DELETE FROM items WHERE parent_id = $1', [this.parentId]);
  }

  async syncStates(): Promise<SyncState[]> {
    // How the owner's sync is doing is not part of what they share.
    if (this.viewerId !== null) return [];
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT job, last_run_at, last_success_at, next_run_at, failures, last_error, fetched, changed
       FROM sync_state WHERE parent_id = $1 ORDER BY job`,
      [this.parentId],
    );
    return rows.map((row) => ({
      job: String(row.job),
      lastRunAt: numberOrNull(row.last_run_at),
      lastSuccessAt: numberOrNull(row.last_success_at),
      nextRunAt: numberOrNull(row.next_run_at),
      failures: Number(row.failures),
      lastError: (row.last_error as string | null) ?? null,
      fetched: Number(row.fetched),
      changed: Number(row.changed),
    }));
  }

  async saveSyncState(state: SyncState): Promise<void> {
    this.writable();
    await this.db.run(
      `INSERT INTO sync_state (parent_id, job, last_run_at, last_success_at, next_run_at, failures, last_error, fetched, changed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (parent_id, job) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         last_success_at = excluded.last_success_at,
         next_run_at = excluded.next_run_at,
         failures = excluded.failures,
         last_error = excluded.last_error,
         fetched = excluded.fetched,
         changed = excluded.changed`,
      [
        this.parentId,
        state.job,
        state.lastRunAt,
        state.lastSuccessAt,
        state.nextRunAt,
        state.failures,
        state.lastError,
        state.fetched,
        state.changed,
      ],
    );
  }

  /**
   * Records a process or action in this parent's audit log, and drops what
   * is older than the log keeps. Never pass Aula content: counts, ids and
   * error messages only.
   */
  async audit(entry: AuditEntry): Promise<void> {
    this.writable();
    // A millisecond after the last entry at least, so entries keep their order.
    const at = Math.max(Date.now(), lastAuditAt + 1);
    lastAuditAt = at;
    const details: AuditDetails = {};
    for (const [key, value] of Object.entries(entry.details ?? {})) {
      if (value === undefined) continue;
      details[key] = typeof value === 'string' ? value.slice(0, 300) : value;
    }
    await this.db.run(
      `INSERT INTO audit_log (parent_id, id, at, category, action, ok, duration_ms, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        this.parentId,
        randomUUID(),
        at,
        entry.category,
        entry.action.slice(0, 64),
        entry.ok ? 1 : 0,
        entry.durationMs === undefined || entry.durationMs === null
          ? null
          : Math.round(entry.durationMs),
        JSON.stringify(details),
      ],
    );
    await this.db.run('DELETE FROM audit_log WHERE parent_id = $1 AND at < $2', [
      this.parentId,
      at - this.auditOptions.days * DAY_MS,
    ]);
  }

  /** Newest first. Empty in a shared view: the owner's log is not shared. */
  async auditLog(query: AuditQuery = {}): Promise<AuditEvent[]> {
    if (this.viewerId !== null) return [];
    const { where, params } = this.auditWhere(query);
    params.push(Math.min(Math.max(query.limit ?? 100, 1), 500));
    const limit = `$${params.length}`;
    params.push(Math.max(Math.floor(query.offset ?? 0), 0));
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT id, at, category, action, ok, duration_ms, details FROM audit_log
       WHERE ${where} ORDER BY at DESC, id LIMIT ${limit} OFFSET $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      id: String(row.id),
      at: Number(row.at),
      category: row.category as AuditCategory,
      action: String(row.action),
      ok: Number(row.ok) === 1,
      durationMs: numberOrNull(row.duration_ms),
      details: JSON.parse(String(row.details)) as AuditDetails,
    }));
  }

  /** How many events match, ignoring `limit` and `offset`. */
  async auditCount(query: Omit<AuditQuery, 'limit' | 'offset'> = {}): Promise<number> {
    if (this.viewerId !== null) return 0;
    const { where, params } = this.auditWhere(query);
    const rows = await this.db.all<{ count: unknown }>(
      `SELECT COUNT(*) AS count FROM audit_log WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private auditWhere(query: AuditQuery): { where: string; params: Array<string | number> } {
    const params: Array<string | number> = [this.parentId];
    const where = ['parent_id = $1'];
    const add = (clause: string, value: string | number) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (query.category) add('category = ?', query.category);
    if (query.ok !== undefined) add('ok = ?', query.ok ? 1 : 0);
    if (query.before !== undefined) add('at < ?', query.before);
    return { where: where.join(' AND '), params };
  }

  /** Which key seals this parent's rows. Reads no content. */
  async keyStatus(): Promise<KeyStatus> {
    const rows = await this.db.all<{ count: unknown }>(
      'SELECT COUNT(*) AS count FROM items WHERE parent_id = $1 AND payload NOT LIKE $2',
      [this.parentId, `${this.cipher.currentPrefix}%`],
    );
    return {
      keyId: this.cipher.currentPrefix.split('.')[1] ?? '',
      previousKeys: this.auditOptions.previousKeys,
      stale: Number(rows[0]?.count ?? 0),
    };
  }

  /** Seals this parent's rows not sealed with the current key again. */
  async reencrypt(): Promise<{ reencrypted: number; unreadable: number }> {
    this.writable();
    let reencrypted = 0;
    let unreadable = 0;
    let after: [string, string] = ['', ''];
    for (;;) {
      const rows = await this.db.all<{ kind: string; id: string; payload: string }>(
        `SELECT kind, id, payload FROM items
         WHERE parent_id = $1 AND payload NOT LIKE $2 AND (kind > $3 OR (kind = $3 AND id > $4))
         ORDER BY kind, id LIMIT 200`,
        [this.parentId, `${this.cipher.currentPrefix}%`, after[0], after[1]],
      );
      for (const row of rows) {
        let plaintext: string;
        try {
          plaintext = this.cipher.open(this.aad(row.kind, row.id), row.payload);
        } catch {
          unreadable += 1;
          continue;
        }
        // Only if the row has not changed since it was read.
        reencrypted += await this.db.run(
          `UPDATE items SET payload = $1, content_hash = $2
           WHERE parent_id = $3 AND kind = $4 AND id = $5 AND payload = $6`,
          [
            this.cipher.seal(this.aad(row.kind, row.id), plaintext),
            this.cipher.hash(plaintext),
            this.parentId,
            row.kind,
            row.id,
            row.payload,
          ],
        );
      }
      const last = rows.at(-1);
      if (!last || rows.length < 200) return { reencrypted, unreadable };
      after = [last.kind, last.id];
    }
  }

  private aad(kind: string, id: string): string {
    return `${this.parentId}\n${kind}\n${id}`;
  }

  private decode(row: ItemRow): StoredItem {
    return {
      kind: row.kind,
      id: row.id,
      childId: row.child_id,
      occurredAt: numberOrNull(row.occurred_at),
      firstSeenAt: Number(row.first_seen_at),
      updatedAt: Number(row.updated_at),
      data: JSON.parse(this.cipher.open(this.aad(row.kind, row.id), row.payload)),
    };
  }
}

interface ItemRow {
  [column: string]: unknown;
  kind: ItemKind;
  id: string;
  child_id: string | null;
  occurred_at: unknown;
  first_seen_at: unknown;
  updated_at: unknown;
  payload: string;
}

const COLUMNS = 'kind, id, child_id, occurred_at, first_seen_at, updated_at, payload';

/** Applied in order, once each. Never edit one that has shipped; add a new one. */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE items (
       parent_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       id TEXT NOT NULL,
       child_id TEXT,
       occurred_at BIGINT,
       content_hash TEXT NOT NULL,
       payload TEXT NOT NULL,
       first_seen_at BIGINT NOT NULL,
       updated_at BIGINT NOT NULL,
       PRIMARY KEY (parent_id, kind, id)
     )`,
    'CREATE INDEX items_by_time ON items (parent_id, kind, occurred_at)',
  ],
  [
    // Error messages only, never Aula content, so it is not encrypted.
    `CREATE TABLE sync_state (
       parent_id TEXT NOT NULL,
       job TEXT NOT NULL,
       last_run_at BIGINT,
       last_success_at BIGINT,
       next_run_at BIGINT,
       failures INTEGER NOT NULL,
       last_error TEXT,
       fetched INTEGER NOT NULL,
       changed INTEGER NOT NULL,
       PRIMARY KEY (parent_id, job)
     )`,
  ],
  [
    // Who a parent shares their data with: an email until that parent signs
    // in with it, then also their parent id. No Aula content.
    `CREATE TABLE shares (
       owner_id TEXT NOT NULL,
       email TEXT NOT NULL,
       owner_name TEXT NOT NULL,
       viewer_id TEXT,
       created_at BIGINT NOT NULL,
       PRIMARY KEY (owner_id, email)
     )`,
    'CREATE INDEX shares_by_viewer ON shares (viewer_id)',
    'CREATE INDEX shares_by_email ON shares (email)',
  ],
  [
    // What ran and what was done, for each parent: counts, ids and error
    // messages only, never Aula content, so it is not encrypted. `at` is in
    // milliseconds, so events of one run keep their order.
    `CREATE TABLE audit_log (
       parent_id TEXT NOT NULL,
       id TEXT NOT NULL,
       at BIGINT NOT NULL,
       category TEXT NOT NULL,
       action TEXT NOT NULL,
       ok INTEGER NOT NULL,
       duration_ms INTEGER,
       details TEXT NOT NULL,
       PRIMARY KEY (parent_id, id)
     )`,
    'CREATE INDEX audit_by_time ON audit_log (parent_id, at)',
  ],
  [
    // The secret calendar feed link of each parent, as a SHA-256 hash only.
    `CREATE TABLE feed_tokens (
       parent_id TEXT PRIMARY KEY,
       token_hash TEXT NOT NULL UNIQUE,
       created_at BIGINT NOT NULL,
       last_used_at BIGINT
     )`,
  ],
];

async function migrate(db: SqlDriver): Promise<void> {
  await db.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)',
  );
  await db.transaction(async (tx) => {
    // Two servers starting at once must not both migrate.
    if (tx.dialect === 'postgres')
      await tx.run("SELECT pg_advisory_xact_lock(hashtext('aula-mcp-migrate'))");
    const done = new Set(
      (await tx.all<{ version: unknown }>('SELECT version FROM schema_migrations')).map((row) =>
        Number(row.version),
      ),
    );
    for (const [index, statements] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (done.has(version)) continue;
      for (const statement of statements) await tx.run(statement);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        version,
        Math.floor(Date.now() / 1000),
      ]);
    }
  });
}

function toEpoch(value: ItemInput['occurredAt']): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value * 1000
        : Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return 'postgres (URL could not be parsed)';
  }
}
