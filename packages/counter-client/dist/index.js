import { Buffer } from "buffer";
import { Client as ContractClient, Spec as ContractSpec, } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
if (typeof window !== "undefined") {
    //@ts-ignore Buffer exists
    window.Buffer = window.Buffer || Buffer;
}
export const Errors = {
    1: { message: "Overflow" }
};
export class Client extends ContractClient {
    options;
    static async deploy(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options) {
        return ContractClient.deploy(null, options);
    }
    constructor(options) {
        super(new ContractSpec(["AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAAQAAAAAAAAAIT3ZlcmZsb3cAAAAB",
            "AAAABQAAAAAAAAAAAAAAC0luY3JlbWVudGVkAAAAAAEAAAALaW5jcmVtZW50ZWQAAAAAAgAAAAAAAAACYnkAAAAAABMAAAABAAAAAAAAAAVjb3VudAAAAAAAAAQAAAAAAAAAAg==",
            "AAAAAAAAADNUaGUgY3VycmVudCBjb3VudDsgemVybyBiZWZvcmUgdGhlIGZpcnN0IGluY3JlbWVudC4AAAAABWNvdW50AAAAAAAAAAAAAAEAAAAE",
            "AAAAAAAAAFNBZGRzIG9uZSBvbiBiZWhhbGYgb2YgYGJ5YCwgd2hvIG11c3QgYXV0aG9yaXplIHRoZSBjYWxsLCBhbmQgcmV0dXJucyB0aGUgbmV3IGNvdW50LgAAAAAJaW5jcmVtZW50AAAAAAAAAQAAAAAAAAACYnkAAAAAABMAAAABAAAD6QAAAAQAAAAD"]), options);
        this.options = options;
    }
    fromJSON = {
        count: this.txFromJSON,
        increment: this.txFromJSON
    };
}
