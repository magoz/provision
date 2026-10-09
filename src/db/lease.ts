import { createHash, randomBytes } from 'node:crypto'
import { Cause, Effect, Exit, FileSystem, Option, Path, Schema } from 'effect'
import {
  LeaseError,
  LeaseFromJson,
  LeaseRecordFromJson,
  LifecycleError,
  normalizeLease,
  type Lease
} from './domain.ts'
import { DbEnvironment } from './environment.ts'

const leaseDirectory = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const directory = path.join((yield* DbEnvironment).stateDirectory, 'leases')
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(
      Effect.mapError(
        cause => new LeaseError({ message: `lease directory unavailable: ${cause.message}` })
      )
    )

  return directory
})

/** The `default` slot keeps the original single-lease identity so old records stay readable. */
const leaseIdentity = (worktree: string, leaseName: string) =>
  leaseName === 'default' ? worktree : JSON.stringify([worktree, leaseName])

const leaseDigest = (worktree: string, leaseName: string) =>
  createHash('sha256').update(leaseIdentity(worktree, leaseName)).digest('hex').slice(0, 16)

const leaseFile = (worktree: string, leaseName: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path

    return path.join(yield* leaseDirectory, `${leaseDigest(worktree, leaseName)}.json`)
  })

export const acquireLeaseLock = (worktree: string, leaseName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const locks = path.join((yield* DbEnvironment).stateDirectory, 'locks')
    yield* fs
      .makeDirectory(locks, { recursive: true })
      .pipe(
        Effect.mapError(
          () => new LeaseError({ message: `lease lock directory unavailable: ${locks}` })
        )
      )
    const lock = path.join(locks, `${leaseDigest(worktree, leaseName)}.lock`)
    yield* fs.makeDirectory(lock).pipe(
      Effect.mapError(
        () =>
          new LeaseError({
            message:
              `another provision db operation owns lease slot ${leaseName}; ` +
              `if none is running, remove stale lock ${lock}; branch TTL remains the cleanup backstop`
          })
      )
    )

    return lock
  })

export const releaseLeaseLock = (lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs
      .remove(lock, { recursive: true })
      .pipe(Effect.mapError(() => new LeaseError({ message: `cannot release lease lock ${lock}` })))
  })

const replayExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)

const isUnexpected = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterrupts(cause) || Cause.hasDies(cause)

/**
 * Runs `operation` while holding a lease lock. A lock-release failure surfaces on its own, never
 * replaces a lone operation failure, and never turns a defect or interruption into a typed error.
 */
export const withLeaseLockUsing = <A, E, RAcquire, RRelease, ROperation>(
  acquire: Effect.Effect<string, LeaseError, RAcquire>,
  release: (lock: string) => Effect.Effect<void, LeaseError, RRelease>,
  operation: Effect.Effect<A, E, ROperation>
) =>
  Effect.suspend(() => {
    let releaseExit: Exit.Exit<void, LeaseError> | undefined

    return Effect.acquireUseRelease(
      acquire,
      () => operation,
      lock =>
        Effect.exit(release(lock)).pipe(
          Effect.tap(exit =>
            Effect.sync(() => {
              releaseExit = exit
            })
          ),
          Effect.asVoid
        )
    ).pipe(
      Effect.exit,
      Effect.flatMap((operationExit): Effect.Effect<A, E | LeaseError | LifecycleError> => {
        if (releaseExit === undefined || Exit.isSuccess(releaseExit)) {
          return replayExit(operationExit)
        }

        if (Exit.isSuccess(operationExit)) return Effect.failCause(releaseExit.cause)

        if (isUnexpected(operationExit.cause)) return replayExit(operationExit)

        if (isUnexpected(releaseExit.cause)) return Effect.failCause(releaseExit.cause)

        if (
          Option.isSome(Cause.findErrorOption(operationExit.cause)) &&
          Option.isSome(Cause.findErrorOption(releaseExit.cause))
        ) {
          return Effect.fail(
            new LifecycleError({ message: 'sandbox operation and lease lock cleanup both failed' })
          )
        }

        return replayExit(operationExit)
      })
    )
  })

export const withLeaseLock = <A, E, R>(
  worktree: string,
  leaseName: string,
  operation: Effect.Effect<A, E, R>
) => withLeaseLockUsing(acquireLeaseLock(worktree, leaseName), releaseLeaseLock, operation)

const decodeLease = (content: string) =>
  Schema.decodeUnknownOption(LeaseRecordFromJson)(content).pipe(Option.map(normalizeLease))

export const readLease = (worktree: string, leaseName = 'default') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* leaseFile(worktree, leaseName)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    if (!exists) return Option.none<Lease>()
    const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ''))

    return decodeLease(content).pipe(Option.filter(lease => lease.leaseName === leaseName))
  })

export const writeLease = (lease: Lease) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* leaseFile(lease.worktree, lease.leaseName)
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`

    const content = yield* Schema.encodeEffect(LeaseFromJson)(lease).pipe(
      Effect.mapError(
        cause => new LeaseError({ message: `lease encoding failed: ${cause.message}` })
      )
    )

    yield* fs.writeFileString(temporary, `${content}\n`, { mode: 0o600 }).pipe(
      Effect.andThen(fs.chmod(temporary, 0o600)),
      Effect.andThen(fs.rename(temporary, file)),
      Effect.mapError(cause => new LeaseError({ message: `lease write failed: ${cause.message}` }))
    )
  })

export const removeLease = (worktree: string, leaseName = 'default') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* leaseFile(worktree, leaseName)

    const exists = yield* fs
      .exists(file)
      .pipe(
        Effect.mapError(() => new LeaseError({ message: 'cannot inspect lease cleanup target' }))
      )

    if (!exists) return
    yield* fs
      .remove(file)
      .pipe(Effect.mapError(() => new LeaseError({ message: 'cannot remove lease record' })))

    const remains = yield* fs
      .exists(file)
      .pipe(
        Effect.mapError(() => new LeaseError({ message: 'cannot confirm lease record cleanup' }))
      )

    if (remains) {
      return yield* new LeaseError({ message: 'lease record cleanup could not be confirmed' })
    }
  })

export const allLeases = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* leaseDirectory

  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

  const leases: Array<Lease> = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue

    const content = yield* fs
      .readFileString(path.join(directory, entry))
      .pipe(Effect.orElseSucceed(() => ''))

    const decoded = decodeLease(content)

    if (Option.isSome(decoded)) leases.push(decoded.value)
  }

  return leases.toSorted(
    (a, b) => a.worktree.localeCompare(b.worktree) || a.leaseName.localeCompare(b.leaseName)
  )
})

/**
 * Whether a record's expiry passed more than `graceMs` ago. Every branch is created with a Neon
 * `expires_at`, so Neon has already deleted such a branch and the record can be pruned without
 * credentials.
 */
export const expiredBeyondGrace = (
  lease: Pick<Lease, 'expiresAt'>,
  now: number,
  graceMs: number
) => {
  const expires = Date.parse(lease.expiresAt)

  return Number.isFinite(expires) && expires + graceMs < now
}
