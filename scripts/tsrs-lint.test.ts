import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { assetUrl, cachedBinary, fetchVerified, target, TSRS_LINT } from './tsrs-lint.ts'

const owned: string[] = []
const servers: http.Server[] = []

afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) server.close()
})

const scratch = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hm-tsrs-lint-'))
  owned.push(dir)
  return dir
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const serve = async (body: Buffer): Promise<string> => {
  const server = http.createServer((request, response) => {
    if (request.url === '/binary') response.end(body)
    else response.writeHead(404, 'Not Found').end()
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not expose a TCP address')
  return `http://127.0.0.1:${address.port}`
}

describe('tsrs-lint pin and cache', () => {
  test('maps supported platforms and rejects unpinned targets', () => {
    expect(target('linux', 'x64')).toBe('x86_64-unknown-linux-gnu')
    expect(target('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(() => target('linux', 'arm64')).toThrow('no release build')
    expect(assetUrl('x86_64-unknown-linux-gnu')).toContain(TSRS_LINT.tag)
  })

  test('the editor backend path follows the release pin', () => {
    const text = readFileSync(new URL('../.vscode/settings.json', import.meta.url), 'utf8')
    const settings: unknown = JSON.parse(
      text
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n'),
    )
    expect(settings).toMatchObject({
      'oxc.path.tsgolint': `\${userHome}/.cache/tsrs-lint/${TSRS_LINT.tag}/tsrs-lint`,
    })
  })

  test('uses the XDG cache and verifies a download', async () => {
    const body = Buffer.from('#!/bin/sh\necho tsrs-lint\n')
    const base = await serve(body)
    const file = path.join(scratch(), 'tag', 'tsrs-lint')
    await expect(fetchVerified({ url: `${base}/binary`, sha256: digest(body), file })).resolves.toBe(file)
    expect(readFileSync(file)).toEqual(body)
    expect(statSync(file).mode & 0o111).toBe(0o111)
    expect(cachedBinary({ XDG_CACHE_HOME: '/var/cache' })).toBe(`/var/cache/tsrs-lint/${TSRS_LINT.tag}/tsrs-lint`)
  })

  test('rejects a bad checksum and leaves no downloaded file', async () => {
    const body = Buffer.from('wrong')
    const base = await serve(body)
    const file = path.join(scratch(), 'tsrs-lint')
    await expect(
      fetchVerified({ url: `${base}/binary`, sha256: digest(Buffer.from('expected')), file }),
    ).rejects.toThrow(/nothing was installed/u)
    expect(existsSync(file)).toBe(false)
  })

  test('rejects a corrupted cached file without replacing it', async () => {
    const file = path.join(scratch(), 'tsrs-lint')
    const body = Buffer.from('cached')
    writeFileSync(file, body, { mode: 0o755 })
    await expect(
      fetchVerified({ url: 'http://127.0.0.1:1/unused', sha256: digest(Buffer.from('expected')), file }),
    ).rejects.toThrow(/delete it to download again/u)
    expect(readFileSync(file)).toEqual(body)
  })

  test('uses a verified cached executable without a download', async () => {
    const file = path.join(scratch(), 'tsrs-lint')
    const body = Buffer.from('verified')
    writeFileSync(file, body, { mode: 0o755 })
    await expect(fetchVerified({ url: 'http://127.0.0.1:1/unused', sha256: digest(body), file })).resolves.toBe(file)
    expect(cachedBinary({ XDG_CACHE_HOME: '' })).toBe(
      path.join(os.homedir(), '.cache', 'tsrs-lint', TSRS_LINT.tag, 'tsrs-lint'),
    )
  })

  test('fails when the release asset is missing', async () => {
    const body = Buffer.from('binary')
    const base = await serve(body)
    const file = path.join(scratch(), 'tsrs-lint')
    await expect(fetchVerified({ url: `${base}/missing`, sha256: digest(body), file })).rejects.toThrow('404 Not Found')
    expect(existsSync(file)).toBe(false)
  })
})
