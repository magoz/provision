import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { Command } from 'effect/cli'
import { readLease } from '../db/lease.ts'
import { fakeNeon, type FakeNeonOptions } from '../testing/fake-neon.ts'
import { scriptedProcessLayer, type Invocation } from '../testing/scripted-process.ts'
import { dbEnvironmentLayer, temporaryDirectory } from '../testing/temporary.ts'
import { envCommand } from './commands.ts'

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.test'
    }
  })

const profile = [
  'SANDBOX_DB_NEON_API_KEY=project-key',
  'SANDBOX_DB_NEON_PROJECT_ID=project',
  'SANDBOX_DB_PARENT_BRANCH_ID=parent'
].join('\n')

/** What `vercel env pull` writes for each environment. */
const pulls: Readonly<Record<string, string>> = {
  development: `${profile}\nAPI_URL=https://dev\nVERCEL_ENV=development\nDATABASE_URL=postgres://vercel\nALLOW_E2E_DATABASE_RESET=1\n`,
  test: 'API_URL=https://test\nVERCEL_URL=preview.example\nALLOW_E2E_DATABASE_RESET=1\n'
}

const vercelScript = (invocation: Invocation) => {
  if (invocation.command !== 'vercel') return undefined
  const [verb, action] = invocation.args

  if (verb === 'env' && action === 'list') return { stdout: '  API_URL   Encrypted\n' }

  if (verb === 'api') {
    return action === '/v9/projects/acme-web'
      ? { stdout: JSON.stringify({ id: 'prj_web', accountId: 'team_1', name: 'acme-web' }) }
      : { exitCode: 1, stderr: 'Error: Project not found (404)\n' }
  }

  if (verb === 'env' && action === 'pull') {
    const file = invocation.args[2] ?? ''
    const environment = invocation.args[invocation.args.indexOf('--environment') + 1] ?? ''

    return Effect.promise(() => writeFile(file, pulls[environment] ?? '')).pipe(
      Effect.as(undefined)
    )
  }

  return undefined
}

interface Fixture {
  readonly packageJson?: Record<string, unknown>
  readonly appDir?: string
  readonly neon?: FakeNeonOptions
  readonly linkPrimary?: boolean
}

const fixture = (options: Fixture = {}) =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory('provision-env')
    const stateHome = yield* temporaryDirectory('provision-env-state')
    const configHome = yield* temporaryDirectory('provision-env-config')
    const primary = join(root, 'primary')
    const worktree = join(root, 'feature')
    const appDir = options.appDir ?? '.'

    yield* Effect.promise(async () => {
      await mkdir(join(primary, appDir, '.vercel'), { recursive: true })
      git(primary, 'init', '--quiet', '--initial-branch', 'main')
      git(primary, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git')
      await writeFile(join(primary, '.gitignore'), '.env.local\n.env.test\n.vercel\n')
      await writeFile(join(primary, 'pnpm-lock.yaml'), '')
      await writeFile(
        join(primary, 'package.json'),
        JSON.stringify({ name: 'repo', ...options.packageJson })
      )

      if (appDir !== '.') await writeFile(join(primary, appDir, 'package.json'), '{}')
      git(primary, 'add', '.')
      git(primary, 'commit', '--quiet', '-m', 'init')
      git(primary, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)

      if (options.linkPrimary !== false) {
        await writeFile(
          join(primary, appDir, '.vercel', 'project.json'),
          JSON.stringify({ orgId: 'team_1', projectId: 'prj_1' })
        )
      }
    })

    const invocations: Array<Invocation> = []
    const neon = fakeNeon('repo-dev', options.neon)

    const layer = Layer.mergeAll(
      scriptedProcessLayer(vercelScript, invocations),
      dbEnvironmentLayer({ configHome, stateHome }),
      neon.layer
    )

    const run = (...args: ReadonlyArray<string>) =>
      Command.runWith(envCommand, { version: 'test' })(args).pipe(Effect.provide(layer))

    const read = (file: string) =>
      Effect.promise(() => readFile(join(worktree, appDir, file), 'utf8').catch(() => undefined))

    const lease = (slot: string) => readLease(worktree, slot).pipe(Effect.provide(layer))

    return { primary, worktree, invocations, neon, run, read, lease }
  })

const setupCommands = (invocations: ReadonlyArray<Invocation>) =>
  invocations
    .filter(invocation => invocation.args[0] === '-lc')
    .map(invocation => invocation.args[1])

afterEach(() => {
  process.exitCode = undefined
})

describe('provision env', () => {
  it.live('installs, reuses the sibling link, pulls env, allocates databases, and runs setup', () =>
    Effect.gen(function* () {
      const env = yield* fixture({
        packageJson: { provision: { setup: ['pnpm db:migrate', 'pnpm db:seed'] } }
      })

      yield* env.run('--repo', env.worktree, '--database', '--non-interactive', '--label', 'feat')
      expect(process.exitCode).toBeUndefined()

      const link = yield* env.read('.vercel/project.json')
      expect(link).toContain('prj_1')

      const local = yield* env.read('.env.local')
      const test = yield* env.read('.env.test')
      const development = Option.getOrThrow(yield* env.lease('default'))
      const testLease = Option.getOrThrow(yield* env.lease('test'))

      expect(local).toContain('API_URL=https://dev')
      expect(local).toContain(profile)
      expect(local).not.toContain('VERCEL_ENV')
      expect(local).not.toContain('postgres://vercel')
      expect(local).not.toContain('ALLOW_E2E_DATABASE_RESET')
      expect(local).toContain(`DATABASE_URL=postgres://${development.branchId}-pooler/neondb`)
      expect(test).toContain('ALLOW_E2E_DATABASE_RESET=1')
      expect(test).not.toContain('VERCEL_URL')
      expect(test).toContain(`DATABASE_URL_UNPOOLED=postgres://${testLease.branchId}/neondb`)
      expect(development.branchName).toMatch(/^agent\/repo-feat-development-/)

      const mode = yield* Effect.promise(() => stat(join(env.worktree, '.env.local')))
      expect(mode.mode & 0o777).toBe(0o600)

      const install = env.invocations.find(invocation => invocation.command === 'pnpm')
      expect(install?.args).toEqual(['install', '--frozen-lockfile'])
      expect(install?.cwd).toBe(env.worktree)
      expect(setupCommands(env.invocations)).toEqual(['pnpm db:migrate', 'pnpm db:seed'])
    })
  )

  it.live('writes env files and the link in a monorepo app directory', () =>
    Effect.gen(function* () {
      const env = yield* fixture({
        appDir: 'apps/web',
        packageJson: { provision: { appDir: 'apps/web' } }
      })

      yield* env.run('--repo', env.worktree, '--non-interactive', '--skip-install')
      expect(process.exitCode).toBeUndefined()

      expect(yield* env.read('.env.local')).toContain('API_URL=https://dev')
      expect(yield* env.read('.vercel/project.json')).toContain('prj_1')

      const rootLocal = yield* Effect.promise(() =>
        readFile(join(env.worktree, '.env.local'), 'utf8').catch(() => undefined)
      )
      expect(rootLocal).toBeUndefined()

      const pull = env.invocations.find(invocation => invocation.args[1] === 'pull')
      expect(pull?.args).toContain(join(env.worktree, 'apps/web'))
    })
  )

  it.live('reports a missing Vercel link as JSON with exit code 3', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ linkPrimary: false })

      yield* env.run('--repo', env.worktree, '--check-vercel-link', '--non-interactive')

      expect(process.exitCode).toBe(3)
      expect(env.invocations).toEqual([])
    })
  )

  it.live('links --vercel-project by writing only the identity, never running vercel link', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ linkPrimary: false })

      yield* env.run(
        '--repo',
        env.worktree,
        '--vercel-project',
        'acme-web',
        '--non-interactive',
        '--skip-install',
        '--skip-setup'
      )

      expect(process.exitCode).toBeUndefined()
      expect(JSON.parse((yield* env.read('.vercel/project.json')) ?? '{}')).toEqual({
        projectId: 'prj_web',
        orgId: 'team_1',
        projectName: 'acme-web'
      })
      expect(env.invocations[0]?.args.slice(0, 2)).toEqual(['api', '/v9/projects/acme-web'])
      expect(env.invocations.some(invocation => invocation.args[0] === 'link')).toBe(false)
      expect(yield* env.read('.gitignore')).toBe('.env.local\n.env.test\n.vercel\n')
    })
  )

  it.live('links --vercel-project in an app subdirectory and rolls the link back on failure', () =>
    Effect.gen(function* () {
      const env = yield* fixture({
        appDir: 'apps/web',
        packageJson: { provision: { appDir: 'apps/web' } },
        linkPrimary: false,
        neon: { failCreation: 2 }
      })

      yield* env.run(
        '--repo',
        env.worktree,
        '--vercel-project',
        'acme-web',
        '--database',
        '--non-interactive',
        '--skip-install'
      )

      expect(process.exitCode).toBe(2)
      const lookup = env.invocations.find(invocation => invocation.args[0] === 'api')
      expect(lookup?.args.at(-1)).toBe(join(env.worktree, 'apps/web'))
      // The link existed (env pulls ran after it) and the failed allocation removed it again.
      expect(env.invocations.some(invocation => invocation.args[1] === 'pull')).toBe(true)
      expect(yield* env.read('.vercel/project.json')).toBeUndefined()
      expect(yield* Effect.promise(() => readFile(join(env.worktree, '.gitignore'), 'utf8'))).toBe(
        '.env.local\n.env.test\n.vercel\n'
      )
    })
  )

  it.live('fails without linking when --vercel-project is not in the current scope', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ linkPrimary: false })

      yield* env.run(
        '--repo',
        env.worktree,
        '--vercel-project',
        'missing-web',
        '--non-interactive',
        '--skip-install',
        '--skip-setup'
      )

      expect(process.exitCode).toBe(2)
      expect(yield* env.read('.vercel/project.json')).toBeUndefined()
    })
  )

  it.live('rolls back leases, env files, and the created link when allocation fails', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ neon: { failCreation: 2 } })
      yield* Effect.promise(() => writeFile(join(env.worktree, '.env.local'), 'BEFORE=1\n'))

      yield* env.run('--repo', env.worktree, '--database', '--non-interactive', '--skip-install')

      expect(process.exitCode).toBe(2)
      expect(yield* env.read('.env.local')).toBe('BEFORE=1\n')
      expect(yield* env.read('.env.test')).toBeUndefined()
      expect(yield* env.read('.vercel/project.json')).toBeUndefined()
      expect(Option.isNone(yield* env.lease('default'))).toBe(true)
      expect(Option.isNone(yield* env.lease('test'))).toBe(true)
      expect([...env.neon.branches.keys()]).toEqual(['parent'])
      expect(setupCommands(env.invocations)).toEqual([])
    })
  )

  it.live('skips env, databases, and setup for install-only runs', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ packageJson: { provision: { setup: ['pnpm db:migrate'] } } })

      yield* env.run('--repo', env.worktree, '--skip-vercel', '--non-interactive')

      expect(process.exitCode).toBeUndefined()
      expect(env.invocations.map(invocation => invocation.command)).toEqual(['pnpm'])
      expect(yield* env.read('.env.local')).toBeUndefined()
    })
  )

  it.live('fails before any mutation on legacy package.json keys', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ packageJson: { worktree: { setup: ['pnpm db:migrate'] } } })

      yield* env.run('--repo', env.worktree, '--non-interactive')

      expect(process.exitCode).toBe(2)
      expect(env.invocations).toEqual([])
    })
  )

  it.live('fails before any mutation on an invalid provision key', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ packageJson: { provision: { setup: ['  '] } } })

      yield* env.run('--repo', env.worktree, '--non-interactive')

      expect(process.exitCode).toBe(2)
      expect(env.invocations).toEqual([])
    })
  )

  it.live('preserves existing env files on request and still runs setup', () =>
    Effect.gen(function* () {
      const env = yield* fixture({ packageJson: { provision: { setup: ['pnpm db:migrate'] } } })

      yield* Effect.promise(async () => {
        await writeFile(join(env.worktree, '.env.local'), 'KEEP=local\n')
        await writeFile(join(env.worktree, '.env.test'), 'KEEP=test\n')
      })

      yield* env.run('--repo', env.worktree, '--env-conflict', 'preserve', '--skip-install')

      expect(process.exitCode).toBeUndefined()
      expect(yield* env.read('.env.local')).toBe('KEEP=local\n')
      expect(env.invocations.some(invocation => invocation.command === 'vercel')).toBe(false)
      expect(setupCommands(env.invocations)).toEqual(['pnpm db:migrate'])
    })
  )
})
