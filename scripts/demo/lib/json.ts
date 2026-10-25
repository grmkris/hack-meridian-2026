/** Reads `a.b.0.c` from parsed JSON without trusting its shape. */
export const at = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        typeof current === 'object' && current !== null
          ? Object.entries(current).find(([k]) => k === key)?.[1]
          : undefined,
      value,
    )

/** The first of several paths that holds a value: tool shapes differ between the S4 stub and the service. */
export const pick = (value: unknown, ...paths: ReadonlyArray<string>): unknown =>
  paths.map(path => at(value, path)).find(found => found !== undefined && found !== null)

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? String(value) : undefined

export const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}
