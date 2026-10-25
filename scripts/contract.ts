import { $ } from 'bun'
import { Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The Soroban contract's build, testnet deploy and TypeScript bindings.
 *
 *   bun scripts/contract.ts deploy     build, deploy a fresh instance to testnet as hm-deployer, record it in
 *                                      contracts/deployments/testnet.json (public: ids and hashes only)
 *   bun scripts/contract.ts bindings   regenerate packages/counter-client from the built wasm (no network)
 *
 * The deployer is the stellar CLI identity `hm-deployer` (~/.config/stellar/identity, created and funded by friendbot
 * on first use). Its secret never leaves the CLI's own config.
 */
const ROOT = resolve(import.meta.dir, '..')
const CONTRACTS = join(ROOT, 'contracts')
const WASM = join(CONTRACTS, 'target/wasm32v1-none/release/counter.wasm')
const DEPLOYMENT = join(CONTRACTS, 'deployments/testnet.json')
const BINDINGS = join(ROOT, 'packages/counter-client')
const IDENTITY = 'hm-deployer'
const NETWORK = {
  name: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  passphrase: 'Test SDF Network ; September 2015',
}
/** stellar-cli 28.1 generates for stellar-sdk 16; 16.4.1 is the last 16.x. */
const BINDINGS_PINS = { '@stellar/stellar-sdk': '16.4.1', buffer: '6.0.3' }

const build = async () => {
  await $`stellar contract build`.cwd(CONTRACTS)
  if (!existsSync(WASM)) throw new Error(`no wasm at ${WASM} after the build`)
}

const deployer = async (): Promise<string> => {
  const known = await $`stellar keys address ${IDENTITY}`.nothrow().quiet()
  if (known.exitCode !== 0) await $`stellar keys generate ${IDENTITY} --network ${NETWORK.name} --fund`
  return (await $`stellar keys address ${IDENTITY}`.text()).trim()
}

const Recorded = Schema.Struct({ contracts: Schema.Record(Schema.String, Schema.Unknown) })

const deploy = async () => {
  await build()
  const account = await deployer()
  const wasmHash = new Bun.CryptoHasher('sha256').update(readFileSync(WASM)).digest('hex')
  const id = (
    await $`stellar contract deploy --wasm ${WASM} --source-account ${IDENTITY} --network ${NETWORK.name} --alias hm-counter`.text()
  ).trim()
  if (!/^C[A-Z2-7]{55}$/u.test(id)) throw new Error(`the deploy printed no contract id: ${id}`)
  const head = await $`git rev-parse --verify HEAD`.cwd(ROOT).nothrow().quiet()
  const release = head.exitCode === 0 ? head.text().trim() : 'uncommitted'
  // The record also lists contracts deployed by other means (the onboard router); a counter deploy keeps them.
  const others = existsSync(DEPLOYMENT)
    ? Schema.decodeUnknownSync(Recorded)(JSON.parse(readFileSync(DEPLOYMENT, 'utf8'))).contracts
    : {}
  const record = {
    network: NETWORK.name,
    rpcUrl: NETWORK.rpcUrl,
    networkPassphrase: NETWORK.passphrase,
    contracts: {
      ...others,
      counter: { id, wasmHash, deployer: account, deployedAt: new Date().toISOString(), release },
    },
  }
  writeFileSync(DEPLOYMENT, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`counter ${id} on ${NETWORK.name}: https://stellar.expert/explorer/testnet/contract/${id}`)
}

const GeneratedManifest = Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) })

/**
 * The generated package is written for its own tsconfig, not this repository's strict one, so it is compiled to dist/
 * with that tsconfig and the workspace imports the compiled module and its declarations. Both are committed.
 */
const bindings = async () => {
  if (!existsSync(WASM)) await build()
  await $`stellar contract bindings typescript --wasm ${WASM} --output-dir ${BINDINGS} --overwrite`.quiet()
  const manifestPath = join(BINDINGS, 'package.json')
  const manifest = Schema.decodeUnknownSync(GeneratedManifest)(JSON.parse(readFileSync(manifestPath, 'utf8')))
  // Exact pins in place of the generator's ranges; bump them deliberately, with the bindings regenerated.
  const dependencies = { ...manifest.dependencies, ...BINDINGS_PINS }
  const workspace = {
    name: '@hm/counter-client',
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies,
  }
  writeFileSync(manifestPath, `${JSON.stringify(workspace, null, 2)}\n`)
  await $`bun install`.cwd(ROOT).quiet()
  await $`${join(ROOT, 'node_modules/.bin/tsc')} -p ${join(BINDINGS, 'tsconfig.json')} --rootDir ${join(BINDINGS, 'src')}`
  console.log(`bindings written to ${BINDINGS} and compiled to dist/`)
}

const command = process.argv[2]
if (command === 'deploy') await deploy()
else if (command === 'bindings') await bindings()
else throw new Error('usage: bun scripts/contract.ts deploy|bindings')
