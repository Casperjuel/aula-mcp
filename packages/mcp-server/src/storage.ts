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
 *
 * Kept forever: nothing is deleted unless a parent deletes it.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadStorageKey, type ParentCipher, parentCipher } from './storage-crypto.ts';
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
  /**
   * The owner's items that the viewer has not stored themselves, read-only;
   * null unless the owner shares with the viewer.
   */
  sharedWith(viewerId: string, ownerId: string): Promise<ParentStorage | null>;
  /** Every parent with stored data. */
  parents(): Promise<string[]>;
  close(): Promise<void>;
}

export class StorageConfigError extends Error {
  override name = 'StorageConfigError';
}

/** Opens and migrates the configured storage; null when it is turned off. */
export async function openStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage | null> {
  const type = env.AULA_MCP_STORAGE ?? 'sqlite';
  const dir = env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  if (type === 'none') return null;
  if (type !== 'sqlite' && type !== 'postgres') {
    throw new StorageConfigError(
      `AULA_MCP_STORAGE must be sqlite, postgres or none, not "${type}".`,
    );
  }
  const key = await loadStorageKey(env.AULA_MCP_STORAGE_KEY, join(dir, 'storage.key'));
  if (type === 'postgres') {
    const url = env.AULA_MCP_DATABASE_URL;
    if (!url)
      throw new StorageConfigError('AULA_MCP_STORAGE=postgres needs AULA_MCP_DATABASE_URL.');
    return createStorage(postgresDriver(url), key, { type, location: redactUrl(url) });
  }
  const path = env.AULA_MCP_SQLITE_PATH ?? join(dir, 'aula.db');
  return createStorage(sqliteDriver(path), key, { type, location: path });
}

export async function createStorage(
  driver: SqlDriver,
  storageKey: Buffer,
  info: StorageInfo,
): Promise<Storage> {
  await migrate(driver);
  const shares = new Shares(driver);
  return {
    info,
    forParent: (parentId) =>
      new ParentStorage(driver, parentCipher(storageKey, parentId), parentId),
    shares,
    sharedWith: async (viewerId, ownerId) =>
      viewerId !== ownerId && (await shares.allows(ownerId, viewerId))
        ? new ParentStorage(driver, parentCipher(storageKey, ownerId), ownerId, viewerId)
        : null,
    parents: async () =>
      (
        await driver.all<{ parent_id: string }>(
          'SELECT DISTINCT parent_id FROM items ORDER BY parent_id',
        )
      ).map((row) => row.parent_id),
    close: () => driver.close(),
  };
}

/**
 * Sharing is granted by email, the one thing a parent knows about the other
 * parent's sign-in. The grant is tied to the viewer's parent id the first
 * time they sign in with a verified email that matches (`claim`), and from
 * then on only that parent id can read it.
 */
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

  /** Deletes this parent's items, of one kind or all. Resolves to how many. */
  async delete(options: { kind?: ItemKind } = {}): Promise<number> {
    this.writable();
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
