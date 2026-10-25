import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import cardHtml from './cards/card.html?raw'
import type { NetworkShape } from './network.ts'

/**
 * MCP Apps: the `ui://` resources Nod's tools render with (cards in the chat). One sealed HTML file
 * (`cards/card.html`, built by `bun run cards:build` from `src/card/`) serves two views; the server tells the card
 * which one with `<meta name="nod-view">`. The card has an empty CSP: it reaches nothing but the host, and gets all
 * its data through host-proxied `tools/call` to this server. Both lanes serve these: the legacy lane through
 * `registerApps`, the 2026-07-28 lane through `listResources` and `readResource`.
 */

export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

/** One tool result, inline in the chat. */
export const CARD_URI = 'ui://nod/card/v1'
/** The wallet, pinned or fullscreen (the `nod_home` tool). */
export const HOME_URI = 'ui://nod/home/v1'

interface AppView {
  readonly uri: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly view: 'card' | 'home'
  readonly displayModes: ReadonlyArray<'inline' | 'fullscreen'>
  readonly preferredDisplayMode: 'inline' | 'fullscreen'
}

/** What hosts read about each view names the stage's network (Stellar Testnet or Stellar Mainnet). */
const viewsOn = (label: NetworkShape['label']): ReadonlyArray<AppView> => [
  {
    uri: CARD_URI,
    name: 'nod-card',
    title: 'Nod',
    description: `A payment, a purchase or the wallet from Nod, with the approve link when it needs the user's nod. Stellar ${label}.`,
    view: 'card',
    displayModes: ['inline'],
    preferredDisplayMode: 'inline',
  },
  {
    uri: HOME_URI,
    name: 'nod-home',
    title: 'Nod wallet',
    description: `The Nod wallet: its USDC balance, this AI app's allowance, payments waiting for the user's nod and recent receipts. Stellar ${label}.`,
    view: 'home',
    displayModes: ['inline', 'fullscreen'],
    preferredDisplayMode: 'fullscreen',
  },
]

/** The card reaches nothing: no fetches, no remote scripts, styles, fonts or frames. */
const EMPTY_CSP = { connectDomains: [], resourceDomains: [], frameDomains: [] }

/** Resource metadata, on the `resources/list` entry and again on the `resources/read` content item (Goblin reads that). */
const resourceMeta = (view: AppView) => ({
  ui: { csp: EMPTY_CSP, prefersBorder: true },
  'openai/ui': { availableDisplayModes: [...view.displayModes], preferredDisplayMode: view.preferredDisplayMode },
  'openai/widgetDescription': view.description,
  'openai/widgetPrefersBorder': true,
  'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
})

/** `_meta` for a tool that renders with a view: the standard key and the aliases older hosts read. */
export const renderMeta = (uri: string) => ({
  ui: { resourceUri: uri },
  'ui/resourceUri': uri,
  'openai/outputTemplate': uri,
})

/** `_meta` for `nod_home`: rendered fullscreen, called by the card and the host's launcher, never by the model. */
export const homeMeta = () => ({
  ui: { resourceUri: HOME_URI, visibility: ['app'] },
  'ui/resourceUri': HOME_URI,
  'openai/outputTemplate': HOME_URI,
  'openai/ui': { entrypoints: [{ type: 'global' }] },
})

/** The sealed card with the view it should render. */
const htmlFor = (view: AppView): string =>
  cardHtml.replace('<head>', `<head><meta name="nod-view" content="${view.view}">`)

export const listResources = (label: NetworkShape['label']) => ({
  resources: viewsOn(label).map(view => ({
    uri: view.uri,
    name: view.name,
    title: view.title,
    description: view.description,
    mimeType: MCP_APP_MIME_TYPE,
    _meta: resourceMeta(view),
  })),
})

const INVALID_PARAMS = -32602

export const readResource = async (uri: string, label: NetworkShape['label']) => {
  const view = viewsOn(label).find(candidate => candidate.uri === uri)
  if (view === undefined) {
    throw Object.assign(new Error(`Unknown resource ${uri}`), { code: INVALID_PARAMS })
  }
  return { contents: [{ uri: view.uri, mimeType: MCP_APP_MIME_TYPE, text: htmlFor(view), _meta: resourceMeta(view) }] }
}

/** The legacy lane declares resources and answers the three resource methods. */
export const appsCapabilities = { resources: {} }

export const registerApps = (server: Server, label: NetworkShape['label']): void => {
  server.setRequestHandler(ListResourcesRequestSchema, async () => listResources(label))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }))
  server.setRequestHandler(ReadResourceRequestSchema, async request => readResource(request.params.uri, label))
}
