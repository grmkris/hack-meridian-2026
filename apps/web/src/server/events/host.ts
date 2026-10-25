import { Context, Effect, Option, type Redacted } from 'effect'

/**
 * What the Worker side of MCP Events needs from its isolate: wake a wallet's Durable Object so it delivers new journal
 * rows now (it also wakes on its own alarm), and the vault key webhook secrets are sealed with. The default does
 * nothing and has no key, so code and tests that never touch events run unchanged; runtime.ts provides the real one.
 */
export interface EventsHostShape {
  readonly poke: (walletId: string) => Effect.Effect<void>
  readonly vaultKey: Option.Option<Redacted.Redacted>
}

export const EventsHost = Context.Reference<EventsHostShape>('hm/EventsHost', {
  defaultValue: () => ({ poke: () => Effect.void, vaultKey: Option.none() }),
})
