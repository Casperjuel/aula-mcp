/**
 * Local storage of Aula data, so it can be read without Aula and kept after
 * Aula drops it. Rows are keyed by parent: every read and write goes through
 * `forParent(parentId)`, and no method reads across parents.
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
  limit?: number;
  offset?: number;
}

export interface StorageInfo {
  type: 'sqlite' | 'postgres';
  /** Where it is, without credentials. */
  location: string;
}

export interface Storage {
  readonly info: StorageInfo;
  forParent(parentId: string): ParentStorage;
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
  return {
    info,
    forParent: (parentId) =>
      new ParentStorage(driver, parentCipher(storageKey, parentId), parentId),
    parents: async () =>
      (
        await driver.all<{ parent_id: string }>(
          'SELECT DISTINCT parent_id FROM items ORDER BY parent_id',
        )
      ).map((row) => row.parent_id),
    close: () => driver.close(),
  };
}

export class ParentStorage {
  constructor(
    private readonly db: SqlDriver,
    private readonly cipher: ParentCipher,
    readonly parentId: string,
  ) {}

  /** Inserts new items and updates changed ones; unchanged ones are left alone. */
  async put(items: ItemInput[]): Promise<{ changed: number; unchanged: number }> {
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
    const rows = await this.db.all<ItemRow>(
      `SELECT ${COLUMNS} FROM items WHERE parent_id = $1 AND kind = $2 AND id = $3`,
      [this.parentId, kind, id],
    );
    return rows[0] ? this.decode(rows[0]) : null;
  }

  /** Newest first. */
  async list(query: ListQuery = {}): Promise<StoredItem[]> {
    const where = ['parent_id = $1'];
    const params: Array<string | number> = [this.parentId];
    const add = (clause: string, value: string | number) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (query.kind) add('kind = ?', query.kind);
    if (query.childId) add('child_id = ?', query.childId);
    if (query.since !== undefined) add('occurred_at >= ?', query.since);
    if (query.until !== undefined) add('occurred_at <= ?', query.until);
    params.push(Math.min(Math.max(query.limit ?? 50, 1), 500), Math.max(query.offset ?? 0, 0));
    const rows = await this.db.all<ItemRow>(
      `SELECT ${COLUMNS} FROM items WHERE ${where.join(' AND ')}
       ORDER BY occurred_at IS NULL, occurred_at DESC, updated_at DESC, id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((row) => this.decode(row));
  }

  async stats(): Promise<KindStats[]> {
    const rows = await this.db.all<{
      kind: ItemKind;
      count: unknown;
      oldest: unknown;
      newest: unknown;
      last_updated: unknown;
    }>(
      `SELECT kind, COUNT(*) AS count, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest,
              MAX(updated_at) AS last_updated
       FROM items WHERE parent_id = $1 GROUP BY kind ORDER BY kind`,
      [this.parentId],
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
    return options.kind
      ? this.db.run('DELETE FROM items WHERE parent_id = $1 AND kind = $2', [
          this.parentId,
          options.kind,
        ])
      : this.db.run('DELETE FROM items WHERE parent_id = $1', [this.parentId]);
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
