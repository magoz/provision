import { format } from 'node:util'
import { Console, Effect, Option, Result } from 'effect'
import { Command, Flag } from 'effect/cli'
import { resolveAppDirectory } from '../env/paths.ts'
import { resolveWorkspace } from '../shared/git.ts'
import { factorySteps, readRepoConfig, type FactoryStep } from '../shared/repo-config.ts'
import { humanOnly } from './approval.ts'
import {
  factoryError,
  onExistingPolicies,
  withTerminal,
  type FactoryContext,
  type OnExisting
} from './context.ts'
import { decodeCredentials, readItemFields, type FactoryCredentials } from './onepassword.ts'
import { resolveOpAuth } from './op-credential.ts'
import { readRegistry, type FactoryEntry, type Registry } from './registry.ts'
import { domainStep } from './steps/domain.ts'
import { neonStep } from './steps/neon.ts'
import { r2Step } from './steps/r2.ts'
import { reportsStep } from './steps/reports.ts'
import { resendStep } from './steps/resend.ts'
import { secretsStep } from './steps/secrets.ts'
import { upstashStep } from './steps/upstash.ts'
import { vercelStep } from './steps/vercel.ts'

const steps = {
  vercel: vercelStep,
  neon: neonStep,
  r2: r2Step,
  upstash: upstashStep,
  resend: resendStep,
  reports: reportsStep,
  secrets: secretsStep,
  domain: domainStep
} satisfies Record<FactoryStep, (context: FactoryContext) => Effect.Effect<void, unknown, unknown>>

/**
 * Runs one step with its output buffered and printed as one block when it ends, so concurrent
 * steps do not interleave. A failing step never interrupts the others mid-mutation.
 */
const runStep = (step: FactoryStep, context: FactoryContext) =>
  Effect.gen(function* () {
    const lines = [`\n[${step}]`]
    const console = yield* Console.Console
    const buffered: Console.Console = {
      ...console,
      log: (...args) => {
        lines.push(format(...args))
      }
    }
    yield* steps[step](context).pipe(
      Effect.provideService(Console.Console, buffered),
      Effect.tapError(error => Effect.sync(() => lines.push(`  failed: ${error.message}`))),
      // Waits while another step is prompting, so output never lands in the middle of a prompt.
      Effect.ensuring(Effect.suspend(() => withTerminal(Console.log(lines.join('\n')))))
    )
  })

const isFactoryStep = (value: string): value is FactoryStep =>
  factorySteps.some(step => step === value)

/** `--only` narrows the repository's steps; execution order is always the canonical order. */
export const selectSteps = (configured: ReadonlyArray<FactoryStep>, only: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(only)) return configured

    const requested = only.value
      .split(',')
      .map(step => step.trim())
      .filter(step => step.length > 0)
    const unknown = requested.filter(step => !isFactoryStep(step))

    if (unknown.length > 0 || requested.length === 0) {
      return yield* factoryError(
        `--only accepts ${factorySteps.join(', ')}${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}`
      )
    }

    const outside = requested.filter(step => !configured.some(candidate => candidate === step))

    if (outside.length > 0) {
      return yield* factoryError(
        `--only names steps this repository does not declare in provision.factory.steps: ${outside.join(', ')}`
      )
    }

    return configured.filter(step => requested.includes(step))
  })

/** Reads one factory's item with that factory's own credentials. */
const readFactory = (name: string, entry: FactoryEntry) =>
  resolveOpAuth(name).pipe(
    Effect.flatMap(auth => readItemFields(entry, auth)),
    Effect.flatMap(decodeCredentials),
    Effect.map(credentials => ({ name, credentials }))
  )

/**
 * The explicit factory, or the single registered factory for the checkout's GitHub owner. The
 * owner recorded by `config add` selects without reading any other factory's item; entries
 * without it fall back to reading their items.
 */
const selectFactory = (registry: Registry, requested: Option.Option<string>, owner: string) =>
  Effect.gen(function* () {
    const entries = Object.entries(registry.factories)

    if (entries.length === 0) {
      return yield* factoryError('no factories registered; run: provision config add')
    }

    if (Option.isSome(requested)) {
      const entry = registry.factories[requested.value]

      if (entry === undefined) {
        return yield* factoryError(`no factory named ${requested.value}`)
      }

      return yield* readFactory(requested.value, entry)
    }

    const recorded = entries.filter(([, entry]) => entry.githubOwner === owner)
    const unrecorded = entries.filter(([, entry]) => entry.githubOwner === undefined)
    const matches: Array<{ readonly name: string; readonly credentials: FactoryCredentials }> = []

    for (const [name, entry] of recorded) matches.push(yield* readFactory(name, entry))

    if (matches.length === 0) {
      for (const [name, entry] of unrecorded) {
        const factory = yield* readFactory(name, entry)

        if (factory.credentials.githubOwner === owner) matches.push(factory)
      }
    }

    const match = matches.length === 1 ? matches[0] : undefined

    if (match === undefined) {
      return yield* factoryError(
        matches.length === 0
          ? `no registered factory has github.owner ${owner}; pass --factory`
          : `several factories have github.owner ${owner}; pass --factory`
      )
    }

    return match
  })

interface FactoryOptions {
  readonly checkout: string
  readonly domain: Option.Option<string>
  readonly senderName: Option.Option<string>
  readonly emailFrom: Option.Option<string>
  readonly factory: Option.Option<string>
  readonly only: Option.Option<string>
  readonly onExisting: OnExisting
  readonly neonParentBranch: Option.Option<string>
  readonly dryRun: boolean
}

const domainPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const runFactory = (options: FactoryOptions) =>
  Effect.gen(function* () {
    const workspace = yield* resolveWorkspace(Option.some(options.checkout))
    const [owner, name] = workspace.repository.split('/')

    if (owner === undefined || name === undefined || name === '') {
      return yield* factoryError('the checkout needs a GitHub origin remote (owner/repository)')
    }

    const repoConfig = yield* readRepoConfig(workspace.root)
    const selected = yield* selectSteps(repoConfig.factory.steps, options.only)
    const domain = Option.getOrUndefined(options.domain)?.toLowerCase()

    if (domain !== undefined && !domainPattern.test(domain)) {
      return yield* factoryError(`--domain must be a host name such as app.example.com`)
    }

    const needsDomain = selected.filter(step => step === 'r2' || step === 'domain')

    if (domain === undefined && needsDomain.length > 0) {
      return yield* factoryError(`--domain is required for ${needsDomain.join(', ')}`)
    }

    const emailFrom = Option.getOrUndefined(options.emailFrom)?.trim().toLowerCase()

    if (emailFrom !== undefined && !/^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(emailFrom)) {
      return yield* factoryError('--email-from must be an address such as noreply@acme.com')
    }

    const factory = yield* selectFactory(yield* readRegistry, options.factory, owner)

    if (factory.credentials.githubOwner !== owner) {
      return yield* factoryError(
        `factory ${factory.name} serves GitHub owner ${factory.credentials.githubOwner}, not ${owner}`
      )
    }

    const app = yield* resolveAppDirectory(workspace.root, repoConfig.appDir)

    const context: FactoryContext = {
      factory: factory.name,
      credentials: factory.credentials,
      checkout: { root: workspace.root, owner, name, repository: workspace.repository },
      repoConfig,
      appDirectory: app.directory,
      domain,
      senderName: Option.getOrElse(options.senderName, () => name),
      emailFrom,
      neonParentBranch: Option.getOrUndefined(options.neonParentBranch),
      dryRun: options.dryRun,
      onExisting: options.onExisting,
      names: { project: name, development: `${name}-dev`, production: `${name}-prod` }
    }

    yield* Console.log(
      `provision factory: ${workspace.repository} with factory ${factory.name}` +
        `${options.dryRun ? ' (dry run: nothing is changed)' : ''}\n` +
        `  steps: ${selected.join(', ')}`
    )

    // Every other step needs the Vercel project, so `vercel` runs alone first.
    if (selected.includes('vercel')) yield* runStep('vercel', context)

    const results = yield* Effect.forEach(
      selected.filter(step => step !== 'vercel'),
      step => runStep(step, context).pipe(Effect.result),
      { concurrency: 'unbounded' }
    )
    const failed = results.flatMap(result => (Result.isFailure(result) ? [result.failure] : []))

    if (failed.length === 1 && failed[0] !== undefined) return yield* failed[0]
    if (failed.length > 1) {
      return yield* factoryError(
        `${failed.length} steps failed: ${failed.map(error => error.message).join('; ')}`
      )
    }

    yield* Console.log(
      `\nprovision factory: ${options.dryRun ? 'dry run complete' : 'done'}` +
        `\n  next: provision env --repo ${workspace.root} --database`
    )
  })

export const factoryCommand = Command.make(
  'factory',
  {
    checkout: Flag.String('checkout').pipe(
      Flag.withDescription('company checkout (default: current directory)'),
      Flag.withDefault('.')
    ),
    domain: Flag.String('domain').pipe(
      Flag.withDescription('production host, e.g. app.example.com (r2 and domain steps)'),
      Flag.optional
    ),
    senderName: Flag.String('sender-name').pipe(
      Flag.withDescription('AUTH_EMAIL_FROM display name (default: repository name)'),
      Flag.optional
    ),
    emailFrom: Flag.String('email-from').pipe(
      Flag.withDescription(
        'AUTH_EMAIL_FROM address, e.g. noreply@acme.com (default: noreply@<resend.sending_domain>)'
      ),
      Flag.optional
    ),
    factory: Flag.String('factory').pipe(
      Flag.withDescription('factory name (default: the factory whose github.owner matches)'),
      Flag.optional
    ),
    only: Flag.String('only').pipe(
      Flag.withDescription(`comma-separated subset of: ${factorySteps.join(', ')}`),
      Flag.optional
    ),
    onExisting: Flag.Literals('on-existing', onExistingPolicies).pipe(
      Flag.withDescription('what to do when a resource exists (data is only ever reused)'),
      Flag.withDefault('ask')
    ),
    neonParentBranch: Flag.String('neon-parent-branch').pipe(
      Flag.withDescription('existing-branch mode: sandbox parent branch id'),
      Flag.optional
    ),
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('inspect and print planned changes without making them'),
      Flag.withDefault(false)
    )
  },
  options =>
    humanOnly(
      runFactory(options).pipe(
        Effect.catch(error =>
          Console.error(`provision factory: ${error.message}`).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 2
              })
            )
          )
        )
      )
    )
).pipe(
  Command.withDescription(
    'Create provider projects and resources with factory admin keys, mint scoped keys, and write them to Vercel.'
  )
)
