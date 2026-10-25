import { Effect, Exit, Option } from 'effect'
import { expect } from 'vitest'

import { it } from '@effect/vitest'

import { Settings } from './settings.ts'

const bindings = {
  STAGE: 'local',
  STELLAR_NETWORK: 'testnet',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  ASSETS: { fetch: () => undefined },
}

it.effect('reads the string bindings and defaults the release and contract', () =>
  Effect.gen(function* () {
    const settings = yield* Settings
    expect(settings.stage).toBe('local')
    expect(settings.release).toBe('local')
    expect(settings.counterContractId).toEqual(Option.none())
  }).pipe(Effect.provide(Settings.fromBindings(bindings))),
)

it.effect('reads a configured contract id', () =>
  Effect.gen(function* () {
    const settings = yield* Settings
    expect(settings.counterContractId).toEqual(Option.some('CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2'))
  }).pipe(
    Effect.provide(
      Settings.fromBindings({
        ...bindings,
        COUNTER_CONTRACT_ID: 'CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2',
      }),
    ),
  ),
)

it.effect('fails without a stage', () =>
  Effect.gen(function* () {
    const { STAGE: _stage, ...rest } = bindings
    const exit = yield* Effect.exit(Effect.provide(Effect.service(Settings), Settings.fromBindings(rest)))
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)
