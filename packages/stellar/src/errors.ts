import { ChainError, type ChainErrorKind, chainErrorKindFromCode } from '@hm/protocol'
import { xdr } from '@stellar/stellar-sdk'

/**
 * Soroban failures → `ChainError` (codes from spikes S1 and S3). Simulation errors arrive as text
 * (`HostError: Error(Auth, InvalidAction)` plus diagnostic events naming the real cause, e.g.
 * `Error(Contract, #3221)`); onchain failures carry the same codes in their diagnostic events.
 */
export const CONTRACT_ERRORS: Readonly<Record<number, string>> = {
  3000: 'context rule not found (the grant was removed)',
  3002: 'unvalidated context (the grant expired, or the wrong rule)',
  3005: 'valid_until is in the past',
  3114: 'passkey challenge does not match',
  3117: 'passkey user-verified bit not set',
  3220: 'spending limit not installed on this rule',
  3221: 'spending limit exceeded (allowance used up)',
  3223: 'not a transfer (the grant only allows USDC transfer)',
  3224: 'spending history full',
  10: 'insufficient balance',
  13: 'recipient has no USDC trustline',
  14: 'recipient lacks the 0.5 XLM reserve for a new trustline',
}

/** The policy/account codes first, then token codes, so the inner cause wins over a generic outer one. */
const PRIORITY = [3221, 3002, 3000, 3223, 3220, 3224, 3005, 3114, 3117, 10, 13, 14]

/** Every `Error(Contract, #n)` in a text, in order of appearance. */
export const contractCodes = (text: string): ReadonlyArray<number> =>
  Array.from(text.matchAll(/Error\(Contract, #(\d+)\)/gu), m => Number(m[1]))

/** The code that explains a failure best: a known code by priority, else the first one present. */
export const primaryContractCode = (codes: ReadonlyArray<number>): number | undefined =>
  PRIORITY.find(c => codes.includes(c)) ?? codes[0]

export const describeCode = (code: number): string => CONTRACT_ERRORS[code] ?? `contract error #${code}`

/** Map a simulation error text to a ChainError. */
export const fromSimulationError = (text: string, stage = 'simulation'): ChainError => {
  const code = primaryContractCode(contractCodes(text))
  if (code === undefined)
    return new ChainError({ kind: 'simulation_failed', message: `${stage} failed: ${firstLine(text)}` })
  return new ChainError({
    kind: chainErrorKindFromCode(code),
    message: `${stage} refused: ${describeCode(code)} (Error(Contract, #${code}))`,
  })
}

/** Map a failed transaction (getTransaction FAILED) to a ChainError carrying its hash. */
export const fromOnchainFailure = (
  hash: string,
  resultCode: string,
  diagnostics: ReadonlyArray<xdr.DiagnosticEvent>,
): ChainError => {
  const errs = scErrors(diagnostics)
  const code = primaryContractCode(contractCodes(errs.join(' ')))
  const kind: ChainErrorKind = code === undefined ? 'submit_failed' : chainErrorKindFromCode(code)
  const why = code === undefined ? errs.join(' | ') || 'no ScError in events' : describeCode(code)
  return new ChainError({
    kind: kind === 'simulation_failed' ? 'submit_failed' : kind,
    message: `onchain ${resultCode}: ${why}`,
    tx: hash,
  })
}

/** Every ScError in diagnostic events, e.g. `Error(Contract, #3221)`. */
export const scErrors = (events: ReadonlyArray<xdr.DiagnosticEvent>): ReadonlyArray<string> => {
  const out = new Set<string>()
  for (const ev of events) {
    try {
      const body = ev.event().body().v0()
      for (const v of [...body.topics(), body.data()]) {
        if (v.switch().name !== 'scvError') continue
        const e = v.error()
        const kind = e.switch().name.replace(/^sce/u, '')
        const code = kind === 'Contract' ? `#${e.contractCode()}` : e.code().name.replace(/^scec/u, '')
        out.add(`Error(${kind}, ${code})`)
      }
    } catch {
      // A malformed event is not a reason to lose the others.
    }
  }
  return [...out]
}

const firstLine = (text: string): string => text.split('\n')[0]?.slice(0, 300) ?? text

export const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : String(e)

/** An RPC or network failure (nothing was submitted). */
export const rpcError = (label: string, e: unknown): ChainError =>
  new ChainError({ kind: 'unknown', message: `${label}: ${firstLine(messageOf(e))}` })
