import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { ChainUnavailable, type CounterReading, NotDeployed } from '@hm/api'

import { makeApiHandler } from './app.ts'
import type { Counter } from './counter.ts'
import { testServices } from './test/layers.ts'

const reading: CounterReading = {
  contractId: 'CAKTREEYOPERBZGP4FHTUZP4WRCMTM5X4WSC3UVTBNG3DEL2LGUC4ON2',
  network: 'testnet',
  count: 3,
}

const handlers: Array<ReturnType<typeof makeApiHandler>> = []
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(api => api.dispose()))
})

const get = async (read: Counter['Service']['read'], path: string) => {
  const api = makeApiHandler(testServices(undefined, { read }))
  handlers.push(api)
  const response = await api.handler(new Request(`http://worker.test${path}`))
  return { status: response.status, body: (await response.json()) as unknown }
}

describe('the Worker API', () => {
  test('health reports the stage, release and network', async () => {
    const { status, body } = await get(Effect.succeed(reading), '/api/health')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      stage: 'test',
      release: '0123456789abcdef0123456789abcdef01234567',
      network: 'testnet',
      chain: { mode: 'fixture', rent_factor: 47 },
    })
  })

  test('the counter answers its reading', async () => {
    const { status, body } = await get(Effect.succeed(reading), '/api/counter')
    expect(status).toBe(200)
    expect(body).toEqual(reading)
  })

  test('a stage without a contract answers 404 NotDeployed', async () => {
    const { status, body } = await get(Effect.fail(new NotDeployed({ error: 'none here' })), '/api/counter')
    expect(status).toBe(404)
    expect(body).toEqual({ _tag: 'NotDeployed', error: 'none here' })
  })

  test('an unreachable chain answers 503 ChainUnavailable', async () => {
    const { status, body } = await get(Effect.fail(new ChainUnavailable({ error: 'rpc down' })), '/api/counter')
    expect(status).toBe(503)
    expect(body).toEqual({ _tag: 'ChainUnavailable', error: 'rpc down' })
  })
})
