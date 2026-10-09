import { Effect, Redacted } from 'effect'
import { readPrivately, writePrivately } from './private-file.ts'

/** Parses `KEY=value` lines; blank lines and comments are skipped, matching quotes are removed. */
export const parseEnvFile = (content: string): ReadonlyMap<string, string> => {
  const entries = new Map<string, string>()

  for (const raw of content.split('\n')) {
    const line = raw.trim()

    if (line.length === 0 || line.startsWith('#')) continue
    const index = line.indexOf('=')

    if (index <= 0) continue
    let value = line.slice(index + 1).trim()

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }

    entries.set(line.slice(0, index).trim(), value)
  }

  return entries
}

export const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

const declares = (line: string, key: string) => line.startsWith(`${key}=`)

const readLines = (file: string) =>
  readPrivately(file).pipe(
    Effect.map(content => (content === undefined ? [] : content.split('\n')))
  )

/** Whether `file` exists and declares every key. */
export const hasEnvKeys = (file: string, keys: ReadonlyArray<string>) =>
  readPrivately(file).pipe(
    Effect.map(content => {
      if (content === undefined) return false
      const lines = content.split('\n')

      return keys.every(key => lines.some(line => declares(line, key)))
    })
  )

/**
 * Replaces `keys` in `file`, keeping every other line. The only place redacted values are
 * unwrapped for writing.
 */
export const writeEnvKeys = (
  file: string,
  values: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>
) =>
  Effect.gen(function* () {
    const existing = yield* readLines(file)
    const keys = values.map(([key]) => key)
    const kept = existing.filter(line => !keys.some(key => declares(line, key)))

    while (kept.at(-1)?.trim() === '') kept.pop()
    const rendered = values.map(([key, value]) => `${key}=${Redacted.value(value)}`)
    yield* writePrivately(file, `${[...kept, ...rendered].join('\n')}\n`)
  })

/** Removes `keys` from `file`; a missing file is left alone. */
export const removeEnvKeys = (file: string, keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const content = yield* readPrivately(file)

    if (content === undefined) return
    const kept = content.split('\n').filter(line => !keys.some(key => declares(line, key)))
    const body = kept.join('\n').trimEnd()
    yield* writePrivately(file, body.length > 0 ? `${body}\n` : '')
  })
