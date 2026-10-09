import * as NodeFs from 'node:fs/promises'
import { Effect, FileSystem, Option, Path } from 'effect'
import { gitOutput, gitSucceeds } from '../shared/git.ts'
import { ensureNotSymlink } from '../shared/private-file.ts'
import { normalizeAppDir } from '../shared/repo-config.ts'
import { EnvError, fail } from './domain.ts'

/** Resolves and validates a Git checkout root. */
export const resolveCheckout = (requested: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const candidate = path.resolve(requested)

    const isDirectory = yield* fs.stat(candidate).pipe(
      Effect.map(info => info.type === 'Directory'),
      Effect.orElseSucceed(() => false)
    )

    if (!isDirectory) return yield* fail(`not a directory: ${candidate}`)

    const inside = yield* gitOutput(candidate, ['rev-parse', '--is-inside-work-tree'])

    if (Option.getOrUndefined(inside) !== 'true') {
      return yield* fail(`not a Git checkout: ${candidate}`)
    }

    const top = yield* gitOutput(candidate, ['rev-parse', '--show-toplevel'])

    if (Option.isNone(top)) return yield* fail(`cannot resolve checkout root: ${candidate}`)

    return path.resolve(top.value)
  })

/**
 * Resolves the selected application directory without changing checkout or lease identity. The
 * app must exist, contain `package.json` (unless it is the root), and be reached without symlinks.
 */
export const resolveAppDirectory = (repo: string, requested: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const appDir = normalizeAppDir(requested)

    if (appDir === undefined || appDir.includes(':')) {
      return yield* fail("app directory must be '.' or a checkout-relative path without traversal")
    }

    const directory = path.join(repo, appDir)

    const canonicalRoot = yield* fs
      .realPath(repo)
      .pipe(Effect.mapError(() => fail('cannot resolve checkout directory')))

    const canonicalApp = yield* fs
      .realPath(directory)
      .pipe(Effect.mapError(() => fail(`app directory does not exist: ${appDir}`)))

    if (canonicalApp !== path.join(canonicalRoot, appDir)) {
      return yield* fail('app directory must not traverse symlinks')
    }

    const info = yield* fs
      .stat(directory)
      .pipe(Effect.mapError(() => fail(`cannot inspect app directory: ${appDir}`)))

    if (info.type !== 'Directory') return yield* fail(`not an app directory: ${appDir}`)

    if (appDir !== '.') {
      const manifest = yield* fs
        .stat(path.join(directory, 'package.json'))
        .pipe(Effect.mapError(() => fail('app directory must contain package.json')))

      if (manifest.type !== 'File') return yield* fail('app directory must contain package.json')
    }

    return { appDir, directory }
  })

/**
 * Fails when any existing component of `directory/file` is a symlink (dangling links included).
 * Preflight validation, not a sandbox against concurrent same-user mutation.
 */
export const ensureProvisionPaths = (directory: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    for (const file of files) {
      let parent = directory

      for (const component of file.split('/')) {
        const entries = yield* fs
          .readDirectory(parent)
          .pipe(Effect.mapError(() => fail(`cannot inspect provisioning path: ${file}`)))

        if (!entries.includes(component)) break
        const child = path.join(parent, component)

        const symbolic = yield* Effect.tryPromise({
          try: async () => (await NodeFs.lstat(child)).isSymbolicLink(),
          catch: () => fail(`cannot inspect provisioning path: ${file}`)
        })

        if (symbolic) return yield* fail(`provisioning path must not traverse symlinks: ${file}`)
        parent = child
      }
    }
  })

/** Env files and Vercel links may only be written to untracked, ignored, non-symlink paths. */
export const ensureSecretPath = (repo: string, relativeFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    yield* ensureNotSymlink(path.join(repo, relativeFile)).pipe(
      Effect.mapError(() => fail(`refusing symbolic-link environment path: ${relativeFile}`))
    )

    if (yield* gitSucceeds(repo, ['ls-files', '--error-unmatch', '--', relativeFile])) {
      return yield* fail(`refusing to write ${relativeFile} because it is tracked`)
    }

    if (!(yield* gitSucceeds(repo, ['check-ignore', '-q', '--', relativeFile]))) {
      return yield* fail(`refusing to write ${relativeFile} because it is not git-ignored`)
    }
  })

const lstatCheck = (
  file: string,
  check: (info: Awaited<ReturnType<typeof NodeFs.lstat>>) => boolean,
  message: string
) =>
  Effect.tryPromise({
    try: async () => {
      if (!check(await NodeFs.lstat(file))) throw new Error('unsafe path')
    },
    catch: () => new EnvError({ message })
  })

export const ensureLocalDirectory = (directory: string, label: string) =>
  lstatCheck(
    directory,
    info => !info.isSymbolicLink() && info.isDirectory(),
    `${label} is not a local directory`
  )

export const ensureRegularFile = (file: string, label: string) =>
  lstatCheck(
    file,
    info => !info.isSymbolicLink() && info.isFile(),
    `${label} is not a regular local file`
  )

export const ensurePrivateMode = (file: string, mode: number, label: string) =>
  lstatCheck(
    file,
    info => !info.isSymbolicLink() && (Number(info.mode) & 0o777) === mode,
    `${label} does not have the required private mode`
  )
