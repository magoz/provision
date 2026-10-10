import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type ScryptOptions
} from 'node:crypto'
import { Data, Effect, Redacted, Schema } from 'effect'

/**
 * Passphrase sealing for stored tokens: scrypt-derived key, AES-256-GCM, with the credential
 * name as associated data so a sealed token cannot be swapped between factories.
 */

export class SealError extends Data.TaggedError('SealError')<{
  readonly reason: 'wrong-passphrase' | 'malformed' | 'crypto'
  readonly message: string
}> {}

export interface KdfParameters {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** ~128 MiB and a few hundred milliseconds per derivation. */
export const defaultKdf: KdfParameters = { N: 2 ** 17, r: 8, p: 1 }

const Envelope = Schema.Struct({
  v: Schema.Literal(1),
  kdf: Schema.Literal('scrypt'),
  N: Schema.Number,
  r: Schema.Number,
  p: Schema.Number,
  salt: Schema.String,
  iv: Schema.String,
  tag: Schema.String,
  data: Schema.String
})

const EnvelopeJson = Schema.fromJsonString(Envelope)

const deriveKey = (passphrase: Redacted.Redacted<string>, salt: Buffer, kdf: KdfParameters) =>
  Effect.callback<Buffer, SealError>(resume => {
    const options: ScryptOptions = { ...kdf, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 }

    scrypt(Redacted.value(passphrase), salt, 32, options, (error, key) => {
      resume(
        error === null
          ? Effect.succeed(key)
          : Effect.fail(new SealError({ reason: 'crypto', message: 'key derivation failed' }))
      )
    })
  })

export const seal = (
  passphrase: Redacted.Redacted<string>,
  plaintext: Redacted.Redacted<string>,
  associatedData: string,
  kdf: KdfParameters = defaultKdf
) =>
  Effect.gen(function* () {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = yield* deriveKey(passphrase, salt, kdf)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(associatedData, 'utf8'))
    const data = Buffer.concat([cipher.update(Redacted.value(plaintext), 'utf8'), cipher.final()])

    return JSON.stringify({
      v: 1,
      kdf: 'scrypt',
      ...kdf,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    })
  })

export const unseal = (
  passphrase: Redacted.Redacted<string>,
  sealed: string,
  associatedData: string
) =>
  Effect.gen(function* () {
    const envelope = yield* Schema.decodeUnknownEffect(EnvelopeJson)(sealed.trim()).pipe(
      Effect.mapError(
        () => new SealError({ reason: 'malformed', message: 'stored token is not sealed' })
      )
    )
    const key = yield* deriveKey(passphrase, Buffer.from(envelope.salt, 'base64'), envelope)

    return yield* Effect.try({
      try: () => {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
        decipher.setAAD(Buffer.from(associatedData, 'utf8'))
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, 'base64')),
          decipher.final()
        ])

        return Redacted.make(plaintext.toString('utf8'))
      },
      catch: () => new SealError({ reason: 'wrong-passphrase', message: 'wrong passphrase' })
    })
  })
