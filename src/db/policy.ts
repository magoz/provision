import { Effect } from 'effect'
import { BRANCH_PREFIX, MAX_TTL_SECONDS, PolicyError, type Branch, type Lease } from './domain.ts'

const ttlUnits = { s: 1, m: 60, h: 3600, d: 86400 } as const

const isTtlUnit = (unit: string): unit is keyof typeof ttlUnits => unit in ttlUnits

export const parseTtl = (value: string) =>
  Effect.gen(function* () {
    const match = /^(\d+)([smhd])$/.exec(value.trim().toLowerCase())
    const amount = match?.[1]
    const unit = match?.[2]

    if (amount === undefined || unit === undefined || !isTtlUnit(unit)) {
      return yield* new PolicyError({
        message: `invalid ttl ${value}; use forms like 12h, 3d, 90m`
      })
    }

    const seconds = Number(amount) * ttlUnits[unit]

    if (seconds <= 0) return yield* new PolicyError({ message: 'ttl must be positive' })

    if (seconds > MAX_TTL_SECONDS) {
      return yield* new PolicyError({
        message: `ttl exceeds policy maximum of ${MAX_TTL_SECONDS / 86400}d`
      })
    }

    return seconds
  })

export const validateLeaseName = (leaseName: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(leaseName)
    ? Effect.succeed(leaseName)
    : Effect.fail(
        new PolicyError({
          message: '--lease must be 1-64 letters, digits, dots, underscores, or hyphens'
        })
      )

export const ensureLeaseProfile = (
  config: { readonly projectId: string; readonly parentBranch: string },
  lease: Lease
) => {
  if (config.projectId !== lease.projectId) {
    return Effect.fail(
      new PolicyError({
        message:
          `lease belongs to Neon project ${lease.projectId}, but the resolved profile selects ${config.projectId}\n` +
          'restore the original worktree environment before managing this lease'
      })
    )
  }

  if (config.parentBranch !== lease.parentBranch) {
    return Effect.fail(
      new PolicyError({
        message:
          `lease belongs to parent branch ${lease.parentBranch}, but the resolved profile selects ${config.parentBranch}\n` +
          'release the existing lease before changing its parent branch'
      })
    )
  }

  return Effect.void
}

export interface BranchIdentity {
  readonly branchId: string
  readonly branchName: string
  readonly parentBranch: string
}

/** The provider branch is exactly the recorded, non-default, unprotected agent branch. */
export const branchMatchesExactIdentity = (
  expected: BranchIdentity,
  branch: Branch,
  expiresAt?: string
) =>
  expected.branchId.length > 0 &&
  expected.branchId !== expected.parentBranch &&
  expected.branchName.startsWith(BRANCH_PREFIX) &&
  branch.id === expected.branchId &&
  branch.name === expected.branchName &&
  branch.parent_id === expected.parentBranch &&
  branch.default === false &&
  branch.protected === false &&
  (expiresAt === undefined || branch.expires_at === expiresAt)

export const validateBranchIdentity = (
  expected: BranchIdentity,
  branch: Branch,
  expiresAt?: string
) =>
  branchMatchesExactIdentity(expected, branch, expiresAt)
    ? Effect.void
    : Effect.fail(
        new PolicyError({
          message:
            'provider branch does not exactly match the recorded non-default, unprotected agent lease'
        })
      )

export const validateDeletionTarget = (lease: Lease, branch: Branch) =>
  validateBranchIdentity(lease, branch)
