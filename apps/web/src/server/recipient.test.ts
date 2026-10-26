import { Effect } from 'effect'
import { encode } from 'fast-png'
import jpeg from 'jpeg-js'
import { describe, expect, test } from 'vitest'

import { StrKey } from '@stellar/stellar-sdk'

import { QR_MAX_BYTES, readQrPixels } from '../qr-decode.ts'
import { qrModules } from '../view/qr.ts'
import { listResources, readResource, SCAN_URI } from './mcp-apps.ts'
import { listTools, callTool } from './mcp-tools.ts'
import {
  recipientAddress,
  decodeRecipientImage,
  recipientImageUrl,
  recipientRead,
  recipientScan,
  RecipientImages,
} from './recipient.ts'
import { searchContacts, pendingOfWallet, receiptsOfWallet } from './store.ts'
import { senderWorld, OWNER } from './test/sender.ts'

const ADDRESS = 'GD4EDKUSDEAKUCBB633HS634PMX4NE7L6IFY4WOD45RJVKLUP7XLTOTC'
const CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const FILE = {
  file_id: 'user-attachment',
  download_url: 'https://files.oaiusercontent.com/recipient.png?signature=private',
}

const qrImage = (value = ADDRESS) => {
  const grid = qrModules(value)
  if (grid === undefined) throw new Error('fixture QR cannot be encoded')
  const scale = 6
  const width = (grid.length + 8) * scale
  const data = new Uint8Array(width * width * 4).fill(255)
  grid.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark)
        Array.from({ length: scale }, (_, dy) =>
          Array.from({ length: scale }, (_pixel, dx) => {
            const start = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4
            data.fill(0, start, start + 3)
          }),
        )
    }),
  )
  return { data, width, height: width, channels: 4 as const }
}

const image = qrImage()
const png = encode(image)

describe('recipient QR decoding', () => {
  test('reads an actual PNG and JPEG to the exact address', () => {
    expect(decodeRecipientImage(png)).toBe(ADDRESS)
    expect(decodeRecipientImage(jpeg.encode(image, 90).data)).toBe(ADDRESS)
  })
  test('accepts checksum-valid G, C and M addresses and rejects altered checksums, secrets and payment URIs', () => {
    expect(recipientAddress(` ${ADDRESS}\n`)).toEqual({ address: ADDRESS, address_kind: 'account' })
    expect(recipientAddress(CONTRACT).address_kind).toBe('contract')
    expect(recipientAddress(StrKey.encodeMed25519PublicKey(Buffer.alloc(40))).address_kind).toBe('muxed')
    for (const text of [
      ADDRESS.slice(0, -1) + 'A',
      StrKey.encodeEd25519SecretSeed(Buffer.alloc(32)),
      `web+stellar:pay?destination=${ADDRESS}&memo=123`,
      `${ADDRESS}\n${CONTRACT}`,
      'https://example.com',
    ]) {
      expect(() => recipientAddress(text)).toThrow('one Stellar')
    }
  })
  test('refuses multiple QR codes and empty images', () => {
    const width = image.width * 2
    const pixels = new Uint8ClampedArray(width * image.height * 4).fill(255)
    Array.from({ length: image.height }, (_, y) => {
      const row = image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4)
      pixels.set(row, y * width * 4)
      pixels.set(row, (y * width + image.width) * 4)
    })
    expect(() => readQrPixels(pixels, width, image.height)).toThrow(/(?:More than one|No readable) QR code/u)
    expect(() => readQrPixels(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100)).toThrow('No readable QR')
  })
  test('rejects oversized dimensions before decoding and refuses non-image input', () => {
    const oversized = png.slice()
    new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength).setUint32(16, 100_000)
    expect(() => decodeRecipientImage(oversized)).toThrow('4 megapixels')
    expect(() => decodeRecipientImage(new TextEncoder().encode('<svg onload="alert(1)">'))).toThrow('PNG or JPEG')
  })
  test('attachment downloads cannot target arbitrary hosts, IPs, credentials or insecure transports', () => {
    expect(recipientImageUrl(FILE.download_url)).toBe(FILE.download_url)
    for (const url of [
      'http://files.oaiusercontent.com/a',
      'https://127.0.0.1/a',
      'https://[::1]/a',
      'https://files.oaiusercontent.com.evil.com/a',
      'https://a@files.oaiusercontent.com/a',
      'https://files.oaiusercontent.com:444/a',
      'https://rebind.example.org/a',
    ]) {
      expect(() => recipientImageUrl(url)).toThrow('not supported')
    }
  })
  test('reads the attachment through the server and leaves contacts, intents, receipts and allowance unchanged', async () => {
    const world = await senderWorld()
    const before = await world.runtime.runPromise(recipientScan(world.ctx))
    const result = await world.runtime.runPromise(
      recipientRead(world.ctx, { file: FILE }).pipe(
        Effect.provideService(RecipientImages, {
          fetch: async (_url, init) => {
            expect(init.redirect).toBe('manual')
            return new Response(png)
          },
        }),
      ),
    )
    expect(result.value).toMatchObject({
      kind: 'recipient',
      address: ADDRESS,
      address_kind: 'account',
      network: 'stellar:testnet',
      grant_remaining: before.value.grant_remaining,
    })
    expect(await world.runtime.runPromise(searchContacts(OWNER, ''))).toEqual([])
    expect(await world.runtime.runPromise(pendingOfWallet('wal_s', world.ctx.props.connection_id))).toEqual([])
    expect(await world.runtime.runPromise(receiptsOfWallet('wal_s', 10))).toEqual([])
    const wire = await callTool(world.runtime, world.ctx, 'recipient_read', { text: ADDRESS })
    expect(wire.structuredContent).toMatchObject({ address: ADDRESS })
    expect((await callTool(world.runtime, world.ctx, 'recipient_read', { text: ADDRESS, file: FILE })).isError).toBe(
      true,
    )
    expect((await callTool(world.runtime, world.ctx, 'recipient_read', {})).isError).toBe(true)
  })
  test('cancels oversized streamed bodies and does not follow redirects or leak signed URLs', async () => {
    const world = await senderWorld()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(QR_MAX_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    const error = await world.runtime.runPromise(
      recipientRead(world.ctx, { file: FILE }).pipe(
        Effect.provideService(RecipientImages, { fetch: async () => new Response(body) }),
        Effect.flip,
      ),
    )
    expect(error.message).toContain('5 MB')
    expect(cancelled).toBe(true)
    const redirect = await world.runtime.runPromise(
      recipientRead(world.ctx, { file: FILE }).pipe(
        Effect.provideService(RecipientImages, {
          fetch: async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }),
        }),
        Effect.flip,
      ),
    )
    expect(redirect.message).not.toContain('signature')
    expect(redirect.message).toContain('could not be read')
  })
  test('only the scanner resource requests camera access; the read tool declares file forwarding', async () => {
    const scan = listResources('Testnet').resources.find(resource => resource.uri === SCAN_URI)
    expect(scan).toMatchObject({ _meta: { ui: { permissions: { camera: {} } } } })
    for (const uri of ['ui://nod/card/v1', 'ui://nod/home/v1']) {
      const resource = await readResource(uri, 'Testnet')
      expect(resource.contents[0]).not.toHaveProperty('_meta.ui.permissions')
    }
    expect(listTools().find(tool => tool.name === 'recipient_read')).toMatchObject({
      _meta: { 'openai/fileParams': ['file'] },
      annotations: { readOnlyHint: true, destructiveHint: false },
    })
  })
})
