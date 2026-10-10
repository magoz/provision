import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { Console, Effect, Option, Redacted } from 'effect'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  requireProject,
  writeGroup,
  type EnvEntry,
  type EnvGroup,
  type FactoryContext,
  type ProjectHandle
} from '../context.ts'
import { requireVerifiedDomain } from '../providers/resend.ts'
import { listEnvRecords, type EnvRecord } from '../vercel-api.ts'

export const usageAlertThresholds = '50,80,95'

const base64 = (bytes: number) => Redacted.make(randomBytes(bytes).toString('base64'))

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

interface SecretSet {
  readonly description: string
  readonly keys: ReadonlyArray<string>
  readonly kind: 'secret' | 'key'
  readonly entries: (secretType: 'encrypted' | 'sensitive') => ReadonlyArray<EnvEntry>
}

/** Generated per group: a separate value for pre-production and production. */
const generatedSets: ReadonlyArray<SecretSet> = [
  {
    description: 'BETTER_AUTH_SECRET',
    keys: ['BETTER_AUTH_SECRET'],
    kind: 'secret',
    entries: type => [{ key: 'BETTER_AUTH_SECRET', value: base64(32), type }]
  },
  {
    description: 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY',
    keys: ['INTEGRATION_CREDENTIAL_ENCRYPTION_KEY'],
    kind: 'secret',
    entries: type => [{ key: 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', value: base64(32), type }]
  },
  {
    description: 'CRON_SECRET',
    keys: ['CRON_SECRET'],
    kind: 'key',
    entries: type => [
      { key: 'CRON_SECRET', value: Redacted.make(randomBytes(32).toString('hex')), type }
    ]
  },
  {
    description: 'VAPID key pair',
    keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
    kind: 'secret',
    entries: type => {
      const pair = generateVapidKeys()

      return [
        { key: 'VAPID_PUBLIC_KEY', value: Redacted.make(pair.publicKey), type: 'plain' },
        { key: 'VAPID_PRIVATE_KEY', value: pair.privateKey, type }
      ]
    }
  }
]

const ensureSet = (
  context: FactoryContext,
  handle: ProjectHandle,
  records: ReadonlyArray<EnvRecord>,
  group: EnvGroup,
  set: SecretSet,
  entries: () => ReadonlyArray<EnvEntry>
) =>
  Effect.gen(function* () {
    if (groupHasKeys(records, group, set.keys)) {
      const decision = yield* decide(context, set.kind, `${set.description} (${group.label})`)

      if (decision === 'reuse') return
    }

    yield* writeGroup(context, handle, group, entries())
  })

/**
 * App secrets the CLI generates (never shown or stored elsewhere), plus plain settings shared by
 * all environments: `AUTH_EMAIL_FROM` and `AI_PROVIDER_USAGE_ALERT_THRESHOLDS`.
 */
export const secretsStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const resend = context.credentials.resend

    if (resend === undefined) {
      return yield* factoryError('the secrets step needs the resend section for AUTH_EMAIL_FROM')
    }

    const fromAddress =
      context.emailFrom ??
      (resend.sendingDomain === undefined ? undefined : `noreply@${resend.sendingDomain}`)

    if (fromAddress === undefined) {
      return yield* factoryError(
        'the secrets step needs a sender: pass --email-from or set resend.sending_domain in the factory item'
      )
    }

    yield* requireVerifiedDomain(resend.apiKey, fromAddress.slice(fromAddress.indexOf('@') + 1))

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

    for (const set of generatedSets) {
      yield* ensureSet(context, handle.value, records, groups.preproduction, set, () =>
        set.entries('encrypted')
      )
      yield* ensureSet(context, handle.value, records, groups.production, set, () =>
        set.entries('sensitive')
      )
    }

    const plain: ReadonlyArray<EnvEntry> = [
      {
        key: 'AUTH_EMAIL_FROM',
        value: Redacted.make(`${context.senderName} <${fromAddress}>`),
        type: 'plain'
      },
      {
        key: 'AI_PROVIDER_USAGE_ALERT_THRESHOLDS',
        value: Redacted.make(usageAlertThresholds),
        type: 'plain'
      }
    ]

    for (const entry of plain) {
      yield* ensureSet(
        context,
        handle.value,
        records,
        groups.all,
        { description: entry.key, keys: [entry.key], kind: 'key', entries: () => [entry] },
        () => [entry]
      )
    }
  })
