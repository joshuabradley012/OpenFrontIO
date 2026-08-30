#!/usr/bin/env bash
# Extract every milestone bot listed in scripts/lab/versions/HISTORY.md into .history/<tag>/ (gitignored) so
# today's lab harness can play an old bot against today's engine on today's grid:
#
#   scripts/lab/history.sh              # extract + type-check every milestone
#   scripts/lab/history.sh fold review  # just these tags
#   CHECK=0 scripts/lab/history.sh      # skip the tsc pass
#
# Layout: .history/<tag>/src/core/execution/playbook/*.ts is `git archive <hash>` of that directory (the
# single-file bots before the A2 module split are the same path). Everything the bot imports lives at
# ../ and ../../ (src/core/execution/* and src/core/*), so those entries are SYMLINKED into the copy —
# node and tsc realpath a symlink, so the old bot shares one module instance of the engine with the lab
# (same UnitType enum, same class identities). Shims for engine symbols that moved since are applied in
# shim_<tag>() below and listed in HISTORY.md; anything not listed there is byte-identical to the commit.
#
# tests/lab/playbook.lab.ts loads `${BOT_DIR}/PlaybookBotExecution.ts` when BOT_DIR is set, and sweep.sh's
# CONFIGS value {"__bot":"<tag>"} sets BOT_DIR=.history/<tag>/src/core/execution/playbook for that config.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
HIST=$ROOT/.history
MANIFEST=scripts/lab/versions/HISTORY.md

# tag → hash from the table in HISTORY.md (rows "| tag | hash | ...")
milestones() { grep -E '^\| *[a-z][a-z0-9-]* *\| *[0-9a-f]{7,} *\|' "$MANIFEST" | awk -F'|' '{gsub(/ /,"",$2); gsub(/ /,"",$3); print $2, $3}'; }

# --- per-version shims (keep them minimal; document every one in HISTORY.md) --------------------------
shim_common() { :; }   # nothing needed as of a0c59bd3e: every milestone compiles against today's engine

extract() {
  local tag=$1 hash=$2 dir=$HIST/$tag
  git cat-file -e "$hash^{commit}" || { echo "history: $tag: no such commit $hash"; return 1; }
  rm -rf "$dir"; mkdir -p "$dir"
  git archive "$hash" src/core/execution/playbook | tar -x -C "$dir"
  [ -f "$dir/src/core/execution/playbook/PlaybookBotExecution.ts" ] || { echo "history: $tag: no PlaybookBotExecution.ts at $hash"; return 1; }
  # engine symlinks: src/core/* except execution, src/core/execution/* except playbook
  for e in "$ROOT"/src/core/*; do n=$(basename "$e"); [ "$n" = execution ] && continue; ln -s "../../../../src/core/$n" "$dir/src/core/$n"; done
  for e in "$ROOT"/src/core/execution/*; do n=$(basename "$e"); [ "$n" = playbook ] && continue; ln -s "../../../../../src/core/execution/$n" "$dir/src/core/execution/$n"; done
  # the engine itself reaches src/client (Config → client/view) and resources/; tsc does not realpath the
  # symlinked engine files' own imports, so mirror those too
  for e in "$ROOT"/src/*; do n=$(basename "$e"); [ "$n" = core ] && continue; ln -s "../../../src/$n" "$dir/src/$n"; done
  for n in resources zbin generated proprietary; do [ -e "$ROOT/$n" ] && ln -s "../../$n" "$dir/$n"; done
  echo "$hash" > "$dir/COMMIT"
  shim_common "$tag" "$dir/src/core/execution/playbook"
  if declare -f "shim_${tag//-/_}" > /dev/null; then "shim_${tag//-/_}" "$dir/src/core/execution/playbook"; fi
  # Two tsconfigs. tsconfig.check.json is for tsc: the root options with the bot as the root file; the
  # engine is reached only through the symlinks (also for the src/* path alias) so every module has one
  # declaration, and the .d.ts files + Main.ts carry the ambient globals the client code needs.
  # tsconfig.json is for the RUN: tsx applies the root compiler options (useDefineForClassFields: false —
  # a bot whose field initialisers read this.p depends on it) only to files inside a tsconfig's include,
  # and .history/ is outside the root include, so the lab runs an old bot with TSX_TSCONFIG_PATH pointing
  # here (sweep.sh sets it for a {"__bot": tag} config; set it yourself with BOT_DIR).
  cat > "$dir/tsconfig.check.json" <<EOF
{ "extends": "../../tsconfig.json",
  "include": ["src/core/execution/playbook/*.ts", "src/**/*.d.ts", "src/client/Main.ts"],
  "compilerOptions": { "noEmit": true, "paths": { "resources/*": ["./resources/*"], "src/*": ["./src/*"] } } }
EOF
  cat > "$dir/tsconfig.json" <<EOF
{ "extends": "../../tsconfig.json",
  "include": ["src/core/execution/playbook/*.ts", "../../src/**/*", "../../tests/**/*", "../../zbin/**/*"],
  "compilerOptions": { "noEmit": true } }
EOF
  echo "history: $tag = $hash ($(ls "$dir/src/core/execution/playbook" | wc -l | tr -d ' ') files)"
}

check() {
  local tag=$1
  if npx tsc --noEmit -p "$HIST/$tag/tsconfig.check.json" > "$HIST/$tag/tsc.log" 2>&1; then echo "history: $tag: tsc clean"
  else echo "history: $tag: tsc FAILED ($(grep -c 'error TS' "$HIST/$tag/tsc.log") errors, see .history/$tag/tsc.log)"; return 1; fi
}

mkdir -p "$HIST"
want=("$@")
fail=0
while read -r tag hash; do
  if [ ${#want[@]} -gt 0 ]; then printf '%s\n' "${want[@]}" | grep -qx "$tag" || continue; fi
  extract "$tag" "$hash" || { fail=1; continue; }
  [ "${CHECK:-1}" = 1 ] && { check "$tag" || fail=1; }
done < <(milestones)
exit $fail
