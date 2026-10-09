import { Console, Effect, Option } from 'effect'
import { decide, factoryError, mutate, type FactoryContext } from './context.ts'

export interface ScopedKey<E, R> {
  /** Human description, e.g. `Resend key acme-app-dev`. */
  readonly description: string
  /** The provider key's id when one with the deterministic name exists. */
  readonly existing: Option.Option<string>
  /** Whether Vercel already holds every record derived from the key. */
  readonly vercelComplete: boolean
  /** Creates a key and writes its Vercel records. */
  readonly createAndWrite: Effect.Effect<void, E, R>
  /** Deletes a provider key by id. */
  readonly remove: (id: string) => Effect.Effect<void, E, R>
}

/**
 * Ensures one scoped key per environment group:
 * - none exists: create it and write Vercel;
 * - it exists and Vercel is complete: reuse, or rotate on overwrite;
 * - it exists but Vercel is incomplete: the value cannot be recovered, so only rotation fixes it.
 *
 * Rotation creates the new key and writes Vercel before deleting the old key.
 */
export const ensureScopedKey = <E, R>(context: FactoryContext, key: ScopedKey<E, R>) =>
  Effect.gen(function* () {
    if (Option.isNone(key.existing)) {
      yield* mutate(context, `create ${key.description}`, key.createAndWrite)

      return
    }

    const description = key.vercelComplete
      ? key.description
      : `${key.description} (its value is missing from Vercel and cannot be recovered)`

    const decision = yield* decide(context, 'key', description)

    if (decision === 'reuse') {
      if (!key.vercelComplete && !context.dryRun) {
        return yield* factoryError(
          `${key.description} cannot be reused because Vercel lacks its value; rerun with --on-existing=overwrite to rotate it`
        )
      }

      yield* Console.log(`  reusing ${key.description}`)

      return
    }

    const previous = key.existing.value
    yield* mutate(context, `rotate ${key.description}`, key.createAndWrite)
    yield* mutate(context, `delete the previous ${key.description}`, key.remove(previous))
  })
