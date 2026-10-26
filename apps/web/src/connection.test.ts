import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { clientUrl, nextAllowanceExpiry } from './connection'
import { claude, revokedClaude } from './page/fixtures'

test('the clock wakes for the next active expiry and advances at its boundary', () => {
  const now = Date.parse('2026-10-26T10:00:00Z')
  const grants = [
    { ...claude, valid_until: '2026-10-26T12:00:00Z' },
    { ...revokedClaude, valid_until: '2026-10-26T10:30:00Z' },
    { ...claude, valid_until: '2026-10-26T11:00:00Z' },
    { ...claude, valid_until: '2026-10-26T09:00:00Z' },
  ]
  expect(nextAllowanceExpiry(grants, now)).toEqual(Option.some(Date.parse('2026-10-26T11:00:00Z')))
  expect(nextAllowanceExpiry(grants, Date.parse('2026-10-26T11:00:00Z'))).toEqual(
    Option.some(Date.parse('2026-10-26T12:00:00Z')),
  )
  expect(nextAllowanceExpiry(grants, Date.parse('2026-10-26T12:00:00Z'))).toEqual(Option.none())
})

describe('stored OAuth client destinations', () => {
  test.each([
    ['claude.ai', 'https://claude.ai/'],
    ['https://chatgpt.com/', 'https://chatgpt.com/'],
    ['https://another-agent.example/chat?from=nod', 'https://another-agent.example/chat?from=nod'],
    ['http://localhost:8787', 'http://localhost:8787/'],
  ])('links %s without an app allowlist', (domain, url) => {
    expect(clientUrl(domain)).toEqual(Option.some(url))
  })
  test.each([
    null,
    '',
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/test',
    '/settings',
    '//example.com',
    'https://user:password@example.com',
    'https://',
    'not a domain',
    'https:\\example.com',
  ])('does not link %s', domain => {
    expect(clientUrl(domain)).toEqual(Option.none())
  })
})
