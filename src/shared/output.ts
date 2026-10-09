import { Console } from 'effect'

export type ReportValue = string | number | boolean

/** Prints a flat report: pretty JSON with `--json`, otherwise aligned `key  value` lines. */
export const report = (json: boolean, payload: Readonly<Record<string, ReportValue>>) => {
  if (json) return Console.log(JSON.stringify(payload, null, 2))
  const width = Math.max(0, ...Object.keys(payload).map(key => key.length))

  return Console.log(
    Object.entries(payload)
      .map(([key, value]) => `${key.padEnd(width)}  ${String(value)}`)
      .join('\n')
  )
}
