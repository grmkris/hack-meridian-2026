import { Effect, Layer } from 'effect'
import { Base64Url } from 'effect/encoding'
import { chromium } from 'playwright-core'
import { expect, test } from 'vitest'

import { SoftPasskey } from '@hm/stellar/testing'

import { makeApiHandler } from './app.ts'
import { claimLinkById } from './claims.ts'
import { ownerRoute } from './routes.ts'
import type { AppServices } from './runtime.ts'
import { createOwnerWallet, createSession, renameWallet, walletById } from './store.ts'
import { ORIGIN, senderWorld, WALLET } from './test/sender.ts'
import { paymentPrepare } from './tools.ts'

/** Native Chrome WebAuthn against the real owner/API handlers and a fixture chain. No network or onchain writes. */
test('three resident passkeys, mismatch, explicit cancellation, filtered retry, and one installed rule', async () => {
  const w = await senderWorld()
  const api = makeApiHandler(Layer.succeedContext(await w.runtime.runPromise(Effect.context<AppServices>())))
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    const errors: Array<string> = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route(`${ORIGIN}/**`, async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.startsWith('/fonts/') || url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
      const incoming = new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(request.postData() === null ? {} : { body: request.postData() }),
      })
      const response = url.pathname.startsWith('/api/')
        ? await api.handler(incoming)
        : await ownerRoute(w.runtime, incoming, url.pathname)
      if (response === undefined) return route.fulfill({ status: 404 })
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      })
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
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
    const addCredential = async (passkey: SoftPasskey, name: string) => {
      const [serialized] = (await passkey.serialize()).split('.')
      const jwk: JsonWebKey = JSON.parse(Buffer.from(serialized ?? '', 'base64url').toString())
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
      const privateKey = await crypto.subtle.exportKey('pkcs8', key)
      await cdp.send('WebAuthn.addCredential', {
        authenticatorId,
        credential: {
          credentialId: Buffer.from(passkey.credentialId).toString('base64'),
          isResidentCredential: true,
          rpId: 'wallet.test',
          privateKey: Buffer.from(privateKey).toString('base64'),
          userHandle: Buffer.from(name).toString('base64'),
          signCount: 0,
          userName: name,
        },
      })
    }
    const original = await w.runtime.runPromise(walletById(WALLET))
    if (original === undefined) throw new Error('missing sender')
    await w.runtime.runPromise(renameWallet(original, 'kristjan0'))
    const made = await w.runtime.runPromise(
      paymentPrepare(w.ctx, { recipient: 'new', recipient_name: 'Vlad', amount: '7', idempotency_key: 'browser' }),
    )
    const id = made.value.payment_id
    const path = `${ORIGIN}/approve/link/${id}`
    // Vitest runs from the workspace root, including its Worker project.
    const directory = '.local/wallet-identity'
    for (const [i, name] of ['Alexander', 'kristjan1'].entries()) {
      const passkey = await SoftPasskey.create('wallet.test', ORIGIN)
      const wallet = await w.runtime.runPromise(
        createOwnerWallet({
          name,
          network: 'stellar:testnet',
          contractId: `C${String.fromCharCode(65 + i).repeat(55)}`,
          credentialId: Base64Url.encode(passkey.credentialId),
          publicKey: Base64Url.encode(passkey.publicKey65),
          deployTx: null,
          fundTx: null,
        }),
      )
      await addCredential(passkey, name)
      const token = await w.runtime.runPromise(createSession(wallet.owner_id))
      await context.addCookies([{ name: 'hm_owner', value: token, url: ORIGIN }])
      await page.goto(path)
      expect(await page.getByRole('alert').textContent()).toContain(`You selected ${name}`)
      expect(await page.getByTestId('link-approve').count()).toBe(0)
      if (i === 0) await page.screenshot({ path: `${directory}/wrong-wallet-mobile.png`, fullPage: true })
    }
    expect(errors).toEqual([])
    await addCredential(w.passkey, 'kristjan0')
    // A cancelled prompt reveals an explicit all-passkeys fallback.
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
    await page.getByRole('button', { name: 'Try another passkey', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel passkey prompt' }).click()
    await page.getByText('No passkey was used.', { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: 'Choose from all passkeys' }).isVisible()).toBe(true)
    expect((await w.runtime.runPromise(claimLinkById(id)))?.status).toBe('awaiting_nod')

    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
    await page.getByRole('button', { name: 'Try another passkey', exact: true }).click()
    await page.getByTestId('link-approve').waitFor()
    expect(await page.getByRole('alert').count()).toBe(0)
    await page.evaluate(`{
      const get = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = options => {
        document.body.dataset.allowed = JSON.stringify(options.publicKey.allowCredentials.map(c => btoa(String.fromCharCode(...new Uint8Array(c.id)))));
        return get(options);
      };
    }`)
    const before = w.fixture.callsOf('installGrant').length
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false })
    await page.getByTestId('link-approve').click()
    await page.getByRole('button', { name: 'Cancel passkey prompt' }).click()
    await page.getByText('No passkey was used.', { exact: false }).waitFor()
    expect(await page.getByTestId('link-approve').isEnabled()).toBe(true)
    expect(w.fixture.callsOf('installGrant')).toHaveLength(before)
    expect((await w.runtime.runPromise(claimLinkById(id)))?.status).toBe('awaiting_nod')
    await page.screenshot({ path: `${directory}/cancelled-mobile.png`, fullPage: true })
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true })
    await page.getByTestId('link-approve').click()
    await page.getByTestId('link-done').waitFor()
    expect(await page.getAttribute('body', 'data-allowed')).toBe(
      JSON.stringify([Buffer.from(w.passkey.credentialId).toString('base64')]),
    )
    expect(w.fixture.callsOf('installGrant')).toHaveLength(before + 1)
    expect(w.fixture.balanceOf(w.contractId)).toBe(300_000_000n)
    expect(await page.getByTestId('link-url').textContent()).toContain('#k=')
    await page.reload()
    await page.getByTestId('link-done').waitFor()
    expect(w.fixture.callsOf('installGrant')).toHaveLength(before + 1)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.screenshot({ path: `${directory}/approved-desktop.png`, fullPage: true })
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await api.dispose()
  }
}, 30_000)
