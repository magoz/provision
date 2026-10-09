import { Data, Effect, FileSystem, Option, Redacted } from 'effect'
import { capture } from '../shared/process.ts'
import { RegistryLocation } from './registry.ts'

/**
 * How `op` authenticates when the CLI reads factory items, in order:
 *
 * 1. `OP_SERVICE_ACCOUNT_TOKEN` already in the environment (`op` reads it itself);
 * 2. the factory's own service-account token, stored next to the registry as a user-scoped
 *    `systemd-creds` credential (TPM2-bound where available), decrypted per run and handed to
 *    `op` only. One token per factory keeps factories isolated: reading one factory's item never
 *    uses, or needs, another factory's token;
 * 3. whatever `op` is signed in with: a manual `op signin` session or the desktop app.
 */

export class OpCredentialError extends Data.TaggedError('OpCredentialError')<{
  readonly message: string
}> {}

const credentialName = (factory: string) => `provision-op-${factory}`

export const serviceAccountTokenVariable = 'OP_SERVICE_ACCOUNT_TOKEN'

export const opCredentialFile = (factory: string) =>
  Effect.gen(function* () {
    const { file } = yield* RegistryLocation

    return `${file.slice(0, file.lastIndexOf('/'))}/op-service-account.${factory}.cred`
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

/** Encrypts the token with `systemd-creds --user` into a `0600` file; the token never hits disk in clear. */
export const storeServiceAccountToken = (factory: string, token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* opCredentialFile(factory)
    yield* fs
      .makeDirectory(file.slice(0, file.lastIndexOf('/')), { recursive: true })
      .pipe(Effect.mapError(() => new OpCredentialError({ message: `cannot create ${file}` })))

    const result = yield* capture(
      'systemd-creds',
      ['--user', 'encrypt', `--name=${credentialName(factory)}`, '-', file],
      { input: Redacted.value(token) }
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

/** Resolves how `op` authenticates for one factory; decrypts its stored token when present. */
export const resolveOpAuth = (factory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    if ((process.env[serviceAccountTokenVariable] ?? '').trim() !== '') {
      return { kind: 'environment' } satisfies OpAuthSource
    }

    const file = yield* opCredentialFile(factory)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    if (!exists) return { kind: 'session' } satisfies OpAuthSource

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

    const token = yield* parseServiceAccountToken(result.stdout)

    return { kind: 'credential', file, token } satisfies OpAuthSource
  })

/** Child-only environment for `op` under a stored service-account token. */
export const opEnvironment = (source: OpAuthSource) =>
  source.kind === 'credential'
    ? Option.some({ [serviceAccountTokenVariable]: Redacted.value(source.token) })
    : Option.none<Record<string, string>>()
