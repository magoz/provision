import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer, Predicate } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import type { Invocation, ScriptResult } from './scripted-process.ts'

/** In-memory providers behind every factory step: Vercel (via `vercel api`) and HTTP APIs. */
export interface FakeWorld {
  readonly mutations: Array<string>
  readonly vercel: {
    readonly projects: Map<
      string,
      { id: string; name: string; repo: string; rootDirectory: string | null }
    >
    readonly customEnvironments: Map<string, Array<{ id: string; slug: string }>>
    readonly envs: Map<
      string,
      Array<{
        id: string
        key: string
        value: string
        type: string
        target: ReadonlyArray<string>
        customEnvironmentIds: ReadonlyArray<string>
        configurationId?: string
      }>
    >
    readonly domains: Map<string, Array<string>>
    /** Installed integrations; `projects: null` means access to every project. */
    readonly integrations: Array<{ id: string; slug: string; projects: Array<string> | null }>
  }
  readonly neon: {
    readonly projects: Array<{
      id: string
      name: string
      branches: Array<{ id: string; name: string; default: boolean; protected: boolean }>
    }>
    readonly apiKeys: Array<{ id: number; name: string; project_id: string }>
  }
  readonly cloudflare: {
    readonly buckets: Map<string, { cors: unknown }>
    readonly tokens: Array<{ id: string; name: string }>
  }
  readonly resend: {
    readonly keys: Array<{ id: string; name: string }>
    readonly created: Array<unknown>
  }
  readonly upstash: { readonly teams: Array<{ team_id: string; team_name: string }> }
  readonly reports: {
    readonly tokens: Array<{ id: string; name: string; revokedAt: string | null }>
  }
}

export const makeWorld = (): FakeWorld => ({
  mutations: [],
  vercel: {
    projects: new Map(),
    customEnvironments: new Map(),
    envs: new Map(),
    domains: new Map(),
    integrations: [{ id: 'icfg_neon', slug: 'neon', projects: null }]
  },
  neon: { projects: [], apiKeys: [] },
  cloudflare: { buckets: new Map(), tokens: [] },
  resend: { keys: [], created: [] },
  upstash: { teams: [] },
  reports: { tokens: [] }
})

let counter = 0
const nextId = (prefix: string) => `${prefix}_${++counter}`

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const notFound = () => new Response('not found', { status: 404 })

const ok = (value: unknown): ScriptResult => ({ stdout: JSON.stringify(value) })

const result = (value: unknown) => json({ success: true, result: value })

const field = (body: unknown, key: string) =>
  Predicate.hasProperty(body, key) ? body[key] : undefined

const text = (body: unknown, key: string) => {
  const value = field(body, key)

  return Predicate.isString(value) ? value : ''
}

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter(Predicate.isString) : Predicate.isString(value) ? [value] : []

// ---------------------------------------------------------------------------
// Vercel through the scripted `vercel` CLI
// ---------------------------------------------------------------------------

const vercelApi = (world: FakeWorld, invocation: Invocation): ScriptResult => {
  const args = invocation.args
  const url = new URL(args[1] ?? '', 'https://api.vercel.com')
  const methodIndex = args.indexOf('-X')
  const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET') : 'GET'
  const body: unknown = invocation.input === undefined ? undefined : JSON.parse(invocation.input)
  const path = url.pathname.replace(/^\/v\d+/, '')
  const missing: ScriptResult = { exitCode: 1, stderr: 'Error: Not Found (404)' }

  if (method !== 'GET') world.mutations.push(`vercel ${method} ${path}`)

  const project = /^\/projects\/([^/]+)/.exec(path)?.[1]
  const found = [...world.vercel.projects.values()].find(
    candidate => candidate.id === project || candidate.name === project
  )

  if (path === '/integrations/configurations' && method === 'GET') {
    const slug = url.searchParams.get('integrationIdOrSlug')

    return ok(world.vercel.integrations.filter(configuration => configuration.slug === slug))
  }

  if (path === '/projects' && method === 'POST') {
    const created = {
      id: nextId('prj'),
      name: text(body, 'name'),
      repo: text(field(body, 'gitRepository'), 'repo'),
      rootDirectory: text(body, 'rootDirectory') || null
    }
    world.vercel.projects.set(created.id, created)

    return ok({ id: created.id, name: created.name, rootDirectory: created.rootDirectory })
  }

  if (found === undefined) return missing

  const rest = path.replace(/^\/projects\/[^/]+/, '')
  const [owner, repo] = found.repo.split('/')
  const projectPayload = {
    id: found.id,
    name: found.name,
    rootDirectory: found.rootDirectory,
    link: { type: 'github', org: owner, repo }
  }

  if (rest === '' && method === 'GET') return ok(projectPayload)

  if (rest === '' && method === 'PATCH') {
    found.rootDirectory = text(body, 'rootDirectory') || null

    return ok(projectPayload)
  }

  if (rest === '/custom-environments') {
    const environments = world.vercel.customEnvironments.get(found.id) ?? []

    if (method === 'GET') return ok({ environments })

    const created = { id: nextId('env'), slug: text(body, 'slug') }
    world.vercel.customEnvironments.set(found.id, [...environments, created])

    return ok(created)
  }

  const envs = world.vercel.envs.get(found.id) ?? []

  if (rest === '/env' && method === 'GET') {
    return ok({
      envs: envs.map(({ value: _value, ...record }) => record),
      pagination: { next: null }
    })
  }

  if (rest === '/env' && method === 'POST') {
    const record = {
      id: nextId('envvar'),
      key: text(body, 'key'),
      value: text(body, 'value'),
      type: text(body, 'type'),
      target: strings(field(body, 'target')),
      customEnvironmentIds: strings(field(body, 'customEnvironmentIds'))
    }
    world.vercel.envs.set(found.id, [...envs, record])

    return ok({ created: record, failed: [] })
  }

  const envId = /^\/env\/([^/]+)$/.exec(rest)?.[1]

  if (envId !== undefined && method === 'DELETE') {
    world.vercel.envs.set(
      found.id,
      envs.filter(record => record.id !== envId)
    )

    return ok({})
  }

  const domains = world.vercel.domains.get(found.id) ?? []
  const domain = /^\/domains\/([^/]+)$/.exec(rest)?.[1]

  if (domain !== undefined) {
    return domains.includes(domain) ? ok({ name: domain, verified: true }) : missing
  }

  if (rest === '/domains' && method === 'POST') {
    world.vercel.domains.set(found.id, [...domains, text(body, 'name')])

    return ok({ name: text(body, 'name'), verified: false })
  }

  return missing
}

/** Script for every external command a factory run invokes (`git` runs for real). */
export const factoryScript =
  (world: FakeWorld) =>
  (invocation: Invocation): Effect.Effect<ScriptResult | undefined> | ScriptResult | undefined => {
    if (invocation.command === 'vercel' && invocation.args[0] === 'api') {
      return vercelApi(world, invocation)
    }

    if (invocation.command === 'vercel' && invocation.args[0] === 'link') {
      const directory = invocation.args[invocation.args.indexOf('--cwd') + 1] ?? ''
      const name = invocation.args[invocation.args.indexOf('--project') + 1] ?? ''
      const project = [...world.vercel.projects.values()].find(candidate => candidate.name === name)
      world.mutations.push(`vercel link ${name}`)

      return Effect.promise(async () => {
        await mkdir(join(directory, '.vercel'), { recursive: true })
        await writeFile(
          join(directory, '.vercel', 'project.json'),
          JSON.stringify({ projectId: project?.id ?? '', orgId: 'team_fake' })
        )
      }).pipe(Effect.as(undefined))
    }

    return { exitCode: 127 }
  }

// ---------------------------------------------------------------------------
// HTTP providers
// ---------------------------------------------------------------------------

const cloudflare = (world: FakeWorld, method: string, path: string, body: unknown) => {
  const bucket = /\/r2\/buckets\/([^/]+)(\/cors)?$/.exec(path)

  if (bucket !== null) {
    const name = bucket[1] ?? ''

    if (bucket[2] !== undefined) {
      const existing = world.cloudflare.buckets.get(name)

      if (method === 'GET') {
        return existing?.cors === undefined ? notFound() : result({ rules: existing.cors })
      }

      world.cloudflare.buckets.set(name, { cors: field(body, 'rules') })

      return json({ success: true })
    }

    return world.cloudflare.buckets.has(name) ? result({ name }) : notFound()
  }

  if (path.endsWith('/r2/buckets') && method === 'POST') {
    world.cloudflare.buckets.set(text(body, 'name'), { cors: undefined })

    return result({ name: text(body, 'name') })
  }

  if (path.endsWith('/tokens/permission_groups')) {
    return result([
      { id: 'pg-read', name: 'Workers R2 Storage Bucket Item Read' },
      { id: 'pg-write', name: 'Workers R2 Storage Bucket Item Write' }
    ])
  }

  if (path.endsWith('/tokens/verify')) return result({ status: 'active' })

  if (path.endsWith('/tokens') && method === 'GET') {
    return json({ success: true, result: world.cloudflare.tokens, result_info: { total_pages: 1 } })
  }

  if (path.endsWith('/tokens') && method === 'POST') {
    const token = { id: nextId('cf'), name: text(body, 'name') }
    world.cloudflare.tokens.push(token)

    return result({ id: token.id, value: `secret-${token.id}` })
  }

  const token = /\/tokens\/([^/]+)$/.exec(path)?.[1]

  if (token !== undefined && method === 'DELETE') {
    const index = world.cloudflare.tokens.findIndex(candidate => candidate.id === token)

    if (index >= 0) world.cloudflare.tokens.splice(index, 1)

    return result({ id: token })
  }

  return notFound()
}

const neon = (world: FakeWorld, method: string, url: URL, body: unknown) => {
  const path = url.pathname.replace('/api/v2', '')

  if (path === '/projects' && method === 'GET') {
    const search = url.searchParams.get('search') ?? ''

    return json({
      projects: world.neon.projects
        .filter(project => project.name.includes(search))
        .map(({ id, name }) => ({ id, name }))
    })
  }

  if (path === '/projects' && method === 'POST') {
    const project = field(body, 'project')
    const branch = {
      id: nextId('br'),
      name: text(field(project, 'branch'), 'name'),
      default: true,
      protected: false
    }
    const created = { id: nextId('neon'), name: text(project, 'name'), branches: [branch] }
    world.neon.projects.push(created)

    return json({ project: { id: created.id, name: created.name }, branch }, 201)
  }

  const keys = /^\/organizations\/[^/]+\/api_keys(?:\/(\d+))?$/.exec(path)

  if (keys !== null) {
    if (method === 'GET') return json(world.neon.apiKeys)

    if (method === 'POST') {
      const key = {
        id: world.neon.apiKeys.length + 100,
        name: text(body, 'key_name'),
        project_id: text(body, 'project_id')
      }
      world.neon.apiKeys.push(key)

      return json({ id: key.id, key: `neon-key-${key.id}` })
    }

    const index = world.neon.apiKeys.findIndex(key => String(key.id) === keys[1])

    if (index >= 0) world.neon.apiKeys.splice(index, 1)

    return json({})
  }

  const projectMatch = /^\/projects\/([^/]+)(.*)$/.exec(path)
  const project = world.neon.projects.find(candidate => candidate.id === projectMatch?.[1])

  if (project === undefined) return notFound()

  const rest = projectMatch?.[2] ?? ''

  if (rest === '/branches') return json({ branches: project.branches })

  const branch = project.branches.find(candidate => rest.startsWith(`/branches/${candidate.id}`))

  if (branch !== undefined && rest.endsWith('/databases')) {
    return json({ databases: [{ name: 'neondb', owner_name: 'neondb_owner' }] })
  }

  if (branch !== undefined && method === 'PATCH') {
    const update = field(body, 'branch')
    const name = text(update, 'name')

    if (name !== '') branch.name = name
    else branch.protected = true

    return json({ branch })
  }

  if (rest === '/connection_uri') {
    const pooled = url.searchParams.get('pooled') === 'true'

    return json({ uri: `postgres://${project.name}${pooled ? '-pooler' : ''}/neondb` })
  }

  return notFound()
}

const resend = (world: FakeWorld, method: string, path: string, body: unknown) => {
  if (path === '/domains') {
    return json({
      data: [
        { id: 'dom_1', name: 'mail.example.test', status: 'verified' },
        { id: 'dom_2', name: 'acme.test', status: 'verified' },
        { id: 'dom_3', name: 'pending.test', status: 'pending' }
      ]
    })
  }

  if (path === '/api-keys' && method === 'GET') return json({ data: world.resend.keys })

  if (path === '/api-keys' && method === 'POST') {
    const key = { id: nextId('re'), name: text(body, 'name') }
    world.resend.created.push(body)
    world.resend.keys.push(key)

    return json({ id: key.id, token: `re_${key.id}` })
  }

  const id = /^\/api-keys\/(.+)$/.exec(path)?.[1]
  const index = world.resend.keys.findIndex(key => key.id === id)

  if (index >= 0) world.resend.keys.splice(index, 1)

  return json({})
}

const upstash = (world: FakeWorld, method: string, path: string, body: unknown) => {
  if (path === '/v2/teams') return json(world.upstash.teams)

  if (path === '/v2/team' && method === 'POST') {
    const team = { team_id: nextId('team'), team_name: text(body, 'team_name') }
    world.upstash.teams.push(team)

    return json(team)
  }

  return notFound()
}

const receiver = (world: FakeWorld, method: string, path: string, body: unknown) => {
  if (path === '/api/factory/report-tokens' && method === 'GET') {
    return json({ tokens: world.reports.tokens })
  }

  if (path === '/api/factory/report-tokens' && method === 'POST') {
    const token = { id: nextId('rt'), name: text(body, 'name'), revokedAt: null }
    world.reports.tokens.push(token)

    return json({ id: token.id, name: token.name, token: `report_token_${token.id}` })
  }

  const id = /\/report-tokens\/(.+)$/.exec(path)?.[1]
  const token = world.reports.tokens.find(candidate => candidate.id === id)

  if (token !== undefined) token.revokedAt = '2026-01-01T00:00:00Z'

  return json({})
}

export const fakeProvidersLayer = (world: FakeWorld) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body = Predicate.isTagged(request.body, 'Uint8Array')
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined
        const method = request.method

        if (method !== 'GET') world.mutations.push(`${url.host} ${method} ${url.pathname}`)

        const response =
          url.host === 'api.cloudflare.com'
            ? cloudflare(world, method, url.pathname, body)
            : url.host === 'console.neon.tech'
              ? neon(world, method, url, body)
              : url.host === 'api.resend.com'
                ? resend(world, method, url.pathname, body)
                : url.host === 'api.upstash.com'
                  ? upstash(world, method, url.pathname, body)
                  : url.host === 'receiver.example.test'
                    ? receiver(world, method, url.pathname, body)
                    : notFound()

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )
