import { App } from '@modelcontextprotocol/ext-apps/app-with-deps'

import { bootCard } from './boot'

/** Boots the card inside the host's iframe: one ext-apps `App`, the view the server asked for, then the handshake. */

const app = new App({ name: 'Nod', version: '1.0.0' }, {}, { autoResize: true })

const container = document.getElementById('root')
if (container === null) {
  throw new Error('The card page has no #root element.')
}

bootCard(app, container, {
  surface: document.querySelector('meta[name="nod-view"]')?.getAttribute('content') === 'home' ? 'Home' : 'Card',
  isVisible: document.visibilityState === 'visible',
})
