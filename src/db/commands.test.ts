import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { Command } from 'effect/cli'
import { fakeNeon } from '../testing/fake-neon.ts'
import { dbTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { dbCommand } from './commands.ts'
import { readLease } from './lease.ts'

const profile = [
  'SANDBOX_DB_NEON_API_KEY=project-key',
  'SANDBOX_DB_NEON_PROJECT_ID=project',
  'SANDBOX_DB_PARENT_BRANCH_ID=parent',
  ''
].join('\n')

const setup = (packageJson: Record<string, unknown>, projectName = 'repo-dev') =>
  Effect.gen(function* () {
    const repo = yield* temporaryDirectory('repo')
    const stateHome = yield* temporaryDirectory('provision-db-state')
    const configHome = yield* temporaryDirectory('provision-db-config')

    yield* Effect.promise(async () => {
      execFileSync('git', ['-C', repo, 'init', '--quiet'])
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git'])
      await writeFile(join(repo, '.gitignore'), '.env.local\n.env.test\n')
      await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'repo', ...packageJson }))
      await writeFile(join(repo, '.env.local'), profile)
    })

    const neon = fakeNeon(projectName)
    const layer = Layer.mergeAll(dbTestLayer({ configHome, stateHome }), neon.layer)
    const run = (...args: ReadonlyArray<string>) =>
      Command.runWith(dbCommand, { version: 'test' })(args).pipe(Effect.provide(layer))
    const envFile = () => Effect.promise(() => readFile(join(repo, '.env.local'), 'utf8'))
    const lease = readLease(repo).pipe(Effect.provide(layer))

    return { repo, neon, run, envFile, lease }
  })

afterEach(() => {
  process.exitCode = undefined
})

describe('provision db', () => {
  it.live('creates, reuses, and releases a lease end to end', () =>
    Effect.gen(function* () {
      const { repo, neon, run, envFile, lease } = yield* setup({})

      yield* run('create', '--worktree', repo, '--label', 'feature', '--ttl', '1d', '--json')
      const created = Option.getOrThrow(yield* lease)

      expect(created.branchName).toMatch(/^agent\/repo-feature-[0-9a-f]{6}$/)
      expect(created.repository).toBe('owner/repo')
      expect(yield* envFile()).toBe(
        `${profile}DATABASE_URL=postgres://${created.branchId}-pooler/neondb\n` +
          `DATABASE_URL_UNPOOLED=postgres://${created.branchId}/neondb\n`
      )
      expect(process.exitCode).toBeUndefined()

      yield* run('create', '--worktree', repo, '--label', 'feature', '--json')
      expect(neon.calls.filter(call => call === 'POST /branches')).toHaveLength(1)
      expect(Option.getOrThrow(yield* lease).branchId).toBe(created.branchId)
      expect(neon.calls).toContain(`PATCH /branches/${created.branchId}`)

      yield* run('release', '--worktree', repo, '--json')
      expect(neon.branches.has(created.branchId)).toBe(false)
      expect(yield* envFile()).toBe(profile)
      expect(Option.isNone(yield* lease)).toBe(true)
      expect(process.exitCode).toBeUndefined()
    })
  )

  it.live('attests the factory baseline only when the repository declares it', () =>
    Effect.gen(function* () {
      const undeclared = yield* setup({}, 'unrelated-name')
      yield* undeclared.run('create', '--worktree', undeclared.repo, '--json')
      expect(Option.isSome(yield* undeclared.lease)).toBe(true)

      const declared = yield* setup(
        { provision: { factory: { neon: { sandboxParent: 'empty-baseline' } } } },
        'unrelated-name'
      )
      yield* declared.run('create', '--worktree', declared.repo, '--json')
      expect(process.exitCode).toBe(2)
      expect(Option.isNone(yield* declared.lease)).toBe(true)
      expect(declared.neon.calls).not.toContain('POST /branches')
    })
  )

  it.live('refuses to write database URLs to an env file git would track', () =>
    Effect.gen(function* () {
      const { repo, neon, run } = yield* setup({})
      yield* Effect.promise(() => writeFile(join(repo, '.env.custom'), profile))

      yield* run('create', '--worktree', repo, '--env-file', '.env.custom', '--json')

      expect(process.exitCode).toBe(2)
      expect(neon.calls).not.toContain('POST /branches')
    })
  )
})
