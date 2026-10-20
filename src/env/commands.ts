import { Console, Effect, Option } from 'effect'
import { Command, Flag } from 'effect/cli'
import { detectAgent } from '../shared/agent.ts'
import { envConflictPolicies } from './domain.ts'
import { provisionEnvironment } from './provision.ts'

const optionalText = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional)

const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(false))

const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code
  })

export const envCommand = Command.make(
  'env',
  {
    repo: Flag.String('repo').pipe(
      Flag.withDescription('target Git checkout (default: current directory)'),
      Flag.withDefault('.')
    ),
    checkVercelLink: booleanFlag(
      'check-vercel-link',
      'check/reuse a local app link only; passes for a checkout that is not a Vercel app; missing or ambiguous links emit JSON on stderr and exit 3'
    ),
    appDir: optionalText(
      'app-dir',
      'checkout-relative app directory (default: package.json provision.appDir or ".")'
    ),
    source: optionalText(
      'source',
      "linked checkout to copy the selected app's .vercel/project.json from"
    ),
    vercelProject: optionalText('vercel-project', 'link explicitly to this Vercel project'),
    database: booleanFlag('database', 'allocate independent development and test databases'),
    testEnvironment: Flag.String('test-environment').pipe(
      Flag.withDescription('Vercel environment for .env.test (default: test)'),
      Flag.withDefault('test')
    ),
    label: optionalText('label', 'database label prefix (default: branch or directory name)'),
    ttl: Flag.String('ttl').pipe(
      Flag.withDescription('database lifetime (default: 7d; maximum: 7d)'),
      Flag.withDefault('7d')
    ),
    skipInstall: booleanFlag('skip-install', 'do not install dependencies'),
    skipVercel: booleanFlag('skip-vercel', 'do not pull either Vercel environment'),
    skipSetup: booleanFlag('skip-setup', 'do not run package.json provision.setup commands'),
    nonInteractive: booleanFlag(
      'non-interactive',
      'never prompt; unresolved env conflicts fail safely'
    ),
    envConflict: Flag.Literals('env-conflict', envConflictPolicies).pipe(
      Flag.withDescription('existing env policy (default: refresh from Vercel)'),
      Flag.withDefault('overwrite')
    )
  },
  options =>
    provisionEnvironment({
      ...options,
      // Agents cannot answer prompts; fail safely instead, as with --non-interactive.
      nonInteractive: options.nonInteractive || detectAgent() !== undefined,
      appDir: Option.getOrUndefined(options.appDir),
      source: Option.getOrUndefined(options.source),
      vercelProject: Option.getOrUndefined(options.vercelProject),
      label: Option.getOrUndefined(options.label)
    }).pipe(
      Effect.catchTag('VercelLinkRequired', error =>
        Console.error(
          JSON.stringify({
            status: 'vercel_link_required',
            directory: error.directory,
            reason: error.reason
          })
        ).pipe(Effect.andThen(setExitCode(3)))
      ),
      Effect.catch(error =>
        Console.error(`provision env: ${error.message}`).pipe(Effect.andThen(setExitCode(2)))
      )
    )
).pipe(
  Command.withDescription(
    'Make a checkout runnable: install dependencies, link Vercel, pull Development and test env ' +
      'files, optionally allocate isolated databases, then run package.json provision.setup.'
  )
)
