#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  die "Usage: ${0##*/} [--check] <git-ref> | --rollback <folder>"
}

mode=install
case ${1-} in
  --check | --rollback)
    mode=${1#--}
    shift
    ;;
  -*) usage ;;
esac
[[ $# -eq 1 ]] || usage
target=$1

home_dir=$(realpath -e -- "${HOME:?Set HOME first}")
[[ "$home_dir" != / && -d "$home_dir" ]] || die "HOME must be a user directory."
config_dir=$home_dir/.config/opencode
config=$config_dir/opencode.json
db=$config_dir/ensemble.db
pins=$home_dir/.local/share/opencode/pinned-plugins
swarm=$home_dir/.agents/skills/ensemble-swarm
ensemble=$config_dir/skills/opencode-ensemble

# Keep every managed path inside this home and reject redirected destinations.
check_path() {
  local path=$1
  [[ "$path" == "$home_dir/"* && "$(realpath -m -- "$path")" == "$path" ]] ||
    die "Unexpected path or symlink: $path"
}

for path in "$config" "$db" "$pins" "$swarm" "$ensemble"; do
  check_path "$path"
done
[[ -f "$config" && -f "$db" && -d "$pins" && -d "${swarm%/*}" && -d "${ensemble%/*}" ]] ||
  die "Expected OpenCode config, Ensemble database, pin directory, and both skill parent directories."

require_idle() {
  local status active
  if pgrep -x 'opencode(\.exe)?' >/dev/null; then
    die "Close OpenCode before changing the pin."
  else
    status=$?
    [[ $status -eq 1 ]] || die "Could not check running OpenCode processes."
  fi
  if pgrep -f '^([^[:space:]]*/)?opencode(\.exe)?([[:space:]]|$)' >/dev/null; then
    die "Close OpenCode before changing the pin."
  else
    status=$?
    [[ $status -eq 1 ]] || die "Could not check running OpenCode processes."
  fi
  active=$(sqlite3 -readonly -batch -bail -init /dev/null -noheader -cmd '.timeout 5000' "$db" \
    "SELECT EXISTS (SELECT 1 FROM team WHERE status = 'active');") ||
    die "Could not read Ensemble team status."
  [[ "$active" == 0 ]] || die "Finish all active Ensemble teams before changing the pin."
}

# Prepare the new skill beside its destination before moving the current copy.
replace_skill() {
  local source=$1 dest=$2 temp
  check_path "$dest"
  temp=$(mktemp -d -- "${dest%/*}/.ensemble-skill.XXXXXX")
  if ! cp -a -- "$source" "$temp/new"; then
    rm -rf -- "$temp"
    die "Could not prepare skill: $dest"
  fi
  if [[ -e "$dest" ]] && ! mv -T -- "$dest" "$temp/previous"; then
    rm -rf -- "$temp"
    die "Could not move the skill at $dest."
  fi
  if ! mv -T -- "$temp/new" "$dest"; then
    if [[ -d "$temp/previous" ]]; then
      mv -T -- "$temp/previous" "$dest" || die "Previous skill is at $temp/previous."
    fi
    rm -rf -- "$temp"
    die "Could not install skill: $dest"
  fi
  rm -rf -- "$temp"
}

replace_config() {
  local source=$1 temp
  check_path "$config"
  temp=$(mktemp -- "$config_dir/.opencode.json.XXXXXX")
  if ! cp -p -- "$source" "$temp" || ! mv -T -- "$temp" "$config"; then
    rm -f -- "$temp"
    die "Could not replace $config."
  fi
}

# jq variables must remain literal until jq evaluates the filter.
# shellcheck disable=SC2016
pin_filter='
  def pin_path:
    if type == "string" then . elif type == "object" then .package else null end;
  def is_ensemble_pin:
    pin_path | if type == "string" then
      startswith($prefix) and (ltrimstr($prefix) | test("^[a-f0-9]{40}$"))
    else false end;
  def old_pin:
    [.plugins[] | select(is_ensemble_pin) | pin_path] |
    if length == 1 then .[0] else error("Expected exactly one pinned Ensemble entry in plugins") end;
'

validate_configured_pin() {
  local previous
  previous=$(jq -er --arg prefix "$pins/ensemble-" "$pin_filter old_pin" "$1")
  check_path "$previous"
  [[ -d "$previous" ]] || die "Configured Ensemble pin is missing: $previous"
}

if [[ "$mode" == rollback ]]; then
  folder=${target##*/}
  if [[ "$folder" =~ ^[a-f0-9]{40}$ ]]; then
    folder=rollback-$folder
  fi
  [[ "$folder" =~ ^rollback-[a-f0-9]{40}$ ]] || die "Expected a rollback folder or full commit SHA."
  backup=$pins/$folder
  [[ "$target" != */* || "$target" == "$backup" ]] || die "Rollback folder must be inside $pins."
  for path in "$backup/opencode.json" "$backup/ensemble.db" "$backup/ensemble-swarm/SKILL.md" "$backup/opencode-ensemble/SKILL.md"; do
    check_path "$path"
    [[ -f "$path" ]] || die "Incomplete rollback folder: $backup"
  done
  validate_configured_pin "$backup/opencode.json"
  require_idle
  (
    cd -- "$backup"
    sqlite3 -batch -bail -init /dev/null -cmd '.timeout 5000' "$db" '.restore ensemble.db'
  )
  replace_skill "$backup/ensemble-swarm" "$swarm"
  replace_skill "$backup/opencode-ensemble" "$ensemble"
  replace_config "$backup/opencode.json"
  printf 'Restored OpenCode and Ensemble from %s\n' "$backup"
  exit
fi

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
sha=$(git -C "$repo" rev-parse --verify --end-of-options "$target^{commit}") || die "Expected a commit in $repo."
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || die "Invalid Git commit SHA."
pin=$pins/ensemble-$sha
backup=$pins/rollback-$sha
for path in "$pin" "$backup"; do
  check_path "$path"
  [[ ! -e "$path" ]] || die "Already exists: $path"
done
[[ -f "$swarm/SKILL.md" && -f "$ensemble/SKILL.md" ]] || die "Expected both installed skills to back up."

validate_configured_pin "$config"

printf 'Build Ensemble %s in %s\nBack up config, database and skills to %s\nReplace %s and both installed skills\n' \
  "$sha" "$pin" "$backup" "$config"
if [[ "$mode" == check ]]; then
  printf '%s\n' "Installation requires OpenCode closed and all Ensemble teams inactive."
  exit 0
fi
require_idle

stage=$(mktemp -d -- "$pins/.ensemble-install.XXXXXX")
saved=
cleanup() {
  local status=$?
  rm -rf -- "$stage"
  if [[ $status -ne 0 && -n "$saved" ]]; then
    printf 'Rollback folder available: %s\n' "$saved" >&2
  fi
}
trap cleanup EXIT

mkdir -- "$stage/pin" "$stage/backup"
git -C "$repo" archive "$sha" | tar -xf - -C "$stage/pin"
new_swarm=$stage/pin/skills-drafts/ensemble-swarm
new_ensemble=$stage/pin/.agents/skills/opencode-ensemble
[[ -f "$new_swarm/SKILL.md" && -f "$new_ensemble/SKILL.md" && -f "$stage/pin/bin/ensemble-wait.py" ]] ||
  die "Commit $sha is missing a skill or the waiter."
(
  cd -- "$stage/pin"
  bun install --frozen-lockfile --production
  bun run build
)
[[ -f "$stage/pin/dist/index.js" ]] || die "The Ensemble build did not produce dist/index.js."

require_idle
cp -p -- "$config" "$stage/backup/opencode.json"
cp -a -- "$swarm" "$ensemble" "$stage/backup/"
(
  cd -- "$stage/backup"
  sqlite3 -readonly -batch -bail -init /dev/null -cmd '.timeout 5000' "$db" '.backup ensemble.db'
)
jq -e --arg prefix "$pins/ensemble-" --arg pin "$pin" \
  "$pin_filter old_pin as \$old | .plugins |= map(
    if pin_path == \$old then
      if type == \"object\" then .package = \$pin else \$pin end
    else . end)" \
  "$stage/backup/opencode.json" >"$stage/opencode.json"
chmod --reference="$stage/backup/opencode.json" -- "$stage/opencode.json"

mv -T -- "$stage/backup" "$backup"
saved=$backup
mv -T -- "$stage/pin" "$pin"
replace_skill "$pin/skills-drafts/ensemble-swarm" "$swarm"
replace_skill "$pin/.agents/skills/opencode-ensemble" "$ensemble"
replace_config "$stage/opencode.json"
printf 'Installed %s\nRollback folder: %s\n' "$pin" "$backup"
