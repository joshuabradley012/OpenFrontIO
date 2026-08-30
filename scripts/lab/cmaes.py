#!/usr/bin/env python3
"""CMA-ES over continuous PlaybookParams, one lab sweep per generation.

Each generation samples a population of parameter sets, writes them as the
CONFIGS JSON of one sweep (scripts/lab/remote.sh on Hetzner, or sweep.sh
locally with --runner local), scores every game with summarize.py (score =
landScore + rankScore + crown, see its docstring; --old-fitness for the old
alive + share + top3) and updates the search distribution. Same grid every
generation, so scores are paired.

Noise handling (2026-08-30):
  * every generation also runs the current distribution mean as config
    "mean" (--reeval-mean, default on; --no-reeval-mean to skip; --with-base
    still adds "base": {} as a drift reference);
  * the value handed to CMA-ES for a member is the mean over the grid of
    (member score - "mean" score on the same game) — a common-random-numbers
    paired difference, so the per-game scenario noise cancels. --raw-fitness
    ranks by plain mean score instead (the old behaviour);
  * --games-growth: once sigma falls below --grow-below (0.12) every later
    generation also runs --extra-batches ("med5 … med9", SPAWNRANK 5–9 on
    Medium; see docs/PlaybookBotLab.md), i.e. 60 games per config, so the
    fine end of the search is not fitted to 30 fixed scenarios;
  * gen_N.json stores the per-game score matrix of every config
    ("per_game", plus "per_game_old"), and --rescore OUT recomputes the score
    fields of every gen_N.json from the stored ab30 files with the current
    summarize.py without running anything (the CMA state is left as it was —
    the populations were sampled from it).

Common random numbers: every config of a generation (members, "mean", "base")
plays the same batch list on the same seed — a lab game is fixed by
(batch, spawn, SHIFT, SEED), see tests/lab/playbook.lab.ts — so per-game
differences against "mean" are paired. (Verified 2026-08-29: sweep.sh builds
one job list per CONFIGS and the gameID "lab" seeds nations, tribes and bot.)

Racing (--race, 2026-08-29): a generation first plays --race-stage (3)
batches; each member's paired differences vs "mean" on those games go through
the sequential test of summarize.py (sprt with d0 = -δ, d1 = 0, δ =
--race-delta 0.10 score units); a member the test REJECTs is "worse than the
parent by δ" and plays no more this generation (it keeps its objective over
the games it did play — a fair ranking for CMA-ES's tail). The batches the
dropped members would have played are spent on the survivors: extra
batches from --extra-batches (med5 …) are added, as many as the saved games
buy (saved / survivors, rounded down, capped by the list). gen_N.json
records "race": {stage, dropped, extra, batches_by_config}; --rescore
honours it, and gen files without it (older campaigns) still rescore.

retreatBelowRatio was dropped from BUILTIN_SPEC on 2026-08-29: Params.ts
declares it but nothing reads it (Military.ts uses literal retreat
thresholds), so it was a pure noise dimension inflating sigma. The spec is
checked against DEFAULT_PLAYBOOK by parsing Params.ts at start-up: a spec
key that is not a parameter, or an init that differs from the default, is
printed as a warning.

  python3 scripts/lab/cmaes.py --out lab-out/cma --pop 10 --gens 12 --minutes 20     # Hetzner
  python3 scripts/lab/cmaes.py --out lab-out/cma --pop 10 --gens 12 --race            # + racing (fewer games per gen)
  python3 scripts/lab/cmaes.py --out /tmp/cma --pop 4 --gens 2 --dry-run              # no games, synthetic fitness
  python3 scripts/lab/cmaes.py --out lab-out/cma --pop 10 --gens 12                   # again = resume from the last gen_N.json
  python3 scripts/lab/cmaes.py --rescore lab-out/cma                                 # re-score stored results, no games

State lives in OUT/gen_N.json (population, scores, mean, sigma, C, paths);
the sweep results of generation N are in OUT/gen_N/. Re-running with the same
--out resumes: a finished generation is skipped, a generation whose sweep
already produced 30 games per config is scored without re-running it.

The search space is the unit cube; each parameter is mapped linearly onto
[lo, hi] ("int" parameters are rounded). Bounds come from --spec (JSON file)
or --param name=lo:hi[:init][:int]; the built-in spec is the 12-parameter
list of docs/PlaybookBotPlan.md (C3). Hetzner env vars (SERVER_TYPE, NAME,
LOCATION, …) pass through to remote.sh; the server is kept between
generations (KEEP=1, REUSE=1 after the first) and is never deleted here — run
`hcloud server delete $(hcloud server list -l lab=1 -o noheader -o columns=name)`
when the campaign is over. WORKERS=4 in the env spreads each generation over
four boxes (one shard each; ~15 min a generation for pop 10).

Pure python (stdlib only); numpy is used for the eigendecomposition when it
happens to be installed, a Jacobi solver otherwise.
"""
import argparse
import glob
import json
import math
import os
import random
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SUMMARIZE = os.path.join(HERE, "summarize.py")
PARAMS_TS = os.path.join(ROOT, "src", "core", "execution", "playbook", "Params.ts")
sys.path.insert(0, HERE)
from summarize import sprt  # noqa: E402  (stdlib-only module next to this one)

# name: (lo, hi, init, int?) — init = DEFAULT_PLAYBOOK on 2026-08-29; check_spec() compares it with Params.ts
# retreatBelowRatio is declared but read nowhere (dropped 2026-08-29, see the docstring)
BUILTIN_SPEC = {
    "expandContested": (0.05, 0.5, 0.2, False),
    "expandFree": (0.03, 0.3, 0.1, False),
    "botRatio": (1.1, 3.0, 1.67, False),
    "botClickCap": (0.1, 0.6, 0.3, False),
    "fightAbove": (0.4, 0.95, 0.7, False),
    "fightMaxShare": (0.3, 0.9, 0.6, False),
    "reserveShare": (0.1, 0.5, 0.3, False),
    "capFullShare": (0.3, 0.9, 0.6, False),
    "bombReserve": (0, 1_000_000, 250_000, True),
    "railSpacing": (8, 32, 16, True),
}

SPAWNS = ["north-russia", "north-america", "east-asia", "africa", "south-america", "australia"]
BATCHES = ["med0", "med1", "med2", "med3", "med4"]
EXTRA_BATCHES = "med5 med6 med7 med8 med9"   # SPAWNRANK 5-9 on Medium (sweep.sh: med[0-9] -> DIFF=medium SPAWNRANK=k)


# ---------------------------------------------------------------- linear algebra (pure python)

def zeros(n):
    return [[0.0] * n for _ in range(n)]


def eye(n):
    m = zeros(n)
    for i in range(n):
        m[i][i] = 1.0
    return m


def matvec(m, v):
    return [sum(m[i][j] * v[j] for j in range(len(v))) for i in range(len(m))]


def eigh(C):
    """Symmetric eigendecomposition -> (eigenvalues, B) with C = B diag(vals) B^T; B[i][k] = k-th vector's i-th comp."""
    try:
        import numpy as np  # optional fast path

        vals, vecs = np.linalg.eigh(np.array(C))
        return [float(v) for v in vals], [[float(x) for x in row] for row in vecs]
    except ImportError:
        pass
    n = len(C)
    a = [row[:] for row in C]
    v = eye(n)
    for _ in range(100):
        off = sum(a[i][j] ** 2 for i in range(n) for j in range(n) if i != j)
        if off < 1e-22:
            break
        for p in range(n - 1):
            for q in range(p + 1, n):
                if abs(a[p][q]) < 1e-300:
                    continue
                theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
                t = (1.0 if theta >= 0 else -1.0) / (abs(theta) + math.sqrt(theta * theta + 1))
                c = 1 / math.sqrt(t * t + 1)
                s = t * c
                for k in range(n):
                    akp, akq = a[k][p], a[k][q]
                    a[k][p], a[k][q] = c * akp - s * akq, s * akp + c * akq
                for k in range(n):
                    apk, aqk = a[p][k], a[q][k]
                    a[p][k], a[q][k] = c * apk - s * aqk, s * apk + c * aqk
                for k in range(n):
                    vkp, vkq = v[k][p], v[k][q]
                    v[k][p], v[k][q] = c * vkp - s * vkq, s * vkp + c * vkq
    return [a[i][i] for i in range(n)], v


# ---------------------------------------------------------------- CMA-ES

class CMA:
    """Minimal (mu/mu_w, lambda)-CMA-ES after Hansen's tutorial; maximises."""

    def __init__(self, n, lam, sigma, mean=None, rng=None):
        self.n, self.lam, self.sigma = n, lam, sigma
        self.rng = rng or random.Random(0)
        self.mean = mean[:] if mean else [0.5] * n
        self.mu = lam // 2
        w = [math.log(self.mu + 0.5) - math.log(i + 1) for i in range(self.mu)]
        self.w = [x / sum(w) for x in w]
        self.mueff = 1 / sum(x * x for x in self.w)
        self.cc = (4 + self.mueff / n) / (n + 4 + 2 * self.mueff / n)
        self.cs = (self.mueff + 2) / (n + self.mueff + 5)
        self.c1 = 2 / ((n + 1.3) ** 2 + self.mueff)
        self.cmu = min(1 - self.c1, 2 * (self.mueff - 2 + 1 / self.mueff) / ((n + 2) ** 2 + self.mueff))
        self.damps = 1 + 2 * max(0.0, math.sqrt((self.mueff - 1) / (n + 1)) - 1) + self.cs
        self.chiN = math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n))
        self.C = eye(n)
        self.pc = [0.0] * n
        self.ps = [0.0] * n
        self._decompose()

    def _decompose(self):
        vals, self.B = eigh(self.C)
        self.D = [math.sqrt(max(v, 1e-20)) for v in vals]

    def ask(self):
        pop = []
        for _ in range(self.lam):
            z = [self.rng.gauss(0, 1) for _ in range(self.n)]
            y = [sum(self.B[i][k] * self.D[k] * z[k] for k in range(self.n)) for i in range(self.n)]
            x = [min(1.0, max(0.0, self.mean[i] + self.sigma * y[i])) for i in range(self.n)]
            pop.append(x)
        return pop

    def tell(self, pop, scores):
        n = self.n
        order = sorted(range(len(pop)), key=lambda i: -scores[i])
        ys = [[(pop[i][j] - self.mean[j]) / self.sigma for j in range(n)] for i in order[: self.mu]]
        yw = [sum(self.w[k] * ys[k][j] for k in range(self.mu)) for j in range(n)]
        self.mean = [self.mean[j] + self.sigma * yw[j] for j in range(n)]
        # C^{-1/2} yw = B D^{-1} B^T yw
        bt = [sum(self.B[i][k] * yw[i] for i in range(n)) / self.D[k] for k in range(n)]
        cinv_yw = [sum(self.B[i][k] * bt[k] for k in range(n)) for i in range(n)]
        f = math.sqrt(self.cs * (2 - self.cs) * self.mueff)
        self.ps = [(1 - self.cs) * self.ps[i] + f * cinv_yw[i] for i in range(n)]
        norm_ps = math.sqrt(sum(x * x for x in self.ps))
        hsig = 1.0 if norm_ps / math.sqrt(1 - (1 - self.cs) ** (2 * (self.gen + 1))) / self.chiN < 1.4 + 2 / (n + 1) else 0.0
        f = math.sqrt(self.cc * (2 - self.cc) * self.mueff)
        self.pc = [(1 - self.cc) * self.pc[i] + hsig * f * yw[i] for i in range(n)]
        for i in range(n):
            for j in range(n):
                rank1 = self.pc[i] * self.pc[j] + (1 - hsig) * self.cc * (2 - self.cc) * self.C[i][j]
                rankmu = sum(self.w[k] * ys[k][i] * ys[k][j] for k in range(self.mu))
                self.C[i][j] = (1 - self.c1 - self.cmu) * self.C[i][j] + self.c1 * rank1 + self.cmu * rankmu
        self.sigma *= math.exp((self.cs / self.damps) * (norm_ps / self.chiN - 1))
        self._decompose()

    gen = 0

    def state(self):
        return {"mean": self.mean, "sigma": self.sigma, "C": self.C, "pc": self.pc, "ps": self.ps, "gen": self.gen}

    def load(self, s):
        self.mean, self.sigma, self.C, self.pc, self.ps, self.gen = s["mean"], s["sigma"], s["C"], s["pc"], s["ps"], s["gen"]
        self._decompose()


# ---------------------------------------------------------------- parameter mapping

def parse_spec(args):
    if args.spec:
        raw = json.load(open(args.spec))
        spec = {}
        for k, v in raw.items():
            if isinstance(v, dict):
                spec[k] = (v["lo"], v["hi"], v.get("init", (v["lo"] + v["hi"]) / 2), bool(v.get("int", False)))
            else:
                is_int = len(v) > 3 and v[3] == "int"
                spec[k] = (v[0], v[1], v[2] if len(v) > 2 and v[2] != "int" else (v[0] + v[1]) / 2, is_int)
    elif args.param:
        spec = {}
        for p in args.param:
            name, _, rest = p.partition("=")
            parts = rest.split(":")
            lo, hi = float(parts[0]), float(parts[1])
            is_int = "int" in parts[2:]
            nums = [x for x in parts[2:] if x != "int"]
            spec[name] = (lo, hi, float(nums[0]) if nums else (lo + hi) / 2, is_int)
    else:
        spec = dict(BUILTIN_SPEC)
    if args.init:
        init = json.load(open(args.init)) if os.path.exists(args.init) else json.loads(args.init)
        for k, v in init.items():
            if k in spec:
                lo, hi, _, is_int = spec[k]
                spec[k] = (lo, hi, v, is_int)
    return spec


def parse_fixed(args, spec):
    """--fixed: the settings every member (and 'mean') plays with, on top of DEFAULT_PLAYBOOK. Checked against
    Params.ts like the spec; a key that is also tuned is an error (which value would win is ambiguous)."""
    if not args.fixed:
        return {}
    fixed = json.load(open(args.fixed)) if os.path.exists(args.fixed) else json.loads(args.fixed)
    if not isinstance(fixed, dict):
        raise SystemExit("--fixed must be a JSON object")
    clash = sorted(set(fixed) & set(spec))
    if clash:
        raise SystemExit(f"--fixed keys also in the spec: {', '.join(clash)} — tune them or fix them, not both")
    defaults = default_playbook()
    for k in fixed:
        if defaults is not None and k not in defaults:
            print(f"warning: --fixed key '{k}' is not in DEFAULT_PLAYBOOK (Params.ts) — the bot ignores it")
    print(f"fixed for every member: {json.dumps(fixed)}")
    return fixed


def to_params(spec, x):
    out = {}
    for (name, (lo, hi, _, is_int)), xi in zip(spec.items(), x):
        v = lo + xi * (hi - lo)
        out[name] = int(round(v)) if is_int else round(v, 4)
    return out


def to_unit(spec):
    return [(init - lo) / (hi - lo) if hi > lo else 0.5 for lo, hi, init, _ in spec.values()]


def default_playbook(path=PARAMS_TS):
    """{name: value} of the DEFAULT_PLAYBOOK literal in Params.ts (numbers and booleans; other values -> None),
    or None when the file cannot be read."""
    try:
        text = open(path).read()
    except OSError:
        return None
    m = re.search(r"export const DEFAULT_PLAYBOOK[^{]*\{(.*?)^\};", text, re.S | re.M)
    if not m:
        return None
    out = {}
    for line in m.group(1).splitlines():
        km = re.match(r"\s*(\w+)\s*:\s*([^,/]*)", line)
        if not km:
            continue
        raw = km.group(2).strip()
        try:
            out[km.group(1)] = float(raw.replace("_", ""))
        except ValueError:
            out[km.group(1)] = {"true": True, "false": False}.get(raw)
    return out


def param_readers(name, bot_dir=os.path.dirname(PARAMS_TS)):
    """Number of mentions of a parameter in the bot's sources outside Params.ts (0 = declared but read nowhere)."""
    n = 0
    pat = re.compile(r"\b" + re.escape(name) + r"\b")
    try:
        for f in os.listdir(bot_dir):
            if f.endswith(".ts") and f != os.path.basename(PARAMS_TS):
                n += len(pat.findall(open(os.path.join(bot_dir, f)).read()))
    except OSError:
        return None
    return n


def check_spec(spec, defaults=None):
    """Warn about spec keys that DEFAULT_PLAYBOOK does not have, keys the bot's sources never read (a noise
    dimension, like retreatBelowRatio was), and inits that differ from the code's default. Returns the warnings."""
    defaults = default_playbook() if defaults is None else defaults
    warnings = []
    if defaults is None:
        warnings.append(f"could not parse DEFAULT_PLAYBOOK from {PARAMS_TS}; spec not checked")
    else:
        for k, (lo, hi, init, is_int) in spec.items():
            if k not in defaults:
                warnings.append(f"spec key '{k}' is not in DEFAULT_PLAYBOOK (Params.ts) — the bot ignores it, drop it from the spec")
                continue
            if param_readers(k) == 0:
                warnings.append(f"spec key '{k}' is declared in Params.ts but read nowhere in the bot — a noise dimension, drop it")
            if isinstance(defaults[k], float) and abs(defaults[k] - init) > 1e-9:
                warnings.append(f"spec init {k}={init:g} differs from DEFAULT_PLAYBOOK {defaults[k]:g}")
    for w in warnings:
        print(f"warning: {w}")
    return warnings


# ---------------------------------------------------------------- sweeps

def results_complete(results_dir, names, batches=BATCHES):
    """True when every config in `names` has a full ab30 file for every batch. `batches` may be a list (same for
    all) or a {name: [batches]} dict (racing: dropped members played fewer)."""
    if not os.path.isdir(results_dir):
        return False
    for n in names:
        for b in (batches[n] if isinstance(batches, dict) else batches):
            f = os.path.join(results_dir, f"ab30_{n}_{b}.txt")
            if not os.path.isfile(f) or sum(1 for l in open(f) if "FINAL" in l) < len(SPAWNS):
                return False
    return True


def run_sweep(args, gen, configs, results_dir, batches):
    os.makedirs(results_dir, exist_ok=True)
    env = dict(os.environ)
    env["CONFIGS"] = json.dumps(configs)
    env["MINUTES"] = str(args.minutes)
    env["BATCHES"] = " ".join(batches)
    if args.runner == "local":
        env["OUT"] = results_dir
        env.setdefault("JOBS", str(args.jobs or os.cpu_count() or 4))
        cmd = [os.path.join(HERE, "sweep.sh")]
    else:
        env["DEST"] = results_dir
        env["KEEP"] = "1"
        # gen 0 creates the box (KEEP=1); later generations reuse it. Resuming gen 0
        # after a failed sweep with the box still up: pass REUSE=1 in the env.
        if gen > 0:
            env["REUSE"] = "1"
        env.setdefault("SERVER_TYPE", "cpx51")
        cmd = [os.path.join(HERE, "remote.sh")]
    log = os.path.join(results_dir, "runner.log")
    print(f"  sweep: {' '.join(cmd)} ({len(configs)} configs, {len(batches) * len(SPAWNS)} games each, {args.minutes} min) -> {results_dir}; log {log}")
    with open(log, "a") as lf:
        rc = subprocess.call(cmd, cwd=ROOT, env=env, stdout=lf, stderr=subprocess.STDOUT)
    if rc != 0:
        sys.exit(f"sweep failed (exit {rc}); see {log}. Re-run the same command to resume.")


def fake_sweep(args, spec, configs, results_dir, target, rng, batches):
    """--dry-run: write ab30 files whose FINAL lines encode a synthetic per-game score.

    Each (batch, region) scenario has its own fixed offset shared by every config
    (common random numbers — what the paired objective cancels), plus a small
    per-config noise. The FINAL lines carry players= and fired= like the real bot."""
    os.makedirs(results_dir, exist_ok=True)
    keys = list(spec.keys())
    for name, params in configs.items():
        # a config without a key (the {} base) sits at the spec's init value
        x = [(params.get(k, spec[k][2]) - spec[k][0]) / (spec[k][1] - spec[k][0]) if spec[k][1] > spec[k][0] else 0.5 for k in keys]
        d2 = sum((xi - ti) ** 2 for xi, ti in zip(x, target))
        q = math.exp(-4.0 * d2 / len(keys))  # 1 at the target, ~0.5 at a typical random point
        for b in batches:
            with open(os.path.join(results_dir, f"ab30_{name}_{b}.txt"), "w") as fh:
                for sp in SPAWNS:
                    scen = random.Random(f"{b}/{sp}").gauss(0, 0.15)  # per-scenario, same for every config
                    qq = min(1.0, max(0.0, q + scen + rng.gauss(0, 0.05)))
                    alive = qq > 0.05
                    tiles = int(10 ** (2 + 3 * qq)) if alive else 0  # 100 .. 100k
                    rank = 1 + int(round((1 - qq) * 39))
                    share = min(1.0, max(0.0, qq))
                    fired = "sim:3,trust:1" if qq > 0.5 else "-"
                    if alive:
                        fh.write(f"== {sp} | spawn 0,0 (dry run) | Medium == FINAL rank={rank} share={share:.2f} alive=true tiles={tiles} troops=0k players=40 fired={fired}\n")
                    else:
                        fh.write(f"== {sp} | spawn 0,0 (dry run) | Medium == DEAD at 100s FINAL alive=false tiles=0 troops=0k players=40 fired={fired}\n")


def score(results_dir, names, old=False, expect=30):
    """summarize.py --fitness as a dict. `expect` = games per config (int, or {name: int})."""
    cmd = [sys.executable, SUMMARIZE] + (["--old-fitness"] if old else []) + ["--fitness", results_dir] + names
    out = subprocess.check_output(cmd, text=True)
    fit = json.loads(out)
    for n in names:
        e = expect[n] if isinstance(expect, dict) else expect
        if fit[n]["games"] < e:
            print(f"  warning: {n} has only {fit[n]['games']} games (expected {e})")
    return fit


def objective(fit, names, ref, raw):
    """Value handed to CMA-ES per member: the mean over shared games of (member - ref) with common random
    numbers, or the plain mean score when raw (or when ref has no results)."""
    if raw or ref not in fit or not fit[ref]["per_game"]:
        return [fit[n]["fitness"] for n in names], "raw"
    ref_pg = fit[ref]["per_game"]
    vals = []
    for n in names:
        pg = fit[n]["per_game"]
        shared = [k for k in pg if k in ref_pg]
        vals.append(sum(pg[k] - ref_pg[k] for k in shared) / len(shared) if shared else 0.0)
    return vals, f"paired-vs-{ref}"


def race_verdicts(fit, pop_names, ref, delta):
    """Sequential test per member on its paired differences vs `ref` (games in batch order): {name: sprt result}.
    d0 = -delta, d1 = 0 — REJECT = the member is worse than the parent by delta; ACCEPT = it is not."""
    ref_pg = fit[ref]["per_game"]
    out = {}
    for n in pop_names:
        pg = fit[n]["per_game"]
        diffs = [pg[k] - ref_pg[k] for k in sorted(pg) if k in ref_pg]
        out[n] = sprt(diffs, d0=-delta, d1=0.0)
    return out


def batches_by_config(record, names):
    """{name: [batches]} for a gen record: the race's per-config lists when present, else the common list."""
    common = record.get("batches", BATCHES)
    by = record.get("race", {}).get("batches_by_config", {})
    return {n: by.get(n, common) for n in names}


def score_record(record, results_dir, names, pop_names, configs, args):
    """Fill the score fields of a gen record from results_dir; returns the CMA objective per member."""
    by = batches_by_config(record, names)
    fit = score(results_dir, names, old=args.old_fitness, expect={n: len(by[n]) * len(SPAWNS) for n in names})
    ref = "mean" if args.reeval_mean else "base"
    obj, kind = objective(fit, pop_names, ref, args.raw_fitness)
    best = max(range(len(pop_names)), key=lambda i: obj[i])
    record.update({
        "scoring": "fit_old" if args.old_fitness else "score",
        "objective_kind": kind,
        "objective": dict(zip(pop_names, obj)),
        "scores": {nm: {k: v for k, v in fit[nm].items() if not k.startswith("per_game")} for nm in names},
        "per_game": {nm: fit[nm]["per_game"] for nm in names},
        "per_game_old": {nm: fit[nm]["per_game_old"] for nm in names},
        "best": {"name": pop_names[best], "objective": obj[best], "fitness": fit[pop_names[best]]["fitness"], "params": configs[pop_names[best]]},
        "mean_fitness": sum(fit[nm]["fitness"] for nm in pop_names) / len(pop_names),
        "mean_objective": sum(obj) / len(obj),
    })
    return obj, fit


def rescore(args):
    """--rescore OUT: recompute the score fields of every gen_N.json from OUT/gen_N/ with the current summarize.py."""
    files = sorted(glob.glob(gen_file(args.rescore, "*")), key=lambda f: int(os.path.basename(f)[4:-5]))
    if not files:
        sys.exit(f"no gen_N.json in {args.rescore}")
    for f in files:
        record = json.load(open(f))
        g = record["gen"]
        results_dir = os.path.join(args.rescore, f"gen_{g}")
        pop_names = [m["name"] for m in record["population"]]
        configs = {m["name"]: m["params"] for m in record["population"]}
        names = list(pop_names)
        for extra in ("mean", "base"):
            if glob.glob(os.path.join(results_dir, f"ab30_{extra}_*.txt")):
                names.append(extra)
        batches = record.get("batches", BATCHES)
        if not results_complete(results_dir, names, batches_by_config(record, names)):
            print(f"gen {g}: results incomplete in {results_dir}, skipped")
            continue
        args.reeval_mean = "mean" in names
        obj, fit = score_record(record, results_dir, names, pop_names, configs, args)
        json.dump(record, open(f, "w"), indent=1)
        extras = "".join(f", {x} {fit[x]['fitness']:.3f}" for x in ("mean", "base") if x in fit)
        race = record.get("race")
        raced = f", raced: {len(race['dropped'])} dropped, +{len(race['extra'])} extra batches" if race else ""
        print(f"gen {g}: rescored ({record['scoring']}, {record['objective_kind']}, {len(batches) * len(SPAWNS)} games{raced}) "
              f"mean fitness {record['mean_fitness']:.3f}, best {record['best']['name']} obj {record['best']['objective']:+.3f}{extras}")


# ---------------------------------------------------------------- driver

def gen_file(out, g):
    return os.path.join(out, f"gen_{g}.json")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", help="campaign directory (gen_N.json + gen_N/ results); required unless --rescore")
    ap.add_argument("--pop", type=int, default=10, help="population per generation (configs per sweep)")
    ap.add_argument("--gens", type=int, default=12, help="total generations to reach (counting finished ones)")
    ap.add_argument("--sigma", type=float, default=0.25, help="initial step size in the unit cube")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--spec", help="JSON {name: [lo, hi, init, 'int'?]} or {name: {lo, hi, init, int}}")
    ap.add_argument("--param", action="append", help="name=lo:hi[:init][:int] (repeatable; replaces the built-in spec)")
    ap.add_argument("--init", help="JSON (file or string) of starting values, e.g. the current DEFAULT_PLAYBOOK subset")
    ap.add_argument("--fixed", help="JSON (file or string) merged under every member's config and the 'mean' reference "
                    "(flags on, calibrated scales, ...) so the tuned params are judged with those settings live; "
                    "'base' (--with-base) stays {} as the drift reference. Keys may not overlap the spec")
    ap.add_argument("--runner", choices=["remote", "local"], default="remote")
    ap.add_argument("--minutes", type=lambda s: s if s == "full" else int(s), default=20, help="game length in minutes, or full (play until a winner; summarize.py then scores wscore)")
    ap.add_argument("--batches", help="override the grid batches (default med0..med4); must match every generation")
    ap.add_argument("--jobs", type=int, help="local runner: parallel games")
    ap.add_argument("--with-base", action="store_true", help="add 'base': {} to every sweep as a drift reference (30 more games)")
    ap.add_argument("--dry-run", action="store_true", help="no sweep: synthetic fitness, writes fake ab30 files")
    ap.add_argument("--reeval-mean", action=argparse.BooleanOptionalAction, default=True,
                    help="also run the distribution mean as config 'mean' every generation and rank members against it (default on)")
    ap.add_argument("--raw-fitness", action="store_true", help="rank members by plain mean score instead of the paired difference vs 'mean'")
    ap.add_argument("--old-fitness", action="store_true", help="score games with the old alive+share+top3 fitness")
    ap.add_argument("--games-growth", action="store_true", help="add --extra-batches once sigma < --grow-below (60 games per config)")
    ap.add_argument("--grow-below", type=float, default=0.12, help="sigma threshold for --games-growth")
    ap.add_argument("--extra-batches", default=EXTRA_BATCHES, help=f"batches added by --games-growth (default '{EXTRA_BATCHES}')")
    ap.add_argument("--rescore", metavar="OUT", help="recompute the scores of every gen_N.json in OUT from its stored results; runs nothing")
    ap.add_argument("--race", action="store_true", help="racing: after --race-stage batches drop members the sequential test puts below 'mean' by --race-delta, spend the saved games on the survivors")
    ap.add_argument("--race-stage", type=int, default=3, help="batches every member plays before the race cut (default 3)")
    ap.add_argument("--race-delta", type=float, default=0.10, help="score-unit margin of the race test (default 0.10)")
    args = ap.parse_args()
    if args.rescore:
        return rescore(args)
    if not args.out:
        ap.error("--out is required")

    spec = parse_spec(args)
    check_spec(spec)
    fixed = parse_fixed(args, spec)
    names_spec = list(spec.keys())
    n = len(names_spec)
    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    target = [rng.random() for _ in range(n)]  # dry-run optimum
    cma = CMA(n, args.pop, args.sigma, mean=to_unit(spec), rng=random.Random(args.seed))

    # resume
    done = sorted(int(os.path.basename(f)[4:-5]) for f in glob.glob(gen_file(args.out, "*")))
    start, pending = 0, None
    if done:
        last = json.load(open(gen_file(args.out, done[-1])))
        if "state_after" in last:
            cma.load(last["state_after"])
            start = done[-1] + 1
            print(f"resuming after generation {done[-1]} (sigma={cma.sigma:.4f})")
        else:
            cma.load(last["state_before"])
            start, pending = done[-1], last
            print(f"resuming generation {done[-1]} (population already sampled)")
        rng = random.Random(args.seed + start)
    base_batches = args.batches.split() if args.batches else list(BATCHES)
    for g in range(start, args.gens):
        cma.gen = g
        if pending:
            pop = [m["x"] for m in pending["population"]]
            batches = pending.get("batches", base_batches)
            pending = None
        else:
            cma.rng = random.Random(args.seed * 1000 + g)
            pop = cma.ask()
            batches = list(base_batches)
            if args.games_growth and cma.sigma < args.grow_below:
                batches += [b for b in args.extra_batches.split() if b not in batches]
        names = [f"g{g}p{i}" for i in range(len(pop))]
        configs = {nm: {**fixed, **to_params(spec, x)} for nm, x in zip(names, pop)}
        record = {
            "gen": g,
            "spec": {k: {"lo": v[0], "hi": v[1], "init": v[2], "int": v[3]} for k, v in spec.items()},
            "state_before": cma.state(),
            "population": [{"name": nm, "x": x, "params": configs[nm]} for nm, x in zip(names, pop)],
            "minutes": args.minutes,
            "batches": batches,
            "runner": "dry-run" if args.dry_run else args.runner,
            "fixed": fixed,
        }
        json.dump(record, open(gen_file(args.out, g), "w"), indent=1)
        results_dir = os.path.join(args.out, f"gen_{g}")
        sweep_configs = dict(configs)
        if args.reeval_mean:
            sweep_configs["mean"] = {**fixed, **to_params(spec, cma.mean)}
        if args.with_base:
            sweep_configs["base"] = {}
        grown = " (grown grid)" if len(batches) > len(base_batches) else ""
        print(f"generation {g}: {len(sweep_configs)} configs x {len(batches) * len(SPAWNS)} games{grown}, sigma={cma.sigma:.4f}")

        def ensure(subset, bats):
            """Run (or skip, when already on disk) the games of `subset` over batches `bats` into results_dir."""
            if not bats or results_complete(results_dir, list(subset), bats):
                return
            if args.dry_run:
                fake_sweep(args, spec, subset, results_dir, target, random.Random(args.seed * 7 + g), bats)
            else:
                run_sweep(args, g, subset, results_dir, bats)

        ref = "mean" if args.reeval_mean else ("base" if args.with_base else None)
        if args.race and ref and len(batches) > args.race_stage:
            stage, rest = batches[: args.race_stage], batches[args.race_stage:]
            ensure(sweep_configs, stage)
            by_stage = {n: len(stage) * len(SPAWNS) for n in sweep_configs}
            fit_stage = score(results_dir, list(sweep_configs), old=args.old_fitness, expect=by_stage)
            verdicts = race_verdicts(fit_stage, names, ref, args.race_delta)
            dropped = [n for n in names if verdicts[n]["decision"] == "REJECT"]
            survivors = [n for n in names if n not in dropped]
            refs = [n for n in sweep_configs if n not in names]
            avail = [b for b in args.extra_batches.split() if b not in batches]
            saved = len(dropped) * len(rest)
            extra = avail[: saved // max(1, len(survivors) + len(refs))] if survivors else []
            if survivors:  # nobody survived: the references stop too (their extra games would pair with nothing)
                ensure({n: sweep_configs[n] for n in survivors + refs}, rest + extra)
            record["race"] = {
                "stage": stage, "dropped": dropped, "extra": extra, "ref": ref, "delta": args.race_delta,
                "verdicts": {n: {k: verdicts[n][k] for k in ("decision", "n", "mean", "llr", "n_at")} for n in names},
                "batches_by_config": {**{n: stage for n in dropped}, **{n: (batches + extra if survivors else stage) for n in survivors + refs}},
            }
            print(f"  race: after {len(stage)} batches dropped {len(dropped)}/{len(names)} ({', '.join(dropped) or '-'}); "
                  f"survivors play {len(rest)} more + {len(extra)} extra batches ({' '.join(extra) or '-'}), "
                  f"{saved - len(extra) * (len(survivors) + len(refs))} of {saved} saved games banked")
        else:
            if args.race and not ref:
                print("  race: no reference config (--no-reeval-mean without --with-base); racing skipped")
            ensure(sweep_configs, batches)
        obj, fit = score_record(record, results_dir, list(sweep_configs), names, configs, args)
        cma.tell(pop, obj)
        record.update({"mean_params": {**fixed, **to_params(spec, cma.mean)}, "state_after": cma.state()})
        json.dump(record, open(gen_file(args.out, g), "w"), indent=1)
        best = record["best"]
        extras = "".join(f", {x} {fit[x]['fitness']:.3f}" for x in ("mean", "base") if x in fit)
        print(f"  mean fitness {record['mean_fitness']:.3f}{extras}; objective ({record['objective_kind']}) mean {record['mean_objective']:+.3f}, best {best['name']} {best['objective']:+.3f}")
        print(f"  best params: {json.dumps(best['params'])}")
        print(f"  new mean:    {json.dumps(record['mean_params'])}  sigma -> {cma.sigma:.4f}")
    if args.runner == "remote" and not args.dry_run:
        print("campaign done; the Hetzner server(s) are still running (KEEP=1) — delete them with: hcloud server delete $(hcloud server list -l lab=1 -o noheader -o columns=name)")


if __name__ == "__main__":
    main()
