import { Context, Data, Effect, Layer, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

export interface CapturedProcess {
  readonly exitCode: number
  readonly stdout: string
  /** Captured for diagnosis by the caller; never printed by this module. */
  readonly stderr: string
}

export class ProcessError extends Data.TaggedError('ProcessError')<{
  readonly command: string
  readonly exitCode: number | undefined
}> {
  override get message() {
    return this.exitCode === undefined
      ? `${this.command}: could not be started`
      : `${this.command}: exited with ${this.exitCode}`
  }
}

export interface ProcessOptions {
  readonly cwd?: string
  /** Written to stdin (capture only); keeps secrets and request bodies out of argv. */
  readonly input?: string
  /** Extra variables for this child only (secrets never enter our own environment or argv). */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The only way this tool runs other programs. Tests replace it to script external tools while
 * delegating `git` to the real implementation.
 */
export interface ProcessRunnerShape {
  /**
   * Runs to completion and captures stdout and stderr without printing either, so tool
   * diagnostics (which may contain secrets) never reach our output. A non-zero exit is data, not
   * a failure.
   */
  readonly capture: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ProcessOptions
  ) => Effect.Effect<CapturedProcess, ProcessError>
  /** Runs attached to the terminal; a non-zero exit fails. Arguments are never echoed. */
  readonly inherit: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ProcessOptions
  ) => Effect.Effect<void, ProcessError>
}

export class ProcessRunner extends Context.Service<ProcessRunner, ProcessRunnerShape>()(
  'provision/ProcessRunner'
) {}

const notStarted = (command: string) => () => new ProcessError({ command, exitCode: undefined })

export const makeProcessRunner = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  return ProcessRunner.of({
    capture: (command, args, options = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: options.cwd,
              ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
              stdin:
                options.input === undefined
                  ? 'ignore'
                  : Stream.make(new TextEncoder().encode(options.input)),
              stdout: 'pipe',
              stderr: 'pipe'
            })
          )

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode
            ],
            { concurrency: 3 }
          )

          return { exitCode, stdout, stderr } satisfies CapturedProcess
        })
      ).pipe(Effect.mapError(notStarted(command))),
    inherit: (command, args, options = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: options.cwd,
              ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
              stdin: 'inherit',
              stdout: 'inherit',
              stderr: 'inherit'
            })
          )

          return yield* handle.exitCode
        })
      ).pipe(
        Effect.mapError(notStarted(command)),
        Effect.flatMap(exitCode =>
          exitCode === 0 ? Effect.void : Effect.fail(new ProcessError({ command, exitCode }))
        )
      )
  })
})

export const ProcessRunnerLive = Layer.effect(ProcessRunner, makeProcessRunner)

export const capture = (command: string, args: ReadonlyArray<string>, options?: ProcessOptions) =>
  Effect.gen(function* () {
    return yield* (yield* ProcessRunner).capture(command, args, options)
  })

export const inherit = (command: string, args: ReadonlyArray<string>, options?: ProcessOptions) =>
  Effect.gen(function* () {
    return yield* (yield* ProcessRunner).inherit(command, args, options)
  })
