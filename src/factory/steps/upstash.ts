import { Console, Effect, Option, Redacted } from 'effect'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  mutate,
  requireProject,
  withTerminal,
  writeGroup,
  type EnvGroup,
  type FactoryContext
} from '../context.ts'
import { SecretInput } from '../secret-input.ts'
import { createTeam, findTeam } from '../providers/upstash.ts'
import { listEnvRecords } from '../vercel-api.ts'

export const qstashVariableKeys = [
  'QSTASH_URL',
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY'
] as const

/**
 * Retained `<repo>-dev` and `<repo>-prod` teams (QStash has one tenancy per team, so separate
 * teams are the only isolation boundary). A team's QStash credentials are only readable with a key
 * created inside that team, so the operator pastes them from the console and the step writes them
 * to Vercel; without a terminal (or when skipped) it reports the manual transfer until Vercel has
 * them.
 */
export const upstashStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const upstash = context.credentials.upstash

    if (upstash === undefined) return yield* factoryError('the factory item has no upstash section')

    for (const name of [context.names.development, context.names.production]) {
      const team = yield* findTeam(upstash.email, upstash.apiKey, name)

      if (Option.isSome(team)) yield* decide(context, 'data', `Upstash team ${name}`)
      else
        yield* mutate(
          context,
          `create Upstash team ${name}`,
          createTeam(upstash.email, upstash.apiKey, name)
        )
    }

    const handle = yield* requireProject(context)

    if (Option.isNone(handle)) {
      for (const name of [context.names.development, context.names.production]) {
        yield* Console.log(`  would ask for ${name}'s QStash credentials (or copy them by hand)`)
      }

      return
    }

    const groups = envGroups(handle.value)
    const records = yield* listEnvRecords(
      context.credentials.vercel.teamId,
      handle.value.project.id
    )
    const targets = [
      { team: context.names.development, group: groups.preproduction, type: 'encrypted' },
      { team: context.names.production, group: groups.production, type: 'sensitive' }
    ] as const

    for (const target of targets) {
      if (groupHasKeys(records, target.group, qstashVariableKeys)) continue

      const values = context.dryRun ? Option.none() : yield* askQStash(target.team, target.group)

      if (Option.isNone(values)) {
        yield* Console.log(
          `  manual: copy ${target.team}'s EU QStash ${qstashVariableKeys.join(', ')} into Vercel (${target.group.label})`
        )
        continue
      }

      const { url, token, current, next } = values.value

      yield* writeGroup(context, handle.value, target.group, [
        { key: 'QSTASH_URL', value: url, type: 'encrypted' },
        { key: 'QSTASH_TOKEN', value: token, type: target.type },
        { key: 'QSTASH_CURRENT_SIGNING_KEY', value: current, type: target.type },
        { key: 'QSTASH_NEXT_SIGNING_KEY', value: next, type: target.type }
      ])
    }
  })

interface QStashValues {
  readonly url: Redacted.Redacted<string>
  readonly token: Redacted.Redacted<string>
  readonly current: Redacted.Redacted<string>
  readonly next: Redacted.Redacted<string>
}

/**
 * Asks the operator to paste a team's QStash `.env` block from the Upstash console (a team's
 * QStash is only readable with a key created inside that team). An empty line skips.
 */
const askQStash = (team: string, group: EnvGroup) =>
  withTerminal(
    Effect.gen(function* () {
      const secrets = yield* SecretInput
      let problem = ''

      for (;;) {
        const pasted = yield* secrets.readEnv(
          `\nQStash for ${team} → Vercel (${group.label})\n` +
            `  1. Open https://console.upstash.com/qstash and switch to team ${team}\n` +
            `     (team menu, top left), EU region (eu-central-1).\n` +
            `  2. In Quickstart, copy the .env block (all 4 lines) and paste it here, then Enter.\n` +
            `  Press Enter on an empty line to skip and copy them into Vercel later.\n` +
            `${problem}QStash .env: `,
          qstashVariableKeys
        )

        if (Option.isNone(pasted)) return Option.none<QStashValues>()

        const [url, token, current, next] = qstashVariableKeys.map(key => pasted.value.get(key))
        const missing = qstashVariableKeys.filter(key => !pasted.value.has(key))

        if (
          url === undefined ||
          token === undefined ||
          current === undefined ||
          next === undefined
        ) {
          problem = `  Missing ${missing.join(', ')}; paste the whole block again.\n`
        } else if (!isHttpsUrl(Redacted.value(url))) {
          problem = '  QSTASH_URL must be an https URL; paste the whole block again.\n'
        } else {
          return Option.some({ url, token, current, next })
        }
      }
    })
  ).pipe(Effect.mapError(error => factoryError(error.message)))

const isHttpsUrl = (value: string) => URL.canParse(value) && new URL(value).protocol === 'https:'
