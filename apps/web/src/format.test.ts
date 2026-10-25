import { describe, expect, test } from 'vitest'

import { explorerAccountUrl, isMainnet, networkLabel, percentUsed, shortAddress, usdc } from './format'

const ALICE = 'CD7SGAMIN5JLN6HOD7ENHNJDQ3C4HICTCPKINJOG2PHUNKQS7QLBYHSW'
const BOB = 'GD4EDKUSDEAKUCBB633HS634PMX4NE7L6IFY4WOD45RJVKLUP7XLTOTC'

describe('networks', () => {
  test('testnet and mainnet are named for the owner and link to their own explorer', () => {
    expect(networkLabel('stellar:testnet')).toBe('Testnet')
    expect(networkLabel('stellar:pubnet')).toBe('Mainnet')
    expect(isMainnet('stellar:pubnet')).toBe(true)
    expect(explorerAccountUrl('stellar:pubnet', BOB)).toBe(`https://stellar.expert/explorer/public/account/${BOB}`)
    expect(explorerAccountUrl('stellar:testnet', ALICE)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${ALICE}`,
    )
    expect(explorerAccountUrl('stellar:testnet', ALICE, 'https://explorer.example/testnet')).toBe(
      `https://explorer.example/testnet/contract/${ALICE}`,
    )
  })
})

describe('amounts', () => {
  test('stroop strings and bigints format the same way, and a malformed amount is shown as sent', () => {
    expect(usdc('29000000')).toBe('2.90 USDC')
    expect(usdc(29_000_000n)).toBe('2.90 USDC')
    expect(usdc('not-a-number')).toBe('not-a-number USDC')
  })

  test('the meter shows how much of the allowance is gone', () => {
    expect(percentUsed('50000000', '29000000')).toBe(42)
    expect(percentUsed('0', '0')).toBe(0)
    expect(percentUsed('50000000', '60000000')).toBe(0)
  })

  test('addresses shorten to their first and last four characters', () => {
    expect(shortAddress(BOB)).toBe('GD4E…TOTC')
  })
})
