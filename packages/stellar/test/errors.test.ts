import { describe, expect, it } from 'vitest'

import { contractCodes, fromSimulationError, primaryContractCode } from '../src/index.ts'

// The shape of a refused enforce simulation (docs/spikes/s1.md "How rejection looks").
const refused = (code: number) =>
  `HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CD4B…, topics:[error, Error(Auth, InvalidAction)]\n   1: [Diagnostic Event] topics:[error, Error(Contract, #${code})], data:["failed account authentication with error", CD4B4YAP7BCINBT6CKGA3ADE2IOBUAGMH5NZGL2XTQGHTCLF2V4UA753, Error(Contract, #${code})]`

describe('simulation errors → ChainError', () => {
  it.each([
    [3221, 'limit_exhausted'],
    [3002, 'expired'],
    [3000, 'removed'],
    [3223, 'not_transfer'],
    [10, 'insufficient_balance'],
  ] as const)('#%i → %s', (code, kind) => {
    const e = fromSimulationError(refused(code), 'enforce simulation')
    expect(e._tag).toBe('ChainError')
    expect(e.kind).toBe(kind)
    expect(e.message).toContain(`#${code}`)
  })

  it('names a missing trustline and a missing reserve (S3) without a dedicated kind', () => {
    expect(fromSimulationError(refused(13)).message).toContain('no USDC trustline')
    expect(fromSimulationError(refused(14)).message).toContain('0.5 XLM')
    expect(fromSimulationError(refused(13)).kind).toBe('simulation_failed')
  })

  it('a failure without a contract code is simulation_failed', () => {
    expect(fromSimulationError('HostError: Error(Storage, ExceededLimit)').kind).toBe('simulation_failed')
  })

  it('the policy code wins over a token code', () => {
    expect(primaryContractCode(contractCodes('Error(Contract, #10) … Error(Contract, #3221)'))).toBe(3221)
    expect(primaryContractCode([])).toBeUndefined()
    expect(primaryContractCode([42])).toBe(42)
  })
})
