import { Context, Effect, Layer, Option, Redacted } from 'effect'
import { readHiddenLine, type PassphraseError } from './passphrase.ts'

/**
 * Values the operator pastes during a run (for example credentials that only a provider console
 * shows). Read hidden from the controlling terminal, like the passphrase; `None` when there is no
 * terminal or the operator leaves the value empty.
 */
export interface SecretInputShape {
  readonly read: (
    message: string
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, PassphraseError>
}

export class SecretInput extends Context.Service<SecretInput, SecretInputShape>()(
  'provision/factory/SecretInput'
) {}

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true

export const SecretInputLive = Layer.succeed(
  SecretInput,
  SecretInput.of({
    read: message =>
      interactive()
        ? readHiddenLine(message).pipe(
            Effect.map(value => {
              const trimmed = Redacted.value(value).trim()

              return trimmed === '' ? Option.none() : Option.some(Redacted.make(trimmed))
            })
          )
        : Effect.succeed(Option.none())
  })
)
