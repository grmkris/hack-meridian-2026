import { Schema } from 'effect'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'

import { SELLER_VARS, STELLAR } from './lib/env.ts'

/**
 * Generates an OpenZeppelin Channels API key (`GET /testnet/gen`, or `/gen` with `--network pubnet`;
 * docs/research/x402-stellar.md) and stores it as OZ_FACILITATOR_KEY in apps/seller/.dev.vars (.dev.vars.mainnet for
 * pubnet; gitignored), which `wrangler deploy --secrets-file` uploads as a Worker secret. Prints only the status and
 * the key's length. A key is not a transaction; nothing here touches a ledger.
 */
const file = SELLER_VARS
if (existsSync(file) && /^OZ_FACILITATOR_KEY=./mu.test(readFileSync(file, 'utf8'))) {
  console.log(`OZ_FACILITATOR_KEY already in ${file}`)
  process.exit(0)
}
const response = await fetch(`https://channels.openzeppelin.com/${STELLAR === 'pubnet' ? '' : 'testnet/'}gen`)
const body = Schema.decodeUnknownOption(Schema.Struct({ apiKey: Schema.String }))(
  await response.json().catch(() => null),
)
if (!response.ok || body._tag === 'None') {
  console.log(
    `GET gen (${STELLAR}) → ${response.status}: no apiKey in the response (mainnet keys may need a GitHub sign-in)`,
  )
  process.exit(1)
}
appendFileSync(file, `OZ_FACILITATOR_KEY=${body.value.apiKey}\n`, { mode: 0o600 })
console.log(
  `GET gen (${STELLAR}) → ${response.status}; stored OZ_FACILITATOR_KEY (${body.value.apiKey.length} chars) in ${file}`,
)
