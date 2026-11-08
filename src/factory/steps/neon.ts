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
  withTerminal,
  type FactoryContext,
  type FactoryError,
  type ProjectHandle
} from '../context.ts'
import {
  connectionUri,
  createProject,
  createProjectApiKey,
  deleteBranch,
  findApiKey,
  findProject,
  listBranches,
  listDatabases,
  neonProductionHistoryRetentionSeconds,
  protectBranch,
  renameBranch,
  revokeApiKey,
  type NeonAdmin,
  type NeonBranch
} from '../providers/neon.ts'
import { ManualStep } from '../manual-step.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import {
  deleteEnvRecord,
  listEnvRecords,
  listIntegrationConfigurations,
  recordTargets,
  type EnvRecord,
  type IntegrationConfiguration
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

/** The branch Neon creates in `<repo>-dev` for Vercel Development when connecting. */
const devBranchName = 'vercel-dev'

const isServerTarget = (target: string) => target === 'production' || target === 'development'

const outsidePreview = (record: EnvRecord) => recordTargets(record).some(isServerTarget)

/** Targets only Production and/or Development: deleting it leaves Preview and `test` untouched. */
const onlyServerTargets = (record: EnvRecord) =>
  (record.customEnvironmentIds ?? []).length === 0 && recordTargets(record).every(isServerTarget)

/** `DATABASE_URL, DATABASE_URL_UNPOOLED (production, development)` */
const recordList = (records: ReadonlyArray<EnvRecord>) => {
  const keys = new Set(records.map(record => record.key))
  const targets = new Set(records.flatMap(recordTargets).filter(isServerTarget))

  return `${[...keys].join(', ')} (${[...targets].join(', ')})`
}

/** Database records owned by one of the integration's configurations. */
const integrationRecords = (
  configurations: ReadonlyArray<IntegrationConfiguration>,
  records: ReadonlyArray<EnvRecord>
) => {
  const ids = new Set(configurations.map(configuration => configuration.id))

  return records.filter(
    record =>
      typeof record.configurationId === 'string' &&
      ids.has(record.configurationId) &&
      databaseKey.test(record.key)
  )
}

type Sandbox = Option.Option<{
  readonly projectId: string
  readonly parentBranch: string | undefined
}>

/**
 * What says whether Neon's Vercel integration serves the project. It takes two links:
 * - Vercel side, `access`: the team's installation may use the project (listed, or "All
 *   projects", which every new project gets without anyone connecting anything);
 * - Neon side: `<repo>-dev` connected to the project in Neon's console. Neither API reports this
 *   link: Neon's project listing only tags a project with integration names (`vercel`), not
 *   which Vercel project, and its behaviour after failed attempts or disconnects is undocumented;
 *   Vercel reports an installation's project access and which records it owns, not the Neon
 *   project behind them. So the link is inferred from what connecting leaves behind:
 *   - `records`: the database variables the installation writes (`configurationId`). Only a
 *     successful connection writes them, but provision removes the Production and Development
 *     ones, so they do not survive a finished run;
 *   - `devBranch`: `vercel-dev`, created in `<repo>-dev` by the option "Create a branch for your
 *     development environment", which the connect step requires so reruns can recognise the link.
 *     A failed attempt can leave one too, which only a fresh connect can tell (no `records`);
 *   - `previewBranch`: a `preview/*` branch, created by a Preview deployment once connected.
 */
interface LinkEvidence {
  readonly access: boolean
  readonly records: ReadonlyArray<EnvRecord>
  readonly devBranch: NeonBranch | undefined
  readonly previewBranch: boolean
}

const linkEvidence = (
  teamId: string,
  admin: NeonAdmin,
  projectId: string,
  records: ReadonlyArray<EnvRecord>,
  sandbox: Sandbox
) =>
  Effect.gen(function* () {
    const configurations = yield* listIntegrationConfigurations(teamId, 'neon')
    const branches = Option.isSome(sandbox)
      ? yield* listBranches(admin, sandbox.value.projectId)
      : []

    return {
      access: configurations.some(
        configuration =>
          configuration.projects === undefined ||
          configuration.projects === null ||
          configuration.projects.includes(projectId)
      ),
      records: integrationRecords(configurations, records),
      devBranch: branches.find(branch => branch.name === devBranchName),
      previewBranch: branches.some(branch => branch.name.startsWith('preview/'))
    } satisfies LinkEvidence
  })

/**
 * How a run finds the integration. Linked needs evidence that survives the run: on a rerun the
 * integration's Production and Development records are gone, so `vercel-dev`, a `preview/*`
 * branch, or a record provision keeps (one that also serves Preview or `test`) is what remains.
 * Only removable records (`no-dev-branch`: connected without the required option) would leave a
 * rerun with nothing. A `vercel-dev` branch left by a failed attempt made outside provision reads
 * as linked; only {@link attemptOutcome} can tell the two apart.
 */
const standing = (evidence: LinkEvidence, development: string) =>
  !evidence.access
    ? ({ status: 'no-access' } as const)
    : evidence.devBranch !== undefined
      ? ({ status: 'linked', by: `${development}/${devBranchName}` } as const)
      : evidence.previewBranch
        ? ({ status: 'linked', by: `${development}/preview/* branches` } as const)
        : evidence.records.some(record => !onlyServerTargets(record))
          ? ({ status: 'linked', by: 'its Preview variables' } as const)
          : evidence.records.length > 0
            ? ({ status: 'no-dev-branch' } as const)
            : ({ status: 'unlinked' } as const)

/**
 * What the operator's connect attempt in this run did. A successful connection writes the
 * integration's variables and, with the required option, creates `vercel-dev`; a `vercel-dev`
 * without variables is a failed attempt.
 */
const attemptOutcome = (evidence: LinkEvidence) =>
  !evidence.access
    ? ({ status: 'no-access' } as const)
    : evidence.records.length > 0
      ? evidence.devBranch === undefined
        ? ({ status: 'no-dev-branch' } as const)
        : ({ status: 'linked' } as const)
      : evidence.devBranch === undefined
        ? ({ status: 'nothing' } as const)
        : ({ status: 'failed', branch: evidence.devBranch } as const)

/**
 * Preview deployments get their own database from Neon's Vercel integration (one branch per git
 * branch, copied from `<repo>-dev`): only that integration can hand a database to a deployment
 * before it builds. Connected already (see {@link standing}): removes the variables it writes for
 * Production and Development. Otherwise, one guided run: removes the database variables that make
 * the integration refuse to connect (Production and Development only, after the operator agrees),
 * shows the Neon console step, waits, checks what the attempt left (see {@link attemptOutcome}),
 * then removes the integration's Production and Development variables. Declined, or without a
 * terminal, it prints how to finish. Production gets `<repo>-prod` afterwards (in
 * {@link neonStep}), never before the link exists.
 */
const previewIntegration = (
  context: FactoryContext,
  admin: NeonAdmin,
  handle: ProjectHandle,
  records: ReadonlyArray<EnvRecord>,
  sandbox: Sandbox
) =>
  Effect.gen(function* () {
    const teamId = context.credentials.vercel.teamId
    const projectId = handle.project.id
    const development = context.names.development
    const project = handle.project.name
    const manual = yield* ManualStep
    let current = records
    let evidence = yield* linkEvidence(teamId, admin, projectId, current, sandbox)
    const initial = standing(evidence, development)

    if (initial.status === 'linked') {
      if (evidence.records.length === 0) {
        yield* Console.log(
          `  reusing Neon's Vercel integration: ${development} is connected to ${project} (${initial.by})`
        )
      }

      return yield* finish(context, handle, evidence, current)
    }

    const noDevBranch = `Neon's integration wrote its variables, but ${development} has no ${devBranchName} branch: "Create a branch for your development environment" was off, and without that branch a later run cannot tell ${development} is connected. In Neon → project ${development} → Integrations → Vercel → Manage, disconnect, then connect again with it on.\n`
    let problem = ''

    if (initial.status === 'no-dev-branch') {
      // Removed now (as once connected) so they cannot block connecting again.
      const owned = yield* removeOwned(context, handle, evidence)
      current = current.filter(record => !owned.includes(record))
      problem = noDevBranch
    }

    const connect = yield* connectStep(context, admin, project, sandbox)
    const intro = `connect Neon's Vercel integration so each Preview branch gets its own database (preview/<git-branch>, copied from ${development}):`
    const rerun = `provision factory --checkout ${context.checkout.root} --only neon --on-existing reuse`
    const confirm = (instructions: ReadonlyArray<string>, question: string) =>
      context.dryRun
        ? Effect.succeed(false)
        : manual.confirm(instructions.join('\n'), question).pipe(
            withTerminal,
            Effect.mapError(error => factoryError(error.message))
          )
    const accessStep = () =>
      evidence.access
        ? []
        : [
            `Vercel → team → Integrations → Neon → Manage Access: add project ${project} (no Neon? Marketplace → Neon → Link Existing Neon Account)`
          ]
    const splitStep = () => {
      const spanning = current.filter(
        record =>
          databaseKey.test(record.key) && outsidePreview(record) && !onlyServerTargets(record)
      )

      return spanning.length === 0
        ? []
        : [
            `Vercel → ${project} → Settings → Environment Variables: take Production and Development off ${recordList(spanning)}, which also serve Preview or test (provision never edits those)`
          ]
    }
    const leave = (lines: ReadonlyArray<string>) =>
      Console.log([`  manual: ${intro}`, ...numbered(lines)].join('\n')).pipe(
        Effect.as({ status: 'pending', records: current } as const)
      )

    // Records the integration refuses to connect alongside -------------------
    const blockers = current.filter(
      record => databaseKey.test(record.key) && outsidePreview(record) && onlyServerTargets(record)
    )

    if (blockers.length > 0) {
      const removal = `provision removes ${recordList(blockers)} from Vercel: Neon's integration refuses to connect while Production or Development has one (running deployments keep theirs; Production gets ${context.names.production} back once connected)`
      const agreed = yield* confirm(
        [
          `${problem}Neon for ${project}: ${intro}`,
          ...numbered([...accessStep(), ...splitStep(), removal, connect])
        ],
        'Remove them now? Yes removes them, then waits while you connect; No leaves it for a rerun'
      )

      if (!agreed && !context.dryRun) {
        return yield* leave([
          ...accessStep(),
          ...splitStep(),
          `rerun in a terminal: ${rerun} (it removes ${recordList(blockers)} first, then waits while you connect ${development} in Neon)`
        ])
      }

      problem = ''

      yield* mutate(
        context,
        `remove ${recordList(blockers)} from Vercel so Neon's integration can connect (Production gets ${context.names.production} once connected)`,
        Effect.forEach(blockers, record => deleteEnvRecord(teamId, projectId, record.id), {
          discard: true
        })
      )
      current = current.filter(record => !blockers.includes(record))
    }

    // Neon console step, then check what it left -------------------------------
    const emptied = blockers.some(record => recordTargets(record).includes('production'))

    while (true) {
      const steps = [...accessStep(), ...splitStep(), connect]
      const confirmed = yield* confirm(
        [`${problem}Neon for ${project}: ${intro}`, ...numbered(steps)],
        'Connected? Yes checks again and continues; No leaves it for a rerun'
      )

      if (!confirmed) {
        return yield* leave([
          ...steps,
          `rerun: ${rerun} (Production goes back to ${context.names.production}, Development is cleared)${emptied && !context.dryRun ? `; until then Production has no DATABASE_URL, so new Production deployments get none` : ''}`
        ])
      }

      current = yield* listEnvRecords(teamId, projectId)
      evidence = yield* linkEvidence(teamId, admin, projectId, current, sandbox)
      const outcome = attemptOutcome(evidence)

      if (outcome.status === 'linked') break

      if (outcome.status === 'no-access') {
        problem = `Neon's Vercel integration still has no access to ${project}.\n`
      } else if (outcome.status === 'nothing') {
        problem = `${development} is still not connected to ${project}: Vercel has no variables from Neon's integration and ${development} has no ${devBranchName} branch.\n`
      } else if (outcome.status === 'no-dev-branch') {
        const owned = yield* removeOwned(context, handle, evidence)
        current = current.filter(record => !owned.includes(record))
        problem = noDevBranch
      } else {
        const conflicts = current.filter(
          record => databaseKey.test(record.key) && !evidence.records.includes(record)
        )
        // Neon may still be writing its variables: look again before deleting the branch.
        const stillFailed = listEnvRecords(teamId, projectId).pipe(
          Effect.flatMap(latest => linkEvidence(teamId, admin, projectId, latest, sandbox)),
          Effect.map(latest => attemptOutcome(latest).status === 'failed')
        )
        problem = yield* failedAttempt(context, admin, sandbox, outcome.branch, conflicts, {
          confirm,
          stillFailed
        })
      }
    }

    return yield* finish(context, handle, evidence, current)
  })

/**
 * A `vercel-dev` branch without the integration's variables: the attempt created the branch and
 * then failed, and the branch would make a later run read the project as connected. It is a fresh
 * copy of `<repo>-dev`'s default branch that nothing uses yet, so it holds no app data; deleting
 * it (once the operator agrees) is the retry Neon needs. Returns the message for the next prompt.
 */
const failedAttempt = <E, R>(
  context: FactoryContext,
  admin: NeonAdmin,
  sandbox: Sandbox,
  branch: NeonBranch,
  conflicts: ReadonlyArray<EnvRecord>,
  operator: {
    readonly confirm: (
      instructions: ReadonlyArray<string>,
      question: string
    ) => Effect.Effect<boolean, FactoryError>
    /** Whether the integration's variables are still missing. */
    readonly stillFailed: Effect.Effect<boolean, E, R>
  }
) =>
  Effect.gen(function* () {
    const development = context.names.development
    const cause =
      conflicts.length === 0
        ? ''
        : ` Neon fails when other database variables are in its way, as these may be: ${conflicts
            .map(record => `${record.key} (${recordTargets(record).join(', ') || 'custom'})`)
            .join(', ')}; remove those first (provision leaves Preview and test ones to you).`
    const failed = `${development} has a ${devBranchName} branch but Vercel has no variables from Neon's integration: the connect attempt failed after creating the branch.${cause}`
    const remove = yield* operator.confirm(
      [
        failed,
        `${devBranchName} is a fresh copy of ${development}'s default branch that nothing uses yet (no app data); delete it before connecting again.`
      ],
      `Delete ${development}/${devBranchName}? Yes deletes it; No leaves it to you`
    )

    if (!remove || Option.isNone(sandbox)) {
      return `${failed} Delete ${development}/${devBranchName} in Neon before connecting again.\n`
    }

    if (!(yield* operator.stillFailed)) {
      return `Neon's variables have appeared since: ${devBranchName} is kept. Confirm again.\n`
    }

    yield* mutate(
      context,
      `delete Neon branch ${development}/${devBranchName} left by the failed attempt`,
      deleteBranch(admin, sandbox.value.projectId, branch.id)
    )

    return `${failed} It is deleted; connect again.\n`
  })

/**
 * Removes the integration's Production and Development variables. Preview ones stay, and so does
 * one that also serves Preview or `test` (writing Production then stops and asks to split it).
 */
const removeOwned = (context: FactoryContext, handle: ProjectHandle, evidence: LinkEvidence) =>
  Effect.gen(function* () {
    const owned = evidence.records.filter(onlyServerTargets)

    if (owned.length > 0) {
      yield* mutate(
        context,
        `remove the Neon integration's ${recordList(owned)} from Vercel`,
        Effect.forEach(
          owned,
          record =>
            deleteEnvRecord(context.credentials.vercel.teamId, handle.project.id, record.id),
          { discard: true }
        )
      )
    }

    return owned
  })

/** Connected: `fresh` when Neon has just written its variables (a new or changed connection). */
const finish = (
  context: FactoryContext,
  handle: ProjectHandle,
  evidence: LinkEvidence,
  records: ReadonlyArray<EnvRecord>
) =>
  removeOwned(context, handle, evidence).pipe(
    Effect.map(owned => ({
      status: 'connected' as const,
      fresh: owned.length > 0,
      records: records.filter(record => !owned.includes(record))
    }))
  )

const numbered = (lines: ReadonlyArray<string>) =>
  lines.map((line, index) => `    ${index + 1}. ${line}`)

/** The Neon console step, with the exact names to pick. */
const connectStep = (
  context: FactoryContext,
  admin: NeonAdmin,
  project: string,
  sandbox: Sandbox
) =>
  Effect.gen(function* () {
    const development = context.names.development
    const databases =
      Option.isSome(sandbox) && sandbox.value.parentBranch !== undefined
        ? yield* listDatabases(admin, sandbox.value.projectId, sandbox.value.parentBranch)
        : []
    const connection =
      databases.length === 0
        ? `the app database and its owner role`
        : databases
            .map(database => `database ${database.name}, role ${database.owner_name}`)
            .join(' or ')

    return `Neon → project ${development} → Integrations → Vercel → connect Vercel project ${project}, ${connection}; turn on Preview branching and "Create a branch for your development environment" (required: later runs recognise the connection by its ${devBranchName} branch). Needed even when Vercel gives Neon access to all projects`
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
    const sandbox: Sandbox =
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
    const remaining = previews.records

    // Production ---------------------------------------------------------------
    const production = yield* ensureProject(
      context,
      admin,
      context.names.production,
      'production',
      { historyRetentionSeconds: neonProductionHistoryRetentionSeconds }
    )

    if (Option.isNone(production)) return

    if (previews.status !== 'connected') {
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

      if (decision === 'reuse') return yield* previewCheck(context, previews.fresh)
    }

    yield* writeUrls
    yield* previewCheck(context, previews.fresh)
  })

/** After connecting: what proves Preview databases work, which only a deployment can show. */
const previewCheck = (context: FactoryContext, fresh: boolean) =>
  fresh
    ? Console.log(
        `  manual: check the first Preview deployment: it should create branch preview/<git-branch> in ${context.names.development}, and its build should run the migrations`
      )
    : Effect.void
