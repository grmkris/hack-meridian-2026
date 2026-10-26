import { Predicate } from 'effect'
import { describe, expect, test } from 'vitest'

import { listTools } from './mcp-tools.ts'

/**
 * The portable tools/list subset hosts agree on, as a lint (after ~/code/myapps/packages/mcp/src/compat.ts): noun_verb
 * names, all four boolean hints, descriptions that start with what the tool does, every input described, at most 40
 * tools. Plus Nod's own risk rules: reads are read-only and never destructive; the tools that move money are destructive.
 */

/** The verbs Nod's descriptions open with; a new tool adds its verb here on purpose. */
const VERBS = new Set([
  'Show',
  'Find',
  'Freeze',
  'Pay',
  'Return',
  'Read',
  'Fetch',
  'Call',
  'Stop',
  'Ask',
  'List',
  'Prepare',
  'Decline',
  'Save',
  'Rename',
  'Remove',
  'Top',
  'Report',
  'Get',
])
const MONEY_MOVERS = ['payment_execute', 'paid_resource_fetch', 'paid_mcp_call', 'request_pay']
const READS = [
  'wallet_overview',
  'contacts_search',
  'payment_approve_url',
  'payment_status',
  'nod_home',
  'requests_list',
  'payments_list',
  'wallet_topup_status',
  'get_guide',
]

const problems = () => {
  const found: Array<string> = []
  const tools = listTools()
  if (tools.length > 40) found.push(`tools: ${tools.length} > 40`)
  const names = new Set<string>()
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/u.test(tool.name)) found.push(`${tool.name}: not a noun_verb name`)
    if (names.has(tool.name)) found.push(`${tool.name}: duplicate`)
    names.add(tool.name)
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)
      if (!Predicate.isBoolean(tool.annotations[hint])) found.push(`${tool.name}: ${hint} is not a boolean`)
    const opening = /^[A-Za-z]+/u.exec(tool.description)?.[0] ?? ''
    if (!VERBS.has(opening)) found.push(`${tool.name}: description opens with "${opening}", not a verb`)
    const schema: unknown = tool.inputSchema
    const declared = Predicate.isObject(schema) ? schema['properties'] : undefined
    const properties = Predicate.isObject(declared) ? declared : {}
    for (const [name, node] of Object.entries(properties))
      if (!Predicate.isObject(node) || typeof node['description'] !== 'string' || node['description'] === '')
        found.push(`${tool.name}: input ${name} is not described`)
  }
  return { found, tools }
}

describe('tools/list compatibility', () => {
  test('every tool passes the portable lint', () => {
    expect(problems().found).toEqual([])
  })

  test('reads are read-only and never destructive; money movers are destructive and not read-only', () => {
    const { tools } = problems()
    const hints = (name: string) => tools.find(tool => tool.name === name)?.annotations
    for (const name of READS) expect(hints(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    for (const name of MONEY_MOVERS) expect(hints(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  test('payment_prepare and contact_add state the already-paid rule; tools naming a person point mentions at contacts_search', () => {
    const { tools } = problems()
    const rule = 'An address the wallet already paid needs no nod'
    for (const name of ['payment_prepare', 'contact_add'])
      expect(tools.find(tool => tool.name === name)?.description).toContain(rule)
    const prepare: unknown = tools.find(tool => tool.name === 'payment_prepare')
    expect(Predicate.isObject(prepare) ? prepare['_meta'] : undefined).toMatchObject({
      'openai/mentions': { searchTool: 'contacts_search' },
    })
  })
})
