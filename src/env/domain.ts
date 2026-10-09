import { Data } from 'effect'

export class EnvError extends Data.TaggedError('EnvError')<{
  readonly message: string
}> {}

/**
 * The selected app has no usable Vercel link. Reported as one JSON object on stderr with exit code
 * 3 so a calling agent can link the project and retry.
 */
export class VercelLinkRequired extends Data.TaggedError('VercelLinkRequired')<{
  readonly directory: string
  readonly reason: string
}> {
  override get message() {
    return `Vercel link required in ${this.directory}: ${this.reason}`
  }
}

export const envConflictPolicies = ['ask', 'error', 'preserve', 'overwrite'] as const

export type EnvConflictPolicy = (typeof envConflictPolicies)[number]

export interface EnvOptions {
  readonly repo: string
  readonly checkVercelLink: boolean
  readonly appDir: string | undefined
  readonly source: string | undefined
  readonly vercelProject: string | undefined
  readonly database: boolean
  readonly testEnvironment: string
  readonly label: string | undefined
  readonly ttl: string
  readonly skipInstall: boolean
  readonly skipVercel: boolean
  readonly skipSetup: boolean
  readonly nonInteractive: boolean
  readonly envConflict: EnvConflictPolicy
}

export const fail = (message: string) => new EnvError({ message })
