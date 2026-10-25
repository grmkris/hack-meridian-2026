import { Runtime } from 'foldkit'

import type { App } from '@modelcontextprotocol/ext-apps/app-with-deps'

import { liveHost } from './host'
import { type Flags, makeElement } from './main'

type Transport = Parameters<App['connect']>[0]

/**
 * Embeds the card program in `container` and wires it to the ext-apps `App`: the host's notifications go into the
 * program's inbound ports before `connect()`, so a tool result that arrives during the handshake is not lost. Without
 * a transport, `connect()` talks to the parent window (the chat). The bridge tests pass an in-memory one.
 */
export const bootCard = (app: App, container: HTMLElement, flags: Flags, transport?: Transport) => {
  const handle = Runtime.embed(makeElement(container, flags, liveHost(app)))

  app.ontoolinput = params => handle.ports.toolInput.send(params)
  app.ontoolresult = params => handle.ports.toolResult.send(params)
  app.ontoolcancelled = params => handle.ports.toolCancelled.send(params)
  app.onhostcontextchanged = params => handle.ports.hostContext.send(params)

  const connect = async () => {
    try {
      await app.connect(transport)
    } catch (error) {
      handle.ports.connectFailed.send(error instanceof Error ? error.message : 'the chat did not answer the handshake')
      return
    }
    handle.ports.connected.send({
      capabilities: app.getHostCapabilities() ?? {},
      context: app.getHostContext() ?? {},
      hostInfo: app.getHostVersion() ?? {},
    })
  }
  const connected = connect()
  return { handle, connected }
}
