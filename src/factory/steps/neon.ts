import { Console, Effect, Option, Redacted } from 'effect'
import { defaultDatabaseUrlKeys, sandboxProfileKeys } from '../../shared/sandbox-profile.ts'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  mutate,
  requireProject,
  writeGroup,
  type FactoryContext
} from '../context.ts'
import {
  connectionUri,
  createProject,
  createProjectApiKey,
  findApiKey,
  findProject,
  listBranches,
  neonProductionHistoryRetentionSeconds,
  protectBranch,
  revokeApiKey,
  type NeonAdmin
} from '../providers/neon.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import { listEnvRecords } from '../vercel-api.ts'

/** Finds or creates a Neon project; returns its id and protected default branch (`None` in a dry run). */
const ensureProject = (
  context: FactoryContext,
  admin: NeonAdmin,
  name: string,
  branchName: string,
  historyRetentionSeconds?: number
) =>
  Effect.gen(function* () {
    const existing = yield* findProject(admin, name)

    if (Option.isSome(existing)) {
      yield* decide(context, 'data', `Neon project ${name}`)
      const branches = yield* listBranches(admin, existing.value.id)
      const branch = branches.find(candidate => candidate.default === true)

      if (branch === undefined) {
        return yield* factoryError(`Neon project ${name} has no default branch`)
      }

      if (branch.protected !== true) {
        yield* mutate(
          context,
          `protect Neon branch ${name}/${branch.name}`,
          protectBranch(admin, existing.value.id, branch.id)
        )
      }

      return Option.some({ projectId: existing.value.id, branch })
    }

    const created = yield* mutate(
      context,
      `create Neon project ${name} with protected branch ${branchName}`,
      createProject(admin, {
        name,
        branchName,
        ...(historyRetentionSeconds === undefined ? {} : { historyRetentionSeconds })
      }).pipe(Effect.tap(response => protectBranch(admin, response.project.id, response.branch.id)))
    )

    return Option.map(created, response => ({
      projectId: response.project.id,
      branch: response.branch
    }))
  })

/**
 * `<repo>-dev`: the sandbox project whose parent branch disposable databases clone, plus a
 * project-scoped key, written to Vercel Development as the `SANDBOX_DB_*` profile.
 * `<repo>-prod`: the production project, written to Vercel Production as `DATABASE_URL(_UNPOOLED)`.
 */
export const neonStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const admin = context.credentials.neon

    if (admin === undefined) {
      return yield* factoryError('the factory item has no neon section')
    }

    const handle = yield* requireProject(context)

    if (Option.isNone(handle)) {
      yield* Console.log('  would run after the vercel step creates the project')

      return
    }

    const teamId = context.credentials.vercel.teamId
    const groups = envGroups(handle.value)
    const records = yield* listEnvRecords(teamId, handle.value.project.id)
    const mode = context.repoConfig.factory.neon.sandboxParent ?? 'empty-baseline'

    // Development sandbox ----------------------------------------------------
    const sandbox: Option.Option<{
      readonly projectId: string
      readonly parentBranch: string | undefined
    }> =
      mode === 'empty-baseline'
        ? Option.map(
            yield* ensureProject(context, admin, context.names.development, 'baseline'),
            project => ({ projectId: project.projectId, parentBranch: project.branch.id })
          )
        : yield* findProject(admin, context.names.development).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    factoryError(
                      `existing-branch mode needs the Neon project ${context.names.development} to exist`
                    )
                  ),
                onSome: project =>
                  decide(context, 'data', `Neon project ${project.name}`).pipe(
                    Effect.as(
                      Option.some({ projectId: project.id, parentBranch: context.neonParentBranch })
                    )
                  )
              })
            )
          )

    if (Option.isSome(sandbox)) {
      const { projectId, parentBranch } = sandbox.value
      const keyName = `${context.names.development}-sandbox-branch-manager`

      yield* ensureScopedKey(context, {
        description: `Neon key ${keyName}`,
        existing: yield* findApiKey(admin, keyName),
        vercelComplete: groupHasKeys(records, groups.development, sandboxProfileKeys),
        createAndWrite: Effect.gen(function* () {
          if (parentBranch === undefined) {
            return yield* factoryError(
              'existing-branch mode needs --neon-parent-branch to (re)write the sandbox profile'
            )
          }

          const created = yield* createProjectApiKey(admin, keyName, projectId)
          const [apiKey, project, parent] = sandboxProfileKeys
          const written = yield* writeGroup(context, handle.value, groups.development, [
            { key: apiKey, value: created.key, type: 'encrypted' },
            { key: project, value: Redacted.make(projectId), type: 'encrypted' },
            { key: parent, value: Redacted.make(parentBranch), type: 'encrypted' }
          ]).pipe(Effect.tapError(() => revokeApiKey(admin, created.id).pipe(Effect.ignore)))

          return written
        }).pipe(Effect.asVoid),
        remove: id => revokeApiKey(admin, id)
      })
    }

    // Production ---------------------------------------------------------------
    const production = yield* ensureProject(
      context,
      admin,
      context.names.production,
      'production',
      neonProductionHistoryRetentionSeconds
    )

    if (Option.isNone(production)) return

    const { projectId, branch } = production.value
    const writeUrls = Effect.gen(function* () {
      const [pooledKey, directKey] = defaultDatabaseUrlKeys
      const pooled = yield* connectionUri(admin, projectId, branch.id, true)
      const direct = yield* connectionUri(admin, projectId, branch.id, false)

      yield* writeGroup(context, handle.value, groups.production, [
        { key: pooledKey, value: pooled, type: 'sensitive' },
        { key: directKey, value: direct, type: 'sensitive' }
      ])
    })

    if (groupHasKeys(records, groups.production, defaultDatabaseUrlKeys)) {
      const decision = yield* decide(context, 'key', 'production DATABASE_URL records')

      if (decision === 'reuse') return
    }

    yield* writeUrls
  })
