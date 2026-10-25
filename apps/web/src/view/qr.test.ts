import { describe, expect, test } from 'vitest'

import { qrModules, qrPath } from './qr'

// Decoded with jsQR during development (v1, v4 and v6 samples); here the structure that any scanner relies on.
const ADDRESS = 'CAH553ZKXMQCYJ7AXYLJDQ65ZKMH7ARP6RDRWGNNFRA5SWBCXKXAX4XV'

const finderAt = (modules: ReadonlyArray<ReadonlyArray<boolean>>, left: number, top: number) =>
  [0, 1, 2, 3, 4, 5, 6].every(y =>
    [0, 1, 2, 3, 4, 5, 6].every(x => {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      return modules[top + y]?.[left + x] === (ring !== 2)
    }),
  )

describe('qrModules', () => {
  test('a Stellar address is a version 4 code (33 × 33) with its three finder patterns and timing rows', () => {
    const modules = qrModules(ADDRESS)
    expect(modules).toBeDefined()
    const grid = modules ?? []
    expect(grid).toHaveLength(33)
    expect(grid.every(row => row.length === 33)).toBe(true)
    expect(finderAt(grid, 0, 0)).toBe(true)
    expect(finderAt(grid, 26, 0)).toBe(true)
    expect(finderAt(grid, 0, 26)).toBe(true)
    expect([8, 9, 10, 11, 12].map(x => grid[6]?.[x])).toEqual([true, false, true, false, true])
    expect(grid[33 - 8]?.[8]).toBe(true)
  })

  test('the same text gives the same code; text past version 6 does not fit', () => {
    expect(qrModules(ADDRESS)).toEqual(qrModules(ADDRESS))
    expect(qrModules('x'.repeat(107))).toBeUndefined()
  })

  test('qrPath draws each dark module once, inside a four-module quiet zone', () => {
    const grid = qrModules('hi') ?? []
    const squares = qrPath(grid).match(/M\d+ \d+h1v1h-1z/gu) ?? []
    expect(squares).toHaveLength(grid.flat().filter(Boolean).length)
    expect(qrPath(grid).startsWith('M4 4')).toBe(true)
  })
})
