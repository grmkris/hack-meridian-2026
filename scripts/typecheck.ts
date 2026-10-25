import { resolve } from 'node:path'

/**
 * TypeScript and Effect diagnostics for every project in one effect-tsrs pass each (tsrs, the Rust port of the
 * TypeScript 7 compiler, with Effect's language-service rules at the severities in tsconfig.base.json). Any TypeScript
 * error, Effect error or Effect warning fails. The repository starts at zero findings, so there is no baseline: fix a
 * finding, or suppress it on its line with a `@effect-diagnostics` comment that says why.
 */
const PROJECTS = [
  'tsconfig.json',
  'packages/api/tsconfig.json',
  'apps/web/tsconfig.json',
  'apps/web/tsconfig.worker.json',
]
const ROOT = resolve(import.meta.dir, '..')
const BIN = resolve(ROOT, 'node_modules/.bin/effect-tsrs')

const results = await Promise.all(
  PROJECTS.map(async project => {
    const child = Bun.spawn([BIN, 'diagnostics', '-p', project, '--strict'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { project, code, output: `${stdout}${stderr}`.trim() }
  }),
)

for (const { project, code, output } of results) {
  console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${project}${code === 2 ? ' (effect-tsrs could not run)' : ''}`)
  if (code !== 0 && output !== '') console.log(output)
}
process.exit(results.some(result => result.code !== 0) ? 1 : 0)
