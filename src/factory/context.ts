import { Console, Data, Effect, Option, Semaphore, type Redacted } from 'effect'
import { Prompt } from 'effect/cli'
import type { RepoConfig } from '../shared/repo-config.ts'
import type { FactoryCredentials } from './onepassword.ts'
import {
  createEnvRecord,
  deleteEnvRecord,
  getProject,
  listCustomEnvironments,
  listEnvRecords,
  recordTargets,
  type EnvRecord,
  type VercelProject,
  type VercelTarget
} from './vercel-api.ts'

export class FactoryError extends Data.TaggedError('FactoryError')<{
  readonly message: string
}> {}

export const onExistingPolicies = ['ask', 'reuse', 'overwrite', 'abort'] as const

export type OnExisting = (typeof onExistingPolicies)[number]

/**
 * What already exists:
 * - `data`: holds data (Neon projects, R2 buckets, Upstash teams, the Vercel project); never
 *   deleted or replaced, only reused;
 * - `key`: a scoped credential; overwriting rotates it;
 * - `secret`: a generated app secret; overwriting invalidates what depends on it.
 */
export type ResourceKind = 'data' | 'key' | 'secret'

export interface FactoryContext {
  readonly factory: string
  readonly credentials: FactoryCredentials
  readonly checkout: {
    readonly root: string
    readonly owner: string
    readonly name: string
    /** `owner/name` */
    readonly repository: string
  }
  readonly repoConfig: RepoConfig
  /** Absolute app directory (monorepo `provision.appDir`). */
  readonly appDirectory: string
  readonly domain: string | undefined
  readonly senderName: string
  /** Sender address for `AUTH_EMAIL_FROM`; defaults to `noreply@<resend.sending_domain>`. */
  readonly emailFrom: string | undefined
  readonly neonParentBranch: string | undefined
  readonly dryRun: boolean
  readonly onExisting: OnExisting
  readonly names: {
    readonly project: string
    readonly development: string
    readonly production: string
  }
}

export const factoryError = (message: string) => new FactoryError({ message })

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true

/** Concurrent steps share one terminal: one prompt at a time. */
const promptLock = Semaphore.makeUnsafe(1)

/** Decides what to do with an existing resource: `reuse` or `overwrite` (abort fails). */
export const decide = (context: FactoryContext, kind: ResourceKind, description: string) =>
  Effect.gen(function* () {
    if (context.dryRun) {
      yield* Console.log(`  exists: ${description} (on-existing=${context.onExisting})`)

      return 'reuse' as const
    }

    if (context.onExisting === 'abort') {
      return yield* factoryError(`${description} already exists (--on-existing=abort)`)
    }

    if (context.onExisting === 'reuse') return 'reuse' as const

    if (context.onExisting === 'overwrite') {
      if (kind === 'data') {
        yield* Console.log(`  reusing ${description}: data is never overwritten`)

        return 'reuse' as const
      }

      return 'overwrite' as const
    }

    if (!interactive()) {
      return yield* factoryError(
        `${description} already exists and prompting is unavailable; pass --on-existing`
      )
    }

    const warning =
      kind === 'secret'
        ? ' (overwriting invalidates sessions, encrypted data, or subscriptions that depend on it)'
        : kind === 'key'
          ? ' (overwriting rotates the key)'
          : ''

    const choice = yield* Prompt.run(
      Prompt.Select({
        message: `${description} already exists${warning}`,
        choices: [
          { title: 'Reuse', value: 'reuse' as const },
          ...(kind === 'data' ? [] : [{ title: 'Overwrite', value: 'overwrite' as const }]),
          { title: 'Abort', value: 'abort' as const }
        ]
      })
    ).pipe(
      Effect.mapError(() => factoryError('cancelled')),
      promptLock.withPermits(1)
    )

    if (choice === 'abort') return yield* factoryError(`aborted at ${description}`)

    return choice
  })

/** Runs a mutation, or only describes it in a dry run (`None`). */
export const mutate = <A, E, R>(
  context: FactoryContext,
  description: string,
  effect: Effect.Effect<A, E, R>
) =>
  context.dryRun
    ? Console.log(`  would ${description}`).pipe(Effect.as(Option.none<A>()))
    : Console.log(`  ${description}`).pipe(Effect.andThen(effect), Effect.map(Option.some))

// ---------------------------------------------------------------------------
// Vercel project and environment groups
// ---------------------------------------------------------------------------

export interface ProjectHandle {
  readonly project: VercelProject
  readonly testEnvironmentId: string | undefined
}

/** The company Vercel project and its `test` environment, created by the `vercel` step. */
export const findProject = (context: FactoryContext) =>
  Effect.gen(function* () {
    const teamId = context.credentials.vercel.teamId
    const project = yield* getProject(teamId, context.names.project)

    if (Option.isNone(project)) return Option.none<ProjectHandle>()

    const environments = yield* listCustomEnvironments(teamId, project.value.id)

    return Option.some<ProjectHandle>({
      project: project.value,
      testEnvironmentId: environments.find(environment => environment.slug === 'test')?.id
    })
  })

/** Steps after `vercel` need the project; in a dry run on a fresh repository it does not exist. */
export const requireProject = (context: FactoryContext) =>
  findProject(context).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          context.dryRun
            ? Effect.succeed(Option.none<ProjectHandle>())
            : Effect.fail(
                factoryError(
                  `Vercel project ${context.names.project} does not exist; run the vercel step first`
                )
              ),
        onSome: handle =>
          handle.testEnvironmentId === undefined && !context.dryRun
            ? Effect.fail(
                factoryError('Vercel project has no test environment; run the vercel step')
              )
            : Effect.succeed(Option.some(handle))
      })
    )
  )

export interface EnvGroup {
  readonly label: string
  readonly target: ReadonlyArray<VercelTarget>
  readonly customEnvironmentIds: ReadonlyArray<string>
}

/** Development + Preview + `test` vs Production, plus single-target groups. */
export const envGroups = (handle: ProjectHandle) => {
  const test = handle.testEnvironmentId === undefined ? [] : [handle.testEnvironmentId]

  return {
    preproduction: {
      label: 'Development, Preview, test',
      target: ['development', 'preview'],
      customEnvironmentIds: test
    },
    production: { label: 'Production', target: ['production'], customEnvironmentIds: [] },
    development: { label: 'Development', target: ['development'], customEnvironmentIds: [] },
    test: { label: 'test', target: [], customEnvironmentIds: test },
    all: {
      label: 'all environments',
      target: ['development', 'preview', 'production'],
      customEnvironmentIds: test
    }
  } satisfies Record<string, EnvGroup>
}

const covers = (record: EnvRecord, group: EnvGroup) => {
  const targets = recordTargets(record)
  const custom = record.customEnvironmentIds ?? []

  return (
    group.target.every(target => targets.includes(target)) &&
    group.customEnvironmentIds.every(id => custom.includes(id))
  )
}

const overlaps = (record: EnvRecord, group: EnvGroup) =>
  recordTargets(record).some(target => group.target.some(wanted => wanted === target)) ||
  (record.customEnvironmentIds ?? []).some(id => group.customEnvironmentIds.includes(id))

const containedIn = (record: EnvRecord, group: EnvGroup) =>
  recordTargets(record).every(target => group.target.some(wanted => wanted === target)) &&
  (record.customEnvironmentIds ?? []).every(id => group.customEnvironmentIds.includes(id))

/** Whether every key has a record covering the whole group. */
export const groupHasKeys = (
  records: ReadonlyArray<EnvRecord>,
  group: EnvGroup,
  keys: ReadonlyArray<string>
) => keys.every(key => records.some(record => record.key === key && covers(record, group)))

export interface EnvEntry {
  readonly key: string
  readonly value: Redacted.Redacted<string>
  readonly type: 'plain' | 'encrypted' | 'sensitive'
}

/**
 * Replaces the group's records for each key: overlapping records are deleted, then one record per
 * key is created. A record that spans environments outside the group is never touched.
 */
export const writeGroup = (
  context: FactoryContext,
  handle: ProjectHandle,
  group: EnvGroup,
  entries: ReadonlyArray<EnvEntry>
) =>
  mutate(
    context,
    `write ${entries.map(entry => entry.key).join(', ')} to Vercel (${group.label})`,
    Effect.gen(function* () {
      const teamId = context.credentials.vercel.teamId
      const records = yield* listEnvRecords(teamId, handle.project.id)

      for (const entry of entries) {
        const existing = records.filter(
          record => record.key === entry.key && overlaps(record, group)
        )
        const spanning = existing.filter(record => !containedIn(record, group))

        if (spanning.length > 0) {
          return yield* factoryError(
            `Vercel ${entry.key} has a record that also targets environments outside ${group.label}; split it manually`
          )
        }

        for (const record of existing) yield* deleteEnvRecord(teamId, handle.project.id, record.id)

        yield* createEnvRecord(teamId, handle.project.id, {
          key: entry.key,
          value: entry.value,
          type: entry.type,
          target: group.target,
          customEnvironmentIds: group.customEnvironmentIds
        })
      }
    })
  )
