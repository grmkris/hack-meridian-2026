import { Match, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { shortAddress } from '../../format'
import { Message } from '../message'
import { LinkCopy, type Model, type TopupCard } from '../model'
import {
  actions,
  amount,
  brandHeader,
  eyebrow,
  facts,
  lead,
  linkFallback,
  note,
  pollStatus,
  textLink,
  time,
} from './parts'

/** wallet_topup_quote / wallet_topup_status: pay on another chain, arrive as USDC in the wallet (NEAR Intents). */

type Builder = HtmlBuilder<Message>

const CHAIN_NAMES: Readonly<Record<string, string>> = {
  base: 'Base',
  solana: 'Solana',
  sol: 'Solana',
  ethereum: 'Ethereum',
  eth: 'Ethereum',
  arbitrum: 'Arbitrum',
  arb: 'Arbitrum',
  polygon: 'Polygon',
  pol: 'Polygon',
}

const chainName = (chain: string): string => CHAIN_NAMES[chain] ?? `${chain.charAt(0).toUpperCase()}${chain.slice(1)}`

/** Top-ups run on mainnet only (1Click has no testnet), so the sweep links to the public explorer. */
const sweepUrl = (hash: string): string => `https://stellar.expert/explorer/public/tx/${hash}`

const payTo = (model: Model, topup: TopupCard, h: Builder): ReadonlyArray<Html> => [
  lead(`Send exactly ${topup.amount_in} ${topup.asset} on ${chainName(topup.origin_chain)} to this address:`, h),
  h.div(
    [h.Class('nod-address')],
    [
      h.p([h.Class('nod-label')], [`Pay to, on ${chainName(topup.origin_chain)}`]),
      h.p([h.Class('nod-mono nod-select'), h.DataAttribute('testid', 'topup-address')], [topup.pay_to]),
    ],
  ),
  actions(
    [
      h.button(
        [h.Type('button'), h.Class('nod-button'), h.OnClick(Message.ClickedCopyLink({ url: topup.pay_to }))],
        [
          LinkCopy.match(model.linkCopy, {
            Idle: () => 'Copy address',
            Copied: () => 'Copied',
            Failed: () => 'Copy address',
          }),
        ],
      ),
    ],
    h,
  ),
  LinkCopy.match(model.linkCopy, {
    Idle: () => h.empty,
    Copied: () => h.p([h.Class('nod-note'), h.Role('status')], ['Copied. Paste it in the wallet you send from.']),
    Failed: () =>
      h.p(
        [h.Class('nod-note'), h.Role('status')],
        ['This chat blocks copying: tap the address to select it, then copy.'],
      ),
  }),
  facts(
    [
      ['Open until', time(topup.deadline, h)],
      ['Arrives as', `about ${topup.amount_out} USDC in your Nod wallet`],
    ],
    h,
  ),
  note('Sent late or not swapped, it goes back to the refund address you gave.', h),
]

export const topupView = (model: Model, topup: TopupCard, h: Builder): ReadonlyArray<Html> => [
  brandHeader(h),
  ...Match.value(topup.status).pipe(
    Match.withReturnType<ReadonlyArray<Html>>(),
    Match.when('pending', () => [
      eyebrow('Top up from another chain', 'quiet', h),
      amount(`${topup.amount_in} ${topup.asset}`, h),
      ...payTo(model, topup, h),
      pollStatus(model, `Waiting for your ${topup.asset} on ${chainName(topup.origin_chain)}`, h),
    ]),
    Match.when('processing', () => [
      eyebrow('Swapping', 'quiet', h),
      amount(`${topup.amount_in} ${topup.asset}`, h),
      lead(`Received on ${chainName(topup.origin_chain)}; NEAR Intents is swapping it to USDC on Stellar.`, h),
      facts([['Arrives as', `about ${topup.amount_out} USDC in your Nod wallet`]], h),
      pollStatus(model, 'Swapping', h),
    ]),
    Match.when('arrived', () => [
      eyebrow('Arrived', 'good', h),
      amount(`${topup.amount_out} USDC`, h),
      lead(`From ${topup.amount_in} ${topup.asset} on ${chainName(topup.origin_chain)}, now in your Nod wallet.`, h),
      ...Option.match(Option.fromNullishOr(topup.sweep_tx), {
        onNone: () => [],
        onSome: hash => [facts([['Swept in', textLink(`${shortAddress(hash)} ↗`, sweepUrl(hash), h)]], h)],
      }),
      linkFallback(model.link, h),
    ]),
    Match.when('failed', () => [
      eyebrow('Not completed', 'bad', h),
      amount(`${topup.amount_in} ${topup.asset}`, h),
      lead(`The swap did not go through. NEAR Intents sends your ${topup.asset} back to the refund address.`, h),
    ]),
    Match.when('expired', () => [
      eyebrow('Expired', 'quiet', h),
      amount(`${topup.amount_in} ${topup.asset}`, h),
      lead('The 30 minutes are up. Anything sent late goes back to the refund address.', h),
    ]),
    Match.exhaustive,
  ),
]
