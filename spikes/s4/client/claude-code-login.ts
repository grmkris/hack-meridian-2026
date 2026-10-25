import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
/**
 * Real-host check: Claude Code's own MCP OAuth client against the deployed Worker, in an isolated
 * CLAUDE_CONFIG_DIR (never ~/.claude). Spawns `claude mcp login <name> --no-browser`, approves the consent page
 * with playwright-core, and pastes the redirect URL back if Claude Code's loopback listener did not take it.
 *
 *   CLAUDE_CONFIG_DIR=/tmp/s4-claude bun client/claude-code-login.ts stellarmcpwallet
 */
import { chromium } from 'playwright-core'

const ROOT = join(import.meta.dir, '..')
const NAME = process.argv[2] ?? 'stellarmcpwallet'
const PASSWORD = /^DEV_PASSWORD=(.+)$/mu.exec(readFileSync(join(ROOT, '.dev.vars'), 'utf8'))?.[1]?.trim()
if (!PASSWORD) throw new Error('DEV_PASSWORD missing')
if (!process.env.CLAUDE_CONFIG_DIR?.startsWith('/tmp/'))
  throw new Error('set CLAUDE_CONFIG_DIR to an isolated /tmp dir')

const transcript: string[] = []
const redact = (text: string) => text.replace(/([?&](code|code_challenge|state)=)[^&\s]+/gu, '$1<redacted>')
// `claude mcp login` refuses a non-TTY stdin; `script` gives it a pty whose input is our pipe.
const child = Bun.spawn(['script', '-q', '-e', '-c', `claude mcp login ${NAME} --no-browser`, '/dev/null'], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, COLUMNS: '4000' },
})
let output = ''
const authUrl = Promise.withResolvers<string>()
const pump = async (stream: ReadableStream<Uint8Array>, label: string) => {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const text = decoder.decode(chunk)
    output += text
    transcript.push(`[${label}] ${redact(text)}`)
    process.stdout.write(redact(text))
    // eslint-disable-next-line no-control-regex
    const match = /https:\/\/[^\s\u001b]+\/authorize\?[^\s\u001b]+/u.exec(output)
    if (match) authUrl.resolve(match[0])
  }
}
void pump(child.stdout, 'stdout')
void pump(child.stderr, 'stderr')

const url = await Promise.race([authUrl.promise, Bun.sleep(30_000).then(() => '')])
if (!url) throw new Error(`no authorization URL printed:\n${output}`)
const authorize = new URL(url)
const params = Object.fromEntries(
  [...authorize.searchParams.entries()].map(([k, v]) => [
    k,
    ['state', 'code_challenge'].includes(k) ? '<redacted>' : v,
  ]),
)
console.log('\n[driver] authorization request params:', params)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const redirected = Promise.withResolvers<string>()
page.on('request', request => {
  if (request.url().startsWith(params.redirect_uri as string)) redirected.resolve(request.url())
})
await page.goto(url)
console.log('[driver] consent page h1:', await page.locator('h1').innerText())
await page.screenshot({ path: join(ROOT, 'evidence', 'claude-code-consent.png'), fullPage: true })
await page.fill('input[name=password]', PASSWORD)
await page.click('button[value=approve]').catch(() => undefined)
const redirect = await Promise.race([redirected.promise, Bun.sleep(15_000).then(() => '')])
console.log('[driver] browser was sent to:', redact(redirect))
await Bun.sleep(3000)
if (child.exitCode === null && redirect) {
  console.log('[driver] Claude Code still waiting: pasting the redirect URL')
  child.stdin.write(`${redirect}\r`)
  await child.stdin.flush()
}
const exit = await Promise.race([child.exited, Bun.sleep(30_000).then(() => 'timeout')])
console.log('[driver] claude mcp login exit:', exit)
await browser.close()
writeFileSync(
  join(ROOT, 'evidence', 'claude-code-login.log'),
  `${transcript.join('')}\n[driver] params ${JSON.stringify(params)}\n[driver] exit ${exit}\n`,
)
if (exit === 'timeout') child.kill()
