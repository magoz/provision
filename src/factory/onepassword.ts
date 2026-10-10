import { Data, Effect, Option, Redacted, Schema } from 'effect'
import { capture } from '../shared/process.ts'
import { opEnvironment, type OpAuthSource } from './op-credential.ts'
import type { FactoryEntry } from './registry.ts'

export class CredentialsError extends Data.TaggedError('CredentialsError')<{
  readonly message: string
  /** The item does not exist in the vault (as opposed to any other read failure). */
  readonly notFound?: boolean
}> {}

const OpField = Schema.Struct({
  label: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  section: Schema.optional(Schema.Struct({ label: Schema.optional(Schema.String) }))
})

const OpItem = Schema.fromJsonString(
  Schema.Struct({ fields: Schema.optional(Schema.Array(OpField)) })
)

/**
 * The first `[ERROR]` line of `op`'s stderr, without its timestamp. `op` error messages name
 * items, vaults, and permissions, never secret values.
 */
export const opErrorMessage = (stderr: string) => {
  const line = stderr
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map(candidate => candidate.trim())
    .find(candidate => candidate.length > 0)

  return line === undefined
    ? undefined
    : line.replace(/^\[ERROR\]\s*\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s*/, '').slice(0, 300)
}

/** Item fields keyed `section.label` (or `label` without a section); values stay redacted. */
export type ItemFields = ReadonlyMap<string, Redacted.Redacted<string>>

/**
 * Reads one factory item as `op` JSON (values revealed; never printed). A failing `op` call
 * reports only its exit code.
 */
export const readItemJson = (entry: FactoryEntry, auth: OpAuthSource) =>
  Effect.gen(function* () {
    const args = ['item', 'get', entry.item, '--vault', entry.vault, '--format', 'json', '--reveal']

    if (entry.account !== undefined) args.push('--account', entry.account)

    const result = yield* capture(
      'op',
      args,
      Option.match(opEnvironment(auth), { onNone: () => ({}), onSome: env => ({ env }) })
    ).pipe(
      Effect.mapError(
        () => new CredentialsError({ message: '1Password CLI (op) could not be started' })
      )
    )

    if (result.exitCode !== 0) {
      const reason = opErrorMessage(result.stderr)

      if (reason?.includes("isn't an item") === true) {
        return yield* new CredentialsError({
          message: `item ${entry.item} does not exist in vault ${entry.vault}`,
          notFound: true
        })
      }

      return yield* new CredentialsError({
        message:
          `cannot read 1Password item ${entry.item} in vault ${entry.vault} (op exit ${result.exitCode}` +
          `${reason === undefined ? '' : `: ${reason}`}); ` +
          (auth.kind === 'session'
            ? 'sign in with `eval "$(op signin)"` or store a service-account token with `provision config op-token set`'
            : 'check that the service account has read access to this vault')
      })
    }

    return result.stdout
  })

/** Reads one factory item's non-empty fields; values stay redacted. */
export const readItemFields = (entry: FactoryEntry, auth: OpAuthSource) =>
  Effect.flatMap(readItemJson(entry, auth), parseItemFields)

/** Non-empty fields of an `op item get --format json` result. */
export const parseItemFields = (json: string) =>
  Effect.gen(function* () {
    const item = yield* Schema.decodeUnknownEffect(OpItem)(json).pipe(
      Effect.mapError(
        () => new CredentialsError({ message: '1Password returned an unexpected item shape' })
      )
    )

    const fields = new Map<string, Redacted.Redacted<string>>()

    for (const field of item.fields ?? []) {
      const label = field.label?.trim()
      const value = field.value?.trim()

      if (label === undefined || label === '' || value === undefined || value === '') continue
      const section = field.section?.label?.trim()
      const key = section === undefined || section === '' ? label : `${section}.${label}`
      fields.set(key.toLowerCase(), Redacted.make(value))
    }

    return fields satisfies ItemFields
  })

/** Credentials of one factory. A section is present only when all of its fields are. */
export interface FactoryCredentials {
  readonly githubOwner: string
  readonly vercel: { readonly teamId: string }
  readonly neon: { readonly apiKey: Redacted.Redacted<string>; readonly orgId: string } | undefined
  readonly cloudflare:
    | { readonly apiToken: Redacted.Redacted<string>; readonly accountId: string }
    | undefined
  readonly upstash:
    | {
        readonly email: string
        readonly apiKey: Redacted.Redacted<string>
      }
    | undefined
  readonly resend:
    | {
        readonly apiKey: Redacted.Redacted<string>
        /** Optional default sender domain for `AUTH_EMAIL_FROM` (`noreply@<domain>`). */
        readonly sendingDomain: string | undefined
      }
    | undefined
  readonly reportReceiver:
    | { readonly url: string; readonly factoryKey: Redacted.Redacted<string> }
    | undefined
}

interface SectionSpec {
  readonly section: string
  readonly required: ReadonlyArray<string>
}

export const credentialSections: ReadonlyArray<SectionSpec> = [
  { section: 'github', required: ['owner'] },
  { section: 'vercel', required: ['team_id'] },
  { section: 'neon', required: ['api_key', 'org_id'] },
  { section: 'cloudflare', required: ['api_token', 'account_id'] },
  { section: 'upstash', required: ['email', 'api_key'] },
  { section: 'resend', required: ['api_key'] },
  { section: 'report_receiver', required: ['url', 'factory_key'] }
]

/** Which sections are complete, partial, or absent: reported by `provision config verify`. */
export const describeSections = (fields: ItemFields) =>
  credentialSections.map(spec => {
    const present = spec.required.filter(name => fields.has(`${spec.section}.${name}`))

    return {
      section: spec.section,
      status:
        present.length === spec.required.length
          ? ('complete' as const)
          : present.length === 0
            ? ('absent' as const)
            : ('partial' as const),
      missing: spec.required.filter(name => !present.includes(name))
    }
  })

export const decodeCredentials = (fields: ItemFields) =>
  Effect.gen(function* () {
    const partial = describeSections(fields).filter(entry => entry.status === 'partial')

    if (partial.length > 0) {
      return yield* new CredentialsError({
        message: `incomplete factory item sections: ${partial
          .map(entry => `${entry.section} (missing ${entry.missing.join(', ')})`)
          .join('; ')}`
      })
    }

    const field = (key: string) => fields.get(key)
    const text = (key: string) => {
      const value = field(key)

      return value === undefined ? undefined : Redacted.value(value)
    }

    const githubOwner = text('github.owner')
    const teamId = text('vercel.team_id')

    if (githubOwner === undefined || teamId === undefined) {
      return yield* new CredentialsError({
        message: 'factory item needs github.owner and vercel.team_id'
      })
    }

    if (!/^team_[A-Za-z0-9]+$/.test(teamId)) {
      return yield* new CredentialsError({
        message: 'vercel.team_id must be an immutable team_* identifier'
      })
    }

    const neonKey = field('neon.api_key')
    const neonOrg = text('neon.org_id')
    const cloudflareToken = field('cloudflare.api_token')
    const cloudflareAccount = text('cloudflare.account_id')
    const upstashEmail = text('upstash.email')
    const upstashKey = field('upstash.api_key')
    const resendKey = field('resend.api_key')
    const sendingDomain = text('resend.sending_domain')
    const receiverUrl = text('report_receiver.url')
    const receiverKey = field('report_receiver.factory_key')

    return {
      githubOwner,
      vercel: { teamId },
      neon: neonKey && neonOrg ? { apiKey: neonKey, orgId: neonOrg } : undefined,
      cloudflare:
        cloudflareToken && cloudflareAccount
          ? { apiToken: cloudflareToken, accountId: cloudflareAccount }
          : undefined,
      upstash: upstashEmail && upstashKey ? { email: upstashEmail, apiKey: upstashKey } : undefined,
      resend: resendKey ? { apiKey: resendKey, sendingDomain } : undefined,
      reportReceiver:
        receiverUrl && receiverKey ? { url: receiverUrl, factoryKey: receiverKey } : undefined
    } satisfies FactoryCredentials
  })
