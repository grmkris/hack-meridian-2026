import { Schema } from 'effect'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './lib/env.ts'

/**
 * Generates a free OpenZeppelin Channels testnet API key (`GET /testnet/gen`, docs/research/x402-stellar.md) and stores
 * it as OZ_FACILITATOR_KEY in apps/seller/.dev.vars (gitignored), which `wrangler deploy --secrets-file` uploads as a
 * Worker secret. Prints only the status and the key's length.
 */
const file = join(ROOT, 'apps/seller/.dev.vars')
if (existsSync(file) && /^OZ_FACILITATOR_KEY=./mu.test(readFileSync(file, 'utf8'))) {
  console.log('OZ_FACILITATOR_KEY already in apps/seller/.dev.vars')
  process.exit(0)
}
const response = await fetch('https://channels.openzeppelin.com/testnet/gen')
const body = Schema.decodeUnknownOption(Schema.Struct({ apiKey: Schema.String }))(
  await response.json().catch(() => null),
)
if (!response.ok || body._tag === 'None') {
  console.log(`GET /testnet/gen → ${response.status}: no apiKey in the response`)
  process.exit(1)
}
appendFileSync(file, `OZ_FACILITATOR_KEY=${body.value.apiKey}\n`, { mode: 0o600 })
console.log(`GET /testnet/gen → ${response.status}; stored OZ_FACILITATOR_KEY (${body.value.apiKey.length} chars)`)
