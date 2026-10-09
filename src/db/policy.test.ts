import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Branch, Lease } from './domain.ts'
import {
  ensureLeaseProfile,
  parseTtl,
  validateDeletionTarget,
  validateLeaseName
} from './policy.ts'

const lease: Lease = {
  version: 2,
  leaseName: 'default',
  projectId: 'project',
  parentBranch: 'parent',
  branchId: 'branch',
  branchName: 'agent/repo-feature-123456',
  worktree: '/repo',
  repository: 'owner/repo',
  label: 'feature',
  configEnvFile: '/repo/.env.local',
  envFile: '/repo/.env.local',
  envKeys: ['DATABASE_URL'],
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-08T00:00:00Z'
}

const branch = (overrides: Partial<Branch> = {}): Branch => ({
  id: 'branch',
  name: lease.branchName,
  parent_id: lease.parentBranch,
  default: false,
  protected: false,
  ...overrides
})

const failureMessage = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map(error => error.message)
  )

describe('lease policy', () => {
  it.effect('requires a positive TTL no greater than seven days', () =>
    Effect.gen(function* () {
      expect(yield* parseTtl('7d')).toBe(604800)
      expect(yield* parseTtl('90m')).toBe(5400)
      expect(yield* failureMessage(parseTtl('8d'))).toContain('maximum of 7d')
      expect(yield* failureMessage(parseTtl('0s'))).toContain('positive')
      expect(yield* failureMessage(parseTtl('forever'))).toContain('invalid ttl')
    })
  )

  it.effect('accepts only simple lease slot names', () =>
    Effect.gen(function* () {
      expect(yield* validateLeaseName('test')).toBe('test')
      expect(yield* validateLeaseName('issue-4.v2_b')).toBe('issue-4.v2_b')
      yield* failureMessage(validateLeaseName('-leading'))
      yield* failureMessage(validateLeaseName('../escape'))
      yield* failureMessage(validateLeaseName('a'.repeat(65)))
    })
  )

  it.effect('rejects wrong project and parent profiles', () =>
    Effect.gen(function* () {
      expect(
        yield* failureMessage(
          ensureLeaseProfile({ projectId: 'other', parentBranch: 'parent' }, lease)
        )
      ).toContain('belongs to Neon project')
      expect(
        yield* failureMessage(
          ensureLeaseProfile({ projectId: 'project', parentBranch: 'other' }, lease)
        )
      ).toContain('belongs to parent branch')
    })
  )

  it.effect.each([
    [{ ...lease, branchName: 'main' }, branch({ name: 'main' })],
    [lease, branch({ id: 'replacement-id' })],
    [lease, branch({ name: 'agent/replacement' })],
    [lease, branch({ parent_id: 'other-parent' })],
    [lease, branch({ id: lease.parentBranch })],
    [lease, branch({ default: true })],
    [lease, branch({ default: undefined })],
    [lease, branch({ protected: true })],
    [lease, branch({ protected: undefined })]
  ] as const)('refuses unsafe deletion targets', ([record, providerBranch]) =>
    Effect.gen(function* () {
      expect(yield* failureMessage(validateDeletionTarget(record, providerBranch))).toContain(
        'does not exactly match'
      )
    })
  )

  it.effect('allows only the exact unprotected recorded agent branch', () =>
    validateDeletionTarget(lease, branch())
  )
})
