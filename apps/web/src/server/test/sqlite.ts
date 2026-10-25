import { Effect, Layer } from 'effect'

import { Db, type SqlEngine, type SqlValue } from '../db.ts'
import wallet from '../migrations/0001_wallet.sql?raw'
import pocketBalance from '../migrations/0002_pocket_balance.sql?raw'
import grantTxs from '../migrations/0003_grant_txs.sql?raw'

/** The subset of node:sqlite's DatabaseSync the tests use. */
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    all(...params: ReadonlyArray<SqlValue>): Array<Record<string, unknown>>
    run(...params: ReadonlyArray<SqlValue>): unknown
  }
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

/**
 * A fresh in-memory SQLite with the D1 migration applied, as the Db the store runs on. node:sqlite (Node 24) stands in
 * for D1: same SQLite dialect, and `batch` is a transaction as D1's is.
 */
export const sqliteEngine = async (): Promise<SqlEngine & { readonly database: SqliteDatabase }> => {
  // The worker tsconfig has no Node types; the specifier is a variable so the import is typed by the interface above.
  const specifier = 'node:sqlite'
  // SAFETY: node:sqlite exports DatabaseSync with (at least) the members SqliteModule declares.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { DatabaseSync } = (await import(/* @vite-ignore */ specifier)) as SqliteModule
  const database = new DatabaseSync(':memory:')
  for (const migration of [wallet, pocketBalance, grantTxs]) database.exec(migration)
  return {
    database,
    all: async statement => database.prepare(statement.sql).all(...statement.params),
    batch: async statements => {
      database.exec('BEGIN')
      try {
        for (const statement of statements) database.prepare(statement.sql).run(...statement.params)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

export const sqliteDb = Layer.unwrap(Effect.promise(async () => Db.fromEngine(await sqliteEngine())))
