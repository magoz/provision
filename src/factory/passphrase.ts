import { closeSync, openSync, writeSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { Context, Data, Effect, Layer, Redacted } from 'effect'

/**
 * The provision passphrase: the human approval for every run that reads factory credentials.
 * It is read from the controlling terminal only, never from arguments, environment, or stdin, and
 * only when this process is attached to a terminal, so agent-launched commands cannot be
 * answered by the agent. One prompt per process; the value stays in memory for that run only.
 */

export class PassphraseError extends Data.TaggedError('PassphraseError')<{
  readonly message: string
}> {}

export interface PassphraseShape {
  /** The passphrase protecting stored factory tokens (prompted once per process). */
  readonly get: Effect.Effect<Redacted.Redacted<string>, PassphraseError>
  /** Chooses a new passphrase: asked twice, at least `minimumPassphraseLength` characters. */
  readonly choose: Effect.Effect<Redacted.Redacted<string>, PassphraseError>
}

export class Passphrase extends Context.Service<Passphrase, PassphraseShape>()(
  'provision/factory/Passphrase'
) {}

export const minimumPassphraseLength = 12

const notInteractive = () =>
  new PassphraseError({
    message:
      'this needs your provision passphrase: run the command yourself in a terminal (agents cannot approve it)'
  })

/**
 * Reads hidden input from `/dev/tty`, line by line, until `next` says a line ends it. Lines may
 * arrive in one pasted chunk; CR, LF, and CRLF all end a line. Ctrl-C, or Ctrl-D on an empty
 * line, cancels. `next` can print a confirmation (never the value) after each line.
 */
const readHidden = (
  message: string,
  next: (lines: ReadonlyArray<string>) => { readonly done: boolean; readonly note?: string }
) =>
  Effect.callback<ReadonlyArray<Redacted.Redacted<string>>, PassphraseError>(resume => {
    if (process.stdin.isTTY !== true && process.stdout.isTTY !== true) {
      resume(Effect.fail(notInteractive()))

      return
    }

    let readFd: number
    let writeFd: number

    try {
      readFd = openSync('/dev/tty', 'r')
      writeFd = openSync('/dev/tty', 'w')
    } catch {
      resume(Effect.fail(notInteractive()))

      return
    }

    const input = new ReadStream(readFd)
    const lines: Array<string> = []
    let characters: Array<string> = []
    let afterCarriageReturn = false
    let finished = false
    const write = (text: string) => {
      try {
        const buffer = Buffer.from(text)
        let offset = 0

        while (offset < buffer.length) {
          offset += writeSync(writeFd, buffer, offset)
        }
      } catch {
        // The prompt is cosmetic; reading still works.
      }
    }

    const finish = (outcome: 'done' | 'cancelled') => {
      finished = true
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.destroy()
      write('\n')
      closeSync(writeFd)
      resume(
        outcome === 'done'
          ? Effect.succeed(lines.map(line => Redacted.make(line)))
          : Effect.fail(new PassphraseError({ message: 'cancelled' }))
      )
    }

    const endLine = () => {
      lines.push(characters.join(''))
      characters = []

      const { done, note } = next(lines)

      if (note !== undefined) write(`\n${note}`)
      if (done) finish('done')
    }

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (finished) return

        const wasCarriageReturn = afterCarriageReturn
        afterCarriageReturn = character === '\r'

        if (character === '\n' && wasCarriageReturn) continue
        if (character === '\r' || character === '\n') {
          endLine()
          continue
        }

        if (character === '\u0003' || (character === '\u0004' && characters.length === 0)) {
          return finish('cancelled')
        }

        if (character === '\u007f' || character === '\b') characters.pop()
        else if (character >= ' ') characters.push(character)
      }
    }

    write(message)
    input.setRawMode(true)
    input.on('data', onData)

    return Effect.sync(() => {
      if (finished) return
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.destroy()
      closeSync(writeFd)
    })
  })

/** Reads one hidden line from `/dev/tty`. Ctrl-C or Ctrl-D cancels. */
export const readHiddenLine = (message: string) =>
  readHidden(message, () => ({ done: true })).pipe(
    Effect.map(lines => lines[0] ?? Redacted.make(''))
  )

/**
 * Reads hidden lines until an empty line or until `complete` accepts them, so a pasted block
 * arrives in one go; `note` confirms each line without echoing it.
 */
export const readHiddenLines = (
  message: string,
  options: {
    readonly complete: (lines: ReadonlyArray<string>) => boolean
    readonly note: (line: string) => string | undefined
  }
) =>
  readHidden(message, lines => {
    const last = lines.at(-1) ?? ''
    const note = options.note(last)

    const done = last.trim() === '' || options.complete(lines)

    return note === undefined ? { done } : { done, note }
  }).pipe(Effect.map(lines => lines.filter(line => Redacted.value(line).trim() !== '')))

export const makePassphrase = (read: (message: string) => ReturnType<typeof readHiddenLine>) => {
  let cached: Redacted.Redacted<string> | undefined

  const remember = (value: Redacted.Redacted<string>) =>
    Effect.sync(() => {
      cached = value

      return value
    })

  return Passphrase.of({
    get: Effect.suspend(() =>
      cached === undefined
        ? read('provision passphrase: ').pipe(Effect.flatMap(remember))
        : Effect.succeed(cached)
    ),
    choose: Effect.gen(function* () {
      const first = yield* read('new provision passphrase: ')

      if (Redacted.value(first).length < minimumPassphraseLength) {
        return yield* new PassphraseError({
          message: `the passphrase needs at least ${minimumPassphraseLength} characters`
        })
      }

      const second = yield* read('repeat the passphrase: ')

      if (Redacted.value(first) !== Redacted.value(second)) {
        return yield* new PassphraseError({ message: 'the passphrases do not match' })
      }

      return yield* remember(first)
    })
  })
}

export const PassphraseLive = Layer.sync(Passphrase, () => makePassphrase(readHiddenLine))
