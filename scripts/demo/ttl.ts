import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { friendbot } from './lib/chain.ts'
import { ROOT, key } from './lib/env.ts'
import { daysLeft, extend, ledgerTime, readShared, restore, type EntryTtl } from './lib/ttl.ts'

/**
 * Shared-contract TTLs: readout, and extension of every entry that expires before a deadline. The OPS account
 * (friendbot-funded, scripts/demo/.env OPS_SECRET) pays; tx hashes and new expiries go to evidence/ttl/<time>.json.
 *
 *   bun scripts/demo/ttl.ts                                    readout only
 *   bun scripts/demo/ttl.ts --extend [--before 2026-11-10] [--days 18] [--max-fee 420]   (XLM per transaction)
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const before = new Date(`${flag('--before') ?? '2026-11-10'}T00:00:00Z`)
const days = Number(flag('--days') ?? '18')
const maxFee = Number(flag('--max-fee') ?? '420')

const row = (latest: number, e: EntryTtl) => ({
  group: e.group,
  entry: e.entry,
  id: e.id,
  bytes: e.bytes ?? null,
  live_until: e.liveUntil ?? null,
  approx_utc: e.liveUntil === undefined ? 'ARCHIVED or missing' : ledgerTime(latest, e.liveUntil),
  days_left: e.liveUntil === undefined ? 0 : Number(daysLeft(latest, e.liveUntil).toFixed(1)),
})

const print = (latest: number, entries: Array<EntryTtl>) => {
  console.log(`latest ledger ${latest}`)
  console.log(`| contract                 | entry    | live until | ≈ UTC              | days |`)
  console.log(`| ------------------------ | -------- | ---------: | ------------------ | ---: |`)
  for (const e of entries.map(x => row(latest, x)))
    console.log(
      `| ${e.group.padEnd(24)} | ${e.entry.padEnd(8)} | ${String(e.live_until ?? '-').padStart(10)} | ${e.approx_utc.padEnd(18)} | ${e.days_left.toFixed(1).padStart(4)} |${e.days_left < 7 ? ' ⚠ < 7 days' : ''}`,
    )
}

const before0 = await readShared()
print(before0.latest, before0.entries)
if (!args.includes('--extend')) process.exit(0)

const deadline = before0.latest + Math.ceil((before.getTime() - Date.now()) / 5_000)
const ledgers = days * 17_280
const ops = key('OPS')
await friendbot(ops.publicKey())
const actions: Array<Record<string, unknown>> = []
const groups = [...new Set(before0.entries.map(e => e.group))]
for (const group of groups) {
  const entries = before0.entries.filter(e => e.group === group)
  const archived = entries.filter(e => e.liveUntil === undefined)
  const short = entries.filter(e => e.liveUntil === undefined || e.liveUntil < deadline)
  if (short.length === 0) continue
  if (archived.length > 0) {
    const restored = await restore(
      ops,
      archived.map(e => e.key),
      maxFee,
      `restore ${group}`,
    )
    console.log(`restored ${group}: ${restored.explorer}`)
    actions.push({ action: 'restore', group, entries: archived.map(e => e.entry), ...restored })
  }
  for (const e of short) {
    const steps = await extend(ops, [e.key], ledgers, maxFee, `extend ${group} ${e.entry}`)
    actions.push({ action: 'extend', group, entry: e.entry, target_ledgers_from_now: ledgers, steps })
  }
}
const after = await readShared()
print(after.latest, after.entries)
const at = new Date().toISOString()
const dir = join(ROOT, 'evidence/ttl')
mkdirSync(dir, { recursive: true })
const file = join(dir, `${at.replace(/[:.]/gu, '-')}.json`)
writeFileSync(
  file,
  `${JSON.stringify(
    {
      at,
      payer: ops.publicKey(),
      deadline: { utc: before.toISOString(), ledger: deadline },
      extend_by_days: days,
      before: before0.entries.map(e => row(before0.latest, e)),
      actions,
      after: after.entries.map(e => row(after.latest, e)),
    },
    null,
    2,
  )}\n`,
)
console.log(`evidence → ${file}`)
