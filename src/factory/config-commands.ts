import { Console, Effect, Option, Redacted } from 'effect'
import { Argument, Command, Flag, Prompt } from 'effect/cli'
import { report } from '../shared/output.ts'
import { decodeCredentials, describeSections, readItemFields } from './onepassword.ts'
import {
  opCredentialFile,
  parseServiceAccountToken,
  removeServiceAccountToken,
  resolveOpAuth,
  storeServiceAccountToken,
  type OpAuthSource
} from './op-credential.ts'
import {
  readRegistry,
  RegistryError,
  validateFactoryName,
  writeRegistry,
  type FactoryEntry
} from './registry.ts'

const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code
  })

const handled = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch(error =>
      Console.error(`provision config: ${error.message}`).pipe(Effect.andThen(setExitCode(2)))
    )
  )

const jsonFlag = Flag.Boolean('json').pipe(
  Flag.withDescription('machine-readable output'),
  Flag.withDefault(false)
)

/** Uses the flag value, or prompts when interactive; agents must pass every flag. */
const valueOrPrompt = (value: Option.Option<string>, message: string, fallback?: string) =>
  Option.isSome(value)
    ? Effect.succeed(value.value)
    : process.stdin.isTTY === true && process.stdout.isTTY === true
      ? Prompt.run(
          Prompt.String(fallback === undefined ? { message } : { message, default: fallback })
        ).pipe(Effect.mapError(() => new RegistryError({ message: 'cancelled' })))
      : fallback === undefined
        ? Effect.fail(new RegistryError({ message: `${message}: pass it as a flag` }))
        : Effect.succeed(fallback)

const listFactories = (json: boolean) =>
  Effect.gen(function* () {
    const registry = yield* readRegistry

    if (json) return yield* Console.log(JSON.stringify(registry, null, 2))

    const entries = Object.entries(registry.factories)

    if (entries.length === 0) {
      return yield* Console.log('no factories registered; run: provision config add')
    }

    yield* Console.log(
      entries
        .map(
          ([name, entry]) =>
            `${name}  vault=${entry.vault} item=${entry.item}${entry.account === undefined ? '' : ` account=${entry.account}`}`
        )
        .join('\n')
    )
  })

/** Reads the factory item and summarizes it without revealing any value. */
const inspectFactory = (entry: FactoryEntry, auth: OpAuthSource) =>
  Effect.gen(function* () {
    const fields = yield* readItemFields(entry, auth)
    const credentials = yield* decodeCredentials(fields)

    return {
      githubOwner: credentials.githubOwner,
      vercelTeamId: credentials.vercel.teamId,
      sections: describeSections(fields)
    }
  })

const add = Command.make(
  'add',
  {
    name: Flag.String('name').pipe(Flag.withDescription('factory name, e.g. acme'), Flag.optional),
    vault: Flag.String('vault').pipe(Flag.withDescription('1Password vault'), Flag.optional),
    item: Flag.String('item').pipe(
      Flag.withDescription('1Password item (default: provision)'),
      Flag.optional
    ),
    account: Flag.String('account').pipe(
      Flag.withDescription('1Password account (default: the CLI default)'),
      Flag.optional
    )
  },
  options =>
    handled(
      Effect.gen(function* () {
        const name = yield* valueOrPrompt(options.name, 'Factory name').pipe(
          Effect.flatMap(validateFactoryName)
        )
        const vault = yield* valueOrPrompt(options.vault, '1Password vault')
        const item = yield* valueOrPrompt(options.item, '1Password item', 'provision')

        const location: FactoryEntry = Option.match(options.account, {
          onNone: () => ({ vault, item }),
          onSome: account => ({ vault, item, account })
        })

        // Refuse to register an item that cannot be read or is incomplete.
        const auth = yield* resolveOpAuth(name)
        const inspected = yield* inspectFactory(location, auth)
        const registry = yield* readRegistry
        const entry: FactoryEntry = { ...location, githubOwner: inspected.githubOwner }
        yield* writeRegistry({ factories: { ...registry.factories, [name]: entry } })

        yield* report(false, {
          status: name in registry.factories ? 'updated' : 'added',
          factory: name,
          auth: describeAuth(auth),
          github_owner: inspected.githubOwner,
          vercel_team: inspected.vercelTeamId,
          sections: inspected.sections
            .filter(section => section.status === 'complete')
            .map(section => section.section)
            .join(', ')
        })
      })
    )
).pipe(Command.withDescription('Register a factory 1Password item (verified before saving).'))

const list = Command.make('list', { json: jsonFlag }, ({ json }) =>
  handled(listFactories(json))
).pipe(Command.withDescription('List registered factories.'))

const remove = Command.make(
  'remove',
  { name: Argument.String('name').pipe(Argument.withDescription('factory name')) },
  ({ name }) =>
    handled(
      Effect.gen(function* () {
        const registry = yield* readRegistry

        if (!(name in registry.factories)) {
          return yield* new RegistryError({ message: `no factory named ${name}` })
        }

        const { [name]: _removed, ...rest } = registry.factories
        yield* writeRegistry({ factories: rest })
        yield* Console.log(`removed factory ${name}`)
      })
    )
).pipe(Command.withDescription('Unregister a factory (the 1Password item is untouched).'))

const verify = Command.make(
  'verify',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription('factory name (default: all)'),
      Argument.optional
    ),
    json: jsonFlag
  },
  ({ json, name }) =>
    handled(
      Effect.gen(function* () {
        const registry = yield* readRegistry

        const selected = Object.entries(registry.factories).filter(([candidate]) =>
          Option.match(name, { onNone: () => true, onSome: wanted => wanted === candidate })
        )

        if (selected.length === 0) {
          return yield* new RegistryError({ message: 'no matching factory registered' })
        }

        const results = yield* Effect.forEach(selected, ([factory, entry]) =>
          Effect.gen(function* () {
            const auth = yield* resolveOpAuth(factory)
            const inspected = yield* inspectFactory(entry, auth)

            return { auth: describeAuth(auth), ...inspected }
          }).pipe(
            Effect.map(inspected => ({ factory, ok: true as const, ...inspected })),
            Effect.catch(error =>
              Effect.succeed({ factory, ok: false as const, error: error.message })
            )
          )
        )

        if (json) yield* Console.log(JSON.stringify(results, null, 2))
        else {
          for (const result of results) {
            yield* Console.log(
              result.ok
                ? `${result.factory}: ok (github ${result.githubOwner}, vercel ${result.vercelTeamId}, auth ${result.auth})\n` +
                    result.sections
                      .map(
                        section =>
                          `  ${section.section.padEnd(16)} ${section.status}${section.missing.length > 0 && section.status === 'partial' ? ` (missing ${section.missing.join(', ')})` : ''}`
                      )
                      .join('\n')
                : `${result.factory}: ${result.error}`
            )
          }
        }

        if (results.some(result => !result.ok)) yield* setExitCode(1)
      })
    )
).pipe(Command.withDescription("Read each factory's 1Password item and report its sections."))

const describeAuth = (auth: OpAuthSource) =>
  auth.kind === 'environment'
    ? 'service account (OP_SERVICE_ACCOUNT_TOKEN)'
    : auth.kind === 'credential'
      ? `service account (${auth.file})`
      : 'op session or desktop app'

const readStdin = Effect.promise(async () => {
  const chunks: Array<Uint8Array> = []

  for await (const chunk of process.stdin) {
    if (chunk instanceof Uint8Array) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8')
})

const factoryFlag = Flag.String('factory').pipe(
  Flag.withDescription('factory the token belongs to (it may be registered afterwards)')
)

const opTokenSet = Command.make('set', { factory: factoryFlag }, ({ factory }) =>
  handled(
    Effect.gen(function* () {
      const name = yield* validateFactoryName(factory)
      const raw =
        process.stdin.isTTY === true
          ? yield* Prompt.run(
              Prompt.Password({ message: '1Password service-account token (input hidden)' })
            ).pipe(
              Effect.map(value => Redacted.value(value)),
              Effect.mapError(() => new RegistryError({ message: 'cancelled' }))
            )
          : yield* readStdin
      const token = yield* parseServiceAccountToken(raw)
      const file = yield* storeServiceAccountToken(name, token)

      yield* Console.log(`stored the ${name} service-account token encrypted at ${file}`)
    })
  )
).pipe(
  Command.withDescription(
    'Store a 1Password service-account token (stdin or hidden prompt), encrypted with systemd-creds.'
  )
)

const opTokenStatus = Command.make('status', {}, () =>
  handled(
    Effect.gen(function* () {
      const registry = yield* readRegistry
      const names = Object.keys(registry.factories)

      if (names.length === 0) return yield* Console.log('no factories registered')

      for (const name of names) {
        yield* Console.log(`${name}: ${describeAuth(yield* resolveOpAuth(name))}`)
      }
    })
  )
).pipe(Command.withDescription('Show how provision authenticates 1Password for each factory.'))

const opTokenRemove = Command.make('remove', { factory: factoryFlag }, ({ factory }) =>
  handled(
    Effect.gen(function* () {
      const name = yield* validateFactoryName(factory)
      const file = yield* opCredentialFile(name)
      const removed = yield* removeServiceAccountToken(name)
      yield* Console.log(removed ? `removed ${file}` : `no stored token at ${file}`)
    })
  )
).pipe(
  Command.withDescription(
    'Delete the stored token (revoke it in 1Password: Developer > Service accounts).'
  )
)

const opToken = Command.make('op-token').pipe(
  Command.withDescription("Manage each factory's 1Password service-account token."),
  Command.withSubcommands([opTokenSet, opTokenStatus, opTokenRemove])
)

export const configCommand = Command.make('config', { json: jsonFlag }, ({ json }) =>
  handled(listFactories(json))
).pipe(
  Command.withDescription('Manage factories: which 1Password item holds each factory account set.'),
  Command.withSubcommands([add, list, remove, verify, opToken])
)
