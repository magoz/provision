import { join } from 'node:path'
import { Console, Effect, Option, Redacted, Schema } from 'effect'
import { readPrivately } from '../../shared/private-file.ts'
import { ensureLinkIgnored, writeProjectLink } from '../../shared/vercel-link.ts'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  mutate,
  writeGroup,
  type FactoryContext,
  type ProjectHandle
} from '../context.ts'
import {
  createCustomEnvironment,
  createProject,
  linkedRepository,
  listEnvRecords,
  setRootDirectory
} from '../vercel-api.ts'
import { findProject } from '../context.ts'

/** Destructive E2E reset consent, present only in the custom `test` environment. */
const resetConsentKey = 'ALLOW_E2E_DATABASE_RESET'

const LinkedProject = Schema.fromJsonString(Schema.Struct({ projectId: Schema.String }))

/**
 * Vercel project `<repo>` linked to the GitHub repository (Root Directory = `provision.appDir`),
 * its custom `test` environment, the `test`-only reset consent, and the checkout's link.
 */
export const vercelStep = (context: FactoryContext) =>
  Effect.gen(function* () {
    const teamId = context.credentials.vercel.teamId
    // Before any mutation, so a dry run reports a checkout the link cannot be written to.
    yield* ensureLinkIgnored(context.appDirectory).pipe(
      Effect.mapError(error => factoryError(error.message))
    )
    const found = yield* findProject(context)

    let handle: Option.Option<ProjectHandle> = found

    if (Option.isSome(found)) {
      const linked = linkedRepository(found.value.project)

      if (linked !== undefined && linked !== context.checkout.repository) {
        return yield* factoryError(
          `Vercel project ${context.names.project} is linked to ${linked}, not ${context.checkout.repository}`
        )
      }

      yield* decide(context, 'data', `Vercel project ${context.names.project}`)

      const rootDirectory = found.value.project.rootDirectory ?? '.'

      if (rootDirectory !== context.repoConfig.appDir) {
        yield* mutate(
          context,
          `set the project Root Directory to ${context.repoConfig.appDir}`,
          setRootDirectory(teamId, found.value.project.id, context.repoConfig.appDir)
        )
      }
    } else {
      const created = yield* mutate(
        context,
        `create Vercel project ${context.names.project} linked to ${context.checkout.repository}`,
        createProject(teamId, {
          name: context.names.project,
          repository: context.checkout.repository,
          rootDirectory: context.repoConfig.appDir
        })
      )

      handle = Option.map(created, project => ({ project, testEnvironmentId: undefined }))
    }

    if (Option.isNone(handle)) {
      yield* Console.log('  would create the test environment and its reset consent')

      return
    }

    let project = handle.value

    if (project.testEnvironmentId === undefined) {
      const environment = yield* mutate(
        context,
        'create the custom test environment',
        createCustomEnvironment(teamId, project.project.id, 'test')
      )

      if (Option.isSome(environment)) {
        project = { ...project, testEnvironmentId: environment.value.id }
      }
    }

    if (project.testEnvironmentId !== undefined) {
      const records = yield* listEnvRecords(teamId, project.project.id)
      const test = envGroups(project).test

      if (!groupHasKeys(records, test, [resetConsentKey])) {
        yield* writeGroup(context, project, test, [
          { key: resetConsentKey, value: Redacted.make('1'), type: 'plain' }
        ])
      }
    }

    const projectFile = join(context.appDirectory, '.vercel', 'project.json')
    const existingLink = yield* readPrivately(projectFile).pipe(
      Effect.mapError(error => factoryError(error.message))
    )
    const linkedProjectId =
      existingLink === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(LinkedProject)(existingLink))?.projectId

    if (linkedProjectId !== project.project.id) {
      if (linkedProjectId !== undefined) {
        return yield* factoryError(
          `${projectFile} links a different Vercel project; remove it and rerun`
        )
      }

      yield* mutate(
        context,
        `link ${context.appDirectory} to ${context.names.project}`,
        writeProjectLink(context.appDirectory, {
          projectId: project.project.id,
          orgId: teamId,
          projectName: project.project.name
        }).pipe(Effect.mapError(error => factoryError(error.message)))
      )
    }
  })
