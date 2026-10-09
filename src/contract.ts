/**
 * The machine-readable contract other tools (for example `worktree`) rely on.
 *
 * Bump `contractVersion` only for breaking changes to command names, flags, JSON output shapes,
 * or exit codes. Adding a command is not breaking: callers check `commands` for what they need.
 */
export const contractVersion = 1

export const contractCommands = ['contract', 'config', 'factory', 'env', 'db'] as const

export interface Contract {
  readonly contractVersion: number
  readonly provisionVersion: string
  readonly commands: ReadonlyArray<string>
}

export const contractFor = (provisionVersion: string): Contract => ({
  contractVersion,
  provisionVersion,
  commands: contractCommands
})
