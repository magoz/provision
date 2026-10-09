import { Data, Schema } from 'effect'

/** Policy: leases are short-lived by construction. */
export const BRANCH_PREFIX = 'agent/'

export const MAX_TTL_SECONDS = 7 * 24 * 3600

export const SUSPEND_TIMEOUT_SECONDS = 300

export const READY_TIMEOUT_SECONDS = 90

export class ConfigurationError extends Data.TaggedError('ConfigurationError')<{
  readonly message: string
}> {}

export class PolicyError extends Data.TaggedError('PolicyError')<{
  readonly message: string
}> {}

export class NeonError extends Data.TaggedError('NeonError')<{
  readonly message: string
}> {}

export class LeaseError extends Data.TaggedError('LeaseError')<{
  readonly message: string
}> {}

export class LifecycleError extends Data.TaggedError('LifecycleError')<{
  readonly message: string
}> {}

/** Neon branch, narrowed to the fields this tool relies on. */
export const Branch = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parent_id: Schema.optional(Schema.String),
  current_state: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Boolean),
  protected: Schema.optional(Schema.Boolean),
  expires_at: Schema.optional(Schema.String),
  ttl_interval_seconds: Schema.optional(Schema.Number)
})

export type Branch = typeof Branch.Type

/**
 * Connection material stays `Redacted` end to end. It is unwrapped only at the single boundary
 * that writes the worktree env file.
 */
const RedactedString = Schema.RedactedFromValue(Schema.String)

export const BranchResponse = Schema.Struct({ branch: Branch })

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})

export type Project = typeof Project.Type

export const ProjectResponse = Schema.Struct({ project: Project })

export const CreateBranchResponse = Schema.Struct({ branch: Branch })

export const BranchListResponse = Schema.Struct({
  branches: Schema.Array(Branch),
  pagination: Schema.optional(Schema.Struct({ cursor: Schema.optional(Schema.String) }))
})

export const Database = Schema.Struct({
  name: Schema.String,
  owner_name: Schema.String
})

export const DatabaseListResponse = Schema.Struct({
  databases: Schema.Array(Database)
})

export const ConnectionUriResponse = Schema.Struct({ uri: RedactedString })

/** Legacy single-lease records remain readable as the `default` lease. */
const LegacyLease = Schema.Struct({
  version: Schema.Literal(1),
  projectId: Schema.String,
  parentBranch: Schema.String,
  branchId: Schema.String,
  branchName: Schema.String,
  worktree: Schema.String,
  repository: Schema.String,
  label: Schema.String,
  envFile: Schema.String,
  envKeys: Schema.Array(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String
})

/** Lease records are persisted outside the repository and hold no secrets. */
export const Lease = Schema.Struct({
  version: Schema.Literal(2),
  leaseName: Schema.String,
  projectId: Schema.String,
  parentBranch: Schema.String,
  branchId: Schema.String,
  branchName: Schema.String,
  worktree: Schema.String,
  repository: Schema.String,
  label: Schema.String,
  configEnvFile: Schema.String,
  envFile: Schema.String,
  envKeys: Schema.Array(Schema.String),
  databaseName: Schema.optionalKey(Schema.String),
  roleName: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String
})

export type Lease = typeof Lease.Type

export const LeaseRecord = Schema.Union([LegacyLease, Lease])

export type LeaseRecord = typeof LeaseRecord.Type

export const LeaseRecordFromJson = Schema.fromJsonString(LeaseRecord)

export const LeaseFromJson = Schema.fromJsonString(Lease)

export const normalizeLease = (lease: LeaseRecord): Lease =>
  lease.version === 2
    ? lease
    : {
        version: 2,
        leaseName: 'default',
        projectId: lease.projectId,
        parentBranch: lease.parentBranch,
        branchId: lease.branchId,
        branchName: lease.branchName,
        worktree: lease.worktree,
        repository: lease.repository,
        label: lease.label,
        configEnvFile: lease.envFile,
        envFile: lease.envFile,
        envKeys: lease.envKeys,
        createdAt: lease.createdAt,
        expiresAt: lease.expiresAt
      }
