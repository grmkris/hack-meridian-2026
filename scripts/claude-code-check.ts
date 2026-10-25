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
 *   bun scripts/claude-code-check.ts --target testnet
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
} finally {
  tmux('kill-session', '-t', session)
  run('claude', ['mcp', 'remove', '-s', 'local', server])
  rmSync(project, { recursive: true, force: true })
}

const failed = checks.filter(entry => !entry.ok).length
console.log(JSON.stringify({ target: target.name, base, checks: checks.length, failed, evidence }))
process.exit(failed === 0 ? 0 : 1)
