import type { CallToolResult } from '@modelcontextprotocol/client'
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'

import cardHtml from '../../server/cards/card.html?raw'
import { FIXTURES, type Fixture } from './fixtures'

/**
 * A local MCP Apps host for the sealed card: it iframes `card.html` the way claude.ai or Goblin do (sandboxed, no
 * same-origin), plays one fixture (`?state=…&theme=light|dark&width=390`), answers the card's own `tools/call` from
 * the fixture's polls and logs every link and model-context update. `scripts/card-shots.ts` drives it.
 */

const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'payment-needs-nod'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const width = Number(params.get('width') ?? '720')
const capabilities = params.get('capabilities') ?? 'all'

const slot = document.getElementById('slot')
const log = document.getElementById('log')
if (slot === null || log === null) {
  throw new Error('harness page is missing #slot or #log')
}
document.body.dataset['theme'] = theme
slot.style.setProperty('--width', `${width}px`)

const say = (line: string) => {
  log.textContent = `${log.textContent ?? ''}${line}\n`
}

const fixtureOf = (name: string): Fixture => {
  const fixture = FIXTURES[name]
  if (fixture === undefined) {
    throw new Error(`no fixture ${name}`)
  }
  return fixture
}

const fixture = fixtureOf(state)
const view = fixture.tool === 'nod_home' ? 'home' : 'card'

const toolResult = (structured: unknown, text: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
  ...(isError ? { isError: true } : {}),
})

const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts')
frame.title = 'Nod card'
slot.append(frame)

const contentWindow = frame.contentWindow
if (contentWindow === null) {
  throw new Error('the card iframe has no window')
}

const bridge = new AppBridge(
  null,
  { name: 'nod-harness', version: '1.0.0' },
  capabilities === 'none' ? {} : { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } },
  {
    hostContext: {
      theme,
      displayMode: view === 'home' ? 'fullscreen' : 'inline',
      platform: 'web',
      toolInfo: { tool: { name: fixture.tool, inputSchema: { type: 'object' } } },
    },
  },
)

/** The fixture's answers to the card's own tool calls, by tool and in order; the last one repeats. */
const makeAnswerer = () => {
  const counts = new Map<string, number>()
  return (name: string): CallToolResult => {
    const answers = fixture.answers?.[name] ?? fixture.polls ?? [fixture.structured]
    const count = counts.get(name) ?? 0
    counts.set(name, count + 1)
    say(`tools/call ${name} #${count + 1}`)
    return toolResult(answers[Math.min(count, answers.length - 1)], `${name} answered`)
  }
}
const answer = makeAnswerer()
bridge.oncalltool = async ({ name }) => answer(name)
bridge.onopenlink = async ({ url }) => {
  say(`open-link ${url}`)
  return {}
}
bridge.onupdatemodelcontext = async ({ content }) => {
  say(`model-context ${JSON.stringify(content)}`)
  return {}
}
bridge.onsizechange = ({ height }) => {
  if (height !== undefined) {
    frame.style.height = `${Math.ceil(height)}px`
    document.body.dataset['height'] = String(Math.ceil(height))
  }
}
bridge.oninitialized = () => {
  void bridge
    .sendToolInput({ arguments: { ...fixture.arguments } })
    .then(() => bridge.sendToolResult(toolResult(fixture.structured, fixture.sentence, fixture.isError === true)))
  setTimeout(() => {
    document.body.dataset['ready'] = 'true'
  }, 400)
}

await bridge.connect(new PostMessageTransport(contentWindow, contentWindow))
frame.srcdoc = cardHtml.replace('<head>', `<head><meta name="nod-view" content="${view}">`)
