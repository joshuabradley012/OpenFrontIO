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
# compact by default: one line per config sorted by wins (PAIRS=1 adds the paired win lines)
python3 scripts/lab/summarize.py "$OUT" 2>/dev/null | awk -v pairs="${PAIRS:-0}" '
  /^config /{hdr=1; next}
  /^  .* wins .* vs/{ if (pairs=="1") print; next }
  /^[a-z0-9_]+ +[0-9]+ +[0-9]+/ && hdr { n=NF; printf "%-10s %3s games  %3s wins  %5s  score %s\n", $1, $2, $(n-2), $(n-1), $(n-3) }
' | sort -k4 -n -r || echo "no finished games yet"
