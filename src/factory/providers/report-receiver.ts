import { Effect, Option, Redacted, Schema } from 'effect'
import { ProviderError, requestJson, requestJsonRequired } from '../http.ts'

export interface ReportReceiver {
  /** The intake endpoint written to `REPORT_RECEIVER_URL`, e.g. `https://receiver.example/api/reports`. */
  readonly url: string
  readonly factoryKey: Redacted.Redacted<string>
}

/** The receiver's factory API lives on the same origin: `/api/factory/report-tokens`. */
const tokensUrl = (receiver: ReportReceiver) =>
  Effect.try({
    try: () => new URL('/api/factory/report-tokens', receiver.url).href,
    catch: () => new ProviderError({ message: 'report_receiver.url is not a valid URL' })
  })

const headers = (receiver: ReportReceiver) => ({
  Authorization: `Bearer ${Redacted.value(receiver.factoryKey)}`
})

const ReportToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  revokedAt: Schema.optional(Schema.NullOr(Schema.String))
})

export const findReportToken = (receiver: ReportReceiver, name: string) =>
  Effect.gen(function* () {
    const url = yield* tokensUrl(receiver)
    const tokens = yield* requestJsonRequired(
      'report token listing',
      url,
      Schema.Struct({ tokens: Schema.Array(ReportToken) }),
      { headers: headers(receiver) }
    )
    const active = tokens.tokens.filter(
      token => token.name === name && (token.revokedAt === undefined || token.revokedAt === null)
    )

    if (active.length > 1) {
      return yield* new ProviderError({ message: `several active report tokens are named ${name}` })
    }

    return Option.map(Option.fromUndefinedOr(active[0]), token => token.id)
  })

export const createReportToken = (receiver: ReportReceiver, name: string) =>
  Effect.gen(function* () {
    const url = yield* tokensUrl(receiver)
    const created = yield* requestJsonRequired(
      'report token creation',
      url,
      Schema.Struct({ id: Schema.String, token: Schema.String }),
      { method: 'POST', headers: headers(receiver), body: { name } }
    )

    return { id: created.id, token: Redacted.make(created.token) }
  })

export const revokeReportToken = (receiver: ReportReceiver, id: string) =>
  Effect.gen(function* () {
    const url = yield* tokensUrl(receiver)
    yield* requestJson(
      'report token revocation',
      `${url}/${encodeURIComponent(id)}`,
      Schema.Unknown,
      {
        method: 'DELETE',
        headers: headers(receiver),
        allowNotFound: true
      }
    )
  })
