import { execFileSync } from 'node:child_process'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { Command } from 'effect/cli'
import {
  factoryScript,
  fakeProvidersLayer,
  makeWorld,
  type FakeWorld
} from '../testing/fake-factory.ts'
import { scriptedProcessLayer, type Invocation } from '../testing/scripted-process.ts'
import { passphraseLayer, temporaryDirectory } from '../testing/temporary.ts'
import { factoryCommand, selectSteps } from './commands.ts'
import { RegistryLocation } from './registry.ts'
import { parseEnvBlock, SecretInput } from './secret-input.ts'

const itemFields: Record<string, string> = {
  'github.owner': 'acme',
  'vercel.team_id': 'team_acme',
  'neon.api_key': 'neon-admin',
  'neon.org_id': 'org-acme',
  'cloudflare.api_token': 'cf-admin',
  'cloudflare.account_id': 'cf-account',
  'upstash.email': 'ops@acme.test',
  'upstash.api_key': 'upstash-admin',
  'resend.api_key': 'resend-admin',
  'resend.sending_domain': 'mail.example.test',
  'report_receiver.url': 'https://receiver.example.test/api/reports',
  'report_receiver.factory_key': 'receiver-key'
}

const opItem = (fields: Record<string, string>) =>
  JSON.stringify({
    fields: Object.entries(fields).map(([key, value]) => {
      const [section, label] = key.split('.')

      return { label, value, section: { label: section } }
    })
  })

const setup = (fields: Record<string, string> = itemFields, owner = 'acme') =>
  Effect.gen(function* () {
    const repo = yield* temporaryDirectory('acme-app')
    const configHome = yield* temporaryDirectory('provision-config')
    const registry = join(configHome, 'config.json')

    yield* Effect.promise(async () => {
      execFileSync('git', ['-C', repo, 'init', '--quiet'])
      execFileSync('git', [
        '-C',
        repo,
        'remote',
        'add',
        'origin',
        `git@github.com:${owner}/acme-app.git`
      ])
      await writeFile(join(repo, '.gitignore'), '.vercel\n.env*.local\n')
      await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'acme-app' }))
      await writeFile(
        registry,
        JSON.stringify({
          factories: {
            acme: { vault: 'provision-factory-acme', item: 'provision', githubOwner: 'acme' },
            other: { vault: 'provision-factory-other', item: 'provision', githubOwner: 'other' }
          }
        })
      )
    })

    const world = makeWorld()
    const invocations: Array<Invocation> = []
    // Values the operator pastes when asked; an empty queue answers like an empty Enter.
    const answers: Array<string> = []
    const prompts: Array<string> = []
    const script = factoryScript(world)

    const layer = Layer.mergeAll(
      scriptedProcessLayer(
        invocation =>
          invocation.command === 'op' ? { stdout: opItem(fields) } : script(invocation),
        invocations
      ),
      fakeProvidersLayer(world),
      passphraseLayer(),
      Layer.succeed(SecretInput, {
        readEnv: (message, keys) =>
          Effect.sync(() => {
            prompts.push(message)
            const values = parseEnvBlock(answers.shift()?.split('\n') ?? [], keys)

            return values.size === 0 ? Option.none() : Option.some(values)
          })
      }),
      Layer.succeed(RegistryLocation, { file: registry })
    )

    const run = (...args: ReadonlyArray<string>) =>
      Command.runWith(factoryCommand, { version: 'test' })([
        '--checkout',
        repo,
        '--domain',
        'app.acme.test',
        ...args
      ]).pipe(Effect.provide(layer))

    return { repo, world, invocations, run, answers, prompts }
  })

const records = (world: FakeWorld) => [...world.vercel.envs.values()].flat()

const recordFor = (world: FakeWorld, key: string, target: string) =>
  records(world).filter(record => record.key === key && record.target.includes(target))

/** What an agent passes for a 10x-style app after reading its code. */
const secretFlags = [
  '--secret',
  'BETTER_AUTH_SECRET',
  '--secret',
  'CRON_SECRET=hex-32',
  '--secret',
  'VAPID=vapid'
]

/** The `.env` block QStash's console Quickstart offers to copy. */
const qstashBlock = (url: string, token: string) =>
  [
    `QSTASH_URL="${url}"`,
    `QSTASH_TOKEN="${token}"`,
    `QSTASH_CURRENT_SIGNING_KEY="sig_${token}_current"`,
    `export QSTASH_NEXT_SIGNING_KEY='sig_${token}_next'`
  ].join('\n')

afterEach(() => {
  process.exitCode = undefined
})

describe('provision factory', () => {
  it.live('provisions every step for a fresh repository', () =>
    Effect.gen(function* () {
      const { repo, world, invocations, run } = yield* setup()

      yield* run('--on-existing', 'abort', ...secretFlags)
      expect(process.exitCode).toBeUndefined()

      const project = [...world.vercel.projects.values()][0]
      expect(project).toMatchObject({
        name: 'acme-app',
        repo: 'acme/acme-app',
        rootDirectory: null
      })

      const testEnvironment = world.vercel.customEnvironments.get(project?.id ?? '')?.[0]
      expect(testEnvironment?.slug).toBe('test')

      const consent = records(world).filter(record => record.key === 'ALLOW_E2E_DATABASE_RESET')
      expect(consent).toEqual([
        expect.objectContaining({
          target: [],
          customEnvironmentIds: [testEnvironment?.id],
          value: '1'
        })
      ])

      expect(world.neon.projects.map(neon => neon.name)).toEqual(['acme-app-dev', 'acme-app-prod'])
      expect(world.neon.projects.every(neon => neon.branches[0]?.protected === true)).toBe(true)
      expect(world.neon.apiKeys.map(key => key.name)).toEqual([
        'acme-app-dev-sandbox-branch-manager'
      ])

      const sandbox = records(world).filter(record => record.key.startsWith('SANDBOX_DB_'))
      expect(sandbox).toHaveLength(3)
      expect(sandbox.every(record => record.target.join() === 'development')).toBe(true)
      expect(recordFor(world, 'SANDBOX_DB_PARENT_BRANCH_ID', 'development')[0]?.value).toBe(
        world.neon.projects[0]?.branches[0]?.id
      )

      expect(recordFor(world, 'DATABASE_URL', 'production')[0]).toMatchObject({
        type: 'sensitive',
        value: 'postgres://acme-app-prod-pooler/neondb'
      })

      expect([...world.cloudflare.buckets.keys()]).toEqual(['acme-app-dev', 'acme-app-prod'])
      expect(JSON.stringify(world.cloudflare.buckets.get('acme-app-prod')?.cors)).toContain(
        'https://app.acme.test'
      )
      expect(world.cloudflare.tokens.map(token => token.name)).toEqual([
        'acme-app-dev-app-rw',
        'acme-app-prod-app-rw'
      ])

      const r2Secret = recordFor(world, 'R2_SECRET_ACCESS_KEY', 'production')[0]
      expect(r2Secret?.type).toBe('sensitive')
      expect(r2Secret?.value).toMatch(/^[0-9a-f]{64}$/)
      expect(recordFor(world, 'R2_BUCKET_NAME', 'preview')[0]?.value).toBe('acme-app-dev')

      expect(world.upstash.teams.map(team => team.team_name)).toEqual([
        'acme-app-dev',
        'acme-app-prod'
      ])
      expect(records(world).filter(record => record.key.startsWith('QSTASH_'))).toEqual([])
      expect(world.resend.keys.map(key => key.name)).toEqual(['acme-app-dev', 'acme-app-prod'])
      expect(world.resend.created).toEqual([
        { name: 'acme-app-dev', permission: 'sending_access' },
        { name: 'acme-app-prod', permission: 'sending_access' }
      ])
      expect(world.reports.tokens.map(token => token.name)).toEqual([
        'acme-app-dev',
        'acme-app-prod'
      ])

      for (const key of ['BETTER_AUTH_SECRET', 'CRON_SECRET', 'VAPID_PRIVATE_KEY']) {
        const development = recordFor(world, key, 'development')[0]
        const production = recordFor(world, key, 'production')[0]
        expect(development?.value).not.toBe(production?.value)
        expect(production?.type).toBe('sensitive')
      }

      expect(recordFor(world, 'VAPID_PUBLIC_KEY', 'production')[0]?.value).toMatch(
        /^[A-Za-z0-9_-]{87}$/
      )
      expect(recordFor(world, 'AUTH_EMAIL_FROM', 'production')[0]?.value).toBe(
        'acme-app <noreply@mail.example.test>'
      )
      expect(world.vercel.domains.get(project?.id ?? '')).toEqual(['app.acme.test'])

      const link = yield* Effect.promise(() =>
        readFile(join(repo, '.vercel', 'project.json'), 'utf8')
      )
      expect(JSON.parse(link)).toEqual({
        projectId: project?.id ?? 'missing',
        orgId: 'team_acme',
        projectName: 'acme-app'
      })
      const linkMode = yield* Effect.promise(() => stat(join(repo, '.vercel', 'project.json')))
      expect(linkMode.mode & 0o777).toBe(0o600)

      // Linking writes only the identity: `vercel link` would pull `.env.local` and edit .gitignore.
      expect(invocations.some(invocation => invocation.args[0] === 'link')).toBe(false)
      expect(yield* Effect.promise(() => readFile(join(repo, '.gitignore'), 'utf8'))).toBe(
        '.vercel\n.env*.local\n'
      )
      expect(
        yield* Effect.promise(() =>
          access(join(repo, '.env.local')).then(
            () => true,
            () => false
          )
        )
      ).toBe(false)

      // Selection by the recorded owner reads only this factory's item.
      const vaults = invocations
        .filter(invocation => invocation.command === 'op')
        .map(invocation => invocation.args[invocation.args.indexOf('--vault') + 1])
      expect(vaults).toEqual(['provision-factory-acme'])

      // Secrets travel through stdin and HTTP headers only, never process arguments.
      const argv = JSON.stringify(invocations.map(invocation => invocation.args))
      const secrets = [
        'neon-admin',
        'cf-admin',
        'upstash-admin',
        'resend-admin',
        'receiver-key',
        ...records(world)
          .filter(record => record.type !== 'plain')
          .map(record => record.value)
      ]

      for (const secret of secrets) expect(argv).not.toContain(secret)
    })
  )

  it.live('changes nothing when rerun with reuse', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()
      yield* run('--on-existing', 'abort', ...secretFlags)
      const before = world.mutations.length

      yield* run('--on-existing', 'reuse', ...secretFlags)

      expect(process.exitCode).toBeUndefined()
      expect(world.mutations.slice(before)).toEqual([])
    })
  )

  it.live('rotates keys and secrets on overwrite but never recreates data', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()
      yield* run('--on-existing', 'abort', ...secretFlags)
      const tokens = world.cloudflare.tokens.map(token => token.id)
      const auth = recordFor(world, 'BETTER_AUTH_SECRET', 'production')[0]?.value

      yield* run('--on-existing', 'overwrite', ...secretFlags)

      expect(process.exitCode).toBeUndefined()
      expect(world.neon.projects).toHaveLength(2)
      expect(world.cloudflare.buckets.size).toBe(2)
      expect(world.cloudflare.tokens).toHaveLength(2)
      expect(world.cloudflare.tokens.some(token => tokens.includes(token.id))).toBe(false)
      expect(world.reports.tokens.filter(token => token.revokedAt === null)).toHaveLength(2)
      expect(recordFor(world, 'BETTER_AUTH_SECRET', 'production')).toHaveLength(1)
      expect(recordFor(world, 'BETTER_AUTH_SECRET', 'production')[0]?.value).not.toBe(auth)
    })
  )

  it.live('refuses to reuse a key whose value is missing from Vercel', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel,resend')

      for (const [projectId, envs] of world.vercel.envs) {
        world.vercel.envs.set(
          projectId,
          envs.filter(
            record => !(record.key === 'RESEND_API_KEY' && record.target.includes('production'))
          )
        )
      }

      yield* run('--on-existing', 'reuse', '--only', 'resend')
      expect(process.exitCode).toBe(2)

      process.exitCode = undefined
      yield* run('--on-existing', 'overwrite', '--only', 'resend')
      expect(process.exitCode).toBeUndefined()
      expect(recordFor(world, 'RESEND_API_KEY', 'production')).toHaveLength(1)
      expect(world.resend.keys).toHaveLength(2)
    })
  )

  it.live('uses --email-from for AUTH_EMAIL_FROM and requires a verified domain', () =>
    Effect.gen(function* () {
      const withoutDomain = { ...itemFields }
      delete withoutDomain['resend.sending_domain']

      const { world, run } = yield* setup(withoutDomain)
      yield* run('--on-existing', 'abort', '--only', 'vercel')

      yield* run('--only', 'secrets', '--on-existing', 'abort')
      expect(process.exitCode).toBeUndefined()
      expect(recordFor(world, 'AUTH_EMAIL_FROM', 'production')).toEqual([])

      yield* run('--only', 'secrets', '--on-existing', 'abort', '--email-from', 'hi@pending.test')
      expect(process.exitCode).toBe(2)

      process.exitCode = undefined
      yield* run('--only', 'secrets', '--on-existing', 'abort', '--email-from', 'hi@acme.test')
      expect(process.exitCode).toBeUndefined()
      expect(recordFor(world, 'AUTH_EMAIL_FROM', 'production')[0]?.value).toBe(
        'acme-app <hi@acme.test>'
      )
    })
  )

  it.live('generates only the secrets passed with --secret', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')

      yield* run(
        '--only',
        'secrets',
        '--secret',
        'CREDENTIAL_ENCRYPTION_KEY',
        '--secret',
        'CRON_SECRET=hex-32'
      )

      expect(process.exitCode).toBeUndefined()
      const keys = new Set(records(world).map(record => record.key))
      expect([...keys].toSorted()).toEqual([
        'ALLOW_E2E_DATABASE_RESET',
        'AUTH_EMAIL_FROM',
        'CREDENTIAL_ENCRYPTION_KEY',
        'CRON_SECRET'
      ])
      expect(
        Buffer.from(
          recordFor(world, 'CREDENTIAL_ENCRYPTION_KEY', 'preview')[0]?.value ?? '',
          'base64'
        )
      ).toHaveLength(32)
      expect(recordFor(world, 'CRON_SECRET', 'production')[0]?.value).toMatch(/^[0-9a-f]{64}$/)
    })
  )

  it.live('never replaces a secret set in only part of an environment group without asking', () =>
    Effect.gen(function* () {
      // No sender, so the secret is the only thing that exists.
      const withoutDomain = { ...itemFields }
      delete withoutDomain['resend.sending_domain']
      const { world, run } = yield* setup(withoutDomain)
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      yield* run('--only', 'secrets', '--secret', 'BETTER_AUTH_SECRET')

      for (const [projectId, envs] of world.vercel.envs) {
        world.vercel.envs.set(
          projectId,
          envs.map(record =>
            record.key === 'BETTER_AUTH_SECRET' && record.target.includes('preview')
              ? { ...record, target: ['development'] }
              : record
          )
        )
      }
      const development = recordFor(world, 'BETTER_AUTH_SECRET', 'development')[0]?.value
      const before = world.mutations.length

      yield* run('--only', 'secrets', '--secret', 'BETTER_AUTH_SECRET', '--on-existing', 'reuse')
      expect(world.mutations.slice(before)).toEqual([])

      yield* run('--only', 'secrets', '--secret', 'BETTER_AUTH_SECRET', '--on-existing', 'abort')
      expect(process.exitCode).toBe(2)
      expect(recordFor(world, 'BETTER_AUTH_SECRET', 'development')[0]?.value).toBe(development)
    })
  )

  it.live('rejects malformed --secret values before doing anything', () =>
    Effect.gen(function* () {
      const { world, invocations, run } = yield* setup()

      for (const value of ['lower_case', 'TOKEN=base64-8', 'TOKEN=uuid', 'A=hex-32=x']) {
        process.exitCode = undefined
        yield* run('--secret', value)
        expect(process.exitCode).toBe(2)
      }

      yield* run('--secret', 'VAPID=vapid', '--secret', 'VAPID_PUBLIC_KEY')
      expect(process.exitCode).toBe(2)
      expect(world.mutations).toEqual([])
      expect(invocations.filter(invocation => invocation.command === 'op')).toEqual([])
    })
  )

  it.live('lets the other steps finish when one fails', () =>
    Effect.gen(function* () {
      const withoutDomain = { ...itemFields }
      delete withoutDomain['resend.sending_domain']

      const { world, run } = yield* setup(withoutDomain)
      yield* run('--on-existing', 'abort', '--email-from', 'hi@pending.test')

      expect(process.exitCode).toBe(2)
      expect(recordFor(world, 'AUTH_EMAIL_FROM', 'production')).toEqual([])
      expect(world.neon.projects).toHaveLength(2)
      expect(world.resend.keys).toHaveLength(2)
      expect(recordFor(world, 'R2_BUCKET_NAME', 'production')).toHaveLength(1)
    })
  )

  it.live('hands the command to the human when an agent runs it', () =>
    Effect.gen(function* () {
      const { world, invocations, run } = yield* setup()

      process.env['AI_AGENT'] = 'acme-agent'
      yield* run('--dry-run').pipe(
        Effect.ensuring(Effect.sync(() => delete process.env['AI_AGENT']))
      )

      expect(process.exitCode).toBe(4)
      expect(invocations).toEqual([])
      expect(world.mutations).toEqual([])
    })
  )

  it.live('writes the pasted QStash .env block, asking only while it is missing', () =>
    Effect.gen(function* () {
      const { world, run, answers, prompts } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')

      answers.push(
        'QSTASH_TOKEN="dev-token"',
        qstashBlock('http://not-https.test', 'dev-token'),
        qstashBlock('https://qstash-eu-central-1.upstash.io', 'dev-token')
      )
      yield* run('--only', 'upstash', '--on-existing', 'reuse')

      expect(process.exitCode).toBeUndefined()
      expect(prompts.filter(prompt => prompt.includes('Missing QSTASH_URL'))).toHaveLength(1)
      expect(prompts.filter(prompt => prompt.includes('must be an https URL'))).toHaveLength(1)
      expect(recordFor(world, 'QSTASH_TOKEN', 'preview')[0]).toMatchObject({
        value: 'dev-token',
        type: 'encrypted'
      })
      expect(recordFor(world, 'QSTASH_NEXT_SIGNING_KEY', 'preview')[0]?.value).toBe(
        'sig_dev-token_next'
      )
      expect(recordFor(world, 'QSTASH_TOKEN', 'production')).toEqual([])

      answers.push(qstashBlock('https://qstash-eu-central-1.upstash.io', 'prod-token'))
      const before = prompts.length
      yield* run('--only', 'upstash', '--on-existing', 'reuse')

      expect(prompts.slice(before).every(prompt => !prompt.includes('acme-app-dev'))).toBe(true)
      expect(recordFor(world, 'QSTASH_TOKEN', 'production')[0]).toMatchObject({
        value: 'prod-token',
        type: 'sensitive'
      })
      expect(recordFor(world, 'QSTASH_URL', 'production')[0]?.type).toBe('encrypted')

      const settled = prompts.length
      yield* run('--only', 'upstash', '--on-existing', 'reuse')
      expect(prompts.length).toBe(settled)
    })
  )

  it.live(
    "holds Production back until Neon's Vercel integration is connected, then replaces its variables",
    () =>
      Effect.gen(function* () {
        const { world, run } = yield* setup()
        world.vercel.integrations.splice(0, 1, { id: 'icfg_neon', slug: 'neon', projects: [] })

        yield* run('--on-existing', 'abort', '--only', 'vercel,neon')
        expect(process.exitCode).toBeUndefined()
        expect(world.neon.projects.map(project => project.name)).toEqual([
          'acme-app-dev',
          'acme-app-prod'
        ])
        expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([])

        // The operator connects the integration: Vercel access, plus its own variables.
        const project = [...world.vercel.projects.values()][0]
        const projectId = project?.id ?? ''
        world.vercel.integrations.splice(0, 1, {
          id: 'icfg_neon',
          slug: 'neon',
          projects: [projectId]
        })
        world.vercel.envs.set(projectId, [
          ...(world.vercel.envs.get(projectId) ?? []),
          ...['production', 'development'].flatMap(target =>
            ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'].map(key => ({
              id: `neon-${key}-${target}`,
              key,
              value: 'postgres://acme-app-dev/neondb',
              type: 'encrypted',
              target: [target],
              customEnvironmentIds: [],
              configurationId: 'icfg_neon'
            }))
          )
        ])

        yield* run('--on-existing', 'reuse', '--only', 'neon')
        expect(process.exitCode).toBeUndefined()
        expect(records(world).filter(record => record.configurationId !== undefined)).toEqual([])
        expect(recordFor(world, 'DATABASE_URL', 'development')).toEqual([])
        expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
          expect.objectContaining({
            value: 'postgres://acme-app-prod-pooler/neondb',
            type: 'sensitive'
          })
        ])
      })
  )

  it.live("renames a reused dev project's default branch to baseline, keeping its id", () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()
      world.neon.projects.push({
        id: 'neon-existing-dev',
        name: 'acme-app-dev',
        branches: [{ id: 'br-dev', name: 'production', default: true, protected: false }]
      })

      yield* run('--on-existing', 'reuse', '--only', 'vercel,neon')

      expect(process.exitCode).toBeUndefined()
      expect(world.neon.projects[0]?.branches[0]).toEqual({
        id: 'br-dev',
        name: 'baseline',
        default: true,
        protected: true
      })
      expect(recordFor(world, 'SANDBOX_DB_PARENT_BRANCH_ID', 'development')[0]?.value).toBe(
        'br-dev'
      )
    })
  )

  it.live('mutates nothing in a dry run', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()

      yield* run('--dry-run')

      expect(process.exitCode).toBeUndefined()
      expect(world.mutations).toEqual([])
    })
  )

  it.live('refuses, even in a dry run, a checkout whose .vercel is not git-ignored', () =>
    Effect.gen(function* () {
      const { repo, world, run } = yield* setup()
      yield* Effect.promise(() => writeFile(join(repo, '.gitignore'), '.env*.local\n'))

      yield* run('--only', 'vercel', '--dry-run')

      expect(process.exitCode).toBe(2)
      expect(world.mutations).toEqual([])
    })
  )

  it.live('refuses a checkout owned by another GitHub owner', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup(itemFields, 'someone-else')

      yield* run('--factory', 'acme')

      expect(process.exitCode).toBe(2)
      expect(world.mutations).toEqual([])
    })
  )

  it.live('requires --domain for steps that use it', () =>
    Effect.gen(function* () {
      const { repo, world, invocations } = yield* setup()
      const layer = Layer.mergeAll(
        scriptedProcessLayer(() => undefined, invocations),
        fakeProvidersLayer(world),
        passphraseLayer(),
        Layer.succeed(SecretInput, { readEnv: () => Effect.succeed(Option.none()) }),
        Layer.succeed(RegistryLocation, { file: join(repo, 'missing.json') })
      )

      yield* Command.runWith(factoryCommand, { version: 'test' })([
        '--checkout',
        repo,
        '--only',
        'r2'
      ]).pipe(Effect.provide(layer))

      expect(process.exitCode).toBe(2)
      expect(invocations.filter(invocation => invocation.command !== 'git')).toEqual([])
    })
  )
})

describe('selectSteps', () => {
  const all = ['vercel', 'neon', 'r2', 'secrets'] as const

  it.effect('keeps the canonical order and the repository subset', () =>
    Effect.gen(function* () {
      expect(yield* selectSteps(all, Option.none())).toEqual(all)
      expect(yield* selectSteps(all, Option.some('secrets, vercel'))).toEqual(['vercel', 'secrets'])
    })
  )

  it.effect('rejects unknown and undeclared steps', () =>
    Effect.gen(function* () {
      expect((yield* selectSteps(all, Option.some('aws')).pipe(Effect.flip)).message).toContain(
        'unknown: aws'
      )
      expect((yield* selectSteps(all, Option.some('upstash')).pipe(Effect.flip)).message).toContain(
        'does not declare'
      )
    })
  )
})
