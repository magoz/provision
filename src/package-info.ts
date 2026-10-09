import { fileURLToPath } from 'node:url'
import { Data, Effect, FileSystem, Schema } from 'effect'

const PackageInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})

export type PackageInfo = typeof PackageInfo.Type

export class PackageInfoError extends Data.TaggedError('PackageInfoError')<{
  readonly message: string
}> {}

// `src/` (development) and `dist/` (published) both sit one level below the package root.
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))

export const readPackageInfo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(packageJsonPath)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageInfo))(text)
}).pipe(
  Effect.mapError(
    cause =>
      new PackageInfoError({ message: `cannot read provision package.json: ${cause.message}` })
  )
)
