import {
  ExactStellarClientScheme,
  appendPaymentIdentifierToExtensions,
  createEd25519Signer,
  x402Client,
} from '../../../apps/seller/demo-deps.ts'
import { NETWORK, RPC_URL } from './env.ts'

/**
 * A stock `@x402/stellar` client paying from a classic G account (docs/spikes/s2.md `buildClient`): the payment id
 * goes into the `payment-identifier` extension before signing, so a repeat is a seller-side cache hit.
 */
export function payerClient(secret: string, paymentId?: string) {
  const scheme = new ExactStellarClientScheme(createEd25519Signer(secret, NETWORK), { url: RPC_URL })
  const client = new x402Client().register('stellar:*', scheme)
  client.setSpendControls({ maxAmountPerPayment: '$0.50' })
  let signed = 0
  client.onBeforePaymentCreation(async context => {
    if (paymentId !== undefined) {
      context.paymentRequired.extensions ??= {}
      appendPaymentIdentifierToExtensions(context.paymentRequired.extensions, paymentId)
    }
  })
  client.onAfterPaymentCreation(async () => {
    signed++
  })
  return { client, signed: () => signed }
}
