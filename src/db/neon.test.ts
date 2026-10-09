import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Fiber, Layer, Predicate, Redacted } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/http'
import {
  attestSandboxProfile,
  createBranch,
  deleteVerifiedBranch,
  listBranches,
  setExpiration,
  waitUntilReady
} from './neon.ts'

const config = { apiKey: Redacted.make('raw-api-key-sentinel'), projectId: 'project' }

const branchConfig = { ...config, parentBranch: 'parent' }

interface Exchange {
  readonly method: string
  readonly url: string
  readonly request: HttpClientRequest.HttpClientRequest
}

/** A fake Neon API: `respond` sees the method and full URL (query included) of each request. */
const neon = (respond: (exchange: Exchange) => Response | Effect.Effect<Response>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const response = respond({ method: request.method, url: url.href, request })

      return (Effect.isEffect(response) ? response : Effect.succeed(response)).pipe(
        Effect.map(source => HttpClientResponse.fromWeb(request, source))
      )
    })
  )

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const empty = (status: number) => new Response(null, { status })

const safeBranch = {
  id: 'branch',
  name: 'agent/repo-test-123456',
  parent_id: 'parent',
  default: false,
  protected: false,
  expires_at: '2026-01-02T00:00:00Z'
}

const project = json({ project: { id: 'project', name: 'repo-dev' } })

const isBranches = (url: string) => /\/branches(\?.*)?$/.test(url)

const isBranch = (url: string) => url.endsWith('/branches/branch')

const isProject = (url: string) => url.endsWith('/projects/project')

const create = () =>
  createBranch(branchConfig, { name: safeBranch.name, expiresAt: safeBranch.expires_at })

const baselineNeon = (isProtected: boolean) =>
  neon(({ url }) =>
    isProject(url)
      ? project.clone()
      : json({
          branch: { id: 'parent', name: 'baseline', default: true, protected: isProtected }
        })
  )

describe('Neon boundary', () => {
  it.live('exhausts branch pages', () =>
    Effect.gen(function* () {
      const urls: Array<string> = []

      const branches = yield* listBranches(config).pipe(
        Effect.provide(
          neon(({ url }) => {
            urls.push(url)

            return url.includes('cursor=next')
              ? json({ branches: [{ id: 'b2', name: 'agent/two' }] })
              : json({
                  branches: [{ id: 'b1', name: 'agent/one' }],
                  pagination: { cursor: 'next' }
                })
          })
        )
      )

      expect(branches.map(branch => branch.id)).toEqual(['b1', 'b2'])
      expect(urls).toHaveLength(2)
    })
  )

  it.live('fails deterministically on pagination cursor cycles', () =>
    Effect.gen(function* () {
      const failure = yield* listBranches(config).pipe(
        Effect.provide(neon(() => json({ branches: [], pagination: { cursor: 'cycle' } }))),
        Effect.flip
      )

      expect(failure.message).toContain('cursor cycle')
    })
  )

  it.live('suppresses provider bodies, credentials, and URLs on failures', () =>
    Effect.gen(function* () {
      const sentinel = 'postgres://user:password@example.test/db?api=raw-api-key-sentinel'

      const failure = yield* listBranches(config).pipe(
        Effect.provide(neon(() => new Response(sentinel, { status: 500 }))),
        Effect.flip
      )

      expect(failure.message).toBe('branch listing failed (500); provider response suppressed')
      expect(JSON.stringify(failure)).not.toContain(sentinel)
      expect(JSON.stringify(failure)).not.toContain('raw-api-key-sentinel')
    })
  )

  it.live('uses a freshly observed exact branch and requests unprotected creation', () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly body?: unknown }> = []

      const created = yield* create().pipe(
        Effect.provide(
          neon(({ method, request, url }) => {
            const body =
              method === 'POST' && Predicate.isTagged(request.body, 'Uint8Array')
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : undefined

            requests.push({ method, body })

            if (isBranches(url)) {
              return method === 'GET' ? json({ branches: [] }) : json({ branch: safeBranch }, 201)
            }

            if (isBranch(url)) return json({ branch: safeBranch })

            if (url.endsWith('/branches/branch/databases')) {
              return json({ databases: [{ name: 'database', owner_name: 'role' }] })
            }

            return json({
              uri: url.includes('pooled=true') ? 'postgres://pooled' : 'postgres://direct'
            })
          })
        )
      )

      expect(created.branch).toEqual(safeBranch)
      expect(Redacted.value(created.pooled)).toBe('postgres://pooled')
      expect(Redacted.value(created.direct)).toBe('postgres://direct')
      expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({
        branch: { protected: false }
      })
      expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(0)
    })
  )

  it.live('cleans the acquired exact branch when interrupted before connection publication', () =>
    Effect.gen(function* () {
      let connectionStarted = false
      let deleted = false

      const layer = neon(({ method, url }) => {
        if (isBranches(url)) {
          return method === 'GET' ? json({ branches: [] }) : json({ branch: safeBranch }, 201)
        }

        if (url.endsWith('/branches/branch/databases')) {
          return Effect.sync(() => {
            connectionStarted = true
          }).pipe(Effect.andThen(Effect.never))
        }

        if (isBranch(url) && method === 'DELETE') {
          deleted = true

          return empty(204)
        }

        if (isProject(url)) return project.clone()

        return deleted ? empty(404) : json({ branch: safeBranch })
      })

      const fiber = yield* Effect.forkChild(create().pipe(Effect.provide(layer)))

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (connectionStarted) break
        yield* Effect.sleep('5 millis')
      }

      expect(connectionStarted).toBe(true)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(deleted).toBe(true)
    })
  )

  it.live('bounds delayed fresh observation before using an exact created branch', () =>
    Effect.gen(function* () {
      let branchLookups = 0
      const methods: Array<string> = []

      const created = yield* create().pipe(
        Effect.provide(
          neon(({ method, url }) => {
            methods.push(method)

            if (isBranches(url)) {
              return method === 'GET' ? json({ branches: [] }) : json({ branch: safeBranch }, 201)
            }

            if (isBranch(url)) {
              branchLookups += 1

              return branchLookups < 3 ? empty(404) : json({ branch: safeBranch })
            }

            if (isProject(url)) return project.clone()

            if (url.endsWith('/branches/branch/databases')) {
              return json({ databases: [{ name: 'database', owner_name: 'role' }] })
            }

            return json({ uri: 'postgres://uri' })
          })
        )
      )

      expect(created.branch).toEqual(safeBranch)
      expect(branchLookups).toBe(3)
      expect(methods).not.toContain('DELETE')
    })
  )

  it.live.each(['missing', 'mismatched'] as const)(
    'recovers and cleans an exact create after bounded %s fresh observations',
    observation =>
      Effect.gen(function* () {
        let branchLookups = 0
        let recoveryStartedAfterLookups: number | undefined
        let listings = 0
        let deleted = false

        const failure = yield* create().pipe(
          Effect.provide(
            neon(({ method, url }) => {
              if (isBranches(url) && method === 'GET') {
                listings += 1

                if (listings === 2) recoveryStartedAfterLookups = branchLookups

                return json({ branches: listings === 1 ? [] : [safeBranch] })
              }

              if (isBranches(url)) return json({ branch: safeBranch }, 201)

              if (isBranch(url) && method === 'DELETE') {
                deleted = true

                return empty(204)
              }

              if (isBranch(url)) {
                branchLookups += 1

                if (deleted) return empty(404)

                if (branchLookups <= 3) {
                  return observation === 'missing'
                    ? empty(404)
                    : json({ branch: { ...safeBranch, parent_id: 'unexpected-parent' } })
                }

                return json({ branch: safeBranch })
              }

              if (isProject(url)) return project.clone()

              return json({})
            })
          ),
          Effect.flip
        )

        expect(failure.message).toContain('outcome could not be safely proven')
        expect(recoveryStartedAfterLookups).toBe(3)
        expect(listings).toBe(2)
        expect(deleted).toBe(true)
      })
  )

  it.live('does not delete an ID from an invalid creation response', () =>
    Effect.gen(function* () {
      const methods: Array<string> = []
      const parentAsBranch = { ...safeBranch, id: 'parent' }

      const failure = yield* create().pipe(
        Effect.provide(
          neon(({ method }) => {
            methods.push(method)

            return method === 'GET'
              ? json({ branches: methods.length === 1 ? [] : [parentAsBranch] })
              : json({ branch: parentAsBranch }, 201)
          })
        ),
        Effect.flip
      )

      expect(failure.message).toContain('uniquely named requested agent branch')
      expect(methods).toEqual(['GET', 'POST', 'GET'])
    })
  )

  it.live('requires exact expiration and confirms strict deletion afterward', () =>
    Effect.gen(function* () {
      let deletionObserved = false
      const methods: Array<string> = []

      const layer = neon(({ method, url }) => {
        methods.push(method)

        if (method === 'PATCH') {
          return json({ branch: { ...safeBranch, expires_at: undefined } })
        }

        if (method === 'DELETE') {
          deletionObserved = true

          return empty(204)
        }

        if (isProject(url)) return project.clone()

        return deletionObserved ? empty(404) : json({ branch: safeBranch })
      })

      const identity = {
        branchId: safeBranch.id,
        branchName: safeBranch.name,
        parentBranch: safeBranch.parent_id
      }

      const failure = yield* setExpiration(branchConfig, identity, safeBranch.expires_at).pipe(
        Effect.provide(layer),
        Effect.flip
      )

      expect(failure.message).toContain('expiration update could not be safely verified')
      expect(methods).toEqual(['PATCH'])

      expect(yield* deleteVerifiedBranch(branchConfig, identity).pipe(Effect.provide(layer))).toBe(
        true
      )
      expect(methods.slice(1)).toEqual(['GET', 'DELETE', 'GET', 'GET', 'GET', 'GET'])
    })
  )

  it.live('attests the repository-specific dev project and protected default baseline', () =>
    Effect.gen(function* () {
      const attested = yield* attestSandboxProfile(branchConfig, 'owner/repo').pipe(
        Effect.provide(baselineNeon(true))
      )
      expect(attested.project.id).toBe('project')
      expect(attested.parent.id).toBe('parent')

      const unprotected = yield* attestSandboxProfile(branchConfig, 'owner/repo').pipe(
        Effect.provide(baselineNeon(false)),
        Effect.flip
      )
      expect(unprotected.message).toContain('protected default baseline')

      const otherRepository = yield* attestSandboxProfile(branchConfig, 'owner/other').pipe(
        Effect.provide(baselineNeon(true)),
        Effect.flip
      )
      expect(otherRepository.message).toContain('must be named other-dev')
    })
  )

  it.live('re-verifies project access before accepting a branch 404', () =>
    Effect.gen(function* () {
      const urls: Array<string> = []

      const failure = yield* deleteVerifiedBranch(config, {
        branchId: safeBranch.id,
        branchName: safeBranch.name,
        parentBranch: safeBranch.parent_id
      }).pipe(
        Effect.provide(
          neon(({ url }) => {
            urls.push(url)

            return empty(404)
          })
        ),
        Effect.flip
      )

      expect(failure.message).toContain('project project not found')
      expect(urls).toEqual([
        'https://console.neon.tech/api/v2/projects/project/branches/branch',
        'https://console.neon.tech/api/v2/projects/project'
      ])
    })
  )

  it.live('cleans a freshly proven exact branch after an unknown creation response', () =>
    Effect.gen(function* () {
      let created = false
      let deleted = false

      const failure = yield* create().pipe(
        Effect.provide(
          neon(({ method, url }) => {
            if (isBranches(url) && method === 'GET') {
              return json({ branches: created && !deleted ? [safeBranch] : [] })
            }

            if (isBranches(url)) {
              created = true

              return new Response('uncertain', { status: 503 })
            }

            if (method === 'DELETE') {
              deleted = true

              return empty(204)
            }

            if (isProject(url)) return project.clone()

            return deleted ? empty(404) : json({ branch: safeBranch })
          })
        ),
        Effect.flip
      )

      expect(failure.message).toContain('branch creation failed (503)')
      expect(deleted).toBe(true)
    })
  )

  it.live('returns static manual recovery guidance when an unknown create cannot be proven', () =>
    Effect.gen(function* () {
      let created = false

      const failure = yield* create().pipe(
        Effect.provide(
          neon(({ method, url }) => {
            if (!isBranches(url)) return json({})

            if (method === 'POST') {
              created = true

              return new Response('{', { status: 201 })
            }

            return json({
              branches: created
                ? [{ ...safeBranch, protected: true, provider_secret: 'suppressed' }]
                : []
            })
          })
        ),
        Effect.flip
      )

      expect(failure.message).toContain('outcome could not be safely proven')
      expect(JSON.stringify(failure)).not.toContain('provider_secret')
    })
  )

  it.live('reports a ready branch without exposing connection material', () =>
    Effect.gen(function* () {
      const state = yield* waitUntilReady(config, 'branch').pipe(
        Effect.provide(
          neon(() =>
            json({ branch: { id: 'branch', name: 'agent/ready', current_state: 'ready' } })
          )
        )
      )

      expect(state).toBe('ready')
    })
  )
})
