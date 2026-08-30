#!/usr/bin/env python3
"""Bot strength over time: read a history sweep (every config = one milestone bot from
scripts/lab/versions/HISTORY.md played on the same grid, `base` = today's bot), print one row per
version, write scripts/lab/versions/<tag>.json and draw lab-out/history.svg.

  python3 scripts/lab/history.py lab-out/hist              # all versions found in the dir, commit order
  python3 scripts/lab/history.py lab-out/hist rules fold   # a subset
  python3 scripts/lab/history.py --svg out.svg --no-write lab-out/hist

Per version: games, alive, crowns (rank 1 alive), median tiles, mean score (summarize.py's land + rank
+ crown) with a 95 % bootstrap CI over games, and the paired delta vs base over the games both played
(summarize.py's live_stats: wins/losses, mean dScore, sign test). Stdlib only; summarize.py is imported
for the parser and the score so the numbers match the lab's tables.
"""
import json
import os
import random
import re
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import summarize  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VDIR = os.path.join(ROOT, "scripts", "lab", "versions")
MANIFEST = os.path.join(VDIR, "HISTORY.md")
ROW_RE = re.compile(r"^\|\s*([a-z][a-z0-9-]*)\s*\|\s*([0-9a-f]{7,})\s*\|\s*([0-9-]+)\s*\|\s*(.*?)\s*\|\s*$")
BOOT_N = 2000


def milestones():
    """[(tag, hash, date, note)] in HISTORY.md (= commit) order."""
    out = []
    for line in open(MANIFEST):
        m = ROW_RE.match(line)
        if m:
            out.append(m.groups())
    return out


def median_ci(xs, n=BOOT_N, seed=0):
    """95 % percentile bootstrap of the median over games (tiles); the score's CI is summarize.bootstrap_ci."""
    if not xs:
        return (0.0, 0.0)
    rnd = random.Random(seed)
    vals = sorted(statistics.median(rnd.choices(xs, k=len(xs))) for _ in range(n))
    return (vals[int(0.025 * n)], vals[int(0.975 * n) - 1])


def stats(games):
    """summarize.summary's counts (games / alive / crowns / top3 — the same definitions as the lab tables) plus the
    per-game objective summarize.obj (score, or wscore = score + WIN_BONUS · winner=us once resolve_objective has seen a
    decided game) with summarize's bootstrap CI. A copy of these here had drifted (no winner=, its own crown and CI)."""
    vals = list(games.values())
    sm = summarize.summary(games)
    scores = [summarize.obj(g) for g in vals]
    tiles = [g["tiles"] for g in vals]
    return {
        "games": sm["games"],
        "alive": sm["alive"],
        "crowns": sm["crowns"],
        "top3": sm["top3"],
        "medianTiles": statistics.median(tiles) if tiles else 0,
        "tilesCI": median_ci(tiles),
        "meanTiles": statistics.fmean(tiles) if tiles else 0,
        "score": statistics.fmean(scores) if scores else 0.0,
        "scoreCI": summarize.bootstrap_ci(scores),
    }


def vs_base(base, games):
    if base is None or base is games:
        return None
    s = summarize.live_stats(games, base)
    if s["n"] == 0:
        return None
    return {"pairs": s["n"], "live": s["n_live"], "wins": s["wins"], "losses": s["losses"], "dScore": s["mean_diff"], "p": s["p"]}


def fmt_row(name, hash_, st, d):
    lo, hi = st["scoreCI"]
    vs = "-" if d is None else f"{d['wins']:>3}W {d['losses']:>3}L  {d['dScore']:+.3f}  p={d['p']:.2f}"
    return (f"{name:<10} {hash_[:9]:<10} {st['games']:>5} {st['alive']:>5} {st['crowns']:>6} {st['top3']:>5} "
            f"{int(st['medianTiles']):>9,} {st['score']:>7.3f} [{lo:.3f}, {hi:.3f}]  {vs}")


def write_version(tag, hash_, date, note, st, d, src):
    lo, hi = st["scoreCI"]
    doc = {
        "note": f"History milestone {tag} = playbook-bot {hash_} ({date}): {note}. Played by the lab at HEAD on {src}; "
                f"{'__bot selects the extracted copy (scripts/lab/history.sh)' if tag != 'base' else 'the shipped defaults'}.",
        "commit": hash_,
        "params": {} if tag == "base" else {"__bot": tag},
        "results": {
            "games": st["games"], "alive": st["alive"], "crowns": st["crowns"], "top3": st["top3"],
            "medianTiles": st["medianTiles"], "medianTilesCI": [round(v) for v in st["tilesCI"]], "meanTiles": round(st["meanTiles"]),
            "score": round(st["score"], 4), "scoreCI": [round(lo, 4), round(hi, 4)],
            "vsBase": None if d is None else {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items()},
        },
    }
    path = os.path.join(VDIR, f"{tag}.json")
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    return path


# --- chart ---------------------------------------------------------------------------------------------------
INK, MUTED, GRID, SURFACE = "#0b0b0b", "#52514e", "#e6e5e1", "#fcfcfb"
BLUE, AQUA = "#2a78d6", "#1baf7a"   # one hue per panel (a single series each: no legend needed)


def nice_ticks(lo, hi, n=4):
    span = max(hi - lo, 1e-9)
    raw = span / n
    mag = 10 ** int(f"{raw:e}".split("e")[1])
    step = next(s * mag for s in (1, 2, 2.5, 5, 10) if s * mag >= raw)
    t0 = int(lo // step) * step
    return [t0 + i * step for i in range(int((hi - t0) // step) + 2)]


def panel(y0, title, rows, key, ci_key, color, fmt, W, ML, MR, H):
    xs = [ML + (W - ML - MR) * (i + 0.5) / len(rows) for i in range(len(rows))]
    lo = min(min(r[ci_key]) for r in rows + [{ci_key: (0, 0)}])
    hi = max(max(r[ci_key]) for r in rows) * 1.05 or 1
    ticks = nice_ticks(lo, hi)
    lo, hi = ticks[0], ticks[-1]
    y = lambda v: y0 + H - (v - lo) / (hi - lo) * H  # noqa: E731
    out = [f'<text x="{ML}" y="{y0 - 12}" font-size="13" font-weight="600" fill="{INK}">{title}</text>']
    for t in ticks:
        out.append(f'<line x1="{ML}" x2="{W - MR}" y1="{y(t):.1f}" y2="{y(t):.1f}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{ML - 8}" y="{y(t) + 4:.1f}" font-size="11" text-anchor="end" fill="{MUTED}">{fmt(t)}</text>')
    pts = " ".join(f"{x:.1f},{y(r[key]):.1f}" for x, r in zip(xs, rows))
    out.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"/>')
    for x, r in zip(xs, rows):
        a, b = r[ci_key]
        out.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{y(a):.1f}" y2="{y(b):.1f}" stroke="{color}" stroke-width="1.5" opacity="0.6"/>')
        for v in (a, b):
            out.append(f'<line x1="{x - 4:.1f}" x2="{x + 4:.1f}" y1="{y(v):.1f}" y2="{y(v):.1f}" stroke="{color}" stroke-width="1.5" opacity="0.6"/>')
        out.append(f'<circle cx="{x:.1f}" cy="{y(r[key]):.1f}" r="4.5" fill="{color}" stroke="{SURFACE}" stroke-width="2"/>')
        out.append(f'<text x="{x:.1f}" y="{y(r[key]) - 10:.1f}" font-size="10.5" text-anchor="middle" fill="{INK}">{fmt(r[key])}</text>')
    return out, xs


def svg(rows, path, title):
    W, ML, MR, H, GAP, TOP = 900, 70, 24, 190, 70, 56
    n = len(rows)
    W = max(W, ML + MR + 96 * n)
    total = TOP + 2 * H + GAP + 100
    body = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total}" viewBox="0 0 {W} {total}" '
            f'font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">',
            f'<rect width="{W}" height="{total}" fill="{SURFACE}"/>',
            f'<text x="{ML}" y="24" font-size="16" font-weight="600" fill="{INK}">{title}</text>',
            f'<text x="{ML}" y="42" font-size="11.5" fill="{MUTED}">mean score = land + rank + crown (summarize.py) and median tiles per version, '
            f'commit order left to right; whiskers = 95 % bootstrap CI over games (of the mean score, of the median tiles)</text>']
    p1, xs = panel(TOP + 16, "Score", rows, "score", "scoreCI", BLUE, lambda v: f"{v:.2f}", W, ML, MR, H)
    p2, _ = panel(TOP + 16 + H + GAP, "Median tiles", rows, "medianTiles", "tilesCI", AQUA,
                  lambda v: f"{v / 1000:.0f}k" if v >= 1000 else f"{v:.0f}", W, ML, MR, H)
    body += p1 + p2
    yb = TOP + 16 + 2 * H + GAP
    for x, r in zip(xs, rows):
        body.append(f'<text x="{x:.1f}" y="{yb + 18}" font-size="11.5" text-anchor="middle" fill="{INK}">{r["tag"]}</text>')
        body.append(f'<text x="{x:.1f}" y="{yb + 32}" font-size="10" text-anchor="middle" fill="{MUTED}">{r["hash"][:7]}</text>')
        body.append(f'<text x="{x:.1f}" y="{yb + 46}" font-size="10" text-anchor="middle" fill="{MUTED}">{r["games"]} games</text>')
        body.append(f'<text x="{x:.1f}" y="{yb + 59}" font-size="10" text-anchor="middle" fill="{MUTED}">{r["crowns"]} crown{"" if r["crowns"] == 1 else "s"}, {r["alive"]} alive</text>')
    body.append("</svg>")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(body) + "\n")


def main(argv):
    svg_path, write = os.path.join(ROOT, "lab-out", "history.svg"), True
    while argv and argv[0].startswith("--"):
        if argv[0] == "--svg":
            svg_path = argv[1]; argv = argv[2:]
        elif argv[0] == "--no-write":
            write = False; argv = argv[1:]
        else:
            print(f"unknown option {argv[0]}"); return 2
    if not argv:
        print(__doc__); return 2
    d = argv[0]
    present = summarize.discover(d)
    order = milestones() + [("base", head_hash(), "", "today's bot")]
    want = argv[1:] or [t for t, *_ in order if t in present]
    rows = []
    base = summarize.load(d, "base") if "base" in present else None
    data = {t: summarize.load(d, t) for t in want if t in present}
    summarize.resolve_objective(data)  # wscore when the dir has decided (winner=) games, else score
    print(summarize.OBJECTIVE_NOTE)
    print(f"{'version':<10} {'commit':<10} {'games':>5} {'alive':>5} {'crowns':>6} {'top3':>5} {'med tiles':>9} {'score':>7} {'95% CI':<16} vs base (live pairs)")
    for tag in want:
        info = next((m for m in order if m[0] == tag), None)
        if info is None:
            print(f"{tag}: not in {MANIFEST}"); continue
        games = data.get(tag) or summarize.load(d, tag)
        if not games:
            print(f"{tag:<10} no games in {d}"); continue
        st = stats(games)
        delta = vs_base(base, games)
        print(fmt_row(tag, info[1], st, delta))
        rows.append({"tag": tag, "hash": info[1], **st})
        if write:
            write_version(tag, info[1], info[2], info[3], st, delta, os.path.basename(os.path.abspath(d)))
    if rows:
        svg(rows, svg_path, f"PlaybookBot strength by version ({os.path.basename(os.path.abspath(d))})")
        print(f"\nchart: {svg_path}" + (f"; versions/<tag>.json written to {VDIR}" if write else ""))
    return 0


def head_hash():
    import subprocess
    try:
        return subprocess.run(["git", "rev-parse", "--short=9", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or "HEAD"
    except OSError:
        return "HEAD"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
