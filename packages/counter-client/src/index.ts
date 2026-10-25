import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const Errors = {
  1: {message:"Overflow"}
}


export interface Client {
  /**
   * Construct and simulate a count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The current count; zero before the first increment.
   */
  count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a increment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds one on behalf of `by`, who must authorize the call, and returns the new count.
   */
  increment: ({by}: {by: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAAQAAAAAAAAAIT3ZlcmZsb3cAAAAB",
        "AAAABQAAAAAAAAAAAAAAC0luY3JlbWVudGVkAAAAAAEAAAALaW5jcmVtZW50ZWQAAAAAAgAAAAAAAAACYnkAAAAAABMAAAABAAAAAAAAAAVjb3VudAAAAAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAADNUaGUgY3VycmVudCBjb3VudDsgemVybyBiZWZvcmUgdGhlIGZpcnN0IGluY3JlbWVudC4AAAAABWNvdW50AAAAAAAAAAAAAAEAAAAE",
        "AAAAAAAAAFNBZGRzIG9uZSBvbiBiZWhhbGYgb2YgYGJ5YCwgd2hvIG11c3QgYXV0aG9yaXplIHRoZSBjYWxsLCBhbmQgcmV0dXJucyB0aGUgbmV3IGNvdW50LgAAAAAJaW5jcmVtZW50AAAAAAAAAQAAAAAAAAACYnkAAAAAABMAAAABAAAD6QAAAAQAAAAD" ]),
      options
    )
  }
  public readonly fromJSON = {
    count: this.txFromJSON<u32>,
        increment: this.txFromJSON<Result<u32>>
  }
}