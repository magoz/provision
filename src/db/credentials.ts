import { Effect, FileSystem, Option, Predicate, Redacted, Schema } from 'effect'
import { parseEnvFile } from '../shared/env-file.ts'
import { readPrivately, writePrivately } from '../shared/private-file.ts'
import { capture } from '../shared/process.ts'
import { ConfigurationError } from './domain.ts'
import { DbEnvironment } from './environment.ts'

/**
 * Global credential storage behind `provision db auth`. Backends, in read precedence order:
 *
 *   1. environment - explicit override, useful for CI or a parent process
 *   2. keychain    - encrypted at rest (macOS)
 *   3. config file - `0600` fallback for machines without a keychain
 */

const SERVICE = 'sandbox-db'

const ACCOUNT = 'neon-api-key'

export const API_KEY_ENV = 'NEON_AGENTS_SANDBOX_API_KEY'

const PROJECT_ENV = 'NEON_AGENTS_SANDBOX_PROJECT_ID'

const PARENT_ENV = 'NEON_AGENTS_SANDBOX_PARENT_BRANCH'

export type Backend = 'environment' | 'keychain' | 'file'

export interface Settings {
  readonly projectId: Option.Option<string>
  readonly parentBranch: Option.Option<string>
}

export interface ResolvedSecret {
  readonly value: Redacted.Redacted<string>
  readonly backend: Backend
}

export const settingsLocation = Effect.gen(function* () {
  return `${(yield* DbEnvironment).configDirectory}/sandbox-db.json`
})

export const secretFileLocation = Effect.gen(function* () {
  return `${(yield* DbEnvironment).configDirectory}/sandbox-db.env`
})

const ensureConfigDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const environment = yield* DbEnvironment
  yield* fs
    .makeDirectory(environment.configDirectory, { recursive: true })
    .pipe(Effect.orElseSucceed(() => undefined))
})

// ---------------------------------------------------------------------------
// keychain backend
// ---------------------------------------------------------------------------

const keychainAvailable = Effect.gen(function* () {
  const environment = yield* DbEnvironment

  if (!environment.keychain) return false

  return yield* capture('which', ['security']).pipe(
    Effect.map(result => result.exitCode === 0),
    Effect.orElseSucceed(() => false)
  )
})

const keychainRead = capture('security', [
  'find-generic-password',
  '-s',
  SERVICE,
  '-a',
  ACCOUNT,
  '-w'
]).pipe(
  Effect.map(result => {
    const trimmed = result.stdout.trim()

    return result.exitCode === 0 && trimmed.length > 0 ? Option.some(trimmed) : Option.none()
  }),
  Effect.orElseSucceed(() => Option.none<string>())
)

/**
 * `security` takes the secret as an argument, so it is briefly visible in the process table to
 * this user. That is the same trust boundary as the `0600` file it replaces; the win is
 * encryption at rest, not process isolation.
 */
const keychainWrite = (secret: Redacted.Redacted<string>) =>
  capture('security', [
    'add-generic-password',
    '-s',
    SERVICE,
    '-a',
    ACCOUNT,
    '-w',
    Redacted.value(secret),
    '-U',
    '-D',
    'sandbox-db neon api key'
  ]).pipe(
    Effect.mapError(
      () => new ConfigurationError({ message: 'keychain unavailable; provider output suppressed' })
    ),
    Effect.flatMap(result =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new ConfigurationError({ message: `keychain write failed (exit ${result.exitCode})` })
          )
    )
  )

const keychainDelete = capture('security', [
  'delete-generic-password',
  '-s',
  SERVICE,
  '-a',
  ACCOUNT
]).pipe(
  Effect.map(result => result.exitCode === 0),
  Effect.orElseSucceed(() => false)
)

// ---------------------------------------------------------------------------
// file backend
// ---------------------------------------------------------------------------

const readSecretFile = Effect.gen(function* () {
  const file = yield* secretFileLocation
  const content = yield* readPrivately(file).pipe(Effect.orElseSucceed(() => undefined))

  return new Map(parseEnvFile(content ?? ''))
})

const writeSecretFile = (entries: ReadonlyMap<string, string>) =>
  Effect.gen(function* () {
    yield* ensureConfigDirectory
    const file = yield* secretFileLocation
    const body = [...entries].map(([key, value]) => `${key}=${value}`).join('\n')
    yield* writePrivately(file, body.length > 0 ? `${body}\n` : '').pipe(
      Effect.mapError(
        () => new ConfigurationError({ message: `private config write failed: ${file}` })
      )
    )
  })

// ---------------------------------------------------------------------------
// secret api
// ---------------------------------------------------------------------------

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim()

  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

export const readSecret = Effect.gen(function* () {
  const environment = yield* DbEnvironment
  const fromEnvironment = nonEmpty(environment.variable(API_KEY_ENV))

  if (fromEnvironment !== undefined) {
    return Option.some<ResolvedSecret>({
      value: Redacted.make(fromEnvironment),
      backend: 'environment'
    })
  }

  if (yield* keychainAvailable) {
    const stored = yield* keychainRead

    if (Option.isSome(stored)) {
      return Option.some<ResolvedSecret>({
        value: Redacted.make(stored.value),
        backend: 'keychain'
      })
    }
  }

  const fromFile = nonEmpty((yield* readSecretFile).get(API_KEY_ENV))

  return fromFile === undefined
    ? Option.none<ResolvedSecret>()
    : Option.some<ResolvedSecret>({ value: Redacted.make(fromFile), backend: 'file' })
})

export const storeSecret = (secret: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    if (yield* keychainAvailable) {
      yield* keychainWrite(secret)
      // Do not leave an older plaintext copy behind once the keychain owns it.
      const entries = yield* readSecretFile

      if (entries.delete(API_KEY_ENV)) yield* writeSecretFile(entries)

      return 'keychain' satisfies Backend
    }

    const entries = yield* readSecretFile
    entries.set(API_KEY_ENV, Redacted.value(secret))
    yield* writeSecretFile(entries)

    return 'file' satisfies Backend
  })

export const clearSecret = Effect.gen(function* () {
  const removed: Array<Backend> = []

  if ((yield* keychainAvailable) && (yield* keychainDelete)) removed.push('keychain')

  const entries = yield* readSecretFile

  if (entries.delete(API_KEY_ENV)) {
    yield* writeSecretFile(entries)
    removed.push('file')
  }

  return removed
})

// ---------------------------------------------------------------------------
// non-secret settings
// ---------------------------------------------------------------------------

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Only string fields count; anything else (including deep structures) is skipped, not decoded. */
const storedString = (stored: unknown, key: string) =>
  Predicate.hasProperty(stored, key) && Predicate.isString(stored[key]) ? stored[key] : undefined

export const readSettings = Effect.gen(function* () {
  const environment = yield* DbEnvironment
  const file = yield* settingsLocation
  const content = yield* readPrivately(file).pipe(Effect.orElseSucceed(() => undefined))
  const stored = content === undefined ? undefined : Option.getOrUndefined(decodeJson(content))
  const legacy = yield* readSecretFile

  const pick = (variable: string, key: string) =>
    Option.fromUndefinedOr(
      nonEmpty(environment.variable(variable)) ??
        nonEmpty(storedString(stored, key)) ??
        nonEmpty(legacy.get(variable))
    )

  return {
    projectId: pick(PROJECT_ENV, 'projectId'),
    parentBranch: pick(PARENT_ENV, 'parentBranch')
  } satisfies Settings
})

export const writeSettings = (settings: {
  readonly projectId: string
  readonly parentBranch: string
}) =>
  Effect.gen(function* () {
    yield* ensureConfigDirectory
    const file = yield* settingsLocation
    yield* writePrivately(file, `${JSON.stringify(settings, null, 2)}\n`).pipe(
      Effect.mapError(() => new ConfigurationError({ message: `settings write failed: ${file}` }))
    )

    // Retire legacy plaintext settings now that the JSON store owns them.
    const entries = yield* readSecretFile
    const hadProject = entries.delete(PROJECT_ENV)
    const hadParent = entries.delete(PARENT_ENV)

    if (hadProject || hadParent) yield* writeSecretFile(entries)
  })
