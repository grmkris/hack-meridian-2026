import { Asset, StrKey } from '@stellar/stellar-sdk'

import {
  ACCOUNT_WASM_HASH,
  DEPOSIT_ROUTER,
  ED25519_VERIFIER,
  HOSTED_FACILITATOR_URL,
  ONBOARD_ROUTER,
  OZ_FACILITATOR_URL,
  PUBNET_PASSPHRASE,
  PUBNET_USDC_ISSUER,
  SPENDING_LIMIT_POLICY,
  TESTNET_FRIENDBOT_URL,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  USDC_CODE,
  USDC_ISSUER,
  USDC_SAC,
  WEBAUTHN_VERIFIER,
  XLM_SAC,
} from './constants.ts'

/**
 * Everything that differs between Stellar networks. A stage picks a preset with `STELLAR_NETWORK` (`testnet`, the
 * development stage, or `pubnet`) and may override any field (config.ts lists the names). Runtime code reads ids only
 * from here.
 */
export type NetworkName = 'testnet' | 'pubnet'

export interface NetworkContracts {
  /** OpenZeppelin smart account WASM; one instance per wallet. */
  readonly accountWasmHash: string
  readonly ed25519Verifier: string
  readonly webauthnVerifier: string
  readonly spendingLimitPolicy: string
  readonly usdcSac: string
  /** CAP-73 router (`pay_and_trust`) for claim links. */
  readonly onboardRouter: string
  /** Deposit router (`register` / `sweep`) for per-wallet deposit addresses; '' = the network has none (feature off). */
  readonly depositRouter: string
  readonly nativeSac: string
}

export interface NetworkFees {
  /** Hard ceiling on any one transaction's fee (stroops), from the enforce simulation. */
  readonly maxFeeStroops: bigint
  /** Suggested ceiling for a grant's first delegated payment (the rule's storage TTL is extended then). */
  readonly firstPullMaxFeeStroops: bigint
  /** Suggested ceiling for any further delegated payment or pull. */
  readonly pullMaxFeeStroops: bigint
  /** Suggested ceiling for an owner-approved payment on a warm account. */
  readonly ownerMaxFeeStroops: bigint
}

export interface NetworkParams {
  readonly name: NetworkName
  readonly passphrase: string
  readonly rpcUrl: string
  /** Second Soroban RPC, used when the first fails to answer (reads and sends). */
  readonly rpcFallbackUrl: string | null
  readonly horizonUrl: string
  /** e.g. `https://stellar.expert/explorer/testnet`; links are `<base>/tx/<hash>`, `<base>/contract/<id>`. */
  readonly explorerBase: string
  /** Friendbot (testnet only); null disables it. */
  readonly friendbotUrl: string | null
  /** CAIP-2 network id x402 uses. */
  readonly x402Network: string
  readonly usdcIssuer: string
  readonly contracts: NetworkContracts
  readonly facilitatorUrl: string
  readonly fallbackFacilitatorUrl: string
  readonly fees: NetworkFees
}

const XLM = (n: number) => BigInt(Math.round(n * 1e7))

export const TESTNET: NetworkParams = {
  name: 'testnet',
  passphrase: TESTNET_PASSPHRASE,
  rpcUrl: TESTNET_RPC_URL,
  rpcFallbackUrl: null,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  explorerBase: 'https://stellar.expert/explorer/testnet',
  friendbotUrl: TESTNET_FRIENDBOT_URL,
  x402Network: 'stellar:testnet',
  usdcIssuer: USDC_ISSUER,
  contracts: {
    accountWasmHash: ACCOUNT_WASM_HASH,
    ed25519Verifier: ED25519_VERIFIER,
    webauthnVerifier: WEBAUTHN_VERIFIER,
    spendingLimitPolicy: SPENDING_LIMIT_POLICY,
    usdcSac: USDC_SAC,
    onboardRouter: ONBOARD_ROUTER,
    depositRouter: DEPOSIT_ROUTER,
    nativeSac: XLM_SAC,
  },
  facilitatorUrl: HOSTED_FACILITATOR_URL,
  fallbackFacilitatorUrl: OZ_FACILITATOR_URL,
  // Testnet rent ran 47–66× the at-target rate on 2026-10-25 (S1, S5, A2 live runs): a first pull cost 24.3 XLM.
  fees: {
    maxFeeStroops: XLM(40),
    firstPullMaxFeeStroops: XLM(35),
    pullMaxFeeStroops: XLM(4),
    ownerMaxFeeStroops: XLM(12),
  },
}

/**
 * Mainnet, from docs/research/mainnet.md (verified read-only 2026-10-25): the same account WASM bytes are uploaded,
 * the verifiers and spending-limit policy are OpenZeppelin's mainnet instances, the SACs are derived from their
 * assets. The CAP-73 router is not deployed on mainnet yet, so `ONBOARD_ROUTER_ID` stays a required override and the
 * layer refuses to start without it.
 */
export const PUBNET: NetworkParams = {
  name: 'pubnet',
  passphrase: PUBNET_PASSPHRASE,
  rpcUrl: 'https://mainnet.sorobanrpc.com',
  rpcFallbackUrl: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
  horizonUrl: 'https://horizon.stellar.org',
  explorerBase: 'https://stellar.expert/explorer/public',
  friendbotUrl: null,
  x402Network: 'stellar:pubnet',
  usdcIssuer: PUBNET_USDC_ISSUER,
  contracts: {
    accountWasmHash: ACCOUNT_WASM_HASH,
    ed25519Verifier: 'CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC',
    webauthnVerifier: 'CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR',
    spendingLimitPolicy: 'CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4',
    usdcSac: new Asset(USDC_CODE, PUBNET_USDC_ISSUER).contractId(PUBNET_PASSPHRASE),
    onboardRouter: '',
    // Not deployed on mainnet: deposit addresses stay off there until the router passes its testnet rehearsal.
    depositRouter: '',
    nativeSac: Asset.native().contractId(PUBNET_PASSPHRASE),
  },
  // x402.org has no pubnet; OpenZeppelin Channels lists stellar:pubnet (Bearer key from its /gen endpoint).
  facilitatorUrl: 'https://channels.openzeppelin.com/x402',
  fallbackFacilitatorUrl: '',
  // Mainnet rent is ~660× cheaper than testnet today (a delegated payment ≈ 0.015 XLM), and XLM is real.
  fees: {
    maxFeeStroops: XLM(1),
    firstPullMaxFeeStroops: XLM(0.5),
    pullMaxFeeStroops: XLM(0.1),
    ownerMaxFeeStroops: XLM(0.1),
  },
}

export const PRESETS: Readonly<Record<NetworkName, NetworkParams>> = { testnet: TESTNET, pubnet: PUBNET }

/** `testnet`; `pubnet`, `mainnet` and `public` all mean pubnet. */
export const networkName = (s: string): NetworkName | undefined =>
  s === 'testnet' ? 'testnet' : s === 'pubnet' || s === 'mainnet' || s === 'public' ? 'pubnet' : undefined

/** Fields a network cannot run without that are empty or malformed (the pubnet preset until S7 fills it). */
export const missingFields = (n: NetworkParams): ReadonlyArray<string> => {
  const out: Array<string> = []
  const contract = (name: string, id: string) => {
    if (!StrKey.isValidContract(id)) out.push(name)
  }
  if (n.passphrase === '') out.push('passphrase (STELLAR_NETWORK_PASSPHRASE)')
  if (!/^https?:\/\//u.test(n.rpcUrl)) out.push('rpcUrl (STELLAR_RPC_URL)')
  if (!/^[0-9a-f]{64}$/u.test(n.contracts.accountWasmHash)) out.push('accountWasmHash (ACCOUNT_WASM_HASH)')
  contract('ed25519Verifier (ED25519_VERIFIER_ID)', n.contracts.ed25519Verifier)
  contract('webauthnVerifier (WEBAUTHN_VERIFIER_ID)', n.contracts.webauthnVerifier)
  contract('spendingLimitPolicy (SPENDING_LIMIT_POLICY_ID)', n.contracts.spendingLimitPolicy)
  contract('usdcSac (USDC_SAC_ID)', n.contracts.usdcSac)
  contract('onboardRouter (ONBOARD_ROUTER_ID)', n.contracts.onboardRouter)
  contract('nativeSac (NATIVE_SAC_ID)', n.contracts.nativeSac)
  // Optional: empty turns deposit addresses off; anything else must be a contract id.
  if (n.contracts.depositRouter !== '') contract('depositRouter (DEPOSIT_ROUTER_ID)', n.contracts.depositRouter)
  if (!StrKey.isValidEd25519PublicKey(n.usdcIssuer)) out.push('usdcIssuer (USDC_ISSUER)')
  return out
}

export const explorerTx = (n: NetworkParams, hash: string): string => `${n.explorerBase}/tx/${hash}`
export const explorerContract = (n: NetworkParams, id: string): string => `${n.explorerBase}/contract/${id}`
export const explorerAccount = (n: NetworkParams, id: string): string => `${n.explorerBase}/account/${id}`
export const usdcAssetOf = (n: NetworkParams): Asset => new Asset(USDC_CODE, n.usdcIssuer)
