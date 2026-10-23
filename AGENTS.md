# AGENTS.md

## Project

CLI для KeePassXC через browser integration (WSL → Windows)

## Stack

NodeJS, TypeScript

## Package manager and commands

Use **pnpm**; the version is pinned in `package.json` via `packageManager`. When dependencies change, update `pnpm-lock.yaml`.

- `pnpm install` — install dependencies.
- `pnpm dev` — compile TypeScript in watch mode (`tsc --watch`).
- `pnpm build` — compile TypeScript to `dist/`.
- `pnpm lint` — run ESLint.
- `pnpm test` — run Vitest.

## Commits

**Do not commit without user review.** Show the change first and wait for explicit confirmation; only then create the commit. Commit messages must be in English.

Messages are short, Conventional Commits style: `<type>: <short description>`. One line, no body, if a phrase describes the change.

Use `source ~/.nvm/nvm.sh && command ...` to load the user environment when running shell commands for npm-global-installed packages.
