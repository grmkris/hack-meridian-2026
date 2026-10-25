import { Context, Effect, Layer, Schema } from 'effect'

/**
 * The SQL port the wallet store runs on: D1 in the Worker and the Durable Object, SQLite (node:sqlite) in tests. Only
 * the two calls the store needs: a read, and an atomic batch of writes.
 */
export type SqlValue = string | number | null
export interface SqlStatement {
  readonly sql: string
  readonly params: ReadonlyArray<SqlValue>
}
export const sql = (text: string, ...params: ReadonlyArray<SqlValue>): SqlStatement => ({ sql: text, params })

/** A SQL engine: D1Database or a test SQLite. */
export interface SqlEngine {
  readonly all: (statement: SqlStatement) => Promise<ReadonlyArray<Record<string, unknown>>>
  /** All statements commit together or none do. */
  readonly batch: (statements: ReadonlyArray<SqlStatement>) => Promise<void>
}

export class DbError extends Schema.TaggedError<DbError>()('DbError', {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class Db extends Context.Service<
  Db,
  {
    readonly all: (statement: SqlStatement) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, DbError>
    readonly batch: (statements: ReadonlyArray<SqlStatement>) => Effect.Effect<void, DbError>
  }
>()('hm/Db') {
  static readonly fromEngine = (engine: SqlEngine) =>
    Layer.succeed(Db, {
      all: statement =>
        Effect.tryPromise({
          try: () => engine.all(statement),
          catch: cause => new DbError({ operation: firstWords(statement.sql), message: String(cause) }),
        }),
      batch: statements =>
        statements.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: () => engine.batch(statements),
              catch: cause =>
                new DbError({
                  operation: `batch: ${statements.map(s => firstWords(s.sql)).join('; ')}`,
                  message: String(cause),
                }),
            }),
    })
}

const firstWords = (text: string) => text.trim().split(/\s+/u).slice(0, 3).join(' ')

/** D1 as a SqlEngine. `batch` is a D1 transaction. */
export const d1Engine = (database: D1Database): SqlEngine => ({
  all: async statement => {
    const result = await database
      .prepare(statement.sql)
      .bind(...statement.params)
      .all<Record<string, unknown>>()
    return result.results
  },
  batch: async statements => {
    await database.batch(statements.map(statement => database.prepare(statement.sql).bind(...statement.params)))
  },
})
