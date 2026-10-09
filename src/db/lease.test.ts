import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Fiber, Option } from 'effect'
import { dbTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { LeaseError, type Lease } from './domain.ts'
import {
  acquireLeaseLock,
  allLeases,
  expiredBeyondGrace,
  readLease,
  releaseLeaseLock,
  removeLease,
  withLeaseLock,
  withLeaseLockUsing,
  writeLease
} from './lease.ts'

const makeLease = (worktree: string, leaseName: string, envFile: string): Lease => ({
  version: 2,
  leaseName,
  projectId: 'project-id',
  parentBranch: 'parent-id',
  branchId: `branch-${leaseName}`,
  branchName: `agent/repo-${leaseName}`,
  worktree,
  repository: 'owner/repo',
  label: leaseName,
  configEnvFile: `${worktree}/.env.local`,
  envFile,
  envKeys: ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'],
  createdAt: '2026-08-13T20:00:00Z',
  expiresAt: '2026-08-20T20:00:00Z'
})

/** Runs `use` with an isolated state home and the live Node services. */
const withStateHome = <A, E, R>(use: (stateHome: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const stateHome = yield* temporaryDirectory('provision-db-state')
    const configHome = yield* temporaryDirectory('provision-db-config')

    return yield* use(stateHome).pipe(Effect.provide(dbTestLayer({ configHome, stateHome })))
  })

describe('lease locks', () => {
  it.live('surface finalizer failures without replacing a lone operation failure', () =>
    Effect.gen(function* () {
      const operationFailure = new LeaseError({ message: 'operation failed' })
      const cleanupFailure = new LeaseError({ message: 'cleanup failed' })
      const acquire = Effect.succeed('lock')

      const original = yield* withLeaseLockUsing(
        acquire,
        () => Effect.void,
        Effect.fail(operationFailure)
      ).pipe(Effect.flip)

      expect(original).toBe(operationFailure)

      const lone = yield* withLeaseLockUsing(
        acquire,
        () => Effect.fail(cleanupFailure),
        Effect.succeed('ok')
      ).pipe(Effect.flip)

      expect(lone.message).toBe('cleanup failed')

      const composite = yield* withLeaseLockUsing(
        acquire,
        () => Effect.fail(cleanupFailure),
        Effect.fail(operationFailure)
      ).pipe(Effect.flip)

      expect(composite.message).toBe('sandbox operation and lease lock cleanup both failed')
    })
  )

  it.live('release after defects without normalizing the defect', () =>
    Effect.gen(function* () {
      let released = false
      const defect = { sentinel: 'lease-defect' }

      const exit = yield* Effect.exit(
        withLeaseLockUsing(
          Effect.succeed('lock'),
          () =>
            Effect.sync(() => {
              released = true
            }),
          Effect.die(defect)
        )
      )

      expect(released).toBe(true)
      expect(
        Exit.isFailure(exit) &&
          Option.getOrUndefined(Option.getSuccess(Cause.findDefect(exit.cause)))
      ).toBe(defect)
    })
  )

  it.live('interruption removes the acquired filesystem lock', () =>
    withStateHome(stateHome =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(withLeaseLock('/worktree', 'interrupt', Effect.never))
        const locks = join(stateHome, 'pi', 'sandbox-db', 'locks')

        for (let attempt = 0; attempt < 40; attempt += 1) {
          const entries = yield* Effect.promise(() => readdir(locks).catch(() => []))

          if (entries.length > 0) break
          yield* Effect.sleep('5 millis')
        }

        expect(yield* Effect.promise(() => readdir(locks))).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* Effect.promise(() => readdir(locks))).toHaveLength(0)
      })
    )
  )

  it.live('serialize operations per worktree and lease slot', () =>
    withStateHome(() =>
      Effect.gen(function* () {
        const lock = yield* acquireLeaseLock('/worktree', 'test')
        const contended = yield* acquireLeaseLock('/worktree', 'test').pipe(Effect.flip)
        expect(contended.message).toContain(`remove stale lock ${lock}`)

        const other = yield* acquireLeaseLock('/worktree', 'default')
        yield* releaseLeaseLock(other)
        yield* releaseLeaseLock(lock)
        expect(yield* acquireLeaseLock('/worktree', 'test')).toContain('.lock')
      })
    )
  )
})

describe('lease records', () => {
  it.live('named leases coexist and legacy records normalize to default', () =>
    withStateHome(stateHome =>
      Effect.gen(function* () {
        const worktree = '/worktrees/repo/feature'
        yield* writeLease(makeLease(worktree, 'default', `${worktree}/.env.local`))
        yield* writeLease(makeLease(worktree, 'test', `${worktree}/.env.test`))

        expect(Option.getOrThrow(yield* readLease(worktree, 'default')).branchId).toBe(
          'branch-default'
        )
        expect(Option.getOrThrow(yield* readLease(worktree, 'test')).branchId).toBe('branch-test')
        expect((yield* allLeases).map(lease => lease.leaseName)).toEqual(['default', 'test'])

        const directory = join(stateHome, 'pi', 'sandbox-db', 'leases')
        const files = (yield* Effect.promise(() => readdir(directory))).filter(file =>
          file.endsWith('.json')
        )
        expect(files).toHaveLength(2)

        for (const file of files) {
          const info = yield* Effect.promise(() => stat(join(directory, file)))
          expect(info.mode & 0o777).toBe(0o600)
        }

        yield* removeLease(worktree, 'test')
        expect(Option.isNone(yield* readLease(worktree, 'test'))).toBe(true)
        expect(Option.isSome(yield* readLease(worktree, 'default'))).toBe(true)
        yield* removeLease(worktree, 'default')

        const legacyFile = join(
          directory,
          `${createHash('sha256').update(worktree).digest('hex').slice(0, 16)}.json`
        )

        const legacy = {
          version: 1,
          projectId: 'legacy-project',
          parentBranch: 'legacy-parent',
          branchId: 'legacy-branch',
          branchName: 'agent/legacy',
          worktree,
          repository: 'owner/repo',
          label: 'legacy',
          envFile: `${worktree}/.env.local`,
          envKeys: ['DATABASE_URL'],
          createdAt: '2026-08-13T20:00:00Z',
          expiresAt: '2026-08-20T20:00:00Z'
        }

        yield* Effect.promise(async () => {
          await mkdir(directory, { recursive: true })
          await writeFile(legacyFile, `${JSON.stringify(legacy)}\n`)
          await chmod(legacyFile, 0o600)
        })

        const normalized = Option.getOrThrow(yield* readLease(worktree))
        expect(normalized.version).toBe(2)
        expect(normalized.leaseName).toBe('default')
        expect(normalized.configEnvFile).toBe(legacy.envFile)

        const raw = yield* Effect.promise(() => readFile(legacyFile, 'utf8'))
        expect(raw).toContain('"version":1')
      })
    )
  )

  it.live('unreadable records are skipped', () =>
    withStateHome(stateHome =>
      Effect.gen(function* () {
        const directory = join(stateHome, 'pi', 'sandbox-db', 'leases')
        yield* Effect.promise(async () => {
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'broken.json'), '{')
        })

        expect(yield* allLeases).toEqual([])
      })
    )
  )
})

describe('expiredBeyondGrace', () => {
  it('prunes only records past expiry plus the grace', () => {
    const day = 24 * 60 * 60 * 1000
    const expiresAt = '2026-08-20T20:00:00Z'
    const expires = Date.parse(expiresAt)

    expect(expiredBeyondGrace({ expiresAt }, expires - 1, day)).toBe(false)
    expect(expiredBeyondGrace({ expiresAt }, expires + day, day)).toBe(false)
    expect(expiredBeyondGrace({ expiresAt }, expires + day + 1, day)).toBe(true)
    expect(expiredBeyondGrace({ expiresAt: 'not a date' }, Date.now(), day)).toBe(false)
  })
})
