import { Effect, Layer, Predicate } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

interface FakeBranch {
  readonly id: string
  readonly name: string
  readonly parent_id?: string
  readonly default: boolean
  readonly protected: boolean
  readonly current_state: string
  readonly expires_at?: string
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const BranchBody = (body: unknown) =>
  Predicate.hasProperty(body, 'branch') ? body.branch : undefined

export interface FakeNeonOptions {
  /** Fail the nth branch creation (1-based) with a 500. */
  readonly failCreation?: number
}

/** An in-memory Neon project with a protected default `baseline` branch. */
export const fakeNeon = (projectName: string, options: FakeNeonOptions = {}) => {
  const baseline: FakeBranch = {
    id: 'parent',
    name: 'baseline',
    default: true,
    protected: true,
    current_state: 'ready'
  }
  const branches = new Map<string, FakeBranch>([[baseline.id, baseline]])
  const calls: Array<string> = []
  let created = 0

  const respond = (method: string, url: URL, body: unknown): Response => {
    const path = url.pathname.replace('/api/v2/projects/project', '')
    calls.push(`${method} ${path}`)

    if (path === '') return json({ project: { id: 'project', name: projectName } })

    if (path === '/branches' && method === 'GET') return json({ branches: [...branches.values()] })

    if (path === '/branches' && method === 'POST') {
      const requested = BranchBody(body)
      created += 1

      if (created === options.failCreation) return new Response('boom', { status: 500 })

      const branch: FakeBranch = {
        id: `br-${created}`,
        name: Predicate.hasProperty(requested, 'name') ? String(requested.name) : '',
        parent_id: Predicate.hasProperty(requested, 'parent_id') ? String(requested.parent_id) : '',
        default: false,
        protected: false,
        current_state: 'ready',
        expires_at: Predicate.hasProperty(requested, 'expires_at')
          ? String(requested.expires_at)
          : ''
      }

      branches.set(branch.id, branch)

      return json({ branch }, 201)
    }

    if (path === '/connection_uri') {
      const pooled = url.searchParams.get('pooled') === 'true'
      const branch = url.searchParams.get('branch_id') ?? ''

      return json({ uri: `postgres://${branch}${pooled ? '-pooler' : ''}/neondb` })
    }

    const match = /^\/branches\/([^/]+)(\/databases)?$/.exec(path)
    const id = match?.[1] ?? ''
    const branch = branches.get(id)

    if (branch === undefined) return new Response(null, { status: 404 })

    if (match?.[2] !== undefined)
      return json({ databases: [{ name: 'neondb', owner_name: 'owner' }] })

    if (method === 'DELETE') {
      branches.delete(id)

      return new Response(null, { status: 204 })
    }

    if (method === 'PATCH') {
      const requested = BranchBody(body)
      const updated: FakeBranch = {
        ...branch,
        expires_at: Predicate.hasProperty(requested, 'expires_at')
          ? String(requested.expires_at)
          : ''
      }
      branches.set(id, updated)

      return json({ branch: updated })
    }

    return json({ branch })
  }

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body = Predicate.isTagged(request.body, 'Uint8Array')
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined

        return HttpClientResponse.fromWeb(request, respond(request.method, url, body))
      })
    )
  )

  return { layer, branches, calls }
}
