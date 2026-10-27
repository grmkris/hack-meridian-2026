import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Release authority for the type-aware backend. The cache is disposable and verified on every use. */
export const TSRS_LINT = {
  repository: 'grmkris/tsrs',
  tag: 'lint-pr624-0acc433-regions.1',
  sha256: {
    'x86_64-unknown-linux-gnu': '17fef910b56c1638a9429e2c6e5f22dd89591234821687dc443d116be63832a5',
    'aarch64-apple-darwin': '8e10bd8a4861f1b7b3bd4ce2e13af0341b0a54af5cc7a73587e7a4772ff510e0',
  },
}

type Target = keyof typeof TSRS_LINT.sha256

export const target = (platform: string = process.platform, arch: string = process.arch): Target => {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu'
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  throw new Error(`tsrs-lint: no release build for ${platform}-${arch}`)
}

export const assetUrl = (forTarget: Target): string =>
  `https://github.com/${TSRS_LINT.repository}/releases/download/${TSRS_LINT.tag}/tsrs-lint-${forTarget}`

export const cachedBinary = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CACHE_HOME
  const cache = xdg === undefined || xdg === '' ? join(homedir(), '.cache') : xdg
  return join(cache, 'tsrs-lint', TSRS_LINT.tag, 'tsrs-lint')
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const fetchVerified = async ({
  url,
  sha256: expected,
  file,
}: {
  readonly url: string
  readonly sha256: string
  readonly file: string
}): Promise<string> => {
  if (existsSync(file)) {
    const actual = sha256(await readFile(file))
    if (actual !== expected) {
      throw new Error(`tsrs-lint: ${file} has sha256 ${actual}, the pin says ${expected}; delete it to download again`)
    }
    await access(file, constants.X_OK)
    return file
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`tsrs-lint: ${url} answered ${response.status} ${response.statusText}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) {
    throw new Error(`tsrs-lint: ${url} has sha256 ${actual}, the pin says ${expected}; nothing was installed`)
  }

  await mkdir(dirname(file), { recursive: true })
  const temporary = await mkdtemp(`${file}.`)
  try {
    const partial = join(temporary, 'binary')
    await writeFile(partial, bytes, { mode: 0o755 })
    await rename(partial, file)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return file
}

export const tsrsLint = (): Promise<string> => {
  const forTarget = target()
  return fetchVerified({ url: assetUrl(forTarget), sha256: TSRS_LINT.sha256[forTarget], file: cachedBinary() })
}

export const oxlintEnv = async (): Promise<NodeJS.ProcessEnv> => ({
  ...process.env,
  OXLINT_TSGOLINT_PATH: await tsrsLint(),
})

if (import.meta.main) console.log(await tsrsLint())
