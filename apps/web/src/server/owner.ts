import { Effect, Option, Schema } from 'effect'

import { Chain, type ChainError, type Wallet, type WebAuthnAssertion } from '@hm/protocol'

import { randomToken } from './clock.ts'
import type { DbError } from './db.ts'
import { inviteRequired, Network } from './network.ts'
import {
  consumeChallenge,
  createChallenge,
  createContact,
  createOwnerWallet,
  createSession,
  ownerOfSession,
  walletByCredential,
  walletOfOwner,
} from './store.ts'
import { WalletCaps } from './wallet-caps.ts'
import { WalletSettings, type Site } from './wallet-settings.ts'
import { b64url, b64urlDecode, readClientData, verifyAssertion, verifyRegistration, WebAuthnError } from './webauthn.ts'

/**
 * The owner's identity is a passkey. These are the ceremonies every surface shares (the SPA's /api, the consent page,
 * the approval page): create a wallet (registration → deploy → welcome USDC), sign in (assertion → session), and check
 * an assertion over a challenge the chain computed (the owner approving one exact invocation).
 */
export class OwnerError extends Schema.TaggedError<OwnerError>()('OwnerError', {
  kind: Schema.Literals(['unauthorized', 'bad_request', 'unavailable']),
  message: Schema.String,
}) {}

export const SESSION_COOKIE = 'hm_owner'

const badRequest = (error: WebAuthnError) => new OwnerError({ kind: 'bad_request', message: error.message })
const unavailable = (error: DbError | ChainError) =>
  new OwnerError({
    kind: 'unavailable',
    message: error._tag === 'DbError' ? `storage failed (${error.operation}); retry` : error.message,
  })

/** Mainnet: wallet creation needs one of the configured invite codes. */
const checkInvite = (code: string | undefined) =>
  Effect.gen(function* () {
    const network = yield* Network
    if (!inviteRequired(network)) return undefined
    if (code === undefined || !network.inviteCodes.includes(code.trim()))
      // The SPA matches this exact string on a 400 and then asks for the code.
      return yield* new OwnerError({ kind: 'bad_request', message: 'invite_required' })
    return undefined
  })

/**
 * `visitor` (a hash of cf-connecting-ip, wallet-caps.ts) counts the creation against the hourly caps: the options only
 * check, so the passkey prompt never opens when no wallet would be created; createWallet takes the slot before the
 * deploy. Without one (Nod's own /sample demo wallet) no cap applies.
 */
export const registrationOptions = (site: Site, name: string, inviteCode?: string, visitor?: string) =>
  Effect.gen(function* () {
    yield* checkInvite(inviteCode)
    if (visitor !== undefined) yield* WalletCaps.use(caps => caps.check(visitor))
    const challenge = yield* createChallenge('register')
    return {
      challenge,
      rp_id: site.rpId,
      rp_name: 'Nod',
      user_id: yield* randomToken,
      user_name: name.trim() === '' ? 'Personal' : name.trim().slice(0, 40),
    }
  }).pipe(Effect.catchTag('DbError', error => Effect.fail(unavailable(error))))

export interface NewWalletInput {
  readonly name: string
  readonly credentialId: string
  readonly publicKey: string
  readonly clientDataJSON: string
  readonly inviteCode?: string | undefined
  /** Counts against the hourly wallet caps (see registrationOptions). */
  readonly visitor?: string | undefined
}

/** Registration → the relayer deploys the smart account with the passkey as admin → treasury sends welcome USDC. */
export const createWallet = (site: Site, input: NewWalletInput) =>
  Effect.gen(function* () {
    yield* checkInvite(input.inviteCode)
    const clientData = yield* b64urlDecode(input.clientDataJSON).pipe(Effect.mapError(badRequest))
    const challenge = (yield* readClientData(clientData).pipe(Effect.mapError(badRequest))).challenge
    if (!(yield* consumeChallenge(challenge, 'register')))
      return yield* new OwnerError({ kind: 'bad_request', message: 'the registration challenge expired; try again' })
    const publicKey = yield* b64urlDecode(input.publicKey).pipe(
      Effect.flatMap(key =>
        verifyRegistration({ clientDataJSON: clientData, publicKey: key, challenge, origins: [site.origin] }),
      ),
      Effect.mapError(badRequest),
    )
    const credentialId = yield* b64urlDecode(input.credentialId).pipe(Effect.mapError(badRequest))
    if ((yield* walletByCredential(input.credentialId)) !== undefined)
      return yield* new OwnerError({ kind: 'bad_request', message: 'this passkey already has a wallet; sign in' })
    const visitor = input.visitor
    if (visitor !== undefined) yield* WalletCaps.use(caps => caps.take(visitor))
    const chain = yield* Chain
    const deployed = yield* chain.deployAccount({ pubkey: publicKey, credentialId })
    const settings = yield* WalletSettings
    const network = yield* Network
    // Welcome USDC from the treasury: testnet only (the judge path), never on mainnet.
    const funded = network.welcomeFunding
      ? yield* chain.fundNewWallet(deployed.contractId, settings.welcomeUsdc).pipe(
          Effect.map(result => result.tx),
          Effect.catchTag('ChainError', error =>
            Effect.as(Effect.logWarning('welcome USDC failed', error.kind, error.message), null),
          ),
        )
      : null
    const wallet = yield* createOwnerWallet({
      network: network.caip,
      name: input.name.trim().slice(0, 40) || 'Personal',
      contractId: deployed.contractId,
      credentialId: input.credentialId,
      publicKey: b64url(publicKey),
      deployTx: deployed.tx,
      fundTx: funded,
    })
    // Demo stages: the wallet starts with Alice, Bob and Carol, readiness read from the chain now.
    yield* Effect.forEach(settings.demoContacts, contact =>
      chain.readiness(contact.address).pipe(
        Effect.map(readiness => (readiness === 'contract' ? ('usdc_ready' as const) : readiness)),
        Effect.catchTag('ChainError', () => Effect.succeed('unverified' as const)),
        Effect.flatMap(readiness =>
          createContact({
            ownerId: wallet.owner_id,
            displayName: contact.name,
            aliases: ['demo contact'],
            address: contact.address,
            memo: null,
            readiness,
          }),
        ),
      ),
    )
    return { wallet, token: yield* createSession(wallet.owner_id) }
  }).pipe(
    Effect.tapError(error => Effect.logError('createWallet failed', error)),
    Effect.catchTags({
      DbError: error => Effect.fail(unavailable(error)),
      ChainError: error => Effect.fail(unavailable(error)),
    }),
  )

export const assertionOptions = (site: Site) =>
  Effect.map(createChallenge('login'), challenge => ({
    challenge,
    rp_id: site.rpId,
    allow_credentials: [] as ReadonlyArray<string>,
  })).pipe(Effect.mapError(unavailable))

export interface AssertionInput {
  readonly credentialId: string
  readonly clientDataJSON: string
  readonly authenticatorData: string
  readonly signature: string
}

const decodeAssertion = (input: AssertionInput) =>
  Effect.all({
    authenticatorData: b64urlDecode(input.authenticatorData),
    clientDataJSON: b64urlDecode(input.clientDataJSON),
    signature: b64urlDecode(input.signature),
  }).pipe(Effect.mapError(badRequest))

/** The wallet's passkey signed `challenge` (WebAuthn checks, then the P-256 signature with the stored key). */
export const checkAssertion = (site: Site, wallet: Wallet, input: AssertionInput, challenge: string) =>
  Effect.gen(function* () {
    if (input.credentialId !== wallet.passkey_credential_id)
      return yield* new OwnerError({ kind: 'unauthorized', message: "that passkey is not this wallet's" })
    const assertion: WebAuthnAssertion = yield* decodeAssertion(input)
    const publicKey = yield* b64urlDecode(wallet.passkey_public_key).pipe(Effect.mapError(badRequest))
    yield* verifyAssertion({ ...assertion, publicKey, challenge, origins: [site.origin], rpId: site.rpId }).pipe(
      Effect.mapError(error => new OwnerError({ kind: 'unauthorized', message: error.message })),
    )
    return assertion
  })

export const signIn = (site: Site, input: AssertionInput) =>
  Effect.gen(function* () {
    const wallet = yield* walletByCredential(input.credentialId)
    if (wallet === undefined)
      return yield* new OwnerError({ kind: 'unauthorized', message: 'no wallet for this passkey; create one' })
    const clientData = yield* b64urlDecode(input.clientDataJSON).pipe(
      Effect.flatMap(readClientData),
      Effect.mapError(badRequest),
    )
    if (!(yield* consumeChallenge(clientData.challenge, 'login')))
      return yield* new OwnerError({ kind: 'bad_request', message: 'the sign-in challenge expired; try again' })
    yield* checkAssertion(site, wallet, input, clientData.challenge)
    return { wallet, token: yield* createSession(wallet.owner_id) }
  }).pipe(Effect.catchTag('DbError', error => Effect.fail(unavailable(error))))

/** The signed-in owner's wallet, from the session cookie's token. */
export const walletOfSession = (token: Option.Option<string>) =>
  Option.match(token, {
    onNone: () => Effect.succeed(undefined),
    onSome: value =>
      Effect.gen(function* () {
        const owner = yield* ownerOfSession(value)
        return owner === undefined ? undefined : yield* walletOfOwner(owner)
      }),
  })

/** The session token in a request's Cookie header. */
export const sessionToken = (request: Request): Option.Option<string> => {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return Option.some(decodeURIComponent(rest.join('=')))
  }
  return Option.none()
}

export const requireWallet = (request: Request) =>
  Effect.flatMap(walletOfSession(sessionToken(request)), wallet =>
    wallet === undefined
      ? Effect.fail(new OwnerError({ kind: 'unauthorized', message: 'sign in with your passkey' }))
      : Effect.succeed(wallet),
  )

export { WebAuthnError }
