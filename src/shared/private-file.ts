import { randomBytes } from 'node:crypto'
import * as NodeFs from 'node:fs/promises'
import { Data, Effect, Predicate } from 'effect'

export class PrivateFileError extends Data.TaggedError('PrivateFileError')<{
  readonly reason: 'symbolic-link' | 'io'
  readonly message: string
}> {}

const isMissing = (cause: unknown) =>
  Predicate.hasProperty(cause, 'code') && cause.code === 'ENOENT'

/** Fails when `file` is a symbolic link (dangling links included); a missing path is fine. */
export const ensureNotSymlink = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        if ((await NodeFs.lstat(file)).isSymbolicLink()) throw new Error('symbolic link')
      } catch (cause) {
        if (isMissing(cause)) return
        throw cause
      }
    },
    catch: () =>
      new PrivateFileError({
        reason: 'symbolic-link',
        message: `refusing symbolic-link path: ${file}`
      })
  })

/**
 * Atomically replaces `file` with `content`, mode `0600` from the first byte. The temporary file is
 * created exclusively next to the target and removed if anything fails.
 */
export const writePrivately = (file: string, content: string) =>
  Effect.gen(function* () {
    yield* ensureNotSymlink(file)
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`

    yield* Effect.tryPromise({
      try: async () => {
        try {
          await NodeFs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
          await NodeFs.chmod(temporary, 0o600)
          await NodeFs.rename(temporary, file)
        } catch (cause) {
          await NodeFs.rm(temporary, { force: true }).catch(() => undefined)
          throw cause
        }
      },
      catch: () =>
        new PrivateFileError({ reason: 'io', message: `private atomic write failed: ${file}` })
    })
  })

/** Reads `file`, refusing symbolic links; a missing file reads as `undefined`. */
export const readPrivately = (file: string) =>
  Effect.gen(function* () {
    yield* ensureNotSymlink(file)

    return yield* Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFs.readFile(file, 'utf8')
        } catch (cause) {
          if (isMissing(cause)) return undefined
          throw cause
        }
      },
      catch: () => new PrivateFileError({ reason: 'io', message: `cannot read ${file}` })
    })
  })
