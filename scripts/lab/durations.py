#!/usr/bin/env python3
"""Expected game length per (batch, spawn) from past lab transcripts, for longest-first scheduling.

    python3 scripts/lab/durations.py [history_dir ...]     # default: ./lab-out, recursive

Prints "batch spawn seconds" (mean gameMs of the newest transcripts of that slot). The order, not
the absolute value, is what sweep.sh uses: a slot's heaviness (big empire, long full game) is stable
across configs and game lengths, so the newest ~3000 transcripts of any length are a good predictor.
Slots with no history are scheduled first (assumed long) by sweep.sh.
"""
import glob, os, re, sys
from collections import defaultdict

SPAWNS = "north-russia north-america east-asia africa south-america australia".split()
dirs = sys.argv[1:] or ["lab-out"]
files = []
for d in dirs:
    files += glob.glob(os.path.join(d, "**", "p_*_*_*.txt"), recursive=True)
files.sort(key=os.path.getmtime, reverse=True)
acc = defaultdict(list)
for f in files[:3000]:
    name = os.path.basename(f)[2:-4]
    sp = next((s for s in SPAWNS if name.endswith("_" + s)), None)
    if sp is None:
        continue
    batch = name[: -len(sp) - 1].rsplit("_", 1)[-1]
    try:
        m = re.search(r"gameMs=(\d+)", open(f, errors="ignore").read())
    except OSError:
        continue
    if m:
        acc[(batch, sp)].append(int(m.group(1)) / 1000)
for (batch, sp), v in sorted(acc.items(), key=lambda kv: -sum(kv[1]) / len(kv[1])):
    print(f"{batch} {sp} {sum(v) / len(v):.0f}")
