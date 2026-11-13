# KeePassXC entry completion for kpx. Requires fzf: https://github.com/junegunn/fzf

# Ask readline to redraw the prompt after fzf closes (see the trailing
# printf '\e[5n' below). Same trick the stock fzf completion uses.
bind '"\e[0n": redraw-current-line' 2>/dev/null

# The kpx CLI is located via $KPX_CMD (default: "kpx"). Point it at your build
# if "kpx" is not on PATH, e.g. KPX_CMD="pnpm kpx" or
# KPX_CMD="node /path/to/keepassxc-wsl/dist/bin.js".

# Prompt for an entry with fzf and print the chosen line to stdout:
# "<url>\t<title>\t<uuid>", or nothing if the user cancels. fzf draws its UI on
# the terminal; --with-nth=1,2 shows only URL and title, while the returned line
# still carries the UUID in field 3. kpx list already filters by "$cur", so fzf
# gets the matching subset directly.
_kpx_pick_entry() {
  local cur="$1" kpx_cmd="${KPX_CMD:-kpx}"
  $kpx_cmd --quiet list "$cur" | fzf \
    --no-sort \
    --delimiter=$'\t' --nth=1,2 --with-nth=1,2 \
    --prompt='entry > ' --height=40%
}

# Completes the entry argument of a wrapper command with
# keepassxc://by-uuid/<uuid>, which kpx resolves unambiguously regardless of
# the entry URL or the "best-matching-only" setting.
_kpx_complete_link() {
  if [ "$COMP_CWORD" -gt 1 ]; then
    return 0
  fi

  local picked uuid
  picked="$(_kpx_pick_entry "${COMP_WORDS[COMP_CWORD]}")"
  printf '\e[5n'

  [ -z "$picked" ] && return 0

  uuid="${picked##*$'\t'}"
  [ -z "$uuid" ] && return 0

  COMPREPLY=("keepassxc://by-uuid/$uuid")
  return 0
}

# Completes the entry argument of a wrapper command with the plain entry URL.
_kpx_complete_url() {
  if [ "$COMP_CWORD" -gt 1 ]; then
    return 0
  fi

  local picked url
  picked="$(_kpx_pick_entry "${COMP_WORDS[COMP_CWORD]}")"
  printf '\e[5n'

  [ -z "$picked" ] && return 0

  url="${picked%%$'\t'*}"
  [ -z "$url" ] && return 0

  COMPREPLY=("$url")
  return 0
}

# Register completion for your own wrapper commands (NAME may be repeated):
#   source <(kpx completion)
#   kpx_complete_link_for doit          # inserts keepassxc://by-uuid/<uuid>
#   kpx_complete_url_for  doit psql     # inserts the plain entry URL
kpx_complete_link_for() {
  complete -o nospace -F _kpx_complete_link "$@"
}
kpx_complete_url_for() {
  complete -F _kpx_complete_url "$@"
}