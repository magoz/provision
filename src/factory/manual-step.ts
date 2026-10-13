import { Context, Data, Effect, Layer, Terminal } from 'effect'
import { Prompt } from 'effect/cli'

export class ManualStepError extends Data.TaggedError('ManualStepError')<{
  readonly message: string
}> {}

/**
 * Waits for the operator to finish something by hand (for example in a provider console), so the
 * run can check it and carry on instead of asking for a rerun. Shows the instructions straight on
 * the terminal, since step output is buffered until the step ends.
 */
export interface ManualStepShape {
  /** `true` once the operator says it is done; `false` when skipped or there is no terminal. */
  readonly confirm: (
    instructions: string,
    question: string
  ) => Effect.Effect<boolean, ManualStepError>
}

export class ManualStep extends Context.Service<ManualStep, ManualStepShape>()(
  'provision/factory/ManualStep'
) {}

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true

export const ManualStepLive = Layer.effect(
  ManualStep,
  Effect.gen(function* () {
    const services = yield* Effect.context<Prompt.Environment>()
    const terminal = yield* Terminal.Terminal

    return ManualStep.of({
      confirm: (instructions, question) =>
        interactive()
          ? terminal.display(`\n${instructions}\n`).pipe(
              Effect.andThen(Prompt.run(Prompt.Confirm({ message: question, initial: true }))),
              Effect.provideContext(services),
              Effect.mapError(() => new ManualStepError({ message: 'cancelled' }))
            )
          : Effect.succeed(false)
    })
  })
)
