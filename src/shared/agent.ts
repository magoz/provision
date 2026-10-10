/**
 * Detects a coding agent from the environment it sets for the commands it runs (the same signals
 * as `@vercel/detect-agent`). This only shapes the experience: what keeps agents from approving
 * factory runs is the passphrase read from the terminal, not this check.
 */
const agentVariables: ReadonlyArray<readonly [variable: string, agent: string]> = [
  ['CURSOR_TRACE_ID', 'cursor'],
  ['CURSOR_AGENT', 'cursor-cli'],
  ['GEMINI_CLI', 'gemini'],
  ['CODEX_SANDBOX', 'codex'],
  ['CODEX_CI', 'codex'],
  ['CODEX_THREAD_ID', 'codex'],
  ['ANTIGRAVITY_AGENT', 'antigravity'],
  ['AUGMENT_AGENT', 'augment-cli'],
  ['OPENCODE', 'opencode'],
  ['OPENCODE_CLIENT', 'opencode'],
  ['CLAUDECODE', 'claude'],
  ['CLAUDE_CODE', 'claude'],
  ['COPILOT_MODEL', 'github-copilot'],
  ['COPILOT_ALLOW_ALL', 'github-copilot']
]

/** The agent running this process, or `undefined` for a human. `AI_AGENT` names it explicitly. */
export const detectAgent = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const named = env['AI_AGENT']?.trim()

  if (named !== undefined && named !== '') return named

  return agentVariables.find(([variable]) => (env[variable] ?? '') !== '')?.[1]
}
