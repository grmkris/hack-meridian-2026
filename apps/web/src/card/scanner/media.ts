import { Effect, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'

import { readQrPixels, QR_MAX_BYTES, QrFailed } from '../../qr-decode'
import { Message } from './message'

export const CAMERA_ID = 'nod-recipient-camera'
const FRAME_SIZE = 960

export const qrReason = (error: unknown): string =>
  error instanceof QrFailed ? error.reason : 'The image could not be read. Choose a clear PNG or JPEG with one QR code.'

const fromFrame = (source: CanvasImageSource, width: number, height: number): string => {
  if (width <= 0 || height <= 0) throw new QrFailed({ reason: 'The camera is not ready. Try again.' })
  const scale = Math.min(1, FRAME_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new QrFailed({ reason: 'This browser cannot read QR images.' })
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return readQrPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
}

export const readCamera = () => {
  const video = document.getElementById(CAMERA_ID)
  if (!(video instanceof HTMLVideoElement)) throw new QrFailed({ reason: 'Open the camera again.' })
  return fromFrame(video, video.videoWidth, video.videoHeight)
}

export const readImage = async (file: File): Promise<string> => {
  if (file.size > QR_MAX_BYTES) throw new QrFailed({ reason: 'Choose an image up to 5 MB.' })
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new QrFailed({ reason: 'Choose a PNG or JPEG image.' })
  const bitmap = await createImageBitmap(file)
  try {
    return fromFrame(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

/** Own the stream in the mount scope: reset, success, hide and teardown all stop every track. */
export const OpenCamera = Mount.defineStream('OpenCamera', {
  args: { attempt: Schema.Int },
  messages: [Message.SucceededCamera, Message.FailedCamera],
  execute: ({ element, attempt }) =>
    Stream.callback<typeof Message.SucceededCamera.Type | typeof Message.FailedCamera.Type>(queue =>
      Effect.gen(function* () {
        if (!(element instanceof HTMLVideoElement))
          return yield* new QrFailed({ reason: 'The camera preview could not open.' })
        let media: MediaStream | undefined
        const stop = () => {
          media?.getTracks().forEach(track => track.stop())
          element.srcObject = null
        }
        yield* Effect.addFinalizer(() => Effect.sync(stop))
        yield* Effect.tryPromise({
          try: async signal => {
            if (!navigator.mediaDevices?.getUserMedia)
              throw new QrFailed({ reason: 'This chat cannot open a camera. Choose a QR image below.' })
            const acquired = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: FRAME_SIZE },
                height: { ideal: FRAME_SIZE },
              },
              audio: false,
            })
            if (signal.aborted) {
              acquired.getTracks().forEach(track => track.stop())
              return
            }
            media = acquired
            element.muted = true
            element.srcObject = acquired
            await element.play()
          },
          catch: () =>
            new QrFailed({
              reason:
                'Camera access is unavailable or was denied. Choose a QR image below, or allow the camera and try again.',
            }),
        })
        yield* Queue.offer(queue, Message.SucceededCamera({ attempt }))
        return yield* Effect.never
      }).pipe(Effect.catch(error => Queue.offer(queue, Message.FailedCamera({ attempt, reason: qrReason(error) })))),
    ),
})
