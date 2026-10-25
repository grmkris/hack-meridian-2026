import { env } from 'cloudflare:workers'

import { liveServices, makeApiHandler } from './server/app.ts'

interface Env {
  readonly ASSETS: Fetcher
}

/** One API handler per isolate; its services are built on the first /api request. */
const api = makeApiHandler(liveServices(env))

export default {
  fetch(request, bindings) {
    return new URL(request.url).pathname.startsWith('/api/') ? api.handler(request) : bindings.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
