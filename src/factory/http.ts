import { Data, Effect, Option, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

export class ProviderError extends Data.TaggedError('ProviderError')<{
  readonly message: string
  readonly status?: number
}> {}

export interface JsonRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: unknown
  /** Treat 404 as `None` instead of failing. */
  readonly allowNotFound?: boolean
}

const ErrorBody = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
  )
})

/**
 * The provider's own error message (`message`, `error.message`, or `errors[0].message`), cleaned
 * for display: one line, at most 160 characters, and any long token-like run (24+ characters
 * without spaces) replaced, so an echoed credential can never reach the output.
 */
export const providerErrorMessage = (body: unknown) =>
  Schema.decodeUnknownOption(ErrorBody)(body).pipe(
    Option.flatMap(parsed =>
      Option.fromUndefinedOr(parsed.message ?? parsed.error?.message ?? parsed.errors?.[0]?.message)
    ),
    Option.map(message =>
      message
        .split('')
        .map(character => (character < ' ' || character === '\u007f' ? ' ' : character))
        .join('')
        .replaceAll(/\s+/g, ' ')
        .replaceAll(/[^\s"'`]{24,}/g, '…')
        .trim()
        .slice(0, 160)
    ),
    Option.filter(message => message !== '')
  )

/**
 * A provider JSON request. Failures name the action, the status, and the provider's cleaned error
 * message; other response content, URLs with query strings, and credentials never reach errors or
 * output.
 */
export const requestJson = <S extends Schema.Constraint>(
  label: string,
  url: string,
  schema: S,
  options: JsonRequest
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const base = HttpClientRequest.make(options.method ?? 'GET')(url).pipe(
      HttpClientRequest.setHeaders({ Accept: 'application/json', ...options.headers })
    )

    const request =
      options.body === undefined
        ? base
        : yield* HttpClientRequest.bodyJson(base, options.body).pipe(
            Effect.mapError(() => new ProviderError({ message: `${label}: invalid request body` }))
          )

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new ProviderError({ message: `${label}: provider unreachable` })))

    if (options.allowNotFound === true && response.status === 404) {
      return Option.none<S['Type']>()
    }

    if (response.status >= 400) {
      const detail = yield* response.json.pipe(
        Effect.map(providerErrorMessage),
        Effect.orElseSucceed(() => Option.none<string>())
      )

      return yield* new ProviderError({
        message: `${label} failed (${response.status})${Option.match(detail, {
          onNone: () => '',
          onSome: message => `: ${message}`
        })}`,
        status: response.status
      })
    }

    if (response.status === 204) {
      return yield* Schema.decodeUnknownEffect(schema)(undefined).pipe(
        Effect.map(Option.some),
        Effect.mapError(
          () => new ProviderError({ message: `${label}: unexpected empty provider response` })
        )
      )
    }

    const json = yield* response.json.pipe(
      Effect.mapError(
        () => new ProviderError({ message: `${label}: provider returned invalid JSON` })
      )
    )

    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        () => new ProviderError({ message: `${label}: unexpected provider response shape` })
      )
    )
  })

/** `requestJson` for calls where 404 is an error: returns the decoded body. */
export const requestJsonRequired = <S extends Schema.Constraint>(
  label: string,
  url: string,
  schema: S,
  options: Omit<JsonRequest, 'allowNotFound'>
) =>
  requestJson(label, url, schema, options).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ProviderError({ message: `${label}: not found` })),
        onSome: Effect.succeed
      })
    )
  )
