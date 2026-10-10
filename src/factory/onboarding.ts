import { Console, Data, Effect, Option, Redacted, Schema } from 'effect'
import { Prompt } from 'effect/cli'
import { capture, inherit } from '../shared/process.ts'
import { credentialSections, opErrorMessage } from './onepassword.ts'
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

/** A failure that includes `op`'s own explanation (never secret values). */
const opFailure = (message: string, result: { readonly stderr: string }) => {
  const reason = opErrorMessage(result.stderr)

  return failure(reason === undefined ? message : `${message}: ${reason}`)
}

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

    if (created.exitCode !== 0) return yield* opFailure(`could not create vault ${vault}`, created)

    yield* Console.log(`created vault ${vault}`)
  })

const secretFields = new Set(['api_key', 'api_token', 'factory_key'])

/** An empty item with every factory field, ready to be filled in the 1Password app. */
export const templateFields = [
  ...credentialSections.map(spec => ({ section: spec.section, labels: spec.required })),
  { section: 'resend', labels: ['sending_domain'] }
].flatMap(({ section, labels }) =>
  labels.map(label => ({ section, label, concealed: secretFields.has(label) }))
)

/** `op` assignment statements that create each field empty (no values, so nothing secret). */
const emptyFieldAssignments = (fields: ReadonlyArray<(typeof templateFields)[number]>) =>
  fields.map(field => `${field.section}.${field.label}[${field.concealed ? 'password' : 'text'}]=`)

const OpItemFields = Schema.fromJsonString(
  Schema.Struct({
    fields: Schema.optional(
      Schema.Array(
        Schema.Struct({
          label: Schema.optional(Schema.String),
          section: Schema.optional(Schema.Struct({ label: Schema.optional(Schema.String) }))
        })
      )
    )
  })
)

/** Template fields an item lacks entirely (empty fields count as present). */
export const missingTemplateFields = (itemJson: string) => {
  const decoded = Schema.decodeUnknownOption(OpItemFields)(itemJson)
  const present = new Set(
    Option.match(decoded, { onNone: () => [], onSome: item => item.fields ?? [] }).flatMap(
      field => {
        const label = field.label?.trim().toLowerCase()
        const section = field.section?.label?.trim().toLowerCase()

        if (label === undefined || label === '') return []

        return [section === undefined || section === '' ? label : `${section}.${label}`]
      }
    )
  )

  return templateFields.filter(field => !present.has(`${field.section}.${field.label}`))
}

/** Adds the missing fields with empty values; existing fields and values are never touched. */
const addMissingFields = (
  env: SessionEnv,
  vault: string,
  item: string,
  missing: ReadonlyArray<(typeof templateFields)[number]>
) =>
  Effect.gen(function* () {
    if (missing.length === 0) return

    const assignments = emptyFieldAssignments(missing)
    const edited = yield* capture('op', ['item', 'edit', item, '--vault', vault, ...assignments], {
      env
    })

    if (edited.exitCode !== 0)
      return yield* opFailure(`could not add fields to item ${item}`, edited)

    yield* Console.log(
      `added ${missing.length} empty field(s) to ${item}: ${missing.map(field => `${field.section}.${field.label}`).join(', ')}`
    )
  })

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

    if (found.exitCode === 0) {
      yield* addMissingFields(env, vault, item, missingTemplateFields(found.stdout))

      return false
    }

    if (
      !(yield* confirm(
        options,
        `Item ${item} does not exist in ${vault}. Create it with empty fields?`
      ))
    ) {
      return yield* failure(`item ${item} is required`)
    }

    const created = yield* capture(
      'op',
      [
        'item',
        'create',
        '--vault',
        vault,
        '--category',
        'Secure Note',
        '--title',
        item,
        ...emptyFieldAssignments(templateFields)
      ],
      { env }
    )

    if (created.exitCode !== 0) {
      return yield* opFailure(`could not create item ${item} in ${vault}`, created)
    }

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
      return yield* opFailure(
        `could not create service account ${name} (if it already exists, revoke it under Developer > Service accounts and run this again)`,
        created
      )
    }

    return yield* parseServiceAccountToken(created.stdout)
  })

/**
 * Signs in as the operator and makes sure the item exists with every field: creates it when
 * missing, adds missing fields (empty) otherwise. Existing fields and values are never touched.
 */
export const ensureFactoryItem = (vault: string, item: string, options: OnboardingOptions) =>
  withOperatorSession(env => ensureItem(env, vault, item, options))

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
