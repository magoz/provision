import { execFileSync } from 'node:child_process'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Console, Effect, Layer, Option } from 'effect'
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
import { ManualStep } from './manual-step.ts'
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
    // What the operator does before answering each manual step; an empty queue skips it.
    const manualSteps: Array<() => boolean> = []
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
      Layer.succeed(ManualStep, {
        confirm: instructions =>
          Effect.sync(() => {
            prompts.push(instructions)

            return manualSteps.shift()?.() ?? false
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
    /** Runs and returns what the command printed. */
    const output = (...args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const console = yield* Console.Console
        yield* run(...args).pipe(
          Effect.provideService(Console.Console, {
            ...console,
            log: (...values: ReadonlyArray<unknown>) => {
              lines.push(values.map(String).join(' '))
            },
            error: (...values: ReadonlyArray<unknown>) => {
              lines.push(values.map(String).join(' '))
            }
          })
        )

        return lines.join('\n')
      })

    return { repo, world, invocations, run, output, answers, prompts, manualSteps }
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

/** Adds a branch Neon's Vercel integration leaves in `acme-app-dev` once connected. */
const neonBranch = (world: FakeWorld, name: string) => {
  world.neon.projects
    .find(project => project.name === 'acme-app-dev')
    ?.branches.push({ id: `br-${name}`, name, default: false, protected: false })
}

const projectIdOf = (world: FakeWorld) => [...world.vercel.projects.values()][0]?.id ?? ''

/** Adds Vercel records to the project (`configurationId` set: owned by that integration). */
const addRecords = (
  world: FakeWorld,
  entries: ReadonlyArray<{
    readonly key: string
    readonly target: ReadonlyArray<string>
    readonly value: string
    readonly type?: string
    readonly configurationId?: string
  }>
) => {
  const projectId = projectIdOf(world)
  world.vercel.envs.set(projectId, [
    ...(world.vercel.envs.get(projectId) ?? []),
    ...entries.map(entry => ({
      id: `${entry.configurationId ?? 'own'}-${entry.key}-${entry.target.join('-')}`,
      type: 'encrypted',
      customEnvironmentIds: [],
      ...entry
    }))
  ])
}

const databaseUrlKeys = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']

/**
 * The operator connects `acme-app-dev` in Neon's console, then confirms: Neon writes its
 * Production and Development variables and, with "Create a branch for your development
 * environment" on, creates `vercel-dev`.
 */
const connectInNeon =
  (world: FakeWorld, options: { readonly devBranch?: boolean } = {}) =>
  () => {
    if (options.devBranch !== false) neonBranch(world, 'vercel-dev')

    addRecords(
      world,
      ['production', 'development'].flatMap(target =>
        databaseUrlKeys.map(key => ({
          key,
          target: [target],
          value: 'postgres://acme-app-dev/neondb',
          configurationId: 'icfg_neon'
        }))
      )
    )

    return true
  }

/** The follow-up line a run printed, if any. */
const next = (printed: string) => printed.split('\n').find(line => line.includes('next:'))

afterEach(() => {
  process.exitCode = undefined
})

describe('provision factory', () => {
  it.live('provisions every step for a fresh repository', () =>
    Effect.gen(function* () {
      const { repo, world, invocations, run, manualSteps } = yield* setup()
      manualSteps.push(connectInNeon(world))

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
      const { repo, world, run, manualSteps } = yield* setup()
      manualSteps.push(connectInNeon(world))
      yield* run('--on-existing', 'abort', ...secretFlags)
      expect(recordFor(world, 'DATABASE_URL', 'production')).toHaveLength(1)
      const before = world.mutations.length
      const linkFile = join(repo, '.vercel', 'project.json')
      const linked = yield* Effect.promise(() => stat(linkFile))

      yield* run('--on-existing', 'reuse', ...secretFlags)

      expect(process.exitCode).toBeUndefined()
      expect(world.mutations.slice(before)).toEqual([])
      // An atomic rewrite would replace the inode; a matching link is left alone.
      expect((yield* Effect.promise(() => stat(linkFile))).ino).toBe(linked.ino)
    })
  )

  it.live('suggests a local follow-up only for what the run changed locally', () =>
    Effect.gen(function* () {
      const { output } = yield* setup()

      expect(next(yield* output('--dry-run', ...secretFlags))).toBeUndefined()

      const fresh = next(yield* output('--on-existing', 'abort', ...secretFlags))
      expect(fresh).toMatch(/next: provision env --repo \S+ --database$/)

      expect(next(yield* output('--on-existing', 'reuse', ...secretFlags))).toBeUndefined()
      expect(next(yield* output('--only', 'domain', '--on-existing', 'overwrite'))).toBeUndefined()

      const secrets = next(
        yield* output('--only', 'secrets', '--on-existing', 'overwrite', ...secretFlags)
      )
      expect(secrets).toMatch(/next: provision env --repo \S+ --skip-install --skip-setup$/)
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

        // The operator connects the integration: Vercel access, plus its own variables and branch.
        neonBranch(world, 'vercel-dev')
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

  it.live("waits for the operator to connect Neon's Vercel integration, then finishes", () =>
    Effect.gen(function* () {
      const { world, output, prompts, manualSteps } = yield* setup()
      world.vercel.integrations.splice(0, 1, { id: 'icfg_neon', slug: 'neon', projects: [] })

      const connect = () => {
        world.vercel.integrations.splice(0, 1, {
          id: 'icfg_neon',
          slug: 'neon',
          projects: [projectIdOf(world)]
        })

        return connectInNeon(world)()
      }

      // The operator first answers before connecting, then connects.
      manualSteps.push(() => true, connect)

      const printed = yield* output('--on-existing', 'abort', '--only', 'vercel,neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('still has no access to acme-app')
      expect(printed).not.toContain('manual: connect')
      expect(printed).toContain(
        'manual: check the first Preview deployment: it should create branch preview/<git-branch> in acme-app-dev'
      )
      expect(records(world).filter(record => record.configurationId !== undefined)).toEqual([])
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
        expect.objectContaining({ value: 'postgres://acme-app-prod-pooler/neondb' })
      ])
    })
  )

  it.live('treats access to all Vercel projects as not connected until Neon connects', () =>
    Effect.gen(function* () {
      const { world, output, prompts, manualSteps } = yield* setup()

      // The operator first answers before connecting in Neon, then declines.
      manualSteps.push(() => true)

      const printed = yield* output('--on-existing', 'abort', '--only', 'vercel,neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).not.toContain('Manage Access')
      expect(prompts[0]).toContain('Neon → project acme-app-dev → Integrations → Vercel')
      expect(prompts[1]).toContain('acme-app-dev is still not connected to acme-app')
      expect(printed).toContain('manual:')
      expect(printed).toContain('held back: Production DATABASE_URL')
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([])

      manualSteps.push(connectInNeon(world))
      yield* output('--on-existing', 'reuse', '--only', 'neon')
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
        expect.objectContaining({ value: 'postgres://acme-app-prod-pooler/neondb' })
      ])
    })
  )

  it.live('treats a listed Vercel project as not connected until Neon connects', () =>
    Effect.gen(function* () {
      const { world, run, output, prompts } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      const projectId = [...world.vercel.projects.values()][0]?.id ?? ''
      world.vercel.integrations.splice(0, 1, {
        id: 'icfg_neon',
        slug: 'neon',
        projects: [projectId]
      })

      const printed = yield* output('--on-existing', 'reuse', '--only', 'neon')

      expect(prompts).toHaveLength(1)
      expect(printed).toContain('manual:')
      expect(printed).toContain('held back: Production DATABASE_URL')
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([])
    })
  )

  for (const branch of ['vercel-dev', 'preview/feature']) {
    it.live(`treats access to all Vercel projects plus a ${branch} branch as connected`, () =>
      Effect.gen(function* () {
        const { world, run, output, prompts } = yield* setup()
        yield* run('--on-existing', 'abort', '--only', 'vercel,neon')
        expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([])
        neonBranch(world, branch)
        prompts.length = 0

        const printed = yield* output('--on-existing', 'reuse', '--only', 'neon')

        expect(process.exitCode).toBeUndefined()
        expect(prompts).toEqual([])
        expect(printed).not.toContain('manual:')
        expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
          expect.objectContaining({ value: 'postgres://acme-app-prod-pooler/neondb' })
        ])
      })
    )
  }

  it.live('treats a Preview record owned by the integration as connected and keeps it', () =>
    Effect.gen(function* () {
      const { world, run, output, prompts } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      const projectId = [...world.vercel.projects.values()][0]?.id ?? ''
      world.vercel.envs.set(projectId, [
        ...(world.vercel.envs.get(projectId) ?? []),
        {
          id: 'neon-DATABASE_URL-preview',
          key: 'DATABASE_URL',
          value: 'postgres://acme-app-dev-preview/neondb',
          type: 'encrypted',
          target: ['preview'],
          customEnvironmentIds: [],
          configurationId: 'icfg_neon'
        }
      ])

      const printed = yield* output('--on-existing', 'reuse', '--only', 'neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts).toEqual([])
      expect(printed).not.toContain('manual:')
      expect(recordFor(world, 'DATABASE_URL', 'preview')).toEqual([
        expect.objectContaining({ id: 'neon-DATABASE_URL-preview' })
      ])
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
        expect.objectContaining({ value: 'postgres://acme-app-prod-pooler/neondb' })
      ])
    })
  )

  it.live(
    'never writes Production on an all-projects installation until acme-app-dev is connected in Neon, then guides the connection in one run',
    () =>
      Effect.gen(function* () {
        const { world, run, output, prompts, manualSteps } = yield* setup()
        yield* run('--on-existing', 'abort', '--only', 'vercel')
        // Production already has acme-app-prod (as an earlier run wrote it), which blocks Neon.
        addRecords(
          world,
          databaseUrlKeys.map(key => ({
            key,
            target: ['production'],
            value: 'postgres://acme-app-prod-pooler/neondb'
          }))
        )

        // Without a terminal: nothing removed or rewritten, and it says how to finish.
        const unattended = yield* output('--on-existing', 'reuse', '--only', 'neon')

        expect(process.exitCode).toBeUndefined()
        expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
          expect.objectContaining({ id: 'own-DATABASE_URL-production' })
        ])
        expect(unattended).toContain('manual: connect')
        expect(unattended).toContain('run in a terminal: provision factory --checkout')
        expect(unattended).toContain(
          'it removes DATABASE_URL, DATABASE_URL_UNPOOLED (production) first'
        )
        expect(unattended).toContain('held back: Production DATABASE_URL')
        expect(unattended).not.toContain('vercel env rm')

        // Guided: remove the blockers, connect in Neon, check, then write Production.
        prompts.length = 0
        manualSteps.push(() => true, connectInNeon(world))
        const guided = yield* output('--on-existing', 'reuse', '--only', 'neon')

        expect(process.exitCode).toBeUndefined()
        expect(prompts).toHaveLength(2)
        expect(prompts[0]).toContain(
          'provision removes DATABASE_URL, DATABASE_URL_UNPOOLED (production) from Vercel'
        )
        expect(prompts[1]).not.toContain('provision removes')
        expect(prompts[1]).toContain(
          'Neon → project acme-app-dev → Integrations → Vercel → connect Vercel project acme-app, database neondb, role neondb_owner'
        )
        expect(prompts[1]).toContain('"Create a branch for your development environment"')
        expect(guided).toContain(
          'remove DATABASE_URL, DATABASE_URL_UNPOOLED (production) from Vercel so Neon'
        )
        expect(guided).toContain(
          "remove the Neon integration's DATABASE_URL, DATABASE_URL_UNPOOLED (production, development) from Vercel"
        )
        expect(guided).toContain('manual: check the first Preview deployment')
        expect(records(world).filter(record => record.configurationId !== undefined)).toEqual([])
        expect(recordFor(world, 'DATABASE_URL', 'development')).toEqual([])
        expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
          expect.objectContaining({
            value: 'postgres://acme-app-prod-pooler/neondb',
            type: 'sensitive'
          })
        ])
        expect(recordFor(world, 'DATABASE_URL', 'production')[0]?.id).not.toBe(
          'own-DATABASE_URL-production'
        )

        // Rerun: the integration's records are gone, vercel-dev says it is connected.
        prompts.length = 0
        const before = world.mutations.length
        const rerun = yield* output('--on-existing', 'reuse', '--only', 'neon')

        expect(process.exitCode).toBeUndefined()
        expect(prompts).toEqual([])
        expect(world.mutations.slice(before)).toEqual([])
        expect(rerun).toContain(
          "reusing Neon's Vercel integration: acme-app-dev is connected to acme-app (acme-app-dev/vercel-dev)"
        )
        expect(rerun).not.toContain('manual:')
      })
  )

  it.live('does not take a connection without vercel-dev for one a rerun would recognise', () =>
    Effect.gen(function* () {
      const { world, run, output, prompts } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel,neon')
      connectInNeon(world, { devBranch: false })()
      prompts.length = 0

      const printed = yield* output('--on-existing', 'reuse', '--only', 'neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts[0]).toContain('"Create a branch for your development environment" was off')
      expect(printed).toContain("remove the Neon integration's DATABASE_URL")
      expect(printed).toContain('held back: Production DATABASE_URL')
      expect(records(world).filter(record => record.configurationId !== undefined)).toEqual([])
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([])
    })
  )

  it.live('says Production has no DATABASE_URL when connecting stops after the removal', () =>
    Effect.gen(function* () {
      const { world, run, output, manualSteps } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addRecords(
        world,
        databaseUrlKeys.map(key => ({ key, target: ['production'], value: 'postgres://old/db' }))
      )
      manualSteps.push(() => true)

      const printed = yield* output('--on-existing', 'reuse', '--only', 'neon')

      expect(process.exitCode).toBeUndefined()
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([])
      expect(printed).toContain('until then Production has no DATABASE_URL')
      expect(printed).toContain('held back: Production DATABASE_URL')
    })
  )

  it.live('plans the removal of what blocks the integration in a dry run', () =>
    Effect.gen(function* () {
      const { world, run, output, prompts } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel,neon')
      addRecords(world, [
        { key: 'DATABASE_URL', target: ['production'], value: 'postgres://elsewhere/db' },
        { key: 'PGHOST', target: ['development'], value: 'elsewhere' }
      ])
      prompts.length = 0
      const before = world.mutations.length

      const printed = yield* output('--dry-run', '--only', 'neon')

      expect(process.exitCode).toBeUndefined()
      expect(world.mutations.slice(before)).toEqual([])
      expect(prompts).toEqual([])
      expect(printed).toContain(
        'would remove DATABASE_URL, PGHOST (production, development) from Vercel so Neon'
      )
      expect(printed).toContain('manual: connect')
    })
  )

  it.live('never touches database variables that also serve Preview', () =>
    Effect.gen(function* () {
      const { world, run, output, prompts } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel,neon')
      addRecords(world, [
        { key: 'DATABASE_URL', target: ['preview'], value: 'postgres://preview/db' },
        { key: 'PGHOST', target: ['development', 'preview'], value: 'shared' }
      ])
      prompts.length = 0

      const printed = yield* output('--on-existing', 'reuse', '--only', 'neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('take Production and Development off PGHOST (development)')
      expect(printed).not.toContain('remove PGHOST')
      expect(recordFor(world, 'DATABASE_URL', 'preview')).toHaveLength(1)
      expect(recordFor(world, 'PGHOST', 'preview')).toHaveLength(1)
    })
  )

  it.live('offers to delete the vercel-dev branch a failed connect attempt leaves', () =>
    Effect.gen(function* () {
      const { world, output, prompts, manualSteps } = yield* setup()
      const failedConnect = () => {
        neonBranch(world, 'vercel-dev')

        return true
      }
      manualSteps.push(failedConnect, () => true, connectInNeon(world))

      const printed = yield* output('--on-existing', 'abort', '--only', 'vercel,neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts).toHaveLength(3)
      expect(prompts[1]).toContain('the connect attempt failed after creating the branch')
      expect(prompts[1]).toContain('no app data')
      expect(prompts[2]).toContain('It is deleted; connect again.')
      expect(printed).toContain(
        'delete Neon branch acme-app-dev/vercel-dev left by the failed attempt'
      )
      expect(world.mutations).toContain(
        `console.neon.tech DELETE /api/v2/projects/${world.neon.projects[0]?.id}/branches/br-vercel-dev`
      )
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
        expect.objectContaining({ value: 'postgres://acme-app-prod-pooler/neondb' })
      ])
    })
  )

  it.live('asks to connect again when Neon created no vercel-dev branch', () =>
    Effect.gen(function* () {
      const { world, output, prompts, manualSteps } = yield* setup()
      manualSteps.push(connectInNeon(world, { devBranch: false }), connectInNeon(world))

      const printed = yield* output('--on-existing', 'abort', '--only', 'vercel,neon')

      expect(process.exitCode).toBeUndefined()
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('"Create a branch for your development environment" was off')
      expect(printed).toContain('manual: check the first Preview deployment')
      expect(records(world).filter(record => record.configurationId !== undefined)).toEqual([])
      expect(recordFor(world, 'DATABASE_URL', 'production')).toEqual([
        expect.objectContaining({ value: 'postgres://acme-app-prod-pooler/neondb' })
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
        Layer.succeed(ManualStep, { confirm: () => Effect.succeed(false) }),
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

const gatewayVariable = 'AI_GATEWAY_API_KEY'
const deployedKey = 'AI Gateway key acme-app (AI_GATEWAY_API_KEY: Production, Preview, Sensitive)'
const localKey = 'AI Gateway key acme-app-dev (AI_GATEWAY_API_KEY: Development)'

const gatewayKey = (world: FakeWorld, name: string) =>
  world.vercel.apiKeys.filter(key => key.name === name)

/** Keys of other projects on the team, enough to span several listing pages. */
const addOtherKeys = (world: FakeWorld) => {
  for (const name of ['other-app', 'other-app-dev', 'acme-app-staging']) {
    world.vercel.apiKeys.push({
      id: `key_${name}`,
      name,
      purpose: 'ai-gateway',
      value: `vck_${name}`
    })
  }
}

/**
 * What a setup by hand leaves: both keys (`vercel ai-gateway api-keys create`) and one record per
 * environment (`vercel env add`).
 */
const addManualSetup = (
  world: FakeWorld,
  options: { readonly withoutPreview?: boolean; readonly withoutDevelopment?: boolean } = {}
) => {
  addOtherKeys(world)
  world.vercel.apiKeys.push({
    id: 'key_prod',
    name: 'acme-app',
    purpose: 'ai-gateway',
    value: 'vck_prod'
  })

  if (options.withoutDevelopment !== true) {
    world.vercel.apiKeys.push({
      id: 'key_dev',
      name: 'acme-app-dev',
      purpose: 'ai-gateway',
      value: 'vck_dev'
    })
  }

  addRecords(world, [
    { key: gatewayVariable, target: ['production'], value: 'vck_prod', type: 'sensitive' },
    ...(options.withoutPreview === true
      ? []
      : [{ key: gatewayVariable, target: ['preview'], value: 'vck_prod', type: 'sensitive' }]),
    ...(options.withoutDevelopment === true
      ? []
      : [{ key: gatewayVariable, target: ['development'], value: 'vck_dev', type: 'encrypted' }])
  ])
}

/** The `[ai-gateway]` block a run printed. */
const block = (printed: string) => printed.split('[ai-gateway]\n')[1]?.split('\n\n')[0] ?? ''

const expectNoSecret = (
  printed: string,
  invocations: ReadonlyArray<Invocation>,
  world: FakeWorld
) => {
  const argv = JSON.stringify(invocations.map(invocation => invocation.args))

  for (const key of world.vercel.apiKeys) {
    expect(printed).not.toContain(key.value)
    expect(argv).not.toContain(key.value)
  }
}

describe('provision factory ai-gateway', () => {
  it.live('creates both keys and writes AI_GATEWAY_API_KEY without printing them', () =>
    Effect.gen(function* () {
      const { world, invocations, output } = yield* setup()
      addOtherKeys(world)

      const printed = yield* output('--on-existing', 'abort', '--only', 'vercel,ai-gateway')

      expect(process.exitCode).toBeUndefined()
      const [deployed] = gatewayKey(world, 'acme-app')
      const [local] = gatewayKey(world, 'acme-app-dev')
      expect(gatewayKey(world, 'acme-app')).toHaveLength(1)
      expect(gatewayKey(world, 'acme-app-dev')).toHaveLength(1)
      expect(records(world).filter(record => record.key === gatewayVariable)).toEqual([
        expect.objectContaining({
          value: deployed?.value,
          type: 'sensitive',
          target: ['production', 'preview'],
          customEnvironmentIds: []
        }),
        expect.objectContaining({
          value: local?.value,
          type: 'encrypted',
          target: ['development'],
          customEnvironmentIds: []
        })
      ])
      expect(deployed?.value).not.toBe(local?.value)

      const created = invocations
        .filter(invocation => invocation.args[1]?.startsWith('/v1/api-keys?teamId=') === true)
        .map(invocation => JSON.parse(invocation.input ?? 'null'))
      expect(created).toEqual([
        { purpose: 'ai-gateway', name: 'acme-app' },
        { purpose: 'ai-gateway', name: 'acme-app-dev' }
      ])

      expect(block(printed).split('\n')).toEqual([
        `  create ${deployedKey}`,
        '  write AI_GATEWAY_API_KEY to Vercel (Production, Preview)',
        `  create ${localKey}`,
        '  write AI_GATEWAY_API_KEY to Vercel (Development)'
      ])
      expect(next(printed)).toMatch(/next: provision env --repo \S+ --skip-install --skip-setup$/)
      expectNoSecret(printed, invocations, world)
    })
  )

  it.live('only reports reuse for keys and variables set up by hand', () =>
    Effect.gen(function* () {
      const { world, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addManualSetup(world)
      const before = world.mutations.length

      const printed = yield* output('--on-existing', 'reuse', '--only', 'ai-gateway')

      expect(process.exitCode).toBeUndefined()
      expect(world.mutations.slice(before)).toEqual([])
      expect(block(printed).split('\n')).toEqual([
        `  reusing ${deployedKey}`,
        `  reusing ${localKey}`
      ])
      expect(next(printed)).toBeUndefined()
    })
  )

  it.live('creates only the missing key when a run stopped partway', () =>
    Effect.gen(function* () {
      const { world, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addManualSetup(world, { withoutDevelopment: true })

      const printed = yield* output('--on-existing', 'reuse', '--only', 'ai-gateway')

      expect(process.exitCode).toBeUndefined()
      expect(gatewayKey(world, 'acme-app')).toEqual([expect.objectContaining({ id: 'key_prod' })])
      expect(gatewayKey(world, 'acme-app-dev')).toHaveLength(1)
      expect(recordFor(world, gatewayVariable, 'development')[0]?.value).toBe(
        gatewayKey(world, 'acme-app-dev')[0]?.value
      )
      expect(block(printed).split('\n')).toEqual([
        `  reusing ${deployedKey}`,
        `  create ${localKey}`,
        '  write AI_GATEWAY_API_KEY to Vercel (Development)'
      ])
    })
  )

  it.live('rotates a key whose value Vercel lacks only on overwrite', () =>
    Effect.gen(function* () {
      const { world, invocations, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addManualSetup(world, { withoutPreview: true })
      const before = world.mutations.length

      for (const policy of ['reuse', 'abort']) {
        process.exitCode = undefined
        yield* run('--on-existing', policy, '--only', 'ai-gateway')
        expect(process.exitCode).toBe(2)
      }

      expect(world.mutations.slice(before)).toEqual([])

      const dryRun = yield* output('--dry-run', '--only', 'ai-gateway')
      expect(block(dryRun)).toContain(
        `exists: ${deployedKey} (its value is missing from Vercel and cannot be recovered)`
      )

      process.exitCode = undefined
      const printed = yield* output('--on-existing', 'overwrite', '--only', 'ai-gateway')

      expect(process.exitCode).toBeUndefined()
      const [rotated] = gatewayKey(world, 'acme-app')
      expect(gatewayKey(world, 'acme-app')).toHaveLength(1)
      expect(rotated?.id).not.toBe('key_prod')
      expect(records(world).filter(record => record.key === gatewayVariable)).toEqual([
        expect.objectContaining({ target: ['production', 'preview'], value: rotated?.value }),
        expect.objectContaining({
          target: ['development'],
          value: gatewayKey(world, 'acme-app-dev')[0]?.value
        })
      ])
      // --on-existing applies to every key the step handles, complete ones included.
      expect(gatewayKey(world, 'acme-app-dev')).toHaveLength(1)
      expect(block(printed)).toContain(`rotate ${localKey}`)

      // The replacement is created and written before the old key is removed.
      const mutations = world.mutations.slice(before)
      const removed = mutations.indexOf('vercel DELETE /api-keys/key_prod')
      const created = mutations.indexOf('vercel POST /api-keys')
      const written = mutations.indexOf(`vercel POST /projects/${projectIdOf(world)}/env`)
      expect([created, written].every(index => index >= 0 && index < removed)).toBe(true)
      expectNoSecret(printed, invocations, world)
    })
  )

  it.live('rotates both keys on overwrite, removing the old ones', () =>
    Effect.gen(function* () {
      const { world, invocations, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel,ai-gateway')
      const previous = world.vercel.apiKeys.map(key => key.id)

      const printed = yield* output('--on-existing', 'overwrite', '--only', 'ai-gateway')

      expect(process.exitCode).toBeUndefined()
      expect(world.vercel.apiKeys.map(key => key.name)).toEqual(['acme-app', 'acme-app-dev'])
      expect(world.vercel.apiKeys.some(key => previous.includes(key.id))).toBe(false)
      expect(recordFor(world, gatewayVariable, 'production')[0]?.value).toBe(
        gatewayKey(world, 'acme-app')[0]?.value
      )
      expect(recordFor(world, gatewayVariable, 'development')[0]?.value).toBe(
        gatewayKey(world, 'acme-app-dev')[0]?.value
      )
      expect(records(world).filter(record => record.key === gatewayVariable)).toHaveLength(2)
      expectNoSecret(printed, invocations, world)
    })
  )

  it.live('removes a key it created when Vercel refuses the variable', () =>
    Effect.gen(function* () {
      const { world, run } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      // One record serving Preview and Development: replacing it would change Development too.
      addRecords(world, [
        { key: gatewayVariable, target: ['preview', 'development'], value: 'vck_elsewhere' }
      ])
      const before = world.mutations.length

      yield* run('--on-existing', 'overwrite', '--only', 'ai-gateway')

      expect(process.exitCode).toBe(2)
      const mutations = world.mutations.slice(before)
      expect(mutations[0]).toBe('vercel POST /api-keys')
      expect(mutations[1]).toMatch(/^vercel DELETE \/api-keys\/key_\d+$/)
      expect(mutations).toHaveLength(2)
      expect(world.vercel.apiKeys).toEqual([])
      expect(recordFor(world, gatewayVariable, 'preview')[0]?.value).toBe('vck_elsewhere')
    })
  )

  it.live('says which key to remove when removing it fails too', () =>
    Effect.gen(function* () {
      const { world, invocations, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addRecords(world, [
        { key: gatewayVariable, target: ['preview', 'development'], value: 'vck_elsewhere' }
      ])
      world.vercel.failKeyDeletes = true

      const printed = yield* output('--on-existing', 'overwrite', '--only', 'ai-gateway')

      expect(process.exitCode).toBe(2)
      const [left] = gatewayKey(world, 'acme-app')
      expect(block(printed)).toContain(
        `manual: remove AI Gateway key acme-app (${left?.id}): Vercel refused its variable and the removal failed`
      )
      // The original failure is what the run reports.
      expect(printed).toContain('has a record that also targets environments outside')
      expectNoSecret(printed, invocations, world)
    })
  )

  it.live('stops when an unfinished rotation left two keys with one name', () =>
    Effect.gen(function* () {
      const { world, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addManualSetup(world)
      world.vercel.apiKeys.push({
        id: 'key_prod_new',
        name: 'acme-app',
        purpose: 'ai-gateway',
        value: 'vck_prod_new'
      })
      const before = world.mutations.length

      const printed = yield* output('--on-existing', 'overwrite', '--only', 'ai-gateway')

      expect(process.exitCode).toBe(2)
      expect(printed).toContain('several AI Gateway keys are named acme-app')
      expect(printed).toContain('remove all but one by id')
      expect(world.mutations.slice(before)).toEqual([])
    })
  )

  it.live('replaces a variable set from another key only when --on-existing says so', () =>
    Effect.gen(function* () {
      const { world, run, output } = yield* setup()
      yield* run('--on-existing', 'abort', '--only', 'vercel')
      addRecords(world, [
        { key: gatewayVariable, target: ['production'], value: 'vck_other', type: 'sensitive' }
      ])
      const before = world.mutations.length

      const planned = yield* output('--dry-run', '--only', 'ai-gateway')
      expect(block(planned)).toContain('(missing from part of Production, Preview)')

      // Preview lacks it and its key is unknown: only overwrite can complete it.
      process.exitCode = undefined
      yield* run('--on-existing', 'abort', '--only', 'ai-gateway')
      expect(process.exitCode).toBe(2)
      process.exitCode = undefined
      const refused = yield* output('--on-existing', 'reuse', '--only', 'ai-gateway')
      expect(process.exitCode).toBe(2)
      expect(refused).toContain(
        'AI_GATEWAY_API_KEY is missing from part of Production, Preview and its key is unknown'
      )
      expect(world.mutations.slice(before)).toEqual([])

      addRecords(world, [
        { key: gatewayVariable, target: ['preview'], value: 'vck_other', type: 'sensitive' }
      ])
      process.exitCode = undefined
      const reused = yield* output('--on-existing', 'reuse', '--only', 'ai-gateway')
      expect(process.exitCode).toBeUndefined()
      expect(block(reused).split('\n')[0]).toBe(
        '  reusing AI_GATEWAY_API_KEY in Production, Preview'
      )
      expect(gatewayKey(world, 'acme-app')).toEqual([])
      expect(recordFor(world, gatewayVariable, 'production')[0]?.value).toBe('vck_other')
      // The development side had nothing, so its key was created.
      expect(gatewayKey(world, 'acme-app-dev')).toHaveLength(1)

      yield* run('--on-existing', 'overwrite', '--only', 'ai-gateway')
      expect(process.exitCode).toBeUndefined()
      expect(recordFor(world, gatewayVariable, 'preview')).toEqual([
        expect.objectContaining({
          target: ['production', 'preview'],
          value: gatewayKey(world, 'acme-app')[0]?.value
        })
      ])
    })
  )

  it.live('lists planned key names and environments in a dry run', () =>
    Effect.gen(function* () {
      const { world, run, output } = yield* setup()

      const fresh = yield* output('--dry-run', '--only', 'vercel,ai-gateway')
      expect(block(fresh).split('\n')).toEqual([
        `  would create ${deployedKey} after the vercel step creates the project`,
        `  would create ${localKey} after the vercel step creates the project`
      ])

      yield* run('--on-existing', 'abort', '--only', 'vercel')
      const before = world.mutations.length
      const planned = yield* output('--dry-run', '--only', 'ai-gateway')

      expect(process.exitCode).toBeUndefined()
      expect(world.mutations.slice(before)).toEqual([])
      expect(world.vercel.apiKeys).toEqual([])
      expect(block(planned).split('\n')).toEqual([
        `  would create ${deployedKey}`,
        `  would create ${localKey}`
      ])
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
