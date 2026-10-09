/**
 * The sandbox database profile: written to the Vercel Development environment by
 * `provision factory`, pulled into `.env.local` by `provision env`, and read by `provision db`.
 * All three keys are required together.
 */
export const sandboxProfileKeys = [
  'SANDBOX_DB_NEON_API_KEY',
  'SANDBOX_DB_NEON_PROJECT_ID',
  'SANDBOX_DB_PARENT_BRANCH_ID'
] as const

export type SandboxProfileKey = (typeof sandboxProfileKeys)[number]

/** Env keys `provision db create` writes by default. */
export const defaultDatabaseUrlKeys = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED'] as const
