# PlaybookBot Against the Field

_Ported from the artifact on 2026-08-30; this file is now the source of truth._

> **Status (30 Aug 2026).** A snapshot at `6f949877c`; the "Implementation status" and "A/B results" sections below record what happened next. Since then: `campaigns` and `simWars` (calibrated) were deleted after decisive losses; `hystRetreats` was rejected; the neutral flags (`utility`, `threatMap`, `buildSearch`, `retaliateAware`, `relationAware`, `drainedNations`, `markTargets`) remain in `Params.ts`, default off; the CMA-tuned constants that beat base by +0.21 at 20 minutes **lost full games** (9 vs 19 of 36) and were not graduated — see `PlaybookBotPlan.md` "Full-game gate". The bug table's items were fixed (`retreatBelowRatio` and the dead cadence params are gone or wired; the "seven flags default off" handoff line was corrected). The "three PROVISIONAL defaults" (opportunity 1) were resolved on a 45-game shifted-grid ladder: retreats confirmed decisively and folded; `trustWars`/`nationAware` neutral-to-positive and kept on. Line counts: the bot is now ~4,600 lines across 13 modules.

What the playbook-bot branch built, how established game-AI engines make the same decisions, and where the gap is worth closing.

_Branch playbook-bot at 6f949877c · 65 commits · +8,861 lines · 2026-08-29_

## What the branch contains

The PR adds a scripted player, `src/core/execution/playbook/` (~2,550 lines across eight modules), plus the lab that tunes it. The bot runs a fixed-order rule table each tick over a per-tick `Situation` snapshot; troops leave home only through `send()`/`boat()`, which enforce a 30 % reserve. Around it: a rival model (`Rivals.ts`: trust, border-security ratio, a copy of the nation attack rules), an attack estimator that replays the engine's loss formula (`Estimate.ts`), a scored spending model (`Spend.ts`), 40 continuous params and 10 flags (`Params.ts`), 71 unit/golden tests, and a Hetzner lab (`scripts/lab/`: paired 30-game A/Bs, CMA-ES over 11 params, a Bradley-Terry ladder).

| Decision               | How it's made today                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expand into wilderness | One click per 10 ticks of 20 % (contested) or 10 % (free) of troops; engine picks the tiles.                                                                                                                                                                              |
| Tribes                 | Weakest bordering tribe first, 1.67× its troops, first click capped at 30 % of home, follow-ups every 100 ticks.                                                                                                                                                          |
| Wars                   | Gate: affordable (2× a rival's army within 60 % of spendable) or opportunity or ≥ 70 % of cap. Hand-weighted scorer (`Military.ts:327-344`): ratio·2 + buildings + density − posts·3 − size + under-fire/traitor/trust bonuses. One sticky target. Whole wave or nothing. |
| Retreat                | Literal thresholds (0.2·sent left and target > 0.7·start) checked every 10 ticks.                                                                                                                                                                                         |
| Diplomacy              | Accept everyone but prey; request every rival every 300 ticks; renew unless prey; gift troops to a nation that could attack at expiry.                                                                                                                                    |
| Spending               | Ordered if-chain, one purchase per 10 ticks: post → SAM → 3 city levels → ports → rail → silos → cities → warships.                                                                                                                                                       |
| Endgame                | grow/hold/push from map share vs. the nations' victory-denial line; bombs, MIRV rules, city-unit cap under the steamroll rule.                                                                                                                                            |

## Where it stands against established engines

The comparison set: Dave Mark's utility AI (Guild Wars 2), influence maps (Total War, Supreme Commander, Brood War bots), Civ V / Vox Populi and HOI4 diplomacy models, Freeciv/FreeOrion allocators, Lanchester and simulator-based combat prediction (UAlbertaBot, Steamhammer, Stardust), BOSS build-order search, Puppet Search / Portfolio search, Stockfish's fishtest (SPRT, SPSA), and the generals.io / Lux / microRTS competition winners.

| Technique                 | Field                                                                                                              | PlaybookBot                                                                                                                                                                                             |         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Combat outcome prediction | Lanchester fits or a fast simulator feeding engage/retreat, calibrated per opponent from logs                      | `Estimate.ts` is an exact replay of the engine's loss formula — better than most Brood War bots — but uncalibrated, ignores merges/allies/posts-in-progress, and is off by default after losing its A/B | partial |
| Opponent model            | Learned strategy prediction; exploit deterministic scripts when the source is known                                | `NATION_RULES` copied verbatim; used for expiry hold and pile-in veto only. Never reads relation values, never uses `targets()`, never predicts the nation's attack cadence                             | partial |
| Evaluation / tuning       | Paired games with common random numbers, SPRT stopping, SPSA or racing-CMA-ES, TrueSkill ladders                   | Paired 30-game batches with bootstrap CI and sign test, CMA-ES with a paired objective, BT ladder. Fixed batch size is why three flags sit at PROVISIONAL                                               | partial |
| Action selection          | Utility scores on one currency across all options; rank buckets for invariants; commitment bonus                   | Fixed rule order; each rule has its own gates; first rule to run takes the troops                                                                                                                       | gap     |
| Hysteresis                | Smoothed stances (VP: 0.9·prev + 0.1·now), N-consecutive checks before retreat                                     | Sticky war target only; everything else re-decided every 10 ticks                                                                                                                                       | gap     |
| Spatial reasoning         | Influence / tension / vulnerability maps at 0.5–2 s cadence driving defence and target choice                      | One scalar `bsr` per rival; manhattan distance from one shore tile; sampled rings                                                                                                                       | gap     |
| Multi-step plans          | HTN-style campaign objects (prepare → posts → wave → follow-up → consolidate) with abort conditions; timed attacks | Independent cadenced rules; the finish rule is the only plan-shaped thing                                                                                                                               | gap     |
| Economy planning          | BOSS fast-forward search over a horizon; amortised "want" values                                                   | Greedy one-step chain; `Spend.ts` values a purchase now, cannot see that saving for a port beats a city                                                                                                 | partial |
| Test discipline           | —                                                                                                                  | 71 tests, golden hash, flags with liveness counters, every constant annotated with its lab result                                                                                                       | ahead   |

## Opportunities, ranked

Ordered by expected gain per hour of work, with the lab's constraints in mind: a 30-min game costs ~96 CPU-s, so anything online must fit a 100 ms tick and anything offline must not cut the 600 games/hour throughput by more than a few ×.

### 1. Make the accept gate sequential, not a fixed 30 games

_**Effort** ~1 day, Python only · **Where** `scripts/lab/summarize.py`, `cmaes.py`, `remote.sh`_

Three defaults are PROVISIONAL because 30 paired games resolve only effects ≥ ~0.5 σ. Stockfish solved exactly this with SPRT: keep playing pairs until the log-likelihood ratio crosses ±2.94, which stops clear results at 20–40 games and lets marginal ones run to 100+ instead of being declared undecided. Two companions: (a) common random numbers — same seed, spawn set _and_ nation PRNG for both arms, with each seed played in both slots; the `SHIFT` grid is halfway there but the opponent field is still the larger variance source; (b) racing inside CMA-ES — evaluate the generation on one seed list and drop members a sequential test puts below the parent, which typically halves games per generation.

Also: drop `retreatBelowRatio` from the CMA-ES spec. It is read nowhere (`Military.ts:481-482` uses literals), so one of the 11 dimensions is pure noise and inflates every generation's σ.

_Fishtest mathematics: official-stockfish.github.io/docs/fishtest-wiki/Fishtest-Mathematics.html · RACE-CMA: arxiv.org/pdf/2604.05792 · irace: iridia.ulb.ac.be/mbiro/paperi/LopDubPer-etal2016orp.pdf_

### 2. Exploit the nation AI as a perfect-information opponent

_**Effort** 1–2 days, several small flags · **Where** `Rivals.ts`, `Military.fight/counterAttack`, `Diplomacy.ts`_

The opponent pool is a deterministic script whose source is in the repo; the literature's strongest cheap lever is to evaluate that script on the current state instead of modelling it. The architecture report found six unused edges in `AiAttackBehavior.ts` / `NationAllianceBehavior.ts`:

- **Target marking.** `Player.targets()` makes every allied nation attack _and nuke_ the marked player (`AiAttackBehavior.ts:492-511`, `NationNukeBehavior.ts:220-231`). The bot never emits it. Marking the war target before the first wave recruits the whole alliance for free.
- **Wilderness pre-empts everything.** A nation with non-fallout unowned land on its border sends its whole surplus to TerraNullius and returns (`:93-95`). Such a neighbour cannot attack you this tick; `nationCanAttack` should read false for it and the reserve can drop.
- **Medium sends its entire surplus** (`troops − max·reserveRatio`, no `troopSendCap` on Medium). A same-size counter cancels the wave and leaves the nation under its `reserveRatio` for minutes — the moment to hit it, which `fight()` does not know.
- **Retaliation hits only the largest attacker.** A second, smaller attacker on the same target is invisible to `retaliate`. Combined with an ally's marked target, the bot can be the smaller attacker.
- **Relation is never read.** Alliance acceptance is relation-driven (Friendly accept, < Neutral reject, threat → always accept). `requestAlliances` spams every rival every 300 ticks and then docks trust for each refusal (`Rivals.ts:138`), so "trust" mostly counts our own spam. Request when the rules say yes.
- **Ex-allies stay Neutral.** Attacking a natural-lapsed ally lands at +30 relation (no `hated`, no embargo) while a never-allied nation goes Hostile at −70. Prey should be picked from lapsed allies first.

Keep all of this nation-only with the human fallback the code already has — Diplomacy-bot research warns these exploits are brittle against people.

### 3. One currency for troops: utility scoring across expand / tribes / wars / counter

_**Effort** 3–5 days behind a flag · **Where** `PlaybookBotExecution.rules`, `Military.ts`_

The rule table is a Dill-style priority bucket without the weight layer. Every 10 ticks expand → tribes → wars run in that order on one shared `spendable`, so a 10 % expand click can starve a whole-or-nothing war forever (`send()`, `:151`), and no rule can compare a tribe at 1.67× against free land at 16–24 troops/tile against a war the estimator likes. `Spend.ts` already does this for gold (return over horizon / cost). Do the same for troops: score each option as expected tiles (or troop-equivalent) over the phase horizon, multiply curved considerations (troops/cap logistic around `fightAbove`, estimate margin, border threat, trust, expiry time), keep the invariants (counter under attack, hold) as rank buckets, and give the running war a commitment bonus. Side effect: thresholds like `fightAbove`, `botEarlyShare` become curve midpoints — CMA-ES converges far better on smooth landscapes than on the current step functions.

_Mark, Building a Better Centaur (GDC 2015) · Dill, Dual-Utility Reasoning (Game AI Pro 2 ch. 3) · Graham, Utility Theory (Game AI Pro ch. 9)_

### 4. Calibrate the estimator from the games you already play, then retry simWars

_**Effort** 2 days · **Where** `Estimate.ts`, `Military.simPick/manageRetreats`, lab RECORD output_

`simWars` lost decisively (7W-23L) but the estimator is verified within 1 % of a single `AttackExecution` — the loss is in what it doesn't model (merging into a running wave, allies piling in, posts built mid-war, the target's other incoming attacks) and in the 20 % margin / free-land gate that sizes the wave. Stanescu, Barriga & Buro got +9 points in UAlbertaBot by fitting 2–3 correction parameters per opponent class from recorded battles. The lab already writes every wave: log (estimate, actual tiles, actual loss) per ATTACK line, fit a per-defender-class multiplier (nation / human / tribe) and an attrition exponent offline. Then follow Steamhammer's two rules for the retreat side: estimate "continue" vs "retreat now" and require continue to win by a margin scaled by other-border threat, and demand N consecutive losing re-estimates (or an EMA) before retreating. The current 10-tick re-check on literal thresholds is the oscillation bug those bots spent years on.

_Stanescu et al., Lanchester models for RTS: cdn.aaai.org/ojs/12780 · Steamhammer combat sim notes: satirist.org/ai/starcraft/blog/archives/665_

### 5. A border threat map instead of one scalar per rival

_**Effort** 2–3 days · **Where** `Rivals.ts` border pass (every 50 ticks), consumers in `counterAttack`, `fight`, `expand`, `Economy.defensePostTile`_

OpenFront is made of territory, so the influence-map representation is native. Per border segment: their troops × their-border-share facing us, decayed by distance from their core; ours likewise; derive tension (both high) and vulnerability (contested, nobody dominant). Three consumers: `bsrReserve` would hold the _right_ border rather than scaling one reserve by the max bsr (that flag lost, likely for this reason); `fight()` gains the "busy elsewhere" signal Civ IV pays for as dogpile war (high tension on their other borders); defence posts go where the enemy is thick, not at the border midpoint (`Economy.ts:546-580`). The 50-tick pass already walks the border, so cost is a few arrays.

_Mark, Modular Tactical Influence Maps (Game AI Pro 2 ch. 30) · Champandard, Core Mechanics of Influence Mapping_

### 6. A war-plan object with a preparation phase and timing

_**Effort** 2–3 days · **Where** new `Campaign.ts` read by Military/Economy/Diplomacy_

Vox Populi's AI chooses a target, then spends 5–10 turns in a "war face": reserves, builds on that border, and declares only when the projection is favourable and a path exists. PlaybookBot's equivalent steps are spread over four modules that can't see they belong together: `plannedTarget` in Diplomacy, threat posts in Economy, the expiry hold in readSituation, the wave in `fight()`. One small plan (target, prep-until tick, abort conditions, wave schedule) lets you time the first wave to the moment the rules above identify — the ally's expiry tick, the nation's surplus just spent on a counter, the tick its wilderness runs out — instead of "whenever affordable on a 10-tick multiple". Not a general planner; GOAP/HTN machinery is overkill for a 6-action domain.

_VP diplomacy AI: forums.civfanatics.com/threads/645461 · Civ IV war plans: civ4.wikidot.com/xml:civ4leaderheadinfos_

### 7. Fast-forward build search for the economy, and a value function from logs

_**Effort** 3–4 days each · **Where** `Spend.ts`/`Economy.build`; lab RECORD frames_

`scoredSpend` lost (12W-17L, fewer ports) because a one-step value can't express "save 2000 gold for a port". BOSS-style search — fast-forward to the next affordable tick, branch over city/port-level/factory/post/silo/cap with macro actions, maximise land+troops at a 5-minute horizon — is cheap for a 7-item economy and strictly dominates the chain. Offline it can precompute openings per spawn class. Separately, the lab already emits state rows every 30 s: fit a predictor of final score from mid-game features (Texel-style). That gives a low-variance proxy metric (predicted final score at 12 min correlates better than raw rank at 12 min, ρ 0.58) and the evaluation function any shallow lookahead needs.

_Churchill & Buro, BOSS: davechurchill.ca/publications/pdf/aiide11-bo.pdf · Texel tuning: chessprogramming.org/Texel's_Tuning_Method_

### 8. Cheap CPU wins

_**Effort** hours · **Where** listed inline_

- `readSituation` scans all players for MIRV threats, expiring alliances and collapse every tick while every consumer runs on 10-tick multiples (`PlaybookBotExecution.ts:124`).
- `Rivals.troopSendCap` walks the _rival's_ full border via `p.nearby()` every 10 ticks per nation neighbour, uncached (`Rivals.ts:206`) — the same cost `nearbyEvery` just removed for the bot itself. Bites on Hard.
- `watchSplit` BFS follows interior tiles, so it scales with territory rather than border (`Military.ts:171`).
- `neighbours()` is recomputed with the friend/rival split 8–12× per active tick; `interiorTile` does 40 × `closestTile` over the whole border per build pass (`Economy.ts:505-507`).
- `annexCache`, `attackStart`, `waves`, `sentAt`, `bombed`, `boatedAt` are never pruned.

Bot time is ~7 % of tick time at `nearbyEvery` 10, so these matter less for the game than for the lab: every second saved per game is 600 more games per lab-hour.

## Bugs and dead code found on the way

| Finding                                                                                                                                        | Location                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `retreatBelowRatio` and `allianceEvery` declared, never read; `expandEvery` only throttles a log line                                          | `Params.ts:28,32`, `Military.ts:368,375,481`                 |
| `onSmallLandmass` computed and unused; `sendBoat()`, `seaInvasion()` never called from the rule table                                          | `PlaybookBotExecution.ts:206`, `Military.ts:526-616`         |
| `troopsDelta`/`tilesDelta` ring buffers maintained every tick, consumed by nothing                                                             | `Rivals.ts:11-26`                                            |
| `reachable()` blacklists a target for 600 ticks when the wave merged into a running attack or won instantly                                    | `Military.ts:55-65`                                          |
| Natural lapse adds +0.1 trust even when _we_ let it lapse to attack; `trustBonus` then makes planned prey look trustworthy                     | `Rivals.ts:81`                                               |
| `manageExpiries` examines each alliance exactly once (300-tick cadence, 300-tick window); a gift/renewal that fails that tick is never retried | `Diplomacy.ts:65-69`                                         |
| MIRV threat needs gold ≥ 20M; the nation rule needs gold ≥ live MIRV price (starts 25M, escalates) — should read the price                     | `PlaybookBotExecution.ts:124` vs `NationMIRVBehavior.ts:127` |
| `cityUnitCap` uses 1.15× the runner-up; the steamroll rule is 1.5× Medium / 1.25× Hard, so the cap is often stuck at 9                         | `Economy.ts:161`                                             |
| `maybeMIRV` targets the territory centre with no SAM check; `maybeBomb` refuses any SAM-covered tile                                           | `Military.ts:148`                                            |
| `sit.hold` only considers nation allies and freezes tribe follow-ups for up to 450 ticks per alliance                                          | `PlaybookBotExecution.ts:131`                                |
| Counters are excluded from the war count, so counter + war + opportunity war can run together despite the one-war invariant                    | `Military.ts:294`                                            |
| Plan handoff says all seven flags default off; three are on and `nearbyEvery` is 10                                                            | `docs/PlaybookBotPlan.md:29-32`                              |

## Implementation status

All eight opportunities and the bug table were implemented on 2026-08-29 in seven packages, each on its own branch and merged into `playbook-bot` (23 commits, 44 files, +5,439 / −324, head `96393fd0d`). Every behaviour change sits behind a default-off flag; the golden test is unchanged with the flags off (except for the estimator's calibration log lines, regenerated with decisions verified identical). Full suite 4,096/4,096; tsc, oxlint, eslint clean. Nothing has been A/B'd on Hetzner yet — that is the next step.

| #   | Branch                 | Flags (all default off)                                                                                         | Also                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `bot/lab-sprt`         | — (lab only)                                                                                                    | `summarize.py --sprt` (GSPRT, δ 0.10, α=β 0.05), `SPRT=1`/`MIRROR=1`/`SEED` in sweep.sh/remote.sh, `cmaes.py --race`, `retreatBelowRatio` dropped from the spec + a Params.ts spec check, `--cycles`. Finding: seeds were already identical across configs; SHIFT=150 re-picks the same africa tile — use MIRROR or SHIFT=300. |
| 2   | `bot/nation-exploit`   | `markTargets`, `wildernessAware`, `drainedNations`, `retaliateAware` (includes secondAttacker), `relationAware` | NATION_RULES extended with alliance-decision constants; 12-min smoke with retaliateAware alone took the crown (one game).                                                                                                                                                                                                      |
| 3   | `bot/utility-campaign` | `utility`                                                                                                       | Utility.ts (curves, Mark compensation, Dill ranks); one `troops` rule replaces counter/expand/tribes/wars. Finding: on this engine a 1.67× tribe click costs ~21 troops/tile and a 2× war ~40 vs free land 20, so the flag mostly changes opportunity and at-cap wars.                                                         |
| 4   | `bot/estimator`        | `simWars`, `hystRetreats`; params `estLossScale{Nation,Human,Bot}`, `estSpeedScale`                             | Estimate.ts restored; always-on EST/ACT calibration log; `scripts/lab/calibrate.py` fits the scales from a sweep. One smoke suggests the replay runs ~1.9× too slow against nations — calibrate before re-testing simWars.                                                                                                     |
| 5   | `bot/threat-map`       | `threatMap` (+ `threatReserveGain`)                                                                             | ThreatMap.ts; reserve from undefended pressure (never below the flat share — the halved reserve shipped the army off in boats), busy-elsewhere/thin-border scorer terms, posts on the hottest segment, pre-positioned posts.                                                                                                   |
| 6   | `bot/utility-campaign` | `campaigns`                                                                                                     | Campaign.ts prepare → wave → followup → consolidate with escrow, post, alliance gating, aborts, 600-tick cooldown.                                                                                                                                                                                                             |
| 7   | `bot/build-search`     | `buildSearch`                                                                                                   | BuildSearch.ts (2,000-node fast-forward search, ~0.7 ms); `scripts/lab/valuefit.py` — on 395 games the fitted predictor beats rank-at-t at 5/8/10/15 min (ρ 0.56–0.68 vs 0.51–0.65).                                                                                                                                           |
| 8   | `bot/fixes-perf`       | `steamrollCap`, `holdHumans`, `strictOneWar`                                                                    | botMs 394 → 306 decision-identical; bug fixes B1–B4, B6, B9, B10 from the table above (reachable() misread, trust on a chosen lapse, expiry retries, live MIRV price, MIRV SAM check, docs, dead cadence params wired).                                                                                                        |

### Smokes on the merged head (africa, Medium, 6 min, one game each — not evidence)

| Config       | Rank | Tiles  | botMs |
| ------------ | ---- | ------ | ----- |
| base         | 3    | 39,884 | 366   |
| utility      | 2    | 42,133 | 429   |
| campaigns    | 2    | 38,854 | 362   |
| all 14 flags | 15   | 22,231 | 1,375 |

The all-flags row is expected: `simWars` runs uncalibrated and `buildSearch` hoards for port levels; they are there to prove the packages coexist, not to be shipped together.

### A/B results (Hetzner, 2026-08-29 late — 99 mirrored 20-min Medium pairs per flag, 1,287 games)

| Flag                           | W/L/T         | dScore [95 % CI]             | Read                                                       |
| ------------------------------ | ------------- | ---------------------------- | ---------------------------------------------------------- |
| campaigns                      | 38/60/1       | −0.19 [−0.30, −0.08], p=0.03 | decisive loss — to be deleted                              |
| hystRetreats                   | 46/49/3       | −0.10 [−0.23, +0.01]         | leaning harmful                                            |
| markTargets                    | 41/58/0       | −0.08 [−0.18, +0.02]         | leaning harmful (4 deaths vs 0)                            |
| threatMap · drainedNations     | 46/51/2       | −0.07                        | noise                                                      |
| relationAware · retaliateAware | 42/46 · 42/36 | −0.04 · −0.03                | noise                                                      |
| utility · buildSearch          | 53/44 · 49/50 | −0.01 · 0.00                 | noise; utility never decided (SPRT CONTINUE at 10 batches) |
| strictOneWar                   | 19/13/66      | +0.02 [−0.03, +0.07]         | only positive, rarely fires                                |
| wildernessAware · steamrollCap | —             | 0.00                         | never change a decision in the nations-only lab            |

Reading: at hand-picked constants none of the mechanisms beats a base that CMA-ES has already tuned for the old rules; the evaluation loop itself worked as intended (12 flags decided in 32 minutes, ~€0.3). Next: delete `campaigns`, tune the neutral flags' constants with `cmaes.py --race` flag-on before judging them, and run `simWars` on the calibrated scales (nation loss ×0.87, tribe loss ×0.72, speed ×1.29 from 17k engaged waves).

### Suggested A/B order

```
CONFIGS='{"base":{},"x":{"retaliateAware":true}}' SPRT=1 MIRROR=1 MINUTES=20 WORKERS=3 scripts/lab/remote.sh
# then, one flag at a time: drainedNations, wildernessAware, relationAware, markTargets, threatMap, utility, campaigns,
# hystRetreats, steamrollCap, strictOneWar, buildSearch
# simWars last: run the base sweep through scripts/lab/calibrate.py, paste the est* scales into Params.ts, then A/B
```

## What not to do

- **End-to-end RL / self-play leagues.** The engine runs ~190 ticks/s per core against thousands of frames/s for the generals.io sims that made RL work, a 40–100-player FFA is a credit-assignment nightmare, and every successful strategy-game RL result (AlphaStar, DipNet, Lux, the microRTS DRL winner) bootstrapped from expert logs you don't have. Competitions keep being won by scripted agents with a thin searched or learned layer — which is what the list above builds.
- **Forking the engine for rollouts.** One game-minute of rollout is ~3 s CPU against a 100 ms tick. Use `Estimate.ts` plus a value function as the abstract forward model (the Puppet Search / Prismata recipe), not the sim.
- **Bayesian optimisation.** Sequential by nature; wastes a 150-games-per-batch lab. CLOP is the one drop-in worth a quick trial.
- **Replay imitation.** Transcripts are priors, not data; the lab decides (as already agreed).

> **Suggested order.** 1 and the dead-param cleanup first — they change how every later A/B is judged and cost no game time. Then 2 (small flags, large expected gain against a deterministic field), then 4 so `simWars` can be re-tried on calibrated numbers, then 3/5/6 as one "utility + threat map + campaign" package, since each feeds the next.
