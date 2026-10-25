import { Layer } from 'effect'

import type { Backend } from './backend'
import { fixtureBackend } from './fixture'
import { httpBackend } from './http'
import type { Passkey } from './passkey'
import { fixturePasskey, livePasskey } from './passkey'

export * from './backend'
export * from './passkey'
export * from './views'

/**
 * The services every Command may use, chosen when the site is built: `VITE_BACKEND=fixture` (or
 * `fixture-signed-out`) runs the site against the in-memory fixture with a fake passkey, for building pages before
 * the service exists and for screenshots; anything else talks to the Worker's /api with the device's real passkey.
 */
/** The services the site's Commands may require; `resources` provides them for the life of the page. */
export type Resources = Backend | Passkey

const choice = import.meta.env['VITE_BACKEND']

export const resources =
  choice === 'fixture' || choice === 'fixture-signed-out'
    ? Layer.mergeAll(fixtureBackend({ signedIn: choice === 'fixture' }), fixturePasskey)
    : Layer.mergeAll(httpBackend, livePasskey)
