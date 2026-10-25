import { describe, expect, it } from 'vitest'

import {
  Address,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

import { createDepositOps, lockDepositOps, registerFunc, sweepFunc, teardownTx } from '../src/deposit.ts'
import { DEPOSIT_ROUTER, USDC_ISSUER } from '../src/index.ts'
import { TESTNET, PUBNET } from '../src/network.ts'

const usdc = new Asset('USDC', USDC_ISSUER)
const relayer = Keypair.random().publicKey()
const deposit = Keypair.random()
const wallet = 'CAFLFU5GH7QZ6KF3FBKRV7VW5XFYUKQPCFFTCPTKVEUG4TDT5B2ZOXGL'

describe('deposit address transactions', () => {
  it('create: the relayer sponsors G (0 XLM) and its USDC trustline; G signs only its own ops', () => {
    const ops = createDepositOps(relayer, deposit.publicKey(), usdc)
    expect(ops.map(op => op.body().switch().name)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ])
    expect(ops[1]?.body().createAccountOp().startingBalance().toString()).toBe('0')
    const sources = ops.map(op => {
      const s = op.sourceAccount()
      return s === null || s === undefined ? null : s.ed25519().equals(deposit.rawPublicKey()) ? 'G' : 'relayer'
    })
    expect(sources).toEqual(['relayer', 'relayer', 'G', 'G'])
  })

  it('lock: master weight 0 and the teardown hash as the only (sponsored) signer; thresholds untouched', () => {
    const hash = new Uint8Array(32).fill(9)
    const ops = lockDepositOps(relayer, deposit.publicKey(), hash)
    expect(ops.map(op => op.body().switch().name)).toEqual([
      'beginSponsoringFutureReserves',
      'setOptions',
      'endSponsoringFutureReserves',
    ])
    const set = ops[1]?.body().setOptionsOp()
    expect(set?.masterWeight()).toBe(0)
    expect(set?.signer()?.key().switch().name).toBe('signerKeyTypePreAuthTx')
    expect([...(set?.signer()?.key().preAuthTx() ?? [])]).toEqual([...hash])
    expect(set?.signer()?.weight()).toBe(1)
    expect(set?.lowThreshold() ?? null).toBeNull()
    expect(set?.medThreshold() ?? null).toBeNull()
    expect(set?.highThreshold() ?? null).toBeNull()
  })

  it('register and sweep call the router with G (and C for register)', () => {
    const reg = registerFunc(DEPOSIT_ROUTER, deposit.publicKey(), wallet, 8_500_000).invokeContract()
    expect(Address.fromScAddress(reg.contractAddress()).toString()).toBe(DEPOSIT_ROUTER)
    expect(reg.functionName().toString()).toBe('register')
    expect(reg.args().map(a => scValToNative(a))).toEqual([deposit.publicKey(), wallet, 8_500_000])
    const sw = sweepFunc(DEPOSIT_ROUTER, deposit.publicKey()).invokeContract()
    expect(sw.functionName().toString()).toBe('sweep')
    expect(sw.args().map(a => scValToNative(a))).toEqual([deposit.publicKey()])
  })

  it("teardown: G's next sequence, trustline removed then merged into the relayer, unsigned, no expiry", () => {
    const { xdr, hash } = teardownTx(deposit.publicKey(), '1234', relayer, usdc, Networks.TESTNET)
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
    if (tx instanceof FeeBumpTransaction) throw new TypeError('the teardown is a plain transaction')
    expect([...tx.hash()]).toEqual([...hash])
    expect(tx.source).toBe(deposit.publicKey())
    expect(tx.sequence).toBe('1235')
    expect(tx.timeBounds?.maxTime ?? '0').toBe('0')
    expect(tx.operations.map(op => op.type)).toEqual(['changeTrust', 'accountMerge'])
    expect(tx.operations[0]).toMatchObject({ limit: '0.0000000' })
    expect(tx.operations[1]).toMatchObject({ destination: relayer })
    expect(tx.signatures).toHaveLength(0)
  })

  it('the router is configured on testnet only', () => {
    expect(TESTNET.contracts.depositRouter).toBe(DEPOSIT_ROUTER)
    expect(PUBNET.contracts.depositRouter).toBe('')
  })
})
