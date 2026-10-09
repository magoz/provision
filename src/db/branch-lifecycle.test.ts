import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from '@effect/vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Option } from 'effect'
import { dbTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { withBranchLifecycleUsing } from './branch-lifecycle.ts'
import { LeaseError, type Lease } from './domain.ts'
import { readLease, removeLease, withLeaseLockUsing, writeLease } from './lease.ts'

it.live('cleans after defects and replays the original defect', () =>
  Effect.gen(function* () {
    const defect = { sentinel: 'direct-branch-defect' }
    let cleaned = false

    const exit = yield* Effect.exit(
      withBranchLifecycleUsing(
        Effect.succeed({ branchId: 'branch-new' }),
        () => Effect.die(defect),
        () =>
          Effect.sync(() => {
            cleaned = true
          })
      )
    )

    expect(cleaned).toBe(true)
    expect(
      Exit.isFailure(exit) && Option.getOrUndefined(Option.getSuccess(Cause.findDefect(exit.cause)))
    ).toBe(defect)
  })
)

it.live('reports unverified cleanup after a typed failure', () =>
  Effect.gen(function* () {
    const failure = yield* withBranchLifecycleUsing(
      Effect.succeed('branch'),
      () => Effect.fail(new LeaseError({ message: 'use failed' })),
      () => Effect.fail(new LeaseError({ message: 'cleanup failed' }))
    ).pipe(Effect.flip)

    expect(failure.message).toContain('cleanup could not be fully verified')
  })
)

it.live('interruption after env and lease writes restores all owned state and the lock', () =>
  Effect.gen(function* () {
    const repo = yield* temporaryDirectory('provision-db-lifecycle')
    const stateHome = yield* temporaryDirectory('provision-db-state')
    const configHome = yield* temporaryDirectory('provision-db-config')
    const envFile = join(repo, '.env.local')
    const before = 'SETTING=before\n'
    yield* Effect.promise(() => writeFile(envFile, before, { mode: 0o600 }))

    const lease: Lease = {
      version: 2,
      leaseName: 'default',
      projectId: 'project',
      parentBranch: 'parent',
      branchId: 'branch-new',
      branchName: 'agent/repo-new',
      worktree: repo,
      repository: 'owner/repo',
      label: 'new',
      configEnvFile: envFile,
      envFile,
      envKeys: ['DATABASE_URL'],
      createdAt: '2026-08-13T20:00:00Z',
      expiresAt: '2026-08-20T20:00:00Z'
    }

    let branchDeleted = false
    let lockReleased = false
    const writesComplete = yield* Deferred.make<void>()

    const program = withLeaseLockUsing(
      Effect.succeed('lock'),
      () =>
        Effect.sync(() => {
          lockReleased = true
        }),
      withBranchLifecycleUsing(
        Effect.succeed({ branchId: lease.branchId }),
        () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => writeFile(envFile, 'DATABASE_URL=secret\n'))
            yield* writeLease(lease)
            yield* Deferred.succeed(writesComplete, undefined)

            return yield* Effect.never
          }),
        acquired =>
          Effect.gen(function* () {
            if (acquired.branchId !== lease.branchId) {
              return yield* new LeaseError({ message: 'identity mismatch' })
            }

            branchDeleted = true
            yield* Effect.promise(() => writeFile(envFile, before, { mode: 0o600 }))
            yield* removeLease(repo)
          })
      )
    )

    const layer = dbTestLayer({ configHome, stateHome })
    const fiber = yield* Effect.forkChild(program.pipe(Effect.provide(layer)))
    yield* Deferred.await(writesComplete)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(branchDeleted).toBe(true)
    expect(lockReleased).toBe(true)
    expect(yield* Effect.promise(() => readFile(envFile, 'utf8'))).toBe(before)
    expect(Option.isNone(yield* readLease(repo).pipe(Effect.provide(layer)))).toBe(true)
  })
)
