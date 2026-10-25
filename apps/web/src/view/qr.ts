import { Array } from 'effect'

/**
 * A minimal QR code encoder for the Add money card: byte mode, error correction level M, versions 1 to 6 (up to 106
 * bytes; a Stellar address is 56). It follows ISO/IEC 18004 as Nayuki's reference generator lays it out: data and
 * Reed–Solomon codewords, the function patterns, the zigzag placement, and the mask with the lowest penalty. Pure and
 * browser-safe; `qrModules` returns rows of dark (true) and light modules without the quiet zone.
 */

/** Per version at level M: total codewords, error-correction codewords per block, number of blocks (all equal). */
const VERSIONS: ReadonlyArray<{ readonly total: number; readonly ecPerBlock: number; readonly blocks: number }> = [
  { total: 26, ecPerBlock: 10, blocks: 1 },
  { total: 44, ecPerBlock: 16, blocks: 1 },
  { total: 70, ecPerBlock: 26, blocks: 1 },
  { total: 100, ecPerBlock: 18, blocks: 2 },
  { total: 134, ecPerBlock: 24, blocks: 2 },
  { total: 172, ecPerBlock: 16, blocks: 4 },
]

const dataCapacity = (version: number) => {
  const spec = VERSIONS[version - 1]
  return spec === undefined ? 0 : spec.total - spec.ecPerBlock * spec.blocks
}

const bitsOf = (value: number, length: number): ReadonlyArray<number> =>
  Array.makeBy(length, i => (value >>> (length - 1 - i)) & 1)

/** GF(256) multiplication modulo x^8 + x^4 + x^3 + x^2 + 1. */
const gfMultiply = (x: number, y: number): number =>
  Array.makeBy(8, i => 7 - i).reduce((z, i) => ((z << 1) ^ ((z >>> 7) * 0x11d) ^ (((y >>> i) & 1) * x)) & 0xff, 0)

const rsDivisor = (degree: number): ReadonlyArray<number> =>
  Array.makeBy(degree, i => i).reduce<{ readonly divisor: ReadonlyArray<number>; readonly root: number }>(
    ({ divisor, root }) => ({
      divisor: divisor.map((coefficient, j) => gfMultiply(coefficient, root) ^ (divisor[j + 1] ?? 0)),
      root: gfMultiply(root, 0x02),
    }),
    { divisor: [...Array.makeBy(degree - 1, () => 0), 1], root: 1 },
  ).divisor

const rsRemainder = (data: ReadonlyArray<number>, divisor: ReadonlyArray<number>): ReadonlyArray<number> =>
  data.reduce<ReadonlyArray<number>>(
    (remainder, byte) => {
      const factor = byte ^ (remainder[0] ?? 0)
      const shifted = [...remainder.slice(1), 0]
      return shifted.map((value, i) => value ^ gfMultiply(divisor[i] ?? 0, factor))
    },
    divisor.map(() => 0),
  )

/** Mode, length, data, terminator and padding, as codewords for `version`. */
const dataCodewords = (bytes: ReadonlyArray<number>, version: number): ReadonlyArray<number> => {
  const capacityBits = dataCapacity(version) * 8
  const header = [...bitsOf(0b0100, 4), ...bitsOf(bytes.length, 8), ...bytes.flatMap(byte => bitsOf(byte, 8))]
  const terminated = [...header, ...Array.makeBy(Math.min(4, capacityBits - header.length), () => 0)]
  const aligned = [...terminated, ...Array.makeBy((8 - (terminated.length % 8)) % 8, () => 0)]
  const codewords = Array.makeBy(aligned.length / 8, i =>
    aligned.slice(i * 8, i * 8 + 8).reduce((byte, bit) => (byte << 1) | bit, 0),
  )
  return [...codewords, ...Array.makeBy(capacityBits / 8 - codewords.length, i => (i % 2 === 0 ? 0xec : 0x11))]
}

const interleave = (rows: ReadonlyArray<ReadonlyArray<number>>, width: number) =>
  Array.makeBy(width, column => rows.map(row => row[column] ?? 0)).flat()

/** Split into blocks, append each block's error correction, and interleave (every block has the same length here). */
const finalCodewords = (data: ReadonlyArray<number>, version: number): ReadonlyArray<number> => {
  const spec = VERSIONS[version - 1] ?? { total: 0, ecPerBlock: 0, blocks: 1 }
  const perBlock = data.length / spec.blocks
  const divisor = rsDivisor(spec.ecPerBlock)
  const blocks = Array.makeBy(spec.blocks, i => data.slice(i * perBlock, (i + 1) * perBlock))
  const ecc = blocks.map(block => rsRemainder(block, divisor))
  return [...interleave(blocks, perBlock), ...interleave(ecc, spec.ecPerBlock)]
}

type Grid = Array<Array<boolean>>

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** The 15 format bits (level M = 00, then the mask), BCH-protected and XOR-masked. */
const formatBits = (mask: number): number => {
  const data = mask
  const remainder = Array.makeBy(10, i => i).reduce(rem => (rem << 1) ^ ((rem >>> 9) * 0x537), data)
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412
}

const drawFormat = (grid: Grid, isFunction: Grid, size: number, mask: number) => {
  const bits = formatBits(mask)
  const bit = (i: number) => ((bits >>> i) & 1) === 1
  const set = (x: number, y: number, dark: boolean) => {
    const row = grid[y]
    const fnRow = isFunction[y]
    if (row !== undefined && fnRow !== undefined) {
      row[x] = dark
      fnRow[x] = true
    }
  }
  Array.makeBy(6, i => i).forEach(i => set(8, i, bit(i)))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  Array.makeBy(6, i => i + 9).forEach(i => set(14 - i, 8, bit(i)))
  Array.makeBy(8, i => i).forEach(i => set(size - 1 - i, 8, bit(i)))
  Array.makeBy(7, i => i + 8).forEach(i => set(8, size - 15 + i, bit(i)))
  set(8, size - 8, true)
}

const around = (radius: number) => Array.makeBy(radius * 2 + 1, i => i - radius)

/** Finder, separator, timing and alignment patterns, and the reserved format area. */
const functionPatterns = (version: number) => {
  const size = version * 4 + 17
  const grid: Grid = Array.makeBy(size, () => Array.makeBy(size, () => false))
  const isFunction: Grid = Array.makeBy(size, () => Array.makeBy(size, () => false))
  const set = (x: number, y: number, dark: boolean) => {
    const row = grid[y]
    const fnRow = isFunction[y]
    if (row !== undefined && fnRow !== undefined && x >= 0 && x < size) {
      row[x] = dark
      fnRow[x] = true
    }
  }
  Array.makeBy(size, i => i).forEach(i => {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  })
  const finders: ReadonlyArray<readonly [number, number]> = [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]
  finders.forEach(([cx, cy]) =>
    around(4).forEach(dy =>
      around(4).forEach(dx => {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        if (cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, distance !== 2 && distance !== 4)
      }),
    ),
  )
  if (version >= 2) {
    const center = size - 7
    around(2).forEach(dy =>
      around(2).forEach(dx => set(center + dx, center + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)),
    )
  }
  drawFormat(grid, isFunction, size, 0)
  return { size, grid, isFunction }
}

/** The data modules in placement order: two-column strips from the right, alternating up and down, skipping x = 6. */
const placementOrder = (size: number, isFunction: Grid): ReadonlyArray<readonly [number, number]> =>
  Array.makeBy(Math.floor(size / 2), strip => {
    const right = size - 1 - strip * 2
    return right <= 6 ? right - 1 : right
  }).flatMap(right =>
    Array.makeBy(size, vert => {
      const upward = ((right + 1) & 2) === 0
      const y = upward ? size - 1 - vert : vert
      return [right, right - 1].map(x => [x, y] as const)
    })
      .flat()
      .filter(([x, y]) => isFunction[y]?.[x] === false),
  )

const runPenalty = (line: ReadonlyArray<boolean>): number =>
  line
    .reduce<ReadonlyArray<number>>((runs, dark, i) => {
      if (i > 0 && dark === line[i - 1]) {
        return [...runs.slice(0, -1), (runs.at(-1) ?? 0) + 1]
      }
      return [...runs, 1]
    }, [])
    .reduce((total, run) => total + (run >= 5 ? run - 2 : 0), 0)

const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false]
const FINDER_LIKE_REVERSED = FINDER_LIKE.toReversed()

const finderPenalty = (line: ReadonlyArray<boolean>): number =>
  Array.makeBy(Math.max(0, line.length - FINDER_LIKE.length + 1), start => start).reduce((total, start) => {
    const window = line.slice(start, start + FINDER_LIKE.length)
    const matches = (pattern: ReadonlyArray<boolean>) => pattern.every((dark, i) => window[i] === dark)
    return total + (matches(FINDER_LIKE) ? 40 : 0) + (matches(FINDER_LIKE_REVERSED) ? 40 : 0)
  }, 0)

/** ISO/IEC 18004 mask penalty: runs, 2×2 blocks, finder-like patterns, dark balance. */
const penalty = (grid: ReadonlyArray<ReadonlyArray<boolean>>): number => {
  const size = grid.length
  const columns = Array.makeBy(size, x => grid.map(row => row[x] === true))
  const lines = [...grid, ...columns]
  const runs = lines.reduce((total, line) => total + runPenalty(line), 0)
  const finders = lines.reduce((total, line) => total + finderPenalty(line), 0)
  const sameBlock = (x: number, y: number): boolean => {
    const dark = grid[y]?.[x]
    return grid[y]?.[x + 1] === dark && grid[y + 1]?.[x] === dark && grid[y + 1]?.[x + 1] === dark
  }
  const blocks =
    3 *
    Array.makeBy(size - 1, y => Array.makeBy(size - 1, x => sameBlock(x, y)).filter(Boolean).length).reduce(
      (total: number, count: number) => total + count,
      0,
    )
  const dark = grid.reduce((total, row) => total + row.filter(Boolean).length, 0)
  const balance = (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10
  return runs + blocks + finders + balance
}

/** The QR code for `text` (UTF-8), or undefined when it does not fit version 6 at level M. */
export const qrModules = (text: string): ReadonlyArray<ReadonlyArray<boolean>> | undefined => {
  const bytes = [...new TextEncoder().encode(text)]
  const version = Array.makeBy(VERSIONS.length, i => i + 1).find(v => 12 + bytes.length * 8 <= dataCapacity(v) * 8)
  if (version === undefined) {
    return undefined
  }
  const codewords = finalCodewords(dataCodewords(bytes, version), version)
  const bits = codewords.flatMap(byte => bitsOf(byte, 8))
  const candidates = MASKS.map((masked, mask) => {
    const { size, grid, isFunction } = functionPatterns(version)
    placementOrder(size, isFunction).forEach(([x, y], i) => {
      const row = grid[y]
      if (row !== undefined) {
        row[x] = (bits[i] === 1) !== masked(x, y)
      }
    })
    drawFormat(grid, isFunction, size, mask)
    return { grid, score: penalty(grid) }
  })
  return candidates.reduce((best, candidate) => (candidate.score < best.score ? candidate : best)).grid
}

/** An SVG path drawing every dark module as a unit square, offset by the quiet zone. */
export const qrPath = (modules: ReadonlyArray<ReadonlyArray<boolean>>, quiet = 4): string =>
  modules.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + quiet} ${y + quiet}h1v1h-1z`] : []))).join('')
