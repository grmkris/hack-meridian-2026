import { afterEach, describe, expect, test, vi } from 'vitest'

import { InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { AppBridge, type McpUiHostCapabilities } from '@modelcontextprotocol/ext-apps/app-bridge'
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps'

import { bootCard } from './boot'
import { BOB, FIXTURES, type Fixture } from './harness/fixtures'

/**
 * The card against a real ext-apps host (`AppBridge`) over an in-memory transport, the way a chat drives it: tool
 * input and result after the handshake, the card's own `tools/call` answered by the fixture, links and model context
 * recorded. No browser, network or server.
 */

const ALL: McpUiHostCapabilities = { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } }

const fixtureOf = (name: string): Fixture => {
  const fixture = FIXTURES[name]
  if (fixture === undefined) throw new Error(`no fixture ${name}`)
  return fixture
}

const resultOf = (structured: unknown, text: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured !== null && typeof structured === 'object' ? { structuredContent: { ...structured } } : {}),
  ...(isError ? { isError: true } : {}),
})

const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })

/** The card scrolls out of view and back: on coming back it polls at once instead of waiting for the next tick. */
const becomeVisible = async () => {
  setVisibility('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  setVisibility('visible')
  document.dispatchEvent(new Event('visibilitychange'))
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  document.body.replaceChildren()
})

/** Mount the card for one fixture behind a test host; `isVisible: false` lets a visibilitychange start a poll now. */
const mount = async (state: string, capabilities: McpUiHostCapabilities = ALL) => {
  const fixture = fixtureOf(state)
  const calls: Array<string> = []
  const links: Array<string> = []
  const contexts: Array<string> = []
  const messages: Array<unknown> = []
  const polls = fixture.polls ?? [fixture.structured]

  const bridge = new AppBridge(null, { name: 'test-host', version: '1.0.0' }, capabilities, {
    hostContext: { theme: 'light', toolInfo: { tool: { name: fixture.tool, inputSchema: { type: 'object' } } } },
  })
  bridge.oncalltool = async ({ name }) => {
    const answer = polls[Math.min(calls.length, polls.length - 1)]
    calls.push(name)
    return resultOf(answer, `${name} answered`)
  }
  bridge.onopenlink = async ({ url }) => {
    links.push(url)
    return {}
  }
  bridge.onupdatemodelcontext = async ({ content }) => {
    for (const block of content ?? []) if (block.type === 'text') contexts.push(block.text)
    return {}
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- AppBridge's ui/message handler is a setter, not a DOM event
  bridge.onmessage = async params => {
    messages.push(params)
    return {}
  }
  bridge.oninitialized = () => {
    void bridge
      .sendToolInput({ arguments: { ...fixture.arguments } })
      .then(() => bridge.sendToolResult(resultOf(fixture.structured, fixture.sentence, fixture.isError === true)))
  }

  const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
  await bridge.connect(hostTransport)
  const container = document.createElement('div')
  container.id = 'card'
  document.body.append(container)
  const app = new App({ name: 'Nod', version: '1.0.0' }, {}, { autoResize: false })
  const { handle, connected } = bootCard(app, container, { surface: 'Card', isVisible: false }, viewTransport)
  await connected
  cleanups.push(async () => {
    handle.dispose()
    await bridge.close()
  })
  return { container, calls, links, contexts, messages, becomeVisible }
}

/** Lets the card take in the host's answer before the next step. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/** The card replaces its container when it renders, so read what the page shows. */
const text = (_container: HTMLElement) => document.body.textContent ?? ''

const buttonNamed = (container: HTMLElement, name: string) => {
  const button = Array.from(document.body.querySelectorAll('button')).find(candidate =>
    (candidate.textContent ?? '').includes(name),
  )
  if (button === undefined) throw new Error(`no button "${name}" in: ${text(container)}`)
  return button
}

describe('the payment card in a chat', () => {
  test('needs your nod: amount, recipient, the full address and the AI reason as its words, on testnet', async () => {
    const card = await mount('payment-needs-nod')
    await vi.waitFor(() => expect(text(card.container)).toContain('Needs your nod'))
    expect(text(card.container)).toContain('20.00 USDC')
    expect(text(card.container)).toContain('Bob')
    expect(text(card.container)).toContain(BOB)
    expect(text(card.container)).toContain('not checked by Nod')
    expect(text(card.container)).toContain('Testnet')
  })

  test('"Approve with your passkey" asks the chat to open the approval page; the card approves nothing itself', async () => {
    const card = await mount('payment-needs-nod')
    await vi.waitFor(() => expect(text(card.container)).toContain('Approve with your passkey'))
    buttonNamed(card.container, 'Approve with your passkey').click()
    await vi.waitFor(() =>
      expect(card.links).toEqual(['https://hack-meridian-testnet.kristjan-grm11775.workers.dev/approve/pi_bob20']),
    )
    expect(card.calls).toEqual([])
  })

  test('polling payment_status turns the card into the receipt and tells the AI once', async () => {
    const card = await mount('payment-needs-nod-then-receipt')
    await vi.waitFor(() => expect(text(card.container)).toContain('Needs your nod'))
    await card.becomeVisible()
    await vi.waitFor(() => expect(card.calls).toEqual(['payment_status']))
    await settle()
    await card.becomeVisible()
    await vi.waitFor(() => expect(card.calls).toHaveLength(2))
    await settle()
    await card.becomeVisible()
    await vi.waitFor(() => expect(text(card.container)).toContain('Paid'))
    expect(card.calls).toEqual(['payment_status', 'payment_status', 'payment_status'])
    expect(text(card.container)).toContain('Nod paid it')
    await vi.waitFor(() => expect(card.contexts).toHaveLength(1))
    expect(card.contexts[0]).toContain('confirmed on Stellar testnet')
    await card.becomeVisible()
    await settle()
    expect(card.calls).toHaveLength(3)
    expect(card.contexts).toHaveLength(1)
    expect(card.messages).toEqual([])
  })

  test('a chat that lets cards call no tools still shows the approve link and never polls', async () => {
    const card = await mount('payment-needs-nod', { openLinks: {} })
    await vi.waitFor(() => expect(text(card.container)).toContain('Approve with your passkey'))
    await card.becomeVisible()
    await settle()
    expect(card.calls).toEqual([])
  })

  test('when the chat will not open links, the card shows the link to copy', async () => {
    const card = await mount('payment-needs-nod', { serverTools: {} })
    await vi.waitFor(() => expect(text(card.container)).toContain('Approve with your passkey'))
    buttonNamed(card.container, 'Approve with your passkey').click()
    await vi.waitFor(() => expect(text(card.container)).toContain('Open this link yourself'))
    expect(text(card.container)).toContain('/approve/pi_bob20')
  })
})

describe('the other cards', () => {
  test('a tool error is shown as Nod could not do that, with its message', async () => {
    const card = await mount('tool-error')
    await vi.waitFor(() => expect(text(card.container)).toContain('Nod could not do that'))
    expect(text(card.container)).toContain('No contact named Bobby')
  })

  test('a purchase shows the seller, the price and what it returned', async () => {
    const card = await mount('purchase-paid')
    await vi.waitFor(() => expect(text(card.container)).toContain('Bought'))
    expect(text(card.container)).toContain('weather.x402.example')
    expect(text(card.container)).toContain('0.10 USDC')
    expect(text(card.container)).toContain('Lisbon')
  })

  test('the wallet shows the balance, the allowance left and what waits for a nod', async () => {
    const card = await mount('wallet')
    await vi.waitFor(() => expect(text(card.container)).toContain('48.50 USDC'))
    expect(text(card.container)).toContain('Allowance left')
    expect(text(card.container)).toContain('1 payment needs your nod')
  })
})
