import { Schema } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'

/**
 * What the browser may ask of the Worker. The Worker implements it (apps/web/src/server) and the browser calls it
 * through the client derived from it (apps/web/src/api.ts), so a change here is checked on both sides. Browser-safe:
 * schemas only, no server code.
 */

/** A Soroban contract address (strkey `C…`). */
export const ContractId = Schema.String.check(Schema.isPattern(/^C[A-Z2-7]{55}$/u))

export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  /** The Alchemy stage serving the request: `local` under `bun run dev`, `testnet` once deployed. */
  stage: Schema.String,
  /** The commit the stage was deployed from (`local` outside a deploy). */
  release: Schema.String,
  /** The Stellar network the Worker reads. */
  network: Schema.String,
})
export type Health = typeof Health.Type

export const CounterReading = Schema.Struct({
  contractId: ContractId,
  network: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CounterReading = typeof CounterReading.Type

/** The stage has no counter contract configured. */
export class NotDeployed extends Schema.TaggedError<NotDeployed>()('NotDeployed', { error: Schema.String }) {}
/** Soroban RPC did not answer, or answered with something other than a count. */
export class ChainUnavailable extends Schema.TaggedError<ChainUnavailable>()('ChainUnavailable', {
  error: Schema.String,
}) {}

export class Api extends HttpApi.make('hack-meridian').add(
  HttpApiGroup.make('system').add(HttpApiEndpoint.get('health', '/api/health', { success: Health })),
  HttpApiGroup.make('counter').add(
    HttpApiEndpoint.get('read', '/api/counter', {
      success: CounterReading,
      error: [NotDeployed.pipe(HttpApiSchema.status(404)), ChainUnavailable.pipe(HttpApiSchema.status(503))],
    }),
  ),
) {}
