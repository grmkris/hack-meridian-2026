/**
 * TTL readout and extension for the contracts every payment touches (spike S5 open risk 1: nobody extends the
 * shared spending-limit policy, the verifiers or their WASM). Uses the chain package's relayers from
 * packages/stellar/.env; the relayer pays the rent.
 *
 *   bun packages/stellar/scripts/ttl.ts status [C…|wasm-hash …]       # default: policy, verifiers, USDC SAC
 *   bun packages/stellar/scripts/ttl.ts extend <C…|wasm-hash> <ledgers> [max-fee-xlm]
 */
import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect'

import {
  ED25519_VERIFIER,
  SPENDING_LIMIT_POLICY,
  stellarLayer,
  StellarOps,
  USDC_SAC,
  WEBAUTHN_VERIFIER,
} from '../src/index.ts'

const envText = await Bun.file(new URL('../.env', import.meta.url).pathname).text()
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const runtime = ManagedRuntime.make(
  stellarLayer(globalThis.fetch.bind(globalThis)).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
  ),
)
const [command = 'status', ...rest] = Bun.argv.slice(2)
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)

const program = Effect.gen(function* () {
  const ops = yield* StellarOps
  if (command === 'extend') {
    const [target = '', ledgers = '0', maxXlm] = rest
    const ceiling = maxXlm === undefined ? undefined : BigInt(Math.round(Number(maxXlm) * 1e7))
    return yield* ops.extendTtl(target, Number(ledgers), ceiling)
  }
  const targets = rest.length > 0 ? rest : [SPENDING_LIMIT_POLICY, ED25519_VERIFIER, WEBAUTHN_VERIFIER, USDC_SAC]
  return yield* ops.ttlStatus(
    targets.filter(t => t.startsWith('C')),
    targets.filter(t => !t.startsWith('C')),
  )
})

const exit = await runtime.runPromiseExit(program)
console.log(json(exit))
await runtime.dispose()
