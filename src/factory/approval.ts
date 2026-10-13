import { Console, Effect } from 'effect'
import { detectAgent } from '../shared/agent.ts'

const shellSafe = /^[\w/.,:=@%+-]+$/

export const shellQuote = (value: string) =>
  shellSafe.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

export interface ApprovalRequired {
  readonly status: 'approval_required'
  readonly reason: string
  readonly hint: string
  /** Commands for the human to run, verbatim, in their own terminal. */
  readonly next: ReadonlyArray<string>
}

export const approvalRequired = (input: {
  readonly agent: string
  readonly cwd: string
  readonly args: ReadonlyArray<string>
}): ApprovalRequired => ({
  status: 'approval_required',
  reason: `this command reads factory admin keys and needs the provision passphrase, typed by a human in a terminal; ${input.agent} cannot approve it`,
  hint: 'ask the human to run the next command in their own terminal and paste its output; never ask for the passphrase',
  next: [`cd ${shellQuote(input.cwd)} && ${['provision', ...input.args].map(shellQuote).join(' ')}`]
})

/**
 * Runs `effect` only for humans. Under a detected agent it changes nothing and prints, as JSON on
 * stderr, the exact command for the human to run instead (exit 4).
 */
export const humanOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const agent = detectAgent()

    if (agent === undefined) return effect

    const payload = approvalRequired({ agent, cwd: process.cwd(), args: process.argv.slice(2) })

    return Console.error(JSON.stringify(payload)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 4
        })
      )
    )
  })
