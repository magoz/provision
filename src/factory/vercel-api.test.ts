import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { regionUpdate, VercelProject } from './vercel-api.ts'

const project = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(VercelProject)({ id: 'prj_1', name: 'acme-app', ...fields })

describe('regionUpdate', () => {
  it('changes nothing for a project already in fra1', () => {
    expect(
      regionUpdate(
        project({
          resourceConfig: { functionDefaultRegions: ['fra1'] },
          sandbox: { region: 'fra1', failoverRegions: ['cdg1'] }
        })
      )
    ).toBeUndefined()
  })

  it('moves a project whose settings are absent or null', () => {
    const everything = {
      resourceConfig: { functionDefaultRegions: ['fra1'] },
      sandbox: { region: 'fra1', failoverRegions: [] }
    }

    expect(regionUpdate(project({}))).toEqual(everything)
    expect(regionUpdate(project({ resourceConfig: null, sandbox: null }))).toEqual(everything)
    expect(
      regionUpdate(
        project({
          resourceConfig: { functionDefaultRegions: null },
          sandbox: { region: null, failoverRegions: null }
        })
      )
    ).toEqual(everything)
  })

  it('moves functions that also run outside fra1', () => {
    expect(
      regionUpdate(
        project({
          resourceConfig: { functionDefaultRegions: ['iad1', 'fra1'] },
          sandbox: { region: 'fra1' }
        })
      )
    ).toEqual({ resourceConfig: { functionDefaultRegions: ['fra1'] } })
  })

  it('keeps sandbox failovers other than fra1', () => {
    expect(
      regionUpdate(
        project({
          resourceConfig: { functionDefaultRegions: ['fra1'] },
          sandbox: { region: 'iad1', failoverRegions: ['fra1', 'cdg1'] }
        })
      )
    ).toEqual({ sandbox: { region: 'fra1', failoverRegions: ['cdg1'] } })
  })
})
