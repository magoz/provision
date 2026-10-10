import { Context, Effect, Layer, Option, Redacted } from 'effect'
import { readHiddenLines, type PassphraseError } from './passphrase.ts'

/** One `KEY=value` line of a `.env` block (optionally `export`ed, value optionally quoted). */
export const parseEnvLine = (line: string) => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)

  if (match === null) return undefined

  const [, key = '', raw = ''] = match
  const quoted = /^(["'])(.*)\1$/.exec(raw)

  return { key, value: quoted?.[2] ?? raw }
}

/** The values for `keys` found in `lines`; later lines win. */
export const parseEnvBlock = (lines: ReadonlyArray<string>, keys: ReadonlyArray<string>) => {
  const values = new Map<string, Redacted.Redacted<string>>()

  for (const line of lines) {
    const parsed = parseEnvLine(line)

    if (parsed !== undefined && keys.includes(parsed.key) && parsed.value !== '') {
      values.set(parsed.key, Redacted.make(parsed.value))
    }
  }

  return values
}

/**
 * Credentials the operator pastes during a run, as a `.env` block copied from a provider console
 * (for example QStash's Quickstart). Read hidden from the controlling terminal, like the
 * passphrase; `None` when there is no terminal or the operator presses Enter on an empty line.
 */
export interface SecretInputShape {
  readonly readEnv: (
    message: string,
    keys: ReadonlyArray<string>
  ) => Effect.Effect<Option.Option<ReadonlyMap<string, Redacted.Redacted<string>>>, PassphraseError>
}

export class SecretInput extends Context.Service<SecretInput, SecretInputShape>()(
  'provision/factory/SecretInput'
) {}

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true

export const SecretInputLive = Layer.succeed(
  SecretInput,
  SecretInput.of({
    readEnv: (message, keys) =>
      interactive()
        ? readHiddenLines(message, {
            complete: lines => parseEnvBlock(lines, keys).size === keys.length,
            note: line => {
              const parsed = parseEnvLine(line)

              return parsed !== undefined && keys.includes(parsed.key)
                ? `  ✓ ${parsed.key}`
                : line.trim() === ''
                  ? undefined
                  : '  · ignored a line that is not one of the expected variables'
            }
          }).pipe(
            Effect.map(lines => {
              const values = parseEnvBlock(
                lines.map(line => Redacted.value(line)),
                keys
              )

              return values.size === 0 ? Option.none() : Option.some(values)
            })
          )
        : Effect.succeed(Option.none())
  })
)
