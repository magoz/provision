import { Console, Effect, FileSystem, Option, Path, Schema } from 'effect'
import { gitOutput, gitSucceeds } from '../shared/git.ts'
import { capture, inherit } from '../shared/process.ts'
import { fail, VercelLinkRequired } from './domain.ts'
import {
  ensureLocalDirectory,
  ensureProvisionPaths,
  ensureRegularFile,
  resolveAppDirectory,
  resolveCheckout
} from './paths.ts'

const VercelProjectIdentity = Schema.fromJsonString(
  Schema.Struct({ orgId: Schema.String, projectId: Schema.String })
)

/** `orgId:projectId` from a `.vercel/project.json`, which must be a regular local file. */
export const readVercelIdentity = (projectFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* ensureRegularFile(projectFile, 'Vercel project identity')

    const content = yield* fs
      .readFileString(projectFile)
      .pipe(Effect.mapError(() => fail(`cannot read Vercel project identity from ${projectFile}`)))

    const parsed = yield* Schema.decodeUnknownEffect(VercelProjectIdentity)(content).pipe(
      Effect.mapError(() => fail(`invalid Vercel project identity in ${projectFile}`))
    )

    return `${parsed.orgId}:${parsed.projectId}`
  })

const originUrl = (cwd: string) =>
  gitOutput(cwd, ['remote', 'get-url', 'origin']).pipe(Effect.map(Option.getOrElse(() => '')))

/**
 * Copies the selected app's `.vercel/project.json` from another checkout of the same repository.
 * Returns `false` when the source app is not linked. A failed copy removes the partial link.
 */
export const copyProjectIdentity = (directory: string, source: string, appDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sourceRoot = yield* resolveCheckout(source)
    const from = (yield* resolveAppDirectory(sourceRoot, appDir)).directory
    yield* ensureProvisionPaths(from, ['.vercel/project.json'])
    const sourceVercelDirectory = path.join(from, '.vercel')
    const sourceProjectFile = path.join(sourceVercelDirectory, 'project.json')
    const sourceLinked = yield* fs.exists(sourceProjectFile).pipe(Effect.orElseSucceed(() => false))

    if (!sourceLinked) return false

    yield* ensureLocalDirectory(sourceVercelDirectory, 'source .vercel path')
    const sourceIdentity = yield* readVercelIdentity(sourceProjectFile)
    const [targetRemote, sourceRemote] = yield* Effect.all([originUrl(directory), originUrl(from)])

    if (targetRemote.length > 0 && sourceRemote.length > 0 && targetRemote !== sourceRemote) {
      return yield* fail(`refusing Vercel identity from a different Git remote: ${from}`)
    }

    if (!(yield* gitSucceeds(directory, ['check-ignore', '-q', '--', '.vercel/project.json']))) {
      return yield* fail('refusing to create .vercel/project.json because .vercel is not ignored')
    }

    const targetDirectory = path.join(directory, '.vercel')
    const targetProjectFile = path.join(targetDirectory, 'project.json')

    yield* Effect.gen(function* () {
      if (!(yield* fs.exists(targetDirectory).pipe(Effect.orElseSucceed(() => false)))) {
        yield* fs
          .makeDirectory(targetDirectory, { recursive: true })
          .pipe(Effect.mapError(() => fail('cannot create .vercel directory')))
      }

      yield* ensureLocalDirectory(targetDirectory, 'checkout .vercel path')
      yield* fs
        .chmod(targetDirectory, 0o700)
        .pipe(Effect.mapError(() => fail('cannot protect .vercel directory')))
      yield* fs
        .copyFile(sourceProjectFile, targetProjectFile)
        .pipe(Effect.mapError(() => fail('cannot copy Vercel project identity')))
      yield* fs
        .chmod(targetProjectFile, 0o600)
        .pipe(Effect.mapError(() => fail('cannot protect Vercel project identity')))

      const [sourceAfterCopy, targetIdentity] = yield* Effect.all([
        readVercelIdentity(sourceProjectFile),
        readVercelIdentity(targetProjectFile)
      ])

      if (sourceAfterCopy !== sourceIdentity || targetIdentity !== sourceIdentity) {
        return yield* fail('Vercel project identity changed while it was being copied')
      }

      yield* Console.log(`provision env: reused Vercel project identity from ${from}`)
    }).pipe(
      Effect.catch(operationError =>
        fs.remove(targetProjectFile, { force: true }).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.fail(
                fail(
                  'Vercel project identity copy and cleanup both failed; manual review is required'
                )
              ),
            onSuccess: () => Effect.fail(operationError)
          })
        )
      )
    )

    return true
  })

export interface LinkRequest {
  /** Absolute app directory in the target checkout. */
  readonly directory: string
  readonly appDir: string
  readonly checkout: string
  readonly source: string | undefined
  readonly vercelProject: string | undefined
}

/**
 * Ensures the app directory is linked to Vercel. Order: existing link, explicit `--source`, explicit
 * `--vercel-project`, then the single identity shared by every linked sibling worktree. Returns
 * whether this invocation created the link.
 */
export const ensureVercelLink = (request: LinkRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const vercelDirectory = path.join(request.directory, '.vercel')
    const projectFile = path.join(vercelDirectory, 'project.json')

    if (yield* fs.exists(vercelDirectory).pipe(Effect.orElseSucceed(() => false))) {
      yield* ensureLocalDirectory(vercelDirectory, 'checkout .vercel path')
    }

    if (yield* fs.exists(projectFile).pipe(Effect.orElseSucceed(() => false))) {
      yield* readVercelIdentity(projectFile)

      return false
    }

    // An explicit but unlinked source is not a dead end: try sibling identities next.
    if (
      request.source !== undefined &&
      (yield* copyProjectIdentity(request.directory, request.source, request.appDir))
    ) {
      return true
    }

    if (request.vercelProject !== undefined) {
      if (
        !(yield* gitSucceeds(request.directory, [
          'check-ignore',
          '-q',
          '--',
          '.vercel/project.json'
        ]))
      ) {
        return yield* fail('.vercel must be git-ignored before linking')
      }

      yield* Console.log(`provision env: linking to Vercel project ${request.vercelProject}`)
      yield* inherit('vercel', [
        'link',
        '--cwd',
        request.directory,
        '--project',
        request.vercelProject,
        '--yes',
        '--no-color'
      ]).pipe(Effect.mapError(error => fail(error.message)))

      return true
    }

    const listed = yield* gitOutput(request.checkout, ['worktree', 'list', '--porcelain'])
    const candidates: Array<string> = []

    for (const line of Option.getOrElse(listed, () => '').split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const candidate = line.slice('worktree '.length)

      if (path.resolve(candidate) === request.checkout) continue
      const linkedFile = path.join(candidate, request.appDir, '.vercel', 'project.json')

      if (yield* fs.exists(linkedFile).pipe(Effect.orElseSucceed(() => false))) {
        yield* resolveAppDirectory(candidate, request.appDir)
        yield* ensureProvisionPaths(path.join(candidate, request.appDir), ['.vercel/project.json'])
        candidates.push(candidate)
      }
    }

    const first = candidates[0]

    if (first !== undefined) {
      const identities = yield* Effect.forEach(candidates, candidate =>
        readVercelIdentity(path.join(candidate, request.appDir, '.vercel', 'project.json'))
      )

      if (
        new Set(identities).size === 1 &&
        (yield* copyProjectIdentity(request.directory, first, request.appDir))
      ) {
        return true
      }

      return yield* new VercelLinkRequired({
        directory: request.directory,
        reason:
          'linked sibling checkouts use different Vercel projects; choose a linked --source explicitly'
      })
    }

    return yield* new VercelLinkRequired({
      directory:
        request.source === undefined
          ? request.directory
          : (yield* resolveAppDirectory(yield* resolveCheckout(request.source), request.appDir))
              .directory,
      reason: 'no Vercel project link found for the selected app'
    })
  })

/** Keys explicitly configured for `environment` (so pulled values with those names are kept). */
export const listExplicitVercelKeys = (directory: string, environment: string) =>
  Effect.gen(function* () {
    const listed = yield* capture('vercel', [
      'env',
      'list',
      environment,
      '--cwd',
      directory,
      '--no-color'
    ])

    if (listed.exitCode !== 0) {
      return yield* fail(`vercel env list ${environment} failed (exit ${listed.exitCode})`)
    }

    return new Set(
      listed.stdout.split('\n').flatMap(line => {
        const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(line)?.[1]

        return key === undefined ? [] : [key]
      })
    )
  }).pipe(Effect.catchTag('ProcessError', error => Effect.fail(fail(error.message))))

export const pullVercelEnvironment = (directory: string, file: string, environment: string) =>
  inherit('vercel', [
    'env',
    'pull',
    file,
    '--environment',
    environment,
    '--yes',
    '--cwd',
    directory,
    '--no-color'
  ]).pipe(Effect.mapError(error => fail(error.message)))
