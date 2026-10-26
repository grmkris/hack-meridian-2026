import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { clientUrl } from './connection'

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
