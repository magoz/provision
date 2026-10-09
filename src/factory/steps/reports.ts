import { Console, Effect, Option, Redacted } from 'effect'
import {
  envGroups,
  groupHasKeys,
  requireProject,
  writeGroup,
  type FactoryContext
} from '../context.ts'
import {
  createReportToken,
  findReportToken,
  revokeReportToken
} from '../providers/report-receiver.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import { listEnvRecords } from '../vercel-api.ts'

export const reportVariableKeys = ['REPORT_RECEIVER_URL', 'REPORT_RECEIVER_TOKEN'] as const

/**
 * One report token per environment group from the factory's report receiver (its factory API).
 * Factories without a `report_receiver` section skip this step.
 */
export const reportsStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const receiver = context.credentials.reportReceiver

    if (receiver === undefined) {
      yield* Console.log('  skipped: the factory has no report receiver')

      return
    }

    const handle = yield* requireProject(context)

    if (Option.isNone(handle)) {
      yield* Console.log('  would run after the vercel step creates the project')

      return
    }

    const groups = envGroups(handle.value)
    const records = yield* listEnvRecords(
      context.credentials.vercel.teamId,
      handle.value.project.id
    )
    const [urlKey, tokenKey] = reportVariableKeys

    const targets = [
      { name: context.names.development, group: groups.preproduction, type: 'encrypted' },
      { name: context.names.production, group: groups.production, type: 'sensitive' }
    ] as const

    for (const target of targets) {
      yield* ensureScopedKey(context, {
        description: `report token ${target.name}`,
        existing: yield* findReportToken(receiver, target.name),
        vercelComplete: groupHasKeys(records, target.group, reportVariableKeys),
        createAndWrite: Effect.gen(function* () {
          const created = yield* createReportToken(receiver, target.name)

          yield* writeGroup(context, handle.value, target.group, [
            { key: urlKey, value: Redacted.make(receiver.url), type: target.type },
            { key: tokenKey, value: created.token, type: target.type }
          ]).pipe(
            Effect.tapError(() => revokeReportToken(receiver, created.id).pipe(Effect.ignore))
          )
        }),
        remove: id => revokeReportToken(receiver, id)
      })
    }
  })
