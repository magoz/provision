import { readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { temporaryDirectory } from '../testing/temporary.ts'
import { hasEnvKeys, parseEnvFile, removeEnvKeys, writeEnvKeys } from './env-file.ts'
import { writePrivately } from './private-file.ts'

describe('parseEnvFile', () => {
  it('reads keys, skips comments, and strips matching quotes', () => {
    const entries = parseEnvFile(
      ['# comment', 'A=1', 'B="two"', "C='three'", 'D="unbalanced', 'invalid', ' E = spaced '].join(
        '\n'
      )
    )

    expect(Object.fromEntries(entries)).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
      D: '"unbalanced',
      E: 'spaced'
    })
  })
})

describe('private env files', () => {
  it.live('private atomic writes create mode-0600 files', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-private')
      const file = join(directory, '.env.local')
      yield* writePrivately(file, 'SAFE=value\n')

      expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe('SAFE=value\n')
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
    })
  )

  it.live('replace only the written keys and remove them again', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-env-keys')
      const file = join(directory, '.env.local')
      yield* Effect.promise(() => writeFile(file, 'KEEP=1\nDATABASE_URL=old\n\n'))

      yield* writeEnvKeys(file, [
        ['DATABASE_URL', Redacted.make('postgres://pooled')],
        ['DATABASE_URL_UNPOOLED', Redacted.make('postgres://direct')]
      ])

      expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe(
        'KEEP=1\nDATABASE_URL=postgres://pooled\nDATABASE_URL_UNPOOLED=postgres://direct\n'
      )
      expect(yield* hasEnvKeys(file, ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'])).toBe(true)

      yield* removeEnvKeys(file, ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'])
      expect(yield* Effect.promise(() => readFile(file, 'utf8'))).toBe('KEEP=1\n')
      expect(yield* hasEnvKeys(file, ['DATABASE_URL'])).toBe(false)
    })
  )

  it.live('refuse symbolic-link paths without touching their target', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-symlink')
      const target = join(directory, 'target')
      const file = join(directory, '.env.local')

      yield* Effect.promise(async () => {
        await writeFile(target, 'SENTINEL=keep\n', { mode: 0o600 })
        await symlink(target, file)
      })

      const failure = yield* writeEnvKeys(file, [
        ['DATABASE_URL', Redacted.make('postgres://secret')]
      ]).pipe(Effect.flip)

      expect(failure.reason).toBe('symbolic-link')
      expect(yield* Effect.promise(() => readFile(target, 'utf8'))).toBe('SENTINEL=keep\n')
    })
  )
})
