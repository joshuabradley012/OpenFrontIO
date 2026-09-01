#!/usr/bin/env bash
# Run a lab sweep on throwaway Hetzner Cloud servers — one box, or a pool of WORKERS boxes pulling games
# from one longest-expected-first queue on the first box (scripts/lab/sweep.sh QUEUE=…), so no box idles
# while another still has games. Results are merged locally.
#
#   CONFIGS='{"base":{},"early":{"botsAfterWild":false}}' MINUTES=20 WORKERS=4 scripts/lab/remote.sh
#
# Env: CONFIGS, MINUTES (20), WORKERS (1), SERVER_TYPE (cpx62 — dedicated CCX types are refused on this
# account), LOCATION (ash), NAME (openfront-lab; workers are NAME-1..N when WORKERS>1), IMAGE (snapshot
# id/name from scripts/lab/snapshot.sh; "auto" = newest snapshot labelled lab-image=1, "none" = plain
# ubuntu-24.04 + cloud-init; default auto), DEST (local results dir, default ./lab-out), KEEP=1 to leave
# the boxes running, REUSE=1 to use running boxes with those names, BATCHES / SPAWNS / JOBS pass through
# to sweep.sh, as do SHIFT, MIRROR / MIRRORSHIFT / MIRRORSEED (mirrored slots), SEED (opponent field), and the
# game-side knobs TRIBES, EXPAND, EVERY, BOT_DIR (tests/lab/playbook.lab.ts reads them); STAGED=1 runs the
# first STAGE1 (3) batches, then the rest only for an unclear verdict (summarize.py --verdict VERDICT, default 3);
# SPRT=1 (implies staged) keeps adding chunks of STAGE1 batches from BATCHES then EXTRA (med5..med9), up to
# MAXBATCHES (10), until summarize.py's sequential test (--sprt, DELTA = its --delta) says ACCEPT or REJECT for
# every config vs the first one. Needs: hcloud CLI with a context selected, ~/.ssh/id_ed25519(.pub), rsync.
#
# Every box carries the labels lab=1,pool=NAME:  hcloud server list -l lab=1  shows strays;
#   hcloud server delete $(hcloud server list -l lab=1 -o noheader -o columns=name)  removes them all.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${CONFIGS:?set CONFIGS}"
MINUTES=${MINUTES:-20}
WORKERS=${WORKERS:-1}
# cpx62@fsn1: same 16 shared vCPU as cpx51 but €0.25/h vs €0.45 and measured ~12 % faster per game
# (2026-08-30). cpx51 exists only in ash/hil; pass SERVER_TYPE/LOCATION for those.
SERVER_TYPE=${SERVER_TYPE:-cpx62}
LOCATION=${LOCATION:-fsn1}
NAME=${NAME:-openfront-lab}
IMAGE=${IMAGE:-auto}
# IPV6=1: boxes without a public IPv4 (Hetzner caps the account at 4 primary IPv4s; IPv6-only boxes are not counted),
# reached over IPv6 from this machine (needs IPv6 here: curl -6 https://ifconfig.co). rsync needs the [addr] form.
IPV6=${IPV6:-0}
# Plain ifs: `X=$([ … ] && echo …)` returns the test's exit status when the test fails, and under set -e
# that aborted the whole script silently for the default IPV6=0.
IPV6_FLAG=; IPFLAG=
if [ "$IPV6" = 1 ]; then IPV6_FLAG=--without-ipv4; IPFLAG=-6; fi
# macOS rsync (2.6.9) cannot parse user@[v6]:path, so an IPv6 box is addressed as the dummy host "lab6" with ssh -o HostName=<addr>
rh() { case "$1" in *:*) echo "lab6";; *) echo "$1";; esac; }
rso() { case "$1" in *:*) echo "-o HostName=$1";; esac; }
DEST=${DEST:-$PWD/lab-out}
KEY_NAME=${KEY_NAME:-$(whoami)-lab}
# Throwaway boxes get recycled IPs, so host keys are neither pinned nor remembered.
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes"
SSH="ssh $SSH_OPTS -o ConnectTimeout=10 root"
TIMEOUT=$(command -v timeout >/dev/null && echo "timeout 60" || true)   # coreutils; brew install coreutils on macOS
RSYNC_SSH="ssh $SSH_OPTS"

if [ "$WORKERS" -eq 1 ]; then names=("$NAME"); else names=(); for i in $(seq 1 "$WORKERS"); do names+=("$NAME-$i"); done; fi

if ! hcloud ssh-key describe "$KEY_NAME" >/dev/null 2>&1; then
  hcloud ssh-key create --name "$KEY_NAME" --public-key-from-file ~/.ssh/id_ed25519.pub >/dev/null
fi

ARCH=$(hcloud server-type describe "$SERVER_TYPE" -o "format={{.Architecture}}")
if [ "$IMAGE" = auto ]; then
  IMAGE=$(hcloud image list --type snapshot -l lab-image=1 -a "$ARCH" -o noheader -o columns=id,created | sort -k2 | tail -1 | awk '{print $1}')
  [ -n "$IMAGE" ] || IMAGE=none
fi

declare -a ips
if [ "${REUSE:-0}" = 1 ]; then
  for n in "${names[@]}"; do ips+=("$(hcloud server ip $IPFLAG "$n")"); done
  echo "reusing ${names[*]} (${ips[*]})"
else
  cat > /tmp/lab-cloud-init.yml <<'CI'
#cloud-config
package_update: true
packages: [rsync, git, build-essential]
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  - apt-get install -y nodejs
  - touch /root/.lab-ready
CI
  if [ "$IMAGE" = none ]; then
    echo "creating $WORKERS x $SERVER_TYPE in $LOCATION from ubuntu-24.04 (cloud-init installs Node; ~3 min) ..."
    for n in "${names[@]}"; do
      hcloud server create --name "$n" --type "$SERVER_TYPE" --image ubuntu-24.04 --location "$LOCATION" \
        --ssh-key "$KEY_NAME" --label lab=1 --label "pool=$NAME" $IPV6_FLAG --user-data-from-file /tmp/lab-cloud-init.yml >/dev/null &
    done
  else
    echo "creating $WORKERS x $SERVER_TYPE in $LOCATION from snapshot $IMAGE (~1 min) ..."
    for n in "${names[@]}"; do
      hcloud server create --name "$n" --type "$SERVER_TYPE" --image "$IMAGE" --location "$LOCATION" \
        --ssh-key "$KEY_NAME" --label lab=1 --label "pool=$NAME" $IPV6_FLAG >/dev/null &
    done
  fi
  wait
  for n in "${names[@]}"; do
    hcloud server describe "$n" >/dev/null 2>&1 || { echo "server $n was not created (see errors above; cpx51 exists only in ash/hil, cpx62/cx53 in the EU) — deleting the rest"; for m in "${names[@]}"; do hcloud server delete "$m" >/dev/null 2>&1 || true; done; exit 1; }
    ips+=("$(hcloud server ip $IPFLAG "$n")")
  done
  echo "servers: ${names[*]} at ${ips[*]}; waiting for ssh/cloud-init ..."
  for ip in "${ips[@]}"; do until $SSH@"$ip" test -f /root/.lab-ready 2>/dev/null; do sleep 5; done; done
fi

echo "syncing tree to ${#ips[@]} box(es) ..."
sync_one() {
  # Only what the lab needs: sources, tests, package files, and the World map manifest (the .bin maps come
  # from tests/testdata). Everything else is 2 GB. .claude holds other agents' worktrees — full copies of the
  # tree that vitest's path filter would also run.
  rsync -az --delete -e "$RSYNC_SSH $(rso "$1")" \
    --include 'resources/' --include 'resources/maps/' --include 'resources/maps/world/' \
    --include 'resources/maps/world/manifest.json' --include 'resources/lang/' --include 'resources/lang/**' \
    --include 'resources/*.json' --exclude 'resources/**' \
    --exclude node_modules --exclude .git --exclude .claude --exclude static --exclude lab-out --exclude dist \
    --exclude map-generator --exclude proprietary --exclude docs --exclude '*.log' \
    ./ root@"$(rh "$1")":/root/openfront/
  # npm run inst when node_modules is missing or the lock file changed since the last install on this box
  $SSH@"$1" 'cd /root/openfront && { [ -d node_modules ] && cmp -s package-lock.json node_modules/.lab-lock; } || { npm run inst >/tmp/inst.log 2>&1 && cp package-lock.json node_modules/.lab-lock; }'
}
for ip in "${ips[@]}"; do sync_one "$ip" & done; wait

# One pull queue for the whole pool: workers on every box claim games from box 1 over ssh with a
# throwaway key, so a fast box drains what a slow one has not started (the old static shards left the
# pool ~35 % idle at the end of full-game sweeps). Single box: the queue stays local, no key needed.
QUEUE_HOST=${ips[0]}
if [ "${#ips[@]}" -gt 1 ]; then
  QKEY=$(mktemp -d)/lab_queue
  ssh-keygen -q -t ed25519 -N "" -f "$QKEY"
  for ip in "${ips[@]}"; do
    rsync -az -e "$RSYNC_SSH $(rso "$ip")" "$QKEY" root@"$(rh "$ip")":/root/.ssh/lab_queue &
  done; wait
  $SSH@"$QUEUE_HOST" "cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/lab_queue && mkdir -p /etc/ssh/sshd_config.d && printf 'MaxStartups 300\nMaxSessions 100\n' > /etc/ssh/sshd_config.d/90-lab.conf && (systemctl reload ssh || systemctl reload sshd || true)" < "$QKEY.pub"
  for ip in "${ips[@]}"; do [ "$ip" = "$QUEUE_HOST" ] || $SSH@"$ip" 'chmod 600 /root/.ssh/lab_queue' & done; wait
fi

# Launch one shard per box, detached, so a dropped ssh session (or a killed local shell) cannot take the
# sweep down with it. /root/lab-out is cleared first: with REUSE a stale game from an earlier sweep with the
# same config name would otherwise be merged into this one.
# run_pool BATCHES: one sweep of the given batches over every box (one shard each), pulled into DEST.
run_pool() {
  local batches=$1 slug; slug=$(echo "$batches" | tr ' ' '-')
  echo "running sweep on ${#ips[@]} box(es) ..."
  mkdir -p "$DEST"
  # Build the job queue locally, longest-expected-first (the duration history lives here, not on the
  # boxes), and deliver it to the queue box. sweep.sh QUEUE_READY=1 consumes it without rebuilding.
  python3 scripts/lab/durations.py "${HISTORY:-lab-out}" > "$DEST/durations.tsv" 2>/dev/null || : > "$DEST/durations.tsv"
  env CONFIGS="$CONFIGS" BATCHES="$batches" ${SPAWNS:+SPAWNS="$SPAWNS"} ${MIRROR:+MIRROR=$MIRROR} \
    DURATIONS="$DEST/durations.tsv" LIST=1 SPRT=0 STAGED=0 bash scripts/lab/sweep.sh > "$DEST/queue.$slug.txt"
  if awk -F'|' 'NF<4 {exit 1}' "$DEST/queue.$slug.txt"; then :; else echo "ERROR: malformed line in $DEST/queue.$slug.txt"; exit 1; fi
  echo "  queue: $(wc -l < "$DEST/queue.$slug.txt" | tr -d ' ') games, longest first"
  # Clear the boxes only on the FIRST stage of a run: a later stage's wipe destroys any not-yet-pulled
  # transcripts from the previous stage if the launcher dies mid-pull (hard1 lost 36 games this way —
  # jobs are config-ordered, so one config's tail finishes last and is pulled last). Batch-named files
  # cannot collide across stages of one run.
  if [ "${POOL_STAGE:-0}" = 0 ]; then for ip in "${ips[@]}"; do $SSH@"$ip" 'rm -rf /root/lab-out && mkdir -p /root/lab-out' & done; wait; fi
  POOL_STAGE=$((${POOL_STAGE:-0} + 1))
  rsync -az -e "$RSYNC_SSH $(rso "$QUEUE_HOST")" "$DEST/queue.$slug.txt" root@"$(rh "$QUEUE_HOST")":/root/lab-out/queue.txt
  # The launch runs in a subshell as a setsid/nohup'd background job, so sshd has nothing left to wait for
  # and ssh returns at once. (A bare `nohup … &` made ssh block until the whole sweep finished, which
  # serialised the shards.) `timeout` is belt and braces: a hung ssh cannot stall the other launches.
  for ip in "${ips[@]}"; do
    q=local; [ "$ip" = "$QUEUE_HOST" ] || q=$QUEUE_HOST
    $TIMEOUT $SSH@"$ip" "cd /root/openfront && (setsid nohup env CONFIGS='$CONFIGS' MINUTES=$MINUTES QUEUE=$q QUEUE_READY=1 AGGREGATE=0 BATCHES='$batches' ${SPAWNS:+SPAWNS='$SPAWNS'} ${JOBS:+JOBS=$JOBS} ${SHIFT:+SHIFT=$SHIFT} ${MIRROR:+MIRROR=$MIRROR} ${MIRRORSHIFT:+MIRRORSHIFT=$MIRRORSHIFT} ${MIRRORSEED:+MIRRORSEED=$MIRRORSEED} ${SEED:+SEED=$SEED} ${TRIBES:+TRIBES=$TRIBES} ${EXPAND:+EXPAND=$EXPAND} ${EVERY:+EVERY=$EVERY} ${BOT_DIR:+BOT_DIR='$BOT_DIR'} OUT=/root/lab-out bash scripts/lab/sweep.sh > /root/lab-out/sweep.log 2>&1 < /dev/null &); sleep 1; head -1 /root/lab-out/sweep.log" \
      || echo "WARNING: launch on $ip did not confirm; check /root/lab-out/sweep.log there"
  done
  sleep 3
  running() {
    local out rc=1
    for ip in "${ips[@]}"; do
      out=$($SSH@"$ip" 'pgrep -f "[s]cripts/lab/sweep.sh" >/dev/null && echo yes || echo no' 2>/dev/null) || out=""
      case "$out" in yes) return 0;; no) ;; *) rc=2;; esac
    done
    return $rc
  }
  count() {
    local d=0 f=0 k=0 x
    for ip in "${ips[@]}"; do
      x=$($SSH@"$ip" 'grep -c "^done" /root/lab-out/sweep.log; true' 2>/dev/null); d=$((d + ${x:-0}))
      x=$($SSH@"$ip" 'grep -c "^FAILED" /root/lab-out/sweep.log; true' 2>/dev/null); f=$((f + ${x:-0}))
      x=$($SSH@"$ip" 'grep -c "^SKIPPED" /root/lab-out/sweep.log; true' 2>/dev/null); k=$((k + ${x:-0}))
    done
    echo "$d done, $f failed${k:+, $k skipped}"
  }
  fails=0
  while :; do
    rc=0; running || rc=$?
    if [ "$rc" = 0 ]; then
      fails=0; c=$(count)
      # Poll every 10 s so the end of a sweep (and each racing stage) is seen promptly, but only log a
      # line when the counts move — the old 60 s cadence added ~1 min of dead time per stage.
      [ "$c" != "${lastc:-}" ] && { echo "  $(date +%H:%M) $c"; lastc=$c; }
      sleep 10; continue
    fi
    if [ "$rc" = 2 ]; then
      fails=$((fails + 1))
      if [ "$fails" -ge 10 ]; then echo "ERROR: a box has not answered ssh for $fails polls; results not pulled, boxes kept: ${names[*]} (${ips[*]})"; exit 1; fi
      echo "  $(date +%H:%M) ssh did not answer ($fails/10), retrying"; sleep 30; continue
    fi
    break
  done
  echo "  $(date +%H:%M) $(count) — finished"
  
  mkdir -p "$DEST"
  i=0
  for ip in "${ips[@]}"; do
    rsync -az -e "$RSYNC_SSH $(rso "$ip")" --exclude sweep.log --exclude 'sed*' --exclude 'queue*' root@"$(rh "$ip")":/root/lab-out/ "$DEST"/ || [ $? -eq 24 ]
    rsync -az -e "$RSYNC_SSH $(rso "$ip")" root@"$(rh "$ip")":/root/lab-out/sweep.log "$DEST"/sweep.$slug.$i.log
    i=$((i + 1))
  done
  cat "$DEST"/sweep.*.log > "$DEST"/sweep.log
  bash scripts/lab/aggregate.sh "$DEST"
}

BATCHES=${BATCHES:-"med0 med1 med2 med3 med4"}
cfgs=$(node -e 'console.log(Object.keys(JSON.parse(process.argv[1])).join(" "))' "$CONFIGS")
# run_sprt: sequential A/B with OVERLAPPED stages. One sweep.sh per box lives for the whole test and pulls
# from one queue that this side tops up: the next chunk's games are appended the moment the current chunk's
# queue drains (every game claimed, the ramp-down tail still running), so the pool never idles. A chunk's
# verdict is taken when its own games are all in; a decision stops the sweep (the already-running games of
# the next chunk are killed — their transcripts are only written at the end, so nothing partial lands).
# Before this each chunk drained the pool before the next began, and a stage's wall was its single longest
# game (8–12 min vs a 5–6 min ideal at 120 slots — ~40 % of the wall was tail; boat1/fix1, 2026-08-30).
run_sprt() {
  set -- $BATCHES ${EXTRA:-med5 med6 med7 med8 med9}; local max=${MAXBATCHES:-10} step=${STAGE1:-3}
  local -a chunks=() files=(); local n chunk slug played=0
  while [ $# -gt 0 ] && [ "$played" -lt "$max" ]; do
    n=$step; [ $((played + n)) -gt "$max" ] && n=$((max - played))
    chunk=$(echo "$@" | cut -d' ' -f1-$n); shift $n 2>/dev/null || set --
    chunks+=("$chunk"); played=$((played + n))
  done
  echo "running overlapped sprt on ${#ips[@]} box(es): ${#chunks[@]} chunks (${chunks[*]// /,}) ..."
  mkdir -p "$DEST"
  python3 scripts/lab/durations.py "${HISTORY:-lab-out}" > "$DEST/durations.tsv" 2>/dev/null || : > "$DEST/durations.tsv"
  for chunk in "${chunks[@]}"; do
    slug=$(echo "$chunk" | tr ' ' '-')
    env CONFIGS="$CONFIGS" BATCHES="$chunk" ${SPAWNS:+SPAWNS="$SPAWNS"} ${MIRROR:+MIRROR=$MIRROR} \
      DURATIONS="$DEST/durations.tsv" LIST=1 SPRT=0 STAGED=0 bash scripts/lab/sweep.sh > "$DEST/queue.$slug.txt"
    if awk -F'|' 'NF<4 {exit 1}' "$DEST/queue.$slug.txt"; then :; else echo "ERROR: malformed line in $DEST/queue.$slug.txt"; exit 1; fi
    files+=("$DEST/queue.$slug.txt")
  done
  # Clear the boxes only on the FIRST stage of a run: a later stage's wipe destroys any not-yet-pulled
  # transcripts from the previous stage if the launcher dies mid-pull (hard1 lost 36 games this way —
  # jobs are config-ordered, so one config's tail finishes last and is pulled last). Batch-named files
  # cannot collide across stages of one run.
  if [ "${POOL_STAGE:-0}" = 0 ]; then for ip in "${ips[@]}"; do $SSH@"$ip" 'rm -rf /root/lab-out && mkdir -p /root/lab-out' & done; wait; fi
  POOL_STAGE=$((${POOL_STAGE:-0} + 1))
  # enqueue <file>: append a chunk's games to the live queue under the workers' lock
  enqueue() {
    rsync -az -e "$RSYNC_SSH $(rso "$QUEUE_HOST")" "$1" root@"$(rh "$QUEUE_HOST")":/root/lab-out/queue.next.txt
    $SSH@"$QUEUE_HOST" 'cd /root/lab-out && touch queue.open && flock queue.lock sh -c "cat queue.next.txt >> queue.txt" && rm -f queue.next.txt'
  }
  queue_len() { $SSH@"$QUEUE_HOST" 'wc -l < /root/lab-out/queue.txt 2>/dev/null || echo 0' 2>/dev/null | tr -d ' ' || echo 0; }
  $SSH@"$QUEUE_HOST" 'mkdir -p /root/lab-out && touch /root/lab-out/queue.open && : > /root/lab-out/queue.txt'
  enqueue "${files[0]}"; echo "  chunk 1/${#chunks[@]} (${chunks[0]}): $(wc -l < "${files[0]}" | tr -d ' ') games queued"
  for ip in "${ips[@]}"; do
    q=local; [ "$ip" = "$QUEUE_HOST" ] || q=$QUEUE_HOST
    $TIMEOUT $SSH@"$ip" "cd /root/openfront && (setsid nohup env CONFIGS='$CONFIGS' MINUTES=$MINUTES QUEUE=$q QUEUE_READY=1 AGGREGATE=0 BATCHES='${chunks[0]}' ${SPAWNS:+SPAWNS='$SPAWNS'} ${JOBS:+JOBS=$JOBS} ${SHIFT:+SHIFT=$SHIFT} ${MIRROR:+MIRROR=$MIRROR} ${MIRRORSHIFT:+MIRRORSHIFT=$MIRRORSHIFT} ${MIRRORSEED:+MIRRORSEED=$MIRRORSEED} ${SEED:+SEED=$SEED} ${TRIBES:+TRIBES=$TRIBES} ${EXPAND:+EXPAND=$EXPAND} ${EVERY:+EVERY=$EVERY} ${BOT_DIR:+BOT_DIR='$BOT_DIR'} OUT=/root/lab-out bash scripts/lab/sweep.sh > /root/lab-out/sweep.log 2>&1 < /dev/null &); sleep 1; head -1 /root/lab-out/sweep.log" \
      || echo "WARNING: launch on $ip did not confirm; check /root/lab-out/sweep.log there"
  done
  # progress: the boxes' sweep.log lines, merged; a chunk is complete when every game of its queue file has one
  progress() { for ip in "${ips[@]}"; do $SSH@"$ip" 'cat /root/lab-out/sweep.log 2>/dev/null; true' 2>/dev/null; done > "$DEST/progress.log"; }
  chunk_left() { comm -23 <(awk -F'|' '{print $1" "$2" "$3}' "$1" | sort) <(grep -E '^(done|FAILED|SKIPPED) ' "$DEST/progress.log" | awk '{print $2" "$3" "$4}' | sort) | wc -l | tr -d ' '; }
  pull() { for ip in "${ips[@]}"; do rsync -az -e "$RSYNC_SSH $(rso "$ip")" --exclude sweep.log --exclude 'sed*' --exclude 'queue*' --exclude 'queue*' root@"$(rh "$ip")":/root/lab-out/ "$DEST"/ ; done; bash scripts/lab/aggregate.sh "$DEST" >/dev/null 2>&1 || true; }
  stop_all() {
    $SSH@"$QUEUE_HOST" 'cd /root/lab-out && rm -f queue.open && flock queue.lock sh -c ": > queue.txt"' || true
    for ip in "${ips[@]}"; do $SSH@"$ip" 'pkill -f "[s]cripts/lab/sweep.sh"; pkill -f "[t]ests/lab/playbook.lab.ts"; true' & done; wait
  }
  running_any() { local ip; for ip in "${ips[@]}"; do [ "$($SSH@"$ip" 'pgrep -f "[s]cripts/lab/sweep.sh" >/dev/null && echo yes || echo no' 2>/dev/null)" = yes ] && return 0; done; return 1; }
  local cur=0 next=1 fails=0 lastc="" decided=0 c left
  sleep 5
  while :; do
    if ! progress; then fails=$((fails + 1)); [ "$fails" -ge 10 ] && { echo "ERROR: boxes not answering; boxes kept: ${names[*]} (${ips[*]})"; exit 1; }; sleep 30; continue; fi
    fails=0
    c="$(grep -c '^done' "$DEST/progress.log" || true) done, $(grep -c '^FAILED' "$DEST/progress.log" || true) failed"
    [ "$c" != "$lastc" ] && { echo "  $(date +%H:%M) $c"; lastc=$c; }
    # top up: the current queue has drained (every game claimed) and a chunk is waiting
    if [ "$next" -lt "${#chunks[@]}" ] && [ "$(queue_len)" = 0 ]; then
      enqueue "${files[$next]}"; echo "  $(date +%H:%M) chunk $((next + 1))/${#chunks[@]} (${chunks[$next]}) queued behind the tail"; next=$((next + 1))
    fi
    left=$(chunk_left "${files[$cur]}")
    if [ "$left" = 0 ]; then
      pull
      echo "  $(date +%H:%M) chunk $((cur + 1))/${#chunks[@]} complete ($(( (cur + 1) * step > max ? max : (cur + 1) * step )) batches played)"
      if python3 scripts/lab/summarize.py --sprt ${DELTA:+--delta $DELTA} --verdict 0 "$DEST" $cfgs; then
        echo "sprt: decided after chunk $((cur + 1))"; decided=1; stop_all; break
      fi
      cur=$((cur + 1))
      if [ "$cur" -ge "${#chunks[@]}" ]; then echo "sprt: still CONTINUE after $max batches (MAXBATCHES=$max)"; break; fi
      # the last chunk is in the queue: let the workers drain and exit
      [ "$next" -ge "${#chunks[@]}" ] && $SSH@"$QUEUE_HOST" 'rm -f /root/lab-out/queue.open' || true
      continue
    fi
    # nothing running anywhere (crash?) — stop polling
    if ! running_any; then echo "  $(date +%H:%M) no sweep.sh running on any box"; break; fi
    sleep 10
  done
  [ "$decided" = 1 ] || { $SSH@"$QUEUE_HOST" 'rm -f /root/lab-out/queue.open' || true; }
  pull
  echo "  $(date +%H:%M) $(grep -c '^done' "$DEST/progress.log" || true) done — finished"
}

if [ "${SPRT:-0}" = 1 ]; then
  run_sprt
elif [ "${STAGED:-0}" = 1 ]; then
  # Staged A/B: run the first STAGE1 batches, and only run the rest when some config is still "unclear"
  # (|wins - losses| < VERDICT vs the first config). Clear winners and losers cost ~40 % fewer games.
  set -- $BATCHES; n=${STAGE1:-3}
  first=$(echo "$@" | cut -d' ' -f1-$n); rest=$(echo "$@" | cut -d' ' -f$((n + 1))-)
  run_pool "$first"
  if python3 scripts/lab/summarize.py --verdict "${VERDICT:-3}" "$DEST" $cfgs; then
    echo "stage 1 verdict clear for every config after $n batches; skipping: ${rest:-nothing}"
  elif [ -z "$rest" ]; then
    echo "stage 2: no batches left (BATCHES has only $n)"   # an empty BATCHES='' would make sweep.sh play its whole default grid
  else
    echo "stage 2: $rest"
    run_pool "$rest"
    python3 scripts/lab/summarize.py --verdict "${VERDICT:-3}" "$DEST" $cfgs || true
  fi
else
  run_pool "$BATCHES"
fi
echo "results in $DEST"

if [ "${KEEP:-0}" != 1 ]; then
  for n in "${names[@]}"; do hcloud server delete "$n" >/dev/null && echo "server $n deleted"; done
else
  echo "servers kept: ${names[*]} (${ips[*]}); delete with: hcloud server delete ${names[*]}"
fi
