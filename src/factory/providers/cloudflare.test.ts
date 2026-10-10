import { describe, expect, it } from '@effect/vitest'
import { corsRulesMatch } from './cloudflare.ts'

const origin = 'https://app.acme.test'

const rule = {
  allowed: { methods: ['PUT'], origins: [origin], headers: ['content-type'] },
  exposeHeaders: ['etag'],
  maxAgeSeconds: 3600
}

describe('corsRulesMatch', () => {
  it('matches the upload policy regardless of field order, rule id, or header case', () => {
    expect(
      corsRulesMatch(
        [
          {
            maxAgeSeconds: 3600,
            exposeHeaders: ['ETag'],
            allowed: { headers: ['Content-Type'], origins: [origin], methods: ['PUT'] }
          }
        ],
        origin
      )
    ).toBe(true)
  })

  it('rejects another origin, extra methods, extra rules, or no rules', () => {
    expect(corsRulesMatch([rule], 'https://other.acme.test')).toBe(false)
    expect(
      corsRulesMatch([{ ...rule, allowed: { ...rule.allowed, methods: ['PUT', 'GET'] } }], origin)
    ).toBe(false)
    expect(corsRulesMatch([rule, rule], origin)).toBe(false)
    expect(corsRulesMatch([], origin)).toBe(false)
  })
})
