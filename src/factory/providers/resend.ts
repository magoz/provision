import { Effect, Option, Redacted, Schema } from 'effect'
import { ProviderError, requestJson, requestJsonRequired } from '../http.ts'

const API_ROOT = 'https://api.resend.com'

const headers = (apiKey: Redacted.Redacted<string>) => ({
  Authorization: `Bearer ${Redacted.value(apiKey)}`
})

const Domain = Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String })

/** The sender domain must be registered and verified in this Resend account. */
export const requireVerifiedDomain = (apiKey: Redacted.Redacted<string>, name: string) =>
  Effect.gen(function* () {
    const response = yield* requestJsonRequired(
      'Resend domain listing',
      `${API_ROOT}/domains`,
      Schema.Struct({ data: Schema.Array(Domain) }),
      { headers: headers(apiKey) }
    )
    const domain = response.data.find(candidate => candidate.name === name)

    if (domain === undefined || domain.status !== 'verified') {
      return yield* new ProviderError({
        message: `Resend domain ${name} must be verified in the factory's Resend account (${domain === undefined ? 'not registered' : `status ${domain.status}`})`
      })
    }
  })

export const findApiKey = (apiKey: Redacted.Redacted<string>, name: string) =>
  requestJsonRequired(
    'Resend API key listing',
    `${API_ROOT}/api-keys`,
    Schema.Struct({
      data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
    }),
    { headers: headers(apiKey) }
  ).pipe(
    Effect.flatMap(response => {
      const matches = response.data.filter(key => key.name === name)

      return matches.length > 1
        ? Effect.fail(new ProviderError({ message: `several Resend API keys are named ${name}` }))
        : Effect.succeed(Option.map(Option.fromUndefinedOr(matches[0]), key => key.id))
    })
  )

/** A sending-only key (it can send from any verified domain, but read and manage nothing). */
export const createSendingKey = (apiKey: Redacted.Redacted<string>, name: string) =>
  requestJsonRequired(
    'Resend API key creation',
    `${API_ROOT}/api-keys`,
    Schema.Struct({ id: Schema.String, token: Schema.String }),
    {
      method: 'POST',
      headers: headers(apiKey),
      body: { name, permission: 'sending_access' }
    }
  ).pipe(Effect.map(created => ({ id: created.id, token: Redacted.make(created.token) })))

export const deleteApiKey = (apiKey: Redacted.Redacted<string>, keyId: string) =>
  requestJson(
    'Resend API key deletion',
    `${API_ROOT}/api-keys/${encodeURIComponent(keyId)}`,
    Schema.Unknown,
    { method: 'DELETE', headers: headers(apiKey), allowNotFound: true }
  ).pipe(Effect.asVoid)
