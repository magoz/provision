import { describe, expect, it } from '@effect/vitest'
import { detectAgent } from '../shared/agent.ts'
import { approvalRequired, shellQuote } from './approval.ts'

describe('detectAgent', () => {
  it('names the agent from AI_AGENT or a known variable, and nobody otherwise', () => {
    expect(detectAgent({ AI_AGENT: ' acme-agent ' })).toBe('acme-agent')
    expect(detectAgent({ CLAUDECODE: '1' })).toBe('claude')
    expect(detectAgent({ OPENCODE: '1' })).toBe('opencode')
    expect(detectAgent({ CODEX_THREAD_ID: 'thread' })).toBe('codex')
    expect(detectAgent({ AI_AGENT: '', CLAUDECODE: '' })).toBeUndefined()
    expect(detectAgent({ HOME: '/home/acme' })).toBeUndefined()
  })
})

describe('approvalRequired', () => {
  it('gives the human the exact command, from the same directory', () => {
    const payload = approvalRequired({
      agent: 'claude',
      cwd: '/home/acme/src/acme app',
      binary: '/usr/local/bin/provision',
      args: ['factory', '--checkout', '.', '--sender-name', "Acme's App"]
    })

    expect(payload.status).toBe('approval_required')
    expect(payload.reason).toContain('claude')
    expect(payload.next).toEqual([
      `cd '/home/acme/src/acme app' && /usr/local/bin/provision factory --checkout . --sender-name 'Acme'\\''s App'`
    ])
  })

  it('leaves plain arguments unquoted and quotes everything else', () => {
    expect(shellQuote('--domain=app.acme.test')).toBe('--domain=app.acme.test')
    expect(shellQuote('noreply@acme.test')).toBe('noreply@acme.test')
    expect(shellQuote('a b')).toBe(`'a b'`)
    expect(shellQuote('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`)
    expect(shellQuote('')).toBe(`''`)
  })
})
