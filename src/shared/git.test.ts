import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { nodeTestLayer, temporaryDirectory } from '../testing/temporary.ts'
import { ensureIgnored, repositoryFromRemote, resolveWorkspace } from './git.ts'

describe('repositoryFromRemote', () => {
  it.each([
    ['git@github.com:acme/app.git', 'acme/app'],
    ['https://github.com/magoz/provision.git', 'magoz/provision'],
    ['https://github.com/acme/web-app', 'acme/web-app'],
    ['ssh://git@github.com/owner/repo/', 'owner/repo']
  ])('parses %s', (url, expected) => {
    expect(repositoryFromRemote(url)).toBe(expected)
  })
})

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })

describe('workspace', () => {
  it.live('resolves the checkout root and repository from a subdirectory', () =>
    Effect.gen(function* () {
      const repo = yield* temporaryDirectory('provision-git')
      const nested = join(repo, 'apps', 'web')

      yield* Effect.promise(async () => {
        git(repo, 'init', '--quiet')
        git(repo, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git')
        await mkdir(nested, { recursive: true })
      })

      const workspace = yield* resolveWorkspace(Option.some(nested))
      expect(workspace.repository).toBe('owner/repo')
      expect(workspace.root.endsWith(repo.split('/').pop() ?? '')).toBe(true)
    }).pipe(Effect.provide(nodeTestLayer))
  )

  it.live('refuses directories outside Git', () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory('provision-no-git')
      const failure = yield* resolveWorkspace(Option.some(directory)).pipe(Effect.flip)
      expect(failure.message).toContain('not inside a git worktree')
    }).pipe(Effect.provide(nodeTestLayer))
  )

  it.live('allows secrets only in ignored, untracked paths', () =>
    Effect.gen(function* () {
      const repo = yield* temporaryDirectory('provision-ignore')

      yield* Effect.promise(async () => {
        git(repo, 'init', '--quiet')
        await writeFile(join(repo, '.gitignore'), '.env.local\n')
      })

      yield* ensureIgnored(repo, join(repo, '.env.local'))
      const failure = yield* ensureIgnored(repo, join(repo, '.env.test')).pipe(Effect.flip)
      expect(failure.message).toContain('not git-ignored')
    }).pipe(Effect.provide(nodeTestLayer))
  )
})
