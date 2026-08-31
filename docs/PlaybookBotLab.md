# PlaybookBot lab: running bot A/B sweeps on Hetzner (or locally)

Handoff notes for an agent who needs to measure a bot change. Companion to
`docs/PlaybookBotGUI.md` (watching the bot play). Everything here is offline
simulation; never point the bot at openfront.io.

Verified end-to-end 2026-08-29: a 4-config, 120-game, 20-minute sweep on one
`cpx51` finished in ~25 minutes for about €0.04. Since the 2026-08-30 rework
(bare-node runner, `nearby()` memo, headless config) a game costs ~28 % less
CPU, and `WORKERS=N` spreads one sweep over N boxes.

## TL;DR

```bash
cd ~/Code/openfront                                     # branch playbook-bot
OUT=/some/dir; mkdir -p $OUT
CONFIGS='{"base":{},"early":{"botsAfterWild":false},"es25":{"botEarlyShare":0.25}}'
nohup env CONFIGS="$CONFIGS" MINUTES=20 WORKERS=2 DEST=$OUT \
  scripts/lab/remote.sh > $OUT/remote.log 2>&1 &
# ... ~10 min for 120 games on two cpx51; "results in ..." in remote.log marks success
python3 scripts/lab/summarize.py $OUT base early es25    # see "Tuning tools"
hcloud server list -l lab=1                              # must be empty afterwards (KEEP=1 keeps boxes)
```

## What a sweep is

- One **game** = `tests/lab/playbook.lab.ts` run once (bare node via
  `node --import tsx`, or through the vitest entry
  `tests/lab/playbook.lab.test.ts` — same code, same result). The bot plays a
  single-player World map against real nations and 400 tribes for `MIN`
  minutes of game time, headless, and writes a transcript ending in

  ```
  == africa | spawn 1215,420 (bot picker rank 0) | Hard == FINAL rank=4 share=0.89 alive=true tiles=6992 troops=193k cities=1 ports=0 ...
  ```

- One **config** = a JSON object of `PlaybookParams` overrides, run over the
  standard **30-game grid**: 6 spawn regions × 5 batches. **Since 2026-08-29
  the default grid is Medium-only** (`med0`–`med4` = Medium, spawn rank 0–4):
  Josh's rule is to develop on Medium until the bot is strong, then move to
  Hard. `hard0`–`hard9` still work via `BATCHES="hard0 hard1 ..."`. Same grid
  for every config, so games pair up one-to-one.
- A **sweep** = several configs on that grid. Always include the current
  default (`{}`) as the baseline in the same sweep — don't compare against an
  older run.

The sim is deterministic and single-threaded: throughput scales linearly with
cores. A 20-minute game takes ~34 s on a Mac core and roughly twice that on a
shared Hetzner vCPU (a hyperthread); games where the bot dies finish sooner.

## Lab test env vars

| Var | Meaning |
| --- | --- |
| `PARAMS` | JSON merged over `DEFAULT_PLAYBOOK`, e.g. `{"botsAfterWild":false}` |
| `MIN` | game length in minutes (default 20) |
| `STALL` | minutes without a territory change (any non-bot player's tiles ±1 %, same players alive) after which a game from 30:00 is stopped as `STALLED at …` — FINAL is taken there, `winner=none` as it would be at 170:00 (default 20; 0 = off). Without overtime (the solo/private default) 5 % of full-length games are a frozen 2-player alliance or stand-off that would otherwise run to the 170-minute cap: 10 % of the CPU and every sweep's tail. |
| `DIFF` | `medium`; anything else is Hard |
| `SPAWN` | `north-russia north-america east-asia africa south-america australia` |
| `SPAWNRANK` | k-th best spawn in the region; each pick excludes a 120-tile circle around earlier ones |
| `TRIBES` | tribe count (default 400 = public default) |
| `LAB_OUT` | output directory (must exist) |
| `OUTFILE` | file name inside `LAB_OUT` |
| `SHIFT` | offset added to the spawn region's preferred point (ladder.sh: 150; the picker searches 250 tiles around it, so a 150 shift often re-picks the same tile) |
| `SEED` | suffix of the game id `"lab"` — nations, tribes and the bot seed from it, so another SEED is another opponent field on the same map |

Single game by hand (≈2 s at `MIN=1`, ~35 s at `MIN=20`):

```bash
mkdir -p /tmp/lab && PARAMS='{"fightAbove":0.6}' MIN=1 SPAWN=africa LAB_OUT=/tmp/lab OUTFILE=x.txt \
  node --import tsx tests/lab/playbook.lab.ts
```

The vitest entry still works, but **always scope it**:
`npx vitest --dir tests tests/lab/playbook.lab.test.ts --run`. A bare path is a
substring filter and also matches the copies of the test inside other agents'
worktrees under `.claude/worktrees/` — on 2026-08-29 one "game" silently ran
four times (`Test Files 4 passed`), 4× the CPU.

## Hetzner setup (exists; do not redo)

- `hcloud` CLI (`brew install hcloud`) with context `openfront` holding the API
  token. `hcloud context active` must print `openfront`. The human creates the
  context and pastes the token; agents never handle it.
- SSH key `josh-lab` in the project = `~/.ssh/id_ed25519.pub` (`remote.sh`
  uploads it if missing).
- **Account limit:** dedicated-vCPU (CCX) servers are refused —
  `dedicated core limit exceeded`. **`cpx51`** (16 shared vCPU, 32 GB) is
  the default. **Prices (gross, `hcloud server-type describe`):** cpx51 in
  ash **€0.45/h** (not the €0.09 an earlier note claimed); cpx62 (same 16
  vCPU) in fsn1 €0.25/h; cx53 (16 vCPU) in fsn1 €0.056/h but often
  `resource_unavailable`; ccx43 (16 dedicated) €0.52/h. cpx51 exists only in
  ash/hil — for the EU pass `SERVER_TYPE=cpx62 LOCATION=fsn1` (verified
  2026-08-30, the ash snapshot works there). For more throughput pass `WORKERS=N` (N boxes,
  one shard each). Worth a support ticket: a raised CCX limit — the sim is
  integer, single-threaded work and a shared vCPU delivers about half a
  dedicated core (measured: ~2× the Mac's per-game time).
- **ARM:** `cax41` (16 Ampere cores, 32 GB, €0.078/h in fsn1/nbg1/hel1 —
  6× cheaper than cpx51@ash, whole cores rather than hyperthreads, outside the
  CCX limit). Needs the arm64 snapshot: `SERVER_TYPE=cax11 LOCATION=nbg1
  scripts/lab/snapshot.sh` once; `remote.sh` picks the snapshot whose
  architecture matches `SERVER_TYPE`. **Blocked on this account
  (2026-08-30):** every `cax*` create in fsn1/nbg1/hel1 is refused with
  `unsupported location for server type` — ARM is not enabled for the
  project; ask for it in the same support ticket as the CCX cores. Not
  benchmarked yet for that reason.
- **Snapshot image:** `scripts/lab/snapshot.sh` bakes Node 24 + `node_modules`
  into a snapshot labelled `lab-image=1` and `arch=x86|arm` (a cpx11 for ~5 min, then
  ~€0.01/GB/month). `remote.sh` uses the newest one automatically
  (`IMAGE=auto`), so a worker is ready in ~1 min instead of ~4; with no
  snapshot it falls back to ubuntu + cloud-init. Re-bake after a
  `package-lock.json` change (not required: `remote.sh` re-installs when the
  lock differs).
- **Labels:** every box `remote.sh` creates carries `lab=1,pool=<NAME>`.
  `hcloud server list -l lab=1` shows what is running.

## `scripts/lab/remote.sh` — what it does

1. Ensures the SSH key exists in Hetzner; picks the newest `lab-image=1`
   snapshot (or `IMAGE=none` → plain ubuntu + cloud-init).
2. Creates `WORKERS` servers in parallel — `NAME` when `WORKERS=1`, else
   `NAME-1 … NAME-N` — and waits for `/root/.lab-ready` on each. With
   `REUSE=1` it uses the running servers with those names instead.
3. `rsync`s **26 MB** to each box in parallel: `src`, `tests`, package files,
   `resources/maps/world/manifest.json`, lang JSON. The `.bin` maps come from
   `tests/testdata`. Do not widen the includes — the full tree is 2.2 GB
   (`resources/maps` alone is 510 MB), and `.claude/` holds other agents'
   worktrees (full copies of the tree).
4. `npm run inst` on a box only when `node_modules` is missing or
   `package-lock.json` changed since the last install there.
5. Clears `/root/lab-out`, builds the job queue locally (longest-expected-first
   via `scripts/lab/durations.py` over `lab-out` history — the long games start
   first so no box idles at the end; `HISTORY=dir` overrides), delivers it to
   box 1 and launches `scripts/lab/sweep.sh QUEUE=…` on
   box *i* with `nohup`, then polls once a minute printing
   `HH:MM N done, M failed` summed over the boxes. A dropped ssh or a killed
   local shell cannot stop a sweep; if the local script dies, rsync
   `/root/lab-out/` from each box yourself and run
   `scripts/lab/aggregate.sh $DEST`.
6. `rsync`s every box's `/root/lab-out/` into `DEST` (the shards' transcripts
   merge; `sweep.log` is the concatenation of `sweep.<i>.log`) and aggregates
   locally.
7. Deletes the servers unless `KEEP=1`.

| Env | Default | Notes |
| --- | --- | --- |
| `CONFIGS` | required | JSON name → params. Use `{}` for the baseline. |
| `MINUTES` | 20 | game length |
| `WORKERS` | 1 | boxes; each runs every N-th game of the same job list |
| `SERVER_TYPE` | cpx62 | dedicated CCX types are refused on this account; cpx51 (ash/hil only) is the old default |
| `IMAGE` | auto | newest `lab-image=1` snapshot; `none` = ubuntu + cloud-init; or an image id |
| `LOCATION` | fsn1 | Falkenstein — cpx62 here is €0.25/h vs cpx51@ash €0.45 and measured ~12 % faster per game (2026-08-30) |
| `NAME` | openfront-lab | server name / prefix; also the `pool` label |
| `DEST` | ./lab-out | local results dir |
| `KEEP` | 0 | 1 = leave the servers running |
| `REUSE` | 0 | 1 = use the existing servers; rsync is incremental, so a rerun after a bot edit starts in seconds |
| `BATCHES`, `SPAWNS`, `JOBS`, `SHIFT` | — | passed through to `sweep.sh` (SHIFT offsets the spawn grid, see ladder.sh) |
| `STAGED` | 0 | 1 = run the first `STAGE1` (3) batches, then the rest only for configs still "unclear" (`summarize.py --verdict VERDICT`, default 3 = \|wins − losses\| < 3 vs the first config). Clear results cost 18 games instead of 30. |
| `SPRT` | 0 | 1 = sequential A/B: chunks of `STAGE1` batches from `BATCHES` then `EXTRA` (`med5 … med9`) until `summarize.py --sprt --verdict` says ACCEPT / REJECT for every config vs the first, or `MAXBATCHES` (10) batches. `DELTA` = the test's δ (0.10). See "Sequential testing". |
| `MIRROR`, `MIRRORSHIFT`, `MIRRORSEED`, `SEED` | — | passed through to `sweep.sh` (mirrored slots / opponent field, see "Sequential testing") |

Run it under `nohup … &` from a tool call — it runs longer than any tool
timeout. Watch `remote.log`; `results in …` means success.

**Timing** (cpx51): after the rework a 30-game shard of 20-min games finished
in ~3 min (2 rounds of 16–24 parallel games, ~90 s each under load).
`WORKERS=N` divides the wall time by ~N. A CMA-ES generation (10 configs ×
30 games) is ~10 min on `WORKERS=3`. **Parallelism bench** (5-min games, 24
games, one cpx51): JOBS=8 → 30 games/min, 16 → 42, 24 → 46; `sweep.sh`
defaults to 1.5 × vCPUs.

**Verify before you trust a sweep:**

```bash
ls $DEST | grep -c '^p_'                 # expect configs × 30
grep -L FINAL $DEST/p_*.txt              # should print nothing
grep -c '^FAILED' $DEST/sweep.log        # should be 0 (each game is retried once before it counts as FAILED)
```

A game that fails twice leaves no `p_*.txt`, prints `FAILED cfg batch spawn`
in `sweep.log`, and keeps its stderr in `$OUT/.err_cfg_batch_spawn` on the box
(rsynced into `DEST`).

## `scripts/lab/sweep.sh` — the box-side runner

Builds a job list (config × batch × spawn) in a fixed order, keeps every N-th
entry, runs JOBS workers that pull games off the queue through
`node --import tsx tests/lab/playbook.lab.ts` (one retry per game — except a
deterministic "no spawn near" crash, which is SKIPPED, and rare since the
lab relaxes the 120-tile spawn-exclusion radius when a region's ranks run
out), then —
unless `AGGREGATE=0` — calls `scripts/lab/aggregate.sh`, which turns the
`p_*.txt` transcripts into `ab30_<config>_<batch>.txt` (one FINAL line per
spawn, the format `summarize.py` reads). `aggregate.sh <dir>` is idempotent;
run it by hand after merging shards.

Env: `CONFIGS`, `MINUTES` (20), `JOBS` (`nproc`; **pass it explicitly on
macOS**), `OUT` (./lab-out), `BATCHES` (default `med0 … med4`; `hardN`/`medN`
for any rank N, `gN`/`ghN` for the global picker ladder), `SPAWNS` (subset),
`SHARD` (`0/1`), `RUNNER` (`node`; `vitest` = the old path, ~2 s slower a
game), `AGGREGATE` (1), `MIRROR` / `MIRRORSHIFT` / `MIRRORSEED` / `SEED` and
`SPRT` / `STAGE1` / `EXTRA` / `MAXBATCHES` / `DELTA` (see "Sequential
testing" — `sweep.sh`'s own SPRT loop re-enters itself once per chunk; `remote.sh SPRT=1` instead keeps one `sweep.sh` per box alive and tops up its queue — see `queue.open` below).

`queue.open`: while this marker exists in `OUT` an empty claim answers `__WAIT__`
and the worker polls again in 5 s instead of exiting. `remote.sh SPRT=1` uses it
to overlap stages: the next chunk's games are appended the moment the current
queue drains (every game claimed, the ramp-down tail still running), the chunk's
verdict is taken when its own games are all in, and a decision kills the sweep
(the next chunk's running games write nothing partial). Before this each stage
drained the pool first, and its wall was its single longest game — 8–12 min vs a
5–6 min ideal at 120 slots, ~40 % tail (boat1/fix1, 2026-08-30).

Gotcha already fixed, worth knowing: plain `xargs` strips double quotes from
its input, which turned `{"botsAfterWild":false}` into `{botsAfterWild:false}`
and made every non-empty config fail to parse while the `{}` baseline ran
fine. The job list is NUL-delimited now. If you ever see one config succeed and
all others `FAILED`, suspect quoting.

Local use (fallback; keep it small, the Mac is also the GUI machine):

```bash
CONFIGS='{"smoke":{}}' MINUTES=1 JOBS=1 BATCHES=hard0 SPAWNS=africa OUT=/tmp/smoke scripts/lab/sweep.sh   # 2-s smoke test
CONFIGS='{"base":{}}' MINUTES=20 JOBS=10 OUT=/tmp/lab scripts/lab/sweep.sh                                # ~4 min
```

## Cheaper answers: time points, staged A/Bs, shorter games

- **Every transcript carries a 10- and 15-minute answer for free.** The
  30-second rows log `tiles`, `rank` and (from 2026-08-30) `share`, so
  `summarize.py --at 600 DIR base cand` scores the same games at 10 minutes
  (and `--at 900` at 15). Use it to see *when* a change helps: `nearbyEvery`
  was a wash at 20 min but **9 W / 21 L at 10 min** — the stale neighbour set
  slows the opening and the bot catches up later.
- **Staged A/B** (`STAGED=1` on `remote.sh`): 18 paired games first; the
  remaining 12 only when the verdict is still inside ±3 wins. Most flags are
  clear either way after 18.
- **Shorter games when the flag can't matter later.** ≥20 min for anything
  touching cities, ports, rail, wars or the endgame (the rule stands); a
  10-min grid (`MINUTES=10`, half the cost) is fine for opening-only knobs
  — spawn picker, `expand*`, `botRatio`/`botClickCap`, `botsAfterWild`
  — and for any flag whose effect
  shows at `--at 600` on an existing 20-min sweep.
- Tried and rejected: `--max-semi-space-size=64` (V8 young-gen size) made no
  difference (29.8 s vs 30.1 s); running six spawns in one warmed process
  would save ~0.3 s a game (1 %) at the cost of parallel slots.

## Where a game's time goes (profiled 2026-08-29, 20-min Medium game)

Before the rework a 20-minute game was 46.7 s on a Mac core: **33 % the bot**
(almost all of it `me.nearby()`, which walks every border tile and was asked
every tick by `readSituation()` plus up to five more times by the rules),
18 % `NationExecution`, 10 % the per-player cluster flood-fill in
`PlayerExecution`, 7 % `AttackExecution`, 5 % render updates + sync hash, 4 %
vitest startup. What changed:

- `SituationQueries` memoises `me.nearby()` per tick (`nearbyEvery`, default
  1; the friend/rival split is still recomputed on every call). Bit-identical
  decisions — the FINAL line and the whole bot log matched the old code.
- `Config.headless()` (true in `LabConfig`) skips `toUpdate()` and `hash()`:
  render outputs, no game state (`tests/HeadlessConfig.test.ts`).
- The sweep runs the harness with bare node instead of vitest.

- `PlayerImpl.nearby()`/`shoreReachableNeighbors()` iterate the border with
  `TileSet.forEach` instead of the `values()` generator (−5 %, exact).

Together: **46.7 s → 32.8 s** (−30 %) for the same game. `nearbyEvery`
(refresh the neighbour set every N ticks) was A/B-ed on 2026-08-30, 90
Medium games: ne5 14 W / 15 L / 1 tie, ne10 14 W / 16 L vs base; fitness
1.874 / 1.864 / 1.846; survival 29 / 29 / 30 — a wash, so the staleness is
harmless. Bot CPU per game: 19.0 s → 7.7 s (ne5) → 5.3 s (ne10); bot share of
the game 16 % → 7 %. Recommended default: `nearbyEvery: 10` (to be flipped
in the C2 flag consolidation; it changes the golden hash). The remaining
engine hot spots (nation AI, cluster flood-fill, pathfinding) are real game
logic shared with production and are left alone.

## Output layout

```
lab-out/
  sweep.log                          done/retry/FAILED per game (all shards; sweep.<i>.log per box)
  p_<config>_<batch>_<spawn>.txt     full transcript of one game (line 2 is its `replay:` env recipe)
  ab30_<config>_<batch>.txt          6 FINAL lines, one per spawn (scripts/lab/aggregate.sh)
  .err_<config>_<batch>_<spawn>      stderr of a game that failed twice
```

### Replays

Games are deterministic, so the second line of every transcript — added
2026-08-30 — is the complete game:

```
  replay: MIN=20 DIFF=medium SPAWNRANK=2 SHIFT=150 SPAWN=africa PARAMS='{...}' node --import tsx tests/lab/playbook.lab.ts
```

Paste it into a shell (add `LAB_OUT`/`OUTFILE` if you want the transcript
kept) and the game replays bit-identically — same engine commit only: any
simulation change invalidates old recipes. To surface the games worth
re-watching:

```
python3 scripts/lab/summarize.py --replays 5 lab-out          # 5 best and 5 worst games with their recipes
```

To WATCH one in the real client (dev server only): paste the recipe into
`localStorage.labReplay` in the browser console, start any solo game, and the
worker rebuilds that exact lab game (`src/core/lab/LabReplay.ts` — the same
bootstrap the headless lab runs) with the normal game UI as a watch-only view:
every click is ignored so the recorded game cannot fork. `?labreplay=<url-encoded
recipe>` works too; `localStorage.removeItem("labReplay")` to go back. Games with
`__bot` / `BOT_DIR` are refused (that bot's code is not in the bundle) — re-run
those headless. Details in docs/PlaybookBotGUI.md.

## Reading results

Minimal loader:

```python
import re, glob
def load(d, cfg):
    g = {}
    for f in glob.glob(f"{d}/ab30_{cfg}_*.txt"):
        batch = f.split("_")[-1][:-4]
        for line in open(f):
            m = re.search(r"== (\S+) .*\| (\w+) ==.*alive=(\w+) tiles=(\d+)", line)
            if m: g[(batch, m.group(1))] = dict(diff=m.group(2), alive=m.group(3) == "true", tiles=int(m.group(4)))
    return g
```

Then, for each config against the baseline:

- **Pair by (batch, region)** — same spawn, same opponents. Count wins,
  losses and **identical** pairs. Identical means the parameter never
  triggered; those games carry no information.
- **Print the biggest swings.** One outlier can make a total look decisive
  (+16 % land once came from a single +81k game; without it, +3 %).
- **Don't mix Hard and Medium in one total.** Medium land totals are dominated
  by a few snowball games swinging ±200k tiles; compare medians and pair
  counts, not sums.
- Ten-minute games only test the opening. Use ≥20 min for anything touching
  cities, ports, rail or wars (`fightNotBeforeTick` = 3000 ticks = 5 min).
- Write the verdict and sample size next to the parameter in
  `DEFAULT_PLAYBOOK`, as the existing comments do, and note which sweep
  (date, box, minutes) produced it.

## Tuning tools: `summarize.py`, `cmaes.py`, `ladder.sh`

Three scripts in `scripts/lab/` turn a results dir into numbers, drive a
CMA-ES campaign, and rank a candidate against stored versions. All python is
stdlib-only (numpy is picked up for the eigensolver if it happens to exist).
The **fitness of one game** everywhere below is

```
alive (0/1) + share (0..1) + (rank <= 3 ? 1 : 0)        # in [0, 3]; a dead game = 0
```

and a config's fitness is its mean over the grid. Games are always **paired
by (batch, region)** — same spawn, same opponents — and a pair is *identical*
when alive and tiles match, i.e. the change never triggered.

### `summarize.py` — read a results dir

```bash
python3 scripts/lab/summarize.py $DEST                    # every config in $DEST; the first found is the baseline
python3 scripts/lab/summarize.py $DEST base early es25    # explicit order; first = baseline
python3 scripts/lab/summarize.py --fitness $DEST base early   # JSON {config: {fitness, games, alive, top3, tiles}}
python3 scripts/lab/summarize.py --ladder $DEST cand v-current v3 v2   # Bradley–Terry table, see ladder.sh
python3 scripts/lab/summarize.py --sprt $DEST base cand                 # + the sequential test (ACCEPT / REJECT / CONTINUE)
python3 scripts/lab/summarize.py --cycles $DEST cand v-current v3 v2   # non-transitive triples among the configs
```

Per config: games, alive, crowns (rank 1), top-3, total tiles, median land,
fitness. Then each config vs the baseline: wins / losses / identical and the
three biggest tile swings, so a single snowball game cannot hide in a total.
It reads `ab30_<config>_<batch>.txt` and falls back to the `p_*.txt`
transcripts if the sweep died before aggregating. A config with fewer than
30 games gets a warning. This replaces the scratchpad `ab30sum.py`.

### `cmaes.py` — CMA-ES over continuous params

One generation = one sweep whose `CONFIGS` is the population (`g<gen>p<i>`),
scored with `summarize.py --fitness`, same 30-game grid every generation.
The search runs in the unit cube and maps each parameter onto `[lo, hi]`
(`int` params are rounded); the built-in spec is the 12-parameter list from
`PlaybookBotPlan.md` C3 with `init` = the current defaults (kept in sync by
hand — check `BUILTIN_SPEC` against `DEFAULT_PLAYBOOK` before a campaign).

```bash
# first real generation on Hetzner: creates cpx51 "openfront-lab", keeps it (KEEP=1)
cd ~/Code/openfront
nohup python3 scripts/lab/cmaes.py --out lab-out/cma --pop 10 --gens 1 --minutes 20 \
  > lab-out/cma.log 2>&1 &
tail -f lab-out/cma.log                       # per-generation: mean/best fitness, best params, new mean, sigma

# continue the campaign (resumes from the last gen_N.json; REUSE=1 is set for gen > 0)
nohup python3 scripts/lab/cmaes.py --out lab-out/cma --pop 10 --gens 12 --minutes 20 \
  > lab-out/cma.log 2>&1 &

# options
#   --with-base          add "base": {} to every sweep (30 more games) to see drift against the default
#   --spec spec.json     {"fightAbove": [0.4, 0.95, 0.7], "railSpacing": [8, 32, 16, "int"]}
#   --param fightAbove=0.4:0.95:0.7 --param railSpacing=8:32:16:int      (replaces the built-in list)
#   --init '{"fightAbove":0.6}'   start the mean somewhere else
#   --sigma 0.25 --seed 1         initial step in the unit cube, PRNG seed
#   --runner local --jobs 8       scripts/lab/sweep.sh on this machine instead of remote.sh
#   --batches "med0 med1"         smaller grid (must stay the same for the whole campaign)
#   --dry-run                     no games: a synthetic bowl-shaped fitness, fake ab30 files; tests the loop
#   --race                        racing: drop members the sequential test puts below "mean" after --race-stage (3)
#                                 batches by --race-delta (0.10); the saved games buy extra batches for the survivors
```

`BUILTIN_SPEC` has **10** parameters since 2026-08-29: `retreatBelowRatio`
was dropped — it is declared in `Params.ts` but read nowhere in the bot, so
it was a pure noise dimension. `cmaes.py` now parses `DEFAULT_PLAYBOOK` from
`Params.ts` at start-up and warns about a spec key that is not a parameter,
one the bot's sources never mention, or an `init` that differs from the
code's default.

Hetzner env (`SERVER_TYPE` defaults to `cpx51` here, `NAME`, `LOCATION`,
`KEEP`, `REUSE`) passes straight through to `remote.sh`. The server is **never
deleted by cmaes.py** — `hcloud server delete openfront-lab` when the campaign
is over (Josh wants to be asked first). If gen 0's sweep dies with the box
already up, resume with `REUSE=1` in the env.

Files in `--out`: `gen_N.json` (spec, population with unit-cube `x` and
`params`, per-config scores, best, `mean_params`, and the full CMA state
before/after) and `gen_N/` (the sweep results, `runner.log`). Resume rules:
a generation with `state_after` is finished and skipped; one without it is
re-scored from `gen_N/` if all 30 games per config are there, otherwise its
already-sampled population is swept again. `mean_params` of the last
generation is the candidate to hand to `ladder.sh`; the per-generation
`best` is one noisy sample and should not be trusted on its own.

Budget: population 10 × 30 games × 12 generations = 3,600 games ≈ 12 sweeps
of ~25 min on one cpx51 ≈ 5 h, ≈ €0.5. Twelve parameters with population 10
is at the low end for CMA-ES; expect a handful of generations before sigma
starts shrinking, and prefer more generations over a bigger population.

Verified 2026-08-29 without Hetzner: `--dry-run --pop 4 --gens 2` completes,
a re-run resumes at gen 2, a gen file stripped of its scores is re-scored
from its results dir, and a 15-generation dry run climbs from 2.06 to 2.99
mean fitness. The first real generation on Hetzner has **not** been run yet.

### `ladder.sh` and `scripts/lab/versions/`

Every graduated default set is stored as `scripts/lab/versions/vN.json`
(`{"note": "...", "params": {...}}`); `v-current.json` holds `{}` — the code's
`DEFAULT_PLAYBOOK` — and is always in the ladder. The ladder runs a candidate
against `v-current` plus the two highest `vN` on the standard grid and prints
`summarize.py` followed by the Bradley–Terry table (ties count half; strength
is the log score, 0 = average; `P(row beats column)` is given for the
candidate against each version).

```bash
scripts/lab/ladder.sh '{"fightAbove":0.6}'                           # JSON string, Hetzner, 20 min
scripts/lab/ladder.sh lab-out/cma/best.json                          # or a file: {...} or {"params": {...}}
RUNNER=local JOBS=4 MINUTES=1 BATCHES=med0 SPAWNS=africa scripts/lab/ladder.sh '{}'   # ~40 s smoke run
DEST=lab-out/ladder-x NAME_CAND=cma12 scripts/lab/ladder.sh cand.json  # results dir + config name
python3 scripts/lab/summarize.py --ladder lab-out/ladder-x cma12 v-current   # re-print the table later
```

When a candidate wins: copy its overrides to `versions/vN.json` (next N, note
= which sweep), fold them into `DEFAULT_PLAYBOOK`, leave `v-current.json`
empty, and update the guide's "Pressure-tested" table.

## Sequential testing (2026-08-29)

Why: three defaults sat at PROVISIONAL because a fixed 30-game grid only
resolves effects of about half a standard deviation. The fix is Stockfish's:
keep playing pairs until a sequential test decides, which stops clear
results early and lets marginal ones run on instead of being declared
undecided.

**The test** (`summarize.py --sprt`, function `sprt()` — also imported by
`cmaes.py`): a generalised SPRT on the mean of the paired score differences
d = score(cand) − score(base), live games only, in batch order.
H0: d ≤ 0 vs H1: d ≥ δ (δ = `--delta`, default **0.10** score units ≈ one
rank step out of ten or 10k → 16k tiles), α = β = 0.05:

```
LLR_n = n · (mean_n − δ/2) · δ / var_n            # running sample variance, floor δ²; no decision before n = 10
ACCEPT  when LLR ≥ ln((1−β)/α) = +2.94             # H1: the candidate is better by ≥ δ
REJECT  when LLR ≤ ln(β/(1−α)) = −2.94             # H0: it is not
CONTINUE otherwise; the report says how many more pairs the current mean/variance would need
```

The decision is the first crossing at n ≥ 10 walking the pairs in order
(later pairs cannot undo it). The minimum n and the sd floor of δ were added
2026-08-30 after `lab-out/final` showed m4 "REJECT at n=2, mean −0.378":
the first two pairs were −0.48 and −0.28, the sample variance of two points
made the LLR −4, and the report printed the mean of that two-pair window
while the 18-pair series averaged +0.20 (the plain paired report of the same
dir said 18W/18L, dScore +0.09). The report now shows the mean / sd over the
whole series, the LLR at the end, and the n and LLR at the crossing. With `--verdict` the exit code is 0 only when every config
has decided, which is what the runners loop on.

**Common random numbers** (already true, now documented): a lab game is
fixed by `(batch, spawn, SHIFT, SEED)` — the game id `"lab"+SEED` seeds the
nations (`simpleHash(id) + simpleHash(gameID)`), the tribes
(`simpleHash(gameID) + 2`) and the bot (`simpleHash("playbook") + 7`), and
the spawn is picked deterministically from the state after three ticks. So
every config of one sweep meets the identical world and the paired
difference cancels the scenario. `SEED=n` changes the opponent field.

**Mirrored slots** (`MIRROR=1`): every `(batch, spawn)` is played twice —
batch `med0` at `SHIFT`/`SEED` as given and batch `med0b` at
`SHIFT=MIRRORSHIFT` (150) with `SEED=${SEED}MIRRORSEED` (`b`). The second
slot is a different opponent field on the same region (a shift alone often
re-picks the same tile, see `SHIFT` above). `summarize.py` averages the two
slots of a scenario into one SPRT observation and prints a pentanomial line
(`LL/LT/TT/WT/WW` = the slot-pair outcomes), the analogue of playing both
colours. Files: `p_<cfg>_med0b_<spawn>.txt`, `ab30_<cfg>_med0b.txt`.

**Commands**

```bash
# sequential A/B on Hetzner: 3 batches (18 games/config), then 3 more, … until the test decides or 10 batches
CONFIGS='{"base":{},"x":{"trustWars":false}}' MINUTES=30 WORKERS=3 SPRT=1 DEST=lab-out/sprt-x scripts/lab/remote.sh
# the same with mirrored slots (36 games per chunk per config) and a different opponent field
CONFIGS='{"base":{},"x":{"trustWars":false}}' MINUTES=30 WORKERS=3 SPRT=1 MIRROR=1 SEED=2 scripts/lab/remote.sh
# knobs: STAGE1=3 (chunk), EXTRA="med5 med6 med7 med8 med9" (pool after BATCHES), MAXBATCHES=10, DELTA=0.10
# locally (small): 1-min games, one spawn, chunks of one batch
CONFIGS='{"base":{},"x":{"fightAbove":0.5}}' MINUTES=1 JOBS=4 SPAWNS=africa MIRROR=1 SPRT=1 STAGE1=1 MAXBATCHES=2 OUT=/tmp/s scripts/lab/sweep.sh
# read it back
python3 scripts/lab/summarize.py --sprt lab-out/sprt-x base x            # table + live stats + SPRT line (+ pentanomial)
python3 scripts/lab/summarize.py --sprt --verdict 0 lab-out/sprt-x base x  # one line per config, exit 0 iff all decided
# racing CMA-ES: members below "mean" after 3 batches stop, survivors get the saved batches
python3 scripts/lab/cmaes.py --out lab-out/cma --pop 10 --gens 12 --race --games-growth
python3 scripts/lab/cmaes.py --rescore lab-out/cma                          # honours the per-member batch lists
# ladder: prints the SPRT of the candidate vs every version and the transitivity check
scripts/lab/ladder.sh cand.json
python3 scripts/lab/summarize.py --cycles lab-out/ladder-x cand v-current v3 v2
```

**Reading the SPRT line**: `SPRT n 24 mean +0.062 sd 0.210 LLR +1.71
[-2.94, +2.94] … CONTINUE (~17 more pairs needed)` — n is the number of live
pairs so far, `more` the extrapolation at the current estimate (∞ when the
mean sits exactly at δ/2). ACCEPT/REJECT say `at n=…`, the pair at which the
bound was crossed. A REJECT means "not better by δ", not "worse" — read the
live-stats line for the sign.

**Racing** (`cmaes.py --race`): the whole generation plays `--race-stage`
(3) batches; each member's paired differences vs `mean` go through
`sprt(d0 = −δ, d1 = 0)`; REJECT = "worse than the parent by δ", and that
member stops (its objective is the paired mean over the games it played).
The saved games are spent as extra batches (`med5 …`) for the survivors —
as many whole batches as `saved / survivors` buys. `gen_N.json` stores
`race.{stage, dropped, extra, verdicts, batches_by_config}`. Verified with
`--dry-run --race --pop 6 --gens 2`: gen 0 dropped 4/6 after 18 games and
gave the survivors +12 games each; resume and `--rescore` honour the
per-member lists. **Not yet run on Hetzner.**

**Transitivity** (`--cycles`, also printed by `--ladder`): lists triples
where x beats y, y beats z and z beats x by paired wins. The Bradley–Terry
strength is one axis; a candidate that beats its parent but loses to the
grandparent is a rock-paper-scissors the ladder cannot show. None found in
the dry-run data; check it on every real ladder.

## Full games and win scoring (2026-08-30)

Josh's objective is winning full games, not the 20-minute land/rank/crown
score. `MINUTES=full` plays until `game.getWinner()` (170-minute ceiling —
WinCheckExecution's limit) and the FINAL line carries `winner=us|other|none`.
`remote.sh` and `sweep.sh` pass `MINUTES` straight through as `MIN=$MINUTES`
(no arithmetic on it), and `tests/lab/playbook.lab.ts` maps `MIN=full` to
170 minutes; `cmaes.py --minutes full` does the same.

Cost: a full game runs up to 170 sim-minutes ≈ 8× a 20-minute game. A
30-pair mirrored A/B of two configs (`MIRROR=1`, 5 batches × 6 regions × 2
slots × 2 configs = 120 games) is about 25 min on 4× cpx62.

```bash
CONFIGS='{"base":{},"x":{"<flag>":true}}' SPRT=1 MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh
python3 scripts/lab/summarize.py --sprt $DEST base x                       # wscore is picked automatically
python3 scripts/lab/summarize.py --objective winrate --sprt $DEST base x   # SPRT on the paired win difference, δ = 0.15
```

`summarize.py` (see its docstring) parses `winner=`, adds `wins` / `winrate`
/ `wscore` columns and scores full-game dirs with

    wscore = score + 1.0 · (winner == us)

A win is worth more than the whole 0.4–2.25 range of the 20-minute score, so
wins dominate whenever they exist and land/rank only orders the non-wins.
The objective is chosen per results dir — `wscore` when any game has
`winner=us|other`, else `score` (20-minute sweeps are unchanged); a dir that
mixes decided games with games lacking the field warns and uses `wscore`;
`--objective score|wscore|winrate` overrides. The live-game pairing,
bootstrap CI, sign test, SPRT, `--verdict` and `--fitness` ("fitness", plus
`wins`, `winrate`, `wscore`, `per_game_wins`, `per_game_wscore` for
`cmaes.py`) all run on the chosen objective, and the paired report adds a
WIN line per config: wins of each, pairs won by A only / B only / both /
neither, and an exact McNemar-style sign test on the discordant pairs.
`remote.sh SPRT=1` calls `summarize.py --sprt --verdict 0` unchanged.

Note that a 20-minute game can also end with `winner=us` (the bot reached the
win threshold early), so a 20-minute dir with a few early wins selects
`wscore` too (`lab-out/final` 6/108, `cma-confirm` 11/272, `ab1` 1/1287);
`--objective score` reproduces the old numbers exactly.

## Bot strength over time: `history.sh` / `history.py`

How strong has the bot been at each milestone, measured with today's harness and
score on one grid? `scripts/lab/versions/HISTORY.md` lists the milestone commits
(tag, hash, what changed). `scripts/lab/history.sh` extracts each one's
`src/core/execution/playbook/` into `.history/<tag>/` (gitignored) with the rest
of the engine symlinked in, and type-checks it against today's engine. A sweep
config `{"__bot":"<tag>"}` then plays that bot (tests/lab/playbook.lab.ts loads
it via `BOT_DIR`), so one CONFIGS sweep puts every version on the same
batches/seeds with `base` = today's bot; remote.sh rsyncs `.history/` to the
boxes. `python3 scripts/lab/history.py <results dir>` prints games / alive /
crowns / median tiles / score with bootstrap CIs and the paired delta vs base,
writes `versions/<tag>.json` and draws `lab-out/history.svg`. The exact Hetzner
command is in HISTORY.md.

## Clean up

```bash
hcloud server list -l lab=1        # must be empty when you are done
hcloud server delete $(hcloud server list -l lab=1 -o noheader -o columns=name)
hcloud image list --type snapshot -l lab-image=1   # snapshots are cheap; delete superseded ones now and then
```

Josh wants to be told before a delete. A forgotten cpx51 costs ~€2/day; a
forgotten pool of four, ~€9/day.

## Spawn picker: what the data says (2026-08-30)

`tests/lab/spawnfeat.lab.test.ts` dumps the picker's features for a list of
coordinates (`SPAWNS="x,y;x,y" LAB_OUT=dir OUTFILE=f.json`); joined with 288
Medium 20-min games over 67 spawns (`lab-out/outcomes.json`):

- No feature correlates linearly with land (all |ρ| ≤ 0.17); the picker's own
  score scored ρ = +0.04. A soft basin slope (`pk1`) changed 3/30 picks and
  nothing else.
- Thresholds do separate: land-connected basin within 120 tiles < 3k → median
  15k tiles vs 64k (vetoed); < 6k → 33k (−6). Nations within 300 ≥ 12 → 33k vs
  59k (−4), ≥ 16 (−8), ≥ 20 → 2k (vetoed). Tribes within 150 ≥ 15 → 71k vs 48k
  (existing +3/tribe term). Sandwich term: no effect.
- Spawn identity explains most variance (between-spawn sd 0.92 of 1.21), but
  through which nations are adjacent and how they behave, not geometry — so
  don't expect a static scorer to rank the top 20 correctly on Medium.
- Use the global ladder (`BATCHES="g0 g1 g2 g3 g4"`) to test a picker change:
  it walks the picker's own ranks 0–29. **Beware confounds**: a ladder run
  after any other bot commit is not comparable to one run before it (pk0 vs
  pk2 was confounded this way).

## History of the tribe-timing question (for context)

`botsAfterWild` = don't eat tribes while wilderness borders you unless the
click is ≤ `botEarlyShare` of spendable troops. A 6-game 10-min test favoured
*off* (117k vs 97k land); a 30-game 10-min A/B favoured *on* (+16 % land but
9 wins / 7 losses / 14 identical, one outlier). The 20-min Hetzner sweep of
2026-08-29 (`jbase`, `jearly`, `jes25`, `jes35`) is the current evidence — its
results and verdict live next to the parameter in `PlaybookBotExecution.ts`.

**Empty mirrored slots (2026-08-29):** with `MIRROR=1`/the EXTRA batches, australia has no spawn from med3 on, africa at med8, and north-russia / south-america / east-asia(b) at med9 (`pickSpawn` throws "no spawn near"). The failures are identical across configs, so the pairing survives; budget ~25 % fewer pairs for batches 6–9, or move the region centres for those shifts.

**Account limits and IPv6-only pools (2026-08-30):** the Hetzner account allows 5 servers, 4 primary IPv4s and 8 dedicated vCPUs (that is why CCX types were refused). `IPV6=1` makes remote.sh create boxes with `--without-ipv4` (not counted against the IPv4 limit) and reach them over IPv6 (this machine needs IPv6; macOS rsync 2.6.9 cannot parse `[addr]`, so the box is addressed as the dummy host `lab6` with `ssh -o HostName=<addr>`). A limit increase (servers 20, primary IPs 20, dedicated vCPUs 96) was requested on 2026-08-30.
