/**
 * Our `SchemeNetworkClient` for x402 `exact` on Stellar, so a smart account (C-address) can pay.
 *
 * It is the @x402/stellar 2.28.0 client scheme (dist/esm/chunk-EGJCLWK3.mjs, ~60 lines) with ONE change:
 * instead of `signAuthEntries({ address, signAuthEntry, expiration })` (which ends in the SDK's ed25519 branch
 * and `Keypair.fromPublicKey("C…")` → "invalid version byte", issue x402#3158), it passes a custom
 * `authorizeEntry` that hands stellar-sdk 16.4.1 a ready `{ signatureScVal }`. What goes into that ScVal is the
 * caller's business, via `signer.signPayload(payloadHash, ctx)`:
 *   - G account:                ed25519SignatureScVal(kp, payloadHash)   (proves the path without S1)
 *   - OZ smart account (S1):    AuthPayload { context_rule_ids, signers: { External(verifier, pk) → sig(digest) } }
 *                               see scheme/smart-account.ts → ozConnectionSigner()
 *
 * Exports: SmartAccountExactStellarScheme, SignPayload, PayloadSigner, ed25519SignatureScVal.
 */
import { Keypair, StrKey, authorizeEntry, contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import {
  findDefaultAsset,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  handleSimulationResult,
  isStellarNetwork,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "@x402/stellar";

export type SignPayloadContext = {
  /** The unsigned auth entry (address credentials for `signer.address`), already carrying the expiration. */
  entry: xdr.SorobanAuthorizationEntry;
  preimage: xdr.HashIdPreimage;
  expirationLedger: number;
  networkPassphrase: string;
  requirements: PaymentRequirements;
};
/** Given sha256(HashIdPreimage) of the payer's auth entry, return the credential's `signature` ScVal. */
export type SignPayload = (payloadHash: Buffer, ctx: SignPayloadContext) => Promise<xdr.ScVal>;
export interface PayloadSigner {
  /** The payer: a G… or C… address. */
  address: string;
  signPayload: SignPayload;
}

/** The ScVal a classic account's `__check_auth` equivalent expects: Vec[Map{public_key, signature}]. */
export function ed25519SignatureScVal(kp: Keypair, payloadHash: Buffer): xdr.ScVal {
  const signature = kp.sign(payloadHash);
  return xdr.ScVal.scvVec([
    nativeToScVal(
      { public_key: StrKey.decodeEd25519PublicKey(kp.publicKey()), signature },
      { type: { public_key: ["symbol", null], signature: ["symbol", null] } },
    ),
  ]);
}

export class SmartAccountExactStellarScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly findDefaultAsset = findDefaultAsset;
  /** Set after each payment; handy for logs and tests. */
  lastExpirationLedger?: number;

  constructor(
    private readonly signer: PayloadSigner,
    private readonly rpcConfig?: { url?: string },
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    try {
      this.validate(paymentRequirements);
    } catch (error) {
      throw new Error(`Invalid input parameters for creating Stellar payment, cause: ${error}`);
    }
    const from = this.signer.address;
    const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = paymentRequirements;
    const networkPassphrase = getNetworkPassphrase(network);
    const rpcUrl = getRpcUrl(network, this.rpcConfig);
    if (!extra?.areFeesSponsored) throw new Error(`Exact scheme requires areFeesSponsored to be true`);

    const rpcServer = getRpcClient(network, this.rpcConfig);
    const currentLedger = (await rpcServer.getLatestLedger()).sequence;
    const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
    const maxLedger = currentLedger + Math.ceil(maxTimeoutSeconds / ledgerSeconds);

    // Recording-mode simulation of USDC.transfer(from, payTo, amount) with the null source account.
    const tx = await contract.AssembledTransaction.build({
      contractId: asset,
      method: "transfer",
      args: [nativeToScVal(from, { type: "address" }), nativeToScVal(payTo, { type: "address" }), nativeToScVal(amount, { type: "i128" })],
      networkPassphrase,
      rpcUrl,
      parseResultXdr: (result: xdr.ScVal) => result,
    });
    handleSimulationResult(tx.simulation);
    let missing = tx.needsNonInvokerSigningBy();
    if (!missing.includes(from) || missing.length > 1) throw new Error(`Expected to sign with [${from}], but got [${missing.join(", ")}]`);

    // THE change: a custom authorizeEntry that returns { signatureScVal } instead of a raw ed25519 signature.
    await tx.signAuthEntries({
      address: from,
      expiration: maxLedger,
      authorizeEntry: (entry, _signer, expirationLedger, passphrase) =>
        authorizeEntry(
          entry,
          async (preimage: xdr.HashIdPreimage, payloadHash: Buffer) => ({
            signatureScVal: await this.signer.signPayload(payloadHash, {
              entry,
              preimage,
              expirationLedger: expirationLedger ?? maxLedger,
              networkPassphrase: passphrase ?? networkPassphrase,
              requirements: paymentRequirements,
            }),
          }),
          expirationLedger ?? maxLedger,
          passphrase ?? networkPassphrase,
        ),
    });
    this.lastExpirationLedger = maxLedger;

    // Enforcing-mode re-simulation: runs the payer's __check_auth (and, for an OZ account, verifier + policy).
    await tx.simulate();
    handleSimulationResult(tx.simulation);
    missing = tx.needsNonInvokerSigningBy();
    if (missing.length > 0) throw new Error(`unexpected signer(s) required: [${missing.join(", ")}]`);

    return { x402Version, payload: { transaction: tx.built!.toXDR() } };
  }

  private validate(r: PaymentRequirements) {
    if (typeof r.amount !== "string" || !Number.isInteger(Number(r.amount)) || Number(r.amount) <= 0)
      throw new Error(`Invalid amount: ${r.amount}. Amount must be a positive integer.`);
    if (r.scheme !== "exact") throw new Error(`Unsupported scheme: ${r.scheme}`);
    if (!isStellarNetwork(r.network)) throw new Error(`Unsupported Stellar network: ${r.network}`);
    if (!validateStellarDestinationAddress(r.payTo)) throw new Error(`Invalid Stellar destination address: ${r.payTo}`);
    if (!validateStellarAssetAddress(r.asset)) throw new Error(`Invalid Stellar asset address: ${r.asset}`);
  }
}
