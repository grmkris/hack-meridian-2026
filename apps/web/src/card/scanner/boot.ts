import { Runtime } from 'foldkit'

import type { App } from '@modelcontextprotocol/ext-apps/app-with-deps'

import { liveHost } from '../host'
import { makeScanner } from './main'

export const bootScanner = (app: App, container: HTMLElement, transport?: Parameters<App['connect']>[0]) => {
  const handle = Runtime.embed(makeScanner(container, liveHost(app)))
  app.ontoolresult = result => handle.ports.result.send(result)
  app.onhostcontextchanged = context => handle.ports.context.send(context)
  app.ontoolcancelled = () => handle.ports.cancelled.send(undefined)
  app.onteardown = async () => {
    handle.dispose()
    return {}
  }
  const connected = app
    .connect(transport)
    .then(() => {
      return handle.ports.connected.send({
        capabilities: app.getHostCapabilities() ?? {},
        context: app.getHostContext() ?? {},
      })
    })
    .catch(() => handle.ports.failed.send(undefined))
  return { handle, connected }
}
