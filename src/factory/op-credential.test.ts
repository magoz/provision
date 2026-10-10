import { execFileSync } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { Command } from 'effect/cli'
import { scriptedProcessLayer, type Invocation } from '../testing/scripted-process.ts'
import {
  nodeTestLayer,
  passphraseLayer,
  temporaryDirectory,
  testPassphrase
} from '../testing/temporary.ts'
import { configCommand } from './config-commands.ts'
import {
  parseServiceAccountToken,
  resolveOpAuth,
  serviceAccountTokenVariable,
  storeServiceAccountToken
} from './op-credential.ts'
import { RegistryLocation } from './registry.ts'
import { seal, unseal } from './sealed.ts'

const token = `ops_${'a'.repeat(40)}`

const otherToken = `ops_${'b'.repeat(40)}`

/** Cheap KDF parameters for tests; production uses the defaults. */
const testKdf = { N: 2 ** 10, r: 8, p: 1 }

// A real per-user encryption, not just `--version`: CI runners ship systemd-creds without a usable
// user credential key.
const systemdCredsAvailable = (() => {
  try {
    execFileSync('systemd-creds', ['--user', 'encrypt', '--name=provision-probe', '-', '-'], {
      input: 'probe',
      stdio: ['pipe', 'ignore', 'ignore']
    })

    return true
  } catch {
    return false
  }
})()

/** A systemd-creds stand-in that stores its input as the "encrypted" file. */
const fakeCreds = (invocations: Array<Invocation>) =>
  scriptedProcessLayer(invocation => {
    if (invocation.command !== 'systemd-creds') return { stdout: JSON.stringify({ fields: [] }) }

    if (invocation.args[1] === 'encrypt') {
      return Effect.promise(() => writeFile(invocation.args[4] ?? '', invocation.input ?? '')).pipe(
        Effect.as(undefined)
      )
    }

    return Effect.promise(() => readFile(invocation.args[3] ?? '', 'utf8')).pipe(
      Effect.map(stdout => ({ stdout }))
    )
  }, invocations)

afterEach(() => {
  process.exitCode = undefined
})

describe('parseServiceAccountToken', () => {
  it.effect('accepts service-account tokens only', () =>
    Effect.gen(function* () {
      expect(Redacted.value(yield* parseServiceAccountToken(` ${token}\n`))).toBe(token)
      yield* parseServiceAccountToken('ops_short').pipe(Effect.flip)
      yield* parseServiceAccountToken(`opsx_${'a'.repeat(40)}`).pipe(Effect.flip)
    })
  )
})

describe('seal', () => {
  it.effect('round-trips and rejects a wrong passphrase or another credential name', () =>
    Effect.gen(function* () {
      const sealed = yield* seal(
        Redacted.make(testPassphrase),
        Redacted.make(token),
        'provision-op-acme',
        testKdf
      )

      expect(sealed).not.toContain(token)
      expect(
        Redacted.value(yield* unseal(Redacted.make(testPassphrase), sealed, 'provision-op-acme'))
      ).toBe(token)

      const wrong = yield* unseal(
        Redacted.make('wrong passphrase'),
        sealed,
        'provision-op-acme'
      ).pipe(Effect.flip)
      expect(wrong.reason).toBe('wrong-passphrase')

      const swapped = yield* unseal(
        Redacted.make(testPassphrase),
        sealed,
        'provision-op-other'
      ).pipe(Effect.flip)
      expect(swapped.reason).toBe('wrong-passphrase')
    })
  )
})

const setup = (answer?: string) =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory('provision-op-token')
    const file = join(directory, 'config.json')
    const invocations: Array<Invocation> = []
    const layer = (passphrase?: string) =>
      Layer.mergeAll(
        fakeCreds(invocations),
        passphraseLayer(passphrase ?? answer),
        Layer.succeed(RegistryLocation, { file })
      )

    return { directory, file, invocations, layer }
  })

describe('stored service-account token', () => {
  it.live('needs the passphrase and reaches op only through its environment', () =>
    Effect.gen(function* () {
      const { file, invocations, layer } = yield* setup()

      yield* storeServiceAccountToken('acme', Redacted.make(token)).pipe(Effect.provide(layer()))

      const stored = yield* Effect.promise(() =>
        readFile(join(file, '..', 'op-service-account.acme.cred'), 'utf8')
      )
      expect(stored).not.toContain(token)

      const wrong = yield* resolveOpAuth('acme').pipe(
        Effect.provide(layer('not the passphrase')),
        Effect.flip
      )
      expect(wrong.message).toContain('wrong passphrase')

      yield* Effect.promise(() =>
        writeFile(
          file,
          JSON.stringify({ factories: { acme: { vault: 'provision-acme', item: 'provision' } } })
        )
      )

      yield* Command.runWith(configCommand, { version: 'test' })(['verify']).pipe(
        Effect.provide(layer())
      )

      const op = invocations.find(invocation => invocation.command === 'op')
      expect(op?.env).toEqual({ [serviceAccountTokenVariable]: token })
      expect(JSON.stringify(invocations.map(invocation => invocation.args))).not.toContain(token)
      expect(process.env[serviceAccountTokenVariable]).toBeUndefined()
    })
  )

  it.live('requires every factory token to share one passphrase', () =>
    Effect.gen(function* () {
      const { layer } = yield* setup()

      yield* storeServiceAccountToken('acme', Redacted.make(token)).pipe(Effect.provide(layer()))

      const mismatch = yield* storeServiceAccountToken('other', Redacted.make(otherToken)).pipe(
        Effect.provide(layer('a different passphrase')),
        Effect.flip
      )
      expect(mismatch.message).toContain('not the passphrase protecting the acme token')

      yield* storeServiceAccountToken('other', Redacted.make(otherToken)).pipe(
        Effect.provide(layer())
      )
      const resolved = yield* resolveOpAuth('other').pipe(Effect.provide(layer()))
      expect(resolved.kind === 'credential' ? Redacted.value(resolved.token) : '').toBe(otherToken)
    })
  )
})

const describeSystemdCreds = systemdCredsAvailable ? describe : describe.skip

describeSystemdCreds('systemd-creds', () => {
  it.live('round-trips a sealed token through the real systemd-creds', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-op-token-real')
      const layer = Layer.mergeAll(
        nodeTestLayer,
        passphraseLayer(),
        Layer.succeed(RegistryLocation, { file: join(directory, 'config.json') })
      )

      const resolved = yield* Effect.gen(function* () {
        const stored = yield* storeServiceAccountToken('acme', Redacted.make(token))
        expect((yield* Effect.promise(() => stat(stored))).mode & 0o777).toBe(0o600)

        return yield* resolveOpAuth('acme')
      }).pipe(Effect.provide(layer))

      expect(resolved.kind === 'credential' ? Redacted.value(resolved.token) : '').toBe(token)
    })
  )
})
