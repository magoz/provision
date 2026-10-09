import { randomBytes } from 'node:crypto'
import { Console, Effect, FileSystem, Option, Path } from 'effect'
import { envKeyPattern, removeEnvKeys, writeEnvKeys } from '../shared/env-file.ts'
import { ensureIgnored, resolveWorkspace, type Workspace } from '../shared/git.ts'
import type { ReportValue } from '../shared/output.ts'
import { readPrivately, writePrivately } from '../shared/private-file.ts'
import { readRepoConfig } from '../shared/repo-config.ts'
import { sandboxProfileKeys } from '../shared/sandbox-profile.ts'
import { withBranchLifecycleUsing } from './branch-lifecycle.ts'
import { loadConfig, type SandboxConfig } from './config.ts'
import { BRANCH_PREFIX, LifecycleError, NeonError, PolicyError, type Lease } from './domain.ts'
import { readLease, removeLease, withLeaseLock, writeLease } from './lease.ts'
import {
  attestSandboxProfile,
  createBranch,
  deleteVerifiedBranch,
  getBranch,
  getConnectionUris,
  setExpiration,
  waitUntilReady,
  type CreatedBranch
} from './neon.ts'
import {
  ensureLeaseProfile,
  parseTtl,
  validateDeletionTarget,
  validateLeaseName
} from './policy.ts'

export const timestamp = (offsetSeconds = 0) =>
  new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'worktree'

const reservedKeys = new Set<string>(sandboxProfileKeys)

const urlFor = (key: string, connection: Pick<CreatedBranch, 'direct' | 'pooled'>) =>
  key.toUpperCase().endsWith('UNPOOLED') ? connection.direct : connection.pooled

export type LeaseReport = Readonly<Record<string, ReportValue>>

export interface CreateLeaseResult {
  readonly status: 'created' | 'reused'
  readonly lease: Lease
  readonly report: LeaseReport
}

/**
 * Repositories that declare `provision.factory.neon.sandboxParent: "empty-baseline"` get their
 * profile attested against the factory-created project and baseline before any mutation.
 */
export const attestIfDeclared = (config: SandboxConfig, workspace: Workspace) =>
  Effect.gen(function* () {
    const repo = yield* readRepoConfig(workspace.root)

    if (repo.factory.neon.sandboxParent === 'empty-baseline') {
      yield* attestSandboxProfile(config, workspace.repository)
    }
  })

export const parseEnvKeys = (keys: string) =>
  Effect.gen(function* () {
    const envKeys = keys
      .split(',')
      .map(key => key.trim())
      .filter(key => key.length > 0)

    if (envKeys.length === 0) {
      return yield* new PolicyError({ message: '--keys must name at least one variable' })
    }

    const invalid = envKeys.filter(key => !envKeyPattern.test(key))

    if (invalid.length > 0) {
      return yield* new PolicyError({
        message: `--keys contains invalid environment names: ${invalid.join(', ')}`
      })
    }

    const duplicates = envKeys.filter((key, index) => envKeys.indexOf(key) !== index)

    if (duplicates.length > 0) {
      return yield* new PolicyError({
        message: `--keys contains duplicates: ${[...new Set(duplicates)].join(', ')}`
      })
    }

    const reserved = envKeys.filter(key => reservedKeys.has(key))

    if (reserved.length > 0) {
      return yield* new PolicyError({
        message: `--keys cannot overwrite sandbox configuration: ${reserved.join(', ')}`
      })
    }

    return envKeys
  })

export interface CreateLeaseOptions {
  readonly worktree: Option.Option<string>
  readonly ttl: string
  readonly label: Option.Option<string>
  /** Checkout-relative or absolute env file that receives the database URLs. */
  readonly envFile: string
  /** Env file holding the sandbox profile (default: `envFile`). */
  readonly configEnvFile: Option.Option<string>
  readonly leaseName: string
  readonly keys: string
  readonly forceNew: boolean
  readonly noWait: boolean
}

/** Refreshes a compatible live lease in place: TTL extended, connection URLs restored. */
const reuseLiveLease = (config: SandboxConfig, existing: Lease, ttlSeconds: number) =>
  Effect.gen(function* () {
    const live = yield* getBranch(config, existing.branchId)

    if (Option.isNone(live)) return Option.none<CreateLeaseResult>()

    yield* validateDeletionTarget(existing, live.value)
    const { databaseName, roleName } = existing

    const connection = yield* getConnectionUris(
      config,
      existing.branchId,
      databaseName !== undefined && roleName !== undefined ? { databaseName, roleName } : undefined
    )

    const expiresAt = timestamp(ttlSeconds)
    yield* setExpiration(config, existing, expiresAt)
    yield* writeEnvKeys(
      existing.envFile,
      existing.envKeys.map(key => [key, urlFor(key, connection)] as const)
    )

    const lease: Lease = {
      ...existing,
      databaseName: connection.databaseName,
      roleName: connection.roleName,
      expiresAt
    }

    yield* writeLease(lease)

    return Option.some<CreateLeaseResult>({
      status: 'reused',
      lease,
      report: {
        status: 'reused',
        lease: lease.leaseName,
        branch_name: lease.branchName,
        branch_id: lease.branchId,
        expires_at: expiresAt,
        config_env_file: lease.configEnvFile,
        env_file: lease.envFile,
        note: 'connection URLs were restored and the existing live lease TTL was refreshed'
      }
    })
  })

/** Creates (or reuses) the lease for one worktree slot and writes its connection URLs. */
export const createLease = (options: CreateLeaseOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const workspace = yield* resolveWorkspace(options.worktree)
    const leaseName = yield* validateLeaseName(options.leaseName)

    return yield* withLeaseLock(
      workspace.root,
      leaseName,
      Effect.gen(function* () {
        const envPath = path.resolve(workspace.root, options.envFile)
        const configEnvPath = path.resolve(
          workspace.root,
          Option.getOrElse(options.configEnvFile, () => options.envFile)
        )

        const config = yield* loadConfig(configEnvPath)
        yield* attestIfDeclared(config, workspace)
        const envKeys = yield* parseEnvKeys(options.keys)
        yield* ensureIgnored(workspace.root, envPath)
        const ttlSeconds = yield* parseTtl(options.ttl)
        const existing = yield* readLease(workspace.root, leaseName)

        if (Option.isSome(existing) && !options.forceNew) {
          const lease = existing.value

          const compatible =
            lease.projectId === config.projectId &&
            lease.parentBranch === config.parentBranch &&
            lease.envFile === envPath &&
            lease.configEnvFile === configEnvPath &&
            lease.envKeys.length === envKeys.length &&
            lease.envKeys.every((key, index) => key === envKeys[index]) &&
            (lease.databaseName === undefined) === (lease.roleName === undefined)

          if (compatible) {
            const reused = yield* reuseLiveLease(config, lease, ttlSeconds)

            if (Option.isSome(reused)) return reused.value
          } else {
            yield* Console.error(
              `provision db: ignoring stale ${leaseName} lease record; its branch will expire automatically`
            )
          }
        }

        const label = slugify(Option.getOrElse(options.label, () => path.basename(workspace.root)))
        const repositoryName = slugify(
          workspace.repository.split('/').pop() ?? workspace.repository
        )
        const branchName = `${BRANCH_PREFIX}${repositoryName}-${label}-${randomBytes(3).toString('hex')}`
        const expiresAt = timestamp(ttlSeconds)
        const envExisted = yield* fs.exists(envPath).pipe(Effect.orElseSucceed(() => false))

        const previousEnv = envExisted
          ? yield* readPrivately(envPath).pipe(
              Effect.mapError(() => new PolicyError({ message: `cannot snapshot ${envPath}` }))
            )
          : undefined

        const leaseFor = (created: CreatedBranch): Lease => ({
          version: 2,
          leaseName,
          projectId: config.projectId,
          parentBranch: config.parentBranch,
          branchId: created.branch.id,
          branchName: created.branch.name,
          worktree: workspace.root,
          repository: workspace.repository,
          label,
          configEnvFile: configEnvPath,
          envFile: envPath,
          envKeys,
          databaseName: created.databaseName,
          roleName: created.roleName,
          createdAt: timestamp(),
          expiresAt
        })

        const publish = (created: CreatedBranch) =>
          Effect.gen(function* () {
            const lease = leaseFor(created)
            yield* writeEnvKeys(
              envPath,
              envKeys.map(key => [key, urlFor(key, created)] as const)
            )
            yield* writeLease(lease)

            const state = options.noWait
              ? 'not-checked'
              : yield* waitUntilReady(config, created.branch.id)

            if (!options.noWait && state !== 'ready') {
              return yield* new NeonError({
                message: 'new branch did not become ready before the bounded timeout'
              })
            }

            return {
              status: 'created',
              lease,
              report: {
                status: 'created',
                lease: lease.leaseName,
                branch_name: lease.branchName,
                branch_id: lease.branchId,
                state,
                expires_at: lease.expiresAt,
                env_file: lease.envFile,
                env_keys: envKeys.join(','),
                config_source: config.backend,
                config_env_file: lease.configEnvFile,
                parent_branch: config.parentBranch,
                note: 'connection string written to env file; not printed'
              }
            } satisfies CreateLeaseResult
          })

        /** Undo everything this run created: branch, env changes, and lease record. */
        const rollback = (created: CreatedBranch) =>
          Effect.gen(function* () {
            const lease = leaseFor(created)
            let cleanupFailed = false

            const attempt = <A, E, R>(cleanup: Effect.Effect<A, E, R>) =>
              cleanup.pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Effect.sync(() => {
                      cleanupFailed = true
                    }),
                  onSuccess: () => Effect.void
                })
              )

            yield* attempt(deleteVerifiedBranch(config, lease, lease.expiresAt))

            if (previousEnv === undefined) yield* attempt(fs.remove(envPath))
            else yield* attempt(writePrivately(envPath, previousEnv))
            const currentLease = yield* readLease(workspace.root, leaseName)

            if (Option.isSome(currentLease)) {
              if (currentLease.value.branchId === lease.branchId) {
                yield* attempt(removeLease(workspace.root, leaseName))

                if (Option.isSome(existing)) yield* attempt(writeLease(existing.value))
              } else if (
                Option.isNone(existing) ||
                currentLease.value.branchId !== existing.value.branchId
              ) {
                cleanupFailed = true
              }
            } else if (Option.isSome(existing)) {
              yield* attempt(writeLease(existing.value))
            }

            if (cleanupFailed) {
              return yield* new LifecycleError({
                message:
                  'new branch setup cleanup could not be fully verified; manual review is required'
              })
            }
          })

        return yield* withBranchLifecycleUsing(
          createBranch(config, { name: branchName, expiresAt }),
          publish,
          rollback
        )
      })
    )
  })

export interface ReleaseLeaseOptions {
  readonly worktree: Option.Option<string>
  readonly leaseName: string
  readonly keepEnv: boolean
}

/** Deletes a lease's branch (after re-verifying its exact identity), env keys, and record. */
export const releaseLease = (options: ReleaseLeaseOptions) =>
  Effect.gen(function* () {
    const workspace = yield* resolveWorkspace(options.worktree)
    const name = yield* validateLeaseName(options.leaseName)

    return yield* withLeaseLock(
      workspace.root,
      name,
      Effect.gen(function* () {
        const lease = yield* readLease(workspace.root, name)

        if (Option.isNone(lease)) {
          return { status: 'none', lease: name, worktree: workspace.root } satisfies LeaseReport
        }

        const config = yield* loadConfig(lease.value.configEnvFile)
        yield* ensureLeaseProfile(config, lease.value)
        yield* attestIfDeclared(config, workspace)

        const deleted = yield* deleteVerifiedBranch(config, lease.value)

        if (!options.keepEnv) yield* removeEnvKeys(lease.value.envFile, lease.value.envKeys)

        yield* removeLease(workspace.root, lease.value.leaseName)

        return {
          status: deleted ? 'released' : 'already-gone',
          lease: lease.value.leaseName,
          branch_name: lease.value.branchName,
          branch_id: lease.value.branchId,
          env_keys_removed: options.keepEnv ? 'no' : 'yes'
        } satisfies LeaseReport
      })
    )
  })
