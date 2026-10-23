# kpx

CLI for KeePassXC running on Windows, used from WSL. It fetches entry passwords, logins and attributes through browser integration (`keepassxc-proxy.exe`). Nothing needs to be typed on the WSL side beyond confirming access in KeePassXC.

## Installation

```sh
source ~/.nvm/nvm.sh
pnpm install
pnpm build
pnpm link --global
```

The default proxy path is `/mnt/c/Program Files/KeePassXC/keepassxc-proxy.exe`. Override it with the `KPX_PROXY` variable.

## KeePassXC setup

1. Enable Browser Integration: "Tools → Settings → Browser Integration".
2. Under "Advanced", enable "Return additional string fields with the 'KPH: ' prefix".
3. Enable "Return only best-matching credentials".
4. Optionally turn off the access prompt or select "Remember".

## Entry convention

- The URL field points to the resource, for example `wsl.dev/service`.
- Variables are stored in string attributes named `KPH: NAME`, for example `KPH: API_KEY`.

## Commands

```sh
kpx status                                   # proxy, KeePassXC version, database, association
kpx associate                                # re-associate kpx with the database (confirm in KeePassXC)
kpx get wsl.dev/service                      # entry password
kpx get wsl.dev/service -f API_KEY           # the KPH: API_KEY attribute
kpx get wsl.dev/service --name "Service *" --login admin
(umask 077; kpx env wsl.dev/service > .env)
eval "$(kpx env wsl.dev/service --format shell)"
kpx list wsl.dev                             # URL + title + uuid of entries matching the fragment
kpx render .env.tpl -o .env                  # substitute {{kp:…}} placeholders in a template
kpx run wsl.dev/service --only API_KEY,DB_URL -- pnpm dev
```

### Filters

`--name` (supports `*`), `--login`, `--group`, `--uuid`. Without filters, if more than one entry matches, the command exits with code 3 and prints the list.

Fields for `get -f`: `password` (default), `login`, `name`, `uuid`, `totp`, and any `KPH: <NAME>` attribute by its `<NAME>`.

### env

- `--format env|shell|json`, default `env` (dotenv, compatible with `node --env-file` and `node:util.parseEnv`). Quoting is chosen so the value round-trips exactly; if a value cannot be represented losslessly, the command fails before printing any data. Use `json` or `shell` for such values.
- `--prefix P` adds a prefix to variable names.
- `--only A,B` prints only the listed attributes.
- `--with-login VAR` and `--with-password VAR` add the entry login and password.
- Attributes whose names are not valid environment variable names are skipped with a warning.

The `env` format is meant for a dotenv parser. For `eval` or `source`, use only `--format shell`: dotenv values may contain syntax that the shell would execute.

With `> .env`, the file is created by the shell. `umask 077` in the example protects the new file; for an existing file, check its permissions and run `chmod 600 .env` if needed.

### render

Placeholder syntax: `{{kp:<url>#<field>}}` or with filters `{{kp:<url>#<field>?name=X&login=Y}}`. Text outside placeholders is copied as is. `\{{` emits a literal `{{`.

Entries are cached per URL and filter pair, so one URL needs only a single request and a single confirmation window. If any substitution fails, the file is not written and all errors go to stderr. The file is written atomically, with mode 600 by default (`--mode`).

Substitution is literal: values are not escaped for dotenv, JSON or shell. Use trusted templates and mind the target file syntax; to export variables in dotenv format use `env`.

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

`kpx completion` prints a Bash completion function that uses `fzf` to pick an entry and inserts it as the unambiguous `keepassxc://by-uuid/<uuid>` reference. It works for any command whose first argument is an entry.

`fzf` must be installed. Enable it with:

```sh
source <(kpx completion)    # add to ~/.bashrc
kpx_complete_link_for doit  # attach to your command
```

After that, `doit wsl.dev` + <kbd>Tab</kbd> opens the list of entries matching the fragment; the chosen one is inserted as `keepassxc://by-uuid/…`.

The completion calls the CLI as `kpx`; if it is not on `PATH`, set `KPX_CMD`. When running through `pnpm`, add `--silent`, otherwise the pnpm banner ends up in the list:

```sh
export KPX_CMD="pnpm --silent kpx"                          # only from the project directory
export KPX_CMD="node /path/to/keepassxc-wsl/dist/cli.js"    # from anywhere
```

Example wrapper that connects to a database with `psql`:

```sh
doit() {
  local dsn
  dsn=$(kpx get "$1" -f DB_URL) || return
  psql "$dsn"
}
```

With `doit wsl.dev` + <kbd>Tab</kbd>, an entry is selected and resolved via `keepassxc://by-uuid/…`, and `psql` connects using the `KPH: DB_URL` attribute of exactly that entry.

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

In KeePassXC: database settings → Browser Integration → remove the "wsl" key. The local association file can be removed manually: `rm ~/.config/kpx/assoc.json`.

## Development

```sh
pnpm dev     # tsc --watch
pnpm lint
pnpm test
pnpm build
```

The integration test against real KeePassXC is run manually: `KPX_E2E=1 pnpm test`.
