import { posix } from 'node:path'
import { Data, Effect, FileSystem, Path, Predicate, Schema } from 'effect'

/** Factory steps in execution order. `--only` and `provision.factory.steps` select a subset. */
export const factorySteps = [
  'vercel',
  'neon',
  'r2',
  'upstash',
  'resend',
  'reports',
  'secrets',
  'domain'
] as const

export type FactoryStep = (typeof factorySteps)[number]

/**
 * How the Neon development project provides the parent branch for disposable databases:
 * - `empty-baseline`: the factory owns the `<repo>-dev` project and its protected, empty default
 *   `baseline` branch; `setup` migrates. `provision db` attests this before every mutation;
 * - `existing-branch`: the repository maintains its own development data and branch.
 *
 * Undeclared (`undefined`): `provision db` skips the attestation; `provision factory` treats it as
 * `empty-baseline`.
 */
export const sandboxParentModes = ['empty-baseline', 'existing-branch'] as const

export type SandboxParentMode = (typeof sandboxParentModes)[number]

/** Repository-declared provisioning settings, from the root `package.json` `provision` key. */
export interface RepoConfig {
  /** Checkout-relative application directory (POSIX, normalized); `.` for single-app repos. */
  readonly appDir: string
  /** Commands run by `provision env` after env files and databases are ready. */
  readonly setup: ReadonlyArray<string>
  readonly factory: {
    readonly steps: ReadonlyArray<FactoryStep>
    readonly neon: { readonly sandboxParent: SandboxParentMode | undefined }
  }
}

export class RepoConfigError extends Data.TaggedError('RepoConfigError')<{
  readonly message: string
}> {}

const SetupCommand = Schema.Trimmed.check(Schema.isNonEmpty())

const ProvisionInput = Schema.Struct({
  appDir: Schema.optionalKey(Schema.NonEmptyString),
  setup: Schema.optionalKey(Schema.Array(SetupCommand)),
  factory: Schema.optionalKey(
    Schema.Struct({
      steps: Schema.optionalKey(
        Schema.NonEmptyArray(Schema.Literals(factorySteps)).check(Schema.isUnique())
      ),
      neon: Schema.optionalKey(
        Schema.Struct({
          sandboxParent: Schema.optionalKey(Schema.Literals(sandboxParentModes))
        })
      )
    })
  )
})

const PackageJson = Schema.Struct({
  provision: Schema.optionalKey(Schema.Unknown),
  provisionEnv: Schema.optionalKey(Schema.Unknown),
  worktree: Schema.optionalKey(Schema.Unknown)
})

const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson))

const decodeProvision = Schema.decodeUnknownEffect(ProvisionInput, {
  onExcessProperty: 'error',
  errors: 'all'
})

const configError = (message: string) => new RepoConfigError({ message })

export const normalizeAppDir = (appDir: string): string | undefined => {
  if (appDir.includes('\\') || posix.isAbsolute(appDir)) return undefined
  const normalized = posix.normalize(appDir).replace(/\/+$/, '')
  if (normalized === '' || normalized === '..' || normalized.startsWith('../')) return undefined
  return normalized
}

export const defaultRepoConfig: RepoConfig = {
  appDir: '.',
  setup: [],
  factory: { steps: factorySteps, neon: { sandboxParent: undefined } }
}

/** Parses root `package.json` text into a resolved {@link RepoConfig}. */
export const parseRepoConfig = (packageJsonText: string) =>
  Effect.gen(function* () {
    const packageJson = yield* decodePackageJson(packageJsonText).pipe(
      Effect.mapError(cause => configError(`invalid package.json: ${cause.message}`))
    )

    if (packageJson.provisionEnv !== undefined) {
      return yield* configError(
        'package.json "provisionEnv" is no longer read; move "provisionEnv.appDir" to "provision.appDir"'
      )
    }

    if (Predicate.hasProperty(packageJson.worktree, 'setup')) {
      return yield* configError(
        'package.json "worktree.setup" is no longer read; move it to "provision.setup"'
      )
    }

    const input = yield* decodeProvision(packageJson.provision ?? {}).pipe(
      Effect.mapError(cause => configError(`invalid package.json "provision": ${cause.message}`))
    )

    const appDir = normalizeAppDir(input.appDir ?? '.')

    if (appDir === undefined) {
      return yield* configError(
        'package.json "provision.appDir" must be a relative path inside the checkout'
      )
    }

    const selected = input.factory?.steps

    return {
      appDir,
      setup: input.setup ?? [],
      factory: {
        steps:
          selected === undefined
            ? factorySteps
            : factorySteps.filter(step => selected.includes(step)),
        neon: { sandboxParent: input.factory?.neon?.sandboxParent }
      }
    } satisfies RepoConfig
  })

/** Reads the checkout root's `package.json`; a checkout without one uses the defaults. */
export const readRepoConfig = (checkoutRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(checkoutRoot, 'package.json')
    const exists = yield* fs.exists(file)

    if (!exists) return defaultRepoConfig

    const text = yield* fs.readFileString(file)
    return yield* parseRepoConfig(text)
  }).pipe(
    Effect.catchTag('PlatformError', cause =>
      Effect.fail(configError(`cannot read package.json: ${cause.message}`))
    )
  )
