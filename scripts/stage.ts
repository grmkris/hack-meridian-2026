import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The only way to run Alchemy here. It builds the child environment from scratch: no inherited CLOUDFLARE_*, HM_* or
 * ALCHEMY_* values, no Bun .env autoload, and the Cloudflare token only for a cloud run.
 *
 *   bun scripts/stage.ts dev                         local stage under alchemy dev, http://localhost:18960
 *   bun scripts/stage.ts plan:testnet                what a testnet deploy would change
 *   bun scripts/stage.ts deploy:testnet              deploy https://testnet.trynod.si
 *   bun scripts/stage.ts destroy:testnet --confirm   remove the testnet Worker
 *
 * The token comes from CLOUDFLARE_API_TOKEN in the shell or ~/.config/secrets.env (mode 600); it is never printed.
 */
const ROOT = resolve(import.meta.dir, '..')
const WEB = join(ROOT, 'apps/web')
const ALCHEMY = join(ROOT, 'node_modules/alchemy/bin/cli.js')
const ACCOUNT_ID = 'bceaeae4788dce3493514fde194b4a7e'
/** Alchemy wants credentials even under alchemy dev; these reach no account. */
const LOCAL_CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_API_TOKEN: 'local-placeholder-token' }
const ACTIONS = ['dev', 'plan', 'deploy', 'destroy'] as const
const SCRUBBED = /^(CLOUDFLARE_|HM_|ALCHEMY_)/u

const [command = 'dev', ...rest] = process.argv.slice(2)
const [verb, stage = 'local'] = command.split(':')
const action = ACTIONS.find(known => known === verb)
if (action === undefined) throw new Error(`unknown command ${command}`)
if (action === 'dev' && stage !== 'local') throw new Error('alchemy dev runs the local stage only')
if (action !== 'dev' && stage === 'local') throw new Error(`${action} needs a cloud stage, e.g. ${action}:testnet`)
if (action === 'destroy' && !rest.includes('--confirm')) throw new Error('destroying a stage needs --confirm')

const fromSecretsFile = (name: string): string | undefined => {
  const file = join(homedir(), '.config/secrets.env')
  if (!existsSync(file)) return undefined
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find(entry => new RegExp(`^(export\\s+)?${name}=`, 'u').test(entry.trim()))
  return line
    ?.slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/gu, '')
}

const git = (...args: Array<string>) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim()

const release = () => {
  const head = git('rev-parse', '--verify', 'HEAD')
  if (head === '') throw new Error('commit before deploying: the release is the commit /api/health reports')
  return git('status', '--porcelain', '--', 'apps', 'packages', 'contracts/deployments') === '' ? head : `${head}-dirty`
}

const cloud = () => {
  const token = process.env['CLOUDFLARE_API_TOKEN'] ?? fromSecretsFile('CLOUDFLARE_API_TOKEN')
  if (token === undefined || token === '')
    throw new Error('CLOUDFLARE_API_TOKEN is not in the shell or ~/.config/secrets.env')
  return { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: token, HM_RELEASE: release() }
}

const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !SCRUBBED.test(entry[0]),
  ),
)
const env = {
  ...inherited,
  ...(stage === 'local' ? LOCAL_CREDENTIALS : cloud()),
  ALCHEMY_PLAIN: '1',
  BUN_OPTIONS: '--no-env-file',
}
const args = [
  ALCHEMY,
  action,
  '--config',
  'alchemy.run.ts',
  '--stage',
  stage,
  ...(action === 'deploy' || action === 'destroy' ? ['--yes'] : []),
  ...rest.filter(arg => arg !== '--confirm'),
]
const result = spawnSync('bun', args, { cwd: WEB, env, stdio: 'inherit' })
process.exit(result.status ?? 1)
