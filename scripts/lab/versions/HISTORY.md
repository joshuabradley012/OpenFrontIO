# PlaybookBot strength history

How strong has the bot been over time? Every milestone below is that commit's `src/core/execution/playbook/`
played by **today's** lab harness (tests/lab/playbook.lab.ts) against **today's** engine on **one** common grid,
scored with today's `summarize.py` score (land + rank + crown). The bots are extracted by `scripts/lab/history.sh`
into `.history/<tag>/` (gitignored, never committed), one sweep runs them all on the same batches/seeds, and
`scripts/lab/history.py` writes `scripts/lab/versions/<tag>.json` plus `lab-out/history.svg`.

The table is the machine-readable manifest: `history.sh` reads the `tag` and `hash` columns (rows are
`| tag | hash | ...`). Tags are config names in a sweep, so keep them `[a-z0-9-]` and not `v<digit>...`
(ladder.sh treats `versions/v<N>.json` as graduated param sets).

| tag | hash | date | what changed |
| --- | --- | --- | --- |
| rules | c1dec6bb9 | 2026-08-29 | first bot with its own spawn picker: situation snapshot, reserve-enforcing send/boat, rule table, alliance-ended events |
| mirv | ac430fcac | 2026-08-29 | "v3": MIRV rule (counter / victory denial / crown push), endgame wars, city-unit cap under the steamroll line, SAM policy, one war at a time |
| boats | 9b45d043a | 2026-08-29 | "v6": sea-expansion rule (free shore, collapsed follow-up, weak players, tribes), open-shore-first early boat; 23/30 alive from 17 |
| sticky | a201a1711 | 2026-08-29 | wars go whole or not at all (4c6bf6aa2) + one sticky war target to the end; leaner structure ratios |
| endgame2 | dc98ec741 | 2026-08-29 | endgame v2: hydrogen bombs instead of hoarding, MIRV fund capped at 40M, weak allies lapse from 15:00, short boat jumps at 2x |
| finish | b7b0ef0c5 | 2026-08-29 | finish rule: hold under the victory-denial line while a MIRV-capable rival exists, remove them, then push |
| preplan | e69862fbe | 2026-08-29 | pre-rebuild baseline: spawn picker v2 (basin / crowding vetoes from the 67-spawn regression), war ratio 2x, split watch, econ wars |
| c3 | bc9108bd1 | 2026-08-29 | after the rebuild plan's C3: module split, estimator, situation model, realRetreats + trustWars + nationAware graduated, nearbyEvery 10 |
| fold | c47fcac82 | 2026-08-29 | dead flags removed (simWars, scoredSpend, bsrReserve, phaseGates), retreats folded (ladder1 1 vs 11 crowns), no feature flags left |
| review | 96393fd0d | 2026-08-29 | the review packages merged: threat map, SPRT lab, estimator restored, nation-exploit flags, build search, fixes/perf, utility + campaigns (all flags default off) |

`base` in a history sweep is today's bot (the normal import, `BOT_DIR` unset) — a0c59bd3e at the time of
writing: simWars and campaigns deleted after their A/Bs, hystRetreats rejected, neutral flags' constants exposed as params.

Not taken: 35ce1d0e9 (the very first bot: no `pickSpawn`, the lab clicked its spawn — it cannot play the
common grid), 47dcd2b57 (remove-dead-flags: one commit before `fold`, differs only by the retreat fold).

## Shims

Every milestone compiles unchanged (`npx tsc --noEmit -p .history/<tag>/tsconfig.check.json`) against the engine at
a0c59bd3e; no source edits were needed. Harness-side accommodations (in tests/lab/playbook.lab.ts, not in the copies):

- `bot.fired` (the per-flag liveness counters) does not exist before 47dcd2b57 — the FINAL line prints `fired=` empty.
- tsx applies the repo's compiler options (`useDefineForClassFields: false`, which `review`'s field initialisers
  depend on) only inside a tsconfig's `include`, and `.history/` is outside the root one: the bare-node entry
  re-execs itself once with `TSX_TSCONFIG_PATH=.history/<tag>/tsconfig.json` (written by history.sh) when
  BOT_DIR / `__bot` is set. `tsconfig.check.json` next to it is the narrower one for the tsc pass.
- `PlaybookBotExecution.pickSpawn(game, prefer, exclude)`: `rules` has no `exclude` parameter (SPAWNRANK arrived at
  1926105b6), so SPAWNRANK>0 would re-pick rank 0. The harness uses **today's** picker for any bot whose
  `pickSpawn` takes fewer than three arguments; `rules` is the only one. Every other milestone spawns with its own picker.

## Running it

Hetzner (from the repo root; `base` first so summarize.py pairs every version against today's bot):

```bash
CONFIGS='{"base":{},"rules":{"__bot":"rules"},"mirv":{"__bot":"mirv"},"boats":{"__bot":"boats"},"sticky":{"__bot":"sticky"},"endgame2":{"__bot":"endgame2"},"finish":{"__bot":"finish"},"preplan":{"__bot":"preplan"},"c3":{"__bot":"c3"},"fold":{"__bot":"fold"},"review":{"__bot":"review"}}' \
MIRROR=1 BATCHES='med0 med1 med2 med3 med4' MINUTES=20 WORKERS=4 SERVER_TYPE=cpx62 LOCATION=fsn1 NAME=openfront-hist DEST=$PWD/lab-out/hist \
scripts/lab/remote.sh
python3 scripts/lab/history.py lab-out/hist
```

`scripts/lab/history.sh` must have been run first (remote.sh rsyncs `.history/` to the boxes). 11 configs x 5
batches x 2 slots x 6 regions = 660 games of 20 min. Local smoke of the pipeline (one 3-minute game per version):

```bash
scripts/lab/history.sh
for t in rules mirv boats sticky endgame2 finish preplan c3 fold review; do
  SPAWN=africa DIFF=medium MIN=3 BOT_DIR=.history/$t/src/core/execution/playbook LAB_OUT=lab-out/hist-smoke/ OUTFILE=p_${t}_med0_africa.txt node --import tsx tests/lab/playbook.lab.ts
done
SPAWN=africa DIFF=medium MIN=3 LAB_OUT=lab-out/hist-smoke/ OUTFILE=p_base_med0_africa.txt node --import tsx tests/lab/playbook.lab.ts
python3 scripts/lab/history.py lab-out/hist-smoke
```

`history.py` prints per-version games / alive / crowns / median tiles / mean score with a bootstrap CI, writes
`versions/<tag>.json` (`{"note", "commit", "params": {"__bot": tag}, "results": {...}}` — usable as a ladder.sh
candidate or opponent since the `__bot` param selects the extracted bot) and draws `lab-out/history.svg`.
