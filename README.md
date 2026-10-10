# provision

One CLI to take a web project from an empty GitHub repository to a running local checkout:

- **`provision factory`** creates the project's provider resources (Vercel, Neon, Cloudflare R2,
  Upstash, Resend) with admin keys kept in 1Password, mints keys scoped to the project, and writes
  them to the project's Vercel environment variables.
- **`provision env`** makes a checkout runnable: installs dependencies, links Vercel, pulls env
  files, creates disposable databases, and runs the repository's setup commands.
- **`provision db`** manages those disposable Neon databases.

It is built for a host shared with coding agents: agents can run `env` and `db` on their own, while
anything that touches admin keys needs a passphrase typed by a human in a terminal.

> **Status: pre-1.0.** Interfaces may still change; see [Contract](#contract-and-exit-codes).

- [Install](#install)
- [Quick start](#quick-start)
- [Repository configuration](#repository-configuration)
- [Factories](#factories)
- [`provision factory`](#provision-factory)
- [`provision env`](#provision-env)
- [`provision db`](#provision-db)
- [Agents](#agents)
- [Contract and exit codes](#contract-and-exit-codes)
- [Troubleshooting](#troubleshooting)

## Install

Requires Node 24+, the [Vercel CLI](https://vercel.com/docs/cli) (logged in), and for factories the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op`) and `systemd-creds` (Linux).

```bash
npm install -g @magoz/provision
provision --help
```

On a host where coding agents run as your user, install it **root-owned** and run factory commands
by absolute path, so an agent cannot replace the code that receives your passphrase:

```bash
sudo npm install -g --prefix /usr/local @magoz/provision
/usr/local/bin/provision --version
```

Install the agent skill so coding agents know how to use the CLI (see [Agents](#agents)):

```bash
npx skills add magoz/provision
```

## Quick start

**Once per factory** (a set of provider accounts, see [Factories](#factories)):

```bash
provision config add --name acme      # guided: vault, item, service account, passphrase
# fill the item's fields in 1Password, then:
provision config add --name acme      # registers the factory once every field decodes
provision config verify acme
```

**Once per project** (the GitHub repository `acme/acme-app` exists and is checked out):

```bash
provision factory --checkout ~/src/acme-app --domain app.acme.com --dry-run   # plan
provision factory --checkout ~/src/acme-app --domain app.acme.com \
  --sender-name "Acme" --email-from noreply@acme.com                          # apply
```

**For every checkout or worktree:**

```bash
provision env --repo ~/src/acme-app --database
```

## Repository configuration

Repositories declare their needs in the root `package.json`. Everything is optional:

```jsonc
{
  "provision": {
    "appDir": "apps/web", // monorepo app directory; default "."
    "setup": ["pnpm db:migrate"], // run by `provision env` after provisioning
    "factory": {
      "steps": ["vercel", "neon", "r2", "resend", "secrets"], // default: all steps
      "neon": { "sandboxParent": "empty-baseline" } // or "existing-branch"
    }
  }
}
```

Unknown keys are rejected. `setup` commands run from the checkout root through `$SHELL -lc`; keep
them idempotent (migrations, not seeds), since `provision env` reruns them on every run. A common
setup migrates both databases while ignoring any inherited `DATABASE_URL`:

```jsonc
"setup": [
  "env -u DATABASE_URL NODE_ENV=development pnpm db:migrate",
  "env -u DATABASE_URL NODE_ENV=test pnpm db:migrate"
]
```

## Factories

A **factory** is one set of operator accounts: a GitHub owner, a Vercel team, a Neon organization,
a Cloudflare account, an Upstash account, a Resend account, and optionally a report receiver. Its
admin credentials live in **one 1Password item** (by default `provision`, in vault
`provision-<name>`). The CLI only records where that item is, in
`${XDG_CONFIG_HOME:-~/.config}/provision/config.json`.

A checkout picks its factory by GitHub owner: `acme/acme-app` uses the factory whose
`github.owner` is `acme` (or `--factory <name>`).

```bash
provision config add [--name acme] [--vault provision-acme] [--item provision] [--account <op-account>] [--yes]
provision config list [--json]
provision config verify [<name>] [--json]
provision config remove <name>
provision config op-token set|remove --factory <name>
provision config op-token status
```

### Set up a factory

```bash
provision config add --name acme
```

The first run walks you through everything:

1. signs you in to 1Password (the session lives only in this command and is signed out at the end);
2. creates the vault and an empty `provision` item with every field, if missing (`--yes` skips the
   confirmation);
3. creates a read-only service account `provision-acme` (`read_items` on that vault only) and stores
   its token, sealed with the **provision passphrase**. The first factory asks you to choose the
   passphrase; all factories share it;
4. lists the fields still empty.

Fill the fields in the 1Password app (see below), then run the same command again. Reruns only ask
for the passphrase, report each section, and register the factory once the item decodes:

```text
  github           ✓ complete
  vercel           ✓ complete
  neon             ✓ complete
  cloudflare       ✓ complete
  upstash          ✓ complete
  resend           ✓ complete
  report_receiver  empty: url, factory_key
status        added
factory       acme
```

### Item fields

Fields are `section.label` in the item. A section counts only when all of its required fields are
filled; `github` and `vercel` are required, the others enable the steps that use them.

| Section           | Fields                                                     | Used by                   |
| ----------------- | ---------------------------------------------------------- | ------------------------- |
| `github`          | `owner`                                                    | factory selection, checks |
| `vercel`          | `team_id` (`team_…`)                                       | every step                |
| `neon`            | `api_key`, `org_id`                                        | `neon`                    |
| `cloudflare`      | `api_token`, `account_id`                                  | `r2`                      |
| `upstash`         | `email`, `api_key`; optional `dev_api_key`, `prod_api_key` | `upstash`                 |
| `resend`          | `api_key`; optional `sending_domain`                       | `resend`, `secrets`       |
| `report_receiver` | `url`, `factory_key`                                       | `reports`                 |

Where to get each value:

- **`github.owner`**: the GitHub organization or user that owns the factory's repositories, e.g.
  `acme`.
- **`vercel.team_id`**: the team's immutable ID, not its slug: Vercel dashboard → team Settings →
  General → Team ID, or `vercel api /v2/teams`. It looks like `team_aBcDeFgH1234…`. Vercel calls use
  your own `vercel login`, which must be a member of that team.
- **`neon.api_key`, `neon.org_id`**: Neon Console → Organization settings → API keys → create an
  **organization** API key. The organization ID (`org-…`) is on the organization settings page.
- **`cloudflare.api_token`, `cloudflare.account_id`**: in the Cloudflare dashboard, enable R2
  (R2 Object Storage; the free tier is enough). Then Manage Account → Account API Tokens → Create
  Token → Custom token with exactly two permissions, **Account · Workers R2 Storage · Edit** and
  **Account · Account API Tokens · Edit**, scoped to this account. This must be an
  **account-owned** token, not a user token. The account ID is in the dashboard URL
  (`dash.cloudflare.com/<account_id>`).
  "Account API Tokens Edit" can mint tokens with any permission you hold on the account: treat
  this token as account-level access.
- **`upstash.email`, `upstash.api_key`**: your Upstash account email and a Management API key
  (Upstash Console → Account → Management API). `dev_api_key`/`prod_api_key` are experimental
  team-scoped keys used to read QStash credentials; leave them empty and copy QStash credentials by
  hand (see [Manual follow-ups](#manual-follow-ups)).
- **`resend.api_key`**: a **Full access** Resend API key (it creates the per-project sending keys).
  `sending_domain` is optional: when set, `AUTH_EMAIL_FROM` defaults to `noreply@<sending_domain>`.
- **`report_receiver.url`, `report_receiver.factory_key`**: an optional service that issues
  report tokens per project. Leave empty if you have none; the `reports` step is then skipped.

### Passphrase and 1Password authentication

`provision` reads factory items with `op`, authenticated by the first of:

1. `OP_SERVICE_ACCOUNT_TOKEN` in the environment;
2. the factory's stored service-account token, sealed with the provision passphrase (scrypt +
   AES-256-GCM) and then encrypted with `systemd-creds --user` (TPM2-bound where available), at
   `~/.config/provision/op-service-account.<factory>.cred`;
3. the current `op` session (`eval "$(op signin)"`) or the desktop app integration.

With stored tokens, **the passphrase is the human approval**. Every command that reads a factory
item (`config add`, `config verify`, `factory`) asks for it once, on the controlling terminal. It is
never read from arguments, the environment, or stdin, and these commands refuse to run without a
terminal. An agent can prepare a command, but only you can run it. One approval covers the whole
run, and each run unseals only the selected factory's token.

Service accounts cannot read Private vaults or the account's default Shared vault, and their
permissions are fixed at creation. Tokens created without `--expires-in` never expire. To rotate,
create a new service account, store it with `provision config op-token set --factory <name>`
(reads stdin or a hidden prompt), and revoke the old one under Developer → Service accounts.
Revoke immediately if the host may be compromised.

## `provision factory`

```bash
provision factory [--checkout <repo>] --domain <production-host>
                  [--sender-name <name>] [--email-from <address>]
                  [--factory <name>] [--only vercel,neon,r2,upstash,resend,reports,secrets,domain]
                  [--on-existing ask|reuse|overwrite|abort] [--neon-parent-branch <id>] [--dry-run]
```

Creates what the repository declares (`provision.factory.steps`, narrowed by `--only`) for the
checkout's GitHub repository `<owner>/<repo>`. Resources are named `<repo>` (Vercel project),
`<repo>-dev` (pre-production), and `<repo>-prod` (production).

| Step      | Creates                                                                                            | Vercel env vars                                                      |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `vercel`  | project (Git link, Root Directory = `appDir`), custom `test` environment, checkout link            | `ALLOW_E2E_DATABASE_RESET=1` (`test` only)                           |
| `neon`    | `<repo>-dev` (protected `baseline`) + project-scoped key; `<repo>-prod` (protected, 7-day history) | `SANDBOX_DB_*` (Development); `DATABASE_URL(_UNPOOLED)` (Production) |
| `r2`      | private `<repo>-dev`/`-prod` buckets with upload CORS, bucket-scoped tokens                        | `R2_*`                                                               |
| `upstash` | `<repo>-dev`/`-prod` teams                                                                         | `QSTASH_*` (see [Manual follow-ups](#manual-follow-ups))             |
| `resend`  | sending-only keys (any verified domain)                                                            | `RESEND_API_KEY`                                                     |
| `reports` | report tokens from the factory's receiver                                                          | `REPORT_RECEIVER_URL`, `REPORT_RECEIVER_TOKEN`                       |
| `secrets` | generated `BETTER_AUTH_SECRET`, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, `CRON_SECRET`, VAPID pair | those, plus `AUTH_EMAIL_FROM`, `AI_PROVIDER_USAGE_ALERT_THRESHOLDS`  |
| `domain`  | attaches `--domain` to the project                                                                 | —                                                                    |

- **Environments.** Pre-production values go to Development, Preview, and `test`; production values
  go to Production and are Sensitive. Each side gets its own keys and secrets.
- **`--domain`** is the production host. The `r2` step allows browser uploads to the production
  bucket only from `https://<domain>`; the development bucket accepts any origin.
- **`--email-from`** sets `AUTH_EMAIL_FROM` (`"<sender-name> <address>"`). The address's domain must
  be verified in the factory's Resend account.
- **Order.** `vercel` runs first; the other steps then run concurrently. Each step prints one block
  when it finishes, and a failing step lets the others finish before the run fails.

### First run on a project

```bash
# 1. Plan: reads every provider, changes nothing
provision factory --checkout ~/src/acme-app --domain app.acme.com \
  --sender-name Acme --email-from noreply@acme.com --dry-run

# 2. Apply
provision factory --checkout ~/src/acme-app --domain app.acme.com \
  --sender-name Acme --email-from noreply@acme.com

# 3. Rerun: should only report "reusing"
provision factory --checkout ~/src/acme-app --domain app.acme.com \
  --sender-name Acme --email-from noreply@acme.com --on-existing reuse
```

Reading the output: `would …` is a dry-run plan; `exists:` and `reusing …` mean nothing changed;
`skipped:` means the factory lacks that provider; `manual:` is a follow-up you do by hand.

```text
[neon]
  create Neon project acme-app-dev with protected branch baseline
  create Neon key acme-app-dev-sandbox-branch-manager
  write SANDBOX_DB_NEON_API_KEY, SANDBOX_DB_NEON_PROJECT_ID, SANDBOX_DB_PARENT_BRANCH_ID to Vercel (Development)
  create Neon project acme-app-prod with protected branch production
  write DATABASE_URL, DATABASE_URL_UNPOOLED to Vercel (Production)
```

### Existing resources

`--on-existing` decides what happens when something already exists (default `ask`, which prompts):

| Policy      | Data (projects, buckets, teams) | Keys                                              | Generated secrets                                     |
| ----------- | ------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `reuse`     | reused                          | reused                                            | reused                                                |
| `overwrite` | reused (never replaced)         | rotated: new key, Vercel updated, old key deleted | regenerated (invalidates sessions and encrypted data) |
| `abort`     | run fails                       | run fails                                         | run fails                                             |

`provision` never deletes data. A key whose value is missing from Vercel cannot be reused; rerun
with `--on-existing overwrite --only <step>` to rotate it.

```bash
provision factory --checkout ~/src/acme-app --domain app.acme.com --only resend --on-existing overwrite
provision factory --checkout ~/src/acme-app --domain app.acme.com --only reports   # after adding a receiver
```

### Manual follow-ups

- **QStash.** Without team-scoped Upstash keys, the `upstash` step creates the teams and prints
  `manual:` lines. In the Upstash console, open team `<repo>-dev`, go to QStash (EU region), and copy
  `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY` into the
  Vercel project for Development, Preview, and `test`. Then copy team `<repo>-prod`'s values into
  Production, marked Sensitive. Later runs stop printing the reminder once Vercel has them.
- **DNS.** If the domain is not yet pointed at Vercel, add the record shown under the project's
  Domains settings at your DNS provider.

## `provision env`

```bash
provision env [--repo <checkout>] [--app-dir <dir>] [--source <linked-checkout>]
              [--vercel-project <name>] [--database] [--label <l>] [--ttl 7d]
              [--test-environment test] [--env-conflict overwrite|preserve|ask|error]
              [--skip-install] [--skip-vercel] [--skip-setup] [--non-interactive]
provision env --check-vercel-link [--repo <checkout>] [--source <linked-checkout>]
```

```bash
provision env --database                                  # current checkout, own databases
provision env --repo ../acme-app-feature --source ../acme-app --database   # new worktree
provision env --env-conflict preserve --skip-install      # keep local env edits
```

Under a per-checkout lock, it:

1. validates the checkout, app directory, and env paths (ignored, untracked, not symlinks);
2. resolves existing env files (`--env-conflict`; default: refresh from Vercel);
3. installs dependencies from the root lockfile (pnpm, bun, npm, or yarn; frozen);
4. reuses or creates the app's Vercel link (existing link, `--source`, `--vercel-project`, or the
   single project shared by linked sibling worktrees);
5. pulls Vercel Development into `.env.local` and `test` into `.env.test` (mode `0600`), dropping
   deployment-only metadata, `ALLOW_E2E_DATABASE_RESET` from `.env.local`, and, with `--database`,
   Vercel's database URLs;
6. with `--database`, creates the `default` and `test` database leases (see `provision db`);
7. after releasing the lock, runs `package.json` `provision.setup` (skipped with `--skip-setup`).

A failure in steps 1–6 rolls back what the run created (leases, env files, a new Vercel link). A
setup failure keeps them, since they are valid; fix the cause and rerun to resume. A missing or
ambiguous Vercel link prints `{"status":"vercel_link_required","directory":…,"reason":…}` on stderr
and exits 3; rerun with `--source` or `--vercel-project`.

## `provision db`

Disposable Neon branches for local checkouts, cloned from the sandbox parent branch (by default
the protected `baseline` branch of the factory-created `<repo>-dev` project).

```bash
provision db create  [--worktree <path>] [--lease <slot>] [--label <l>] [--ttl 7d] [--env-file .env.local]
                     [--config-env-file <file>] [--keys DATABASE_URL,DATABASE_URL_UNPOOLED]
                     [--force-new] [--no-wait] [--json]
provision db status  [--worktree <path>] [--lease <slot>] [--json]
provision db renew   [--worktree <path>] [--lease <slot>] [--ttl 7d] [--json]
provision db release [--worktree <path>] [--lease <slot>] [--keep-env] [--json]
provision db list    [--json]
provision db gc      [--dry-run] [--prune-expired] [--json]
provision db auth login [--project-id <id>] [--parent-branch <id>] [--token-stdin] [--json]
provision db auth status [--worktree <path>] [--json]
provision db auth logout [--json]
```

```bash
provision db status --lease default        # exit 1 when there is no lease
provision db renew --lease test --ttl 7d   # keep a database alive longer
provision db release --lease default       # before deleting a worktree; also --lease test
provision db gc --dry-run                  # find leftovers
```

- **Profile.** The worktree's `.env.local` (or `--config-env-file`) provides
  `SANDBOX_DB_NEON_API_KEY`, `SANDBOX_DB_NEON_PROJECT_ID`, and `SANDBOX_DB_PARENT_BRANCH_ID`
  (written there by the factory's `neon` step), all three or none. Without them, global auth
  (`db auth login`, or the `NEON_AGENTS_SANDBOX_*` environment variables) applies.
- **Branches** are named `agent/<repo>-<label>-<random>`, unprotected, with a mandatory TTL of at
  most 7 days. Connection URLs are written only to git-ignored, untracked env files (mode `0600`)
  and never printed.
- **Leases** (`default`, `test`, …) record identifiers and paths, never secrets. `create` reuses a
  compatible live lease and refreshes its TTL; `release` re-verifies the exact branch before
  deleting it.
- **Attestation.** When `package.json` declares `provision.factory.neon.sandboxParent:
  "empty-baseline"`, `create`, `renew`, and `release` first verify that the profile points at the
  `<repo>-dev` project and its protected default `baseline` branch.
- **Storage:** settings in `${XDG_CONFIG_HOME:-~/.config}/pi/sandbox-db.json`, the global key in the
  macOS keychain or `sandbox-db.env` next to it, leases and locks in
  `${XDG_STATE_HOME:-~/.local/state}/pi/sandbox-db/`.

## Agents

The repository ships an [agent skill](skills/provision/SKILL.md) that teaches coding agents the
workflows above and the approval boundary:

```bash
npx skills add magoz/provision            # this project
npx skills add magoz/provision -g         # all projects
```

The skill is also included in the npm package, under `skills/provision/`.

| Agents may run                                                   | Only a human runs (needs the passphrase)                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `env`, `db`, `contract`, `config list`, `config op-token status` | `factory`, `config add`, `config verify`, `config op-token set` |

## Contract and exit codes

`provision contract` prints the machine-readable contract other tools rely on:

```json
{
  "contractVersion": 1,
  "provisionVersion": "0.0.0",
  "commands": ["contract", "config", "factory", "env", "db"]
}
```

`contractVersion` changes only for breaking changes to commands, flags, JSON output, or exit codes.
Check `commands` for the capabilities you need.

| Code | Meaning                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                                                                                                                |
| 1    | negative result: `db status` without a lease or branch, `db auth status` unauthenticated or invalid, `db gc` with inaccessible leases (unless `--prune-expired`), or a CLI usage error |
| 2    | expected failure, reported as one `provision <mode>: …` line on stderr                                                                                                                 |
| 3    | `provision env`: Vercel link required (JSON on stderr)                                                                                                                                 |

## Troubleshooting

| Message                                                             | Fix                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `vercel.team_id must be an immutable team_* identifier`             | use the team ID (`team_…`), not the slug or URL                                      |
| `partial: also fill <field>` in `config add`                        | fill the missing fields, or clear the whole section if the factory does not use it   |
| `Resend domain … must be verified in the factory's Resend account`  | verify the domain in Resend, or pass `--email-from` with an already verified domain  |
| `factory … serves GitHub owner …, not …`                            | the checkout's `origin` belongs to another owner; pass `--factory` or fix the remote |
| `Vercel project … does not exist; run the vercel step first`        | run without `--only`, or include `vercel`                                            |
| `… already exists and prompting is unavailable; pass --on-existing` | run in a terminal, or choose `--on-existing reuse`                                   |
| `systemd-creds is unavailable`                                      | use `op signin` or `OP_SERVICE_ACCOUNT_TOKEN` instead of a stored token              |
| `env` exits 3                                                       | pass `--source <linked checkout>` or `--vercel-project <name>`                       |

## Development

```bash
pnpm install
pnpm dev --help     # run from source
pnpm verify         # format, typecheck, lint, test, build
```

## Releasing

Pushing a `v*` tag publishes to npm from GitHub Actions with provenance (npm trusted publishing).
