import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { dbTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { loadConfig } from './config.ts'

const resolveWith = (content: string, variables: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory('provision-db-profile')
    const configHome = yield* temporaryDirectory('provision-db-config')
    const file = join(directory, '.env.local')
    yield* Effect.promise(() => writeFile(file, content, { mode: 0o600 }))

    return yield* loadConfig(file).pipe(
      Effect.provide(dbTestLayer({ configHome, stateHome: directory, variables }))
    )
  })

describe('loadConfig', () => {
  it.live('resolves a complete worktree profile atomically', () =>
    Effect.gen(function* () {
      const config = yield* resolveWith(
        [
          'SANDBOX_DB_NEON_API_KEY="project-key"',
          'SANDBOX_DB_NEON_PROJECT_ID="project-id"',
          'SANDBOX_DB_PARENT_BRANCH_ID="parent-id"'
        ].join('\n')
      )

      expect(config.backend).toBe('worktree-env')
      expect(config.projectId).toBe('project-id')
      expect(config.parentBranch).toBe('parent-id')
      expect(Redacted.value(config.apiKey)).toBe('project-key')
    })
  )

  it.live('does not fall back to global auth for a partial profile', () =>
    Effect.gen(function* () {
      const failure = yield* resolveWith('SANDBOX_DB_NEON_API_KEY=project-key\n', {
        NEON_AGENTS_SANDBOX_API_KEY: 'global-key'
      }).pipe(Effect.flip)

      expect(failure.message).toContain('incomplete sandbox database profile')
    })
  )

  it.live('does not fall back to global auth for declared but empty keys', () =>
    Effect.gen(function* () {
      const failure = yield* resolveWith(
        [
          'SANDBOX_DB_NEON_API_KEY=',
          'SANDBOX_DB_NEON_PROJECT_ID=',
          'SANDBOX_DB_PARENT_BRANCH_ID='
        ].join('\n')
      ).pipe(Effect.flip)

      expect(failure.message).toContain('empty SANDBOX_DB_NEON_API_KEY')
    })
  )

  it.live('falls back to global auth without a worktree profile', () =>
    Effect.gen(function* () {
      const config = yield* resolveWith('OTHER=value\n', {
        NEON_AGENTS_SANDBOX_API_KEY: 'global-key',
        NEON_AGENTS_SANDBOX_PROJECT_ID: 'global-project',
        NEON_AGENTS_SANDBOX_PARENT_BRANCH: 'global-parent'
      })

      expect(config.backend).toBe('environment')
      expect(config.projectId).toBe('global-project')
    })
  )

  it.live('refuses a symbolic-link profile path', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-db-symlink')
      const target = join(directory, 'target')
      const file = join(directory, '.env.local')

      yield* Effect.promise(async () => {
        await writeFile(target, 'SANDBOX_DB_NEON_API_KEY=key\n')
        await symlink(target, file)
      })

      const failure = yield* loadConfig(file).pipe(
        Effect.provide(dbTestLayer({ configHome: directory, stateHome: directory })),
        Effect.flip
      )

      expect(failure.message).toContain('symbolic-link')
    })
  )
})
