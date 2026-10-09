import { Console, Effect, Option, Redacted } from 'effect'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  mutate,
  requireProject,
  writeGroup,
  type EnvGroup,
  type FactoryContext
} from '../context.ts'
import { createTeam, findTeam, qstashUrl, readQStash } from '../providers/upstash.ts'
import { listEnvRecords } from '../vercel-api.ts'

export const qstashVariableKeys = [
  'QSTASH_URL',
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY'
] as const

/**
 * Retained `<repo>-dev` and `<repo>-prod` teams (QStash has one tenancy per team, so separate
 * teams are the only isolation boundary). When the factory item holds team-scoped keys
 * (`upstash.dev_api_key`, `upstash.prod_api_key`), each team's EU QStash credentials are written
 * to Vercel; otherwise the manual transfer is reported.
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
      yield* Console.log(
        '  would write QStash credentials after the vercel step creates the project'
      )

      return
    }

    const groups = envGroups(handle.value)
    const records = yield* listEnvRecords(
      context.credentials.vercel.teamId,
      handle.value.project.id
    )

    const targets: ReadonlyArray<{
      readonly team: string
      readonly key: Redacted.Redacted<string> | undefined
      readonly group: EnvGroup
      readonly secretType: 'encrypted' | 'sensitive'
    }> = [
      {
        team: context.names.development,
        key: upstash.developmentApiKey,
        group: groups.preproduction,
        secretType: 'encrypted'
      },
      {
        team: context.names.production,
        key: upstash.productionApiKey,
        group: groups.production,
        secretType: 'sensitive'
      }
    ]

    for (const target of targets) {
      if (groupHasKeys(records, target.group, qstashVariableKeys)) {
        const decision = yield* decide(context, 'key', `QStash records for ${target.group.label}`)

        if (decision === 'reuse') continue
      }

      if (target.key === undefined) {
        yield* Console.log(
          `  manual: copy ${target.team}'s EU QStash ${qstashVariableKeys.join(', ')} into Vercel (${target.group.label}), or add a team-scoped key to the factory item`
        )
        continue
      }

      const teamKey = target.key
      const [url, token, current, next] = qstashVariableKeys

      yield* Effect.gen(function* () {
        const qstash = yield* readQStash(upstash.email, teamKey)

        yield* writeGroup(context, handle.value, target.group, [
          { key: url, value: Redacted.make(qstashUrl), type: 'encrypted' },
          { key: token, value: qstash.token, type: target.secretType },
          { key: current, value: qstash.currentSigningKey, type: target.secretType },
          { key: next, value: qstash.nextSigningKey, type: target.secretType }
        ])
      })
    }
  })
