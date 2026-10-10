import { Console, Effect, Option } from 'effect'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  mutate,
  requireProject,
  type FactoryContext
} from '../context.ts'
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
 * created inside that team, so copying them into Vercel stays manual; the step reports it until
 * Vercel has them.
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
    const records = Option.isSome(handle)
      ? yield* listEnvRecords(context.credentials.vercel.teamId, handle.value.project.id)
      : []
    const targets = Option.match(handle, {
      onNone: () => [
        { team: context.names.development, label: 'Development, Preview, test', done: false },
        { team: context.names.production, label: 'Production', done: false }
      ],
      onSome: project => {
        const groups = envGroups(project)

        return [
          { team: context.names.development, group: groups.preproduction },
          { team: context.names.production, group: groups.production }
        ].map(({ team, group }) => ({
          team,
          label: group.label,
          done: groupHasKeys(records, group, qstashVariableKeys)
        }))
      }
    })

    for (const pending of targets.filter(target => !target.done)) {
      yield* Console.log(
        `  manual: copy ${pending.team}'s EU QStash ${qstashVariableKeys.join(', ')} into Vercel (${pending.label})`
      )
    }
  })
