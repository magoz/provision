import { Effect } from 'effect'
import { parseEnvFile } from '../shared/env-file.ts'
import { fail } from './domain.ts'

/** Variables Vercel adds to pulls of deployment targets that do not belong in local env files. */
const deploymentMetadataKeys = new Set([
  'CI',
  'NX_DAEMON',
  'TURBO_CACHE',
  'TURBO_DOWNLOAD_LOCAL_ENABLED',
  'TURBO_REMOTE_ONLY',
  'TURBO_RUN_SUMMARY',
  'VERCEL',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'VERCEL_BRANCH_URL',
  'VERCEL_DEPLOYMENT_ID',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_AUTHOR_LOGIN',
  'VERCEL_GIT_COMMIT_AUTHOR_NAME',
  'VERCEL_GIT_COMMIT_MESSAGE',
  'VERCEL_GIT_COMMIT_REF',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_PREVIOUS_SHA',
  'VERCEL_GIT_PROVIDER',
  'VERCEL_GIT_PULL_REQUEST_ID',
  'VERCEL_GIT_REPO_ID',
  'VERCEL_GIT_REPO_OWNER',
  'VERCEL_GIT_REPO_SLUG',
  'VERCEL_HASH_SALT',
  'VERCEL_OIDC_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_REGION',
  'VERCEL_SKEW_PROTECTION_ENABLED',
  'VERCEL_TARGET_ENV',
  'VERCEL_URL'
])

export const databaseUrlKeys = new Set(['DATABASE_URL', 'DATABASE_URL_UNPOOLED'])

/** Destructive E2E reset consent: allowed only in `.env.test`, never in `.env.local`. */
export const resetConsentKey = 'ALLOW_E2E_DATABASE_RESET'

const keyOf = (line: string) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]

export interface StripOptions {
  /** Keys explicitly configured in Vercel; kept even when they look like deployment metadata. */
  readonly explicitKeys: ReadonlySet<string>
  /** Drop Vercel database URLs because isolated databases replace them. */
  readonly replaceDatabaseUrls: boolean
  /** Drop the destructive reset consent (Development pulls). */
  readonly removeResetConsent: boolean
}

export const stripPulledEnvironment = (content: string, options: StripOptions) => {
  let metadataRemoved = 0
  let databaseUrlsRemoved = 0

  const lines = content.split('\n').filter(line => {
    const key = keyOf(line)

    if (key === undefined) return true

    if (options.removeResetConsent && key === resetConsentKey) {
      metadataRemoved += 1

      return false
    }

    if (options.replaceDatabaseUrls && databaseUrlKeys.has(key)) {
      databaseUrlsRemoved += 1

      return false
    }

    if (options.explicitKeys.has(key) || !deploymentMetadataKeys.has(key)) return true
    metadataRemoved += 1

    return false
  })

  return { content: lines.join('\n'), databaseUrlsRemoved, metadataRemoved }
}

/** Carries database URL lines from `existing` into `pulled` (when databases are not reallocated). */
export const keepExistingDatabaseUrls = (pulled: string, existing: string) => {
  const retained = new Map<string, string>()

  for (const line of existing.split('\n')) {
    const key = keyOf(line)

    if (key !== undefined && databaseUrlKeys.has(key)) retained.set(key, line)
  }

  if (retained.size === 0) return pulled

  const trailingNewline = pulled.endsWith('\n')
  const lines = pulled.split('\n')

  if (trailingNewline) lines.pop()

  for (const [key, line] of retained) {
    const index = lines.findIndex(candidate => candidate.startsWith(`${key}=`))

    if (index >= 0) lines[index] = line
    else lines.push(line)
  }

  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`
}

export const ensureNoLocalResetConsent = (localContent: string) =>
  parseEnvFile(localContent).has(resetConsentKey)
    ? Effect.fail(fail(`${resetConsentKey} is forbidden in .env.local`))
    : Effect.void
