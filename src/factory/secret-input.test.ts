import { describe, expect, it } from '@effect/vitest'
import { Redacted } from 'effect'
import { parseEnvBlock, parseEnvLine } from './secret-input.ts'

describe('parseEnvLine', () => {
  it('reads KEY=value lines, quoted or exported', () => {
    expect(parseEnvLine('QSTASH_URL="https://qstash.acme.test"')).toEqual({
      key: 'QSTASH_URL',
      value: 'https://qstash.acme.test'
    })
    expect(parseEnvLine("export TOKEN='a=b'")).toEqual({ key: 'TOKEN', value: 'a=b' })
    expect(parseEnvLine('  KEY = plain  ')).toEqual({ key: 'KEY', value: 'plain' })
    expect(parseEnvLine('# comment')).toBeUndefined()
    expect(parseEnvLine('just a token')).toBeUndefined()
  })
})

describe('parseEnvBlock', () => {
  it('keeps only the wanted, non-empty keys; later lines win', () => {
    const values = parseEnvBlock(['A="1"', 'B=""', 'C=3', 'A=2'], ['A', 'B'])

    expect([...values.keys()]).toEqual(['A'])
    expect(Redacted.value(values.get('A') ?? Redacted.make(''))).toBe('2')
  })
})
