# provision

One CLI (`provision`) with three modes: `factory` (create provider projects and scoped keys, write
them to Vercel), `env` (make a checkout runnable), and `db` (disposable Neon databases). Operator-specific
plans live in the untracked `plans/` directory (never committed: this repository is public); read
them when present before changing behavior.

## Layout

```text
src/cli.ts          entry point; the only place Effects are run (NodeRuntime.runMain)
src/contract.ts     public machine-readable contract (`provision contract`)
src/shared/         modules used by more than one mode (repo config, …)
src/factory/        factory mode (admin credentials live only here)
src/env/            env mode
src/db/             db mode
skills/provision/   agent skill shipped with the package (`npx skills add magoz/provision`)
```

## Conventions

- Node 24, ESM, Effect 4 (`effect`, `effect/cli`, `@effect/platform-node`). Source runs directly
  with Node type stripping (`node src/cli.ts`); `pnpm build` emits `dist/` for npm.
- Erasable TypeScript only (no enums, namespaces, parameter properties). Relative imports use
  `.ts` extensions; the build rewrites them.
- No `any`, non-null assertions, or type assertions (`as const` is fine). Lint enforces this.
- Parse unknown input (files, JSON, provider responses, CLI output) at the boundary with Effect
  Schema. Model expected failures as `Data.TaggedError` in the error channel; never catch defects.
- Export Effects from modules; run them only in `src/cli.ts`.
- `env`, `db`, and `shared` never import `factory` (enforced by `credential-boundary.test.ts`).
- Never print, log, or pass secrets as process arguments; use `Redacted` for secret values.
- The repository is public: no operator, company, factory, vault, or private repository names in
  code, tests, or docs. Use `acme` / `example.test` placeholders.
- Style: no semicolons, single quotes, no trailing commas, 100 columns (oxfmt).

## Contract

`provision contract`, every `--json` output, and exit codes are a public interface used by other
tools (for example `worktree`). Changing them requires updating the snapshot tests and README,
and a breaking change requires bumping `contractVersion` and a major version. Keep the README and
`skills/provision/SKILL.md` in sync with commands, flags, and output.

## Tests

- Vitest + `@effect/vitest` (`it.effect`), colocated `*.test.ts`.
- No module mocking; fake external systems with typed layers.

## Commands

```bash
pnpm dev <args>      # run the CLI from source
pnpm typecheck
pnpm lint
pnpm format:fix
pnpm test
pnpm build
pnpm verify          # format, typecheck, lint, test, build
```
