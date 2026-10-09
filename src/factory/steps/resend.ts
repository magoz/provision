import { Console, Effect, Option } from 'effect'
import {
  envGroups,
  factoryError,
  groupHasKeys,
  requireProject,
  writeGroup,
  type FactoryContext
} from '../context.ts'
import {
  createSendingKey,
  deleteApiKey,
  findApiKey,
  findSendingDomain
} from '../providers/resend.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import { listEnvRecords } from '../vercel-api.ts'

const variableKey = 'RESEND_API_KEY'

/** One sending-only key per environment group, restricted to the factory's sending domain. */
export const resendStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const resend = context.credentials.resend

    if (resend === undefined) return yield* factoryError('the factory item has no resend section')

    const domainId = yield* findSendingDomain(resend.apiKey, resend.sendingDomain)
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

    const targets = [
      { name: context.names.development, group: groups.preproduction, type: 'encrypted' },
      { name: context.names.production, group: groups.production, type: 'sensitive' }
    ] as const

    for (const target of targets) {
      yield* ensureScopedKey(context, {
        description: `Resend key ${target.name}`,
        existing: yield* findApiKey(resend.apiKey, target.name),
        vercelComplete: groupHasKeys(records, target.group, [variableKey]),
        createAndWrite: Effect.gen(function* () {
          const key = yield* createSendingKey(resend.apiKey, target.name, domainId)

          yield* writeGroup(context, handle.value, target.group, [
            { key: variableKey, value: key.token, type: target.type }
          ]).pipe(Effect.tapError(() => deleteApiKey(resend.apiKey, key.id).pipe(Effect.ignore)))
        }),
        remove: id => deleteApiKey(resend.apiKey, id)
      })
    }
  })
