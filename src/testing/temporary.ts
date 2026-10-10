import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'
import { DbEnvironment } from '../db/environment.ts'
import { makePassphrase, Passphrase } from '../factory/passphrase.ts'
import { ProcessRunnerLive } from '../shared/process.ts'

/** A temporary directory removed when the surrounding scope closes. */
export const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), `${prefix}-`))),
    directory => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

/** Node platform services and the real process runner. */
export const nodeTestLayer = ProcessRunnerLive.pipe(Layer.provideMerge(NodeServices.layer))

export interface DbTestEnvironment {
  readonly configHome: string
  readonly stateHome: string
  readonly variables?: Readonly<Record<string, string>>
}

/** An isolated `DbEnvironment` rooted in temporary directories. */
export const dbEnvironmentLayer = (environment: DbTestEnvironment) =>
  Layer.succeed(DbEnvironment, {
    configDirectory: join(environment.configHome, 'pi'),
    stateDirectory: join(environment.stateHome, 'pi', 'sandbox-db'),
    variable: name => environment.variables?.[name],
    keychain: false
  })

/** Node platform services, the real process runner, and an isolated `DbEnvironment`. */
export const dbTestLayer = (environment: DbTestEnvironment) =>
  Layer.mergeAll(nodeTestLayer, dbEnvironmentLayer(environment))

export const testPassphrase = 'correct horse battery staple'

/** Answers every passphrase prompt with `answer` (default: `testPassphrase`). */
export const passphraseLayer = (answer: string = testPassphrase) =>
  Layer.sync(Passphrase, () => makePassphrase(() => Effect.succeed(Redacted.make(answer))))
