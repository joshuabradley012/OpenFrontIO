#!/usr/bin/env python3
"""Tempo-gap analysis over lab transcripts (read-only).

Per game (p_*.txt): winner, end minute, BOMB events (tick), ATTACK war waves (tick),
first `build Missile Silo`, first MIRV RISK mention of an enemy with a silo
(canFire or saving — proxy for enemy silo appearance; MirvRisk logs it periodically).
"""
import glob, re, sys
from collections import defaultdict

DIRS = ["/Users/josh/Code/openfront/lab-out/hard1", "/Users/josh/Code/openfront/lab-out/salv2"]

games = []
for d in DIRS:
    for f in sorted(glob.glob(d + "/p_*.txt")):
        txt = open(f, errors="replace").read()
        m = re.search(r"FINAL .*?winner=(\S+)", txt)
        if not m:
            continue
        winner = m.group(1)
        # sim end time: last status line "  NNNs "
        times = re.findall(r"^\s+(\d+)s bots=", txt, re.M)
        end_min = int(times[-1]) / 60 if times else None
        events = txt.split("|")
        bombs, attacks, annex = [], [], []
        first_silo = first_enemy_silo = first_mirv_risk = None
        mirved = None
        for ev in events:
            tm = re.match(r"\s*t(\d+) (.*)", ev)
            if not tm:
                continue
            t, body = int(tm.group(1)), tm.group(2)
            if body.startswith("BOMB "):
                bombs.append(t)
            elif body.startswith("ATTACK "):
                attacks.append(t)
            elif body.startswith("ANNEX WAR "):
                annex.append(t)
            elif body.startswith("build Missile Silo") and first_silo is None:
                first_silo = t
            elif body.startswith("MIRV RISK"):
                if first_mirv_risk is None:
                    first_mirv_risk = t
                if first_enemy_silo is None and ("can fire (" in body or "saving (" in body):
                    first_enemy_silo = t
            elif body.startswith("MIRVED by") and mirved is None:
                mirved = t
        games.append(dict(f=f, dir=d.split("/")[-1], winner=winner, end_min=end_min,
                          bombs=bombs, attacks=attacks, annex=annex,
                          first_silo=first_silo, first_enemy_silo=first_enemy_silo,
                          mirved=mirved))

n = len(games)
wins = [g for g in games if g["winner"] == "us"]
print(f"games={n} wins={len(wins)} ({100*len(wins)/n:.0f}%)  dirs=" +
      ",".join(f"{d.split('/')[-1]}:{sum(1 for g in games if g['dir']==d.split('/')[-1])}" for d in DIRS))

def dist(vals, label, unit="min"):
    vals = sorted(vals)
    if not vals:
        print(f"{label}: none"); return
    def pct(p): return vals[min(len(vals)-1, int(p*len(vals)))]
    print(f"{label}: n={len(vals)} min={vals[0]:.0f} p25={pct(.25):.0f} med={pct(.5):.0f} p75={pct(.75):.0f} max={vals[-1]:.0f} {unit}")

dist([g["end_min"] for g in wins], "win-minute")
# histogram of win minutes in 12-min buckets
h = defaultdict(int)
for g in wins: h[int(g["end_min"] // 12) * 12] += 1
print("win-minute hist (12-min buckets):", " ".join(f"{k}-{k+12}:{v}" for k, v in sorted(h.items())))

# bombs per game by minute bucket (10-min), avg over all games
bk = defaultdict(float)
for g in games:
    for t in g["bombs"]: bk[int(t/600//10)*10] += 1
print("\nbombs/game by minute bucket (all games):")
print("  " + " ".join(f"{k}-{k+10}m:{v/n:.2f}" for k, v in sorted(bk.items())))
tot = [len(g["bombs"]) for g in games]
print(f"  total bombs/game: mean={sum(tot)/n:.1f}  games with 0 bombs: {sum(1 for x in tot if x==0)}/{n}")

dist([g["bombs"][0]/600 for g in games if g["bombs"]], "first bomb minute")
dist([g["first_silo"]/600 for g in games if g["first_silo"]], "our first silo minute")
dist([g["first_enemy_silo"]/600 for g in games if g["first_enemy_silo"]],
     "first enemy silo seen (MIRV-RISK saving/canFire proxy)")
# enemy silo before our first bomb?
both = [g for g in games if g["first_enemy_silo"]]
beat = [g for g in both if not g["bombs"] or g["bombs"][0] > g["first_enemy_silo"]]
print(f"enemy silo (proxy) before our first bomb: {len(beat)}/{len(both)} games where enemy silo seen")
dist([(g["bombs"][0] - g["first_enemy_silo"])/600 for g in both if g["bombs"]],
     "our-first-bomb minus enemy-silo-seen")

# war waves preceded by a bomb within 100 ticks
pre, tot_w, games_any = 0, 0, 0
for g in games:
    bs = g["bombs"]
    for a in g["attacks"] + g["annex"]:
        tot_w += 1
        if any(0 <= a - b <= 100 for b in bs): pre += 1
print(f"\nwar waves preceded by a bomb within 10s: {pre}/{tot_w} ({100*pre/max(1,tot_w):.1f}%)")
waves = [len(g["attacks"]) + len(g["annex"]) for g in games]
print(f"war waves/game: mean={sum(waves)/n:.1f}")
dist([g["attacks"][0]/600 for g in games if g["attacks"]], "first war wave minute")

mirved = [g for g in games if g["mirved"]]
print(f"\ngames MIRVed: {len(mirved)}/{n}; of those we still won: {sum(1 for g in mirved if g['winner']=='us')}")
dist([g["mirved"]/600 for g in mirved], "first MIRVED minute")

# wins vs losses: bombs before minute 20
early = lambda g: sum(1 for t in g["bombs"] if t < 20*600)
w20 = [early(g) for g in wins]; l20 = [early(g) for g in games if g["winner"] != "us"]
print(f"bombs before min 20: wins mean={sum(w20)/max(1,len(w20)):.2f}, losses mean={sum(l20)/max(1,len(l20)):.2f}")
