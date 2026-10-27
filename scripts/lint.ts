import { resolve } from 'node:path'

import { oxlintEnv } from './tsrs-lint.ts'

const root = resolve(import.meta.dir, '..')
const child = Bun.spawn([resolve(root, 'node_modules/.bin/oxlint'), ...Bun.argv.slice(2)], {
  cwd: root,
  env: await oxlintEnv(),
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exit(await child.exited)
