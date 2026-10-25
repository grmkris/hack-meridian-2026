import { Match } from 'effect'

import type { PaymentView } from '@hm/protocol'

/** Where a payment stands, as the card shows it, and the sentence the AI gets when the card sees it finish. */

export type PaymentPhase = 'Ready' | 'NeedsNod' | 'Paying' | 'Claim' | 'Approved' | 'Receipt' | 'Failed' | 'Expired'

export const phaseOf = (payment: PaymentView): PaymentPhase =>
  Match.value(payment.status).pipe(
    Match.withReturnType<PaymentPhase>(),
    Match.when('prepared', () => 'Ready'),
    Match.when('awaiting_approval', () => 'NeedsNod'),
    Match.when('approved', () => {
      if (payment.kind !== 'payment') {
        return 'Approved'
      }
      if (payment.recipient.readiness === 'trustline_required' && payment.claim_url !== null) {
        return 'Claim'
      }
      return 'Paying'
    }),
    Match.whenOr('reserved', 'submitted', () => 'Paying'),
    Match.when('confirmed', () => 'Receipt'),
    Match.when('failed', () => 'Failed'),
    Match.when('expired', () => 'Expired'),
    Match.exhaustive,
  )

/** No more changes to wait for: a receipt, a failure, an expiry, or a purchase the AI must now finish itself. */
export const isSettled = (payment: PaymentView): boolean =>
  Match.value(phaseOf(payment)).pipe(
    Match.withReturnType<boolean>(),
    Match.whenOr('Receipt', 'Failed', 'Expired', 'Approved', () => true),
    Match.orElse(() => false),
  )

export const recipientName = (payment: PaymentView): string => payment.recipient.name ?? payment.recipient.address

const networkName = (payment: PaymentView): string => (payment.network === 'stellar:pubnet' ? 'mainnet' : 'testnet')

/** One sentence for the AI's context once the card has watched the payment settle. */
export const settledSentence = (payment: PaymentView): string =>
  Match.value(phaseOf(payment)).pipe(
    Match.withReturnType<string>(),
    Match.when('Receipt', () =>
      payment.receipt === null
        ? `Payment ${payment.payment_id} of ${payment.amount} USDC to ${recipientName(payment)} is confirmed on Stellar ${networkName(payment)}.`
        : `Payment ${payment.payment_id} of ${payment.amount} USDC to ${recipientName(payment)} is confirmed on Stellar ${networkName(payment)}: transaction ${payment.receipt.tx_hash} in ledger ${payment.receipt.ledger} (${payment.receipt.explorer_url}). This AI app may still spend ${payment.grant_remaining} USDC.`,
    ),
    Match.orElse(() => `Payment ${payment.payment_id}: ${payment.next_step}`),
  )
