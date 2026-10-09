import { describe, expect, it } from '@effect/vitest'
import { contractFor } from './contract.ts'

describe('contract', () => {
  // Snapshot of the public contract: changing it is a deliberate, documented act.
  it('keeps the published shape', () => {
    expect(contractFor('1.2.3')).toEqual({
      contractVersion: 1,
      provisionVersion: '1.2.3',
      commands: ['contract', 'config', 'factory', 'env', 'db']
    })
  })
})
