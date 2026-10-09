import { Console, Effect, Option, Redacted } from 'effect'
import {
  decide,
  envGroups,
  factoryError,
  groupHasKeys,
  mutate,
  requireProject,
  writeGroup,
  type EnvGroup,
  type FactoryContext,
  type ProjectHandle
} from '../context.ts'
import {
  bucketCorsMatches,
  bucketExists,
  createBucket,
  createBucketToken,
  deleteToken,
  findToken,
  putBucketCors,
  r2Endpoint,
  type CloudflareAdmin
} from '../providers/cloudflare.ts'
import { ensureScopedKey } from '../scoped-key.ts'
import { listEnvRecords, type EnvRecord } from '../vercel-api.ts'

export const r2VariableKeys = [
  'R2_API_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME'
] as const

interface BucketTarget {
  readonly bucket: string
  readonly origin: string
  readonly group: EnvGroup
  readonly secretType: 'encrypted' | 'sensitive'
}

const ensureBucket = (
  context: FactoryContext,
  admin: CloudflareAdmin,
  handle: ProjectHandle,
  records: ReadonlyArray<EnvRecord>,
  target: BucketTarget
) =>
  Effect.gen(function* () {
    if (yield* bucketExists(admin, target.bucket)) {
      yield* decide(context, 'data', `R2 bucket ${target.bucket}`)
    } else {
      yield* mutate(
        context,
        `create private R2 bucket ${target.bucket}`,
        createBucket(admin, target.bucket)
      )
    }

    if (!(yield* bucketCorsMatches(admin, target.bucket, target.origin))) {
      yield* mutate(
        context,
        `set ${target.bucket} CORS to PUT from ${target.origin}`,
        putBucketCors(admin, target.bucket, target.origin)
      )
    }

    const tokenName = `${target.bucket}-app-rw`

    yield* ensureScopedKey(context, {
      description: `R2 token ${tokenName}`,
      existing: yield* findToken(admin, tokenName),
      vercelComplete: groupHasKeys(records, target.group, r2VariableKeys),
      createAndWrite: Effect.gen(function* () {
        const token = yield* createBucketToken(admin, tokenName, target.bucket)
        const [url, accessKey, secretKey, bucketName] = r2VariableKeys

        yield* writeGroup(context, handle, target.group, [
          { key: url, value: Redacted.make(r2Endpoint(admin.accountId)), type: 'encrypted' },
          { key: accessKey, value: Redacted.make(token.accessKeyId), type: target.secretType },
          { key: secretKey, value: token.secretAccessKey, type: target.secretType },
          { key: bucketName, value: Redacted.make(target.bucket), type: 'encrypted' }
        ]).pipe(Effect.tapError(() => deleteToken(admin, token.id).pipe(Effect.ignore)))
      }),
      remove: id => deleteToken(admin, id)
    })
  })

/**
 * Private `<repo>-dev` and `<repo>-prod` buckets with upload CORS (`*` for development, the exact
 * production origin for production) and one bucket-scoped object read/write token each.
 */
export const r2Step = (context: FactoryContext) =>
  Effect.gen(function* () {
    const admin = context.credentials.cloudflare

    if (admin === undefined)
      return yield* factoryError('the factory item has no cloudflare section')

    if (context.domain === undefined) {
      return yield* factoryError('the r2 step needs --domain for the production CORS origin')
    }

    const handle = yield* requireProject(context)

    if (Option.isNone(handle)) {
      yield* Console.log('  would run after the vercel step creates the project')

      return
    }

    const groups = envGroups(handle.value)
    const records = yield* listEnvRecords(
      context.credentials.vercel.teamId,
      handle.value.project.id
    )

    yield* ensureBucket(context, admin, handle.value, records, {
      bucket: context.names.development,
      origin: '*',
      group: groups.preproduction,
      secretType: 'encrypted'
    })

    yield* ensureBucket(context, admin, handle.value, records, {
      bucket: context.names.production,
      origin: `https://${context.domain}`,
      group: groups.production,
      secretType: 'sensitive'
    })
  })
