#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { perform } from './demo/lib/actions.ts'
import { ownerBrowser } from './demo/lib/browser.ts'
import { ROOT } from './demo/lib/env.ts'
import { TARGETS } from './demo/targets.ts'

/**
 * The post-deploy Claude Code check: a fresh Claude Code connects Nod (CIMD + PKCE through `claude mcp login`), signs in
 * with a new passkey wallet in a headless browser (the rehearsal's virtual authenticator), then a fresh session calls
 * wallet_overview and payment_prepare (0.01 USDC to Alice: inside the allowance, so nothing is paid). Claude Code
 * renders no cards, so this proves the text results and the tool metadata don't trip it.
 *
 * Then recipient memory and the guide, in a second fresh session: pay 0.02 USDC to a raw address the user calls Chris
 * (payment_prepare with recipient_name, payment_execute: Nod saves Chris as a contact), then "send 0.02 to Chris" must
 * pay inside the allowance with no nod, then get_guide returns the skill. The raw address is `--raw <G…>` (default on
 * testnet: the treasury, so the 0.04 USDC goes back). Skipped, not failed, when the new wallet holds under 0.04 USDC.
 *
 *   bun scripts/claude-code-check.ts --target testnet [--raw G…]
 *
 * It runs in a throwaway project directory with a local-scope server, so the user's own Claude Code config is untouched.
 */

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const target = TARGETS[flag('--target') ?? 'testnet']
if (target === undefined) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`)
const base = (process.env['HM_URL'] ?? target.base).replace(/\/$/u, '')
const server = 'nod-check'
/** The testnet treasury: it exists and holds USDC, and is never a demo contact. */
const TESTNET_TREASURY = 'GB4F3NUAD2NIRNOHNB36QS7ONEPWMPVSI5IRT6NY5FMMONLGTDQ4CIU5'
const raw = flag('--raw') ?? (target.name === 'testnet' ? TESTNET_TREASURY : undefined)
const session = `nod-cc-check-${process.pid}`
const project = mkdtempSync(join(tmpdir(), 'nod-cc-check-'))
const evidence = join(ROOT, '.local/claude-code-check', new Date().toISOString().replace(/[:.]/gu, '-'))
mkdirSync(evidence, { recursive: true })

const run = (command: string, argv: ReadonlyArray<string>, options: { readonly input?: string } = {}) => {
  const result = spawnSync(command, argv, {
    cwd: project,
    encoding: 'utf8',
    timeout: 240_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const tmux = (...argv: ReadonlyArray<string>) => run('tmux', argv)
const pane = () => tmux('capture-pane', '-p', '-J', '-t', session, '-S', '-200').out

const waitFor = async (pattern: RegExp, ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const match = pattern.exec(pane())
    if (match !== null) return match
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`no ${pattern} in the login pane within ${ms} ms:\n${pane()}`)
}

const checks: Array<{ readonly ok: boolean; readonly detail: string }> = []
const check = (ok: boolean, detail: string) => {
  checks.push({ ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${detail}`)
}
const skipped: Array<string> = []
const skip = (detail: string) => {
  skipped.push(detail)
  console.log(`skip ${detail}`)
}

try {
  check(
    run('claude', ['mcp', 'add', '--transport', 'http', '-s', 'local', server, `${base}/mcp`]).status === 0,
    'mcp add',
  )
  tmux(
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '400',
    '-y',
    '50',
    '-c',
    project,
    `claude mcp login ${server} --no-browser`,
  )
  const url = (await waitFor(/(https?:\/\/\S+\/authorize\?\S+)/u, 60_000))[1] ?? ''
  check(url.startsWith(base), `authorization URL on ${new URL(url).host}`)
  const owner = await ownerBrowser(evidence)
  const seen: { redirect?: string } = {}
  owner.page.on('request', request => {
    const to = request.url()
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/callback/u.test(to)) seen.redirect = to
  })
  await owner.page.route(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/callback/u, route => route.abort())
  try {
    await perform(
      owner.page,
      target.consent,
      { auth_url: url, base, allowance: target.allowance },
      name => owner.shot(name),
      line => console.error(`  ${line}`),
    )
    const until = Date.now() + 60_000
    while (seen.redirect === undefined && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250))
  } finally {
    await owner.close()
  }
  const redirect = seen.redirect
  check(redirect !== undefined, 'consent redirected back to Claude Code')
  if (redirect !== undefined) {
    tmux('send-keys', '-t', session, '-l', redirect)
    tmux('send-keys', '-t', session, 'Enter')
    await waitFor(/(authenticat|success|connected|logged in)/iu, 60_000).catch(() => undefined)
  }
  const prompt = [
    `Use only the ${server} MCP server. Call its wallet_overview tool, then call its payment_prepare tool with`,
    `recipient "Alice", amount "0.01", reason "Claude Code post-deploy check", idempotency_key "cc-check-${Date.now()}".`,
    'Do not call any other tool. Then answer in exactly two lines: OVERVIEW <the first sentence of the wallet_overview',
    'result> and PREPARE <the status and lane of the prepared payment>. If a tool errors, print TOOL_ERROR and the message.',
  ].join(' ')
  const answer = run('claude', [
    '-p',
    prompt,
    '--allowedTools',
    `mcp__${server}__wallet_overview,mcp__${server}__payment_prepare`,
  ])
  console.log(answer.out.trim())
  check(answer.status === 0, 'claude -p exited 0')
  check(/OVERVIEW .*USDC/u.test(answer.out), 'wallet_overview answered with the balance sentence')
  check(/PREPARE .*(prepared|ready|autonomous)/iu.test(answer.out), 'payment_prepare answered inside the allowance')
  check(!/TOOL_ERROR|_meta|resourceUri|ui:\/\//u.test(answer.out), 'no tool error and no card metadata leaked')

  // Recipient memory and the guide: a raw address named Chris, then "send 0.02 to Chris" alone, then get_guide.
  // The wallet balance is the first amount on the OVERVIEW line, however Claude words it: hosts that show the model
  // structuredContent (Claude Code) never see the "holds … USDC" sentence, so the answer paraphrases it.
  const overviewLine = /OVERVIEW[^\n]*/u.exec(answer.out)?.[0] ?? ''
  const holds = Number(/([\d.]+) USDC/u.exec(overviewLine)?.[1] ?? '0')
  if (raw === undefined) skip('recipient memory: no --raw address for this target')
  else if (holds < 0.04) skip(`recipient memory: the new wallet holds ${holds} USDC, under the 0.04 it pays`)
  const pays = raw !== undefined && holds >= 0.04
  const stamp = Date.now()
  const memory = [
    `Use only the ${server} MCP server.`,
    ...(pays
      ? [
          `First call payment_prepare with recipient "${raw}", recipient_name "Chris", amount "0.02",`,
          `reason "Claude Code check: a raw address", idempotency_key "cc-raw-${stamp}"; if its status is prepared, call`,
          'payment_execute with its payment_id. Then the user says "send 0.02 to Chris": call payment_prepare with',
          `recipient "Chris", amount "0.02", reason "Claude Code check: by name", idempotency_key "cc-chris-${stamp}"; if`,
          'its status is prepared, call payment_execute with its payment_id.',
        ]
      : []),
    'Then call get_guide. Do not call any other tool. Answer in exactly these lines:',
    ...(pays
      ? [
          'RAW <the status after payment_execute> <SAVED if the result says Chris was saved as a contact, else NOT_SAVED>,',
          'CHRIS <the status and lane after payment_execute> <the approval_url, or NONE>,',
        ]
      : []),
    'GUIDE <the first line of the guide text that starts with "# ">.',
    'If a tool errors, print TOOL_ERROR and the message.',
  ].join(' ')
  const remembered = run('claude', [
    '-p',
    memory,
    '--allowedTools',
    [
      `mcp__${server}__get_guide`,
      ...(pays ? [`mcp__${server}__payment_prepare`, `mcp__${server}__payment_execute`] : []),
    ].join(','),
  ])
  console.log(remembered.out.trim())
  check(remembered.status === 0, 'claude -p (recipient memory, guide) exited 0')
  if (pays) {
    check(/RAW .*confirmed.*\bSAVED\b/iu.test(remembered.out), 'the raw address was paid and saved as Chris')
    check(
      /CHRIS .*confirmed.*autonomous.*NONE/iu.test(remembered.out),
      '"send 0.02 to Chris" paid inside the allowance with no nod',
    )
  }
  check(/GUIDE # Using Nod/u.test(remembered.out), 'get_guide returned the skill')
  check(!/TOOL_ERROR/u.test(remembered.out), 'no tool error')
} finally {
  tmux('kill-session', '-t', session)
  run('claude', ['mcp', 'remove', '-s', 'local', server])
  rmSync(project, { recursive: true, force: true })
}

const failed = checks.filter(entry => !entry.ok).length
console.log(JSON.stringify({ target: target.name, base, checks: checks.length, failed, skipped, evidence }))
process.exit(failed === 0 ? 0 : 1)
