import { Effect, Option, Redacted, Schema } from 'effect'
import { ProviderError, requestJson, requestJsonRequired } from '../http.ts'

const API_ROOT = 'https://api.resend.com'

/** Sending domains live in Resend's EU region. */
export const resendRegion = 'eu-west-1'

const headers = (apiKey: Redacted.Redacted<string>) => ({
  Authorization: `Bearer ${Redacted.value(apiKey)}`
})

const Domain = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  region: Schema.String
})

/** The factory's shared sending domain: registered exactly once, verified, in the EU region. */
export const findSendingDomain = (apiKey: Redacted.Redacted<string>, name: string) =>
  Effect.gen(function* () {
    const response = yield* requestJsonRequired(
      'Resend domain listing',
      `${API_ROOT}/domains`,
      Schema.Struct({ data: Schema.Array(Domain) }),
      { headers: headers(apiKey) }
    )
    const matches = response.data.filter(domain => domain.name === name)
    const domain = matches.length === 1 ? matches[0] : undefined

    if (domain === undefined) {
      return yield* new ProviderError({
        message: `Resend sending domain ${name} must be registered exactly once (found ${matches.length})`
      })
    }

    if (domain.status !== 'verified' || domain.region !== resendRegion) {
      return yield* new ProviderError({
        message: `Resend sending domain ${name} must be verified in ${resendRegion} (status ${domain.status}, region ${domain.region})`
      })
    }

    return domain.id
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

/** A sending-only key restricted to one domain. */
export const createSendingKey = (
  apiKey: Redacted.Redacted<string>,
  name: string,
  domainId: string
) =>
  requestJsonRequired(
    'Resend API key creation',
    `${API_ROOT}/api-keys`,
    Schema.Struct({ id: Schema.String, token: Schema.String }),
    {
      method: 'POST',
      headers: headers(apiKey),
      body: { name, permission: 'sending_access', domain_id: domainId }
    }
  ).pipe(Effect.map(created => ({ id: created.id, token: Redacted.make(created.token) })))

export const deleteApiKey = (apiKey: Redacted.Redacted<string>, keyId: string) =>
  requestJson(
    'Resend API key deletion',
    `${API_ROOT}/api-keys/${encodeURIComponent(keyId)}`,
    Schema.Unknown,
    { method: 'DELETE', headers: headers(apiKey), allowNotFound: true }
  ).pipe(Effect.asVoid)
