# kpx

CLI for KeePassXC running on Windows, used from WSL. It fetches entry passwords, logins and attributes through browser integration (`keepassxc-proxy.exe`); the database password is entered only in KeePassXC.

## Installation

```sh
source ~/.nvm/nvm.sh
pnpm install
pnpm build
pnpm link --global
```

The default proxy path is `/mnt/c/Program Files/KeePassXC/keepassxc-proxy.exe`. Override it with the `KPX_PROXY` variable.

After updating the package, re-run `pnpm link --global` so the global `kpx` launcher points to `dist/bin.js`, then re-source the completion in open shells: `source <(kpx completion)`.

## KeePassXC setup

1. Enable Browser Integration: "Tools → Settings → Browser Integration".
2. Under "Advanced", enable **Return advanced string fields which start with "KPH: "**.
3. Enable "Return only best-matching credentials".
4. Optionally turn off the access prompt or select "Remember".

## Entry convention

- The URL field points to the resource, for example `wsl.dev/service`.
- Variables are stored in string attributes named `KPH: NAME`, for example `KPH: API_KEY`.

## Usage scenarios

### Print one value

For a password, login, TOTP code or one attribute:

```sh
kpx get wsl.dev/service                      # password
kpx get wsl.dev/service -f login             # login
kpx get wsl.dev/service -f API_KEY           # KPH: API_KEY attribute
kpx get wsl.dev/service -f totp              # current TOTP code
kpx get wsl.dev/service --name "Service *" --login admin
```

When piped, the value has no trailing newline. If several entries match, the command fails with exit code 3 and prints the candidates, so narrow the selection with the filters described in [Filters](#filters).

### Pass secrets to one command

Start a process that needs the attributes, without writing them anywhere:

```sh
kpx run wsl.dev/backend --only TYPEORM_URL -- npm run start:dev
kpx run wsl.dev/service --only API_KEY,DB_URL -- pnpm dev
```

`--only` is strongly recommended: without it every attribute of the entry is passed, and attributes override variables such as `PATH` or `NODE_OPTIONS` in the child environment. The process exit code becomes the `kpx` exit code.

### Write a `.env` file

When the variables must be read by a dotenv parser (`node --env-file`, `docker compose`, `pnpm`, `vitest`):

```sh
(umask 077; kpx env wsl.dev/service > .env)
```

Use `--prefix P` to namespace the names and `--with-login VAR`/`--with-password VAR` to add the entry login and password. The output is dotenv, not shell code: never `eval` or `source` it.

### Read secrets in a script or config

When a tool wants JSON:

```sh
kpx env wsl.dev/service --format json | jq -r .TYPEORM_URL
```

### Pick an entry without typing its URL

Bash completion that resolves an entry with `fzf` and inserts it into the command line:

```sh
source <(kpx completion)       # in ~/.bashrc

doit() {
  local dsn
  dsn=$(kpx get "$1" -f DB_URL) || return
  psql "$dsn"
}
kpx_complete_link_for doit     # doit <Tab> → keepassxc://by-uuid/<uuid>
```

### Inspect entries

```sh
kpx list                # all entries: URL, title, UUID
kpx list wsl.dev        # entries whose URL or title contains wsl.dev
```

### Check or repair the connection

```sh
kpx status              # proxy path, KeePassXC version, database state, association
kpx associate           # create a new association (confirm in KeePassXC)
```

`kpx status` exits non-zero when the proxy is missing or the association is not valid.

## Command reference

Details and restrictions per command.

### get

`kpx get <url>` prints one field: `password` (default), `login`, `name`, `uuid`, `totp`, or any `KPH: <NAME>` attribute by its `<NAME>`. On a terminal the value ends with a newline; when piped it does not, so it can be used in `$(...)` as is.

### Filters

`--name` (supports `*`), `--login`, `--group` and `--uuid` narrow the entry for `get`, `env` and `run`. Without filters, if more than one entry matches, the command exits with code 3 and prints the list.

### env

- `--format env|json`, default `env` (dotenv, compatible with `node --env-file` and `node:util.parseEnv`). Quoting is chosen so the value round-trips exactly; if a value cannot be represented losslessly, the command fails before printing any data. Use `json` for such values.
- `--prefix P` adds a prefix to variable names.
- `--only A,B` prints only the listed attributes.
- `--with-login VAR` and `--with-password VAR` add the entry login and password.
- Attributes whose names are not valid environment variable names are skipped with a warning.

The `env` format is meant for a dotenv parser, not for `eval` or `source`: dotenv values may contain syntax that the shell would execute. To pass attributes to a process, use `run`.

With `> .env`, the file is created by the shell. `umask 077` in the example protects the new file; for an existing file, check its permissions and run `chmod 600 .env` if needed.

### run

Entry attributes are passed into the command environment. The command exit code is returned as the `kpx` exit code.

`--only A,B` limits which attributes are passed. Without it, all attributes with valid names are passed. Attributes override same-named variables from the current environment, including `PATH`, `NODE_OPTIONS`, `LD_PRELOAD` and `BASH_ENV`, and can affect the executed code. For shared entry editing, set an explicit list of trusted variables.

### list

`kpx list [fragment]` prints metadata for all entries in the connected database — URL, title and UUID, one entry per line, fields separated by tabs. The fragment filters entries by a case-insensitive substring of the URL or title:

```sh
kpx list                # all entries
kpx list wsl.dev        # entries whose URL or title contains wsl.dev
```

KeePassXC returns the entry list through the `get-database-entries` request, so enable **Browser Integration → Advanced → "Allow limited access to all entries in connected databases (ignores site access restrictions)"**, otherwise the request is denied. Available since KeePassXC 2.8.

### Entry completion

Completion lives in a separate Bash script, `completions/kpx.bash`, and is not part of the CLI logic: it only calls `kpx list` and feeds the result to `fzf`. `kpx completion` prints that file, so the script has a single source of truth and can be edited or sourced directly.

The helpers work for any command whose first argument is an entry, and the name may be repeated to attach several commands at once.

`fzf` must be installed. Enable a helper with:

```sh
source <(kpx completion)       # add to ~/.bashrc
kpx_complete_link_for doit     # inserts keepassxc://by-uuid/<uuid>
kpx_complete_url_for  doit     # inserts the plain entry URL
```

After that, `doit wsl.dev` + <kbd>Tab</kbd> opens the list of entries matching the fragment. `kpx_complete_link_for` inserts the chosen entry as the unambiguous `keepassxc://by-uuid/<uuid>`, which resolves regardless of the entry URL or the "best-matching-only" setting. `kpx_complete_url_for` inserts the entry URL itself, which is friendlier in shell history but resolves by URL (ambiguous when several entries share it).

The completion calls the CLI as `kpx`; if it is not on `PATH`, set `KPX_CMD`. When running through `pnpm`, add `--silent`, otherwise the pnpm banner ends up in the list:

```sh
export KPX_CMD="pnpm --silent kpx"                          # only from the project directory
export KPX_CMD="node /path/to/keepassxc-wsl/dist/cli.js"    # from anywhere
```

A wrapper example is in [Pick an entry without typing its URL](#pick-an-entry-without-typing-its-url).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | general error |
| 2 | entry not found |
| 3 | ambiguous selection |
| 4 | database locked (unlock timeout) |
| 5 | association rejected |

Secrets are written only to stdout. Diagnostics go to stderr and can be silenced with `--quiet` (`-q`). Errors are always printed.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KPX_PROXY` | `/mnt/c/Program Files/KeePassXC/keepassxc-proxy.exe` | path to the proxy |
| `KPX_CONFIG` | `~/.config/kpx/assoc.json` | association file |
| `KPX_TIMEOUT` | `30` | regular request timeout, seconds |
| `KPX_UNLOCK_TIMEOUT` | `120` | wait for unlock and confirmation, seconds |
| `KPX_CMD` | `kpx` | CLI command used by the completion script |

## Associations

Associations are stored in `~/.config/kpx/assoc.json` with mode 600; the directory is created with mode 700. For each database an `id` and `idKey` pair is stored. Although `idKey` was obtained as a public key, the protocol accepts the pair as an access token without proof of possession of the corresponding private key. Therefore `assoc.json` is a secret: a copy of it can reproduce the association whenever browser integration is reachable. Entry access still depends on KeePassXC settings and confirmations.

Do not publish this file and do not include it in diagnostic attachments or unencrypted backups. Session private keys are generated at startup and never written to disk. The CLI targets a trusted local WSL environment: file permissions do not isolate it from other processes running as the same user.

## Revoking access

In KeePassXC: database settings → Browser Integration → remove the association created by `kpx`. The local association file can be removed manually: `rm ~/.config/kpx/assoc.json`.

## Development

```sh
pnpm dev     # tsc --watch
pnpm lint
pnpm test
pnpm build
```

The integration test against real KeePassXC is run manually: `KPX_E2E=1 pnpm test`.
