#!/usr/bin/env python3
"""Summarise PlaybookBot lab sweeps (python3 stdlib only).

Reads the ab30_<config>_<batch>.txt files a sweep leaves in a results dir
(one FINAL line per game, see docs/PlaybookBotLab.md) and prints, per config:
games, alive, crowns (rank 1), top-3, total tiles, median land, the old
fitness (`fit_old`) and the new score; then pairs every game by
(batch, region) against the first config named and prints wins / losses /
identical pairs, the biggest swings, and the live-game statistics below.

  python3 scripts/lab/summarize.py DIR                 # every config found in DIR, first is the baseline
  python3 scripts/lab/summarize.py DIR base cand1 …    # explicit order; first = baseline
  python3 scripts/lab/summarize.py --fitness DIR …     # JSON {config: {"fitness": …, "per_game": {…}, …}} for cmaes.py
  python3 scripts/lab/summarize.py --old-fitness --fitness DIR …   # "fitness" = the old alive+share+top3 instead
  python3 scripts/lab/summarize.py --ladder DIR cand v-current v3 v2   # Bradley–Terry table over all pairs
  python3 scripts/lab/summarize.py --at 600 DIR …      # same, but scored from the 10-minute row of each transcript
  python3 scripts/lab/summarize.py --verdict 3 DIR …   # per config: "clear" when |wins - losses| >= 3 vs the baseline, else "unclear"
                                                       # (exit 0 when every config is clear — remote.sh STAGED=1 uses this to skip the rest of the grid)
  python3 scripts/lab/summarize.py --sprt DIR base cand  # + sequential test (GSPRT) per config: ACCEPT / REJECT / CONTINUE (n more pairs)
  python3 scripts/lab/summarize.py --sprt --verdict 3 DIR base cand   # exit 0 when every config's SPRT has decided (remote.sh SPRT=1 loop)
  python3 scripts/lab/summarize.py --cycles DIR cand v-current v3 v2   # non-transitive triples (a beats b beats c beats a)
  python3 scripts/lab/summarize.py --objective wscore DIR …   # objective for the paired stats / SPRT / --fitness: score | wscore | winrate
  python3 scripts/lab/summarize.py --selftest          # inline fixture, exit 0 iff the scoring is as documented here

Score of one game (2026-08-30, replaces the old fitness as the objective):

    score     = landScore + rankScore + crown                  # in [0.4, 2.25]
    landScore = log10(max(tiles, 100)) / 5                    # 100k tiles = 1.0, 10k = 0.8, dead (0 tiles) = 0.4
    rankScore = 1 - (rank - 1) / (players - 1)   if alive     # 1st = 1.0, last = 0.0; 0 when dead
    crown     = 0.25                             if rank == 1

`players` is the `players=N` field of the FINAL line (bot-side change of
2026-08-30). When it is missing we take the N of the last `rank=x/N` row of
the p_<config>_<batch>_<region>.txt transcript if that file is present, and
otherwise ASSUME N=40 (a note is printed). A config's score is its mean over
the grid. The old fitness, alive (0/1) + share (0..1) + (rank <= 3 ? 1 : 0)
in [0, 3], is still computed and printed as `fit_old`.

The FINAL line may also carry `fired=flag:count,flag:count` — which flagged
branches fired during that game (`fired=-` or absent = none). In the paired
report a game is *live* for a config when its `fired` is non-empty or its
outcome (alive, tiles) differs from the baseline's; wins / losses / ties, the
mean paired score difference with a bootstrap 95% CI (1000 resamples, seed 0)
and a two-sided sign test are over live games only, and the verdict is
"decisive win" / "decisive loss" when the sign test has p < 0.05, else
"undecided (n_live=…)".

Full games and win scoring (2026-08-30). With MIN=full the lab plays until
someone wins (170-minute ceiling) and the FINAL line carries `winner=us|other|none`
(absent on older / fixed-length sweeps). Per config the table adds `wins`
(winner=us) and `winrate`, and there is a second objective

    wscore = score + WIN_BONUS · (winner == us)       WIN_BONUS = 1.0

A win outweighs the whole 0.4–2.25 range of the 20-minute score, so wins
dominate whenever they exist and land/rank only orders the non-wins. The
objective used by the paired statistics, the sequential test, --verdict and
--fitness ("fitness") is chosen per results dir: `wscore` when any game in it
has winner=us|other (a full-game sweep), else `score`; --objective
score|wscore|winrate overrides. A dir that mixes decided games with games that
have no winner= field at all gets a warning and uses wscore. The paired report
adds a WIN line per config (wins of each, pairs won by A only / B only / both
/ neither, and an exact McNemar-style sign test on the discordant pairs). For
--objective winrate the observations are the paired win differences (+1/0/−1)
and the SPRT's δ defaults to 0.15 (a 15-point win-rate change).

Sequential test (--sprt, 2026-08-29; the Stockfish/fishtest GSPRT applied to
the paired score difference). Observations are the per-pair differences
d_i = obj(cand) − obj(base) (obj = the chosen objective, see above) over live games in batch order (with mirrored
slots, see below, the two slots of one (batch, region) are averaged into one
observation). H0: mean d ≤ 0 against H1: mean d ≥ δ (--delta, default 0.10
score units ≈ one rank step out of ten, or 10k→16k tiles), α = β = 0.05:

    LLR_n = n · (mean_n − δ/2) · δ / var_n          (var_n = sample variance, floor δ²)
    ACCEPT when LLR ≥ ln((1−β)/α) = +2.944, REJECT when LLR ≤ ln(β/(1−α)) = −2.944, else CONTINUE

The decision is the *first* crossing at n ≥ SPRT_MIN_N = 10 walking the
observations in order (a true sequential test — later pairs cannot undo it;
the minimum n and the sd floor of δ are there because a sample variance from
two or three pairs is meaningless — lab-out/final's m4 REJECTed at n=2 on
two pairs of −0.38 while its 18 pairs averaged +0.20). The report shows the
mean / sd over the whole series and the LLR at the crossing; CONTINUE also reports how
many more pairs the current mean and variance would need to reach a bound
(∞ when the mean sits at δ/2). --verdict with --sprt exits 0 only when every
config has decided, which is what remote.sh/sweep.sh SPRT=1 loop on.
For racing inside cmaes.py the same function is called with (d0, d1) =
(−δ, 0): REJECT there means "worse than the parent by δ".

Mirrored slots (sweep.sh MIRROR=1): every (batch, region) is played twice,
batch `med0` at SHIFT (default 0) and batch `med0b` at MIRRORSHIFT (default
150) — the two "slots" of one scenario, the lab's analogue of playing both
colours. summarize.py pairs `med0b` with `med0` and, when both slots exist
for both configs, prints a pentanomial summary of the (slot a, slot b)
outcome pairs: LL, LT/TL, TT or WL, WT/TW, WW.
"""
import glob
import json
import math
import os
import random
import re
import statistics
import sys

FINAL_RE = re.compile(
    r"== (?P<region>\S+) \|.*\| (?P<diff>\w+) ==.*FINAL(?: rank=(?P<rank>\d+))?"
    r"(?: share=(?P<share>[\d.]+))?.*?alive=(?P<alive>\w+) tiles=(?P<tiles>\d+)"
)
DEAD_RE = re.compile(r"DEAD at (\d+)s")
PLAYERS_RE = re.compile(r"\bplayers=(\d+)")
FIRED_RE = re.compile(r"\bfired=(\S+)")
# one per-30-s row of a transcript:  "  600s bots=… tiles=  12345 troops=… rank=3/41 share=0.62"
ROW_RE = re.compile(r"^\s*(?P<t>\d+)s .*?tiles=\s*(?P<tiles>\d+).*?rank=(?P<rank>\d+)/(?P<players>\d+)(?: share=(?P<share>[\d.]+))?")
AT = None  # --at SECONDS: score games from the row at that time instead of FINAL
WINNER_RE = re.compile(r"\bwinner=(\w+)")
WIN_BONUS = 1.0
OBJECTIVE = None  # --objective score|wscore|winrate; None = auto (wscore when the dir has decided games, else score)
OBJECTIVE_NOTE = None  # printed once: which objective was chosen and why
DELTA_SET = False  # --delta given (else winrate uses WINRATE_DELTA)
WINRATE_DELTA = 0.15
SPRT = False  # --sprt: add the sequential test to the table / ladder / verdict
ASSUMED_PLAYERS = 40
ASSUMED = {}  # config -> games whose player count had to be assumed (reported once)
BOOT_N = 1000
BOOT_SEED = 0


def parse_fired(s):
    """'a:3,b:1' -> {'a': 3, 'b': 1}; '-' / '' -> {}."""
    out = {}
    for part in (s or "").split(","):
        name, _, count = part.partition(":")
        if name and name != "-":
            out[name] = int(count) if count.isdigit() else 1
    return out


def parse_line(line):
    m = FINAL_RE.search(line)
    if not m:
        return None
    alive = m.group("alive") == "true"
    rank = int(m.group("rank")) if m.group("rank") else None
    share = float(m.group("share")) if m.group("share") else 0.0
    dead = DEAD_RE.search(line)
    players = PLAYERS_RE.search(line)
    fired = FIRED_RE.search(line)
    winner = WINNER_RE.search(line)
    return {
        "region": m.group("region"),
        "diff": m.group("diff"),
        "alive": alive,
        "rank": rank,
        "share": share,
        "tiles": int(m.group("tiles")),
        "deadAt": int(dead.group(1)) if dead else None,
        "players": int(players.group(1)) if players else None,
        "fired": parse_fired(fired.group(1)) if fired else {},
        "winner": winner.group(1) if winner else None,  # "us" | "other" | "none" | None (no winner= field)
    }


def fitness(g):
    """The old objective: alive + share + top3, in [0, 3]."""
    return (1.0 if g["alive"] else 0.0) + g["share"] + (1.0 if g["rank"] is not None and g["rank"] <= 3 else 0.0)


def land_score(tiles):
    return math.log10(max(tiles, 100)) / 5


def rank_score(g):
    if not g["alive"] or g["rank"] is None:
        return 0.0
    players = g.get("players") or ASSUMED_PLAYERS
    if players <= 1:
        return 1.0
    return max(0.0, 1 - (g["rank"] - 1) / (players - 1))


def score(g):
    crown = 0.25 if (g["alive"] and g["rank"] == 1) else 0.0
    return land_score(g["tiles"]) + rank_score(g) + crown


def won(g):
    return g.get("winner") == "us"


def wscore(g):
    """Win-aware objective: the 20-minute score plus WIN_BONUS for winning the game outright."""
    return score(g) + (WIN_BONUS if won(g) else 0.0)


def winrate_obj(g):
    return 1.0 if won(g) else 0.0


OBJECTIVES = {"score": score, "wscore": wscore, "winrate": winrate_obj}


def obj(g):
    """The chosen objective of one game (see resolve_objective)."""
    return OBJECTIVES[OBJECTIVE or "score"](g)


def resolve_objective(data):
    """Pick the objective for a results dir: wscore when any game was decided (winner=us|other), else score;
    --objective overrides. Sets the SPRT δ for winrate unless --delta was given. `data` = {config: games}."""
    global OBJECTIVE, OBJECTIVE_NOTE, SPRT_DELTA
    games = [g for gs in data.values() for g in gs.values()]
    decided = sum(1 for g in games if g.get("winner") in ("us", "other"))
    nofield = sum(1 for g in games if g.get("winner") is None)
    chosen = OBJECTIVE
    if chosen is None:
        chosen = "wscore" if decided else "score"
        OBJECTIVE_NOTE = (f"objective: {chosen} (auto — {decided} of {len(games)} games have a winner)" if decided
                          else "objective: score (auto — no game has winner=us|other)")
    else:
        OBJECTIVE_NOTE = f"objective: {chosen} (--objective)"
    if decided and nofield:
        OBJECTIVE_NOTE += (f"\nwarning: mixed results dir — {decided} decided games but {nofield} games have no winner= field"
                           f" (fixed-length or older sweep); those count as no win")
    OBJECTIVE = chosen
    if chosen == "winrate" and not DELTA_SET:
        SPRT_DELTA = WINRATE_DELTA
    return chosen


def parse_at(text, seconds):
    """Game state at `seconds` from a transcript: the last row at or before that time (dead = no row and a
    DEAD line before it). share needs the row's share= field (transcripts from 2026-08-30 on)."""
    header = next((l for l in text.splitlines() if l.startswith("==")), None)
    hm = re.search(r"== (?P<region>\S+) \|.*\| (?P<diff>\w+) ==", header or "")
    if not hm:
        return None
    row = None
    for l in text.splitlines():
        m = ROW_RE.match(l)
        if m and int(m.group("t")) <= seconds:
            row = m
    dead = DEAD_RE.search(text)
    dead_at = int(dead.group(1)) if dead else None
    alive = not (dead_at is not None and dead_at <= seconds)
    base = {"region": hm.group("region"), "diff": hm.group("diff"), "alive": alive, "deadAt": dead_at, "fired": {}, "winner": None}
    if row is None:
        return {**base, "rank": None, "share": 0.0, "tiles": 0, "players": None}
    return {
        **base,
        "rank": int(row.group("rank")) if alive else None,
        "share": float(row.group("share")) if (alive and row.group("share")) else 0.0,
        "tiles": int(row.group("tiles")) if alive else 0,
        "players": int(row.group("players")),
    }


def players_from_transcript(path):
    """N of the last 'rank=x/N' row of a transcript, or None."""
    if not os.path.isfile(path):
        return None
    n = None
    for l in open(path):
        m = ROW_RE.match(l)
        if m:
            n = int(m.group("players"))
    return n


def fill_players(d, cfg, games):
    for (batch, region), g in games.items():
        if g.get("players"):
            continue
        g["players"] = players_from_transcript(os.path.join(d, f"p_{cfg}_{batch}_{region}.txt"))
        if not g["players"]:
            ASSUMED.setdefault(cfg, 0)
            ASSUMED[cfg] += 1


def load(d, cfg):
    """{(batch, region): game} for one config. Falls back to the p_*.txt transcripts
    when the aggregated ab30 files are missing (sweep died before aggregating).
    With --at, always reads the transcripts."""
    games = {}
    if AT is not None:
        for f in sorted(glob.glob(os.path.join(d, f"p_{cfg}_*_*.txt"))):
            rest = os.path.basename(f)[len(f"p_{cfg}_"):-4]
            batch, _, region = rest.partition("_")
            g = parse_at(open(f).read(), AT)
            if g:
                games[(batch, region)] = g
        fill_players(d, cfg, games)
        return games
    files = sorted(glob.glob(os.path.join(d, f"ab30_{cfg}_*.txt")))
    for f in files:
        batch = os.path.basename(f)[:-4].split("_")[-1]
        for line in open(f):
            g = parse_line(line)
            if g:
                games[(batch, g["region"])] = g
    if not games:
        for f in sorted(glob.glob(os.path.join(d, f"p_{cfg}_*_*.txt"))):
            rest = os.path.basename(f)[len(f"p_{cfg}_"):-4]
            batch, _, region = rest.partition("_")
            text = open(f).read()
            joined = " ".join(l.strip() for l in text.splitlines() if l.startswith("==") or "DEAD" in l or "FINAL" in l)
            g = parse_line(joined)
            if g:
                games[(batch, region)] = g
    fill_players(d, cfg, games)
    return games


def assumed_note():
    if not ASSUMED:
        return None
    return ("note: no players= on the FINAL line and no transcript for "
            + ", ".join(f"{c} ({n} games)" for c, n in ASSUMED.items())
            + f" — rankScore assumes {ASSUMED_PLAYERS} players")


def discover(d):
    names = []
    for f in sorted(glob.glob(os.path.join(d, "ab30_*_*.txt"))):
        stem = os.path.basename(f)[5:-4]
        name = stem.rsplit("_", 1)[0]
        if name not in names:
            names.append(name)
    return names


def summary(games):
    vals = list(games.values())
    tiles = [g["tiles"] for g in vals]
    return {
        "games": len(vals),
        "alive": sum(g["alive"] for g in vals),
        "crowns": sum(1 for g in vals if g["rank"] == 1),
        "top3": sum(1 for g in vals if g["rank"] is not None and g["rank"] <= 3),
        "tiles": sum(tiles),
        "median": statistics.median(tiles) if tiles else 0,
        "fitness": statistics.fmean(fitness(g) for g in vals) if vals else 0.0,
        "score": statistics.fmean(score(g) for g in vals) if vals else 0.0,
        "wins": sum(1 for g in vals if won(g)),
        "winrate": (sum(1 for g in vals if won(g)) / len(vals)) if vals else 0.0,
        "wscore": statistics.fmean(wscore(g) for g in vals) if vals else 0.0,
    }


def outcome(g):
    """Ordering key for a paired comparison: won the game first, then alive, then land."""
    return (1 if won(g) else 0, 1 if g["alive"] else 0, g["tiles"])


def paired(a, b):
    """wins / losses / identical of a vs b over shared (batch, region) keys, plus the swings."""
    w = l = same = 0
    swings = []
    for k in sorted(set(a) & set(b)):
        ka, kb = outcome(a[k]), outcome(b[k])
        if ka == kb:
            same += 1
        elif ka > kb:
            w += 1
        else:
            l += 1
        swings.append((a[k]["tiles"] - b[k]["tiles"], k))
    swings.sort(key=lambda s: -abs(s[0]))
    return w, l, same, swings


def sign_test(w, l):
    """Two-sided exact sign test on wins vs losses (ties excluded)."""
    n = w + l
    if n == 0:
        return 1.0
    k = min(w, l)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def bootstrap_ci(diffs, n=BOOT_N, seed=BOOT_SEED):
    if not diffs:
        return (0.0, 0.0)
    rng = random.Random(seed)
    m = len(diffs)
    means = sorted(statistics.fmean(diffs[rng.randrange(m)] for _ in range(m)) for _ in range(n))
    return means[int(0.025 * n)], means[min(n - 1, int(0.975 * n))]


def live_stats(a, b):
    """Paired statistics of config a vs baseline b over *live* games (a fired something, or the outcome differs)."""
    keys = sorted(set(a) & set(b))
    diffs = []
    w = l = t = 0
    for k in keys:
        live = bool(a[k].get("fired")) or outcome(a[k]) != outcome(b[k])
        if not live:
            continue
        d = obj(a[k]) - obj(b[k])
        diffs.append(d)
        if d > 1e-12:
            w += 1
        elif d < -1e-12:
            l += 1
        else:
            t += 1
    mean = statistics.fmean(diffs) if diffs else 0.0
    lo, hi = bootstrap_ci(diffs)
    p = sign_test(w, l)
    if p < 0.05 and w > l:
        verdict = "decisive win"
    elif p < 0.05 and l > w:
        verdict = "decisive loss"
    else:
        verdict = f"undecided (n_live={len(diffs)})"
    return {"n": len(keys), "n_live": len(diffs), "wins": w, "losses": l, "ties": t,
            "mean_diff": mean, "ci": (lo, hi), "p": p, "verdict": verdict}


def win_stats(a, b):
    """Paired wins of config a vs baseline b over shared (batch, region) keys: pairs won by a only, b only,
    both, neither, and the exact two-sided McNemar-style sign test on the discordant pairs."""
    keys = sorted(set(a) & set(b))
    a_only = b_only = both = neither = 0
    for k in keys:
        wa, wb = won(a[k]), won(b[k])
        if wa and wb:
            both += 1
        elif wa:
            a_only += 1
        elif wb:
            b_only += 1
        else:
            neither += 1
    return {"n": len(keys), "wins_a": a_only + both, "wins_b": b_only + both, "a_only": a_only, "b_only": b_only,
            "both": both, "neither": neither, "p": sign_test(a_only, b_only)}


def format_win(n, base, s):
    return (f"  {n:16s} wins {n} vs {base}: {s['wins_a']:2d} {s['wins_b']:2d}  pairs {n}-only {s['a_only']:2d} / {base}-only {s['b_only']:2d}"
            f" / both {s['both']:2d} / neither {s['neither']:2d}  McNemar p={s['p']:.3f}")


def split_slot(batch):
    """'med0' -> ('med0', 'a'); 'med0b' -> ('med0', 'b')  (MIRROR=1 second slot, see the docstring)."""
    m = re.match(r"^(.*\d)b$", batch)
    return (m.group(1), "b") if m else (batch, "a")


def is_live(a, b, k):
    return bool(a[k].get("fired")) or outcome(a[k]) != outcome(b[k])


def paired_diffs(a, b, live_only=True):
    """Ordered observations for the sequential test: [(scenario, diff)] of a vs baseline b in batch order.
    Without mirrored slots one game = one observation; with MIRROR=1 the two slots of a (batch, region) that
    both configs played are averaged into one observation (live when either slot is live)."""
    groups = {}
    for k in sorted(set(a) & set(b)):
        base, slot = split_slot(k[0])
        groups.setdefault((base, k[1]), []).append(k)
    out = []
    for scen, keys in sorted(groups.items()):
        live = any(is_live(a, b, k) for k in keys)
        if live_only and not live:
            continue
        out.append((scen, statistics.fmean(obj(a[k]) - obj(b[k]) for k in keys)))
    return out


def pentanomial(a, b):
    """Counts of (slot a, slot b) outcome pairs over scenarios both slots of which were played by both configs,
    or None when no scenario has both slots. Keys: LL, LT, TT (also WL), WT, WW."""
    groups = {}
    for k in sorted(set(a) & set(b)):
        base, slot = split_slot(k[0])
        groups.setdefault((base, k[1]), {})[slot] = k
    counts = {"LL": 0, "LT": 0, "TT": 0, "WT": 0, "WW": 0}
    n = 0
    for scen, slots in groups.items():
        if "a" not in slots or "b" not in slots:
            continue
        n += 1
        pts = 0
        for k in slots.values():
            d = obj(a[k]) - obj(b[k])
            pts += 2 if d > 1e-12 else (0 if d < -1e-12 else 1)
        counts[["LL", "LT", "TT", "WT", "WW"][pts]] += 1
    return counts if n else None


SPRT_DELTA = 0.10
SPRT_ALPHA = 0.05
SPRT_BETA = 0.05
SPRT_MIN_N = 10  # no decision before this many observations (2026-08-30: lab-out/final m4 REJECTed at n=2 on two pairs)


def sprt(diffs, d0=0.0, d1=None, alpha=None, beta=None, min_n=None):
    """Generalised SPRT on the mean of `diffs` (in order), H0: mean = d0 vs H1: mean = d1, normal approximation
    with the running sample variance: LLR_n = n (mean − (d0+d1)/2)(d1 − d0) / var_n.
    The running variance is floored at (d1 − d0)² (sd floor = δ: two equal early pairs must not decide the test)
    and no decision is taken before SPRT_MIN_N observations — before the fix (2026-08-30) lab-out/final's m4
    REJECTed at n=2 from its first two pairs (−0.38 ± 0.15) while the full series of 18 was +0.20.
    Returns {decision: ACCEPT|REJECT|CONTINUE, n, llr, mean, var, n_at, llr_at, more, bounds}. `mean`/`var` are
    over the whole series, `llr` at the end of it; `n_at`/`llr_at` describe the first crossing; `more` is the
    number of extra observations the current mean/variance would need (None when the mean sits on the
    indifference point)."""
    d1 = SPRT_DELTA if d1 is None else d1
    alpha = SPRT_ALPHA if alpha is None else alpha
    beta = SPRT_BETA if beta is None else beta
    min_n = SPRT_MIN_N if min_n is None else min_n
    upper, lower = math.log((1 - beta) / alpha), math.log(beta / (1 - alpha))
    mid, width = (d0 + d1) / 2, d1 - d0
    var_floor = width * width
    res = {"decision": "CONTINUE", "n": len(diffs), "llr": 0.0, "mean": 0.0, "var": var_floor, "n_at": None, "llr_at": None,
           "more": None, "bounds": (lower, upper), "d0": d0, "d1": d1}
    if len(diffs) < 2:
        res["more"] = max(2, min_n) - len(diffs)
        res["mean"] = statistics.fmean(diffs) if diffs else 0.0
        return res
    for n in range(2, len(diffs) + 1):
        window = diffs[:n]
        mean = statistics.fmean(window)
        var = max(statistics.variance(window), var_floor)
        llr = n * (mean - mid) * width / var
        if n >= min_n and res["n_at"] is None:
            if llr >= upper:
                res.update(decision="ACCEPT", n_at=n, llr_at=llr)
            elif llr <= lower:
                res.update(decision="REJECT", n_at=n, llr_at=llr)
    res.update(llr=llr, mean=mean, var=var)
    if res["decision"] == "CONTINUE":
        drift = (mean - mid) * width / var  # LLR per observation at the current estimate
        if abs(drift) < 1e-12:
            res["more"] = None
        else:
            target = upper if drift > 0 else lower
            res["more"] = max(1, math.ceil(target / drift) - len(diffs), min_n - len(diffs))
    return res


def format_sprt(name, r, penta=None):
    n = r["n"]
    if r["decision"] == "CONTINUE":
        more = "∞ at the current estimate" if r["more"] is None else f"~{r['more']} more pair{'s' if r['more'] != 1 else ''} needed"
        tail = f"CONTINUE ({more})"
    else:
        tail = f"{r['decision']} at n={r['n_at']} (LLR {r['llr_at']:+.2f})"
    pent = ""
    if penta:
        pent = "  pentanomial LL/LT/TT/WT/WW " + "/".join(str(penta[k]) for k in ("LL", "LT", "TT", "WT", "WW"))
    return (f"  {name:16s} SPRT n {n:3d}  mean {r['mean']:+.3f}  sd {math.sqrt(r['var']):.3f}  LLR(end) {r['llr']:+.2f}"
            f" [{r['bounds'][0]:+.2f}, {r['bounds'][1]:+.2f}]  H0 d<={r['d0']:g} vs H1 d>={r['d1']:g}  {tail}{pent}")


def sprt_report(a, b, name):
    diffs = [d for _, d in paired_diffs(a, b)]
    r = sprt(diffs)
    return r, format_sprt(name, r, pentanomial(a, b))


def format_live(n, s):
    return (f"  {n:16s} n_live {s['n_live']:2d}/{s['n']:2d}  W {s['wins']:2d} L {s['losses']:2d} T {s['ties']:2d}"
            f"  d{OBJECTIVE or 'score'} {s['mean_diff']:+.3f} [{s['ci'][0]:+.3f}, {s['ci'][1]:+.3f}]  p={s['p']:.3f}  {s['verdict']}")


def print_table(d, names):
    data = {n: load(d, n) for n in names}
    resolve_objective(data)
    print(f"{'config':16s} {'games':>5s} {'alive':>5s} {'crown':>5s} {'top3':>4s} {'tiles':>9s} {'median':>7s} {'fit_old':>7s} {'score':>6s} {'wins':>4s} {'winrate':>7s} {'wscore':>6s}")
    for n in names:
        s = summary(data[n])
        print(f"{n:16s} {s['games']:5d} {s['alive']:5d} {s['crowns']:5d} {s['top3']:4d} {s['tiles']:9d} {int(s['median']):7d} {s['fitness']:7.3f} {s['score']:6.3f}"
              f" {s['wins']:4d} {s['winrate']:7.2f} {s['wscore']:6.3f}")
    print(OBJECTIVE_NOTE)
    base = names[0]
    if len(names) > 1:
        print(f"\npaired vs {base} (by batch+region; identical = the change never triggered):")
        for n in names[1:]:
            w, l, same, swings = paired(data[n], data[base])
            top = ", ".join(f"{k[1]}/{k[0]} {dt:+d}" for dt, k in swings[:3])
            print(f"  {n:16s} wins {w:2d}  loses {l:2d}  identical {same:2d}   swings: {top}")
        print(f"\nlive games vs {base} (fired non-empty or outcome differs; d = paired {OBJECTIVE} difference; sign test, bootstrap 95% CI):")
        for n in names[1:]:
            print(format_live(n, live_stats(data[n], data[base])))
        print(f"\npaired wins vs {base} (winner=us; McNemar-style exact sign test on the discordant pairs):")
        for n in names[1:]:
            print(format_win(n, base, win_stats(data[n], data[base])))
        if SPRT:
            print(f"\nsequential test vs {base} (GSPRT on the paired {OBJECTIVE} difference, live pairs in batch order; see --sprt):")
            for n in names[1:]:
                print(sprt_report(data[n], data[base], n)[1])
    missing = {n: 30 - len(data[n]) for n in names if len(data[n]) < 30}
    if missing:
        print("\nwarning: fewer than 30 games for " + ", ".join(f"{n} ({30 - m})" for n, m in missing.items()))
    note = assumed_note()
    if note:
        print("\n" + note)


def bradley_terry(names, wins, iters=500):
    """Zermelo / MM fit of p_i (ties count half). wins[(i, j)] = wins of i over j."""
    n = len(names)
    p = [1.0] * n
    tot = {(i, j): wins.get((i, j), 0) + wins.get((j, i), 0) for i in range(n) for j in range(n) if i != j}
    for _ in range(iters):
        new = []
        for i in range(n):
            w_i = sum(wins.get((i, j), 0) for j in range(n) if j != i)
            denom = sum(tot[(i, j)] / (p[i] + p[j]) for j in range(n) if j != i and tot[(i, j)])
            new.append(w_i / denom if denom and w_i else 1e-6)
        gm = math.exp(sum(math.log(x) for x in new) / n)
        p = [x / gm for x in new]
    return p


def print_ladder(d, names):
    data = {n: load(d, n) for n in names}
    resolve_objective(data)
    n = len(names)
    wins = {}
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            w, l, same, _ = paired(data[names[i]], data[names[j]])
            wins[(i, j)] = w + 0.5 * same
    p = bradley_terry(names, wins)
    order = sorted(range(n), key=lambda i: -p[i])
    head = "".join(f"{names[j][:10]:>11s}" for j in order)
    print(f"{'config':16s} {'strength':>8s} {'fit_old':>7s} {'score':>6s} {'alive':>5s} {'crown':>5s} {'wins':>4s} |{head}")
    for i in order:
        s = summary(data[names[i]])
        row = ""
        for j in order:
            if i == j:
                row += f"{'-':>11s}"
            else:
                w, l, same, _ = paired(data[names[i]], data[names[j]])
                row += f"{f'{w}-{l}-{same}':>11s}"
        print(f"{names[i]:16s} {math.log(p[i]):8.3f} {s['fitness']:7.3f} {s['score']:6.3f} {s['alive']:5d} {s['crowns']:5d} {s['wins']:4d} |{row}")
    print("\nstrength = log Bradley–Terry score (0 = average); cells = wins-losses-identical of row vs column (pairs by won, alive, tiles)")
    print(OBJECTIVE_NOTE)
    print("P(row beats column) = 1 / (1 + exp(strength_col - strength_row))")
    cand = names[0]
    ci = 0
    for j in range(1, n):
        prob = 1 / (1 + math.exp(math.log(p[j]) - math.log(p[ci])))
        print(f"  P({cand} beats {names[j]}) = {prob:.2f}")
    print(f"\nlive games of {cand} vs each version:")
    for j in range(1, n):
        print(format_live(names[j], live_stats(data[cand], data[names[j]])))
    print(f"\npaired wins of {cand} vs each version:")
    for j in range(1, n):
        print(format_win(cand, names[j], win_stats(data[cand], data[names[j]])))
    if SPRT:
        print(f"\nsequential test of {cand} vs each version:")
        for j in range(1, n):
            print(sprt_report(data[cand], data[names[j]], names[j])[1])
    print("\ntransitivity (--cycles):")
    print_cycles(d, names, data)
    note = assumed_note()
    if note:
        print("\n" + note)


def beats(a, b):
    """a beats b when it wins more (batch, region) pairs than it loses (paired() on alive, tiles)."""
    w, l, _, _ = paired(a, b)
    return w > l


def cycles(data, names):
    """Non-transitive triples: (x, y, z) with x beats y, y beats z, z beats x. Cheap check that the Bradley–Terry
    ladder's single strength axis is not hiding a rock-paper-scissors between versions (a candidate that beats its
    parent but loses to the grandparent)."""
    out = []
    n = len(names)
    for i in range(n):
        for j in range(n):
            for k in range(n):
                if len({i, j, k}) < 3 or not (i < j and i < k):
                    continue  # each cycle once, starting from its lowest index
                x, y, z = names[i], names[j], names[k]
                if beats(data[x], data[y]) and beats(data[y], data[z]) and beats(data[z], data[x]):
                    out.append((x, y, z))
    return out


def print_cycles(d, names, data=None):
    if data is None:
        data = {n: load(d, n) for n in names}
        resolve_objective(data)
    cyc = cycles(data, names)
    if not cyc:
        print(f"no non-transitive triples among {len(names)} configs (every triple orders consistently by paired wins)")
    for x, y, z in cyc:
        wxy = paired(data[x], data[y])[:2]; wyz = paired(data[y], data[z])[:2]; wzx = paired(data[z], data[x])[:2]
        print(f"cycle: {x} beats {y} ({wxy[0]}-{wxy[1]}), {y} beats {z} ({wyz[0]}-{wyz[1]}), {z} beats {x} ({wzx[0]}-{wzx[1]})")
    return len(cyc)


def verdict(d, names, thresh):
    """Staged A/B helper: 'clear' when |wins - losses| >= thresh vs the baseline. Exit code 0 iff all clear.
    With --sprt: 'clear' = the sequential test has decided (ACCEPT / REJECT), 'unclear' = CONTINUE."""
    data = {n: load(d, n) for n in names}
    resolve_objective(data)
    print(OBJECTIVE_NOTE)
    base = names[0]
    all_clear = True
    if SPRT:
        for n in names[1:]:
            r, line = sprt_report(data[n], data[base], n)
            clear = r["decision"] != "CONTINUE"
            all_clear = all_clear and clear
            print(f"{n} {'clear' if clear else 'unclear'} {r['decision']} n={r['n']} mean={r['mean']:+.3f} llr={r['llr']:+.2f}"
                  + ("" if clear else f" more={'inf' if r['more'] is None else r['more']}") + f" games={len(data[n])}")
        return 0 if all_clear else 1
    for n in names[1:]:
        w, l, same, _ = paired(data[n], data[base])
        clear = abs(w - l) >= thresh
        all_clear = all_clear and clear
        print(f"{n} {'clear' if clear else 'unclear'} wins={w} losses={l} identical={same} games={len(data[n])}")
    return 0 if all_clear else 1


def fitness_json(d, names, old):
    out = {}
    data = {n: load(d, n) for n in names}
    objective = resolve_objective(data)
    print(OBJECTIVE_NOTE, file=sys.stderr)
    for n in names:
        games = data[n]
        s = summary(games)
        items = sorted(games.items())
        per = {f"{b}/{r}": round(score(g), 6) for (b, r), g in items}
        per_old = {f"{b}/{r}": round(fitness(g), 6) for (b, r), g in items}
        per_w = {f"{b}/{r}": round(wscore(g), 6) for (b, r), g in items}
        per_wins = {f"{b}/{r}": int(won(g)) for (b, r), g in items}
        per_obj = {f"{b}/{r}": round(obj(g), 6) for (b, r), g in items}
        mean_obj = statistics.fmean(obj(g) for _, g in items) if items else 0.0
        out[n] = {
            "fitness": s["fitness"] if old else mean_obj,
            "objective": "fit_old" if old else objective,
            "score": s["score"], "fit_old": s["fitness"], "wscore": s["wscore"], "wins": s["wins"], "winrate": s["winrate"],
            "games": s["games"], "alive": s["alive"], "crowns": s["crowns"], "top3": s["top3"], "tiles": s["tiles"],
            "per_game": per_old if old else per_obj, "per_game_score": per, "per_game_old": per_old,
            "per_game_wscore": per_w, "per_game_wins": per_wins,
        }
    print(json.dumps(out, indent=1))
    note = assumed_note()
    if note:
        print(note, file=sys.stderr)


# ---------------------------------------------------------------- self-test

SELFTEST_BASE = [
    "== africa | spawn 1,1 (bot picker rank 0) | Medium == FINAL rank=1 share=0.90 alive=true tiles=100000 troops=1k players=40",
    "== australia | spawn 1,1 (bot picker rank 0) | Medium == FINAL rank=20 share=0.30 alive=true tiles=10000 troops=1k players=39",
    "== east-asia | spawn 1,1 (bot picker rank 0) | Medium == DEAD at 300s FINAL alive=false tiles=0 troops=0k players=40",
]
SELFTEST_CAND = [
    # same outcome as base but a flag fired -> live tie
    "== africa | spawn 1,1 (bot picker rank 0) | Medium == FINAL rank=1 share=0.90 alive=true tiles=100000 troops=1k players=40 fired=trustWars:2,nationAware:1",
    # better -> live win (rank 2/39: rankScore 1-1/38)
    "== australia | spawn 1,1 (bot picker rank 0) | Medium == FINAL rank=2 share=0.50 alive=true tiles=20000 troops=1k players=39 fired=-",
    # identical, nothing fired -> not live
    "== east-asia | spawn 1,1 (bot picker rank 0) | Medium == DEAD at 300s FINAL alive=false tiles=0 troops=0k players=40",
]


def selftest():
    def games(lines):
        return {("med0", g["region"]): g for g in (parse_line(l) for l in lines) if g}

    base, cand = games(SELFTEST_BASE), games(SELFTEST_CAND)
    expect = {"africa": 2.25, "australia": 0.8 + 0.5, "east-asia": 0.4}
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + msg)
        ok = ok and cond

    for r, e in expect.items():
        s = score(base[("med0", r)])
        check(abs(s - e) < 1e-9, f"score base/{r} = {s:.4f} (expected {e})")
    check(abs(fitness(base[("med0", "africa")]) - 2.9) < 1e-9, "fit_old base/africa = 2.9")
    check(cand[("med0", "africa")]["fired"] == {"trustWars": 2, "nationAware": 1}, "fired= parsed")
    check(cand[("med0", "australia")]["fired"] == {}, "fired=- is empty")
    check(base[("med0", "australia")]["players"] == 39, "players= parsed")
    nop = parse_line(SELFTEST_BASE[1].replace(" players=39", ""))
    check(nop["players"] is None and abs(rank_score(nop) - (1 - 19 / 39)) < 1e-9, f"missing players -> assume {ASSUMED_PLAYERS}")
    st = live_stats(cand, base)
    check(st["n"] == 3 and st["n_live"] == 2, f"n_live = {st['n_live']} of {st['n']} (expected 2 of 3)")
    check((st["wins"], st["losses"], st["ties"]) == (1, 0, 1), f"W/L/T = {st['wins']}/{st['losses']}/{st['ties']} (expected 1/0/1)")
    d_aus = (math.log10(20000) / 5 + 1 - 1 / 38) - 1.3
    check(abs(st["mean_diff"] - d_aus / 2) < 1e-9, f"mean paired diff = {st['mean_diff']:+.4f}")
    check(abs(st["p"] - 1.0) < 1e-9, f"sign test p = {st['p']} for 1 win 0 losses")
    check(st["verdict"].startswith("undecided"), f"verdict: {st['verdict']}")
    check(abs(sign_test(12, 2) - 0.012939) < 1e-5, f"sign test 12-2 p = {sign_test(12, 2):.6f}")
    check(sign_test(0, 0) == 1.0, "sign test with no decisive games = 1.0")
    lo, hi = bootstrap_ci([0.1, 0.2, 0.3, 0.4])
    check(0.1 <= lo <= 0.25 <= hi <= 0.4, f"bootstrap CI [{lo:.3f}, {hi:.3f}] brackets the mean")
    w, l, same, _ = paired(cand, base)
    check((w, l, same) == (1, 0, 2), f"old paired W/L/identical = {w}/{l}/{same} (expected 1/0/2)")

    # --- sequential test fixtures: a clear win, a clear loss, an undecided series
    rng = random.Random(3)
    win = [0.25 + rng.gauss(0, 0.1) for _ in range(60)]
    r = sprt(win)
    check(r["decision"] == "ACCEPT" and r["n_at"] <= 20, f"SPRT clear win: {r['decision']} at n={r['n_at']} (mean {r['mean']:+.3f})")
    loss = [-0.25 + rng.gauss(0, 0.1) for _ in range(60)]
    r = sprt(loss)
    check(r["decision"] == "REJECT" and r["n_at"] <= 20, f"SPRT clear loss: {r['decision']} at n={r['n_at']}")
    und = [0.05 + 0.3 * (1 if i % 2 else -1) for i in range(12)]  # mean exactly δ/2 = 0.05: no drift
    r = sprt(und)
    check(r["decision"] == "CONTINUE" and r["more"] is None, f"SPRT undecided at the indifference point: {r['decision']}, more={r['more']}")
    und2 = [0.45, -0.3] * 4  # mean 0.075, sd 0.4: a small positive drift that needs far more pairs
    r = sprt(und2)
    check(r["decision"] == "CONTINUE" and isinstance(r["more"], int) and r["more"] >= 1, f"SPRT small noisy sample: {r['decision']}, ~{r['more']} more")
    r = sprt([0.3])
    check(r["decision"] == "CONTINUE" and r["more"] == SPRT_MIN_N - 1, "SPRT with one observation continues")
    # lab-out/final shape (2026-08-30): the first two pairs strongly negative and nearly equal, the other 16 positive.
    early = [-0.48, -0.28] + [0.25 + rng.gauss(0, 0.3) for _ in range(16)]
    r = sprt(early)
    check(r["decision"] != "REJECT" and (r["n_at"] is None or r["n_at"] >= SPRT_MIN_N) and r["mean"] > 0,
          f"SPRT does not decide on two early pairs: {r['decision']} at n={r['n_at']}, series mean {r['mean']:+.3f}")
    r = sprt([0.2, 0.2, 0.2])
    check(r["decision"] == "CONTINUE" and r["more"] == SPRT_MIN_N - 3, f"three identical pairs do not decide (var floor δ², min n): {r['decision']}, more={r['more']}")
    r = sprt([-0.3 + rng.gauss(0, 0.05) for _ in range(30)], d0=-0.1, d1=0.0)
    check(r["decision"] == "REJECT", f"SPRT racing form (d0=-δ, d1=0) rejects a member 0.3 below the parent: {r['decision']}")
    r = sprt([0.0 + rng.gauss(0, 0.05) for _ in range(30)], d0=-0.1, d1=0.0)
    check(r["decision"] == "ACCEPT", f"SPRT racing form keeps a member level with the parent: {r['decision']}")
    lo_b, hi_b = r["bounds"]
    check(abs(hi_b - 2.944) < 1e-3 and abs(lo_b + 2.944) < 1e-3, f"SPRT bounds ±{hi_b:.3f}")

    # --- mirrored slots: med0 + med0b pair into one observation; pentanomial counts
    check(split_slot("med0b") == ("med0", "b") and split_slot("med0") == ("med0", "a") and split_slot("g3b") == ("g3", "b"),
          "split_slot: med0b is slot b of med0")
    base2 = dict(base); cand2 = dict(cand)
    for r_ in ("africa", "australia", "east-asia"):
        base2[("med0b", r_)] = base[("med0", r_)]
        cand2[("med0b", r_)] = cand[("med0", r_)]
    # slot b of australia: candidate loses instead of winning -> the scenario's observation is the mean of the two
    cand2[("med0b", "australia")] = parse_line(SELFTEST_BASE[1].replace("tiles=10000", "tiles=5000").replace("rank=20", "rank=25"))
    obs = paired_diffs(cand2, base2)
    check([s_ for s_, _ in obs] == [("med0", "africa"), ("med0", "australia")], f"mirrored observations: {[s_ for s_, _ in obs]}")
    d_b = (math.log10(5000) / 5 + 1 - 24 / 38) - 1.3
    check(abs(obs[1][1] - (d_aus + d_b) / 2) < 1e-9, f"mirrored australia observation = mean of the slots ({obs[1][1]:+.4f})")
    pent = pentanomial(cand2, base2)
    check(pent == {"LL": 0, "LT": 0, "TT": 3, "WT": 0, "WW": 0}, f"pentanomial (africa TT, australia WL=TT, east-asia TT): {pent}")
    # a slot missing for one config (the shifted game failed): the scenario falls back to the slot both played
    cand3 = dict(cand2); del cand3[("med0b", "australia")]
    obs3 = paired_diffs(cand3, base2)
    check(len(obs3) == 2 and abs(obs3[1][1] - d_aus) < 1e-9, f"missing slot b: australia observation = slot a alone ({obs3[1][1]:+.4f})")
    check(pentanomial(cand3, base2) == {"LL": 0, "LT": 0, "TT": 2, "WT": 0, "WW": 0}, "missing slot b: pentanomial skips that scenario")
    st3 = live_stats(cand3, base2)
    check(st3["n"] == 5 and st3["n_live"] == 3, f"missing slot b: live_stats pairs {st3['n']} games, {st3['n_live']} live (per game, not per scenario)")
    check(pentanomial(cand, base) is None, "pentanomial is None without mirrored slots")

    # --- cycles: rock-paper-scissors between three configs on three scenarios
    def g(tiles):
        return {("med0", f"r{i}"): parse_line(SELFTEST_BASE[0].replace("tiles=100000", f"tiles={t}")) for i, t in enumerate(tiles)}
    trio = {"x": g([3, 2, 1]), "y": g([1, 3, 2]), "z": g([2, 1, 3])}  # x beats z 2-1, z beats y 2-1, y beats x 2-1
    cyc = cycles(trio, ["x", "y", "z"])
    check(cyc == [("x", "z", "y")], f"cycle x>z>y>x found: {cyc}")
    check(cycles({"x": trio["x"], "y": trio["x"], "z": trio["x"]}, ["x", "y", "z"]) == [], "no cycle among identical configs")

    # --- full games: three results dirs on disk, run through the real load/objective path
    import contextlib
    import io
    import tempfile

    def reset_objective(name=None):
        global OBJECTIVE, OBJECTIVE_NOTE, SPRT_DELTA, DELTA_SET
        OBJECTIVE, OBJECTIVE_NOTE, SPRT_DELTA, DELTA_SET = name, None, 0.10, False

    def final(region, win, fired="-", winner_field=True):
        w = "us" if win else "other"
        tail = f" players=40 winner={w} fired={fired}" if winner_field else f" players=40 fired={fired}"
        if win:
            return f"== {region} | spawn 1,1 (bot picker rank 0) | Medium == FINAL rank=1 share=1.00 alive=true tiles=200000 troops=1k{tail}"
        return f"== {region} | spawn 1,1 (bot picker rank 0) | Medium == FINAL rank=5 share=0.40 alive=true tiles=50000 troops=1k{tail}"

    def write_dir(d, cfg, batches, line_fn):
        for b in batches:
            with open(os.path.join(d, f"ab30_{cfg}_{b}.txt"), "w") as fh:
                for i in range(10):
                    fh.write(line_fn(f"r{i}", i) + "\n")

    def run(args):
        reset_objective()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = main(args)
        return rc, buf.getvalue()

    with tempfile.TemporaryDirectory() as tmp:
        # candidate wins 6/10 per batch (r1 r3 r5 r7 r9 alone, r0 with base), base 2/10 (r0, r2); r4 r6 r8 nobody
        full = os.path.join(tmp, "full"); os.makedirs(full)
        cand_wins = {0, 1, 3, 5, 7, 9}; base_wins = {0, 2}
        BATCHES6 = [f"med{i}" for i in range(6)]  # 60 games: 6/10 vs 2/10 per batch
        write_dir(full, "base", BATCHES6, lambda r, i: final(r, i in base_wins))
        write_dir(full, "cand", BATCHES6, lambda r, i: final(r, i in cand_wins, fired="x:1"))
        reset_objective()
        data = {n: load(full, n) for n in ("base", "cand")}
        check(resolve_objective(data) == "wscore" and "auto" in OBJECTIVE_NOTE and "warning" not in OBJECTIVE_NOTE,
              f"full-game dir auto-selects wscore: {OBJECTIVE_NOTE}")
        sb, sc = summary(data["base"]), summary(data["cand"])
        check((sb["wins"], sc["wins"]) == (12, 36) and abs(sc["winrate"] - 0.6) < 1e-9, f"wins base/cand = {sb['wins']}/{sc['wins']}, cand winrate {sc['winrate']:.2f}")
        check(abs(wscore(data["cand"][("med0", "r1")]) - score(data["cand"][("med0", "r1")]) - 1.0) < 1e-9 and abs(wscore(data["base"][("med0", "r1")]) - score(data["base"][("med0", "r1")])) < 1e-9,
              "wscore = score + 1.0 for a win, = score otherwise")
        ws = win_stats(data["cand"], data["base"])
        check((ws["wins_a"], ws["wins_b"], ws["a_only"], ws["b_only"], ws["both"], ws["neither"]) == (36, 12, 30, 6, 6, 18),
              f"paired wins: {ws['wins_a']} vs {ws['wins_b']}, A-only {ws['a_only']} / B-only {ws['b_only']} / both {ws['both']} / neither {ws['neither']}")
        check(abs(ws["p"] - sign_test(30, 6)) < 1e-12 and ws["p"] < 0.05, f"McNemar p = {ws['p']:.4f}")
        for name, want_delta in (("wscore", 0.10), ("winrate", 0.15)):
            reset_objective(name); resolve_objective(data)
            check(abs(SPRT_DELTA - want_delta) < 1e-12, f"--objective {name}: δ = {SPRT_DELTA}")
            r = sprt([dd for _, dd in paired_diffs(data["cand"], data["base"])])
            check(r["decision"] == "ACCEPT", f"--objective {name}: SPRT {r['decision']} at n={r['n_at']} (mean {r['mean']:+.3f})")
        reset_objective("score"); resolve_objective(data)
        st = live_stats(data["cand"], data["base"])
        check(st["n_live"] == 60 and st["wins"] == 30 and st["losses"] == 6, f"--objective score on the same dir: W/L {st['wins']}/{st['losses']} of {st['n_live']} live")
        rc, out = run(["--sprt", "--verdict", "0", full, "base", "cand"])
        check(rc == 0 and "cand clear ACCEPT" in out, f"--sprt --verdict 0 (remote.sh SPRT=1 call) exits {rc}: {out.strip().splitlines()[-1]}")
        rc, out = run(["--objective", "winrate", "--sprt", "--verdict", "0", full, "base", "cand"])
        check(rc == 0 and "cand clear ACCEPT" in out, f"--objective winrate --sprt --verdict 0 exits {rc}")
        rc, out = run(["--fitness", full, "base", "cand"])
        fit = json.loads(out)
        check(fit["cand"]["objective"] == "wscore" and abs(fit["cand"]["fitness"] - fit["cand"]["wscore"]) < 1e-9
              and fit["cand"]["wins"] == 36 and fit["cand"]["per_game_wins"]["med0/r1"] == 1 and fit["base"]["per_game_wins"]["med0/r1"] == 0,
              f"--fitness: objective {fit['cand']['objective']}, fitness {fit['cand']['fitness']:.3f} = wscore, wins/per_game_wins present")
        rc, out = run([full, "base", "cand"])
        check(rc == 0 and "wins cand vs base: 36 12" in out and "objective: wscore (auto" in out, "table prints the WIN line and the objective note")

        # a 20-minute dir without winner= : objective score, same numbers as the in-memory fixture above
        short = os.path.join(tmp, "short"); os.makedirs(short)
        for cfg, lines in (("base", SELFTEST_BASE), ("cand", SELFTEST_CAND)):
            with open(os.path.join(short, f"ab30_{cfg}_med0.txt"), "w") as fh:
                fh.write("\n".join(lines) + "\n")
        reset_objective()
        data = {n: load(short, n) for n in ("base", "cand")}
        check(resolve_objective(data) == "score" and all(g["winner"] is None for g in data["cand"].values()), f"20-min dir: {OBJECTIVE_NOTE}")
        st = live_stats(data["cand"], data["base"])
        check(st["n_live"] == 2 and abs(st["mean_diff"] - d_aus / 2) < 1e-9, f"20-min dir: n_live {st['n_live']}, mean diff {st['mean_diff']:+.4f} (unchanged)")
        check(summary(data["cand"])["wins"] == 0 and abs(summary(data["cand"])["wscore"] - summary(data["cand"])["score"]) < 1e-12, "20-min dir: wins 0, wscore = score")
        rc, out = run(["--fitness", short, "base", "cand"])
        fit = json.loads(out)
        check(fit["cand"]["objective"] == "score" and abs(fit["cand"]["fitness"] - fit["cand"]["score"]) < 1e-9, "20-min dir: --fitness reports score")

        # mixed: the base has winner=, the candidate's files do not -> warn, use wscore
        mixed = os.path.join(tmp, "mixed"); os.makedirs(mixed)
        write_dir(mixed, "base", ["med0"], lambda r, i: final(r, i in base_wins))
        write_dir(mixed, "cand", ["med0"], lambda r, i: final(r, i in cand_wins, winner_field=False))
        reset_objective()
        data = {n: load(mixed, n) for n in ("base", "cand")}
        check(resolve_objective(data) == "wscore" and "warning: mixed" in OBJECTIVE_NOTE, f"mixed dir: {OBJECTIVE_NOTE.splitlines()[-1]}")
        check(summary(data["cand"])["wins"] == 0, "mixed dir: games without winner= count as no win")
    reset_objective()
    print("selftest " + ("passed" if ok else "FAILED"))
    return 0 if ok else 1


def main(argv):
    global AT, SPRT, SPRT_DELTA, SPRT_ALPHA, SPRT_BETA, OBJECTIVE, DELTA_SET
    mode = "table"
    thresh = 3
    old = False
    while argv and argv[0].startswith("--"):
        if argv[0] == "--at":
            AT = int(argv[1]); argv = argv[2:]
        elif argv[0] == "--verdict":
            mode = "verdict"; thresh = int(argv[1]); argv = argv[2:]
        elif argv[0] in ("--fitness", "--ladder", "--cycles"):
            mode = argv[0][2:]; argv = argv[1:]
        elif argv[0] == "--sprt":
            SPRT = True; argv = argv[1:]
        elif argv[0] == "--delta":
            SPRT_DELTA = float(argv[1]); DELTA_SET = True; argv = argv[2:]
        elif argv[0] == "--objective":
            if argv[1] not in OBJECTIVES:
                print(f"--objective must be one of {', '.join(OBJECTIVES)}"); return 2
            OBJECTIVE = argv[1]; argv = argv[2:]
        elif argv[0] == "--alpha":
            SPRT_ALPHA = float(argv[1]); argv = argv[2:]
        elif argv[0] == "--beta":
            SPRT_BETA = float(argv[1]); argv = argv[2:]
        elif argv[0] == "--old-fitness":
            old = True; argv = argv[1:]
        elif argv[0] == "--selftest":
            return selftest()
        else:
            print(f"unknown option {argv[0]}"); return 2
    if not argv:
        print(__doc__)
        return 2
    d = argv[0]
    names = argv[1:] or discover(d)
    if not names and AT is not None:
        names = sorted({os.path.basename(f)[2:].rsplit("_", 2)[0] for f in glob.glob(os.path.join(d, "p_*_*_*.txt"))})
    if not names:
        print(f"no ab30_*.txt files in {d}")
        return 1
    if mode == "fitness":
        fitness_json(d, names, old)
    elif mode == "verdict":
        if len(names) < 2:
            print("--verdict needs a baseline and at least one candidate")
            return 2
        return verdict(d, names, thresh)
    elif mode == "ladder":
        if len(names) < 2:
            print("--ladder needs a candidate and at least one version")
            return 2
        print_ladder(d, names)
    elif mode == "cycles":
        if len(names) < 3:
            print("--cycles needs at least three configs")
            return 2
        print_cycles(d, names)
    else:
        print_table(d, names)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
