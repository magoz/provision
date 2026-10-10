import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { Command } from 'effect/cli'
import { scriptedProcessLayer, type Invocation } from '../testing/scripted-process.ts'
import { passphraseLayer, temporaryDirectory } from '../testing/temporary.ts'
import { configCommand } from './config-commands.ts'
import { decodeCredentials, opErrorMessage } from './onepassword.ts'
import { RegistryLocation } from './registry.ts'

const fields = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([key, value]) => [key, Redacted.make(value)]))

const base = { 'github.owner': 'acme', 'vercel.team_id': 'team_acme' }

afterEach(() => {
  process.exitCode = undefined
})

describe('opErrorMessage', () => {
  it('keeps the first error line without its timestamp or colors', () => {
    expect(
      opErrorMessage(
        '\u001b[31m[ERROR] 2026/10/10 06:58:01 "provision" isn\'t an item in the "acme" vault.\u001b[0m\nmore\n'
      )
    ).toBe('"provision" isn\'t an item in the "acme" vault.')
    expect(opErrorMessage('')).toBeUndefined()
  })
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

const sessionToken = 'operator-session-token'

const serviceAccountToken = `ops_${'s'.repeat(40)}`

/**
 * A stateful 1Password and systemd-creds stand-in: vault, item, service account, and the
 * operator session, plus the fields the operator "fills in" through `fill`.
 */
interface Initial {
  readonly vault: boolean
  readonly item: Record<string, string> | undefined
  readonly failVaultCreate?: boolean
}

const fakeOnePassword = (initial: Initial) => {
  const edits: Array<ReadonlyArray<string>> = []
  const state = {
    ...initial,
    item: initial.item === undefined ? undefined : { ...initial.item },
    serviceAccounts: 0,
    edits
  }

  const script = (invocation: Invocation) => {
    const [noun, verb] = invocation.args

    if (invocation.command === 'systemd-creds') {
      return verb === 'encrypt'
        ? Effect.promise(() => writeFile(invocation.args[4] ?? '', invocation.input ?? '')).pipe(
            Effect.as(undefined)
          )
        : Effect.promise(() => readFile(invocation.args[3] ?? '', 'utf8')).pipe(
            Effect.map(stdout => ({ stdout }))
          )
    }

    if (noun === 'account') return { stdout: '[{"url":"https://my.1password.com"}]' }

    if (noun === 'signin') return { stdout: `export OP_SESSION_abc="${sessionToken}"\n` }

    if (noun === 'signout') return undefined

    if (noun === 'vault' && verb === 'get') return { exitCode: state.vault ? 0 : 1 }

    if (noun === 'vault' && verb === 'create') {
      if (initial.failVaultCreate === true) return { exitCode: 1 }

      state.vault = true

      return undefined
    }

    if (noun === 'service-account') {
      state.serviceAccounts += 1

      return { stdout: `${serviceAccountToken}\n` }
    }

    if (noun === 'item' && verb === 'create') {
      const template: {
        fields: ReadonlyArray<{ label: string; section: { id: string } }>
      } = JSON.parse(invocation.input ?? '{}')
      state.item = Object.fromEntries(
        template.fields.map(field => [`${field.section.id}.${field.label}`, ''])
      )

      return undefined
    }

    if (noun === 'item' && verb === 'edit') {
      const assignments = invocation.args.slice(5)
      state.edits.push(assignments)

      for (const assignment of assignments) {
        const key = assignment.replace(/\[.*$/, '')

        if (state.item !== undefined && !(key in state.item)) state.item[key] = ''
      }

      return undefined
    }

    if (noun === 'item' && verb === 'get') {
      return state.item === undefined ? { exitCode: 1 } : { stdout: opItem(state.item) }
    }

    return { exitCode: 1 }
  }

  return { state, script }
}

const opItem = (entries: Record<string, string>) =>
  JSON.stringify({
    fields: Object.entries(entries).map(([key, value]) => {
      const [section, label] = key.split('.')

      return { label, value, section: { label: section } }
    })
  })

const setup = (initial: Initial) =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory('provision-registry')
    const file = join(directory, 'provision', 'config.json')
    const invocations: Array<Invocation> = []
    const onePassword = fakeOnePassword(initial)

    const layer = Layer.mergeAll(
      scriptedProcessLayer(onePassword.script, invocations),
      passphraseLayer(),
      Layer.succeed(RegistryLocation, { file })
    )

    const run = (...args: ReadonlyArray<string>) =>
      Command.runWith(configCommand, { version: 'test' })(args).pipe(Effect.provide(layer))

    const registry = Effect.promise(() => readFile(file, 'utf8').catch(() => undefined))

    return { directory, file, invocations, onePassword, run, registry }
  })

const add = ['add', '--name', 'acme', '--vault', 'provision-acme', '--yes'] as const

const opCalls = (invocations: ReadonlyArray<Invocation>) =>
  invocations
    .filter(invocation => invocation.command === 'op')
    .map(invocation => invocation.args.slice(0, 2).join(' '))

describe('provision config add', () => {
  it.live('sets up a new factory end to end, pausing for the operator to fill the item', () =>
    Effect.gen(function* () {
      const { file, invocations, onePassword, run, registry } = yield* setup({
        vault: false,
        item: undefined
      })

      yield* run(...add)

      expect(process.exitCode).toBe(2)
      expect(yield* registry).toBeUndefined()
      expect(onePassword.state.vault).toBe(true)
      expect(Object.keys(onePassword.state.item ?? {})).toContain('neon.api_key')
      expect(Object.values(onePassword.state.item ?? {}).every(value => value === '')).toBe(true)
      expect(onePassword.state.serviceAccounts).toBe(1)
      expect(opCalls(invocations)).toEqual([
        'account list',
        'signin',
        'vault get',
        'vault create',
        'item get',
        'item create',
        'service-account create',
        'signout',
        'item get'
      ])
      expect(onePassword.state.edits).toEqual([])

      const signin = invocations.find(invocation => invocation.args[0] === 'signin')
      expect(signin?.interactive).toBe(true)

      const create = invocations.find(invocation => invocation.args[0] === 'service-account')
      expect(create?.args).toEqual([
        'service-account',
        'create',
        'provision-acme',
        '--vault',
        'provision-acme:read_items',
        '--raw'
      ])
      expect(create?.env).toEqual({ OP_SESSION_abc: sessionToken })

      const read = invocations.filter(invocation => invocation.args[0] === 'item').at(-1)
      expect(read?.env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken })

      // The operator fills in the item; the rerun needs only the passphrase.
      onePassword.state.item = { ...onePassword.state.item, ...base }
      process.exitCode = undefined
      const before = invocations.length
      yield* run(...add)

      expect(process.exitCode).toBeUndefined()
      expect(opCalls(invocations.slice(before))).toEqual(['item get'])
      expect(onePassword.state.serviceAccounts).toBe(1)
      expect(JSON.parse((yield* registry) ?? '{}')).toEqual({
        factories: { acme: { vault: 'provision-acme', item: 'provision', githubOwner: 'acme' } }
      })
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)

      const argv = JSON.stringify(invocations.map(invocation => invocation.args))
      expect(argv).not.toContain(sessionToken)
      expect(argv).not.toContain(serviceAccountToken)

      yield* run('remove', 'acme')
      expect(JSON.parse((yield* registry) ?? '{}')).toEqual({ factories: {} })
    })
  )

  it.live('adds missing fields to an existing item without touching filled ones', () =>
    Effect.gen(function* () {
      const { invocations, onePassword, run } = yield* setup({ vault: true, item: base })

      yield* run(...add)

      // github and vercel are filled; the other sections are optional, so it registers.
      expect(process.exitCode).toBeUndefined()
      expect(opCalls(invocations)).toEqual([
        'account list',
        'signin',
        'vault get',
        'item get',
        'item edit',
        'service-account create',
        'signout',
        'item get'
      ])

      const added = onePassword.state.edits[0] ?? []
      expect(added).toContain('neon.api_key[password]=')
      expect(added).toContain('resend.sending_domain[text]=')
      expect(added.some(assignment => assignment.startsWith('github.owner'))).toBe(false)
      expect(onePassword.state.item?.['github.owner']).toBe('acme')
    })
  )

  it.live('adds missing fields on a rerun with the stored token', () =>
    Effect.gen(function* () {
      const { invocations, onePassword, run } = yield* setup({ vault: true, item: base })
      yield* run(...add)

      // The item loses fields after setup, e.g. recreated by hand.
      onePassword.state.item = { ...base }
      process.exitCode = undefined
      const before = invocations.length
      yield* run(...add)

      expect(opCalls(invocations.slice(before))).toEqual([
        'item get',
        'account list',
        'signin',
        'item get',
        'item edit',
        'signout',
        'item get'
      ])
      expect(onePassword.state.serviceAccounts).toBe(1)
    })
  )

  it.live('recreates a deleted item on a rerun with the stored token', () =>
    Effect.gen(function* () {
      const { invocations, onePassword, run } = yield* setup({ vault: true, item: base })
      yield* run(...add)

      onePassword.state.item = undefined
      process.exitCode = undefined
      const before = invocations.length
      yield* run(...add)

      expect(opCalls(invocations.slice(before))).toEqual([
        'item get',
        'account list',
        'signin',
        'item get',
        'item create',
        'signout',
        'item get'
      ])
      expect(Object.keys(onePassword.state.item ?? {})).toContain('github.owner')
      expect(onePassword.state.serviceAccounts).toBe(1)
      // The recreated item is empty, so registration waits for the operator.
      expect(process.exitCode).toBe(2)
    })
  )

  it.live('signs out even when setup fails', () =>
    Effect.gen(function* () {
      const { invocations, run } = yield* setup({
        vault: false,
        item: undefined,
        failVaultCreate: true
      })

      yield* run(...add)

      expect(process.exitCode).toBe(2)
      expect(opCalls(invocations).at(-1)).toBe('signout')
      expect(opCalls(invocations)).not.toContain('service-account create')
    })
  )

  it.live('rejects invalid factory names', () =>
    Effect.gen(function* () {
      const { invocations, run } = yield* setup({ vault: true, item: base })

      yield* run('add', '--name', 'Acme Corp', '--vault', 'v', '--item', 'i')

      expect(process.exitCode).toBe(2)
      expect(invocations).toEqual([])
    })
  )
})
