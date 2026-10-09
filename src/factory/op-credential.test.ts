import { execFileSync } from 'node:child_process'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'
import { Command } from 'effect/cli'
import { scriptedProcessLayer, type Invocation } from '../testing/scripted-process.ts'
import { nodeTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { configCommand } from './config-commands.ts'
import {
  parseServiceAccountToken,
  resolveOpAuth,
  serviceAccountTokenVariable,
  storeServiceAccountToken
} from './op-credential.ts'
import { RegistryLocation } from './registry.ts'

const token = `ops_${'a'.repeat(40)}`

const systemdCredsAvailable = (() => {
  try {
    execFileSync('systemd-creds', ['--version'], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
})()

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

describe('stored service-account token', () => {
  it.live('is decrypted per run and handed to op through its environment only', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-op-token')
      const file = join(directory, 'config.json')
      const invocations: Array<Invocation> = []

      const layer = Layer.mergeAll(
        scriptedProcessLayer(invocation => {
          if (invocation.command === 'systemd-creds' && invocation.args[1] === 'encrypt') {
            return Effect.promise(() => writeFile(invocation.args[4] ?? '', 'encrypted')).pipe(
              Effect.as(undefined)
            )
          }

          if (invocation.command === 'systemd-creds') return { stdout: token }

          return { stdout: JSON.stringify({ fields: [] }) }
        }, invocations),
        Layer.succeed(RegistryLocation, { file })
      )

      yield* Effect.gen(function* () {
        yield* storeServiceAccountToken('acme', Redacted.make(token))
        const auth = yield* resolveOpAuth('acme')
        expect(auth.kind).toBe('credential')
      }).pipe(Effect.provide(layer))

      yield* Effect.promise(() =>
        writeFile(
          file,
          JSON.stringify({ factories: { acme: { vault: 'provision-acme', item: 'provision' } } })
        )
      )

      yield* Command.runWith(configCommand, { version: 'test' })(['verify']).pipe(
        Effect.provide(layer)
      )

      const encrypt = invocations.find(invocation => invocation.args[1] === 'encrypt')
      expect(encrypt?.input).toBe(token)
      expect(JSON.stringify(encrypt?.args)).not.toContain(token)

      const op = invocations.find(invocation => invocation.command === 'op')
      expect(op?.env).toEqual({ [serviceAccountTokenVariable]: token })
      expect(JSON.stringify(op?.args)).not.toContain(token)
      expect(process.env[serviceAccountTokenVariable]).toBeUndefined()
    })
  )
})

const describeSystemdCreds = systemdCredsAvailable ? describe : describe.skip

describeSystemdCreds('systemd-creds', () => {
  it.live('round-trips a token through the real systemd-creds', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-op-token-real')
      const layer = Layer.mergeAll(
        nodeTestLayer,
        Layer.succeed(RegistryLocation, { file: join(directory, 'config.json') })
      )

      const resolved = yield* Effect.gen(function* () {
        const stored = yield* storeServiceAccountToken('acme', Redacted.make(token))
        expect((yield* Effect.promise(() => stat(stored))).mode & 0o777).toBe(0o600)

        return yield* resolveOpAuth('acme')
      }).pipe(Effect.provide(layer))

      expect(resolved.kind).toBe('credential')
      expect(resolved.kind === 'credential' ? Redacted.value(resolved.token) : '').toBe(token)
    })
  )
})
