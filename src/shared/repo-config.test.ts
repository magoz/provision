import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { defaultRepoConfig, normalizeAppDir, parseRepoConfig } from './repo-config.ts'

const packageJson = (value: Record<string, unknown>) => JSON.stringify({ name: 'app', ...value })

const failureMessage = (text: string) =>
  parseRepoConfig(text).pipe(
    Effect.flip,
    Effect.map(error => error.message)
  )

describe('parseRepoConfig', () => {
  it.effect('uses defaults without a provision key', () =>
    Effect.gen(function* () {
      expect(yield* parseRepoConfig(packageJson({}))).toEqual(defaultRepoConfig)
    })
  )

  it.effect('resolves a monorepo configuration', () =>
    Effect.gen(function* () {
      const config = yield* parseRepoConfig(
        packageJson({
          provision: {
            appDir: 'apps/web/',
            setup: ['pnpm db:migrate'],
            factory: { steps: ['secrets', 'neon'], neon: { sandboxParent: 'existing-branch' } }
          }
        })
      )

      expect(config).toEqual({
        appDir: 'apps/web',
        setup: ['pnpm db:migrate'],
        factory: { steps: ['neon', 'secrets'], neon: { sandboxParent: 'existing-branch' } }
      })
    })
  )

  it.effect('keeps unrelated worktree settings', () =>
    Effect.gen(function* () {
      const config = yield* parseRepoConfig(packageJson({ worktree: { other: true } }))
      expect(config).toEqual(defaultRepoConfig)
    })
  )

  it.effect('rejects unknown provision keys', () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(packageJson({ provision: { appdir: 'apps/web' } }))
      expect(message).toContain('appdir')
    })
  )

  it.effect('rejects unknown and duplicate factory steps', () =>
    Effect.gen(function* () {
      yield* failureMessage(packageJson({ provision: { factory: { steps: ['vercel', 'aws'] } } }))
      yield* failureMessage(packageJson({ provision: { factory: { steps: ['neon', 'neon'] } } }))
      yield* failureMessage(packageJson({ provision: { factory: { steps: [] } } }))
    })
  )

  it.effect('rejects blank setup commands', () =>
    Effect.gen(function* () {
      yield* failureMessage(packageJson({ provision: { setup: ['  '] } }))
      yield* failureMessage(packageJson({ provision: { setup: [' pnpm db:migrate'] } }))
    })
  )

  it.effect('rejects app directories outside the checkout', () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(packageJson({ provision: { appDir: '../web' } }))
      expect(message).toContain('provision.appDir')
    })
  )

  it.effect('points legacy keys to their replacements', () =>
    Effect.gen(function* () {
      expect(
        yield* failureMessage(packageJson({ provisionEnv: { appDir: 'apps/web' } }))
      ).toContain('provision.appDir')
      expect(
        yield* failureMessage(packageJson({ worktree: { setup: ['pnpm db:migrate'] } }))
      ).toContain('provision.setup')
    })
  )

  it.effect('rejects invalid JSON', () =>
    Effect.gen(function* () {
      expect(yield* failureMessage('{')).toContain('invalid package.json')
    })
  )
})

describe('normalizeAppDir', () => {
  it('normalizes relative paths', () => {
    expect(normalizeAppDir('.')).toBe('.')
    expect(normalizeAppDir('./apps/web/')).toBe('apps/web')
    expect(normalizeAppDir('apps//web')).toBe('apps/web')
    expect(normalizeAppDir('apps/web/../api')).toBe('apps/api')
  })

  it('rejects paths that leave the checkout', () => {
    expect(normalizeAppDir('/abs')).toBeUndefined()
    expect(normalizeAppDir('..')).toBeUndefined()
    expect(normalizeAppDir('../web')).toBeUndefined()
    expect(normalizeAppDir('apps/../../web')).toBeUndefined()
    expect(normalizeAppDir('apps\\web')).toBeUndefined()
  })
})
