#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, Layer } from 'effect'
import { Command } from 'effect/cli'
import { FetchHttpClient } from 'effect/http'
import { contractFor } from './contract.ts'
import { dbCommand } from './db/commands.ts'
import { DbEnvironmentLive } from './db/environment.ts'
import { envCommand } from './env/commands.ts'
import { factoryCommand } from './factory/commands.ts'
import { configCommand } from './factory/config-commands.ts'
import { PassphraseLive } from './factory/passphrase.ts'
import { RegistryLocationLive } from './factory/registry.ts'
import { SecretInputLive } from './factory/secret-input.ts'
import { readPackageInfo } from './package-info.ts'
import { ProcessRunnerLive } from './shared/process.ts'

// Private configuration, lease, and env files are protected from their first write.
process.umask(0o077)

const contract = Command.make('contract', {}, () =>
  Effect.gen(function* () {
    const info = yield* readPackageInfo
    yield* Console.log(JSON.stringify(contractFor(info.version)))
  })
).pipe(Command.withDescription('Print the machine-readable CLI contract as JSON'))

const provision = Command.make('provision').pipe(
  Command.withDescription(
    'Provision projects (factory), local checkouts (env), and databases (db)'
  ),
  Command.withSubcommands([contract, configCommand, factoryCommand, envCommand, dbCommand])
)

const main = Effect.gen(function* () {
  const info = yield* readPackageInfo
  yield* Command.run(provision, { version: info.version })
})

const AppLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  DbEnvironmentLive,
  RegistryLocationLive,
  PassphraseLive,
  SecretInputLive,
  ProcessRunnerLive
).pipe(Layer.provideMerge(NodeServices.layer))

main.pipe(Effect.provide(AppLayer), NodeRuntime.runMain)
