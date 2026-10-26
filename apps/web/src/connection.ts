import { Array, DateTime, Option, Order } from 'effect'

import type { GrantView } from './backend'
import { toStroops } from './format'

/** OAuth client metadata is a destination, never an executable URL or embedded credentials. */
export const clientUrl = (domain: string | null): Option.Option<string> => {
  if (domain === null || domain.trim() === '' || /[\s\\]/u.test(domain) || domain.startsWith('/')) return Option.none()
  const value = domain.trim()
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(value) ? value : `https://${value}`
  const url = URL.parse(candidate)
  return url !== null &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === ''
    ? Option.some(url.href)
    : Option.none()
}

export type AllowanceState = 'ready' | 'expired' | 'empty' | 'pending' | 'revoked' | 'checking'

/** Wake at the next allowance boundary instead of repainting every second. */
export const nextAllowanceExpiry = (grants: ReadonlyArray<GrantView>, nowMs: number): Option.Option<number> =>
  Array.head(
    Array.sort(
      Array.getSomes(
        Array.map(grants, grant =>
          grant.connection_status === 'active' && grant.grant_status === 'active' && grant.valid_until !== null
            ? Option.filter(
                Option.map(DateTime.make(grant.valid_until), DateTime.toEpochMillis),
                until => until > nowMs,
              )
            : Option.none(),
        ),
      ),
      Order.Number,
    ),
  )

/** This is display state only; the account and Worker remain authoritative for spending. */
export const allowanceState = (grant: GrantView, nowMs: Option.Option<number>): AllowanceState => {
  if (grant.connection_status === 'revoked' || grant.grant_status === 'revoked') return 'revoked'
  if (grant.grant_status === 'expired') return 'expired'
  if (grant.valid_until === null || grant.grant_status !== 'active' || grant.rule_status !== 'installed')
    return 'pending'
  const until = Option.map(DateTime.make(grant.valid_until), DateTime.toEpochMillis)
  if (Option.isNone(until) || Option.isNone(nowMs)) return 'checking'
  if (until.value <= nowMs.value) return 'expired'
  return Option.match(toStroops(grant.remaining), {
    onNone: () => 'checking',
    onSome: remaining => (remaining > 0n ? 'ready' : 'empty'),
  })
}

export const allowanceHelp: Readonly<Record<Exclude<AllowanceState, 'ready'>, string>> = {
  expired: 'Allowance expired. Ask your app for a new one.',
  empty: 'Allowance used. Further spending needs your passkey.',
  pending: 'Finish authorizing this app with your passkey.',
  revoked: 'Access revoked.',
  checking: 'Checking allowance expiry…',
}
