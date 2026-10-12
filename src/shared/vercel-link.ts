import * as NodeFs from 'node:fs/promises'
import { join } from 'node:path'
import { Data, Effect } from 'effect'
import { ensureIgnored } from './git.ts'
import { ensureNotSymlink, writePrivately } from './private-file.ts'

export class VercelLinkError extends Data.TaggedError('VercelLinkError')<{
  readonly message: string
}> {}

/** The identity `vercel link` stores in `.vercel/project.json`. */
export interface VercelProjectLink {
  readonly projectId: string
  /** The owning team's `team_*` id. */
  readonly orgId: string
  readonly projectName: string
}

/** Fails unless `<directory>/.vercel/project.json` is untracked and git-ignored. */
export const ensureLinkIgnored = (directory: string) =>
  ensureIgnored(directory, join('.vercel', 'project.json')).pipe(
    Effect.mapError(error => new VercelLinkError({ message: error.message }))
  )

/**
 * Links `directory` to a Vercel project by writing `.vercel/project.json` directly. `vercel link`
 * is never run: it also pulls Development variables into `.env.local` and appends `.env*` to the
 * repository's `.gitignore`, which silently ignores committed `.env.example` files.
 */
export const writeProjectLink = (directory: string, link: VercelProjectLink) =>
  Effect.gen(function* () {
    yield* ensureLinkIgnored(directory)
    const vercelDirectory = join(directory, '.vercel')

    yield* ensureNotSymlink(vercelDirectory).pipe(
      Effect.mapError(error => new VercelLinkError({ message: error.message }))
    )
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFs.mkdir(vercelDirectory, { recursive: true, mode: 0o700 })
        await NodeFs.chmod(vercelDirectory, 0o700)
      },
      catch: () => new VercelLinkError({ message: `cannot create ${vercelDirectory}` })
    })
    yield* writePrivately(
      join(vercelDirectory, 'project.json'),
      JSON.stringify({
        projectId: link.projectId,
        orgId: link.orgId,
        projectName: link.projectName
      })
    ).pipe(Effect.mapError(error => new VercelLinkError({ message: error.message })))
  })
