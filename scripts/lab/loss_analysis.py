#!/usr/bin/env python3
"""Classify PlaybookBot full-game transcripts (lab-out/<dir>/p_base_*.txt) and
cluster the losses into causes. Stdlib only; re-runnable on later sweeps:

    python3 loss_analysis.py [dir=lab-out/rm1] [glob=p_base_*.txt]
"""
import glob as globmod
import os
import re
import statistics
import sys
from collections import Counter, defaultdict

ROW = re.compile(
    r"^\s+(\d+)s .*?tiles=\s*(\d+) .*?rank=(\d+)/(\d+) share=([\d.]+)"
)
WINNER = re.compile(r"^\s+WINNER (.+) at (\d+)s \((us|not us)\)")
DEAD = re.compile(r"^\s+DEAD at (\d+)s")
MIRVED = re.compile(r"t(\d+) MIRVED by (.+?) \(([^,)]+)")
WARRES = re.compile(
    r"t(\d+) WAR RESULT (.+?): \+(-?\d+) tiles, -(\d+) troops, (\d+) troops/tile"
)
FINISH = re.compile(r"t(\d+) FINISH mode (\w+) → (\w+)")
NAME = re.compile(r"p_base_(\w+?)_([a-z-]+)\.txt$")


def kv(line):
    return dict(re.findall(r"(\w+)=([^ ]+)", line))


def parse(path):
    g = {"file": os.path.basename(path), "rows": [], "winner": None,
         "winner_t": None, "dead_t": None, "final": {}, "log": "",
         "region": "?", "batch": "?"}
    m = NAME.search(os.path.basename(path))
    if m:
        g["batch"], g["region"] = m.group(1), m.group(2)
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("=="):
            g["region"] = line.split("|")[0].strip("= ").strip()
            sm = re.search(r"spawn (\d+,\d+)", line)
            g["spawn"] = sm.group(1) if sm else "?"
        elif (m := ROW.match(line)):
            g["rows"].append((int(m[1]), int(m[2]), int(m[3]), int(m[4]),
                              float(m[5])))
        elif (m := WINNER.match(line)):
            g["winner"], g["winner_t"] = m[1], int(m[2])
            g["winner_us"] = m[3] == "us"
        elif (m := DEAD.match(line)):
            g["dead_t"] = int(m[1])
        elif line.strip().startswith("FINAL "):
            g["final"] = kv(line)
        elif line.strip().startswith("log:"):
            g["log"] = line.split("log:", 1)[1]
    return g


def analyze(g):
    a = {}
    f = g["final"]
    a["mirvs_taken"] = int(f.get("mirvsTaken", 0))
    a["final_rank"] = int(f.get("rank", 99))
    a["final_share"] = float(f.get("share", 0))
    a["silos"] = int(f.get("silos", 0))
    a["sams"] = int(f.get("sams", 0))
    a["bombs"] = int(f.get("bombs", 0))
    # outcome
    if g["dead_t"] is not None and (g["winner_t"] is None
                                    or g["dead_t"] <= g["winner_t"]):
        a["outcome"] = "died"
    elif g.get("winner_us"):
        a["outcome"] = "won"
    elif g["winner"]:
        a["outcome"] = "alive-but-lost"
    else:
        a["outcome"] = "no-winner"          # time cap, nobody won
    rows = g["rows"]
    if rows:
        peak_t, peak_tiles = max(((t, ti) for t, ti, *_ in rows),
                                 key=lambda x: x[1])
        a["peak_min"] = peak_t // 60
        a["peak_tiles"] = peak_tiles
        a["end_frac_of_peak"] = rows[-1][1] / peak_tiles if peak_tiles else 0
        a["end_t"] = rows[-1][0]
        at600 = next((r for r in rows if r[0] >= 600), rows[-1])
        a["rank_10m"], a["tiles_10m"], a["share_10m"] = (at600[2], at600[1],
                                                         at600[4])
        # plateau: any 5-min window (10 rows) with <5% tile growth while rank>1
        a["plateau"] = False
        for i in range(len(rows) - 10):
            t0, ti0, r0, *_ = rows[i]
            t1, ti1, r1, *_ = rows[i + 10]
            if r0 > 1 and r1 > 1 and ti0 > 0 and (ti1 - ti0) / ti0 < 0.05:
                a["plateau"] = True
                a.setdefault("plateau_min", t0 // 60)
                break
    # log-derived
    a["mirved_rules"] = Counter(m[3] for m in MIRVED.finditer(g["log"]))
    a["mirved_by"] = Counter(m[2] for m in MIRVED.finditer(g["log"]))
    a["first_mirv_t"] = min((int(m[1]) for m in MIRVED.finditer(g["log"])),
                            default=None)
    wars = [(int(m[1]), m[2], int(m[3]), int(m[4]), int(m[5]))
            for m in WARRES.finditer(g["log"])]
    a["wars"] = len(wars)
    a["bad_wars"] = sum(1 for _, _, ti, _, tpt in wars
                        if ti <= 0 or tpt >= 500)
    a["war_troops_spent"] = sum(w[3] for w in wars)
    a["finish_push_t"] = min((int(m[1]) for m in FINISH.finditer(g["log"])
                              if m[3] == "push"), default=None)
    a["finish_flips"] = sum(1 for m in FINISH.finditer(g["log"]))
    a["boats"] = g["log"].count(" boat ")
    return a


def classify_loss(g, a):
    if a["outcome"] == "died":
        return ("died-early (<15 min, neighbour rush)"
                if g["dead_t"] < 900 else "died-late (collapsed after peak)")
    if a["mirvs_taken"] >= 3 and a["end_frac_of_peak"] < 0.75:
        return "MIRVed down (steamroll rule) after leading"
    if a["final_rank"] <= 3:
        return "lost endgame race despite top-3"
    if a["plateau"]:
        return "plateaued (stuck), outgrown by runaway winner"
    return "outgrown, never contended"


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "lab-out/rm1"
    pat = sys.argv[2] if len(sys.argv) > 2 else "p_base_*.txt"
    games = [parse(p) for p in sorted(globmod.glob(os.path.join(d, pat)))]
    res = [(g, analyze(g)) for g in games]

    print(f"== {len(games)} games from {d}/{pat} ==\n")
    # replicate detection: same spawn + same winner time = same simulation
    sig = defaultdict(list)
    for g, a in res:
        sig[(g.get("spawn"), g["winner"], g["winner_t"],
             g["final"].get("tiles"))].append(g["file"])
    dups = {k: v for k, v in sig.items() if len(v) > 1}
    if dups:
        ndup = sum(len(v) - 1 for v in dups.values())
        print(f"REPLICATES: {len(dups)} groups share spawn+outcome "
              f"({ndup} redundant games — spawn picker collapse):")
        for k, v in sorted(dups.items()):
            print(f"    spawn {k[0]} winner={k[1]}@{k[2]}s: {', '.join(v)}")
        print(f"  unique games: {len(sig)}\n")
    oc = Counter(a["outcome"] for _, a in res)
    print("OUTCOMES:", dict(oc))
    for label in ("no-winner",):
        sub = [a for _, a in res if a["outcome"] == label]
        if sub:
            r1 = sum(1 for a in sub if a["final_rank"] == 1)
            print(f"  no-winner detail: {r1}/{len(sub)} end rank 1 "
                  f"(dominant at time cap)")

    losses = [(g, a) for g, a in res if a["outcome"] in
              ("alive-but-lost", "died")]
    wins = [(g, a) for g, a in res if a["outcome"] == "won"]

    print(f"\nLOSS CLUSTERS ({len(losses)} losses):")
    clusters = defaultdict(list)
    for g, a in losses:
        clusters[classify_loss(g, a)].append((g, a))
    for c, items in sorted(clusters.items(), key=lambda x: -len(x[1])):
        regions = Counter(g["region"] for g, _ in items)
        print(f"  {len(items):3d}  {c}   regions={dict(regions)}")
        for g, a in items:
            w = g["winner"] or "-"
            print(f"        {g['file']:38s} winner={w:<18s} "
                  f"rank={a['final_rank']}/{a['final_share']:.2f} "
                  f"peak@{a.get('peak_min','?')}m end/peak="
                  f"{a.get('end_frac_of_peak',0):.2f} "
                  f"mirvs={a['mirvs_taken']} wars={a['wars']} "
                  f"badWars={a['bad_wars']} "
                  f"plateau@{a.get('plateau_min','-')}m")

    print("\nWINNER NAMES in losses:")
    wn = Counter(g["winner"] for g, _ in losses if g["winner"])
    for name, n in wn.most_common():
        print(f"  {n:2d}  {name}")

    print("\nMIRVED-BY rules across losses:",
          dict(sum((a["mirved_rules"] for _, a in losses), Counter())))
    print("MIRVED-BY rules across wins:  ",
          dict(sum((a["mirved_rules"] for _, a in wins), Counter())))

    def stats(items, key, fmt="{:.1f}"):
        vals = [a[key] for _, a in items if a.get(key) is not None]
        return fmt.format(statistics.mean(vals)) if vals else "-"

    print(f"\nWINS ({len(wins)}) vs LOSSES ({len(losses)}) — means:")
    for k in ("peak_min", "mirvs_taken", "wars", "bad_wars", "boats",
              "silos", "sams", "finish_flips", "end_frac_of_peak",
              "rank_10m", "tiles_10m", "share_10m"):
        print(f"  {k:18s} wins={stats(wins,k):>7s}  losses={stats(losses,k):>7s}")
    for label, items in (("wins", wins), ("losses", losses)):
        pt = [a["finish_push_t"] for _, a in items
              if a["finish_push_t"] is not None]
        n_pl = sum(1 for _, a in items if a.get("plateau"))
        print(f"  {label}: first FINISH-push at "
              f"{statistics.mean(pt)/60:.0f}m (n={len(pt)}), "
              f"plateaued={n_pl}/{len(items)}")

    print("\nPER-REGION win rate:")
    by_r = defaultdict(lambda: [0, 0])
    for g, a in res:
        by_r[g["region"]][0] += a["outcome"] == "won"
        by_r[g["region"]][1] += 1
    for r, (w, n) in sorted(by_r.items()):
        print(f"  {r:15s} {w:2d}/{n}")


if __name__ == "__main__":
    main()
