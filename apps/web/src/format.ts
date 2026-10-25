import { DateTime, Option, Predicate, Schema, String } from 'effect'

import { DecimalAmount, Stroops, toStroops as decimalToStroops, fromStroops } from '@hm/protocol'

/** An amount from the Worker: stroops as a decimal string on the wire, or already a bigint. */
export type Amount = string | bigint

const decodeStroops = Schema.decodeUnknownOption(Stroops)

export const toStroops = (amount: Amount): Option.Option<bigint> =>
  Predicate.isString(amount) ? decodeStroops(amount) : Option.some(amount)

const formatAmount = (amount: Amount, unit: string): string =>
  Option.match(toStroops(amount), {
    onNone: () => `${globalThis.String(amount)} ${unit}`,
    onSome: value => `${fromStroops(value)} ${unit}`,
  })

export const usdc = (amount: Amount): string => formatAmount(amount, 'USDC')

export const xlm = (amount: Amount): string => formatAmount(amount, 'XLM')

const decodeDecimal = Schema.decodeUnknownOption(DecimalAmount)

/** A decimal amount as the MCP tools send it ("20", "0.1"), in stroops when it is one. */
export const decimalStroops = (amount: string): Option.Option<bigint> =>
  Option.map(decodeDecimal(amount), decimalToStroops)

/** A decimal amount from an MCP tool as the owner reads it: "20" → "20.00 USDC"; a malformed one is shown as sent. */
export const decimalUsdc = (amount: string): string =>
  Option.match(decimalStroops(amount), { onNone: () => `${amount} USDC`, onSome: usdc })

const ADDRESS_EDGE = 4

export const shortAddress = (address: string): string =>
  `${String.slice(0, ADDRESS_EDGE)(address)}…${String.slice(-ADDRESS_EDGE)(address)}`

const DATE_TIME: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}

export const dateTime = (iso: string): string =>
  Option.match(DateTime.make(iso), {
    onNone: () => iso,
    onSome: value => `${DateTime.formatUtc(value, { ...DATE_TIME, locale: 'en-GB' })} UTC`,
  })

const NETWORKS: Readonly<Record<string, Readonly<{ label: string; explorer: string; isMainnet: boolean }>>> = {
  'stellar:testnet': { label: 'Testnet', explorer: 'https://stellar.expert/explorer/testnet', isMainnet: false },
  'stellar:pubnet': { label: 'Mainnet', explorer: 'https://stellar.expert/explorer/public', isMainnet: true },
}

const networkOf = (network: string) =>
  NETWORKS[network] ?? { label: network, explorer: 'https://stellar.expert/explorer/testnet', isMainnet: false }

/** The network's name as the owner reads it: Testnet or Mainnet. */
export const networkLabel = (network: string): string => networkOf(network).label

export const isMainnet = (network: string): boolean => networkOf(network).isMainnet

/** An address on stellar.expert: under the Worker's explorer base when it sends one, else the network's own. */
export const explorerAccountUrl = (network: string, address: string, explorerBase?: string): string =>
  `${explorerBase ?? networkOf(network).explorer}/${String.startsWith('C')(address) ? 'contract' : 'account'}/${address}`

const FULL = 100n

/** How much of `total` is gone, given what `remaining` is left: 0 to 100. */
export const percentUsed = (total: Amount, remaining: Amount): number =>
  Option.match(Option.all([toStroops(total), toStroops(remaining)]), {
    onNone: () => 0,
    onSome: ([whole, left]) => (whole > 0n && left <= whole ? Number(((whole - left) * FULL) / whole) : 0),
  })
