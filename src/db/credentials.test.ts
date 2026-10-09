import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Redacted } from 'effect'
import { dbTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { clearSecret, readSecret, readSettings, storeSecret, writeSettings } from './credentials.ts'

const PROJECT_ENV = 'NEON_AGENTS_SANDBOX_PROJECT_ID'

const PARENT_ENV = 'NEON_AGENTS_SANDBOX_PARENT_BRANCH'

interface Files {
  readonly stored?: string
  readonly legacy?: string
}

/** Runs `use` against an isolated config home seeded with the given settings files. */
const withConfigHome = <A, E, R>(
  files: Files,
  use: (configDirectory: string) => Effect.Effect<A, E, R>,
  variables: Readonly<Record<string, string>> = {}
) =>
  Effect.gen(function* () {
    const configHome = yield* temporaryDirectory('provision-db-config')
    const stateHome = yield* temporaryDirectory('provision-db-state')
    const directory = join(configHome, 'pi')

    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })

      if (files.stored !== undefined) {
        await writeFile(join(directory, 'sandbox-db.json'), files.stored, { mode: 0o600 })
      }

      if (files.legacy !== undefined) {
        await writeFile(join(directory, 'sandbox-db.env'), files.legacy, { mode: 0o600 })
      }
    })

    return yield* use(directory).pipe(
      Effect.provide(dbTestLayer({ configHome, stateHome, variables }))
    )
  })

const settingsFor = (files: Files, variables: Readonly<Record<string, string>> = {}) =>
  withConfigHome(files, () => readSettings, variables)

describe('settings', () => {
  it.live('parse named project and parent fields', () =>
    Effect.gen(function* () {
      const settings = yield* settingsFor({
        stored: JSON.stringify({ projectId: 'project-id', parentBranch: 'parent-id', extra: 1 })
      })

      expect(Option.getOrThrow(settings.projectId)).toBe('project-id')
      expect(Option.getOrThrow(settings.parentBranch)).toBe('parent-id')
    })
  )

  it.live('malformed JSON yields no stored values', () =>
    Effect.gen(function* () {
      const settings = yield* settingsFor({ stored: '{' })

      expect(Option.isNone(settings.projectId)).toBe(true)
      expect(Option.isNone(settings.parentBranch)).toBe(true)
    })
  )

  it.live('empty stored strings fall through', () =>
    Effect.gen(function* () {
      const settings = yield* settingsFor({
        stored: JSON.stringify({ projectId: '', parentBranch: 'parent-id' })
      })

      expect(Option.isNone(settings.projectId)).toBe(true)
      expect(Option.getOrThrow(settings.parentBranch)).toBe('parent-id')
    })
  )

  it.live('environment values take precedence', () =>
    Effect.gen(function* () {
      const settings = yield* settingsFor(
        { stored: JSON.stringify({ projectId: 'stored-project', parentBranch: 'stored-parent' }) },
        { [PROJECT_ENV]: 'env-project', [PARENT_ENV]: 'env-parent' }
      )

      expect(Option.getOrThrow(settings.projectId)).toBe('env-project')
      expect(Option.getOrThrow(settings.parentBranch)).toBe('env-parent')
    })
  )

  it.live('round-trip through the JSON store and retire legacy settings', () =>
    withConfigHome(
      { legacy: `${PROJECT_ENV}=legacy-project\nNEON_AGENTS_SANDBOX_API_KEY=legacy-key\n` },
      directory =>
        Effect.gen(function* () {
          yield* writeSettings({ projectId: 'written-project', parentBranch: 'written-parent' })
          const settings = yield* readSettings

          expect(Option.getOrThrow(settings.projectId)).toBe('written-project')
          expect(Option.getOrThrow(settings.parentBranch)).toBe('written-parent')

          const legacy = yield* Effect.promise(() =>
            readFile(join(directory, 'sandbox-db.env'), 'utf8')
          )
          expect(legacy).toBe('NEON_AGENTS_SANDBOX_API_KEY=legacy-key\n')

          const info = yield* Effect.promise(() => stat(join(directory, 'sandbox-db.json')))
          expect(info.mode & 0o777).toBe(0o600)
        })
    )
  )

  it.live.each([42, null, { nested: true }])(
    'skip a non-string stored projectId (%j) independently',
    projectId =>
      Effect.gen(function* () {
        const settings = yield* settingsFor({
          stored: JSON.stringify({ projectId, parentBranch: 'parent-id' })
        })

        expect(Option.isNone(settings.projectId)).toBe(true)
        expect(Option.getOrThrow(settings.parentBranch)).toBe('parent-id')
      })
  )

  it.live('legacy file fills only the skipped field', () =>
    Effect.gen(function* () {
      const settings = yield* settingsFor({
        stored: JSON.stringify({ projectId: 1, parentBranch: 'stored-parent' }),
        legacy: `${PROJECT_ENV}=legacy-project\n${PARENT_ENV}=legacy-parent\n`
      })

      expect(Option.getOrThrow(settings.projectId)).toBe('legacy-project')
      expect(Option.getOrThrow(settings.parentBranch)).toBe('stored-parent')
    })
  )

  it.live('legacy file fills both fields when stored JSON is malformed', () =>
    Effect.gen(function* () {
      const settings = yield* settingsFor({
        stored: '{',
        legacy: `${PROJECT_ENV}=legacy-project\n${PARENT_ENV}=legacy-parent\n`
      })

      expect(Option.getOrThrow(settings.projectId)).toBe('legacy-project')
      expect(Option.getOrThrow(settings.parentBranch)).toBe('legacy-parent')
    })
  )

  it.live('deeply nested stored values are skipped', () =>
    Effect.gen(function* () {
      const depth = 10000
      const settings = yield* settingsFor({
        stored: `{"projectId":${'['.repeat(depth)}0${']'.repeat(depth)},"parentBranch":"parent-id"}`
      })

      expect(Option.isNone(settings.projectId)).toBe(true)
      expect(Option.getOrThrow(settings.parentBranch)).toBe('parent-id')
    })
  )
})

describe('secret', () => {
  it.live('prefers the environment override', () =>
    Effect.gen(function* () {
      const secret = yield* withConfigHome(
        { legacy: 'NEON_AGENTS_SANDBOX_API_KEY=file-key\n' },
        () => readSecret,
        { NEON_AGENTS_SANDBOX_API_KEY: ' env-key ' }
      )

      const value = Option.getOrThrow(secret)
      expect(value.backend).toBe('environment')
      expect(Redacted.value(value.value)).toBe('env-key')
    })
  )

  it.live('stores, reads, and clears the file backend without a keychain', () =>
    withConfigHome({}, directory =>
      Effect.gen(function* () {
        expect(yield* storeSecret(Redacted.make('stored-key'))).toBe('file')
        const stored = Option.getOrThrow(yield* readSecret)
        expect(stored.backend).toBe('file')
        expect(Redacted.value(stored.value)).toBe('stored-key')

        const info = yield* Effect.promise(() => stat(join(directory, 'sandbox-db.env')))
        expect(info.mode & 0o777).toBe(0o600)

        expect(yield* clearSecret).toEqual(['file'])
        expect(Option.isNone(yield* readSecret)).toBe(true)
      })
    )
  )
})
