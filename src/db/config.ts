import { Effect, Option, Redacted } from 'effect'
import { parseEnvFile } from '../shared/env-file.ts'
import { readPrivately } from '../shared/private-file.ts'
import { sandboxProfileKeys } from '../shared/sandbox-profile.ts'
import { readSecret, readSettings, type Backend } from './credentials.ts'
import { ConfigurationError } from './domain.ts'

export type ConfigBackend = Backend | 'worktree-env'

export interface SandboxConfig {
  readonly apiKey: Redacted.Redacted<string>
  readonly projectId: string
  readonly parentBranch: string
  readonly backend: ConfigBackend
}

const missing = (what: string) =>
  new ConfigurationError({
    message:
      `${what}\n` +
      "run: provision db auth login, or configure the worktree's Vercel Development environment"
  })

/**
 * A worktree profile is atomic: once any local key is present, all three must be present. This
 * prevents accidentally combining one account's credential with another account's globally
 * configured project.
 */
const readWorktreeConfig = (envFile: string) =>
  Effect.gen(function* () {
    const content = yield* readPrivately(envFile).pipe(
      Effect.mapError(
        error =>
          new ConfigurationError({
            message:
              error.reason === 'symbolic-link'
                ? `refusing symbolic-link environment path: ${envFile}`
                : `cannot read local environment ${envFile}`
          })
      )
    )

    if (content === undefined) return Option.none<SandboxConfig>()

    const entries = parseEnvFile(content)
    const declared = sandboxProfileKeys.filter(key => entries.has(key))

    if (declared.length === 0) return Option.none<SandboxConfig>()

    const absent = sandboxProfileKeys.filter(key => !entries.has(key))
    const value = (key: string) => (entries.get(key) ?? '').trim()
    const empty = sandboxProfileKeys.filter(key => entries.has(key) && value(key).length === 0)

    if (absent.length > 0 || empty.length > 0) {
      const details = [
        absent.length > 0 ? `missing ${absent.join(', ')}` : '',
        empty.length > 0 ? `empty ${empty.join(', ')}` : ''
      ]
        .filter(detail => detail.length > 0)
        .join('; ')

      return yield* new ConfigurationError({
        message:
          `incomplete sandbox database profile in ${envFile}; ${details}\n` +
          'local profiles are not combined with global authentication'
      })
    }

    const [apiKey, projectId, parentBranch] = sandboxProfileKeys

    return Option.some<SandboxConfig>({
      apiKey: Redacted.make(value(apiKey)),
      projectId: value(projectId),
      parentBranch: value(parentBranch),
      backend: 'worktree-env'
    })
  })

/**
 * Resolves one complete credential/project/parent tuple. A complete profile in the worktree env
 * takes precedence; otherwise global auth is used as a fallback.
 */
export const loadConfig = (envFile?: string) =>
  Effect.gen(function* () {
    if (envFile !== undefined) {
      const local = yield* readWorktreeConfig(envFile)

      if (Option.isSome(local)) return local.value
    }

    const secret = yield* readSecret

    if (Option.isNone(secret)) return yield* missing('no neon api key configured')

    const settings = yield* readSettings

    if (Option.isNone(settings.projectId)) return yield* missing('no sandbox project configured')

    if (Option.isNone(settings.parentBranch)) return yield* missing('no parent branch configured')

    return {
      apiKey: secret.value.value,
      projectId: settings.projectId.value,
      parentBranch: settings.parentBranch.value,
      backend: secret.value.backend
    } satisfies SandboxConfig
  })
