import { Effect, Option, Predicate, Redacted, Schema } from 'effect'
import { capture } from '../shared/process.ts'
import { ProviderError } from './http.ts'

/**
 * Vercel REST calls through the operator's authenticated `vercel` CLI (`vercel api`), always
 * scoped to the factory's immutable `team_*` id. Request bodies go through stdin, so secret values
 * never appear in argv; responses and diagnostics are never printed.
 */
const vercelApi = (
  teamId: string,
  label: string,
  path: string,
  options: { readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly body?: unknown } = {}
) =>
  Effect.gen(function* () {
    const method = options.method ?? 'GET'
    const separator = path.includes('?') ? '&' : '?'
    const scopedPath = `${path}${separator}teamId=${encodeURIComponent(teamId)}`
    const args = ['api', scopedPath, '--raw', '--non-interactive', '--no-color', '--scope', teamId]

    if (method !== 'GET') args.push('-X', method)

    if (method === 'DELETE') args.push('--dangerously-skip-permissions')

    if (options.body !== undefined) args.push('--input', '-')

    const result = yield* capture(
      'vercel',
      args,
      options.body === undefined ? {} : { input: JSON.stringify(options.body) }
    ).pipe(
      Effect.mapError(
        () => new ProviderError({ message: 'Vercel CLI (vercel) could not be started' })
      )
    )

    if (result.exitCode !== 0) {
      const status = /\(\s*(\d{3})\s*\)\s*$/u.exec(result.stderr.trim())?.[1]

      if (status === '404') return Option.none<unknown>()

      return yield* new ProviderError({
        message: `${label} failed${status === undefined ? '' : ` (${status})`}; Vercel response suppressed`,
        ...(status === undefined ? {} : { status: Number(status) })
      })
    }

    if (result.stdout.trim() === '') return Option.some<unknown>(undefined)

    return yield* Effect.try({
      try: (): unknown => JSON.parse(result.stdout),
      catch: () => new ProviderError({ message: `${label}: Vercel returned invalid JSON` })
    }).pipe(Effect.map(Option.some))
  })

const decode = <S extends Schema.Constraint>(label: string, schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new ProviderError({ message: `${label}: unexpected Vercel response shape` })
    )
  )

const required = <A>(label: string, value: Option.Option<A>) =>
  Option.match(value, {
    onNone: () => Effect.fail(new ProviderError({ message: `${label}: not found` })),
    onSome: Effect.succeed
  })

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const VercelProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootDirectory: Schema.optional(Schema.NullOr(Schema.String)),
  link: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        org: Schema.optional(Schema.String),
        repo: Schema.optional(Schema.String)
      })
    )
  )
})

export type VercelProject = typeof VercelProject.Type

/** `owner/repo` of a project's Git link, when linked to GitHub. */
export const linkedRepository = (project: VercelProject) => {
  const link = project.link

  if (link === undefined || link === null || link.type !== 'github') return undefined

  return link.org !== undefined && link.repo !== undefined ? `${link.org}/${link.repo}` : link.repo
}

export const getProject = (teamId: string, name: string) =>
  vercelApi(teamId, 'project lookup', `/v9/projects/${encodeURIComponent(name)}`).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<VercelProject>()),
        onSome: value =>
          decode('project lookup', VercelProject, value).pipe(Effect.map(Option.some))
      })
    )
  )

export const createProject = (
  teamId: string,
  options: { readonly name: string; readonly repository: string; readonly rootDirectory: string }
) =>
  vercelApi(teamId, 'project creation', '/v11/projects', {
    method: 'POST',
    body: {
      name: options.name,
      framework: 'nextjs',
      gitRepository: { type: 'github', repo: options.repository },
      ...(options.rootDirectory === '.' ? {} : { rootDirectory: options.rootDirectory })
    }
  }).pipe(
    Effect.flatMap(value => required('project creation', value)),
    Effect.flatMap(value => decode('project creation', VercelProject, value))
  )

export const setRootDirectory = (teamId: string, projectId: string, rootDirectory: string) =>
  vercelApi(teamId, 'project update', `/v9/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: { rootDirectory: rootDirectory === '.' ? null : rootDirectory }
  }).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// custom environments
// ---------------------------------------------------------------------------

const CustomEnvironment = Schema.Struct({ id: Schema.String, slug: Schema.String })

const CustomEnvironmentList = Schema.Struct({ environments: Schema.Array(CustomEnvironment) })

export const listCustomEnvironments = (teamId: string, projectId: string) =>
  vercelApi(
    teamId,
    'custom environment listing',
    `/v9/projects/${encodeURIComponent(projectId)}/custom-environments`
  ).pipe(
    Effect.flatMap(value => required('custom environment listing', value)),
    Effect.flatMap(value => decode('custom environment listing', CustomEnvironmentList, value)),
    Effect.map(list => list.environments)
  )

export const createCustomEnvironment = (teamId: string, projectId: string, slug: string) =>
  vercelApi(
    teamId,
    'custom environment creation',
    `/v9/projects/${encodeURIComponent(projectId)}/custom-environments`,
    { method: 'POST', body: { slug, description: 'Disposable end-to-end test configuration' } }
  ).pipe(
    Effect.flatMap(value => required('custom environment creation', value)),
    Effect.flatMap(value => decode('custom environment creation', CustomEnvironment, value))
  )

// ---------------------------------------------------------------------------
// environment variables
// ---------------------------------------------------------------------------

export type VercelTarget = 'production' | 'preview' | 'development'

export const EnvRecord = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  type: Schema.String,
  target: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  customEnvironmentIds: Schema.optional(Schema.Array(Schema.String)),
  /** Set when an integration owns the record (for example Neon's Vercel integration). */
  configurationId: Schema.optional(Schema.NullOr(Schema.String))
})

export type EnvRecord = typeof EnvRecord.Type

const EnvList = Schema.Struct({
  envs: Schema.Array(EnvRecord),
  pagination: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        next: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))
      })
    )
  )
})

export const recordTargets = (record: EnvRecord): ReadonlyArray<string> =>
  record.target === undefined
    ? []
    : Predicate.isString(record.target)
      ? [record.target]
      : record.target

export const listEnvRecords = (teamId: string, projectId: string) =>
  Effect.gen(function* () {
    const records: Array<EnvRecord> = []
    const seen = new Set<string>()
    let until: string | undefined

    do {
      const query = new URLSearchParams({ limit: '100' })

      if (until !== undefined) query.set('until', until)

      const value = yield* vercelApi(
        teamId,
        'environment variable listing',
        `/v10/projects/${encodeURIComponent(projectId)}/env?${query.toString()}`
      ).pipe(Effect.flatMap(found => required('environment variable listing', found)))

      const page = yield* decode('environment variable listing', EnvList, value)
      records.push(...page.envs)
      const next = page.pagination?.next
      until = next === undefined || next === null ? undefined : String(next)

      if (until !== undefined && seen.has(until)) {
        return yield* new ProviderError({ message: 'Vercel environment pagination cycled' })
      }

      if (until !== undefined) seen.add(until)
    } while (until !== undefined)

    return records
  })

export const createEnvRecord = (
  teamId: string,
  projectId: string,
  record: {
    readonly key: string
    readonly value: Redacted.Redacted<string>
    readonly type: 'plain' | 'encrypted' | 'sensitive'
    readonly target: ReadonlyArray<VercelTarget>
    readonly customEnvironmentIds: ReadonlyArray<string>
  }
) =>
  vercelApi(
    teamId,
    `environment variable ${record.key}`,
    `/v10/projects/${encodeURIComponent(projectId)}/env`,
    {
      method: 'POST',
      body: {
        key: record.key,
        value: Redacted.value(record.value),
        type: record.type,
        ...(record.target.length > 0 ? { target: record.target } : {}),
        ...(record.customEnvironmentIds.length > 0
          ? { customEnvironmentIds: record.customEnvironmentIds }
          : {}),
        comment: 'Managed by provision factory'
      }
    }
  ).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// integrations
// ---------------------------------------------------------------------------

const IntegrationConfiguration = Schema.Struct({
  id: Schema.String,
  slug: Schema.optional(Schema.String),
  /** Projects the team gave the integration access to; `null` or absent means all projects. */
  projects: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))
})

const IntegrationConfigurations = Schema.Union([
  Schema.Array(IntegrationConfiguration),
  Schema.Struct({ configurations: Schema.Array(IntegrationConfiguration) })
])

/** The team's installations of the integration `slug` (for example `neon`). */
export const listIntegrationConfigurations = (teamId: string, slug: string) =>
  vercelApi(
    teamId,
    'integration listing',
    `/v1/integrations/configurations?view=account&integrationIdOrSlug=${encodeURIComponent(slug)}`
  ).pipe(
    Effect.flatMap(found => required('integration listing', found)),
    Effect.flatMap(value => decode('integration listing', IntegrationConfigurations, value)),
    Effect.map(decoded =>
      ('configurations' in decoded ? decoded.configurations : decoded).filter(
        configuration => configuration.slug === undefined || configuration.slug === slug
      )
    )
  )

export const deleteEnvRecord = (teamId: string, projectId: string, recordId: string) =>
  vercelApi(
    teamId,
    'environment variable deletion',
    `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' }
  ).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------

const ProjectDomain = Schema.Struct({
  name: Schema.String,
  verified: Schema.optional(Schema.Boolean)
})

export type ProjectDomain = typeof ProjectDomain.Type

export const getProjectDomain = (teamId: string, projectId: string, domain: string) =>
  vercelApi(
    teamId,
    'domain lookup',
    `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`
  ).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ProjectDomain>()),
        onSome: value => decode('domain lookup', ProjectDomain, value).pipe(Effect.map(Option.some))
      })
    )
  )

export const addProjectDomain = (teamId: string, projectId: string, domain: string) =>
  vercelApi(teamId, 'domain creation', `/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    method: 'POST',
    body: { name: domain }
  }).pipe(
    Effect.flatMap(value => required('domain creation', value)),
    Effect.flatMap(value => decode('domain creation', ProjectDomain, value))
  )
