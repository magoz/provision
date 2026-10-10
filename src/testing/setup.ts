import { detectAgent } from '../shared/agent.ts'

// Tests run inside coding agents; start every test file as a human operator would.
for (const variable of [
  'AI_AGENT',
  'CURSOR_TRACE_ID',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'CODEX_CI',
  'CODEX_THREAD_ID',
  'ANTIGRAVITY_AGENT',
  'AUGMENT_AGENT',
  'OPENCODE',
  'OPENCODE_CLIENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'COPILOT_MODEL',
  'COPILOT_ALLOW_ALL'
]) {
  delete process.env[variable]
}

if (detectAgent() !== undefined) throw new Error('test setup left an agent variable set')
