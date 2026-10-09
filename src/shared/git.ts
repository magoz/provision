import { Data, Effect, FileSystem, Option, Path } from 'effect'
import { capture } from './process.ts'

export class WorkspaceError extends Data.TaggedError('WorkspaceError')<{
  readonly message: string
}> {}

export class SecretPathError extends Data.TaggedError('SecretPathError')<{
  readonly message: string
}> {}

/** Trimmed stdout of a git command, or `None` when it fails or cannot run. */
export const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  capture('git', ['-C', cwd, ...args]).pipe(
    Effect.map(result =>
      result.exitCode === 0 ? Option.some(result.stdout.trim()) : Option.none<string>()
    ),
    Effect.orElseSucceed(() => Option.none<string>())
  )

export const gitSucceeds = (cwd: string, args: ReadonlyArray<string>) =>
  capture('git', ['-C', cwd, ...args]).pipe(
    Effect.map(result => result.exitCode === 0),
    Effect.orElseSucceed(() => false)
  )

export interface Workspace {
  /** Absolute checkout root. */
  readonly root: string
  /** `owner/repository` from the `origin` remote, or the root directory name without one. */
  readonly repository: string
}

export const repositoryFromRemote = (url: string): string | undefined =>
  /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]

/** Resolves and validates a Git checkout root; anything outside Git is refused. */
export const resolveWorkspace = (requested: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const candidate = path.resolve(Option.getOrElse(requested, () => process.cwd()))

    const isDirectory = yield* fs.stat(candidate).pipe(
      Effect.map(info => info.type === 'Directory'),
      Effect.orElseSucceed(() => false)
    )

    if (!isDirectory) {
      return yield* new WorkspaceError({ message: `not a directory: ${candidate}` })
    }

    const inside = yield* gitOutput(candidate, ['rev-parse', '--is-inside-work-tree'])

    if (Option.getOrElse(inside, () => '') !== 'true') {
      return yield* new WorkspaceError({ message: `not inside a git worktree: ${candidate}` })
    }

    const top = yield* gitOutput(candidate, ['rev-parse', '--show-toplevel'])
    const root = path.resolve(Option.getOrElse(top, () => candidate))
    const remote = yield* gitOutput(root, ['remote', 'get-url', 'origin'])

    const repository = Option.match(remote, {
      onNone: () => path.basename(root),
      onSome: url => repositoryFromRemote(url) ?? path.basename(root)
    })

    return { root, repository } satisfies Workspace
  })

/**
 * Secrets may only be written to a path Git will never track. This is the guardrail that makes
 * automatic provisioning safe.
 */
export const ensureIgnored = (root: string, file: string) =>
  Effect.gen(function* () {
    if (yield* gitSucceeds(root, ['ls-files', '--error-unmatch', '--', file])) {
      return yield* new SecretPathError({
        message: `refusing to write secrets: ${file} is tracked by git`
      })
    }

    if (!(yield* gitSucceeds(root, ['check-ignore', '-q', '--', file]))) {
      return yield* new SecretPathError({
        message: `refusing to write secrets: ${file} is not git-ignored\nadd it to .gitignore first`
      })
    }
  })
