import { Schema } from 'effect'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, webkit } from 'playwright-core'

import { fixture } from '../apps/web/src/backend/fixture'
import { Assertion, NewWallet } from '../packages/api/src/index'

/** Local compiled-page acceptance. APIs are intercepted; no real wallet/transaction. Chromium uses a virtual
 * authenticator; Linux WebKit has no credential API, so its supported-browser recovery UI uses a rejecting stub. */
const origin = process.argv[2] ?? 'http://localhost:18965'
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use an isolated local build')
const engineName = process.argv[3] ?? 'chromium'
assert(engineName === 'chromium' || engineName === 'webkit')
const executablePath = process.env['HM_BROWSER_EXECUTABLE']
const browser = await (engineName === 'webkit' ? webkit : chromium).launch(
  executablePath === undefined ? {} : { executablePath },
)
const directory = resolve('.local/landing-iteration')
mkdirSync(directory, { recursive: true })
const results: Array<unknown> = []
const decode = (value: string) => Buffer.from(value, 'base64url')
const ClientData = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, challenge: Schema.String, origin: Schema.String }),
)
const checkClientData = (encoded: string, type: string, challenge: string) => {
  const bytes = decode(encoded)
  const data = Schema.decodeUnknownSync(ClientData)(bytes.toString())
  assert.equal(data.type, type)
  assert.equal(data.challenge, challenge)
  assert.equal(data.origin, origin)
  return bytes
}
try {
  for (const scenario of ['new-wallet', 'unavailable', 'network-failure']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const pageErrors: Array<string> = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const requests: Array<string> = []
    const challenge = randomBytes(32).toString('base64url')
    const registrationChallenge = randomBytes(32).toString('base64url')
    let signedIn = false
    let publicKey: KeyObject | undefined
    let credentialId: string | undefined
    let registered = false
    let asserted = false
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const key = `${request.method()} ${path}`
      requests.push(key)
      const send = (json: unknown, status = 200) => route.fulfill({ status, json })
      if (key === 'GET /api/session') {
        return signedIn ? send({ wallet: fixture.wallet }) : send({ _tag: 'Unauthorized', error: 'Sign in.' }, 401)
      }
      if (key === 'POST /api/session/options') {
        return scenario === 'network-failure'
          ? send({ _tag: 'Unavailable', error: 'Connection interrupted. Please try again.' }, 503)
          : send({ challenge, rp_id: new URL(origin).hostname, allow_credentials: [] })
      }
      if (key === 'POST /api/wallets/options') {
        return send({
          challenge: registrationChallenge,
          rp_id: new URL(origin).hostname,
          rp_name: 'Nod',
          user_id: randomBytes(32).toString('base64url'),
          user_name: 'Travel',
        })
      }
      if (key === 'POST /api/wallets') {
        const registration = Schema.decodeUnknownSync(NewWallet)(request.postDataJSON())
        assert.equal(registration.name, 'Travel')
        checkClientData(registration.client_data_json, 'webauthn.create', registrationChallenge)
        const point = decode(registration.public_key)
        assert.equal(point.length, 65)
        assert.equal(point[0], 4)
        // Standard P-256 SubjectPublicKeyInfo prefix; Node verifies independently of the Worker's WebCrypto code.
        publicKey = createPublicKey({
          key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), point]),
          format: 'der',
          type: 'spki',
        })
        credentialId = registration.credential_id
        registered = true
        signedIn = true
        return send({ wallet: fixture.wallet })
      }
      if (key === 'POST /api/session') {
        const assertion = Schema.decodeUnknownSync(Assertion)(request.postDataJSON())
        assert(publicKey !== undefined)
        assert.equal(assertion.credential_id, credentialId)
        const clientData = checkClientData(assertion.client_data_json, 'webauthn.get', challenge)
        const authData = decode(assertion.authenticator_data)
        assert(authData.length >= 37)
        assert.deepEqual(authData.subarray(0, 32), createHash('sha256').update(new URL(origin).hostname).digest())
        assert.equal((authData[32] ?? 0) & 5, 5, 'user presence and verification')
        assert(
          verify(
            'sha256',
            Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
            publicKey,
            decode(assertion.signature),
          ),
        )
        asserted = true
        signedIn = true
        return send({ wallet: fixture.wallet })
      }
      if (key === 'POST /api/session/sign-out') {
        signedIn = false
        return route.fulfill({ status: 204 })
      }
      if (key === 'GET /api/overview') {
        return send({
          wallet: fixture.wallet,
          balances: { usdc: '0', xlm: '0' },
          network: 'stellar:testnet',
          explorer_base: 'https://stellar.expert/explorer/testnet',
          grants: [],
          pending: [],
          receipts: [],
          deposits_available: false,
        })
      }
      return send({ _tag: 'Unavailable', error: `Unexpected local test request: ${key}` }, 503)
    })
    if (engineName === 'webkit' && scenario !== 'unavailable') {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'credentials', {
          value: { get: () => Promise.reject(new DOMException('No credential selected', 'NotAllowedError')) },
        })
      })
    }
    if (scenario === 'unavailable') {
      await page.addInitScript(() => Object.defineProperty(window, 'PublicKeyCredential', { value: undefined }))
    } else if (scenario === 'new-wallet') {
      if (engineName === 'chromium') {
        const cdp = await context.newCDPSession(page)
        await cdp.send('WebAuthn.enable')
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        })
      }
      await page.addInitScript(() => {
        const get = navigator.credentials.get.bind(navigator.credentials)
        let first = true
        navigator.credentials.get = options => {
          if (first) {
            first = false
            return Promise.reject(new DOMException('No credential selected', 'NotAllowedError'))
          }
          return get(options)
        }
      })
    }
    await page.goto(origin)
    await page.getByRole('button', { name: 'Connect wallet' }).waitFor()
    assert.equal(await page.getByLabel('Wallet name').count(), 0)
    assert.equal(await page.locator('.nod-card').count(), 0)
    assert.equal(await page.locator('.landing-hero [data-testid="add-to-claude"]').count(), 0)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    if (scenario === 'unavailable') {
      await page.getByText('This browser cannot use passkeys.', { exact: false }).waitFor()
      assert.equal(requests.filter(request => request.startsWith('POST ')).length, 0)
      assert.equal(await page.getByTestId('choose-create-wallet').count(), 0)
    } else {
      await page.getByTestId('choose-create-wallet').waitFor()
      await page.waitForFunction(() => document.activeElement?.id === 'connect-wallet')
      assert.equal(requests.includes('POST /api/wallets/options'), false)
      assert.equal(requests.includes('POST /api/wallets'), false)
      await page.screenshot({ path: `${directory}/${engineName}-${scenario}-recovery.png` })
      if (scenario === 'network-failure') {
        assert.match(await page.getByRole('alert').innerText(), /Connection interrupted/)
        assert(!/no passkey|no wallet/i.test(await page.getByRole('alert').innerText()))
      } else {
        await page.getByTestId('choose-create-wallet').click()
        await page.getByLabel('Wallet name').fill('  Travel ')
        assert.equal(await page.getByLabel('Wallet name').evaluate(element => element === document.activeElement), true)
        await page.screenshot({ path: `${directory}/${engineName}-create.png` })
        if (engineName === 'chromium') {
          await page.getByRole('button', { name: 'Continue with a passkey' }).click()
          await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
          assert(registered)
          await page.getByRole('button', { name: 'Wallet details', exact: true }).click()
          await page.getByRole('button', { name: 'Sign out' }).click()
          await page.getByRole('button', { name: 'Connect wallet' }).click()
          await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
          assert(asserted)
          assert.equal(requests.filter(request => request === 'POST /api/wallets').length, 1)
        }
      }
    }
    assert.deepEqual(pageErrors, [])
    results.push({
      scenario,
      requests,
      registered,
      asserted,
      credentialApiStubbed: engineName === 'webkit' && scenario !== 'unavailable',
      pageErrors,
    })
    console.log(
      `PASS ${engineName} ${scenario}: explicit entry and recovery${asserted ? ', verified registration and assertion' : ''}`,
    )
    await context.close()
  }
} finally {
  writeFileSync(
    `${directory}/${engineName}-entry.json`,
    JSON.stringify({ origin, engine: engineName, results }, null, 2) + '\n',
  )
  await browser.close()
}
