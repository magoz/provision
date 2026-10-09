import { Effect, Option, Redacted, Schedule, Schema } from 'effect'
import { ProviderError, requestJson, requestJsonRequired } from '../http.ts'

const API_ROOT = 'https://console.neon.tech/api/v2'

export const neonRegion = 'aws-eu-central-1'

export const neonPgVersion = 18

/** Production keeps a 7-day restore window. */
export const neonProductionHistoryRetentionSeconds = 7 * 24 * 3600

export interface NeonAdmin {
  readonly apiKey: Redacted.Redacted<string>
  readonly orgId: string
}

const headers = (admin: NeonAdmin) => ({ Authorization: `Bearer ${Redacted.value(admin.apiKey)}` })

const Project = Schema.Struct({ id: Schema.String, name: Schema.String })

const Branch = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  default: Schema.optional(Schema.Boolean),
  protected: Schema.optional(Schema.Boolean)
})

export type NeonBranch = typeof Branch.Type

const Database = Schema.Struct({ name: Schema.String, owner_name: Schema.String })

export const findProject = (admin: NeonAdmin, name: string) =>
  Effect.gen(function* () {
    const query = new URLSearchParams({ org_id: admin.orgId, search: name, limit: '100' })
    const response = yield* requestJsonRequired(
      'Neon project lookup',
      `${API_ROOT}/projects?${query.toString()}`,
      Schema.Struct({ projects: Schema.Array(Project) }),
      { headers: headers(admin) }
    )
    const matches = response.projects.filter(project => project.name === name)

    if (matches.length > 1) {
      return yield* new ProviderError({ message: `several Neon projects are named ${name}` })
    }

    return Option.fromUndefinedOr(matches[0])
  })

export const createProject = (
  admin: NeonAdmin,
  options: {
    readonly name: string
    readonly branchName: string
    readonly historyRetentionSeconds?: number
  }
) =>
  requestJsonRequired(
    'Neon project creation',
    `${API_ROOT}/projects`,
    Schema.Struct({ project: Project, branch: Branch }),
    {
      method: 'POST',
      headers: headers(admin),
      body: {
        project: {
          name: options.name,
          org_id: admin.orgId,
          region_id: neonRegion,
          pg_version: neonPgVersion,
          branch: { name: options.branchName },
          ...(options.historyRetentionSeconds === undefined
            ? {}
            : { history_retention_seconds: options.historyRetentionSeconds })
        }
      }
    }
  )

export const listBranches = (admin: NeonAdmin, projectId: string) =>
  requestJsonRequired(
    'Neon branch listing',
    `${API_ROOT}/projects/${encodeURIComponent(projectId)}/branches`,
    Schema.Struct({ branches: Schema.Array(Branch) }),
    { headers: headers(admin) }
  ).pipe(Effect.map(response => response.branches))

/** Neon rejects changes while project operations run (423/409); retry briefly. */
const whileLocked = Schedule.max([Schedule.spaced('1 second'), Schedule.recurs(30)])

export const protectBranch = (admin: NeonAdmin, projectId: string, branchId: string) =>
  requestJsonRequired(
    'Neon branch protection',
    `${API_ROOT}/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    Schema.Struct({ branch: Branch }),
    { method: 'PATCH', headers: headers(admin), body: { branch: { protected: true } } }
  ).pipe(
    Effect.retry({
      schedule: whileLocked,
      while: error => error.status === 423 || error.status === 409
    })
  )

export const connectionUri = (
  admin: NeonAdmin,
  projectId: string,
  branchId: string,
  pooled: boolean
) =>
  Effect.gen(function* () {
    const databases = yield* requestJsonRequired(
      'Neon database listing',
      `${API_ROOT}/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/databases`,
      Schema.Struct({ databases: Schema.Array(Database) }),
      { headers: headers(admin) }
    )
    const database = databases.databases.length === 1 ? databases.databases[0] : undefined

    if (database === undefined) {
      return yield* new ProviderError({
        message: `expected one database on Neon branch ${branchId}, found ${databases.databases.length}`
      })
    }

    const query = new URLSearchParams({
      branch_id: branchId,
      database_name: database.name,
      role_name: database.owner_name,
      pooled: String(pooled)
    })

    const response = yield* requestJsonRequired(
      'Neon connection URI',
      `${API_ROOT}/projects/${encodeURIComponent(projectId)}/connection_uri?${query.toString()}`,
      Schema.Struct({ uri: Schema.String }),
      { headers: headers(admin) }
    )

    return Redacted.make(response.uri)
  }).pipe(
    Effect.retry({
      schedule: whileLocked,
      while: error => error.status === 423 || error.status === 409
    })
  )

const ApiKey = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  project_id: Schema.optional(Schema.String)
})

export const findApiKey = (admin: NeonAdmin, name: string) =>
  requestJsonRequired(
    'Neon API key listing',
    `${API_ROOT}/organizations/${encodeURIComponent(admin.orgId)}/api_keys`,
    Schema.Array(ApiKey),
    { headers: headers(admin) }
  ).pipe(
    Effect.flatMap(keys => {
      const matches = keys.filter(key => key.name === name)

      return matches.length > 1
        ? Effect.fail(new ProviderError({ message: `several Neon API keys are named ${name}` }))
        : Effect.succeed(Option.map(Option.fromUndefinedOr(matches[0]), key => String(key.id)))
    })
  )

export const createProjectApiKey = (admin: NeonAdmin, name: string, projectId: string) =>
  requestJsonRequired(
    'Neon API key creation',
    `${API_ROOT}/organizations/${encodeURIComponent(admin.orgId)}/api_keys`,
    Schema.Struct({ id: Schema.Number, key: Schema.String }),
    { method: 'POST', headers: headers(admin), body: { key_name: name, project_id: projectId } }
  ).pipe(Effect.map(created => ({ id: String(created.id), key: Redacted.make(created.key) })))

export const revokeApiKey = (admin: NeonAdmin, keyId: string) =>
  requestJson(
    'Neon API key revocation',
    `${API_ROOT}/organizations/${encodeURIComponent(admin.orgId)}/api_keys/${encodeURIComponent(keyId)}`,
    Schema.Unknown,
    { method: 'DELETE', headers: headers(admin), allowNotFound: true }
  ).pipe(Effect.asVoid)
