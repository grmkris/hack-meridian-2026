import { Schema } from 'effect'
import jsQR from 'jsqr'

export class QrFailed extends Schema.TaggedError<QrFailed>()('QrFailed', { reason: Schema.String }) {
  override get message() {
    return this.reason
  }
}

/** Image bounds also cap decoder allocations; camera frames are downscaled before reaching this boundary. */
export const QR_MAX_BYTES = 5 * 1024 * 1024
export const QR_MAX_PIXELS = 4_000_000

export const checkQrDimensions = (width: number, height: number): void => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > QR_MAX_PIXELS
  )
    throw new QrFailed({ reason: 'Use an image up to 4 megapixels. Crop the image around one QR code and try again.' })
}

/** Mask the first detected symbol and look once more: never silently choose between two recipients. */
export const readQrPixels = (pixels: Uint8ClampedArray, width: number, height: number): string => {
  checkQrDimensions(width, height)
  const first = jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' })
  if (first === null)
    throw new QrFailed({ reason: 'No readable QR code found. Hold it steady or choose a clearer, cropped image.' })
  const corners = [
    first.location.topLeftCorner,
    first.location.topRightCorner,
    first.location.bottomLeftCorner,
    first.location.bottomRightCorner,
  ]
  const left = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x))) - 2)
  const right = Math.min(width, Math.ceil(Math.max(...corners.map(point => point.x))) + 2)
  const top = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y))) - 2)
  const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(point => point.y))) + 2)
  const masked = pixels.slice()
  Array.from({ length: bottom - top }, (_, row) =>
    masked.fill(255, ((top + row) * width + left) * 4, ((top + row) * width + right) * 4),
  )
  if (jsQR(masked, width, height, { inversionAttempts: 'attemptBoth' }) !== null)
    throw new QrFailed({ reason: 'More than one QR code found. Crop the image to the recipient you want.' })
  return first.data
}
