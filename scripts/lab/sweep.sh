#!/usr/bin/env bash
# Box-side lab sweep. Runs every (config × batch × spawn) game in parallel with the bare-node runner
# (tests/lab/playbook.lab.ts), retries a failed game once, and aggregates each config/batch into
# ab30_<config>_<batch>.txt via aggregate.sh (the format summarize.py reads).
#
#   CONFIGS='{"base":{},"early":{"botsAfterWild":false}}' MINUTES=20 JOBS=16 scripts/lab/sweep.sh
#
# Env: CONFIGS (JSON name -> PlaybookParams overrides), MINUTES (game length, default 20), JOBS (parallel
# games, default nproc — pass it explicitly on macOS), OUT (result dir, default ./lab-out), BATCHES /
# SPAWNS (subset of the grid), SHARD=i/N (run only every N-th game, i in 0..N-1 — remote.sh gives each
# worker box one shard of the same job list; the results directories are merged and aggregated locally),
# RUNNER=node|vitest (default node; vitest = the old `npx vitest` path, ~2 s slower a game),
# AGGREGATE=0 to skip aggregation (remote.sh aggregates after merging shards).
#
# Common random numbers: a lab game is fully determined by (batch, spawn, SHIFT, SEED) — gameID "lab"+SEED
# seeds the nations, tribes and the bot (tests/lab/playbook.lab.ts), so every config of one sweep meets the
# identical world and only the bot's own decisions differ. MIRROR=1 plays every (batch, spawn) twice: batch
# `med0` at SHIFT/SEED as given and batch `med0b` at SHIFT=MIRRORSHIFT (150) with SEED=${SEED}MIRRORSEED ("b") —
# the two "slots" of a scenario (same region, other opponent field: the picker's 250-tile search radius means a
# 150-tile shift alone often re-picks the same tile), which summarize.py averages into one paired observation
# (its pentanomial line). SEED=n (default empty) changes the opponent field (nation personalities, tribe
# placement) for the whole sweep.
# SPRT=1: sequential A/B — play the batch pool (BATCHES then EXTRA, default med5..med9) in chunks of STAGE1 (3)
# batches and stop as soon as `summarize.py --sprt --verdict` has decided ACCEPT/REJECT for every config vs the
# first one, or after MAXBATCHES (10) batches (mirrored slots count as one batch).
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${SPRT:-0}" = 1 ]; then
  # Sequential loop: re-enter this script per chunk with SPRT unset; the results dir accumulates and
  # aggregate.sh is idempotent over it.
  pool="${BATCHES:-med0 med1 med2 med3 med4} ${EXTRA:-med5 med6 med7 med8 med9}"
  set -- $pool; max=${MAXBATCHES:-10}; step=${STAGE1:-3}; played=0
  names=$(node -e "console.log(Object.keys(JSON.parse(process.argv[1])).join(' '))" "$CONFIGS")
  while [ $# -gt 0 ] && [ "$played" -lt "$max" ]; do
    n=$step; [ $((played + n)) -gt "$max" ] && n=$((max - played))
    chunk=$(echo "$@" | cut -d' ' -f1-$n); shift $n 2>/dev/null || set --
    echo "sprt: chunk '$chunk' ($played batches played so far)"
    SPRT=0 BATCHES="$chunk" bash scripts/lab/sweep.sh
    played=$((played + n))
    if python3 scripts/lab/summarize.py --sprt ${DELTA:+--delta $DELTA} --verdict 0 "${OUT:-$PWD/lab-out}" $names; then
      echo "sprt: decided after $played batches"; exit 0
    fi
  done
  echo "sprt: still CONTINUE after $played batches (MAXBATCHES=$max)"; exit 0
fi
MINUTES=${MINUTES:-20}
# 1.5 x vCPUs: on a cpx51 (16 shared vCPU) 24 parallel gave 46 games/min vs 42 at 16 and 30 at 8
# (2026-08-30 bench, 5-min games); each game is slower under oversubscription but throughput is higher.
JOBS=${JOBS:-$(( $(nproc 2>/dev/null || sysctl -n hw.ncpu) * 3 / 2 ))}
OUT=${OUT:-$PWD/lab-out}
RUNNER=${RUNNER:-node}
SHARD=${SHARD:-0/1}
mkdir -p "$OUT"
: "${CONFIGS:?set CONFIGS to a JSON object of name -> params}"

SPAWNS=${SPAWNS:-"north-russia north-america east-asia africa south-america australia"}
# Medium-only until the bot is strong (Josh, 2026-08-29): 6 regions x spawn ranks 0-4.
# Hard batches (hard0..hard4) still work when asked for via BATCHES.
BATCHES=${BATCHES:-"med0 med1 med2 med3 med4"}
names=$(node -e "for (const k of Object.keys(JSON.parse(process.argv[1]))) console.log(k)" "$CONFIGS")

# Job list in a fixed order (config, batch, spawn) so every shard of the same CONFIGS agrees on numbering.
jobs_file=$(mktemp)
i=0; shard_i=${SHARD%/*}; shard_n=${SHARD#*/}
for name in $names; do
  params=$(node -e "console.log(JSON.stringify(JSON.parse(process.argv[1])[process.argv[2]]))" "$CONFIGS" "$name")
  for batch in $BATCHES; do
    slots=$batch; [ "${MIRROR:-0}" = 1 ] && slots="$batch ${batch}b"
    for slot in $slots; do
      for sp in $SPAWNS; do
        [ $((i % shard_n)) -eq "$shard_i" ] && echo "$name|$slot|$sp|$params" >> "$jobs_file"
        i=$((i + 1))
      done
    done
  done
done
echo "sweep: $(wc -l < "$jobs_file") games (shard $SHARD of $i), $JOBS parallel, $MINUTES min each, runner $RUNNER -> $OUT"

export MINUTES OUT RUNNER MIRRORSHIFT="${MIRRORSHIFT:-150}" MIRRORSEED="${SEED:-}${MIRRORSEED:-b}"
# NUL-delimited: plain xargs strips the quotes out of the JSON params
tr '\n' '\0' < "$jobs_file" | xargs -0 -P "$JOBS" -I{} bash -c '
  IFS="|" read -r name batch sp params <<< "$1"
  slot=${batch%b}; senv=""; [ "$slot" != "$batch" ] && senv="SHIFT=$MIRRORSHIFT SEED=$MIRRORSEED"   # med0b = slot b: shifted grid, other opponent field
  case $slot in
    hard[0-9]) benv="SPAWNRANK=${slot#hard}";;
    med[0-9]) benv="DIFF=medium SPAWNRANK=${slot#med}";;
    g[0-9]) benv="GLOBAL=1 DIFF=medium SPAWNRANK=${slot#g}";;      # global picker ranks 6k..6k+5 (Medium)
    gh[0-9]) benv="GLOBAL=1 SPAWNRANK=${slot#gh}";;                # same on Hard
    *) echo "unknown batch $batch"; exit 1;;
  esac
  benv="$benv $senv"
  run() {
    if [ "$RUNNER" = vitest ]; then
      # --dir tests: a bare path filter also matches copies under .claude/worktrees/ (one game per copy)
      env $benv PARAMS="$params" MIN="$MINUTES" SPAWN="$sp" LAB_OUT="$OUT" OUTFILE="p_${name}_${batch}_${sp}.txt" TAG="${name}_${batch}" \
        npx vitest --dir tests tests/lab/playbook.lab.test.ts --run > "$OUT/.err_${name}_${batch}_${sp}" 2>&1
    else
      env $benv PARAMS="$params" MIN="$MINUTES" SPAWN="$sp" LAB_OUT="$OUT" OUTFILE="p_${name}_${batch}_${sp}.txt" TAG="${name}_${batch}" \
        node --import tsx tests/lab/playbook.lab.ts > "$OUT/.err_${name}_${batch}_${sp}" 2>&1
    fi
  }
  if run || { echo "retry $name $batch $sp"; run; }; then rm -f "$OUT/.err_${name}_${batch}_${sp}"; echo "done $name $batch $sp"
  else echo "FAILED $name $batch $sp (see $OUT/.err_${name}_${batch}_${sp})"; fi' _ {}

rm -f "$jobs_file" "$OUT/lab_baseline.txt"
if [ "${AGGREGATE:-1}" = 1 ]; then bash scripts/lab/aggregate.sh "$OUT"; fi
echo "sweep complete"
