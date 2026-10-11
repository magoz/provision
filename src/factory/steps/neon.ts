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
  type FactoryContext,
  type ProjectHandle
} from '../context.ts'
import {
  connectionUri,
  createProject,
  createProjectApiKey,
  findApiKey,
  findProject,
  listBranches,
  listDatabases,
  neonProductionHistoryRetentionSeconds,
  protectBranch,
  renameBranch,
  revokeApiKey,
  type NeonAdmin
} from '../providers/neon.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import {
  deleteEnvRecord,
  listEnvRecords,
  listIntegrationConfigurations,
  recordTargets,
  type EnvRecord
} from '../vercel-api.ts'

/** Finds or creates a Neon project; returns its id and protected default branch (`None` in a dry run). */
const ensureProject = (
  context: FactoryContext,
  admin: NeonAdmin,
  name: string,
  branchName: string,
  options: { readonly historyRetentionSeconds?: number; readonly renameDefault?: boolean } = {}
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

      // An existing default branch keeps its data; only a misleading name (for example Neon's
      // default `production` in a dev project) is corrected.
      if (options.renameDefault === true && branch.name !== branchName) {
        yield* mutate(
          context,
          `rename Neon branch ${name}/${branch.name} to ${branchName}`,
          renameBranch(admin, existing.value.id, branch.id, branchName)
        )
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
        ...(options.historyRetentionSeconds === undefined
          ? {}
          : { historyRetentionSeconds: options.historyRetentionSeconds })
      }).pipe(Effect.tap(response => protectBranch(admin, response.project.id, response.branch.id)))
    )

    return Option.map(created, response => ({
      projectId: response.project.id,
      branch: response.branch
    }))
  })

/** Variables Neon's Vercel integration can write (its selectable database variables). */
const databaseKey = /^(DATABASE_URL(_UNPOOLED)?|PG[A-Z_]*|POSTGRES_[A-Z_]*)$/

const outsidePreview = (record: EnvRecord) =>
  recordTargets(record).some(target => target === 'production' || target === 'development')

/**
 * Preview deployments get their own database from Neon's Vercel integration (one branch per git
 * branch, copied from `<repo>-dev`): only that integration can hand a database to a deployment
 * before it builds. It also writes Production and Development variables pointing at `<repo>-dev`;
 * those are removed (Production gets `<repo>-prod` back). Not connected yet: prints how.
 * Connected means the team's Neon integration has access to this Vercel project.
 */
const previewIntegration = (
  context: FactoryContext,
  admin: NeonAdmin,
  handle: ProjectHandle,
  records: ReadonlyArray<EnvRecord>,
  sandbox: Option.Option<{ readonly projectId: string; readonly parentBranch: string | undefined }>
) =>
  Effect.gen(function* () {
    const teamId = context.credentials.vercel.teamId
    const projectId = handle.project.id
    const configurations = yield* listIntegrationConfigurations(teamId, 'neon')
    const configurationIds = new Set(configurations.map(configuration => configuration.id))
    const connected = configurations.some(
      configuration =>
        configuration.projects === undefined ||
        configuration.projects === null ||
        configuration.projects.includes(projectId)
    )

    if (connected) {
      const owned = records.filter(
        record =>
          typeof record.configurationId === 'string' &&
          configurationIds.has(record.configurationId) &&
          databaseKey.test(record.key) &&
          outsidePreview(record)
      )

      if (owned.length > 0) {
        const keys = [...new Set(owned.map(record => record.key))].join(', ')
        const targets = [...new Set(owned.flatMap(recordTargets))].join(', ')

        yield* mutate(
          context,
          `remove the Neon integration's ${keys} from Vercel (${targets})`,
          Effect.forEach(owned, record => deleteEnvRecord(teamId, projectId, record.id), {
            discard: true
          })
        )
      }

      return { connected: true, removed: owned.map(record => record.id) }
    }

    const development = context.names.development
    const project = handle.project.name
    const databases =
      Option.isSome(sandbox) && sandbox.value.parentBranch !== undefined
        ? yield* listDatabases(admin, sandbox.value.projectId, sandbox.value.parentBranch)
        : []
    const database = databases.length === 1 ? databases[0] : undefined
    const connection =
      database === undefined
        ? `the app database and its owner role`
        : `database ${database.name}, role ${database.owner_name}`
    const blocking = [
      ...new Set(
        records
          .filter(record => databaseKey.test(record.key) && outsidePreview(record))
          .flatMap(record =>
            recordTargets(record)
              .filter(target => target === 'production' || target === 'development')
              .map(environment => `${record.key} ${environment}`)
          )
      )
    ]
    const steps = [
      `Vercel → team → Integrations → Neon → Manage Access: add project ${project} (no Neon? Marketplace → Neon → Link Existing Neon Account)`,
      ...(blocking.length === 0
        ? []
        : [
            `remove these first (the integration refuses to connect while they exist; running deployments keep theirs): cd ${context.appDirectory} && ${blocking.map(entry => `vercel env rm ${entry} --yes`).join(' && ')}`
          ]),
      `Neon → project ${development} → Integrations → Vercel → connect ${connection}, Vercel project ${project}. After a failed attempt, delete the vercel-dev branch it leaves in ${development} before retrying`,
      `rerun: provision factory --checkout ${context.checkout.root} --only neon (Production goes back to ${context.names.production}, Development is cleared)`
    ]

    yield* Console.log(
      [
        `  manual: connect Neon's Vercel integration so each Preview branch gets its own database (preview/<git-branch>, copied from ${development}):`,
        ...steps.map((step, index) => `    ${index + 1}. ${step}`)
      ].join('\n')
    )

    const removed: ReadonlyArray<string> = []

    return { connected: false, removed }
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
            yield* ensureProject(context, admin, context.names.development, 'baseline', {
              renameDefault: true
            }),
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

    // Preview databases ---------------------------------------------------------
    const previews = yield* previewIntegration(context, admin, handle.value, records, sandbox)
    const remaining = records.filter(record => !previews.removed.includes(record.id))

    // Production ---------------------------------------------------------------
    const production = yield* ensureProject(
      context,
      admin,
      context.names.production,
      'production',
      { historyRetentionSeconds: neonProductionHistoryRetentionSeconds }
    )

    if (Option.isNone(production)) return

    if (
      !previews.connected &&
      !groupHasKeys(remaining, groups.production, defaultDatabaseUrlKeys)
    ) {
      yield* Console.log(
        `  held back: Production DATABASE_URL (${context.names.production}) is written once Neon's Vercel integration is connected, which refuses to connect while Production has one`
      )

      return
    }

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

    if (groupHasKeys(remaining, groups.production, defaultDatabaseUrlKeys)) {
      const decision = yield* decide(context, 'key', 'production DATABASE_URL records')

      if (decision === 'reuse') return
    }

    yield* writeUrls
  })
