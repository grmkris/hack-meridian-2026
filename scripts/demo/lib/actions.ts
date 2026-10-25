import type { Page } from 'playwright-core'

/**
 * Browser steps for the owner's pages (consent, approval, connections, claim), as data, so a new page layout is a
 * config change in scripts/demo/targets.ts. `{{name}}` in a url, selector or value is replaced from the variables.
 */
export type Action =
  | { readonly do: 'goto'; readonly url: string }
  | { readonly do: 'fill'; readonly selector: string; readonly value: string; readonly optional?: boolean }
  | {
      readonly do: 'click'
      readonly selector: string
      readonly optional?: boolean
      readonly timeoutMs?: number
      /** Retry the click (up to 3 times) until this selector shows: for buttons a re-render can swallow. */
      readonly until?: string
    }
  | { readonly do: 'waitFor'; readonly selector: string; readonly optional?: boolean; readonly timeoutMs?: number }
  | { readonly do: 'waitForText'; readonly text: string; readonly optional?: boolean; readonly timeoutMs?: number }
  | { readonly do: 'shot'; readonly name: string }

export type Vars = Readonly<Record<string, string | undefined>>

const fill = (template: string, vars: Vars) =>
  template.replace(/\{\{(\w+)\}\}/gu, (_, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`browser step needs {{${name}}}, which is not known yet`)
    return value
  })

/** Runs the actions in order, reporting what happened one line at a time (so a failure keeps the lines before it). */
export async function perform(
  page: Page,
  actions: ReadonlyArray<Action>,
  vars: Vars,
  shot: (name: string) => Promise<string>,
  report: (line: string) => void,
): Promise<void> {
  const log = { push: report }
  for (const action of actions) {
    const optional = 'optional' in action ? (action.optional ?? false) : false
    try {
      switch (action.do) {
        case 'goto': {
          const response = await page.goto(fill(action.url, vars), { waitUntil: 'load' })
          log.push(
            `goto ${page.url().replace(/([?&](code|state|code_challenge)=)[^&]+/gu, '$1<redacted>')} → ${response?.status() ?? '?'}`,
          )
          break
        }
        case 'fill':
          await page
            .locator(fill(action.selector, vars))
            .first()
            .fill(fill(action.value, vars), { timeout: optional ? 3_000 : 15_000 })
          log.push(`fill ${action.selector}${action.value.includes('password') ? ' (password)' : ''}`)
          break
        case 'click': {
          const target = page.locator(fill(action.selector, vars)).first()
          const until = action.until === undefined ? undefined : page.locator(fill(action.until, vars)).first()
          for (let attempt = 1; ; attempt++) {
            await target.click({ timeout: action.timeoutMs ?? (optional ? 5_000 : 30_000) })
            await page.waitForLoadState('load').catch(() => undefined)
            if (until === undefined) break
            const shown = await until.waitFor({ state: 'visible', timeout: 5_000 }).then(
              () => true,
              () => false,
            )
            if (shown) break
            if (attempt === 3)
              throw new Error(`${action.until} did not appear after clicking ${action.selector} 3 times`)
          }
          log.push(`click ${action.selector}`)
          break
        }
        case 'waitFor':
          await page
            .locator(fill(action.selector, vars))
            .first()
            .waitFor({ state: 'visible', timeout: action.timeoutMs ?? 30_000 })
          log.push(`visible ${action.selector}`)
          break
        case 'waitForText':
          await page
            .getByText(fill(action.text, vars))
            .first()
            .waitFor({ timeout: action.timeoutMs ?? 30_000 })
          log.push(`text "${action.text}"`)
          break
        case 'shot':
          log.push(`screenshot ${await shot(action.name)}`)
          break
      }
    } catch (error) {
      if (!optional) throw error
      log.push(
        `skipped optional ${action.do} (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
      )
    }
  }
}
