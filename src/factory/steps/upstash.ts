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
import { SecretInput, type SecretInputShape } from '../secret-input.ts'
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

      yield* writeGroup(
        context,
        handle.value,
        target.group,
        qstashVariableKeys.map((key, index) => ({
          key,
          value: values.value[index] ?? Redacted.make(''),
          type: key === 'QSTASH_URL' ? 'encrypted' : target.type
        }))
      )
    }
  })

/**
 * Asks the operator to paste a team's QStash credentials from the Upstash console (a team's
 * QStash is only readable with a key created inside that team). An empty first value skips.
 */
const askQStash = (team: string, group: EnvGroup) =>
  withTerminal(
    Effect.gen(function* () {
      const secrets = yield* SecretInput
      const values: Array<Redacted.Redacted<string>> = []

      for (const [index, key] of qstashVariableKeys.entries()) {
        const intro =
          index === 0
            ? `\nQStash for ${team} → Vercel (${group.label})\n` +
              `  1. Open https://console.upstash.com/qstash and switch to team ${team}\n` +
              `     (team menu, top left).\n` +
              `  2. Choose the EU region (eu-central-1) and copy each value below.\n` +
              `  Press Enter on an empty value to skip and copy them into Vercel later.\n`
            : ''
        const value = yield* readQStashValue(secrets, `${intro}${key}: `, key)

        if (Option.isNone(value)) return Option.none<ReadonlyArray<Redacted.Redacted<string>>>()

        values.push(value.value)
      }

      return Option.some<ReadonlyArray<Redacted.Redacted<string>>>(values)
    })
  ).pipe(Effect.mapError(error => factoryError(error.message)))

const readQStashValue = (secrets: SecretInputShape, message: string, key: string) =>
  Effect.gen(function* () {
    let prompt = message

    for (;;) {
      const value = yield* secrets.read(prompt)

      if (Option.isNone(value) || key !== 'QSTASH_URL' || isHttpsUrl(Redacted.value(value.value))) {
        return value
      }

      prompt = `${key} must be an https URL, e.g. https://qstash-eu-central-1.upstash.io\n${key}: `
    }
  })

const isHttpsUrl = (value: string) => URL.canParse(value) && new URL(value).protocol === 'https:'
