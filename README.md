# provision

One CLI to provision web projects end to end:

- **`provision factory`**: create provider projects and resources (Vercel, Neon, Cloudflare R2,
  Upstash, Resend) with admin keys from 1Password, mint scoped keys, and write them to Vercel
  environment variables.
- **`provision env`**: make a checkout runnable: install dependencies, link Vercel, pull env files,
  create disposable databases, run the repository's setup commands.
- **`provision db`**: manage disposable Neon database branches for local checkouts.

> **Status: in development, not yet published.** Every mode exists; `factory` has not yet been run
> against real provider accounts.

## Install

```bash
npm install -g @magoz/provision
```

Requires Node 24 or newer.

## Repository configuration

Repositories declare their needs in the root `package.json`:

```jsonc
{
  "provision": {
    "appDir": "apps/web", // monorepo app directory; default "."
    "setup": ["pnpm db:migrate"], // run by `provision env` once the checkout is provisioned
    "factory": {
      "steps": ["vercel", "neon", "r2", "resend", "secrets"], // default: all steps
      "neon": { "sandboxParent": "empty-baseline" } // or "existing-branch"
    }
  }
}
```

Unknown keys are rejected.

## Factories: `provision config`

A factory is one set of operator accounts (Vercel team, Neon organization, Cloudflare account,
Upstash account, Resend account, optional report receiver). Its admin credentials live in one
1Password item; the CLI only records where that item is, in
`${XDG_CONFIG_HOME:-~/.config}/provision/config.json`.

```bash
provision config add --name acme --vault provision-factory-acme [--item provision] [--account <op-account>]
provision config list [--json]
provision config verify [<name>] [--json]
provision config remove <name>
```

`add` reads the item with `op` and refuses to save it unless it decodes. Item fields
(`section.label`; a section counts only when all of its fields are present):

| Section           | Fields                                                                   | Used by                   |
| ----------------- | ------------------------------------------------------------------------ | ------------------------- |
| `github`          | `owner`                                                                  | factory selection, checks |
| `vercel`          | `team_id` (`team_*`)                                                     | every step                |
| `neon`            | `api_key` (organization key), `org_id`                                   | `neon`                    |
| `cloudflare`      | `api_token` (R2 write + account tokens write), `account_id`              | `r2`                      |
| `upstash`         | `email`, `api_key`; optional `dev_api_key`, `prod_api_key` (team-scoped) | `upstash`                 |
| `resend`          | `api_key` (full access), `sending_domain` (verified, EU)                 | `resend`, `secrets`       |
| `report_receiver` | `url`, `factory_key`                                                     | `reports` (optional)      |

## `provision factory`

```bash
provision factory [--checkout <repo>] --domain <production-host> [--sender-name <name>]
                  [--factory <name>] [--only vercel,neon,r2,upstash,resend,reports,secrets,domain]
                  [--on-existing ask|reuse|overwrite|abort] [--neon-parent-branch <id>] [--dry-run]
```

Creates what the repository declares (`provision.factory.steps`, narrowed by `--only`) for the
checkout's GitHub repository `<owner>/<repo>`, with resources named `<repo>`, `<repo>-dev`, and
`<repo>-prod`. The factory is the one whose `github.owner` matches the checkout (or `--factory`).
Vercel calls use the operator's `vercel` login, scoped to the factory team.

| Step      | Creates                                                                                            | Vercel records                                                       |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `vercel`  | project (Git link, Root Directory = `appDir`), custom `test` environment, checkout link            | `ALLOW_E2E_DATABASE_RESET=1` (`test` only)                           |
| `neon`    | `<repo>-dev` (protected `baseline`) + project-scoped key; `<repo>-prod` (protected, 7-day history) | `SANDBOX_DB_*` (Development); `DATABASE_URL(_UNPOOLED)` (Production) |
| `r2`      | private `<repo>-dev`/`-prod` buckets with upload CORS, bucket-scoped tokens                        | `R2_*`                                                               |
| `upstash` | `<repo>-dev`/`-prod` teams; QStash credentials when team keys are in the item                      | `QSTASH_*`                                                           |
| `resend`  | sending-only keys for the factory domain                                                           | `RESEND_API_KEY`                                                     |
| `reports` | report tokens from the factory's receiver                                                          | `REPORT_RECEIVER_URL`, `REPORT_RECEIVER_TOKEN`                       |
| `secrets` | generated `BETTER_AUTH_SECRET`, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, `CRON_SECRET`, VAPID pair | those, plus `AUTH_EMAIL_FROM`, `AI_PROVIDER_USAGE_ALERT_THRESHOLDS`  |
| `domain`  | attaches `--domain`                                                                                | —                                                                    |

Pre-production records target Development, Preview, and `test`; production records target
Production and are Sensitive. Existing resources follow `--on-existing` (default `ask`): data
(projects, buckets, teams) is only ever reused; keys can be reused or rotated (new key, Vercel
updated, old key deleted); generated secrets can be reused or regenerated. A key whose value is
missing from Vercel cannot be reused and must be rotated. `--dry-run` inspects and prints what
would change.

## `provision env`

Makes a checkout runnable (formerly `provision-env`).

```bash
provision env [--repo <checkout>] [--app-dir <dir>] [--source <linked-checkout>]
              [--vercel-project <name>] [--database] [--label <l>] [--ttl 7d]
              [--test-environment test] [--env-conflict overwrite|preserve|ask|error]
              [--skip-install] [--skip-vercel] [--skip-setup] [--non-interactive]
provision env --check-vercel-link [--repo <checkout>] [--source <linked-checkout>]
```

In order, under a per-checkout lock:

1. validates the checkout, app directory, and ignored, untracked, non-symlink env paths;
2. resolves existing env files (`--env-conflict`, default: refresh from Vercel);
3. installs dependencies from the root lockfile (pnpm, bun, npm, or yarn; frozen);
4. reuses or creates the app's Vercel link (existing link, `--source`, `--vercel-project`, or the
   single identity shared by linked sibling worktrees);
5. pulls Vercel Development into `.env.local` and `test` into `.env.test` (staged, `0600`),
   removing deployment-only metadata, the destructive `ALLOW_E2E_DATABASE_RESET` from
   `.env.local`, and (with `--database`) Vercel database URLs;
6. with `--database`, creates the `default` and `test` database leases (`provision db`);
7. after releasing the lock, runs `package.json` `provision.setup` commands from the checkout root
   through `$SHELL -lc` (skipped for install-only runs and with `--skip-setup`).

A failure in steps 1–6 rolls back what the run created: leases, env files, and a new Vercel link.
A setup failure keeps them (they are valid) and a re-run resumes. A missing or ambiguous Vercel
link prints `{"status":"vercel_link_required","directory":…,"reason":…}` on stderr and exits 3.

## `provision db`

Disposable Neon branches for local checkouts (formerly `sandbox-db`).

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

- **Profile.** The worktree's `.env.local` (or `--config-env-file`) provides
  `SANDBOX_DB_NEON_API_KEY`, `SANDBOX_DB_NEON_PROJECT_ID`, and `SANDBOX_DB_PARENT_BRANCH_ID`,
  all three or none. Without them, global auth (`auth login`, or the `NEON_AGENTS_SANDBOX_*`
  environment variables) applies.
- **Branches** are named `agent/<repo>-<label>-<random>`, unprotected, with a mandatory TTL of at
  most 7 days. Connection URLs are written only to git-ignored, untracked env files (mode `0600`)
  and never printed.
- **Leases** (`default`, `test`, …) record identifiers and paths, never secrets. `create` reuses a
  compatible live lease and refreshes its TTL; `release` re-verifies the exact branch before
  deleting it.
- **Attestation.** When `package.json` declares
  `provision.factory.neon.sandboxParent: "empty-baseline"`, `create`, `renew`, and `release`
  first verify the profile points at the `<repo>-dev` project and its protected default
  `baseline` branch.
- **Storage** (shared with the former `sandbox-db`): global settings in
  `${XDG_CONFIG_HOME:-~/.config}/pi/sandbox-db.json`, the key in the macOS keychain or
  `sandbox-db.env` next to it, leases and locks in `${XDG_STATE_HOME:-~/.local/state}/pi/sandbox-db/`.

## Contract

`provision contract` prints the machine-readable contract that other tools rely on:

```json
{
  "contractVersion": 1,
  "provisionVersion": "0.0.0",
  "commands": ["contract", "config", "factory", "env", "db"]
}
```

`contractVersion` changes only for breaking changes to commands, flags, JSON output, or exit
codes. Check `commands` for the capabilities you need.

Exit codes:

| Code | Meaning                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                                                                                                                |
| 1    | negative result: `db status` without a lease or branch, `db auth status` unauthenticated or invalid, `db gc` with inaccessible leases (unless `--prune-expired`), or a CLI usage error |
| 2    | expected failure, reported as one `provision <mode>: …` line on stderr                                                                                                                 |
| 3    | `provision env`: Vercel link required (JSON on stderr)                                                                                                                                 |

## Development

```bash
pnpm install
pnpm dev --help     # run from source
pnpm verify         # format, typecheck, lint, test, build
```

## Releasing

Pushing a `v*` tag publishes to npm from GitHub Actions with provenance (npm trusted publishing).
