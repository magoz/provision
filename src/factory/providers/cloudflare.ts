import { createHash } from 'node:crypto'
import { Effect, Option, Redacted, Schema } from 'effect'
import { ProviderError, requestJson, requestJsonRequired } from '../http.ts'

const API_ROOT = 'https://api.cloudflare.com/client/v4'

export interface CloudflareAdmin {
  readonly apiToken: Redacted.Redacted<string>
  readonly accountId: string
}

const headers = (token: Redacted.Redacted<string>) => ({
  Authorization: `Bearer ${Redacted.value(token)}`
})

const envelope = <S extends Schema.Constraint>(result: S) =>
  Schema.Struct({ success: Schema.Literal(true), result })

const account = (admin: CloudflareAdmin) =>
  `${API_ROOT}/accounts/${encodeURIComponent(admin.accountId)}`

export const r2Endpoint = (accountId: string) => `https://${accountId}.r2.cloudflarestorage.com`

// ---------------------------------------------------------------------------
// buckets
// ---------------------------------------------------------------------------

export const bucketExists = (admin: CloudflareAdmin, name: string) =>
  requestJson(
    'R2 bucket lookup',
    `${account(admin)}/r2/buckets/${encodeURIComponent(name)}`,
    envelope(Schema.Struct({ name: Schema.String })),
    { headers: headers(admin.apiToken), allowNotFound: true }
  ).pipe(Effect.map(Option.isSome))

export const createBucket = (admin: CloudflareAdmin, name: string) =>
  requestJsonRequired(
    'R2 bucket creation',
    `${account(admin)}/r2/buckets`,
    envelope(Schema.Struct({ name: Schema.String })),
    { method: 'POST', headers: headers(admin.apiToken), body: { name } }
  ).pipe(Effect.asVoid)

/**
 * Browser uploads use presigned PUTs; CORS allows exactly that, with the headers a signed upload
 * binds (`content-type`, and `if-none-match` for create-only uploads).
 */
const corsRules = (origin: string) => [
  {
    id: 'browser-uploads',
    allowed: { methods: ['PUT'], origins: [origin], headers: ['content-type', 'if-none-match'] },
    exposeHeaders: ['etag'],
    maxAgeSeconds: 3600
  }
]

const CorsRule = Schema.Struct({
  allowed: Schema.Struct({
    methods: Schema.Array(Schema.String),
    origins: Schema.Array(Schema.String),
    headers: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  exposeHeaders: Schema.optionalKey(Schema.Array(Schema.String)),
  maxAgeSeconds: Schema.optionalKey(Schema.Number)
})

type CorsRule = typeof CorsRule.Type

const normalize = (values: ReadonlyArray<string>) =>
  [...new Set(values.map(value => value.toLowerCase()))].toSorted().join('\n')

const sameSet = (left: ReadonlyArray<string> = [], right: ReadonlyArray<string> = []) =>
  normalize(left) === normalize(right)

/**
 * Whether `rules` grant exactly the upload policy for `origin`. Compares values, not JSON text:
 * the API may reorder fields, drop the rule id, or change header case.
 */
export const corsRulesMatch = (rules: ReadonlyArray<CorsRule>, origin: string) => {
  const [actual, ...rest] = rules
  const [expected] = corsRules(origin)

  return (
    actual !== undefined &&
    expected !== undefined &&
    rest.length === 0 &&
    sameSet(actual.allowed.methods, expected.allowed.methods) &&
    sameSet(actual.allowed.origins, expected.allowed.origins) &&
    sameSet(actual.allowed.headers, expected.allowed.headers) &&
    sameSet(actual.exposeHeaders, expected.exposeHeaders) &&
    actual.maxAgeSeconds === expected.maxAgeSeconds
  )
}

/** Whether the bucket already has exactly the upload CORS policy for `origin`. */
export const bucketCorsMatches = (admin: CloudflareAdmin, name: string, origin: string) =>
  requestJson(
    'R2 CORS lookup',
    `${account(admin)}/r2/buckets/${encodeURIComponent(name)}/cors`,
    envelope(Schema.Struct({ rules: Schema.Array(CorsRule) })),
    { headers: headers(admin.apiToken), allowNotFound: true }
  ).pipe(
    Effect.map(
      Option.match({
        onNone: () => false,
        onSome: response => corsRulesMatch(response.result.rules, origin)
      })
    )
  )

export const putBucketCors = (admin: CloudflareAdmin, name: string, origin: string) =>
  requestJsonRequired(
    'R2 CORS update',
    `${account(admin)}/r2/buckets/${encodeURIComponent(name)}/cors`,
    Schema.Struct({ success: Schema.Literal(true) }),
    {
      method: 'PUT',
      headers: headers(admin.apiToken),
      body: { rules: corsRules(origin) }
    }
  ).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// bucket-scoped account tokens
// ---------------------------------------------------------------------------

const permissionGroupNames = [
  'Workers R2 Storage Bucket Item Read',
  'Workers R2 Storage Bucket Item Write'
] as const

const bucketResource = (accountId: string, bucket: string) =>
  `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`

const Token = Schema.Struct({ id: Schema.String, name: Schema.String })

export const findToken = (admin: CloudflareAdmin, name: string) =>
  Effect.gen(function* () {
    const tokens: Array<typeof Token.Type> = []
    let page = 1
    let totalPages = 1

    do {
      const response = yield* requestJsonRequired(
        'Cloudflare token listing',
        `${account(admin)}/tokens?page=${page}&per_page=100`,
        Schema.Struct({
          success: Schema.Literal(true),
          result: Schema.Array(Token),
          result_info: Schema.Struct({ total_pages: Schema.Number })
        }),
        { headers: headers(admin.apiToken) }
      )
      tokens.push(...response.result)
      totalPages = response.result_info.total_pages
      page += 1
    } while (page <= totalPages)

    const matches = tokens.filter(token => token.name === name)

    if (matches.length > 1) {
      return yield* new ProviderError({ message: `several Cloudflare tokens are named ${name}` })
    }

    return Option.map(Option.fromUndefinedOr(matches[0]), token => token.id)
  })

const permissionGroupIds = (admin: CloudflareAdmin) =>
  requestJsonRequired(
    'Cloudflare permission groups',
    `${account(admin)}/tokens/permission_groups`,
    envelope(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
    { headers: headers(admin.apiToken) }
  ).pipe(
    Effect.flatMap(response =>
      Effect.forEach(permissionGroupNames, name => {
        const group = response.result.find(candidate => candidate.name === name)

        return group === undefined
          ? Effect.fail(
              new ProviderError({ message: `Cloudflare permission group ${name} is unavailable` })
            )
          : Effect.succeed(group.id)
      })
    )
  )

/**
 * Creates an object read/write token scoped to exactly one bucket. The S3 access key is the token
 * id; the secret is the SHA-256 of the one-time token value (Cloudflare's R2 token contract).
 */
export const createBucketToken = (admin: CloudflareAdmin, name: string, bucket: string) =>
  Effect.gen(function* () {
    const ids = yield* permissionGroupIds(admin)
    const created = yield* requestJsonRequired(
      'Cloudflare token creation',
      `${account(admin)}/tokens`,
      envelope(Schema.Struct({ id: Schema.String, value: Schema.String })),
      {
        method: 'POST',
        headers: headers(admin.apiToken),
        body: {
          name,
          policies: [
            {
              effect: 'allow',
              permission_groups: ids.map(id => ({ id })),
              resources: { [bucketResource(admin.accountId, bucket)]: '*' }
            }
          ]
        }
      }
    )

    const value = Redacted.make(created.result.value)

    // Verify the new token authenticates before anything depends on it.
    yield* requestJsonRequired(
      'Cloudflare token verification',
      `${account(admin)}/tokens/verify`,
      envelope(Schema.Struct({ status: Schema.Literal('active') })),
      { headers: headers(value) }
    )

    return {
      id: created.result.id,
      accessKeyId: created.result.id,
      secretAccessKey: Redacted.make(
        createHash('sha256').update(Redacted.value(value)).digest('hex')
      )
    }
  })

export const deleteToken = (admin: CloudflareAdmin, tokenId: string) =>
  requestJson(
    'Cloudflare token deletion',
    `${account(admin)}/tokens/${encodeURIComponent(tokenId)}`,
    Schema.Unknown,
    { method: 'DELETE', headers: headers(admin.apiToken), allowNotFound: true }
  ).pipe(Effect.asVoid)
