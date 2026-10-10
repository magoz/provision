import { Data, Effect, FileSystem, Option, Redacted } from 'effect'
import { capture } from '../shared/process.ts'
import { Passphrase } from './passphrase.ts'
import { RegistryLocation } from './registry.ts'
import { seal, unseal } from './sealed.ts'

/**
 * How `op` authenticates when the CLI reads factory items, in order:
 *
 * 1. `OP_SERVICE_ACCOUNT_TOKEN` already in the environment (`op` reads it itself);
 * 2. the factory's own read-only service-account token, sealed with the operator's provision
 *    passphrase and then encrypted with `systemd-creds --user` (TPM2-bound where available).
 *    Every run needs the passphrase, typed by the operator in a terminal: that is the approval.
 *    One token per factory keeps factories isolated;
 * 3. whatever `op` is signed in with: a manual `op signin` session or the desktop app.
 */

export class OpCredentialError extends Data.TaggedError('OpCredentialError')<{
  readonly message: string
}> {}

const credentialName = (factory: string) => `provision-op-${factory}`

const credentialPattern = /^op-service-account\.([a-z][a-z0-9-]{0,31})\.cred$/

export const serviceAccountTokenVariable = 'OP_SERVICE_ACCOUNT_TOKEN'

const registryDirectory = Effect.gen(function* () {
  const { file } = yield* RegistryLocation

  return file.slice(0, file.lastIndexOf('/'))
})

export const opCredentialFile = (factory: string) =>
  Effect.map(registryDirectory, directory => `${directory}/op-service-account.${factory}.cred`)

/** Factories with a stored token. */
export const storedTokenFactories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* registryDirectory
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

  return entries.flatMap(entry => {
    const factory = credentialPattern.exec(entry)?.[1]

    return factory === undefined ? [] : [factory]
  })
})

/** Service-account tokens are `ops_` followed by an encoded payload. */
export const parseServiceAccountToken = (value: string) => {
  const token = value.trim()

  return /^ops_[A-Za-z0-9_-]{20,}={0,2}$/.test(token)
    ? Effect.succeed(Redacted.make(token))
    : Effect.fail(
        new OpCredentialError({
          message: 'not a 1Password service-account token (expected ops_…)'
        })
      )
}

const unavailable = () =>
  new OpCredentialError({
    message:
      'systemd-creds is unavailable; export OP_SERVICE_ACCOUNT_TOKEN instead, or sign in with op'
  })

const decryptSealed = (factory: string, file: string) =>
  Effect.gen(function* () {
    const result = yield* capture('systemd-creds', [
      '--user',
      'decrypt',
      `--name=${credentialName(factory)}`,
      file,
      '-'
    ]).pipe(Effect.mapError(unavailable))

    if (result.exitCode !== 0) {
      return yield* new OpCredentialError({
        message: `cannot decrypt ${file} (exit ${result.exitCode}); store the token again with \`provision config op-token set --factory ${factory}\``
      })
    }

    return result.stdout
  })

/** Unseals one factory's stored token with the (prompted, cached) passphrase. */
const openStoredToken = (factory: string, file: string) =>
  Effect.gen(function* () {
    const sealed = yield* decryptSealed(factory, file)
    const passphrase = yield* (yield* Passphrase).get
    const token = yield* unseal(passphrase, sealed, credentialName(factory)).pipe(
      Effect.mapError(error =>
        error.reason === 'malformed'
          ? new OpCredentialError({
              message: `${file} is not passphrase-protected; store the token again with \`provision config op-token set --factory ${factory}\``
            })
          : new OpCredentialError({ message: `${error.message} for the ${factory} token` })
      )
    )

    return yield* parseServiceAccountToken(Redacted.value(token))
  })

/**
 * Seals the token with the provision passphrase, then encrypts it with `systemd-creds --user`
 * into a `0600` file. The first stored token chooses the passphrase; later ones must use the same
 * passphrase, proven by opening an existing token.
 */
export const storeServiceAccountToken = (factory: string, token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const passphrases = yield* Passphrase
    const file = yield* opCredentialFile(factory)
    const others = (yield* storedTokenFactories).filter(other => other !== factory)
    const existing = others[0]

    const passphrase =
      existing === undefined
        ? yield* passphrases.choose
        : yield* openStoredToken(existing, yield* opCredentialFile(existing)).pipe(
            Effect.andThen(passphrases.get),
            Effect.mapError(error =>
              error instanceof OpCredentialError && error.message.startsWith('wrong passphrase')
                ? new OpCredentialError({
                    message: `that is not the passphrase protecting the ${existing} token`
                  })
                : error
            )
          )

    const sealed = yield* seal(passphrase, token, credentialName(factory))

    yield* fs
      .makeDirectory(file.slice(0, file.lastIndexOf('/')), { recursive: true })
      .pipe(Effect.mapError(() => new OpCredentialError({ message: `cannot create ${file}` })))

    const result = yield* capture(
      'systemd-creds',
      ['--user', 'encrypt', `--name=${credentialName(factory)}`, '-', file],
      { input: sealed }
    ).pipe(Effect.mapError(unavailable))

    if (result.exitCode !== 0) {
      return yield* new OpCredentialError({
        message: `systemd-creds could not encrypt the token (exit ${result.exitCode})`
      })
    }

    yield* fs
      .chmod(file, 0o600)
      .pipe(Effect.mapError(() => new OpCredentialError({ message: `cannot protect ${file}` })))

    return file
  })

export const removeServiceAccountToken = (factory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* opCredentialFile(factory)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    if (!exists) return false

    yield* fs
      .remove(file)
      .pipe(Effect.mapError(() => new OpCredentialError({ message: `cannot remove ${file}` })))

    return true
  })

export type OpAuthSource =
  | { readonly kind: 'environment' }
  | {
      readonly kind: 'credential'
      readonly file: string
      readonly token: Redacted.Redacted<string>
    }
  | { readonly kind: 'session' }

/** Where `op` credentials would come from for a factory, without prompting or decrypting. */
export const describeOpAuth = (factory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if ((process.env[serviceAccountTokenVariable] ?? '').trim() !== '') {
      return 'service account (OP_SERVICE_ACCOUNT_TOKEN)'
    }

    const file = yield* opCredentialFile(factory)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    return exists ? `passphrase-protected service account (${file})` : 'op session or desktop app'
  })

/** Resolves how `op` authenticates for one factory; a stored token needs the passphrase. */
export const resolveOpAuth = (factory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if ((process.env[serviceAccountTokenVariable] ?? '').trim() !== '') {
      return { kind: 'environment' } satisfies OpAuthSource
    }

    const file = yield* opCredentialFile(factory)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    if (!exists) return { kind: 'session' } satisfies OpAuthSource

    const token = yield* openStoredToken(factory, file)

    return { kind: 'credential', file, token } satisfies OpAuthSource
  })

/** Child-only environment for `op` under a stored service-account token. */
export const opEnvironment = (source: OpAuthSource) =>
  source.kind === 'credential'
    ? Option.some({ [serviceAccountTokenVariable]: Redacted.value(source.token) })
    : Option.none<Record<string, string>>()
