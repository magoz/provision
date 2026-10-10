import { Console, Data, Effect, Option, Redacted, Schema } from 'effect'
import { Prompt } from 'effect/cli'
import { capture, inherit } from '../shared/process.ts'
import { credentialSections } from './onepassword.ts'
import { parseServiceAccountToken, storeServiceAccountToken } from './op-credential.ts'

/**
 * One-time factory setup with the operator's own 1Password sign-in: make sure the vault and its
 * `provision` item exist, then create the factory's read-only service account and store its token.
 * The operator session lives only in this process and is signed out at the end.
 */

export class OnboardingError extends Data.TaggedError('OnboardingError')<{
  readonly message: string
}> {}

const failure = (message: string) => new OnboardingError({ message })

/** Environment that authenticates `op` children with the operator session. */
type SessionEnv = Readonly<Record<string, string>>

const Accounts = Schema.fromJsonString(Schema.Array(Schema.Struct({ url: Schema.String })))

const ensureAccount = Effect.gen(function* () {
  const listed = yield* capture('op', ['account', 'list', '--format', 'json'])
  const accounts = Schema.decodeUnknownOption(Accounts)(listed.stdout.trim() || '[]')

  if (Option.isSome(accounts) && accounts.value.length > 0) return

  yield* Console.log('No 1Password account is configured on this machine; adding yours.')
  yield* inherit('op', ['account', 'add'])
})

/** `op signin` prints `export OP_SESSION_<id>="<token>"` for the shell to evaluate. */
export const parseSessionExport = (output: string) => {
  const match = /export (OP_SESSION_[A-Za-z0-9_]+)="([^"]+)"/.exec(output)

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { name: match[1], token: Redacted.make(match[2]) }
}

const signIn = Effect.gen(function* () {
  yield* ensureAccount
  yield* Console.log('Sign in to 1Password (used only for this setup, then signed out):')

  const result = yield* capture('op', ['signin'], { interactive: true })
  const session = result.exitCode === 0 ? parseSessionExport(result.stdout) : undefined

  if (session === undefined) return yield* failure('1Password sign-in failed')

  const env: SessionEnv = { [session.name]: Redacted.value(session.token) }

  return env
})

const signOut = (env: SessionEnv) => capture('op', ['signout'], { env }).pipe(Effect.ignore)

/** The operator's 1Password session for the duration of `use`; always signed out afterwards. */
export const withOperatorSession = <A, E, R>(use: (env: SessionEnv) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(signIn, use, signOut)

interface OnboardingOptions {
  /** Create a missing vault or item without asking. */
  readonly assumeYes: boolean
}

const confirm = (options: OnboardingOptions, message: string) =>
  options.assumeYes
    ? Effect.succeed(true)
    : Prompt.run(Prompt.Confirm({ message, initial: true })).pipe(
        Effect.mapError(() => failure('cancelled'))
      )

const ensureVault = (env: SessionEnv, vault: string, options: OnboardingOptions) =>
  Effect.gen(function* () {
    const found = yield* capture('op', ['vault', 'get', vault, '--format', 'json'], { env })

    if (found.exitCode === 0) return

    if (!(yield* confirm(options, `Vault ${vault} does not exist. Create it?`))) {
      return yield* failure(`vault ${vault} is required`)
    }

    const created = yield* capture('op', ['vault', 'create', vault], { env })

    if (created.exitCode !== 0) return yield* failure(`could not create vault ${vault}`)

    yield* Console.log(`created vault ${vault}`)
  })

const secretFields = new Set(['api_key', 'api_token', 'factory_key', 'dev_api_key', 'prod_api_key'])

/** An empty item with every factory field, ready to be filled in the 1Password app. */
export const itemTemplate = (title: string) => {
  const fields = [
    ...credentialSections.map(spec => ({ section: spec.section, labels: spec.required })),
    { section: 'upstash', labels: ['dev_api_key', 'prod_api_key'] }
  ].flatMap(({ section, labels }) =>
    labels.map(label => ({
      id: `${section}.${label}`,
      label,
      section: { id: section },
      type: secretFields.has(label) ? 'CONCEALED' : 'STRING',
      value: ''
    }))
  )

  return JSON.stringify({
    title,
    category: 'SECURE_NOTE',
    sections: credentialSections.map(spec => ({ id: spec.section, label: spec.section })),
    fields
  })
}

/** Ensures the item exists; returns `true` when it was just created (and so is still empty). */
const ensureItem = (env: SessionEnv, vault: string, item: string, options: OnboardingOptions) =>
  Effect.gen(function* () {
    const found = yield* capture(
      'op',
      ['item', 'get', item, '--vault', vault, '--format', 'json'],
      {
        env
      }
    )

    if (found.exitCode === 0) return false

    if (
      !(yield* confirm(
        options,
        `Item ${item} does not exist in ${vault}. Create it with empty fields?`
      ))
    ) {
      return yield* failure(`item ${item} is required`)
    }

    const created = yield* capture('op', ['item', 'create', '--vault', vault, '-'], {
      env,
      input: itemTemplate(item)
    })

    if (created.exitCode !== 0) return yield* failure(`could not create item ${item} in ${vault}`)

    yield* Console.log(`created item ${item} in ${vault}`)

    return true
  })

const createServiceAccount = (env: SessionEnv, factory: string, vault: string) =>
  Effect.gen(function* () {
    const name = `provision-${factory}`
    yield* Console.log(`creating read-only service account ${name} for ${vault}`)

    const created = yield* capture(
      'op',
      ['service-account', 'create', name, '--vault', `${vault}:read_items`, '--raw'],
      { env }
    )

    if (created.exitCode !== 0) {
      return yield* failure(
        `could not create service account ${name}; if it already exists, revoke it under Developer > Service accounts and run this again`
      )
    }

    return yield* parseServiceAccountToken(created.stdout)
  })

/**
 * Signs in as the operator, ensures the vault and item, then creates and stores the factory's
 * read-only service account. Returns whether the item was just created (and still needs values).
 */
export const onboardFactory = (
  factory: string,
  vault: string,
  item: string,
  options: OnboardingOptions
) =>
  withOperatorSession(env =>
    Effect.gen(function* () {
      yield* ensureVault(env, vault, options)
      const createdItem = yield* ensureItem(env, vault, item, options)
      const token = yield* createServiceAccount(env, factory, vault)
      const file = yield* storeServiceAccountToken(factory, token)
      yield* Console.log(`stored the ${factory} service-account token encrypted at ${file}`)

      return createdItem
    })
  )
