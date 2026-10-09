import { Effect, Option, Redacted, Schema } from 'effect'
import { ProviderError, requestJsonRequired } from '../http.ts'

const API_ROOT = 'https://api.upstash.com/v2'

export const qstashRegion = 'eu-central-1'

export const qstashUrl = `https://qstash-${qstashRegion}.upstash.io`

const basic = (email: string, apiKey: Redacted.Redacted<string>) => ({
  Authorization: `Basic ${Buffer.from(`${email}:${Redacted.value(apiKey)}`).toString('base64')}`
})

const Team = Schema.Struct({ team_id: Schema.String, team_name: Schema.String })

export const findTeam = (email: string, apiKey: Redacted.Redacted<string>, name: string) =>
  requestJsonRequired('Upstash team listing', `${API_ROOT}/teams`, Schema.Array(Team), {
    headers: basic(email, apiKey)
  }).pipe(
    Effect.flatMap(teams => {
      const matches = teams.filter(team => team.team_name === name)

      return matches.length > 1
        ? Effect.fail(new ProviderError({ message: `several Upstash teams are named ${name}` }))
        : Effect.succeed(Option.map(Option.fromUndefinedOr(matches[0]), team => team.team_id))
    })
  )

/** Creates a team without copying the payment method or billing details. */
export const createTeam = (email: string, apiKey: Redacted.Redacted<string>, name: string) =>
  requestJsonRequired('Upstash team creation', `${API_ROOT}/team`, Team, {
    method: 'POST',
    headers: basic(email, apiKey),
    body: { team_name: name, copy_cc: false }
  }).pipe(Effect.map(team => team.team_id))

export interface QStashCredentials {
  readonly token: Redacted.Redacted<string>
  readonly currentSigningKey: Redacted.Redacted<string>
  readonly nextSigningKey: Redacted.Redacted<string>
}

/**
 * Reads the EU QStash instance visible to a team-scoped developer key, then its signing keys.
 * A personal key only sees the personal account's instance, never a team's.
 */
export const readQStash = (email: string, teamApiKey: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const users = yield* requestJsonRequired(
      'Upstash QStash lookup',
      `${API_ROOT}/qstash/users`,
      Schema.Array(
        Schema.Struct({
          region: Schema.String,
          token: Schema.String,
          active: Schema.optional(Schema.Boolean)
        })
      ),
      { headers: basic(email, teamApiKey) }
    )
    const matches = users.filter(user => user.region === qstashRegion && user.active !== false)
    const user = matches.length === 1 ? matches[0] : undefined

    if (user === undefined) {
      return yield* new ProviderError({
        message: `expected one active ${qstashRegion} QStash instance for the team key, found ${matches.length}`
      })
    }

    const token = Redacted.make(user.token)
    const keys = yield* requestJsonRequired(
      'QStash signing keys',
      `${qstashUrl}/v2/keys`,
      Schema.Struct({ current: Schema.NonEmptyString, next: Schema.NonEmptyString }),
      { headers: { Authorization: `Bearer ${user.token}` } }
    )

    return {
      token,
      currentSigningKey: Redacted.make(keys.current),
      nextSigningKey: Redacted.make(keys.next)
    } satisfies QStashCredentials
  })
