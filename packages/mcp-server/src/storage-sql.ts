/**
 * The two SQL backends local storage runs on: SQLite (bun:sqlite, the
 * default) and PostgreSQL (Bun.SQL). Both take `$1`-style placeholders and
 * return plain rows, so storage.ts writes each query once.
 */

import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';

export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

export interface SqlDriver {
  readonly dialect: 'sqlite' | 'postgres';
  all<T extends SqlRow = SqlRow>(query: string, params?: SqlValue[]): Promise<T[]>;
  /** Resolves to the number of rows the statement changed. */
  run(query: string, params?: SqlValue[]): Promise<number>;
  /** Runs `fn` in one transaction; it rolls back when `fn` throws. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function sqliteDriver(path: string): SqlDriver {
  const db = new Database(path, { create: true, strict: true });
  // The content is encrypted, but who has data and when is not.
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA foreign_keys = ON');
  // bun:sqlite binds `?1`, not `$1`.
  const toSqlite = (query: string) => query.replace(/\$(\d+)/g, '?$1');

  const direct: Omit<SqlDriver, 'transaction' | 'close'> = {
    dialect: 'sqlite',
    all: async <T extends SqlRow>(query: string, params: SqlValue[] = []) =>
      db.query(toSqlite(query)).all(...params) as T[],
    run: async (query, params = []) => db.query(toSqlite(query)).run(...params).changes,
  };

  // One connection: a transaction must not interleave with other calls, so
  // every call waits its turn.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const inTransaction: SqlDriver = {
    ...direct,
    transaction: (fn) => fn(inTransaction),
    close: async () => {},
  };

  return {
    dialect: 'sqlite',
    all: (query, params) => serial(() => direct.all(query, params)),
    run: (query, params) => serial(() => direct.run(query, params)),
    transaction: (fn) =>
      serial(async () => {
        db.run('BEGIN IMMEDIATE');
        try {
          const result = await fn(inTransaction);
          db.run('COMMIT');
          return result;
        } catch (err) {
          db.run('ROLLBACK');
          throw err;
        }
      }),
    close: async () => {
      await queue;
      db.close();
    },
  };
}

export function postgresDriver(url: string): SqlDriver {
  const sql = new Bun.SQL(url);
  const wrap = (conn: Bun.SQL): SqlDriver => ({
    dialect: 'postgres',
    all: async <T extends SqlRow>(query: string, params: SqlValue[] = []) =>
      [...(await conn.unsafe(query, params))] as T[],
    run: async (query, params = []) => {
      const result = (await conn.unsafe(query, params)) as { count?: number };
      return result.count ?? 0;
    },
    transaction: (fn) =>
      conn === sql
        ? (sql.begin((tx) => fn(wrap(tx as unknown as Bun.SQL))) as never)
        : fn(wrap(conn)),
    close: async () => {
      await sql.close();
    },
  });
  return wrap(sql);
}
