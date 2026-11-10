import { Console, Effect, Option } from 'effect'
import {
  decide,
  envGroups,
  environmentsHaveKeys,
  factoryError,
  groupKeyState,
  requireProject,
  writeGroup,
  type FactoryContext
} from '../context.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import {
  createGatewayKey,
  deleteGatewayKey,
  listEnvRecords,
  listGatewayKeys,
  type GatewayKey
} from '../vercel-api.ts'

const variableKey = 'AI_GATEWAY_API_KEY'

/** The key named `name`; two keys share a name only while a rotation is unfinished. */
const keyNamed = (keys: ReadonlyArray<GatewayKey>, name: string) => {
  const matches = keys.filter(key => key.name === name)

  return matches.length > 1
    ? Effect.fail(
        factoryError(
          `several AI Gateway keys are named ${name}, left by an unfinished rotation; ` +
            'keep the newest and remove the others by id (vercel ai-gateway api-keys ls)'
        )
      )
    : Effect.succeed(Option.map(Option.fromUndefinedOr(matches[0]), key => key.id))
}

/**
 * Two AI Gateway keys on the factory's Vercel team, so each company's spend is billed apart:
 * `<repo>` for Production and Preview (Sensitive), and `<repo>-dev` for Development (plain
 * encrypted: Development cannot hold Sensitive values, and `provision env` pulls it). The `test`
 * environment gets none: end-to-end suites never call the Gateway.
 */
export const aiGatewayStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const teamId = context.credentials.vercel.teamId
    const handle = yield* requireProject(context)
    const targets = (groups: ReturnType<typeof envGroups>) =>
      [
        { name: context.names.project, group: groups.deployed, type: 'sensitive' },
        { name: context.names.development, group: groups.development, type: 'encrypted' }
      ] as const
    const describeKey = (target: ReturnType<typeof targets>[number]) =>
      `AI Gateway key ${target.name} (${variableKey}: ${target.group.label}${target.type === 'sensitive' ? ', Sensitive' : ''})`

    if (Option.isNone(handle)) {
      for (const target of targets(envGroups({ testEnvironmentId: undefined }))) {
        yield* Console.log(
          `  would create ${describeKey(target)} after the vercel step creates the project`
        )
      }

      return
    }

    const records = yield* listEnvRecords(teamId, handle.value.project.id)
    const keys = yield* listGatewayKeys(teamId)

    for (const target of targets(envGroups(handle.value))) {
      const description = describeKey(target)
      const existing = yield* keyNamed(keys, target.name)

      // A variable set from some other key: replacing it moves the spend, so it is the
      // operator's call like any existing key.
      if (
        Option.isNone(existing) &&
        groupKeyState(records, target.group, [variableKey]) !== 'none'
      ) {
        const decision = yield* decide(
          context,
          'key',
          `${variableKey} in ${target.group.label}, set without ${description}`
        )

        if (decision === 'reuse') {
          yield* Console.log(`  reusing ${variableKey} in ${target.group.label}`)

          continue
        }
      }

      yield* ensureScopedKey(context, {
        description,
        existing,
        vercelComplete: environmentsHaveKeys(records, target.group, [variableKey]),
        createAndWrite: Effect.gen(function* () {
          const key = yield* createGatewayKey(teamId, target.name)

          yield* writeGroup(context, handle.value, target.group, [
            { key: variableKey, value: key.token, type: target.type }
          ]).pipe(Effect.tapError(() => deleteGatewayKey(teamId, key.id).pipe(Effect.ignore)))
        }),
        remove: id => deleteGatewayKey(teamId, id)
      })
    }
  })
