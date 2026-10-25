import { chmodSync, existsSync, writeFileSync } from 'node:fs'

import { Stellar } from '../../apps/seller/demo-deps.ts'
import { FILES, FUNDING, NET, ROLE_LIST, ROLES, publicKey, type Role } from './lib.ts'

/**
 * M1: the mainnet keypairs (relayer A and B, treasury, seller payTo, Bob, Carol), a fresh VAULT_KEY and one invite
 * code, written to apps/web/.env.mainnet (the mainnet stage) and scripts/demo/.env.pubnet (the scripts), both mode 600.
 * No network access, nothing signed. Prints public keys only. Never overwrites: when the files exist it prints the
 * public keys they hold.
 *
 *   bun scripts/mainnet/keys.ts
 *
 * Alice is a smart account relayer A deploys in M5 (scripts/mainnet/seed.ts), so she has no key. The seller's
 * OZ_FACILITATOR_KEY lives in apps/seller/.dev.vars.mainnet (scripts/mainnet/seller-deploy.sh, M4).
 */
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** `length` characters drawn uniformly from the alphabet (rejection sampling; no look-alikes such as l/1, o/0). */
function inviteCode(length = 16): string {
  const limit = 256 - (256 % INVITE_ALPHABET.length)
  let out = ''
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32)))
      if (byte < limit && out.length < length) out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length]
  }
  return out
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

function create() {
  const keys = {
    relayerA: Stellar.Keypair.random(),
    relayerB: Stellar.Keypair.random(),
    treasury: Stellar.Keypair.random(),
    seller: Stellar.Keypair.random(),
    bob: Stellar.Keypair.random(),
    carol: Stellar.Keypair.random(),
  } satisfies Record<Role, Stellar.Keypair>
  const demo = [
    '# Mainnet demo accounts for scripts/mainnet and scripts/demo --network pubnet. REAL FUNDS. Never print, copy',
    '# into logs or commit. Created by scripts/mainnet/keys.ts; public keys are in docs/mainnet-funding.md.',
    ...ROLE_LIST.map(role => `${ROLES[role]}=${keys[role].secret()}`),
    '',
  ].join('\n')
  const web = [
    '# The mainnet stage (docs/MAINNET.md Track M), read by apps/web/alchemy.run.ts. REAL FUNDS. Never print or commit.',
    '# Created by scripts/mainnet/keys.ts; check with bun scripts/mainnet/check-env.ts. An empty value means unset',
    '# (the pubnet preset decides) and also keeps a same-named shell variable out.',
    'CHAIN=stellar',
    'STELLAR_NETWORK=pubnet',
    `STELLAR_RPC_URL=${NET.rpcUrl}`,
    `STELLAR_RPC_FALLBACK_URL=${NET.rpcFallbackUrl ?? ''}`,
    `RELAYER_SECRET=${keys.relayerA.secret()},${keys.relayerB.secret()}`,
    'RELAYER_SECRETS=',
    `TREASURY_SECRET=${keys.treasury.secret()}`,
    `VAULT_KEY=${hex(crypto.getRandomValues(new Uint8Array(32)))}`,
    `DEMO_RECIPIENT_SECRET=${keys.carol.secret()}`,
    `INVITE_CODES=${inviteCode()}`,
    '# M4: scripts/mainnet/seller-deploy.sh copies the mainnet OpenZeppelin Channels key here',
    'OZ_FACILITATOR_KEY=',
    '# M3: scripts/mainnet/router-deploy.ts prints (or with --write-env sets) the router id',
    'ONBOARD_ROUTER_ID=',
    'RP_ID=trynod.si',
    'ORIGIN=https://trynod.si',
    'PAYMENTS_ENABLED=true',
    'MAX_GRANT_USDC=20',
    'MAX_OWNER_PAYMENT_USDC=50',
    'MAX_X402_PRICE_USDC=1',
    'MAX_FEE_STROOPS=10000000',
    'FIRST_PULL_MAX_FEE_STROOPS=10000000',
    'PULL_MAX_FEE_STROOPS=10000000',
    'SAMPLE_ENABLED=false',
    'WELCOME_USDC_STROOPS=0',
    'X402_FACILITATOR_URL=',
    'WALLET_TTL_LEDGERS=',
    '# M5: scripts/mainnet/seed.ts prints (or with --write-env sets) Alice, Bob and Carol',
    'DEMO_CONTACTS=[]',
    '',
  ].join('\n')
  // 'wx': fail rather than overwrite; mode 600 from the first byte.
  writeFileSync(FILES.demo, demo, { mode: 0o600, flag: 'wx' })
  writeFileSync(FILES.web, web, { mode: 0o600, flag: 'wx' })
  chmodSync(FILES.demo, 0o600)
  chmodSync(FILES.web, 0o600)
  console.log(`wrote ${FILES.demo} and ${FILES.web} (mode 600)`)
}

if (existsSync(FILES.demo) || existsSync(FILES.web)) {
  if (!(existsSync(FILES.demo) && existsSync(FILES.web)))
    throw new Error(`only one of ${FILES.demo} and ${FILES.web} exists; fix by hand, never overwrite a key`)
  console.log('keys exist; not regenerating')
} else create()

console.log('\n| role | public key | XLM | USDC |\n| ---- | ---------- | --: | ---: |')
for (const role of ROLE_LIST)
  console.log(`| ${role} | ${publicKey(role)} | ${FUNDING[role].xlm} | ${FUNDING[role].usdc} |`)
console.log(`\ninvite code: INVITE_CODES in ${FILES.web} (not printed)`)
