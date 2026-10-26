import { Schema } from 'effect'

import { Network, StellarAddress } from './entities.ts'

/** ChatGPT file parameters: all four properties are declared, only the URL and id are required. */
export const RecipientFile = Schema.Struct({
  download_url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  file_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  mime_type: Schema.optionalKey(Schema.String),
  file_name: Schema.optionalKey(Schema.String),
})

export const RecipientScanInput = Schema.Struct({})
export const RecipientScanOutput = Schema.Struct({
  kind: Schema.Literal('recipient_scan'),
  network: Network,
  grant_remaining: Schema.String,
})

export const RecipientReadInput = Schema.Struct({
  file: Schema.optionalKey(RecipientFile).annotate({
    description: 'A user-provided PNG or JPEG QR image. Supply file or text, never both.',
  }),
  text: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).annotate({
    description: 'The exact decoded QR payload: a raw Stellar G…, C… or M… address. Supply text or file, never both.',
  }),
})
export type RecipientReadInput = typeof RecipientReadInput.Type

export const RecipientReadOutput = Schema.Struct({
  kind: Schema.Literal('recipient'),
  address: StellarAddress,
  address_kind: Schema.Literals(['account', 'contract', 'muxed']),
  network: Network,
  grant_remaining: Schema.String,
})
export type RecipientReadOutput = typeof RecipientReadOutput.Type
