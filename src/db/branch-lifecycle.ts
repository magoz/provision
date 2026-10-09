import { Cause, Effect, Exit } from 'effect'
import { LifecycleError } from './domain.ts'

/**
 * Transfers ownership from an uninterruptible acquisition to an interruptible use phase. Every
 * unsuccessful use exit runs cleanup uninterruptibly before the original cause is replayed.
 */
export const withBranchLifecycleUsing = <A, B, EAcquire, EUse, ECleanup, RAcquire, RUse, RCleanup>(
  acquire: Effect.Effect<A, EAcquire, RAcquire>,
  use: (acquired: A) => Effect.Effect<B, EUse, RUse>,
  cleanup: (acquired: A) => Effect.Effect<void, ECleanup, RCleanup>
) =>
  Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      const acquisitionExit = yield* Effect.exit(acquire)

      if (Exit.isFailure(acquisitionExit)) return yield* Effect.failCause(acquisitionExit.cause)

      const operationExit = yield* Effect.exit(restore(use(acquisitionExit.value)))

      if (Exit.isSuccess(operationExit)) return operationExit.value

      const cleanupExit = yield* Effect.exit(cleanup(acquisitionExit.value))

      if (
        Exit.isFailure(cleanupExit) &&
        !Cause.hasInterrupts(operationExit.cause) &&
        !Cause.hasDies(operationExit.cause)
      ) {
        return yield* new LifecycleError({
          message:
            'new branch setup failed and cleanup could not be fully verified; manual review is required'
        })
      }

      return yield* Effect.failCause(operationExit.cause)
    })
  )
