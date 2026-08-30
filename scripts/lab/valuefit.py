#!/usr/bin/env python3
"""valuefit.py — fit a value function (final score from mid-game state) on lab transcripts.

Reads every *.txt under one or more results dirs (the lab's transcripts: a `== region | … | Difficulty ==`
header, one `  Ns …` row every 30 s with tiles/troops/cap/gold/cities/ports/dp/allies/rank, a FINAL line), builds
one row per game and time (5 / 8 / 10 / 12 / 15 min) from the row at that time, and fits a ridge-regularised
linear model of the FINAL score (summarize.py's landScore + rankScore + crown) per time, closed form, stdlib only.

For each time it prints the coefficients (standardised features, so they are comparable), the in-sample R², and
the 5-fold out-of-sample Spearman of predicted-vs-final score next to the two raw baselines the early-stop
analysis used: rank-at-t vs final rank (ρ 0.58 at 12:00 over 390 games, PlaybookBotPlan.md "Training-loop fixes"
item 6) and the score-at-t vs final score. `--out value.json` writes the models so the bot or the lab can use them.

    python3 scripts/lab/valuefit.py DIR [DIR …] [--diff Medium] [--min-length 1200] [--lambda 1.0] [--folds 5] [--out value.json]
    python3 scripts/lab/valuefit.py --selftest
"""
import argparse
import json
import math
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import summarize  # noqa: E402

TIMES = [300, 480, 600, 720, 900]  # seconds: 5, 8, 10, 12, 15 min
FEATURES = ["log_tiles", "log_troops", "troops_over_cap", "log_gold", "cities", "ports", "dp", "allies", "rank_score", "share", "log_cap"]

HEADER_RE = re.compile(r"^== (?P<region>\S+) \|.*\| (?P<diff>\w+) ==")
ROW_RE = re.compile(
    r"^\s*(?P<t>\d+)s .*?tiles=\s*(?P<tiles>\d+) troops=\s*(?P<troops>\d+)k cap=\s*(?P<cap>\d+)k gold=\s*(?P<gold>-?\d+)k "
    r"cities=(?P<cities>\d+) ports=(?P<ports>\d+) dp=(?P<dp>\d+) allies=(?P<allies>\d+) rank=(?P<rank>\d+)/(?P<players>\d+)(?: share=(?P<share>[\d.]+))?"
)
DEAD_RE = re.compile(r"^\s*DEAD at (?P<t>\d+)s")
FINAL_RE = re.compile(r"FINAL(?: rank=(?P<rank>\d+))?(?: share=(?P<share>[\d.]+))?.*?alive=(?P<alive>\w+) tiles=(?P<tiles>\d+)(?:.*? players=(?P<players>\d+))?")
WINNER_RE = summarize.WINNER_RE


# ---------------------------------------------------------------- scoring: summarize.py's own functions (a copy here drifted:
# no winner= / WIN_BONUS, so a full-game FINAL scored the same won or lost)
def land_score(tiles):
    return summarize.land_score(tiles)


def rank_score(alive, rank, players):
    return summarize.rank_score({"alive": alive, "rank": rank, "players": players})


def score(alive, rank, players, tiles, winner=None):
    """summarize.wscore: land + rank + crown, plus WIN_BONUS when the FINAL line says winner=us (MIN=full sweeps)."""
    return summarize.wscore({"alive": alive, "rank": rank, "players": players, "tiles": tiles, "winner": winner})


# ---------------------------------------------------------------- parsing
def parse_games(text, source):
    """Split a transcript file into games: header, rows by second, dead time, FINAL fields."""
    games = []
    g = None
    for line in text.splitlines():
        m = HEADER_RE.match(line)
        if m:
            g = {"source": source, "region": m.group("region"), "diff": m.group("diff"), "rows": {}, "dead": None, "final": None}
            games.append(g)
            continue
        if g is None:
            continue
        m = ROW_RE.match(line)
        if m:
            d = {k: (float(v) if k == "share" else int(v)) for k, v in m.groupdict().items() if v is not None}
            g["rows"][d["t"]] = d
            continue
        m = DEAD_RE.match(line)
        if m:
            g["dead"] = int(m.group("t"))
            continue
        m = FINAL_RE.search(line)
        if m and "FINAL" in line and not line.lstrip().startswith("log:"):
            g["final"] = {
                "rank": int(m.group("rank")) if m.group("rank") else None,
                "alive": m.group("alive") == "true",
                "tiles": int(m.group("tiles")),
                "players": int(m.group("players")) if m.group("players") else None,
                "winner": (WINNER_RE.search(line).group(1) if WINNER_RE.search(line) else None),
            }
    return [x for x in games if x["final"] is not None]


def load_dirs(dirs):
    games = []
    for d in dirs:
        for root, _, files in os.walk(d):
            for f in sorted(files):
                if f.endswith(".txt"):
                    p = os.path.join(root, f)
                    with open(p, errors="replace") as fh:
                        games.extend(parse_games(fh.read(), p))
    return games


def final_score(g):
    f = g["final"]
    players = f["players"]
    if players is None and g["rows"]:
        players = g["rows"][max(g["rows"])]["players"]
    return score(f["alive"], f["rank"], players, f["tiles"], f.get("winner")), players


def features_at(g, t):
    """Feature vector at second t, or None when the game has no row there (dead: a zero row with rank_score 0)."""
    if g["dead"] is not None and g["dead"] <= t:
        return [math.log10(100), 0.0, 0.0, 0.0, 0, 0, 0, 0, 0.0, 0.0, 0.0], None, None
    r = g["rows"].get(t)
    if r is None:
        return None, None, None
    rs = rank_score(True, r["rank"], r["players"])
    share = r.get("share", 0.0)
    x = [
        math.log10(max(r["tiles"], 100)), math.log10(r["troops"] * 1000 + 1), r["troops"] / max(1, r["cap"]), math.log10(max(r["gold"], 0) * 1000 + 1),
        r["cities"], r["ports"], r["dp"], r["allies"], rs, share, math.log10(r["cap"] * 1000 + 1),
    ]
    return x, r["rank"], score(True, r["rank"], r["players"], r["tiles"])


# ---------------------------------------------------------------- linear algebra (stdlib)
def solve(A, b):
    """Gaussian elimination with partial pivoting; A is n×n, b length n."""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        piv = M[c][c]
        if abs(piv) < 1e-12:
            continue
        for r in range(n):
            if r == c:
                continue
            f = M[r][c] / piv
            if f == 0:
                continue
            for k in range(c, n + 1):
                M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def standardise(X):
    n, d = len(X), len(X[0])
    mean = [sum(X[i][j] for i in range(n)) / n for j in range(d)]
    std = [math.sqrt(sum((X[i][j] - mean[j]) ** 2 for i in range(n)) / n) or 1.0 for j in range(d)]
    Z = [[(X[i][j] - mean[j]) / std[j] for j in range(d)] for i in range(n)]
    return Z, mean, std


def ridge(Z, y, lam):
    """min ‖Zw + b − y‖² + λ‖w‖² with an unpenalised intercept: centre y, solve (ZᵀZ + λI) w = Zᵀ(y − ȳ)."""
    n, d = len(Z), len(Z[0])
    ybar = sum(y) / n
    A = [[sum(Z[i][j] * Z[i][k] for i in range(n)) + (lam if j == k else 0.0) for k in range(d)] for j in range(d)]
    b = [sum(Z[i][j] * (y[i] - ybar) for i in range(n)) for j in range(d)]
    w = solve(A, b)
    return w, ybar


def predict(Z, w, b):
    return [b + sum(z[j] * w[j] for j in range(len(w))) for z in Z]


def r2(y, yhat):
    ybar = sum(y) / len(y)
    ss_res = sum((a - p) ** 2 for a, p in zip(y, yhat))
    ss_tot = sum((a - ybar) ** 2 for a in y) or 1.0
    return 1 - ss_res / ss_tot


def ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def spearman(a, b):
    if len(a) < 3:
        return float("nan")
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra)) or 1.0
    vb = math.sqrt(sum((y - mb) ** 2 for y in rb)) or 1.0
    return cov / (va * vb)


def cv_predictions(X, y, lam, folds, seed=0):
    """Out-of-sample predictions: each game is predicted by a model fitted without its fold."""
    n = len(X)
    idx = list(range(n))
    random.Random(seed).shuffle(idx)
    yhat = [0.0] * n
    for f in range(folds):
        test = set(idx[f::folds])
        tr = [i for i in range(n) if i not in test]
        if len(tr) < len(X[0]) + 2 or not test:
            continue
        Z, mean, std = standardise([X[i] for i in tr])
        w, b = ridge(Z, [y[i] for i in tr], lam)
        for i in test:
            z = [(X[i][j] - mean[j]) / std[j] for j in range(len(mean))]
            yhat[i] = b + sum(z[j] * w[j] for j in range(len(w)))
    return yhat


# ---------------------------------------------------------------- fitting per time
def fit_all(games, lam, folds, quiet=False):
    out = {"features": FEATURES, "lambda": lam, "games": len(games), "times": {}}
    for t in TIMES:
        X, y, rank_t, score_t, final_rank = [], [], [], [], []
        for g in games:
            x, rk, sc = features_at(g, t)
            if x is None:
                continue
            fs, players = final_score(g)
            X.append(x)
            y.append(fs)
            rank_t.append(rk if rk is not None else 99)
            score_t.append(sc if sc is not None else score(False, None, players, 0))
            f = g["final"]
            final_rank.append(f["rank"] if (f["alive"] and f["rank"]) else (players or 40) + 1)
        n = len(X)
        if n < len(FEATURES) + 2:
            if not quiet:
                print(f"t={t // 60:2d} min: {n} games, too few to fit")
            continue
        Z, mean, std = standardise(X)
        w, b = ridge(Z, y, lam)
        yhat = predict(Z, w, b)
        cv = cv_predictions(X, y, lam, folds)
        rho_fit = spearman(yhat, y)
        rho_cv = spearman(cv, y)
        rho_rank = spearman(rank_t, final_rank)  # the early-stop baseline (rank@t vs final rank)
        rho_score = spearman(score_t, y)  # score@t vs final score
        rec = {
            "n": n, "mean": mean, "std": std, "coef": w, "intercept": b, "r2": r2(y, yhat),
            "spearman_fit": rho_fit, "spearman_cv": rho_cv, "spearman_rank_at_t": rho_rank, "spearman_score_at_t": rho_score,
            "beats_rank_at_t": rho_cv > rho_rank, "beats_score_at_t": rho_cv > rho_score,
        }
        out["times"][str(t)] = rec
        if not quiet:
            print(f"t={t // 60:2d} min  n={n:4d}  R²={rec['r2']:.3f}  ρ(pred,final) fit={rho_fit:.3f} cv={rho_cv:.3f}  |  ρ(rank@t,final rank)={rho_rank:.3f}  ρ(score@t,final)={rho_score:.3f}  → predictor {'beats' if rec['beats_rank_at_t'] else 'does not beat'} rank@t, {'beats' if rec['beats_score_at_t'] else 'does not beat'} score@t")
            coef = sorted(zip(FEATURES, w), key=lambda kv: -abs(kv[1]))
            print("          " + "  ".join(f"{k}={v:+.3f}" for k, v in coef))
    return out


def apply_model(model, t, row_features):
    """Predicted final score from one model (the JSON's times[t]) and a raw feature vector."""
    m = model["times"][str(t)]
    z = [(row_features[j] - m["mean"][j]) / m["std"][j] for j in range(len(m["mean"]))]
    return m["intercept"] + sum(z[j] * m["coef"][j] for j in range(len(z)))


# ---------------------------------------------------------------- selftest
def synthetic_transcript(seed, n_games=120):
    """Games whose final score is a noisy linear function of the 12-minute state, so the fit has something to find."""
    rnd = random.Random(seed)
    lines = []
    for gi in range(n_games):
        players = rnd.randint(20, 30)
        strength = rnd.random()  # latent
        lines.append(f"== region{gi % 6} | spawn 1,1 (bot picker rank 0) | Medium ==")
        dead = rnd.random() < 0.08
        dead_at = rnd.choice([420, 540, 660]) if dead else None
        for t in range(30, 1201, 30):
            if dead_at and t >= dead_at:
                if t == dead_at:
                    lines.append(f"  DEAD at {t}s")
                break
            tiles = int(2000 + strength * 60000 * (t / 1200) + rnd.gauss(0, 2000))
            tiles = max(200, tiles)
            rank = max(1, min(players, int(round(1 + (1 - strength) * (players - 1) + rnd.gauss(0, 2)))))
            cities = int(strength * 20 * t / 1200)
            lines.append(f"  {t:4d}s bots=0 botTroops=0 botTiles=0 nearBotTroops=- tiles={tiles:7d} troops={int(strength * 3000):5d}k cap={int(strength * 4000 + 100):5d}k gold={int(rnd.random() * 500):6d}k cities={cities} ports={cities // 2} dp={cities // 3} allies={rnd.randint(0, 6)} rank={rank}/{players} share={min(1, strength + 0.1):.2f}")
        if dead:
            lines.append(f"  FINAL rank=99 share=0.00 botMs=1 gameMs=1 alive=false tiles=0 troops=0k cities=0 ports=0 factories=0 silos=0 sams=0 bombs=0 trainGold=0k gold=0k players={players} fired=-")
        else:
            final_rank = max(1, min(players, int(round(1 + (1 - strength) * (players - 1) + rnd.gauss(0, 3)))))
            final_tiles = int(max(500, 5000 + strength * 150000 + rnd.gauss(0, 15000)))
            lines.append(f"  FINAL rank={final_rank} share=0.9 botMs=1 gameMs=1 alive=true tiles={final_tiles} troops=1k cities=1 ports=1 factories=0 silos=0 sams=0 bombs=0 trainGold=0k gold=0k players={players} fired=-")
        lines.append("  log: t10 nothing")
        lines.append("")
    return "\n".join(lines)


def selftest():
    # 1. the linear algebra: ridge with λ→0 recovers a known line
    X = [[float(i), float(i * i % 7)] for i in range(30)]
    y = [2 * x[0] - 3 * x[1] + 1 for x in X]
    Z, mean, std = standardise(X)
    w, b = ridge(Z, y, 1e-9)
    yhat = predict(Z, w, b)
    assert r2(y, yhat) > 0.999, r2(y, yhat)
    assert abs(w[0] / std[0] - 2) < 1e-6 and abs(w[1] / std[1] + 3) < 1e-6, (w, std)
    # 2. spearman: monotone → 1, reversed → −1, ties averaged
    assert abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12
    assert abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12
    assert ranks([5, 5, 1]) == [2.5, 2.5, 1.0]
    # 3. a synthetic results dir: parse, fit, and the predictor at 12 min beats the raw rank at 12 min
    games = parse_games(synthetic_transcript(1), "synthetic")
    assert len(games) == 120, len(games)
    assert sum(1 for g in games if g["dead"]) > 0
    fs, players = final_score(games[0])
    assert 0.4 <= fs <= 2.25 and players is not None
    model = fit_all(games, lam=1.0, folds=5, quiet=True)
    m12 = model["times"]["720"]
    assert m12["r2"] > 0.5, m12["r2"]
    assert m12["spearman_cv"] > 0.6, m12["spearman_cv"]
    # apply_model reproduces the in-sample prediction of the first game
    x, _, _ = features_at(games[0], 720)
    z = [(x[j] - m12["mean"][j]) / m12["std"][j] for j in range(len(x))]
    assert abs(apply_model(model, 720, x) - (m12["intercept"] + sum(z[j] * m12["coef"][j] for j in range(len(z))))) < 1e-9
    # 4. the JSON round-trips
    json.loads(json.dumps(model))
    print(f"selftest ok: 120 synthetic games, 12-min R²={m12['r2']:.2f}, ρ_cv={m12['spearman_cv']:.2f} vs rank@12 ρ={m12['spearman_rank_at_t']:.2f}")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="*", help="results dirs (transcripts *.txt, searched recursively)")
    ap.add_argument("--lambda", dest="lam", type=float, default=1.0, help="ridge penalty on standardised features (default 1.0)")
    ap.add_argument("--folds", type=int, default=5, help="cross-validation folds for the out-of-sample Spearman (default 5)")
    ap.add_argument("--diff", default=None, help="only games of this difficulty (Medium / Hard)")
    ap.add_argument("--min-length", type=int, default=1200, help="only games that ran at least this many seconds (or died): a results dir mixes 10- and 20-minute games, and a 10-minute game's FINAL is its 10-minute row (default 1200)")
    ap.add_argument("--out", default=None, help="write the models as JSON here")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        selftest()
        return 0
    if not a.dirs:
        ap.print_usage()
        return 2
    games = load_dirs(a.dirs)
    if a.diff:
        games = [g for g in games if g["diff"].lower() == a.diff.lower()]
    if a.min_length:
        games = [g for g in games if g["dead"] is not None or (g["rows"] and max(g["rows"]) >= a.min_length)]
    print(f"{len(games)} games with a FINAL line from {len(a.dirs)} dir(s); {sum(1 for g in games if g['dead'])} died; {sum(1 for g in games if g['final']['players'] is None)} without players= (N from the last row)")
    if not games:
        return 1
    model = fit_all(games, a.lam, a.folds)
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(model, fh, indent=1)
        print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
