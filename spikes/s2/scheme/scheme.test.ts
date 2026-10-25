/**
 * Unit tests for our SchemeNetworkClient (scheme/index.ts), proven against a G-address signer first so the
 * signatureScVal path is independent of S1's smart account.
 *
 *   bun test scheme            # offline tests + one testnet verify (no settlement) if spikes/s2/.env exists
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Address, Keypair, Networks, StrKey, authorizeEntry, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { SmartAccountExactStellarScheme, authorizeEntryWithScVal, ed25519SignatureScVal } from "./index";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PASS = Networks.TESTNET;
const EXP = 5_400_000;
const payTo = Keypair.random().publicKey();
const req: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "1000000",
  asset: USDC,
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

/** An unsigned SAC transfer auth entry for `from`, exactly the shape a recording simulation returns. */
function unsignedTransferEntry(from: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(from).toScAddress(),
        nonce: xdr.Int64.fromString("1234567890123"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(USDC).toScAddress(),
          functionName: "transfer",
          args: [new Address(from).toScVal(), new Address(payTo).toScVal(), nativeToScVal("1000000", { type: "i128" })],
        }),
      ),
      subInvocations: [],
    }),
  });
}

describe("authorizeEntryWithScVal (offline)", () => {
  test("G payer: the signatureScVal path is byte-identical to the SDK's built-in ed25519 path", async () => {
    const kp = Keypair.random();
    const entry = unsignedTransferEntry(kp.publicKey());
    const sdk = await authorizeEntry(entry, kp, EXP, PASS);
    const ours = await authorizeEntryWithScVal(entry, async (h) => ed25519SignatureScVal(kp, h), EXP, PASS, req);
    expect(ours.toXDR("base64")).toBe(sdk.toXDR("base64"));
  });

  test("payloadHash handed to the callback is sha256(HashIdPreimage) and carries the expiration", async () => {
    const kp = Keypair.random();
    let seen: { h: Buffer; pre: xdr.HashIdPreimage; exp: number } | undefined;
    await authorizeEntryWithScVal(
      unsignedTransferEntry(kp.publicKey()),
      async (h, ctx) => {
        seen = { h, pre: ctx.preimage, exp: ctx.expirationLedger };
        return ed25519SignatureScVal(kp, h);
      },
      EXP,
      PASS,
      req,
    );
    expect(seen).toBeDefined();
    expect(seen!.h.equals(hash(seen!.pre.toXDR()))).toBe(true);
    expect(seen!.pre.sorobanAuthorization().signatureExpirationLedger()).toBe(EXP);
    expect(seen!.pre.sorobanAuthorization().networkId().equals(hash(Buffer.from(PASS)))).toBe(true);
    const sig = (seen && ed25519SignatureScVal(kp, seen.h).vec()![0]!.map()![1]!.val().bytes()) as Buffer;
    expect(kp.verify(seen!.h, sig)).toBe(true);
  });

  test("C payer: the entry carries exactly the callback's ScVal (OZ AuthPayload shape), expiration set", async () => {
    const cAddr = StrKey.encodeContract(Buffer.alloc(32, 7));
    const authPayload = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: xdr.ScVal.scvMap([]) }),
    ]);
    const signed = await authorizeEntryWithScVal(unsignedTransferEntry(cAddr), async () => authPayload, EXP, PASS, req);
    const creds = signed.credentials().address();
    expect(Address.fromScAddress(creds.address()).toString()).toBe(cAddr);
    expect(creds.signatureExpirationLedger()).toBe(EXP);
    expect(creds.signature().toXDR("base64")).toBe(authPayload.toXDR("base64"));
  });

  test("C payer through the stock path (raw signature buffer) fails as in x402#3158", async () => {
    const cAddr = StrKey.encodeContract(Buffer.alloc(32, 7));
    const kp = Keypair.random();
    // What @x402/stellar 2.28.0 does: signAuthEntries → signAuthEntry returns a raw ed25519 signature buffer.
    const p = authorizeEntry(unsignedTransferEntry(cAddr), async (pre) => kp.sign(hash(pre.toXDR())), EXP, PASS);
    await expect(p).rejects.toThrow(/invalid version byte/i);
  });
});

const hasEnv = existsSync(join(import.meta.dir, "..", ".env"));
describe.skipIf(!hasEnv)("SmartAccountExactStellarScheme on testnet (G signer, verify only, no settlement)", () => {
  test("payload passes the stock @x402/stellar facilitator verify()", async () => {
    const { secret, pub, RPC_URL } = await import("../lib/env");
    const { facilitatorScheme } = await import("../facilitator/local");
    const kp = Keypair.fromSecret(secret("PAYER"));
    const scheme = new SmartAccountExactStellarScheme(
      { address: kp.publicKey(), signPayload: async (h) => ed25519SignatureScVal(kp, h) },
      { url: RPC_URL },
    );
    const r = { ...req, payTo: pub("PAYTO") };
    const partial = await scheme.createPaymentPayload(2, r);
    const verdict = await facilitatorScheme().verify({ ...partial, accepted: r, resource: { url: "test://s2" } } as never, r);
    expect(verdict).toEqual({ isValid: true, payer: kp.publicKey() });
  }, 60_000);
});
