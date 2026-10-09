import { join } from 'node:path'
import { Context, Data, Effect, FileSystem, Layer, Option, Schema } from 'effect'
import { readPrivately, writePrivately } from '../shared/private-file.ts'

/**
 * The CLI-owned factory registry: where each factory's 1Password item lives. Non-secret; stored at
 * `${XDG_CONFIG_HOME:-~/.config}/provision/config.json` with mode `0600`.
 */
export class RegistryLocation extends Context.Service<
  RegistryLocation,
  { readonly file: string }
>()('provision/factory/RegistryLocation') {}

export const RegistryLocationLive = Layer.sync(RegistryLocation, () => ({
  file: join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
    'provision',
    'config.json'
  )
}))

export class RegistryError extends Data.TaggedError('RegistryError')<{
  readonly message: string
}> {}

export const factoryNamePattern = /^[a-z][a-z0-9-]{0,31}$/

const FactoryName = Schema.String.check(Schema.isPattern(factoryNamePattern))

export const FactoryEntry = Schema.Struct({
  vault: Schema.NonEmptyString,
  item: Schema.NonEmptyString,
  account: Schema.optionalKey(Schema.NonEmptyString)
})

export type FactoryEntry = typeof FactoryEntry.Type

const RegistryFile = Schema.Struct({
  factories: Schema.Record(FactoryName, FactoryEntry)
})

export type Registry = typeof RegistryFile.Type

const RegistryJson = Schema.fromJsonString(RegistryFile)

const emptyRegistry: Registry = { factories: {} }

export const readRegistry = Effect.gen(function* () {
  const { file } = yield* RegistryLocation
  const content = yield* readPrivately(file).pipe(
    Effect.mapError(error => new RegistryError({ message: error.message }))
  )

  if (content === undefined) return emptyRegistry

  return yield* Schema.decodeUnknownEffect(RegistryJson, { onExcessProperty: 'error' })(
    content
  ).pipe(
    Effect.mapError(
      cause => new RegistryError({ message: `invalid factory registry ${file}: ${cause.message}` })
    )
  )
})

export const writeRegistry = (registry: Registry) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { file } = yield* RegistryLocation
    const directory = file.slice(0, file.lastIndexOf('/'))
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError(() => new RegistryError({ message: `cannot create ${directory}` })))
    yield* writePrivately(file, `${JSON.stringify(registry, null, 2)}\n`).pipe(
      Effect.mapError(error => new RegistryError({ message: error.message }))
    )
  })

export const validateFactoryName = (name: string) =>
  factoryNamePattern.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new RegistryError({
          message:
            'factory names are 1-32 lowercase letters, digits, or hyphens, starting with a letter'
        })
      )

export const findFactory = (registry: Registry, name: string) =>
  Option.fromUndefinedOr(registry.factories[name])
