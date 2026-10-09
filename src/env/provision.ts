import { Cause, Console, Effect, Exit, FileSystem, Option, Path } from 'effect'
import { Prompt } from 'effect/cli'
import type { Lease } from '../db/domain.ts'
import { readLease, writeLease } from '../db/lease.ts'
import { createLease, releaseLease } from '../db/operations.ts'
import { gitOutput } from '../shared/git.ts'
import { readPrivately, writePrivately } from '../shared/private-file.ts'
import { inherit } from '../shared/process.ts'
import { readRepoConfig } from '../shared/repo-config.ts'
import { defaultDatabaseUrlKeys } from '../shared/sandbox-profile.ts'
import { fail, type EnvConflictPolicy, type EnvError, type EnvOptions } from './domain.ts'
import { installDependencies } from './install.ts'
import {
  ensureLocalDirectory,
  ensurePrivateMode,
  ensureProvisionPaths,
  ensureSecretPath,
  resolveAppDirectory,
  resolveCheckout
} from './paths.ts'
import {
  ensureNoLocalResetConsent,
  keepExistingDatabaseUrls,
  stripPulledEnvironment
} from './sanitize.ts'
import {
  ensureVercelLink,
  listExplicitVercelKeys,
  pullVercelEnvironment,
  readVercelIdentity
} from './vercel.ts'

type LeaseSlot = 'default' | 'test'

/** What this invocation created or replaced, so a failed run can restore the previous state. */
interface RollbackState {
  createdLocalEnv: boolean
  createdTestEnv: boolean
  createdVercelLink: boolean
  defaultLeaseBefore?: Option.Option<Lease>
  testLeaseBefore?: Option.Option<Lease>
  localEnvSnapshot?: string | undefined
  testEnvSnapshot?: string | undefined
  localPullTemporary?: string | undefined
  testPullTemporary?: string | undefined
}

const io =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, () => fail(message))

const resolveEnvConflict = (
  policy: EnvConflictPolicy,
  nonInteractive: boolean,
  localExists: boolean,
  testExists: boolean
) =>
  Effect.gen(function* () {
    if (!localExists && !testExists) return 'overwrite' as const

    const existing = [localExists ? '.env.local' : undefined, testExists ? '.env.test' : undefined]
      .filter(file => file !== undefined)
      .join(' and ')

    const bothExist = localExists && testExists
    const existence = bothExist ? 'already exist' : 'already exists'

    if (policy === 'error') {
      return yield* fail(
        `${existing} ${existence}; use --env-conflict=preserve or --env-conflict=overwrite`
      )
    }

    if (policy === 'preserve') {
      if (!bothExist) {
        return yield* fail(
          `cannot preserve a partial env pair (${existing}); use --env-conflict=overwrite or restore both files`
        )
      }

      return 'preserve' as const
    }

    if (policy === 'overwrite') return 'overwrite' as const

    if (nonInteractive || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      return yield* fail(
        `${existing} ${existence} and prompting is unavailable; pass --env-conflict=preserve or --env-conflict=overwrite explicitly`
      )
    }

    const decision = yield* Prompt.run(
      Prompt.Select({
        message: `${existing} ${existence}. How should provision env continue?`,
        choices: [
          {
            title: 'Preserve existing env files',
            value: 'preserve' as const,
            description: 'Skip both Vercel pulls and continue with the existing files',
            disabled: !bothExist
          },
          {
            title: 'Overwrite from Vercel',
            value: 'overwrite' as const,
            description: 'Snapshot both files, pull fresh values, and restore them if setup fails'
          },
          {
            title: 'Cancel',
            value: 'cancel' as const,
            description: 'Exit without changing env files or database leases'
          }
        ]
      })
    ).pipe(Effect.mapError(() => fail('cancelled by user')))

    if (decision === 'cancel') return yield* fail('cancelled by user')

    return decision
  })

const ensureEnvUnchanged = (file: string, existed: boolean, snapshot: string | undefined) =>
  Effect.gen(function* () {
    const current = yield* readPrivately(file).pipe(io(`cannot revalidate ${file}`))

    if ((current !== undefined) !== existed || (current !== undefined && current !== snapshot)) {
      return yield* fail(`${file} changed while provisioning; refusing to overwrite it`)
    }
  })

const replayExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)

const isUnexpected = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterrupts(cause) || Cause.hasDies(cause)

/**
 * Holds the checkout lock around `operation`; on failure runs `rollback` before releasing the
 * lock. Cleanup problems never hide the original cause, and defects or interruption are never
 * normalized into typed errors.
 */
export const withProvisionLifecycleUsing = <A, E, RAcquire, ROperation, RRollback, RRelease>(
  acquire: Effect.Effect<string, EnvError, RAcquire>,
  operation: Effect.Effect<A, E, ROperation>,
  rollback: Effect.Effect<void, EnvError, RRollback>,
  release: (lock: string) => Effect.Effect<void, EnvError, RRelease>
) =>
  Effect.suspend(() => {
    let rollbackExit: Exit.Exit<void, EnvError> | undefined
    let releaseExit: Exit.Exit<void, EnvError> | undefined

    return Effect.acquireUseRelease(
      acquire,
      () => operation,
      (lock, operationExit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(operationExit)) rollbackExit = yield* Effect.exit(rollback)
          releaseExit = yield* Effect.exit(release(lock))
        })
    ).pipe(
      Effect.exit,
      Effect.flatMap((operationExit): Effect.Effect<A, E | EnvError> => {
        const cleanupExits = [rollbackExit, releaseExit].filter(exit => exit !== undefined)
        const failedCleanup = cleanupExits.find(Exit.isFailure)

        if (failedCleanup === undefined) return replayExit(operationExit)

        if (Exit.isSuccess(operationExit)) return Effect.failCause(failedCleanup.cause)

        if (isUnexpected(operationExit.cause)) return replayExit(operationExit)

        const unexpectedCleanup = cleanupExits.find(
          exit => Exit.isFailure(exit) && isUnexpected(exit.cause)
        )

        if (unexpectedCleanup !== undefined && Exit.isFailure(unexpectedCleanup)) {
          return Effect.failCause(unexpectedCleanup.cause)
        }

        if (
          Option.isSome(Cause.findErrorOption(operationExit.cause)) &&
          Option.isSome(Cause.findErrorOption(failedCleanup.cause))
        ) {
          return Effect.fail(
            fail('setup failed and lifecycle cleanup also failed; manual review is required')
          )
        }

        return Effect.failCause(failedCleanup.cause)
      })
    )
  })

/** Release only a lease this invocation created, and restore the record it replaced. */
const rollBackLease = (repo: string, slot: LeaseSlot, before: Option.Option<Lease> | undefined) =>
  Effect.gen(function* () {
    if (before === undefined) return
    const current = yield* readLease(repo, slot)

    const createdHere =
      Option.isSome(current) &&
      (Option.isNone(before) || current.value.branchId !== before.value.branchId)

    if (createdHere) {
      yield* releaseLease({ worktree: Option.some(repo), leaseName: slot, keepEnv: true })

      if (Option.isSome(before)) yield* writeLease(before.value)
    } else if (Option.isNone(current) && Option.isSome(before)) {
      yield* writeLease(before.value)
    }
  })

/** Restores a file to its snapshot, or removes it when it did not exist before. */
const restoreFile = (file: string, label: string, snapshot: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if (snapshot === undefined) yield* fs.remove(file, { force: true })
    else yield* writePrivately(file, snapshot)

    yield* Console.error(`provision env: restored ${label} after setup failure`)
  })

/** Runs repository-declared setup commands from the checkout root through the user's shell. */
export const runSetup = (repo: string, commands: ReadonlyArray<string>) =>
  Effect.forEach(
    commands,
    command =>
      Console.log(`provision env: setup: ${command}`).pipe(
        Effect.andThen(inherit(process.env.SHELL ?? '/bin/sh', ['-lc', command], { cwd: repo })),
        Effect.mapError(error => fail(`setup command failed (${error.message}): ${command}`))
      ),
    { discard: true }
  )

export const provisionEnvironment = (options: EnvOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const repo = yield* resolveCheckout(options.repo)

    // Read and validate repository configuration (including setup) before any mutation.
    const config = yield* readRepoConfig(repo).pipe(Effect.mapError(error => fail(error.message)))

    const { appDir, directory } = yield* resolveAppDirectory(repo, options.appDir ?? config.appDir)
    const vercelLinkRelative = path.join(appDir, '.vercel', 'project.json')

    // Preflight for callers about to create a worktree: validate or reuse a local link only.
    if (options.checkVercelLink) {
      yield* ensureProvisionPaths(directory, ['.vercel/project.json'])
      yield* ensureSecretPath(repo, vercelLinkRelative)
      yield* ensureVercelLink({
        directory,
        appDir,
        checkout: repo,
        source: options.source,
        vercelProject: undefined
      })
      yield* readVercelIdentity(path.join(directory, '.vercel', 'project.json'))

      return
    }

    const localRelative = path.join(appDir, '.env.local')
    const testRelative = path.join(appDir, '.env.test')
    const localEnvFile = path.join(directory, '.env.local')
    const testEnvFile = path.join(directory, '.env.test')
    const vercelDirectory = path.join(directory, '.vercel')
    const lockPath = yield* gitOutput(repo, ['rev-parse', '--git-path', 'provision-env.lock'])

    if (Option.isNone(lockPath)) return yield* fail('cannot resolve the checkout lock path')

    const lockDirectory = path.resolve(repo, lockPath.value)

    const acquireLock = fs.makeDirectory(lockDirectory).pipe(
      Effect.mapError(() =>
        fail(
          `another provision env process is already using ${repo}; if none is running, remove stale lock ${lockDirectory}`
        )
      ),
      Effect.as(lockDirectory)
    )

    const state: RollbackState = {
      createdLocalEnv: false,
      createdTestEnv: false,
      createdVercelLink: false
    }

    const createDatabaseLease = (slot: LeaseSlot, envRelative: string, label: string) =>
      Effect.gen(function* () {
        const result = yield* createLease({
          worktree: Option.some(repo),
          ttl: options.ttl,
          label: Option.some(label),
          envFile: envRelative,
          configEnvFile: Option.some(localRelative),
          leaseName: slot,
          keys: defaultDatabaseUrlKeys.join(','),
          forceNew: false,
          noWait: false
        })

        yield* Console.log(
          `provision env: ${result.status} ${slot} lease ${result.lease.branchName} (${result.lease.branchId})`
        )
      })

    const pullEnvironments = (localExists: boolean, testExists: boolean) =>
      Effect.gen(function* () {
        state.createdVercelLink = yield* ensureVercelLink({
          directory,
          appDir,
          checkout: repo,
          source: options.source,
          vercelProject: options.vercelProject
        })

        yield* ensureLocalDirectory(vercelDirectory, 'checkout .vercel path')
        yield* fs.chmod(vercelDirectory, 0o700).pipe(io('cannot protect Vercel staging directory'))
        yield* ensurePrivateMode(vercelDirectory, 0o700, 'Vercel staging directory')

        const stage = (name: string) => path.join(vercelDirectory, `${name}.provision-env.tmp`)
        const localStage = stage('.env.local')
        const testStage = stage('.env.test')
        state.localPullTemporary = localStage
        state.testPullTemporary = testStage

        for (const file of [localStage, testStage]) {
          yield* fs.remove(file, { force: true }).pipe(io(`cannot clear staging path ${file}`))
          yield* writePrivately(file, '').pipe(io(`cannot create staging file ${file}`))
          yield* ensurePrivateMode(file, 0o600, 'staging file')
        }

        const developmentKeys = yield* listExplicitVercelKeys(directory, 'development')
        const testKeys = yield* listExplicitVercelKeys(directory, options.testEnvironment)

        const pull = (
          stageFile: string,
          environment: string,
          label: string,
          explicitKeys: ReadonlySet<string>,
          snapshot: string | undefined,
          removeResetConsent: boolean
        ) =>
          Effect.gen(function* () {
            yield* Console.log(
              `provision env: pulling Vercel ${environment} variables into ${label}`
            )
            yield* pullVercelEnvironment(directory, stageFile, environment)

            const pulled = yield* readPrivately(stageFile).pipe(
              io(`cannot inspect pulled ${environment} environment`)
            )

            const sanitized = stripPulledEnvironment(pulled ?? '', {
              explicitKeys,
              replaceDatabaseUrls: options.database,
              removeResetConsent
            })

            const content =
              options.database || snapshot === undefined
                ? sanitized.content
                : keepExistingDatabaseUrls(sanitized.content, snapshot)

            if (content !== pulled) {
              yield* writePrivately(stageFile, content).pipe(
                io(`cannot sanitize pulled ${environment} environment`)
              )
            }

            yield* ensurePrivateMode(stageFile, 0o600, `pulled ${environment} environment`)

            if (sanitized.metadataRemoved > 0) {
              yield* Console.log(
                `provision env: removed ${sanitized.metadataRemoved} deployment-only variables from ${environment}`
              )
            }

            if (sanitized.databaseUrlsRemoved > 0) {
              yield* Console.log(
                `provision env: removed ${sanitized.databaseUrlsRemoved} Vercel database variables from ${environment}`
              )
            }
          })

        yield* pull(
          localStage,
          'development',
          '.env.local',
          developmentKeys,
          state.localEnvSnapshot,
          true
        )
        yield* pull(
          testStage,
          options.testEnvironment,
          '.env.test',
          testKeys,
          state.testEnvSnapshot,
          false
        )

        yield* ensureEnvUnchanged(localEnvFile, localExists, state.localEnvSnapshot)
        yield* ensureEnvUnchanged(testEnvFile, testExists, state.testEnvSnapshot)

        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* fs.rename(localStage, localEnvFile).pipe(io('cannot publish .env.local'))
            state.localPullTemporary = undefined
            state.createdLocalEnv = true
            yield* fs.rename(testStage, testEnvFile).pipe(io('cannot publish .env.test'))
            state.testPullTemporary = undefined
            state.createdTestEnv = true
          })
        )
      })

    const operation = Effect.gen(function* () {
      if (!options.skipVercel || options.database) {
        yield* ensureProvisionPaths(directory, ['.env.local', '.env.test', '.vercel/project.json'])
        yield* ensureSecretPath(repo, localRelative)
        yield* ensureSecretPath(repo, testRelative)
      }

      const localBefore = yield* readPrivately(localEnvFile).pipe(io('cannot read .env.local'))
      const testBefore = yield* readPrivately(testEnvFile).pipe(io('cannot read .env.test'))
      const localExists = localBefore !== undefined
      const testExists = testBefore !== undefined

      const decision = options.skipVercel
        ? 'preserve'
        : yield* resolveEnvConflict(
            options.envConflict,
            options.nonInteractive,
            localExists,
            testExists
          )

      const pullVercel = !options.skipVercel && decision === 'overwrite'
      state.localEnvSnapshot = localBefore
      state.testEnvSnapshot = testBefore

      if (!options.skipInstall) yield* installDependencies(repo)

      if (pullVercel) yield* pullEnvironments(localExists, testExists)

      const currentLocal = yield* readPrivately(localEnvFile).pipe(io('cannot read .env.local'))
      yield* ensureNoLocalResetConsent(currentLocal ?? '')

      if (options.database) {
        const label =
          options.label ??
          Option.getOrElse(
            Option.filter(
              yield* gitOutput(repo, ['branch', '--show-current']),
              branch => branch !== ''
            ),
            () => path.basename(repo)
          )

        yield* Console.log('provision env: allocating isolated development PostgreSQL')
        state.defaultLeaseBefore = yield* readLease(repo, 'default').pipe(io('cannot read lease'))
        state.createdLocalEnv = true
        yield* createDatabaseLease('default', localRelative, `${label}-development`)

        yield* Console.log('provision env: allocating isolated test PostgreSQL')
        state.testLeaseBefore = yield* readLease(repo, 'test').pipe(io('cannot read lease'))
        state.createdTestEnv = true
        yield* createDatabaseLease('test', testRelative, `${label}-test`)
      }

      return pullVercel
    })

    const rollback = Effect.gen(function* () {
      const failures: Array<string> = []

      const attempt = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.sync(() => {
                failures.push(label)
              }),
            onSuccess: () => Effect.void
          })
        )

      yield* attempt(
        'cannot release test lease',
        rollBackLease(repo, 'test', state.testLeaseBefore)
      )
      yield* attempt(
        'cannot release default lease',
        rollBackLease(repo, 'default', state.defaultLeaseBefore)
      )

      if (state.createdTestEnv) {
        yield* attempt(
          'cannot restore .env.test',
          restoreFile(testEnvFile, '.env.test', state.testEnvSnapshot)
        )
      }

      if (state.createdLocalEnv) {
        yield* attempt(
          'cannot restore .env.local',
          restoreFile(localEnvFile, '.env.local', state.localEnvSnapshot)
        )
      }

      for (const temporary of [state.testPullTemporary, state.localPullTemporary]) {
        if (temporary !== undefined) {
          yield* attempt(
            `cannot remove staged environment ${temporary}`,
            fs.remove(temporary, { force: true })
          )
        }
      }

      if (state.createdVercelLink) {
        yield* attempt(
          'cannot remove invocation-created Vercel project identity',
          fs.remove(path.join(vercelDirectory, 'project.json'), { force: true })
        )
      }

      if (failures.length > 0) {
        return yield* fail(`rollback could not complete: ${failures.join('; ')}`)
      }
    })

    const pulled = yield* withProvisionLifecycleUsing(acquireLock, operation, rollback, lock =>
      fs.remove(lock, { recursive: true }).pipe(io(`cannot release provision lock ${lock}`))
    )

    // Setup runs after the lock is released and never rolls back provisioned env or databases:
    // they are valid, and setup commands are idempotent, so a re-run resumes.
    const runsSetup = !options.skipSetup && (!options.skipVercel || options.database)

    if (runsSetup) yield* runSetup(repo, config.setup)

    yield* Console.log(
      [
        '',
        'provision env: ready',
        `  repo:       ${repo}`,
        `  app:        ${directory}`,
        `  install:    ${options.skipInstall ? 'skipped' : 'complete'}`,
        `  vercel env: ${pulled ? '.env.local + .env.test' : options.skipVercel ? 'skipped' : 'preserved'}`,
        `  databases:  ${options.database ? 'development + test ready' : 'skipped'}`,
        `  setup:      ${runsSetup ? `${config.setup.length} command(s)` : 'skipped'}`
      ].join('\n')
    )
  })
