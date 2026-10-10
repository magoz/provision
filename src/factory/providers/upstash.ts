import { Effect, Option, Redacted, Schema } from 'effect'
import { ProviderError, requestJsonRequired } from '../http.ts'

const API_ROOT = 'https://api.upstash.com/v2'

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
