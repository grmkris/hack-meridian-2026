import * as sdk16 from 'stellar-sdk-16'

import * as sdk17 from '@stellar/stellar-sdk'

type Sdk = typeof sdk17 | typeof sdk16
const SDKS: Record<string, { label: string; sdk: Sdk }> = {
  '17': { label: '@stellar/stellar-sdk 17.3.0', sdk: sdk17 },
  '16': { label: '@stellar/stellar-sdk 16.4.1', sdk: sdk16 },
}

const toHex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

/** 16.x XDR structs expose accessor functions; 17.x exposes plain properties. */
const field = (struct: unknown, name: string): unknown => {
  const value = (struct as Record<string, unknown>)[name]
  return typeof value === 'function' ? (value as () => unknown).call(struct) : value
}

/**
 * Prove @stellar/stellar-sdk inside workerd: build + sign a testnet payment offline (Keypair.random() source,
 * sequence 0, one payment op), verify the signature, then call Soroban RPC getLatestLedger from the Worker.
 * `?sdk=16` runs the same with 16.4.1 (the foundation's pin).
 */
export async function probe(url: URL): Promise<Response> {
  const choice = SDKS[url.searchParams.get('sdk') ?? '17']
  if (choice === undefined) return Response.json({ error: 'sdk must be 16 or 17' }, { status: 400 })
  const { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, rpc } = choice.sdk as typeof sdk17
  const started = Date.now()
  const source = Keypair.random()
  const destination = Keypair.random()
  const tx = new TransactionBuilder(new Account(source.publicKey(), '0'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: destination.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(300)
    .build()
  tx.sign(source)
  const signature = field(tx.signatures[0], 'signature') as Uint8Array
  const verified = source.verify(tx.hash(), signature as never)

  let latestLedger: { id: string; sequence: number; protocolVersion: number } | undefined
  let rpcError: string | undefined
  const rpcStarted = Date.now()
  try {
    const ledger = await new rpc.Server('https://soroban-testnet.stellar.org').getLatestLedger()
    latestLedger = { id: ledger.id, sequence: ledger.sequence, protocolVersion: Number(ledger.protocolVersion) }
  } catch (error) {
    rpcError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
  return Response.json({
    sdk: choice.label,
    network_passphrase: Networks.TESTNET,
    source: source.publicKey(),
    destination: destination.publicKey(),
    // 17.x: tx.hash() is a Uint8Array (toString('hex') prints decimals); 16.x: a Buffer. toHex works for both.
    tx_hash: toHex(tx.hash()),
    hash_type: tx.hash().constructor.name,
    signature_verifies: verified,
    envelope_xdr: tx.toXDR(),
    build_sign_ms: Date.now() - started,
    soroban_rpc: {
      url: 'https://soroban-testnet.stellar.org',
      latestLedger,
      error: rpcError,
      ms: Date.now() - rpcStarted,
    },
  })
}
