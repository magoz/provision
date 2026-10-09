import { NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import {
  makeProcessRunner,
  ProcessError,
  ProcessRunner,
  type CapturedProcess,
  type ProcessOptions
} from '../shared/process.ts'

/** A scripted answer; omitted output fields default to empty. */
export type ScriptResult = Partial<CapturedProcess>

export interface Invocation {
  readonly mode: 'capture' | 'inherit'
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly input: string | undefined
}

/**
 * Scripts external tools for tests. `git` always runs for real; every other command is recorded
 * and answered by `script`, which returns captured output (or `undefined` for empty success).
 * Throwing from `script` fails the invocation with a non-zero exit.
 */
export const scriptedProcessLayer = (
  script: (
    invocation: Invocation
  ) => Effect.Effect<ScriptResult | undefined> | ScriptResult | undefined,
  invocations: Array<Invocation>
) => {
  const answer = (invocation: Invocation) => {
    invocations.push(invocation)

    return Effect.suspend(() => {
      const result = script(invocation)

      return Effect.isEffect(result) ? result : Effect.succeed(result)
    }).pipe(
      Effect.map((result): CapturedProcess => ({ exitCode: 0, stdout: '', stderr: '', ...result })),
      Effect.catchDefect(() => Effect.succeed({ exitCode: 1, stdout: '', stderr: '' }))
    )
  }

  const run = (
    mode: Invocation['mode'],
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessOptions = {}
  ) => answer({ mode, command, args, cwd: options.cwd, input: options.input })

  return Layer.effect(
    ProcessRunner,
    Effect.gen(function* () {
      const live = yield* makeProcessRunner

      return ProcessRunner.of({
        capture: (command, args, options) =>
          command === 'git'
            ? live.capture(command, args, options)
            : run('capture', command, args, options),
        inherit: (command, args, options) =>
          command === 'git'
            ? live.inherit(command, args, options)
            : run('inherit', command, args, options).pipe(
                Effect.flatMap(result =>
                  result.exitCode === 0
                    ? Effect.void
                    : Effect.fail(new ProcessError({ command, exitCode: result.exitCode }))
                )
              )
      })
    })
  ).pipe(Layer.provideMerge(NodeServices.layer))
}
