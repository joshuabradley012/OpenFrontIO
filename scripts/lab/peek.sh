#!/usr/bin/env bash
# Peek at a running remote sweep: pull the boxes' partial transcripts, aggregate, and print the win table.
#   scripts/lab/peek.sh openfront-boat            # pool NAME used for remote.sh (boxes NAME-1..N)
#   watch -n 120 scripts/lab/peek.sh openfront-boat
set -euo pipefail
cd "$(dirname "$0")/../.."
POOL=${1:?usage: peek.sh <pool name>}
OUT=${OUT:-lab-out/peek-$POOL}
mkdir -p "$OUT"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o ConnectTimeout=10"
for n in $(hcloud server list -l "pool=$POOL" -o noheader -o columns=name); do
  ip4=$(hcloud server ip "$n" 2>/dev/null || true); ip6=$(hcloud server ip -6 "$n" 2>/dev/null || true)
  if [ -n "$ip4" ]; then
    rsync -az -e "ssh $SSH_OPTS" --exclude sweep.log root@"$ip4":/root/lab-out/ "$OUT"/ &
  else
    rsync -az -e "ssh $SSH_OPTS -o HostName=$ip6" --exclude sweep.log root@lab6:/root/lab-out/ "$OUT"/ &
  fi
done; wait
bash scripts/lab/aggregate.sh "$OUT" >/dev/null 2>&1 || true
python3 scripts/lab/summarize.py "$OUT" 2>/dev/null | grep -E "^config|^[a-z0-9]+ +[0-9]+ |wins .* vs" || echo "no finished games yet"
