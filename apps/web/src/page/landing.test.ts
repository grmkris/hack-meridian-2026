import { describe, expect, test } from 'vitest'

import { networkOf } from './landing'

describe('networkOf', () => {
  test.each([
    ['https://testnet.trynod.si/mcp', 'testnet'],
    ['http://localhost:18960/mcp', 'testnet'],
    ['https://trynod.si/mcp', 'mainnet'],
    ['https://www.trynod.si/mcp', 'mainnet'],
  ] as const)('%s reads as %s (the sandbox and local development are testnet)', (url, network) => {
    expect(networkOf(url)).toBe(network)
  })
})
