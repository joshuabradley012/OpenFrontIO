#!/usr/bin/env bash
# Box-side lab sweep. Runs every (config × batch × spawn) game in parallel with the bare-node runner
# (tests/lab/playbook.lab.ts), retries a failed game once, and aggregates each config/batch into
# ab30_<config>_<batch>.txt via aggregate.sh (the format summarize.py reads).
#
#   CONFIGS='{"base":{},"early":{"botsAfterWild":false}}' MINUTES=20 JOBS=16 scripts/lab/sweep.sh
#
# Env: CONFIGS (JSON name -> PlaybookParams overrides), MINUTES (game length, default 20), JOBS (parallel
# games, default 1.5 x nproc — pass it explicitly on macOS), OUT (result dir, default ./lab-out), BATCHES /
# SPAWNS (subset of the grid), RUNNER=node|vitest (default node; vitest = the old `npx vitest` path, ~2 s
# slower a game), AGGREGATE=0 to skip aggregation (remote.sh aggregates after merging the boxes).
#
# Scheduling: the games form one queue ($OUT/queue.txt) ordered longest-expected-first (DURATIONS: a
# "batch spawn seconds" file from scripts/lab/durations.py; default: generated from ./lab-out when it
# exists; slots without history go first), and JOBS workers pull from it — so the long games start early
# and the ramp-down tail at the end of a sweep is short. Across boxes the queue lives on one box:
# QUEUE=<host> makes the workers claim over ssh (key /root/.ssh/lab_queue, installed by remote.sh),
# QUEUE=local (default) claims from the local file. QUEUE_READY=1 says the queue file was delivered by
# remote.sh — don't rebuild it. LIST=1 prints the ordered job list and exits (remote.sh builds the
# queue locally, where the history is). SHARD=i/N (every N-th game) is still honoured when building.
# A game whose first attempt dies with "no spawn near" (the region has no spawn at that rank — e.g.
# australia rank >= 3) is SKIPPED, not retried: the failure is deterministic. Other failures retry once.
# A config value {"__bot":"<tag>"} plays an extracted milestone bot instead of today's: the lab loads
# .history/<tag>/src/core/execution/playbook (scripts/lab/history.sh, scripts/lab/versions/HISTORY.md) and
# strips the key from the params, so one sweep can put several bot versions on the same batches/seeds
# (node runner only; the vitest runner compiles with vite, not tsx).
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
# LIST=1 always prints the ordered job list for the given BATCHES and exits — even when the caller's
# environment carries SPRT=1 (remote.sh's own SPRT loop builds each chunk's queue through LIST; on
# 2026-08-30 the SPRT branch ran first and its banner + summarize output were captured into the queue,
# which workers then claimed as jobs — "unknown batch").
if [ "${SPRT:-0}" = 1 ] && [ "${LIST:-0}" != 1 ]; then
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
QUEUE=${QUEUE:-local}
QUEUE_FILE=$OUT/queue.txt
QUEUE_LOCK=$OUT/queue.lock
mkdir -p "$OUT"
: "${CONFIGS:?set CONFIGS to a JSON object of name -> params}"

SPAWNS=${SPAWNS:-"north-russia north-america east-asia africa south-america australia"}
# Medium-only until the bot is strong (Josh, 2026-08-29): 6 regions x spawn ranks 0-4.
# Hard batches (hard0..hard4) still work when asked for via BATCHES.
BATCHES=${BATCHES:-"med0 med1 med2 med3 med4"}

# build_list: every (config, batch, spawn) game in a fixed order, ordered longest-expected-first when
# durations are known (stable within equal/unknown expectations, so the grid order survives as a tiebreak).
build_list() {
  local names name params batch slots slot sp i=0 shard_i=${SHARD%/*} shard_n=${SHARD#*/} tmp
  names=$(node -e "for (const k of Object.keys(JSON.parse(process.argv[1]))) console.log(k)" "$CONFIGS")
  tmp=$(mktemp)
  for name in $names; do
    params=$(node -e "console.log(JSON.stringify(JSON.parse(process.argv[1])[process.argv[2]]))" "$CONFIGS" "$name")
    for batch in $BATCHES; do
      slots=$batch; [ "${MIRROR:-0}" = 1 ] && slots="$batch ${batch}b"
      for slot in $slots; do
        for sp in $SPAWNS; do
          [ $((i % shard_n)) -eq "$shard_i" ] && echo "$name|$slot|$sp|$params" >> "$tmp"
          i=$((i + 1))
        done
      done
    done
  done
  local dur=${DURATIONS:-}
  if [ -z "$dur" ] && [ -d lab-out ] && command -v python3 >/dev/null; then
    dur=$(mktemp); python3 scripts/lab/durations.py lab-out > "$dur" 2>/dev/null || : > "$dur"
  fi
  if [ -n "$dur" ] && [ -s "$dur" ]; then
    # decorate with -expected seconds (unknown slot = -1e9 → first), stable sort, strip
    awk -F'|' -v D="$dur" 'BEGIN { while ((getline l < D) > 0) { split(l, a, " "); e[a[1] " " a[2]] = a[3] } }
      { k = $2 " " $3; printf "%d\t%d\t%s\n", (k in e ? -e[k] : -1000000000), NR, $0 }' "$tmp" | sort -t$'\t' -k1,1n -k2,2n | cut -f3-
  else
    cat "$tmp"
  fi
  rm -f "$tmp"
}

if [ "${LIST:-0}" = 1 ]; then build_list; exit 0; fi
if [ "${QUEUE_READY:-0}" != 1 ] && [ "$QUEUE" = local ]; then build_list > "$QUEUE_FILE"; fi
if [ "$QUEUE" = local ]; then
  echo "sweep: $(wc -l < "$QUEUE_FILE" | tr -d ' ') games queued, $JOBS parallel, $MINUTES min each, runner $RUNNER -> $OUT"
else
  echo "sweep: pulling from queue on $QUEUE, $JOBS parallel, $MINUTES min each, runner $RUNNER -> $OUT"
fi

# claim: pop the first line of the queue under a lock; empty output = queue drained. The flock form is
# what remote workers run over ssh, so the queue box's own workers use the same lock; the mkdir spinlock
# is the macOS fallback (no flock there — local sweeps only, never mixed with ssh claimants).
CLAIM_CMD="flock $QUEUE_LOCK sh -c 'j=\$(head -n1 $QUEUE_FILE 2>/dev/null); [ -n \"\$j\" ] && sed -i 1d $QUEUE_FILE; printf %s \"\$j\"'"
claim_local() {
  if command -v flock >/dev/null; then bash -c "$CLAIM_CMD"; return; fi
  local j
  until mkdir "$QUEUE_LOCK.d" 2>/dev/null; do sleep 0.05; done
  j=$(head -n1 "$QUEUE_FILE" 2>/dev/null)
  if [ -n "$j" ]; then tail -n +2 "$QUEUE_FILE" > "$QUEUE_FILE.t" && mv "$QUEUE_FILE.t" "$QUEUE_FILE"; fi
  rmdir "$QUEUE_LOCK.d"
  printf %s "$j"
}
claim() {
  if [ "$QUEUE" = local ]; then claim_local; return; fi
  local n rc out
  for n in 1 2 3 4 5; do
    out=$(ssh -i /root/.ssh/lab_queue -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o ConnectTimeout=15 root@"$QUEUE" "$CLAIM_CMD"); rc=$?
    [ $rc -eq 0 ] && { printf %s "$out"; return 0; }
    sleep $((n * 2))   # sshd MaxStartups or a blip: back off and retry
  done
  echo "claim from $QUEUE failed 5 times; worker stops" >&2; return 1
}

export MINUTES OUT RUNNER MIRRORSHIFT="${MIRRORSHIFT:-150}" MIRRORSEED="${SEED:-}${MIRRORSEED:-b}"
run_job() {
  local name batch sp params slot senv benv err
  IFS="|" read -r name batch sp params <<< "$1"
  slot=${batch%b}; senv=""; [ "$slot" != "$batch" ] && senv="SHIFT=$MIRRORSHIFT SEED=$MIRRORSEED"   # med0b = slot b: shifted grid, other opponent field
  case $slot in
    hard[0-9]) benv="SPAWNRANK=${slot#hard}";;
    med[0-9]) benv="DIFF=medium SPAWNRANK=${slot#med}";;
    g[0-9]) benv="GLOBAL=1 DIFF=medium SPAWNRANK=${slot#g}";;      # global picker ranks 6k..6k+5 (Medium)
    gh[0-9]) benv="GLOBAL=1 SPAWNRANK=${slot#gh}";;                # same on Hard
    *) echo "unknown batch $batch"; return 1;;
  esac
  benv="$benv $senv"
  err="$OUT/.err_${name}_${batch}_${sp}"
  run() {
    if [ "$RUNNER" = vitest ]; then
      # --dir tests: a bare path filter also matches copies under .claude/worktrees/ (one game per copy)
      env $benv PARAMS="$params" MIN="$MINUTES" SPAWN="$sp" LAB_OUT="$OUT" OUTFILE="p_${name}_${batch}_${sp}.txt" TAG="${name}_${batch}" \
        npx vitest --dir tests tests/lab/playbook.lab.test.ts --run > "$err" 2>&1
    else
      env $benv PARAMS="$params" MIN="$MINUTES" SPAWN="$sp" LAB_OUT="$OUT" OUTFILE="p_${name}_${batch}_${sp}.txt" TAG="${name}_${batch}" \
        node --import tsx tests/lab/playbook.lab.ts > "$err" 2>&1
    fi
  }
  if run; then rm -f "$err"; echo "done $name $batch $sp"; return 0; fi
  if grep -q "no spawn near" "$err"; then rm -f "$err"; echo "SKIPPED $name $batch $sp (no spawn at this rank in the region)"; return 0; fi
  echo "retry $name $batch $sp"
  if run; then rm -f "$err"; echo "done $name $batch $sp"; else echo "FAILED $name $batch $sp (see $err)"; fi
}
worker() {
  local job
  sleep "$(( RANDOM % 5 ))"   # spread the first claims (one sshd, JOBS x boxes workers)
  while job=$(claim) && [ -n "$job" ]; do run_job "$job"; done
}
for _ in $(seq 1 "$JOBS"); do worker & done
wait

rm -f "$OUT/lab_baseline.txt" "$QUEUE_LOCK"; rmdir "$QUEUE_LOCK.d" 2>/dev/null || true
if [ "${AGGREGATE:-1}" = 1 ]; then bash scripts/lab/aggregate.sh "$OUT"; fi
echo "sweep complete"
