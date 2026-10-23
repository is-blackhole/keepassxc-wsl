# AGENTS.md

## Project

CLI for KeePassXC running on Windows, accessed from WSL through `keepassxc-proxy.exe` and browser integration.

## Stack

Node.js (ES modules), TypeScript. `node:util.parseEnv` requires Node.js 20.12.0+; use Node.js 22+ for development.

## Project structure

- `src/` — CLI, KeePassXC protocol/client, transport, output formatting and template rendering.
- `test/` — unit tests with an in-memory KeePassXC fake; `e2e.test.ts` is an opt-in test against real KeePassXC.
- `scripts/` — manual development/probe scripts.
- `dist/` — generated build output; do not edit by hand.

## Package manager and commands

Use **pnpm**; the version is pinned in `package.json` via `packageManager`. When dependencies change, update `pnpm-lock.yaml`.

- `pnpm install` — install dependencies.
- `pnpm dev` — compile TypeScript in watch mode (`tsc -p tsconfig.json --watch`).
- `pnpm build` — compile TypeScript to `dist/`.
- `pnpm lint` — run ESLint.
- `pnpm test` — run Vitest; the real-KeePassXC E2E test is skipped by default.

After code changes, run the relevant tests and `pnpm lint`; run `pnpm build` for TypeScript or build-related changes.

The opt-in command `KPX_E2E=1 pnpm test` connects to real KeePassXC and may trigger an unlock or association prompt. Run it only when specifically needed and expected.

## Security

- Treat passwords, TOTP codes, KeePassXC attributes and `~/.config/kpx/assoc.json` as secrets. Never log real secret values or copy values from a real database into tests, diagnostics, commits or review output; use synthetic test fixtures.
- Keep secret output on stdout and diagnostics on stderr. Preserve restrictive permissions for association/output files; avoid tests that write secrets to persistent paths.
- `kpx run` passes selected entry attributes into a child process environment. Do not assume entry attributes are trusted; preserve/document `--only` behavior and avoid shell-based process execution.
- The project targets a trusted local WSL environment. Do not imply that file permissions protect secrets from other processes running as the same user.

## Commits

**Do not commit without user review.** Show the change first and wait for explicit confirmation; only then create the commit. Commit messages must be in English.

Messages are short, Conventional Commits style: `<type>: <short description>`. One line, no body, if a phrase describes the change.

Use `source ~/.nvm/nvm.sh && command ...` to load the user environment when running shell commands for npm-global-installed packages.
