import { Console, Effect, FileSystem, Path } from 'effect'
import { capture, inherit } from '../shared/process.ts'
import { fail } from './domain.ts'

/** Installs dependencies from the checkout root's committed lockfile, never updating it. */
export const installDependencies = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const exists = (file: string) =>
      fs.exists(path.join(repo, file)).pipe(Effect.orElseSucceed(() => false))

    const run = (label: string, command: string, args: ReadonlyArray<string>) =>
      Console.log(`provision env: installing dependencies with ${label}`).pipe(
        Effect.andThen(inherit(command, args, { cwd: repo })),
        Effect.mapError(error => fail(error.message))
      )

    if (yield* exists('pnpm-lock.yaml')) {
      return yield* run('pnpm --frozen-lockfile', 'pnpm', ['install', '--frozen-lockfile'])
    }

    if ((yield* exists('bun.lock')) || (yield* exists('bun.lockb'))) {
      return yield* run('bun --frozen-lockfile', 'bun', ['install', '--frozen-lockfile'])
    }

    if (yield* exists('package-lock.json')) return yield* run('npm ci', 'npm', ['ci'])

    if (yield* exists('yarn.lock')) {
      const version = yield* capture('yarn', ['--version'], { cwd: repo }).pipe(
        Effect.mapError(error => fail(error.message))
      )
      const major = Number(version.stdout.trim().split('.')[0])
      const flag = Number.isInteger(major) && major >= 2 ? '--immutable' : '--frozen-lockfile'

      return yield* run(`yarn ${flag}`, 'yarn', ['install', flag])
    }

    return yield* fail(`no supported lockfile found in ${repo}`)
  })
