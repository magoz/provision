import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { Command } from 'effect/cli'
import { scriptedProcessLayer, type Invocation } from '../testing/scripted-process.ts'
import { temporaryDirectory } from '../testing/temporary.ts'
import { configCommand } from './config-commands.ts'
import { decodeCredentials } from './onepassword.ts'
import { RegistryLocation } from './registry.ts'

const fields = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([key, value]) => [key, Redacted.make(value)]))

const base = { 'github.owner': 'acme', 'vercel.team_id': 'team_acme' }

afterEach(() => {
  process.exitCode = undefined
})

describe('decodeCredentials', () => {
  it.effect('keeps only complete optional sections', () =>
    Effect.gen(function* () {
      const credentials = yield* decodeCredentials(
        fields({ ...base, 'neon.api_key': 'key', 'neon.org_id': 'org' })
      )

      expect(credentials.githubOwner).toBe('acme')
      expect(credentials.neon?.orgId).toBe('org')
      expect(credentials.cloudflare).toBeUndefined()
      expect(credentials.reportReceiver).toBeUndefined()
    })
  )

  it.effect('rejects partial sections, missing identity, and mutable team slugs', () =>
    Effect.gen(function* () {
      const partial = yield* decodeCredentials(fields({ ...base, 'neon.api_key': 'key' })).pipe(
        Effect.flip
      )
      expect(partial.message).toContain('neon (missing org_id)')

      const anonymous = yield* decodeCredentials(fields({ 'vercel.team_id': 'team_acme' })).pipe(
        Effect.flip
      )
      expect(anonymous.message).toContain('github.owner')

      const slug = yield* decodeCredentials(fields({ ...base, 'vercel.team_id': 'acme' })).pipe(
        Effect.flip
      )
      expect(slug.message).toContain('team_*')
    })
  )
})

const opItem = (entries: Record<string, string>) =>
  JSON.stringify({
    fields: Object.entries(entries).map(([key, value]) => {
      const [section, label] = key.split('.')

      return { label, value, section: { label: section } }
    })
  })

const setup = (item: Record<string, string>) =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory('provision-registry')
    const file = join(directory, 'provision', 'config.json')
    const invocations: Array<Invocation> = []

    const layer = Layer.mergeAll(
      scriptedProcessLayer(
        invocation => (invocation.command === 'op' ? { stdout: opItem(item) } : { exitCode: 1 }),
        invocations
      ),
      Layer.succeed(RegistryLocation, { file })
    )

    const run = (...args: ReadonlyArray<string>) =>
      Command.runWith(configCommand, { version: 'test' })(args).pipe(Effect.provide(layer))

    const registry = Effect.promise(() => readFile(file, 'utf8').catch(() => undefined))

    return { file, invocations, run, registry }
  })

describe('provision config', () => {
  it.live('adds a verified factory to a private registry', () =>
    Effect.gen(function* () {
      const { file, invocations, run, registry } = yield* setup(base)

      yield* run(
        'add',
        '--name',
        'acme',
        '--vault',
        'provision-factory-acme',
        '--item',
        'provision'
      )

      expect(process.exitCode).toBeUndefined()
      expect(JSON.parse((yield* registry) ?? '{}')).toEqual({
        factories: {
          acme: { vault: 'provision-factory-acme', item: 'provision', githubOwner: 'acme' }
        }
      })
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
      expect(invocations[0]?.args).toEqual([
        'item',
        'get',
        'provision',
        '--vault',
        'provision-factory-acme',
        '--format',
        'json',
        '--reveal'
      ])

      yield* run('remove', 'acme')
      expect(JSON.parse((yield* registry) ?? '{}')).toEqual({ factories: {} })
    })
  )

  it.live('refuses to register an incomplete item', () =>
    Effect.gen(function* () {
      const { run, registry } = yield* setup({ ...base, 'neon.api_key': 'key' })

      yield* run(
        'add',
        '--name',
        'acme',
        '--vault',
        'provision-factory-acme',
        '--item',
        'provision'
      )

      expect(process.exitCode).toBe(2)
      expect(yield* registry).toBeUndefined()
    })
  )

  it.live('rejects invalid factory names', () =>
    Effect.gen(function* () {
      const { invocations, run } = yield* setup(base)

      yield* run('add', '--name', 'Acme Corp', '--vault', 'v', '--item', 'i')

      expect(process.exitCode).toBe(2)
      expect(invocations).toEqual([])
    })
  )
})
