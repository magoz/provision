import { describe, expect, it } from '@effect/vitest'
import { Option } from 'effect'
import { providerErrorMessage } from './http.ts'

describe('providerErrorMessage', () => {
  it('reads the common provider error shapes', () => {
    expect(providerErrorMessage({ code: '', message: 'project not found' })).toEqual(
      Option.some('project not found')
    )
    expect(providerErrorMessage({ error: { message: 'forbidden' } })).toEqual(
      Option.some('forbidden')
    )
    expect(
      providerErrorMessage({ success: false, errors: [{ code: 1, message: 'bad token' }] })
    ).toEqual(Option.some('bad token'))
  })

  it('never shows token-like values, control characters, or long text', () => {
    const echoed = providerErrorMessage({
      message: 'key napi_0123456789abcdefghijklmnopqrstuv is invalid\nretry'
    })

    expect(echoed).toEqual(Option.some('key … is invalid retry'))
    expect(
      Option.getOrElse(providerErrorMessage({ message: 'a '.repeat(200) }), () => '')
    ).toHaveLength(160)
  })

  it('has nothing to show for other bodies', () => {
    expect(providerErrorMessage('Not Found')).toEqual(Option.none())
    expect(providerErrorMessage({ detail: 'x' })).toEqual(Option.none())
    expect(providerErrorMessage({ message: '   ' })).toEqual(Option.none())
  })
})
