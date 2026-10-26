import { Context, Effect } from 'effect'
import { convertIndexedToRgb, decode as decodePng } from 'fast-png'
import { Unzlib } from 'fflate'
import jpeg from 'jpeg-js'

import type { RecipientFile, RecipientReadInput, RecipientReadOutput, RecipientScanOutput } from '@hm/protocol'
import { StrKey } from '@stellar/stellar-sdk'

import { checkQrDimensions, readQrPixels, QR_MAX_BYTES, QR_MAX_PIXELS, QrFailed } from '../qr-decode.ts'
import { Network } from './network.ts'
import { refuse, toolError } from './tool-errors.ts'
import { scope, type ToolContext } from './tools.ts'
import { grantRemaining } from './views.ts'

/** Attachment URLs are temporary credentials. They are neither stored nor forwarded to the model. */
export const RecipientImages = Context.Reference<{
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
}>('hm/RecipientImages', { defaultValue: () => ({ fetch: (url, init) => globalThis.fetch(url, init) }) })

export const recipientAddress = (text: string) => {
  const address = text.trim()
  const kind: RecipientReadOutput['address_kind'] | undefined = StrKey.isValidEd25519PublicKey(address)
    ? 'account'
    : StrKey.isValidContract(address)
      ? 'contract'
      : StrKey.isValidMed25519PublicKey(address)
        ? 'muxed'
        : undefined
  if (kind === undefined) {
    throw new QrFailed({
      reason:
        'The QR code must contain one Stellar G, C or M address. Payment links, memos and secret keys are not supported.',
    })
  }
  return { address, address_kind: kind }
}

/** Only chat attachment storage, never arbitrary URLs or redirects (including DNS rebinding targets). */
export const recipientImageUrl = (raw: string): string => {
  const url = new URL(raw)
  const hosts = ['files.oaiusercontent.com', 'files.openai.com']
  const allowed =
    hosts.includes(url.hostname) ||
    url.hostname.endsWith('.oaiusercontent.com') ||
    url.hostname.endsWith('.blob.core.windows.net')
  if (
    !allowed ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new QrFailed({ reason: 'This image link is not supported. Open recipient_scan and choose the image there.' })
  }
  return url.href
}

/** Inspect dimensions and bound inflated IDAT before the PNG decoder allocates; omit ancillary compressed metadata. */
const boundedPng = (bytes: Uint8Array): Uint8Array => {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  checkQrDimensions(data.getUint32(16), data.getUint32(20))
  if (data.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
    throw new QrFailed({ reason: 'The PNG header is invalid.' })
  let inflated = 0
  const inflater = new Unzlib(chunk => {
    inflated += chunk.byteLength
    if (inflated > QR_MAX_PIXELS * 9) throw new QrFailed({ reason: 'The image is too large to scan.' })
  })
  const parts = [bytes.subarray(0, 8)]
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const size = data.getUint32(offset)
    if (size > bytes.length - offset - 12) throw new QrFailed({ reason: 'The PNG is incomplete.' })
    const tag = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (tag === 'IHDR' && offset !== 8) throw new QrFailed({ reason: 'The PNG header is invalid.' })
    if (tag === 'IDAT') {
      let position = offset + 8
      const end = position + size
      while (position < end) {
        const next = Math.min(end, position + 512)
        inflater.push(bytes.subarray(position, next))
        position = next
      }
    }
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(tag)) parts.push(bytes.subarray(offset, offset + size + 12))
    offset += size + 12
  }
  return Buffer.concat(parts)
}

export const decodeRecipientImage = (bytes: Uint8Array): string => {
  if (bytes.byteLength > QR_MAX_BYTES) throw new QrFailed({ reason: 'Choose an image up to 5 MB.' })
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const image = decodePng(boundedPng(bytes), { checkCrc: true })
    const channels = image.palette === undefined ? image.channels : (image.palette[0]?.length ?? 3)
    const data = image.palette === undefined ? image.data : convertIndexedToRgb(image)
    const max = image.depth === 16 ? 65535 : image.palette === undefined ? 2 ** image.depth - 1 : 255
    const pixels = new Uint8ClampedArray(image.width * image.height * 4)
    Array.from({ length: image.width * image.height }, (_, index) => {
      const source = index * channels
      const target = index * 4
      const sample = (channel: number) => {
        if (image.palette === undefined && image.depth < 8) {
          const row = Math.floor(index / image.width)
          const column = index % image.width
          const byte =
            data[row * Math.ceil((image.width * image.depth) / 8) + Math.floor((column * image.depth) / 8)] ?? 0
          return Math.round((((byte >> (8 - image.depth - ((column * image.depth) % 8))) & max) * 255) / max)
        }
        return Math.round(((data[source + channel] ?? 0) * 255) / max)
      }
      const alpha = channels === 2 ? sample(1) : channels === 4 ? sample(3) : 255
      const composite = (channel: number) => Math.round((sample(channel) * alpha) / 255 + 255 - alpha)
      pixels[target] = composite(0)
      pixels[target + 1] = composite(channels <= 2 ? 0 : 1)
      pixels[target + 2] = composite(channels <= 2 ? 0 : 2)
      pixels[target + 3] = 255
    })
    return readQrPixels(pixels, image.width, image.height)
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const image = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: QR_MAX_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 32,
    })
    return readQrPixels(new Uint8ClampedArray(image.data), image.width, image.height)
  }
  throw new QrFailed({ reason: 'Choose a PNG or JPEG image.' })
}

const readBounded = async (response: Response): Promise<Uint8Array> => {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new QrFailed({ reason: 'The image was empty.' })
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    if (Number(response.headers.get('content-length')) > QR_MAX_BYTES)
      throw new QrFailed({ reason: 'Choose an image up to 5 MB.' })
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > QR_MAX_BYTES) throw new QrFailed({ reason: 'Choose an image up to 5 MB.' })
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel()
  }
}

const scanError = (error: unknown) =>
  toolError(
    'invalid_input',
    error instanceof QrFailed
      ? error.reason
      : 'The image could not be read. Choose a clear PNG or JPEG, cropped around the QR code.',
    { recovery: 'Try another image with recipient_read, or open recipient_scan to choose it locally.', retry: 'read' },
  )

const readFile = Effect.fn('recipient.readFile')(function* (file: typeof RecipientFile.Type) {
  const images = yield* RecipientImages
  return yield* Effect.tryPromise({
    try: async signal => {
      const response = await images.fetch(recipientImageUrl(file.download_url), { redirect: 'manual', signal })
      if (!response.ok) {
        await response.body?.cancel()
        throw new QrFailed({
          reason: 'The attachment link expired or could not be read. Choose the image again in recipient_scan.',
        })
      }
      return decodeRecipientImage(await readBounded(response))
    },
    catch: scanError,
  }).pipe(
    Effect.timeoutOrElse({
      duration: '10 seconds',
      orElse: () => refuse('invalid_input', 'The image took too long to read. Choose it locally in recipient_scan.'),
    }),
  )
})

export const recipientScan = Effect.fn('recipient.scan')(function* (ctx: ToolContext) {
  const { grant, nowMs } = yield* scope(ctx, false)
  const network = yield* Network
  return {
    sentence:
      'Choose a QR image or open the camera in the scanner card. Camera access depends on the chat host. Scanning never pays or saves a contact.',
    value: {
      kind: 'recipient_scan',
      network: network.caip,
      grant_remaining: grantRemaining(grant, nowMs),
    } satisfies typeof RecipientScanOutput.Type,
  }
})

export const recipientRead = Effect.fn('recipient.read')(function* (ctx: ToolContext, input: RecipientReadInput) {
  const { grant, nowMs } = yield* scope(ctx, false)
  if ((input.file === undefined) === (input.text === undefined))
    return yield* refuse('invalid_input', 'Send either a QR image or decoded QR text, never both.')
  const text = input.file === undefined ? (input.text ?? '') : yield* readFile(input.file)
  const recipient = yield* Effect.try({ try: () => recipientAddress(text), catch: scanError })
  const network = yield* Network
  return {
    sentence: `Found Stellar recipient ${recipient.address}. Confirm this recipient before preparing the payment. The address itself does not identify a network; this wallet uses ${network.label}. Nothing was paid.`,
    value: {
      kind: 'recipient',
      ...recipient,
      network: network.caip,
      grant_remaining: grantRemaining(grant, nowMs),
    } satisfies RecipientReadOutput,
  }
})
