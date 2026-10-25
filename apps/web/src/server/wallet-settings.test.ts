import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { WalletSettings } from './wallet-settings.ts'

const load = (bindings: Record<string, string>) =>
  Effect.runPromise(
    WalletSettings.use(settings => Effect.succeed(settings)).pipe(
      Effect.provide(WalletSettings.fromBindings(bindings)),
    ),
  )

describe('WalletSettings', () => {
  it('signs claims as the demo recipient off testnet only when DEMO_CLAIM_SIGNER=true', async () => {
    expect((await load({})).demoClaimSigner).toBe(false)
    expect((await load({ DEMO_CLAIM_SIGNER: 'false' })).demoClaimSigner).toBe(false)
    expect((await load({ DEMO_CLAIM_SIGNER: 'true' })).demoClaimSigner).toBe(true)
  })
})
