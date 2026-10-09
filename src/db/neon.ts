import { Cause, Effect, Exit, Option, Redacted, Result, type Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
  BranchListResponse,
  BranchResponse,
  ConnectionUriResponse,
  CreateBranchResponse,
  DatabaseListResponse,
  LifecycleError,
  NeonError,
  ProjectResponse,
  READY_TIMEOUT_SECONDS,
  SUSPEND_TIMEOUT_SECONDS,
  type Branch
} from './domain.ts'
import { branchMatchesExactIdentity, type BranchIdentity } from './policy.ts'

const API_ROOT = 'https://console.neon.tech/api/v2'

/**
 * Minimal access needed to talk to one project, so `auth login` can validate a candidate
 * credential before any of it is persisted.
 */
export interface NeonAccess {
  readonly apiKey: Redacted.Redacted<string>
  readonly projectId: string
}

export type NeonProfile = NeonAccess & { readonly parentBranch: string }

interface CreateBranchBody {
  readonly branch: {
    readonly name: string
    readonly parent_id: string
    readonly expires_at: string
    readonly protected: boolean
  }
  readonly endpoints: ReadonlyArray<{
    readonly type: 'read_write'
    readonly suspend_timeout_seconds: number
  }>
}

interface PatchBranchBody {
  readonly branch: { readonly expires_at: string }
}

const request = (
  config: NeonAccess,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: CreateBranchBody | PatchBranchBody
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const base = HttpClientRequest.make(method)(
      `${API_ROOT}/projects/${config.projectId}${path}`
    ).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
        Accept: 'application/json'
      })
    )

    const prepared =
      body === undefined
        ? base
        : yield* HttpClientRequest.bodyJson(base, body).pipe(
            Effect.mapError(() => new NeonError({ message: 'invalid request body' }))
          )

    return yield* client
      .execute(prepared)
      .pipe(Effect.mapError(() => new NeonError({ message: 'neon unreachable' })))
  })

const decode = <S extends Schema.Constraint>(
  schema: S,
  response: HttpClientResponse.HttpClientResponse
) =>
  HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(
      () =>
        new NeonError({ message: 'unexpected neon response shape; provider payload suppressed' })
    )
  )

const failing = (response: HttpClientResponse.HttpClientResponse, action: string) =>
  Effect.fail(
    new NeonError({
      message: `${action} failed (${response.status}); provider response suppressed`
    })
  )

const verifyProjectAccess = (config: NeonAccess) =>
  Effect.gen(function* () {
    const response = yield* request(config, 'GET', '')

    if (response.status === 401 || response.status === 403) {
      return yield* new NeonError({ message: 'credential rejected by neon' })
    }

    if (response.status === 404) {
      return yield* new NeonError({
        message: `project ${config.projectId} not found, or this key is scoped to another project`
      })
    }

    if (response.status >= 400) return yield* failing(response, 'project lookup')
    const body = yield* decode(ProjectResponse, response)

    if (body.project.id !== config.projectId) {
      return yield* new NeonError({
        message: 'configured Neon project identity could not be attested'
      })
    }

    return body.project
  })

/** Branch lookup that treats a re-verified project-scoped 404 as "gone". */
export const getBranch = (config: NeonAccess, branchId: string) =>
  Effect.gen(function* () {
    const response = yield* request(config, 'GET', `/branches/${branchId}`)

    if (response.status === 404) {
      yield* verifyProjectAccess(config)

      return Option.none<Branch>()
    }

    if (response.status >= 400) return yield* failing(response, 'branch lookup')

    return Option.some((yield* decode(BranchResponse, response)).branch)
  })

export const listBranches = (config: NeonAccess) =>
  Effect.gen(function* () {
    const branches: Array<Branch> = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    do {
      const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`
      const response = yield* request(config, 'GET', `/branches${query}`)

      if (response.status >= 400) return yield* failing(response, 'branch listing')
      const body = yield* decode(BranchListResponse, response)
      branches.push(...body.branches)
      const next = body.pagination?.cursor

      if (next !== undefined && seenCursors.has(next)) {
        return yield* new NeonError({ message: 'branch pagination cursor cycle detected' })
      }

      if (next !== undefined) seenCursors.add(next)
      cursor = next
    } while (cursor !== undefined)

    return branches
  })

export const listDatabases = (config: NeonAccess, branchId: string) =>
  Effect.gen(function* () {
    const response = yield* request(config, 'GET', `/branches/${branchId}/databases`)

    if (response.status >= 400) return yield* failing(response, 'database listing')

    return (yield* decode(DatabaseListResponse, response)).databases
  })

export interface ConnectionTarget {
  readonly databaseName: string
  readonly roleName: string
}

const retrieveConnectionUri = (
  config: NeonAccess,
  branchId: string,
  target: ConnectionTarget,
  pooled: boolean
) =>
  Effect.gen(function* () {
    const query = new URLSearchParams({
      branch_id: branchId,
      database_name: target.databaseName,
      role_name: target.roleName,
      pooled: String(pooled)
    })

    const response = yield* request(config, 'GET', `/connection_uri?${query.toString()}`)

    if (response.status >= 400) return yield* failing(response, 'connection URI retrieval')

    return (yield* decode(ConnectionUriResponse, response)).uri
  })

export const getConnectionUris = (
  config: NeonAccess,
  branchId: string,
  recordedTarget?: ConnectionTarget
) =>
  Effect.gen(function* () {
    const target =
      recordedTarget ??
      (yield* listDatabases(config, branchId).pipe(
        Effect.flatMap(databases => {
          const database = databases[0]

          return databases.length === 1 && database !== undefined
            ? Effect.succeed({ databaseName: database.name, roleName: database.owner_name })
            : Effect.fail(
                new NeonError({
                  message:
                    `cannot restore connection URLs for branch ${branchId}: ` +
                    `expected one database, found ${databases.length}`
                })
              )
        })
      ))

    const [direct, pooled] = yield* Effect.all(
      [
        retrieveConnectionUri(config, branchId, target, false),
        retrieveConnectionUri(config, branchId, target, true)
      ],
      { concurrency: 2 }
    )

    return { ...target, direct, pooled }
  })

/** Validates a credential against one project and returns the project. */
export const describeProject = (config: NeonAccess) => verifyProjectAccess(config)

/**
 * Attests a profile against what `provision factory` creates for an `empty-baseline` repository:
 * the project is the repository's `<repo>-dev` project and the parent is its protected default
 * `baseline` branch, rather than an older profile silently trusted by ID.
 */
export const attestSandboxProfile = (config: NeonProfile, repository: string) =>
  Effect.gen(function* () {
    const repositoryName = repository.split('/').pop() ?? repository
    const expectedProjectName = `${repositoryName}-dev`
    const project = yield* verifyProjectAccess(config)

    if (project.name !== expectedProjectName) {
      return yield* new NeonError({
        message:
          `configured Neon project must be named ${expectedProjectName}; ` +
          'align or explicitly import older sandbox baselines before routine mutation'
      })
    }

    const parent = yield* getBranch(config, config.parentBranch)

    if (Option.isNone(parent)) {
      return yield* new NeonError({ message: 'configured Neon parent baseline does not exist' })
    }

    if (
      parent.value.id !== config.parentBranch ||
      parent.value.name !== 'baseline' ||
      parent.value.default !== true ||
      parent.value.protected !== true
    ) {
      return yield* new NeonError({
        message:
          'configured Neon parent must be the protected default baseline; ' +
          'align or explicitly import older sandbox baselines before routine mutation'
      })
    }

    return { project, parent: parent.value }
  })

/** Resolves the default parent when global auth does not name one explicitly. */
export const findDefaultBranch = (config: NeonAccess) =>
  listBranches(config).pipe(
    Effect.flatMap(branches => {
      const found = branches.find(branch => branch.default === true)

      return found === undefined
        ? Effect.fail(new NeonError({ message: 'project has no default branch' }))
        : Effect.succeed(found)
    })
  )

export interface CreatedBranch {
  readonly branch: Branch
  readonly pooled: Redacted.Redacted<string>
  readonly direct: Redacted.Redacted<string>
  readonly databaseName: string
  readonly roleName: string
}

const unsafeCreateOutcome = () =>
  new NeonError({
    message:
      'branch creation outcome could not be safely proven; inspect the uniquely named requested agent branch in Neon and remove it manually if appropriate'
  })

const settleDelay = '100 millis'

const recoverUnknownCreateOutcome = (
  config: NeonProfile,
  options: { readonly name: string; readonly expiresAt: string },
  beforeIds: ReadonlySet<string>
) =>
  Effect.gen(function* () {
    let matches: ReadonlyArray<Branch> = []

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = yield* Effect.result(listBranches(config))

      if (Result.isFailure(listed)) return yield* unsafeCreateOutcome()
      matches = listed.success.filter(branch => branch.name === options.name)

      if (matches.length > 0) break

      if (attempt < 2) yield* Effect.sleep(settleDelay)
    }

    const candidate = matches.length === 1 ? matches[0] : undefined

    if (candidate === undefined || beforeIds.has(candidate.id)) {
      return yield* unsafeCreateOutcome()
    }

    const expected: BranchIdentity = {
      branchId: candidate.id,
      branchName: options.name,
      parentBranch: config.parentBranch
    }

    if (!branchMatchesExactIdentity(expected, candidate, options.expiresAt)) {
      return yield* unsafeCreateOutcome()
    }

    yield* deleteVerifiedBranch(config, expected, options.expiresAt).pipe(
      Effect.mapError(
        () =>
          new LifecycleError({
            message:
              'unknown branch creation outcome and verified cleanup both failed; inspect the uniquely named requested agent branch in Neon and remove it manually if appropriate'
          })
      )
    )
  })

/**
 * Creates an unprotected agent branch and its connection URLs. Every path that may have created a
 * branch without returning it proves and removes exactly that branch, or reports manual recovery.
 */
export const createBranch = (
  config: NeonProfile,
  options: { readonly name: string; readonly expiresAt: string }
) =>
  Effect.gen(function* () {
    const before = yield* listBranches(config)
    const beforeIds = new Set(before.map(branch => branch.id))

    if (before.some(branch => branch.name === options.name)) {
      return yield* unsafeCreateOutcome()
    }

    return yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const posted = yield* Effect.exit(
          Effect.gen(function* () {
            const response = yield* request(config, 'POST', '/branches', {
              branch: {
                name: options.name,
                parent_id: config.parentBranch,
                expires_at: options.expiresAt,
                protected: false
              },
              endpoints: [{ type: 'read_write', suspend_timeout_seconds: SUSPEND_TIMEOUT_SECONDS }]
            })

            if (response.status >= 400) return yield* failing(response, 'branch creation')
            const body = yield* decode(CreateBranchResponse, response)

            const expected: BranchIdentity = {
              branchId: body.branch.id,
              branchName: options.name,
              parentBranch: config.parentBranch
            }

            if (!branchMatchesExactIdentity(expected, body.branch, options.expiresAt)) {
              return yield* unsafeCreateOutcome()
            }

            return expected
          })
        )

        if (Exit.isFailure(posted)) {
          const cleanupExit = yield* Effect.exit(
            recoverUnknownCreateOutcome(config, options, beforeIds)
          )

          if (Exit.isFailure(cleanupExit)) {
            return yield* new LifecycleError({
              message:
                'branch creation outcome could not be safely proven and verified cleanup failed; inspect the uniquely named requested agent branch in Neon and remove it manually if appropriate'
            })
          }

          return yield* Effect.failCause(posted.cause)
        }

        const expected = posted.value

        const observationExit = yield* Effect.exit(
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const fresh = yield* Effect.result(getBranch(config, expected.branchId))

              if (
                Result.isSuccess(fresh) &&
                Option.isSome(fresh.success) &&
                branchMatchesExactIdentity(expected, fresh.success.value, options.expiresAt)
              ) {
                return fresh.success.value
              }

              if (attempt < 2) yield* Effect.sleep(settleDelay)
            }

            return yield* unsafeCreateOutcome()
          })
        )

        if (Exit.isFailure(observationExit)) {
          const cleanupExit = yield* Effect.exit(
            recoverUnknownCreateOutcome(config, options, beforeIds)
          )

          if (Exit.isFailure(cleanupExit)) return yield* Effect.failCause(cleanupExit.cause)

          return yield* Effect.failCause(observationExit.cause)
        }

        const connectionExit = yield* Effect.exit(
          restore(getConnectionUris(config, expected.branchId))
        )

        if (Exit.isFailure(connectionExit)) {
          const cleanupExit = yield* Effect.exit(
            deleteVerifiedBranch(config, expected, options.expiresAt)
          )

          if (Exit.isFailure(cleanupExit)) {
            if (Cause.hasInterrupts(connectionExit.cause) || Cause.hasDies(connectionExit.cause)) {
              return yield* Effect.failCause(connectionExit.cause)
            }

            return yield* new LifecycleError({
              message:
                'new branch setup and verified cleanup both failed; inspect the requested agent branch in Neon and remove it manually if appropriate'
            })
          }

          return yield* Effect.failCause(connectionExit.cause)
        }

        return {
          branch: observationExit.value,
          pooled: connectionExit.value.pooled,
          direct: connectionExit.value.direct,
          databaseName: connectionExit.value.databaseName,
          roleName: connectionExit.value.roleName
        } satisfies CreatedBranch
      })
    )
  })

const unverifiedExpiration = () =>
  new NeonError({
    message:
      'expiration update could not be safely verified; inspect the recorded agent branch in Neon before retrying'
  })

export const setExpiration = (config: NeonAccess, expected: BranchIdentity, expiresAt: string) =>
  Effect.gen(function* () {
    const response = yield* request(config, 'PATCH', `/branches/${expected.branchId}`, {
      branch: { expires_at: expiresAt }
    })

    if (response.status >= 400) return yield* failing(response, 'expiration update')
    const body = yield* decode(BranchResponse, response)

    if (!branchMatchesExactIdentity(expected, body.branch, expiresAt)) {
      return yield* unverifiedExpiration()
    }

    const observed = yield* getBranch(config, expected.branchId).pipe(
      Effect.mapError(unverifiedExpiration)
    )

    if (Option.isNone(observed)) {
      return yield* new NeonError({
        message: 'recorded branch disappeared after expiration update'
      })
    }

    if (!branchMatchesExactIdentity(expected, observed.value, expiresAt)) {
      return yield* unverifiedExpiration()
    }

    return observed.value
  })

const deleteBranch = (config: NeonAccess, branchId: string) =>
  Effect.gen(function* () {
    const response = yield* request(config, 'DELETE', `/branches/${branchId}`)

    if (response.status === 404) {
      yield* verifyProjectAccess(config)

      return
    }

    if (response.status >= 400) return yield* failing(response, 'branch deletion')
  })

export const confirmStableBranchAbsence = (config: NeonAccess, branchId: string) =>
  Effect.gen(function* () {
    for (let observation = 0; observation < 2; observation += 1) {
      if (Option.isSome(yield* getBranch(config, branchId))) return false

      if (observation === 0) yield* Effect.sleep(settleDelay)
    }

    return true
  })

/**
 * Deletes the branch only after re-observing its exact identity, then confirms stable absence.
 * Returns `false` when the branch was already gone.
 */
export const deleteVerifiedBranch = (
  config: NeonAccess,
  expected: BranchIdentity,
  expiresAt?: string
) =>
  Effect.gen(function* () {
    const observed = yield* getBranch(config, expected.branchId)

    if (Option.isNone(observed)) {
      if (!(yield* confirmStableBranchAbsence(config, expected.branchId))) {
        return yield* new NeonError({
          message: 'branch absence was not stable; manual review is required'
        })
      }

      return false
    }

    if (!branchMatchesExactIdentity(expected, observed.value, expiresAt)) {
      return yield* new NeonError({
        message: 'branch deletion target failed strict identity validation'
      })
    }

    yield* deleteBranch(config, expected.branchId)

    if (!(yield* confirmStableBranchAbsence(config, expected.branchId))) {
      return yield* new NeonError({
        message: 'branch deletion could not be confirmed; manual review is required'
      })
    }

    return true
  })

const settled = (state: string) => state === 'ready' || state === 'missing'

/** Polls until the compute is usable; a timeout is reported as `not-ready`, never thrown away. */
export const waitUntilReady = (config: NeonAccess, branchId: string) => {
  const currentState = getBranch(config, branchId).pipe(
    Effect.map(
      Option.match({
        onNone: () => 'missing',
        onSome: branch => branch.current_state ?? 'unknown'
      })
    )
  )

  return Effect.gen(function* () {
    let state = yield* currentState

    while (!settled(state)) {
      yield* Effect.sleep('2 seconds')
      state = yield* currentState
    }

    return state
  }).pipe(
    Effect.timeout(`${READY_TIMEOUT_SECONDS} seconds`),
    Effect.orElseSucceed(() => 'not-ready')
  )
}
