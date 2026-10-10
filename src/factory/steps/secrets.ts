import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { Console, Effect, Option, Redacted } from 'effect'
import {
  decide,
  envGroups,
  factoryError,
  groupKeyState,
  requireProject,
  writeGroup,
  type EnvEntry,
  type EnvGroup,
  type FactoryContext,
  type ProjectHandle
} from '../context.ts'
import { requireVerifiedDomain } from '../providers/resend.ts'
import { listEnvRecords, type EnvRecord } from '../vercel-api.ts'

const generators = {
  base64: (bytes: number) => Redacted.make(randomBytes(bytes).toString('base64')),
  hex: (bytes: number) => Redacted.make(randomBytes(bytes).toString('hex'))
}

/** A web-push VAPID pair: uncompressed P-256 public point and raw private scalar, base64url. */
export const generateVapidKeys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicJwk = publicKey.export({ format: 'jwk' })
  const privateJwk = privateKey.export({ format: 'jwk' })
  const x = Buffer.from(publicJwk.x ?? '', 'base64url')
  const y = Buffer.from(publicJwk.y ?? '', 'base64url')

  return {
    publicKey: Buffer.concat([Buffer.from([4]), x, y]).toString('base64url'),
    privateKey: Redacted.make(privateJwk.d ?? '')
  }
}

/**
 * One `--secret NAME[=FORMAT]`: `base64-<bytes>` (default `base64-32`), `hex-<bytes>`, or `vapid`
 * (writes `<NAME>_PUBLIC_KEY`, plain, and `<NAME>_PRIVATE_KEY`).
 */
export type SecretFormat =
  | { readonly kind: 'base64' | 'hex'; readonly bytes: number }
  | { readonly kind: 'vapid' }

export interface SecretSpec {
  readonly name: string
  readonly format: SecretFormat
}

const secretName = /^[A-Z][A-Z0-9_]*$/

export const parseSecretSpecs = (values: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const specs: Array<SecretSpec> = []

    for (const value of values) {
      const [name = '', format = 'base64-32', ...rest] = value.split('=')
      const sized = /^(base64|hex)-(\d+)$/.exec(format)
      const bytes = Number(sized?.[2])

      if (!secretName.test(name) || rest.length > 0) {
        return yield* factoryError(
          `--secret ${value}: expected NAME[=FORMAT] with an upper-case NAME, e.g. BETTER_AUTH_SECRET=base64-32`
        )
      }

      if (format === 'vapid') specs.push({ name, format: { kind: 'vapid' } })
      else if ((sized?.[1] === 'base64' || sized?.[1] === 'hex') && bytes >= 16 && bytes <= 128) {
        specs.push({ name, format: { kind: sized[1], bytes } })
      } else {
        return yield* factoryError(
          `--secret ${value}: FORMAT is base64-<bytes>, hex-<bytes> (16 to 128 bytes), or vapid`
        )
      }
    }

    const keys = specs.flatMap(spec => specKeys(spec))
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)

    if (duplicates.length > 0) {
      return yield* factoryError(
        `--secret names a variable twice: ${[...new Set(duplicates)].join(', ')}`
      )
    }

    return specs
  })

const specKeys = (spec: SecretSpec) =>
  spec.format.kind === 'vapid'
    ? [`${spec.name}_PUBLIC_KEY`, `${spec.name}_PRIVATE_KEY`]
    : [spec.name]

const generate = (spec: SecretSpec, type: 'encrypted' | 'sensitive'): ReadonlyArray<EnvEntry> => {
  if (spec.format.kind === 'vapid') {
    const pair = generateVapidKeys()

    return [
      { key: `${spec.name}_PUBLIC_KEY`, value: Redacted.make(pair.publicKey), type: 'plain' },
      { key: `${spec.name}_PRIVATE_KEY`, value: pair.privateKey, type }
    ]
  }

  return [{ key: spec.name, value: generators[spec.format.kind](spec.format.bytes), type }]
}

/**
 * Writes `entries` unless the group already has any of `keys`: whole or partial, an existing value
 * is only replaced when `--on-existing` says so (never silently).
 */
const ensure = (
  context: FactoryContext,
  handle: ProjectHandle,
  records: ReadonlyArray<EnvRecord>,
  group: EnvGroup,
  description: string,
  keys: ReadonlyArray<string>,
  entries: () => ReadonlyArray<EnvEntry>
) =>
  Effect.gen(function* () {
    const state = groupKeyState(records, group, keys)

    if (state !== 'none') {
      const partly = state === 'partial' ? ', set only in part of it' : ''
      const decision = yield* decide(context, 'secret', `${description} (${group.label}${partly})`)

      if (decision === 'reuse') return
    }

    yield* writeGroup(context, handle, group, entries())
  })

/**
 * The secrets the repository's code reads, named with `--secret` (generated here, never shown or
 * stored elsewhere): a separate value for pre-production and for production (Sensitive). Plus
 * `AUTH_EMAIL_FROM` for every environment when a sender is known (`--email-from`, else
 * `noreply@<resend.sending_domain>`), on a domain verified in the factory's Resend account.
 */
export const secretsStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const resend = context.credentials.resend
    const fromAddress =
      context.emailFrom ??
      (resend?.sendingDomain === undefined ? undefined : `noreply@${resend.sendingDomain}`)

    if (context.secrets.length === 0 && fromAddress === undefined) {
      yield* Console.log('  nothing to generate: pass --secret NAME=FORMAT or --email-from')

      return
    }

    if (fromAddress !== undefined) {
      if (resend === undefined) {
        return yield* factoryError('AUTH_EMAIL_FROM needs the resend section to verify its domain')
      }

      yield* requireVerifiedDomain(resend.apiKey, fromAddress.slice(fromAddress.indexOf('@') + 1))
    }

    const handle = yield* requireProject(context)

    if (Option.isNone(handle)) {
      yield* Console.log('  would run after the vercel step creates the project')

      return
    }

    const groups = envGroups(handle.value)
    const records = yield* listEnvRecords(
      context.credentials.vercel.teamId,
      handle.value.project.id
    )

    for (const spec of context.secrets) {
      const keys = specKeys(spec)

      for (const [group, type] of [
        [groups.preproduction, 'encrypted'],
        [groups.production, 'sensitive']
      ] as const) {
        yield* ensure(context, handle.value, records, group, keys.join(', '), keys, () =>
          generate(spec, type)
        )
      }
    }

    if (fromAddress !== undefined) {
      const entry: EnvEntry = {
        key: 'AUTH_EMAIL_FROM',
        value: Redacted.make(`${context.senderName} <${fromAddress}>`),
        type: 'plain'
      }

      yield* ensure(context, handle.value, records, groups.all, entry.key, [entry.key], () => [
        entry
      ])
    }
  })
