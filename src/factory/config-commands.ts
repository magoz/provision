import { Console, Effect, Option } from 'effect'
import { Argument, Command, Flag, Prompt } from 'effect/cli'
import { report } from '../shared/output.ts'
import { decodeCredentials, describeSections, readItemFields } from './onepassword.ts'
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
const inspectFactory = (entry: FactoryEntry) =>
  Effect.gen(function* () {
    const fields = yield* readItemFields(entry)
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

        const entry: FactoryEntry = Option.match(options.account, {
          onNone: () => ({ vault, item }),
          onSome: account => ({ vault, item, account })
        })

        // Refuse to register an item that cannot be read or is incomplete.
        const inspected = yield* inspectFactory(entry)
        const registry = yield* readRegistry
        yield* writeRegistry({ factories: { ...registry.factories, [name]: entry } })

        yield* report(false, {
          status: name in registry.factories ? 'updated' : 'added',
          factory: name,
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
          inspectFactory(entry).pipe(
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
                ? `${result.factory}: ok (github ${result.githubOwner}, vercel ${result.vercelTeamId})\n` +
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

export const configCommand = Command.make('config', { json: jsonFlag }, ({ json }) =>
  handled(listFactories(json))
).pipe(
  Command.withDescription('Manage factories: which 1Password item holds each factory account set.'),
  Command.withSubcommands([add, list, remove, verify])
)
