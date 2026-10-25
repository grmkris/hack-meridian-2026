import { join } from 'node:path'

import type { Action } from './lib/actions.ts'
import { ROOT } from './lib/env.ts'

/**
 * Where the rehearsal runs, and how the owner's pages are driven there. Switching from the S4 stub to the real
 * service is choosing a target (`--target`), or `HM_URL` to point a target at another origin.
 */
export interface Target {
  readonly name: string
  readonly base: string
  readonly mcpPath: string
  readonly clientName: string
  readonly allowance: string
  /** What this server can do; steps that need a missing feature are skipped, not failed. */
  readonly features: ReadonlySet<'onchain' | 'x402' | 'autonomous' | 'claim' | 'fund'>
  /** Owner sign-in for the S4 stub (a shared dev password read from a gitignored file; never printed). */
  readonly passwordFile?: string
  /** Top the new wallet up from the TREASURY to this many USDC (Kristjan's video wallet: 30; outflow 28). */
  readonly fundTo?: number
  /** What the agent says for each contact (`payment_prepare.recipient`). */
  readonly recipients: { readonly alice: string; readonly bob: string; readonly carol: string }
  readonly consent: ReadonlyArray<Action>
  readonly approve: ReadonlyArray<Action>
  readonly revoke: ReadonlyArray<Action>
  readonly claim: ReadonlyArray<Action>
}

/** The S4 spike server: three tools, a dev password instead of a passkey, fake receipts. */
const stub: Target = {
  name: 'stub',
  base: 'https://hm26-s4-mcp.kristjan-grm11775.workers.dev',
  mcpPath: '/mcp',
  clientName: 'hm26 rehearse (stub)',
  allowance: '5.00',
  features: new Set(),
  passwordFile: join(ROOT, 'spikes/s4/.dev.vars'),
  recipients: { alice: 'Alice', bob: 'Bob GBOBDEMO', carol: 'Carol' },
  consent: [
    { do: 'goto', url: '{{auth_url}}' },
    { do: 'shot', name: 'consent' },
    { do: 'fill', selector: 'input[name=password]', value: '{{password}}' },
    { do: 'fill', selector: 'input[name=allowance]', value: '{{allowance}}' },
    { do: 'click', selector: 'button[value=approve]' },
  ],
  approve: [
    { do: 'goto', url: '{{approval_url}}' },
    { do: 'shot', name: 'approval-before' },
    { do: 'fill', selector: 'input[name=password]', value: '{{password}}' },
    { do: 'click', selector: '#approve' },
    { do: 'shot', name: 'approval-after' },
  ],
  revoke: [
    { do: 'goto', url: '{{base}}/connections' },
    {
      do: 'fill',
      selector: 'form:has(button[data-connection="{{connection_id}}"]) input[name=password]',
      value: '{{password}}',
    },
    { do: 'click', selector: 'form:has(button[data-connection="{{connection_id}}"]) button' },
    { do: 'shot', name: 'connections-revoked' },
  ],
  claim: [],
}

/**
 * The wallet service (stream A1). The selectors are the `data-testid`s requested from A1 in the stream C reply,
 * with the S4 names as fallbacks; adjust here when the pages land.
 */
const service = (name: string, base: string): Target => ({
  name,
  base,
  mcpPath: '/mcp',
  clientName: `hm26 rehearse (${name})`,
  allowance: '5',
  features: new Set(['onchain', 'x402', 'autonomous', 'claim', 'fund']),
  fundTo: 30,
  recipients: { alice: 'Alice', bob: 'Bob', carol: 'Carol' },
  consent: [
    { do: 'goto', url: '{{auth_url}}' },
    { do: 'shot', name: 'consent-start' },
    { do: 'click', selector: '[data-testid="passkey-create"], [data-testid="passkey-signin"]', optional: true },
    { do: 'waitFor', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
    {
      do: 'fill',
      selector: '[data-testid="allowance"], input[name=allowance]',
      value: '{{allowance}}',
      optional: true,
    },
    { do: 'shot', name: 'consent' },
    { do: 'click', selector: '[data-testid="consent-allow"], button[value=approve]', timeoutMs: 120_000 },
  ],
  approve: [
    { do: 'goto', url: '{{approval_url}}' },
    { do: 'shot', name: 'approval-before' },
    { do: 'click', selector: '[data-testid="approve"], #approve', timeoutMs: 60_000 },
    { do: 'waitFor', selector: '[data-testid="approval-done"]', optional: true, timeoutMs: 90_000 },
    { do: 'shot', name: 'approval-after' },
  ],
  // Stream B's Connections page (apps/web/src/page/connections.ts): revoke is two clicks, the row then carries
  // data-testid="revoked"; when the service needs the passkey to remove the onchain rule, the row offers
  // data-testid="remove-rule" → A1's /approve page. Step s9 then checks the chain for the rule itself.
  revoke: [
    { do: 'goto', url: '{{base}}/connections' },
    // the site needs the owner signed in: the passkey made on the consent page signs in (data-testid="sign-in")
    { do: 'click', selector: '[data-testid="sign-in"]', optional: true, timeoutMs: 8_000 },
    { do: 'goto', url: '{{base}}/connections' },
    { do: 'waitFor', selector: '[data-testid="revoke"][data-connection="{{connection_id}}"]', timeoutMs: 60_000 },
    { do: 'shot', name: 'connections' },
    {
      do: 'click',
      selector: '[data-testid="revoke"][data-connection="{{connection_id}}"]',
      until: '[data-testid="revoke-confirm"][data-connection="{{connection_id}}"]',
    },
    { do: 'click', selector: '[data-testid="revoke-confirm"][data-connection="{{connection_id}}"]' },
    { do: 'waitFor', selector: '[data-connection="{{connection_id}}"][data-testid="revoked"]', timeoutMs: 60_000 },
    { do: 'shot', name: 'connections-revoked' },
    // A1's /approve/revoke/<connection> page: sign in if asked, then the passkey removes the onchain rule
    { do: 'click', selector: '[data-testid="remove-rule"]', optional: true, timeoutMs: 5_000 },
    { do: 'click', selector: 'button#signin', optional: true, timeoutMs: 5_000 },
    {
      do: 'click',
      selector: 'button[data-testid="revoke"][data-connection="{{connection_id}}"]',
      optional: true,
      timeoutMs: 20_000,
    },
    { do: 'waitFor', selector: 'h1[data-testid="revoked"]', optional: true, timeoutMs: 90_000 },
    { do: 'shot', name: 'rule-removal' },
  ],
  claim: [
    { do: 'goto', url: '{{claim_url}}' },
    { do: 'shot', name: 'claim-before' },
    // already paid when the claim needs no recipient signature (fixture chain); otherwise Carol accepts here
    { do: 'click', selector: '[data-testid="claim-accept"], #accept', optional: true, timeoutMs: 15_000 },
    { do: 'waitFor', selector: '[data-testid="claim-done"]', optional: true, timeoutMs: 90_000 },
    { do: 'shot', name: 'claim-after' },
  ],
})

export const TARGETS: Record<string, Target> = {
  stub,
  testnet: service('testnet', 'https://hack-meridian-testnet.kristjan-grm11775.workers.dev'),
  local: service('local', 'http://localhost:18960'),
}
