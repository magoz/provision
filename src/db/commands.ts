import { createHash } from 'node:crypto'
import { Console, Effect, Option, Path, Predicate, Redacted, Result } from 'effect'
import { Command, Flag, Prompt } from 'effect/cli'
import { resolveWorkspace } from '../shared/git.ts'
import { report } from '../shared/output.ts'
import { defaultDatabaseUrlKeys } from '../shared/sandbox-profile.ts'
import { loadConfig } from './config.ts'
import {
  API_KEY_ENV,
  clearSecret,
  readSettings,
  settingsLocation,
  storeSecret,
  writeSettings
} from './credentials.ts'
import { BRANCH_PREFIX, ConfigurationError, PolicyError, type Lease } from './domain.ts'
import {
  allLeases,
  expiredBeyondGrace,
  readLease,
  removeLease,
  withLeaseLock,
  writeLease
} from './lease.ts'
import { describeProject, findDefaultBranch, getBranch, setExpiration } from './neon.ts'
import { attestIfDeclared, createLease, releaseLease, timestamp } from './operations.ts'
import {
  ensureLeaseProfile,
  parseTtl,
  validateDeletionTarget,
  validateLeaseName
} from './policy.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code
  })

/** Expected failures print one line on stderr and exit 2; defects stay defects. */
const handled = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch(error =>
      Console.error(`provision db: ${error.message}`).pipe(Effect.andThen(setExitCode(2)))
    )
  )

/** Identifies which credential is in use without revealing any of it. */
const fingerprint = (secret: Redacted.Redacted<string>) =>
  createHash('sha256').update(Redacted.value(secret)).digest('hex').slice(0, 8)

const readStdin = Effect.promise(async () => {
  const chunks: Array<Uint8Array> = []

  for await (const chunk of process.stdin) {
    if (Predicate.isString(chunk)) chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Uint8Array) chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8').trim()
})

// ---------------------------------------------------------------------------
// shared flags
// ---------------------------------------------------------------------------

const worktreeFlag = Flag.String('worktree').pipe(
  Flag.withDescription('worktree path (default: current directory)'),
  Flag.optional
)

const jsonFlag = Flag.Boolean('json').pipe(
  Flag.withDescription('machine-readable output'),
  Flag.withDefault(false)
)

const ttlFlag = Flag.String('ttl').pipe(
  Flag.withDescription('lifetime such as 12h or 7d (default 7d)'),
  Flag.withDefault('7d')
)

const leaseFlag = Flag.String('lease').pipe(
  Flag.withDescription('lease slot within the worktree (default: default)'),
  Flag.withDefault('default')
)

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

const authLogin = Command.make(
  'login',
  {
    json: jsonFlag,
    projectId: Flag.String('project-id').pipe(
      Flag.withDescription('neon sandbox project id'),
      Flag.optional
    ),
    parentBranch: Flag.String('parent-branch').pipe(
      Flag.withDescription('parent branch id (default: project default branch)'),
      Flag.optional
    ),
    tokenStdin: Flag.Boolean('token-stdin').pipe(
      Flag.withDescription('read the api key from stdin instead of prompting'),
      Flag.withDefault(false)
    )
  },
  ({ json, parentBranch, projectId, tokenStdin }) =>
    handled(
      Effect.gen(function* () {
        const existing = yield* readSettings

        // The credential is Redacted from the moment it is captured.
        const apiKey = tokenStdin
          ? Redacted.make(yield* readStdin)
          : yield* Prompt.run(Prompt.Password({ message: 'Neon API key (input hidden)' })).pipe(
              Effect.mapError(() => new ConfigurationError({ message: 'cancelled' }))
            )

        if (Redacted.value(apiKey).trim().length === 0) {
          return yield* new ConfigurationError({ message: 'no api key provided' })
        }

        const resolvedProject = Option.isSome(projectId)
          ? projectId.value
          : Option.isSome(existing.projectId)
            ? existing.projectId.value
            : yield* Prompt.run(Prompt.String({ message: 'Neon sandbox project id' })).pipe(
                Effect.mapError(() => new ConfigurationError({ message: 'cancelled' }))
              )

        // Validate before persisting anything.
        const access = { apiKey, projectId: resolvedProject }
        const project = yield* describeProject(access)

        const parent = Option.isSome(parentBranch)
          ? parentBranch.value
          : (yield* findDefaultBranch(access)).id

        if (Option.isNone(yield* getBranch(access, parent))) {
          return yield* new ConfigurationError({
            message: `parent branch ${parent} does not exist in project ${resolvedProject}`
          })
        }

        const backend = yield* storeSecret(apiKey)
        yield* writeSettings({ projectId: project.id, parentBranch: parent })

        return yield* report(json, {
          status: 'authenticated',
          backend,
          project: `${project.name} (${project.id})`,
          parent_branch: parent,
          fingerprint: fingerprint(apiKey),
          note: 'credential stored; it is never printed'
        })
      })
    )
).pipe(Command.withDescription('Store a global Neon key and sandbox project.'))

const authStatus = Command.make(
  'status',
  { json: jsonFlag, worktree: worktreeFlag },
  ({ json, worktree }) =>
    handled(
      Effect.gen(function* () {
        const path = yield* Path.Path

        const workspace = Option.isSome(worktree)
          ? Result.succeed(yield* resolveWorkspace(worktree))
          : yield* Effect.result(resolveWorkspace(Option.none()))

        const envFile = path.join(
          Result.isSuccess(workspace) ? workspace.success.root : path.resolve(process.cwd()),
          '.env.local'
        )

        const resolved = yield* Effect.result(loadConfig(envFile))

        if (Result.isFailure(resolved)) {
          yield* report(json, {
            status: 'unauthenticated',
            settings_file: envFile,
            note: resolved.failure.message
          })

          return yield* setExitCode(1)
        }

        const config = resolved.success
        const settingsFile = config.backend === 'worktree-env' ? envFile : yield* settingsLocation

        const verification = yield* Effect.result(
          Effect.gen(function* () {
            const project = yield* describeProject(config)

            if (Option.isNone(yield* getBranch(config, config.parentBranch))) {
              return yield* new ConfigurationError({
                message: `parent branch ${config.parentBranch} does not exist in project ${config.projectId}`
              })
            }

            return project
          })
        )

        if (Result.isFailure(verification)) {
          yield* report(json, {
            status: 'invalid',
            backend: config.backend,
            fingerprint: fingerprint(config.apiKey),
            project: config.projectId,
            parent_branch: `${config.parentBranch} (unverified)`,
            settings_file: settingsFile,
            note: verification.failure.message
          })

          return yield* setExitCode(1)
        }

        yield* report(json, {
          status: 'authenticated',
          backend: config.backend,
          fingerprint: fingerprint(config.apiKey),
          project: `${verification.success.name} (${verification.success.id})`,
          parent_branch: config.parentBranch,
          settings_file: settingsFile
        })
      })
    )
).pipe(Command.withDescription('Show the resolved worktree or global auth.'))

const authLogout = Command.make('logout', { json: jsonFlag }, ({ json }) =>
  handled(
    Effect.gen(function* () {
      const removed = yield* clearSecret

      return yield* report(json, {
        status: removed.length > 0 ? 'cleared' : 'nothing-stored',
        backends: removed.join(', ') || 'none',
        note: `an ${API_KEY_ENV} environment variable or complete worktree .env.local profile, if set, still applies`
      })
    })
  )
).pipe(Command.withDescription('Remove the stored global Neon key.'))

const auth = Command.make('auth').pipe(
  Command.withDescription('Manage global Neon auth and inspect resolved worktree auth.'),
  Command.withSubcommands([authLogin, authStatus, authLogout])
)

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const create = Command.make(
  'create',
  {
    worktree: worktreeFlag,
    json: jsonFlag,
    ttl: ttlFlag,
    label: Flag.String('label').pipe(
      Flag.withDescription('short label, e.g. issue-4'),
      Flag.optional
    ),
    envFile: Flag.String('env-file').pipe(
      Flag.withDescription('env file that receives database URLs'),
      Flag.withDefault('.env.local')
    ),
    configEnvFile: Flag.String('config-env-file').pipe(
      Flag.withDescription(
        'env file containing the sandbox database profile (default: --env-file)'
      ),
      Flag.optional
    ),
    leaseName: leaseFlag,
    keys: Flag.String('keys').pipe(
      Flag.withDescription('comma-separated env keys to write'),
      Flag.withDefault(defaultDatabaseUrlKeys.join(','))
    ),
    forceNew: Flag.Boolean('force-new').pipe(
      Flag.withDescription('ignore any existing lease'),
      Flag.withDefault(false)
    ),
    noWait: Flag.Boolean('no-wait').pipe(
      Flag.withDescription('do not wait for the branch to become ready'),
      Flag.withDefault(false)
    )
  },
  ({ json, ...options }) =>
    handled(Effect.flatMap(createLease(options), result => report(json, result.report)))
).pipe(Command.withDescription('Create or reuse a disposable database branch for a worktree.'))

// ---------------------------------------------------------------------------
// status / renew / release
// ---------------------------------------------------------------------------

const status = Command.make(
  'status',
  { worktree: worktreeFlag, json: jsonFlag, leaseName: leaseFlag },
  ({ json, leaseName, worktree }) =>
    handled(
      Effect.gen(function* () {
        const workspace = yield* resolveWorkspace(worktree)
        const name = yield* validateLeaseName(leaseName)
        const lease = yield* readLease(workspace.root, name)

        if (Option.isNone(lease)) {
          yield* report(json, { status: 'none', lease: name, worktree: workspace.root })

          return yield* setExitCode(1)
        }

        const config = yield* loadConfig(lease.value.configEnvFile)
        yield* ensureLeaseProfile(config, lease.value)
        const branch = yield* getBranch(config, lease.value.branchId)

        yield* report(json, {
          status: Option.isSome(branch) ? 'live' : 'missing',
          // Read-only release eligibility, so callers can check every lease before deleting any.
          // `release` repeats its own guardrails.
          releasable:
            lease.value.branchName.startsWith(BRANCH_PREFIX) &&
            Option.match(branch, {
              onNone: () => true,
              onSome: value => value.default !== true && value.protected !== true
            }),
          lease: lease.value.leaseName,
          branch_name: lease.value.branchName,
          branch_id: lease.value.branchId,
          state: Option.match(branch, {
            onNone: () => 'gone',
            onSome: value => value.current_state ?? 'unknown'
          }),
          expires_at: Option.match(branch, {
            onNone: () => lease.value.expiresAt,
            onSome: value => value.expires_at ?? lease.value.expiresAt
          }),
          repository: lease.value.repository,
          parent_branch: lease.value.parentBranch,
          config_source: config.backend,
          config_env_file: lease.value.configEnvFile,
          env_file: lease.value.envFile,
          worktree: lease.value.worktree
        })

        if (Option.isNone(branch)) yield* setExitCode(1)
      })
    )
).pipe(Command.withDescription('Show a lease and its branch state.'))

const renew = Command.make(
  'renew',
  { worktree: worktreeFlag, json: jsonFlag, leaseName: leaseFlag, ttl: ttlFlag },
  ({ json, leaseName, ttl, worktree }) =>
    handled(
      Effect.gen(function* () {
        const workspace = yield* resolveWorkspace(worktree)
        const name = yield* validateLeaseName(leaseName)

        return yield* withLeaseLock(
          workspace.root,
          name,
          Effect.gen(function* () {
            const lease = yield* readLease(workspace.root, name)

            if (Option.isNone(lease)) {
              return yield* new PolicyError({
                message: `no ${name} lease recorded for ${workspace.root}`
              })
            }

            const config = yield* loadConfig(lease.value.configEnvFile)
            yield* ensureLeaseProfile(config, lease.value)
            yield* attestIfDeclared(config, workspace)
            const ttlSeconds = yield* parseTtl(ttl)
            const recorded = yield* getBranch(config, lease.value.branchId)

            if (Option.isNone(recorded)) {
              return yield* new PolicyError({
                message: `recorded branch ${lease.value.branchId} no longer exists`
              })
            }

            yield* validateDeletionTarget(lease.value, recorded.value)
            const expiresAt = timestamp(ttlSeconds)
            yield* setExpiration(config, lease.value, expiresAt)
            const updated: Lease = { ...lease.value, expiresAt }
            yield* writeLease(updated)

            return yield* report(json, {
              status: 'renewed',
              lease: updated.leaseName,
              branch_name: updated.branchName,
              branch_id: updated.branchId,
              expires_at: updated.expiresAt
            })
          })
        )
      })
    )
).pipe(Command.withDescription("Extend a lease's TTL."))

const release = Command.make(
  'release',
  {
    worktree: worktreeFlag,
    json: jsonFlag,
    leaseName: leaseFlag,
    keepEnv: Flag.Boolean('keep-env').pipe(
      Flag.withDescription('leave env keys in place'),
      Flag.withDefault(false)
    )
  },
  ({ json, keepEnv, leaseName, worktree }) =>
    handled(
      Effect.flatMap(releaseLease({ worktree, leaseName, keepEnv }), payload =>
        report(json, payload)
      )
    )
).pipe(Command.withDescription('Delete a lease branch and remove its env keys.'))

// ---------------------------------------------------------------------------
// list / gc
// ---------------------------------------------------------------------------

const list = Command.make('list', { json: jsonFlag }, ({ json }) =>
  handled(
    Effect.gen(function* () {
      const leases = yield* allLeases

      if (json) return yield* Console.log(JSON.stringify(leases, null, 2))

      if (leases.length === 0) return yield* Console.log('no leases')

      return yield* Console.log(
        leases
          .map(
            lease =>
              `${lease.leaseName}  ${lease.branchName}  ${lease.expiresAt}  ${lease.worktree}`
          )
          .join('\n')
      )
    })
  )
).pipe(Command.withDescription('List local lease records.'))

/** `gc --prune-expired`: how long past its expiry a record must be before it is pruned blind. */
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000

const gc = Command.make(
  'gc',
  {
    json: jsonFlag,
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('report without removing lease records'),
      Flag.withDefault(false)
    ),
    pruneExpired: Flag.Boolean('prune-expired').pipe(
      Flag.withDescription(
        'also remove records whose expiry passed over a day ago, without Neon credentials (Neon already deleted those branches)'
      ),
      Flag.withDefault(false)
    )
  },
  ({ dryRun, json, pruneExpired }) =>
    handled(
      Effect.gen(function* () {
        const leases = yield* allLeases
        const stale: Array<string> = []
        const expired: Array<string> = []
        const inaccessible: Array<string> = []
        let live = 0
        const now = Date.now()

        for (const lease of leases) {
          if (pruneExpired && expiredBeyondGrace(lease, now, EXPIRED_GRACE_MS)) {
            expired.push(lease.branchName)

            if (!dryRun) yield* removeLease(lease.worktree, lease.leaseName)
            continue
          }

          const resolved = yield* Effect.result(loadConfig(lease.configEnvFile))

          if (
            Result.isFailure(resolved) ||
            resolved.success.projectId !== lease.projectId ||
            resolved.success.parentBranch !== lease.parentBranch
          ) {
            inaccessible.push(lease.branchName)
            continue
          }

          const lookedUp = yield* Effect.result(getBranch(resolved.success, lease.branchId))

          if (Result.isFailure(lookedUp)) {
            inaccessible.push(lease.branchName)
            continue
          }

          if (Option.isSome(lookedUp.success)) {
            live += 1
            continue
          }

          stale.push(lease.branchName)

          if (!dryRun) yield* removeLease(lease.worktree, lease.leaseName)
        }

        yield* report(json, {
          status: inaccessible.length > 0 ? 'partial' : dryRun ? 'dry-run' : 'pruned',
          live_leases: live,
          stale_leases: stale.length,
          expired_leases: expired.length,
          inaccessible_leases: inaccessible.length,
          pruned: [...stale, ...expired].join(', ') || 'none',
          inaccessible: inaccessible.join(', ') || 'none'
        })

        // With --prune-expired every remaining unverifiable record expires within the TTL cap and
        // is pruned by a later run, so it is reported but does not fail the run (daily timer).
        if (inaccessible.length > 0 && !pruneExpired) yield* setExitCode(1)
      })
    )
).pipe(Command.withDescription('Prune lease records whose branches are gone.'))

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

export const dbCommand = Command.make('db').pipe(
  Command.withDescription('Manage disposable Neon database branches for local checkouts.'),
  Command.withSubcommands([auth, create, status, renew, release, list, gc])
)
