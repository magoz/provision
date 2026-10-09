import { Console, Effect, Option } from 'effect'
import { decide, factoryError, mutate, requireProject, type FactoryContext } from '../context.ts'
import { addProjectDomain, getProjectDomain } from '../vercel-api.ts'

/** Attaches `--domain` to the Vercel project and reports whether DNS verification is pending. */
export const domainStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const domain = context.domain

    if (domain === undefined) return yield* factoryError('the domain step needs --domain')

    const handle = yield* requireProject(context)

    if (Option.isNone(handle)) {
      yield* Console.log(`  would attach ${domain} after the vercel step creates the project`)

      return
    }

    const teamId = context.credentials.vercel.teamId
    const projectId = handle.value.project.id
    const existing = yield* getProjectDomain(teamId, projectId, domain)

    const attached = Option.isSome(existing)
      ? yield* decide(context, 'data', `Vercel domain ${domain}`).pipe(Effect.as(existing))
      : yield* mutate(
          context,
          `attach ${domain} to ${context.names.project}`,
          addProjectDomain(teamId, projectId, domain)
        )

    if (Option.isSome(attached) && attached.value.verified === false) {
      yield* Console.log(
        `  manual: ${domain} needs DNS verification; see the project's Domains page in Vercel`
      )
    }
  })
