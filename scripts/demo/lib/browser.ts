import { join } from 'node:path'
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core'

/**
 * Headless Chromium with a CTAP2 virtual authenticator (internal transport, user verification, resident keys), so a
 * consent or approval page's `navigator.credentials.create/get` succeed without a person. The authenticator belongs
 * to the page's CDP target and survives navigation; one page drives every owner interaction of a run.
 */
export interface OwnerBrowser {
  readonly context: BrowserContext
  readonly page: Page
  readonly cdp: CDPSession
  readonly authenticatorId: string
  shot(name: string): Promise<string>
  /** Public facts about the passkeys the virtual authenticator holds (never the private key). */
  credentials(): Promise<Array<{ credentialId: string; rpId: string | undefined; signCount: number }>>
  close(): Promise<void>
}

export async function ownerBrowser(evidenceDir: string, onDocument?: (line: string) => void): Promise<OwnerBrowser> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
  const page = await context.newPage()
  if (onDocument !== undefined)
    page.on('response', response => {
      if (response.request().resourceType() === 'document')
        onDocument(
          `${response.request().method()} ${response.url().replace(/([?&]code=)[^&]+/u, '$1<redacted>')} → ${response.status()}`,
        )
    })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return {
    context,
    page,
    cdp,
    authenticatorId,
    shot: async name => {
      const path = join(evidenceDir, `${name}.png`)
      await page.screenshot({ path, fullPage: true })
      return path
    },
    credentials: async () =>
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.map(c => ({
        credentialId: c.credentialId,
        rpId: c.rpId,
        signCount: c.signCount,
      })),
    close: () => browser.close(),
  }
}

/**
 * Proves the virtual authenticator end to end on a local page: register a resident ES256 passkey with user
 * verification, then assert with it. `bun scripts/demo/rehearse.ts --passkey-selftest`.
 */
export async function passkeySelfTest(evidenceDir: string) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        `<!doctype html><title>passkey self-test</title><body><pre id="out">ready</pre><script>
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)))
async function run() {
  const created = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'hm26 self-test' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'owner', displayName: 'Owner' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } })
  const got = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: created.rawId }] } })
  return { created: created.id, asserted: got.id, signature_bytes: got.response.signature.byteLength,
    alg: created.response.getPublicKeyAlgorithm(), authenticatorData: b64(got.response.authenticatorData).slice(0, 16) }
}
</script>`,
        { headers: { 'content-type': 'text/html' } },
      ),
  })
  const owner = await ownerBrowser(evidenceDir)
  try {
    await owner.page.goto(`http://localhost:${server.port}/`)
    const result: unknown = await owner.page.evaluate('run()')
    return { result, credentials: await owner.credentials() }
  } finally {
    await owner.close()
    void server.stop(true)
  }
}
