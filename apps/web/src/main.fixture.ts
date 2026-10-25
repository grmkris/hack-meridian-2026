import type { CounterReading, Health } from '@hm/api'

import { CounterData, HealthData, type Model } from './main'

export const health: Health = { ok: true, stage: 'testnet', release: '0123456789abcdef0123', network: 'testnet' }

export const reading: CounterReading = {
  contractId: 'CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2',
  network: 'testnet',
  count: 7,
}

export const loadingModel: Model = { health: HealthData.Loading(), counter: CounterData.Loading() }

export const loadedModel: Model = {
  health: HealthData.Success({ data: health }),
  counter: CounterData.Success({ data: reading }),
}
