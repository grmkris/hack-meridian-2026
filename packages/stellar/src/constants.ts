/**
 * Stellar testnet ids for the wallet (docs/research/smart-accounts.md §(a), proven in spikes S1–S3). Testnet only.
 */
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org'
export const TESTNET_FRIENDBOT_URL = 'https://friendbot.stellar.org'
/** CAIP-2 network id x402 uses. */
export const X402_NETWORK = 'stellar:testnet'

/** OpenZeppelin smart account WASM (stellar-accounts v0.7.x build, legacy-concat auth digest). */
export const ACCOUNT_WASM_HASH = '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a'
export const ED25519_VERIFIER = 'CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4'
export const WEBAUTHN_VERIFIER = 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F'
export const SPENDING_LIMIT_POLICY = 'CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G'
/** Circle testnet USDC: the Stellar Asset Contract (7 decimals) and its classic issuer. */
export const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const USDC_CODE = 'USDC'
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
/** S3's CAP-73 router: `pay_and_trust(sender, recipient, token, amount)` = SAC `trust(recipient)` + `transfer`. */
export const ONBOARD_ROUTER = 'CCLFB4I4CNGWHHL53UO33CSWKKXJBANMDGOGL43J7RBT7SWK2H2BPGN4'

export const HOSTED_FACILITATOR_URL = 'https://www.x402.org/facilitator'
export const OZ_FACILITATOR_URL = 'https://channels.openzeppelin.com/x402/testnet'

/** Ledgers close every 5 s. */
export const LEDGER_SECONDS = 5
export const LEDGERS_PER_DAY = 17_280
/** 1 USDC (and 1 XLM) = 10^7 stroops. */
export const STROOPS_PER_UNIT = 10_000_000n
/** Inclusion fee in stroops; the resource fee comes from the enforce simulation. */
export const INCLUSION_FEE = 1_000

export const explorerTx = (hash: string): string => `https://stellar.expert/explorer/testnet/tx/${hash}`
export const explorerContract = (id: string): string => `https://stellar.expert/explorer/testnet/contract/${id}`
export const explorerAccount = (id: string): string => `https://stellar.expert/explorer/testnet/account/${id}`
