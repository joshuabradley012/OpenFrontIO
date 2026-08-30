#!/usr/bin/env python3
"""Fit the PlaybookBot attack estimator's calibration constants from lab transcripts (python3 stdlib only).

The bot logs, for every war wave and every tribe's first click (Military.noteWave / trackCalibration):

    t812 EST Foo wave=3 troops=61000 tilesEst=1188 lossEst=49360 ticksEst=31 wins=false class=human others=0
    t990 ACT Foo wave=3 tiles=1020 ours=1105 loss=52000 ticks=178 sent=61000 left=9000 class=human end=retreat

This script reads every `log:` line in the .txt files of a results dir (the format tests/lab/playbook.lab.ts writes,
one game per `== region | … ==` block), pairs EST with ACT by (game, target, wave) and fits, per defender class:

    lossScale  = exp(mean(log((loss_act / tiles_act) / (loss_est / tiles_est))))   the per-tile loss multiplier
    speedScale = exp(mean(log((tiles_act / ticks_act) / (tiles_est / ticks_est))))  the tiles-per-tick multiplier

i.e. the least-squares fit of the multiplicative correction in log space, with the residual spread (standard
deviation of the log ratios) and the count. Pairs with zero tiles or losses on either side are skipped (a wave that
never engaged carries no information), as are `end=fast` pairs (the attack was over before the bot's first 10-tick
look at it: tiles are known, the loss and the ticks are not). `others` > 0 pairs are kept but counted separately:
the target's other attackers inflate its tile loss, so the loss fit reads low on them.

    python3 scripts/lab/calibrate.py DIR [DIR …]     # table + JSON blob with the fitted Params values
    python3 scripts/lab/calibrate.py --json DIR       # JSON only
    python3 scripts/lab/calibrate.py --selftest       # synthetic fixture, exit 0 iff the fit recovers it

Paste the blob's estLossScale* / estSpeedScale into DEFAULT_PLAYBOOK (Params.ts) or a lab CONFIGS entry; the
speed scale is fitted over all classes (one movement formula) and per class for the reader.
"""
import glob
import json
import math
import os
import re
import statistics
import sys

EST_RE = re.compile(
    r"t(?P<t>\d+) EST (?P<target>.+?) wave=(?P<wave>\d+) troops=(?P<troops>\d+) tilesEst=(?P<tiles>\d+) "
    r"lossEst=(?P<loss>\d+) ticksEst=(?P<ticks>\d+) wins=(?P<wins>\w+) class=(?P<cls>\w+)(?: others=(?P<others>\d+))?"
)
ACT_RE = re.compile(
    r"t(?P<t>\d+) ACT (?P<target>.+?) wave=(?P<wave>\d+) tiles=(?P<tiles>\d+)(?: ours=(?P<ours>-?\d+))? loss=(?P<loss>\d+) "
    r"ticks=(?P<ticks>\d+)(?: sent=(?P<sent>\d+))?(?: left=(?P<left>\d+))? class=(?P<cls>\w+)(?: end=(?P<end>\w+))?"
)
CLASSES = ("nation", "human", "bot")
PARAM = {"nation": "estLossScaleNation", "human": "estLossScaleHuman", "bot": "estLossScaleBot"}


def games(text):
    """Yield (header, log_line) per game block of a lab transcript."""
    header = None
    for line in text.splitlines():
        if line.startswith("== "):
            header = line
        elif line.lstrip().startswith("log: "):
            yield header or "?", line.lstrip()[5:]


def pairs_from_log(game, log):
    """EST/ACT pairs of one game's log: list of dicts with est_*, act_* fields."""
    est = {}
    out = []
    for entry in log.split(" | "):
        m = EST_RE.search(entry)
        if m:
            est[(m["target"], m["wave"])] = m.groupdict()
            continue
        m = ACT_RE.search(entry)
        if m:
            e = est.pop((m["target"], m["wave"]), None)
            if e is None:
                continue
            out.append({
                "game": game, "target": m["target"], "wave": int(m["wave"]), "cls": m["cls"],
                "others": int(e["others"] or 0),
                "est_tiles": int(e["tiles"]), "est_loss": int(e["loss"]), "est_ticks": int(e["ticks"]), "est_troops": int(e["troops"]),
                "act_tiles": int(m["tiles"]), "act_loss": int(m["loss"]), "act_ticks": int(m["ticks"]),
                "sent": int(m["sent"] or e["troops"]), "end": m["end"] or "?",
            })
    return out, len(est)  # unpaired ESTs (attacks still running when the game ended)


def collect(dirs):
    pairs, unpaired = [], 0
    for d in dirs:
        files = [d] if os.path.isfile(d) else sorted(glob.glob(os.path.join(d, "*.txt")))
        for f in files:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for header, log in games(fh.read()):
                    p, u = pairs_from_log(f"{os.path.basename(f)}:{header[:40]}", log)
                    pairs.extend(p)
                    unpaired += u
    return pairs, unpaired


def fit(pairs):
    """Per class (and 'all'): n, lossScale, lossSpread, speedScale, speedSpread, plus the log ratios."""
    res = {}
    for cls in CLASSES + ("all",):
        sel = [p for p in pairs if cls == "all" or p["cls"] == cls]
        loss_lr, speed_lr = [], []
        for p in sel:
            if p["end"] == "fast":
                continue
            if p["est_tiles"] > 0 and p["act_tiles"] > 0 and p["est_loss"] > 0 and p["act_loss"] > 0:
                loss_lr.append(math.log((p["act_loss"] / p["act_tiles"]) / (p["est_loss"] / p["est_tiles"])))
            if p["est_tiles"] > 0 and p["act_tiles"] > 0 and p["est_ticks"] > 0 and p["act_ticks"] > 0:
                speed_lr.append(math.log((p["act_tiles"] / p["act_ticks"]) / (p["est_tiles"] / p["est_ticks"])))
        r = {"n": len(sel), "engaged": len(loss_lr), "clean": sum(1 for p in sel if p["others"] == 0)}
        r["lossScale"] = math.exp(statistics.fmean(loss_lr)) if loss_lr else None
        r["lossSpread"] = statistics.pstdev(loss_lr) if len(loss_lr) > 1 else None
        r["lossMedian"] = math.exp(statistics.median(loss_lr)) if loss_lr else None
        r["speedScale"] = math.exp(statistics.fmean(speed_lr)) if speed_lr else None
        r["speedSpread"] = statistics.pstdev(speed_lr) if len(speed_lr) > 1 else None
        r["speedMedian"] = math.exp(statistics.median(speed_lr)) if speed_lr else None
        res[cls] = r
    return res


def fmt(x, d=2):
    return "-" if x is None else f"{x:.{d}f}"


def report(pairs, unpaired, json_only=False):
    res = fit(pairs)
    blob = {
        PARAM[c]: round(res[c]["lossScale"], 3) if res[c]["lossScale"] is not None else 1.0 for c in CLASSES
    }
    blob["estSpeedScale"] = round(res["all"]["speedScale"], 3) if res["all"]["speedScale"] is not None else 1.0
    blob["_n"] = {c: res[c]["engaged"] for c in CLASSES + ("all",)}
    blob["_spread"] = {c: {"loss": res[c]["lossSpread"], "speed": res[c]["speedSpread"]} for c in CLASSES + ("all",)}
    blob["_unpairedEst"] = unpaired
    if not json_only:
        print(f"{len(pairs)} EST/ACT pairs ({unpaired} EST without ACT: attacks still running at the end)")
        print(f"{'class':8} {'n':>5} {'engaged':>7} {'clean':>5} {'lossScale':>9} {'median':>7} {'spread':>6} {'speedScale':>10} {'median':>7} {'spread':>6}")
        for c in CLASSES + ("all",):
            r = res[c]
            print(f"{c:8} {r['n']:5d} {r['engaged']:7d} {r['clean']:5d} {fmt(r['lossScale']):>9} {fmt(r['lossMedian']):>7} {fmt(r['lossSpread']):>6} {fmt(r['speedScale']):>10} {fmt(r['speedMedian']):>7} {fmt(r['speedSpread']):>6}")
        ends = {}
        for p in pairs:
            ends[p["end"]] = ends.get(p["end"], 0) + 1
        print("ends: " + ", ".join(f"{k}={v}" for k, v in sorted(ends.items())))
        print("\nParams (paste into DEFAULT_PLAYBOOK or a CONFIGS entry):")
    print(json.dumps(blob, indent=2))
    return blob


def selftest():
    """Synthetic transcript: every actual is 1.5× the estimated loss per tile and 0.8× its speed for nations,
    2.0× / 0.5× for humans, 1.0× / 1.0× for bots (three waves each, plus one wave that never engaged, one
    end=fast wave, one unpaired EST, and an ACT with no EST)."""
    rows = []
    wave = 0
    scales = {"nation": (1.5, 0.8), "human": (2.0, 0.5), "bot": (1.0, 1.0)}
    for cls, (ls, ss) in scales.items():
        for i in range(3):
            wave += 1
            tiles_e, loss_e, ticks_e = 1000 + 100 * i, 40000 + 5000 * i, 100 + 10 * i
            tiles_a = tiles_e // 2
            loss_a = round(loss_e / tiles_e * ls * tiles_a)
            ticks_a = round(tiles_a / (tiles_e / ticks_e * ss))
            rows.append(f"t{100 * wave} EST X{wave} wave={wave} troops=61000 tilesEst={tiles_e} lossEst={loss_e} ticksEst={ticks_e} wins=false class={cls} others=0")
            rows.append(f"t{100 * wave + ticks_a} ACT X{wave} wave={wave} tiles={tiles_a} ours={tiles_a} loss={loss_a} ticks={ticks_a} sent=61000 left=1000 class={cls} end=retreat")
    rows.append("t9000 EST Y wave=99 troops=5000 tilesEst=0 lossEst=0 ticksEst=0 wins=false class=bot others=0")
    rows.append("t9010 ACT Y wave=99 tiles=0 ours=0 loss=0 ticks=10 sent=5000 left=5000 class=bot end=done")
    rows.append("t9400 EST F wave=98 troops=5000 tilesEst=50 lossEst=500 ticksEst=5 wins=true class=bot others=0")
    rows.append("t9420 ACT F wave=98 tiles=60 ours=60 loss=0 ticks=20 sent=5000 left=5000 class=bot end=fast")
    rows.append("t9500 EST Z wave=100 troops=5000 tilesEst=10 lossEst=100 ticksEst=5 wins=true class=bot others=0")
    rows.append("t9600 ACT Q wave=7 tiles=3 ours=3 loss=30 ticks=3 sent=500 left=470 class=bot end=done")
    text = "== africa | spawn 1,1 | Medium == FINAL rank=1 alive=true tiles=1\n  log: " + " | ".join(rows) + "\n"
    pairs = []
    unpaired = 0
    for header, log in games(text):
        p, u = pairs_from_log(header, log)
        pairs.extend(p)
        unpaired += u
    assert len(pairs) == 11, len(pairs)
    assert unpaired == 1, unpaired
    res = fit(pairs)
    for cls, (ls, ss) in scales.items():
        assert abs(res[cls]["lossScale"] - ls) < 0.02, (cls, res[cls])
        assert abs(res[cls]["speedScale"] - ss) < 0.05, (cls, res[cls])  # ticks are rounded
        assert res[cls]["lossSpread"] < 0.02, (cls, res[cls])
    assert res["bot"]["n"] == 5 and res["bot"]["engaged"] == 3, res["bot"]
    blob = report(pairs, unpaired, json_only=True)
    assert abs(blob["estLossScaleHuman"] - 2.0) < 0.02, blob
    print("selftest ok")


def main(argv):
    if "--selftest" in argv:
        selftest()
        return 0
    json_only = "--json" in argv
    dirs = [a for a in argv if not a.startswith("--")]
    if not dirs:
        print(__doc__)
        return 2
    pairs, unpaired = collect(dirs)
    if not pairs:
        print("no EST/ACT pairs found", file=sys.stderr)
        return 1
    report(pairs, unpaired, json_only)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
