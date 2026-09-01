# PlaybookBot rebuild plan

Implementation plan for the architecture review (artifact
`PlaybookBot Architecture Review`, 2026-08-29). Written for the agents who
execute the work packages below. Companion docs: `PlaybookBotLab.md` (how to
measure), `PlaybookBotGUI.md` (how to watch).

Baseline: branch `playbook-bot` at `e69862fbe`.
Bot: `src/core/execution/playbook/PlaybookBotExecution.ts` (1,457 lines).

## Handoff (state at bb03d7cd8, 2026-08-29)

Read this first if you are picking the rebuild up.

**Where things are**

- Branch `playbook-bot`, HEAD `bb03d7cd8`, nothing pushed. All code packages
  A1–C2 are merged; only C3 (the lab campaign) remains.
- Bot: `src/core/execution/playbook/` — `PlaybookBotExecution.ts` (loop,
  `send()`, rule table), `Situation.ts` (+ phase, `Rivals.ts`), `Military.ts`,
  `Economy.ts`, `Diplomacy.ts`, `Params.ts`. (`Estimate.ts` and `Spend.ts`
  were deleted with their flags in 7cd2c9c56; last commit containing them:
  95f4b634a.)
- Tests: `npx vitest --dir tests tests/playbook --run` (golden included; the
  `--dir tests` matters — a bare path also matches copies under
  `.claude/worktrees/`). `npx tsc --noEmit` and `npm run lint` are clean.
- Lab: `docs/PlaybookBotLab.md`. Single game:
  `PARAMS='{...}' MIN=8 SPAWN=africa DIFF=medium LAB_OUT=/tmp/x OUTFILE=a.txt node --import tsx tests/lab/playbook.lab.ts`.
  Sweeps: `scripts/lab/remote.sh` (Hetzner, WORKERS=N) or `sweep.sh`; results
  via `scripts/lab/summarize.py`; tuning via `cmaes.py` / `ladder.sh`.

**Flags (see `Params.ts` for the defaults — they are not all off)**
Originally seven default-off flags waited for a 30-game Medium A/B:
`simWars`, `realRetreats`, `scoredSpend`, `bsrReserve`, `trustWars`,
`nationAware`, `phaseGates`. `{}` is the exact pre-rebuild baseline (every
flag-off transcript was proven byte-identical at merge time).
_Update (C3 done):_ `simWars`, `scoredSpend`, `bsrReserve` and `phaseGates`
`nationAware`, `phaseGates`; `{}` was the exact pre-rebuild baseline (every
flag-off transcript was proven byte-identical at merge time). Today
`realRetreats`, `trustWars` and `nationAware` default **on** (PROVISIONAL, see
their comments in `Params.ts`), `nearbyEvery` is 10, and the package below
added three default-off flags: `steamrollCap`, `holdHumans`, `strictOneWar`.
*Update (C3 done):* `simWars`, `scoredSpend`, `bsrReserve` and `phaseGates`
lost their A/Bs and were removed in 7cd2c9c56 (code, tests, `Estimate.ts`,
`Spend.ts`; a default-config game was diff-identical before and after). The
simWars/scoredSpend ideas live in git history — last commit with
`Estimate.ts`/`Spend.ts` is 95f4b634a. *Ladder (2026-08-29 late):* retreats
confirmed decisively and folded into the code (no flag); `trustWars` and
`nationAware` confirmed neutral-to-positive and kept on. No flags remain.

`Estimate.ts`/`Spend.ts` is 95f4b634a. Remaining flags: `realRetreats`,
`trustWars`, `nationAware` (all default on, PROVISIONAL — graduate them with
`SPRT=1`, see "Sequential evaluation loop" below).

**What to do next (C3)**

1. One sweep, MINUTES=20, all in the same CONFIGS so games pair:
   `{"base":{},"ret":{"realRetreats":true},"spend":{"scoredSpend":true},"c1":{"bsrReserve":true,"trustWars":true,"nationAware":true,"phaseGates":true},"sim":{"simWars":true}}`
   Keep `simWars` on its own: single-game smokes (africa, 8 min) gave baseline
   rank 2 / 43.5k tiles, `sim` rank 10 / 23k, `spend` rank 4 / 40k, `c1`
   rank 3 / 44k, all seven together rank 20 / 13.5k. Expect `simWars` to need
   retuning (wave margin 20 %, free-land gates 20/60/150 troops per tile in
   `Military.fight`) before it graduates.
2. Graduate winners: set the default to `true`, then (a later commit) fold
   the flag as C2 did. Drop losers. Update the golden hash only when a
   default changes, and say so in the commit.
3. Confirm flags were live in the transcripts: `sim:` annotations on ATTACK
   lines, `spend:` lines, `retreat from`/`coming home` lines, `phase` lines.
4. Then CMA-ES over the 11 continuous params (`cmaes.py` built-in spec),
   population 10, ~12 generations; ladder the result against `v-current`.
5. Repeat on Hard.

**Rules that still apply**

- New behaviour goes behind a default-off `PlaybookParams` flag; refactors
  keep the golden hash; every change ships a `tests/playbook/` test.
- One package = one worktree = one branch; `git checkout -b <branch> <sha>`
  first — agent worktrees have been created at `main`, not `playbook-bot`.
- Before merging into `playbook-bot`, check `git status`: another session
  (`openfront-00`) works in the main checkout; never stash or overwrite its
  edits — message it and merge after it commits.
- Hetzner: cpx51 only, `KEEP=1`, never `hcloud server delete` without
  telling Josh. A box `openfront-lab-c3` may still exist from an aborted run.

**Known loose ends**

- `realRetreats` off keeps the old no-op retreat on purpose (baseline
  fidelity); once it graduates, delete the `orderRetreat` path.
- `Spend.ts` value constants (`CAP_GOLD_PER_TROOP` = 20, port/rail curves)
  are first estimates from the labs, not swept.
- `bsr` approximates "their border facing us" by our border facing them.
- Worker branches `bot/a1-tests … bot/c1-c2` are merged and can be deleted.

## Ground rules

1. **One package = one worktree = one PR onto `playbook-bot`.** Own only the
   files listed in your card; if you must touch another file, say so in the PR.
2. **No behaviour change without a flag.** New logic goes behind a
   `PlaybookParams` boolean that defaults to **off**, so `{}` stays the
   baseline for every sweep. Flags graduate (default on, old branch deleted)
   only after a 30-game Medium A/B on Hetzner (`PlaybookBotLab.md`).
3. **Refactors are proven by the golden test**, not by argument. The sim is
   deterministic: same seed → identical bot log. A pure refactor must leave
   `tests/playbook/golden.test.ts` green; a behaviour change updates the
   golden hash in the same PR and says why.
4. **Every package ships tests** (`src/core` rule, CLAUDE.md). Rule-level
   tests live in `tests/playbook/`, on the `setup()` harness, not mocks.
5. `src/core` stays dependency-free, integer-deterministic, no floating
   point in game state (floats inside a bot _estimate_ are fine; they never
   touch state).

## Sequence

```
Day 1        A1 tests + golden ─┐   A2 module split ─┐   B4 tuning infra ──┐
                                │ (A2 merges first)  │                      │
Day 2–3      B1 attack estimator │ B2 situation model │ B3 spending scorer  │
             (Military.ts)       │ (Situation/Rivals) │ (Economy/Spend.ts)  │
                                 └────────┬───────────┘                     │
Day 4        C1 wire consumers to phase / threat / nation rules             │
             C2 fold graduated flags, delete losers                         │
Day 5+       C3 lab campaign: A/B each flag → CMA-ES on winners → Hard ◄────┘
```

A1, A2 and B4 start together. B1–B3 branch **from A2's merge** so the three
of them edit different files. C1/C2 are integration and belong to one agent.

## Interface contracts (agreed up front so packages don't collide)

### Module context (A2)

```ts
// src/core/execution/playbook/Context.ts
export interface BotContext {
  mg: Game;
  me: Player;
  p: PlaybookParams;
  sit: Situation;
  random: PseudoRandom;
  send(
    targetID: string | null,
    n: number,
    why: string,
    min?: number,
    capFloor?: number,
  ): number;
  boat(tile: TileRef, n: number, why: string): number;
  log(line: string): void; // enforces the 2000 cap
}
```

Modules are plain classes taking `ctx` in the constructor and exposing the
rule methods they own. `PlaybookBotExecution` keeps `init/tick/isActive`,
`readSituation`, `send`, `boat`, `events`, and the rule table.

### Situation (A2 defines, B2 extends)

```ts
export interface Situation {
  tick: number;
  troops: number;
  cap: number;
  capShare: number;
  reserve: number;
  spendable: number;
  gold: bigint;
  bots: Player[];
  rivals: Player[];
  friends: Player[];
  wilderness: boolean;
  incoming: Attack[];
  incomingBots: number;
  outgoing: Attack[];
  tribeAttacks: number;
  boats: number;
  collapsed: Player[];
  expiring: Player[];
  hold: Player | null;
  // B2 adds:
  phase: "opening" | "consolidate" | "war" | "endgame";
  rival: Map<Player, RivalView>; // trend, trust, border threat, nation predictions
}
export interface RivalView {
  troopsDelta: number; // per 100 ticks, from a ring buffer sampled every 50 ticks
  tilesDelta: number;
  trust: number; // 0–1; starts 0.5; − on broken alliance / attacked ally / refused request, + on renewal
  borderTiles: number; // our border tiles adjacent to them
  bsr: number; // their troops on our shared border / our troops (Risk border-security ratio)
  nationCanAttack: boolean; // from AiAttackBehavior rules; false for humans
  nationWouldSend: number; // troops their troopSendCap allows right now
}
```

### Attack estimator (B1)

```ts
// src/core/execution/playbook/Estimate.ts — pure, no state
export interface AttackEstimate {
  tilesTaken: number;
  attackerLoss: number;
  defenderLoss: number;
  ticks: number;
  troopsLeft: number;
  wins: boolean; // wins = target's troops exhausted before ours hit `stopBelow`
}
export function estimateAttack(
  mg: Game,
  attacker: Player,
  defender: Player,
  troops: number,
  opts?: { horizonTicks?: number; stopBelow?: number; reinforce?: boolean },
): AttackEstimate;
```

Replays `Config.attackLogic` over the defender's border tiles nearest to the
attacker (posts, terrain, fallout, size debuffs all come for free), adds the
defender's regen over the horizon when `reinforce` is on, stops at the
horizon, at `stopBelow`, or when the defender has no troops.

### Spending (B3)

```ts
// src/core/execution/playbook/Spend.ts
export interface Candidate {
  kind: "build" | "upgrade";
  type: UnitType;
  tile?: TileRef;
  unit?: Unit;
  cost: bigint;
  value: number;
  why: string;
} // value = expected return over horizon / cost
export interface Escrow {
  purpose: string;
  amount: bigint;
  until: number;
}
```

`Economy.build()` becomes: hard overrides (post where an attack lands, SAM
when a MIRV threat appears) → enumerate candidates → subtract escrow → buy
the top candidate if `value >= 1` → log the top three with values so the
lab can see why.

## Work packages

Each card is a self-contained brief. Definition of done includes tests,
`npm run lint`, and — for anything that can change behaviour — a lab result.

### A1 — Rule-level tests and the golden test

- **Owner files:** `tests/playbook/**`, `tests/util/PlaybookSetup.ts` (new).
- **Do not touch:** the bot.
- **Build:** `playbookSetup({ map, bot: PlaybookParams, rivals: [...], tribes })`
  on `tests/util/Setup.ts`: small map (`plains` / `half_land_half_ocean`),
  spawns the bot and N nation/bot opponents at given tiles, ends the spawn
  phase, exposes `step(n)`, the bot instance, and its log.
- **Tests (one file per rule):** counter fires at ≈1.05× an incoming non-bot
  attack above 15 % of our troops and not below; `expand` never sends below
  `homeFloor`; `send()` returns 0 while `sit.hold` is set (alliance with a
  stronger nation expiring in < 45 s); retreat triggers when the wave is
  < 20 % of what was sent and the target has > 70 % of its troops; the
  tribe click cap splits a large tribe into follow-ups 100 ticks apart;
  `build()` places a defence post facing the attacker when an attack lands.
- **Golden:** `golden.test.ts` runs the bot on `plains` vs two nations for
  600 ticks with a fixed seed and asserts a hash of `bot.log` + tiles +
  troops + gold at ticks 100/300/600 against a stored constant. Document in
  the file how to regenerate it (`GOLDEN=1 npx vitest …` prints the hash).
- **Done when:** all green on `e69862fbe`; `npx vitest tests/playbook --run`
  under 20 s.

### A2 — Mechanical module split (zero behaviour change)

- **Owner files:** `src/core/execution/playbook/**`.
- **Split:** `Context.ts`, `Situation.ts` (readSituation, neighbours, cap,
  density, landmass, acrossWater), `Military.ts` (expand, harvestBots,
  counterAttack, fight, manageRetreats, collapsed, boats: earlyBoat /
  sendBoat / huntBotsByBoat / seaInvasion / seaExpansion, maybeBomb,
  maybeMIRV, watchSplit), `Economy.ts` (build, buildRail, rail helpers,
  tile pickers, tryBuild), `Diplomacy.ts` (acceptAlliances, isPrey,
  requestAlliances, manageExpiries, manageEmbargoes, onAllianceEnded).
  `PlaybookBotExecution.ts` keeps the loop, `send/boat`, `events`, the rule
  table, and re-exports `PlaybookParams`/`DEFAULT_PLAYBOOK` so the lab, `GameRunner.ts`,
  `WorkerMessages.ts`, `ClientGameRunner.ts` and `tests/PlaybookBotHook.test.ts`
  don't change.
- **Rule:** move code, don't improve it. Private state that two modules
  share (`currentTarget`, `counters`, `lastWarTick`, `postFailed`) moves to
  the module that writes it with a getter; note each in the PR.
- **Done when:** A1's golden hash is unchanged, lab `MIN=1` transcript for
  one spawn is byte-identical before/after, lint clean.

### B1 — Attack estimator and simulated wars

- **Owner files:** `Estimate.ts` (new), `Military.ts`, `tests/playbook/estimate.test.ts`.
- **Flag:** `simWars: boolean` (default false).
- **Estimator:** as in the contract. Verify on the harness: launch a real
  `AttackExecution` with the same numbers and assert the estimate's
  `attackerLoss` / `tilesTaken` are within 15 % of the real outcome for three
  scenarios (no posts, posts on the border, defender twice our size).
- **With `simWars` on:** `fight()` picks the target and size by
  `estimateAttack` — send the smallest `troops` that `wins` with
  `troopsLeft >= reserve`, capped by `fightMaxShare`; skip targets where
  `tilesTaken / attackerLoss` is worse than free land (≈ 1 tile per 16–24
  troops). `manageRetreats()` re-estimates a running war every 100 ticks with
  the attack's current troops and retreats when `wins` flips false.
  `fightRatio` stays as the fallback when the flag is off.
- **Done when:** tests green; a 30-game Medium A/B `{"simWars":true}` vs `{}`
  on Hetzner is in the PR description (win/loss/tie, alive, crowns, land).

### B2 — Situation model: phase, rival trend/trust, border threat, nation rules

- **Owner files:** `Situation.ts`, `Rivals.ts` (new), `tests/playbook/situation.test.ts`.
- **Do not** change any consumer yet (that is C1); this package only _exposes_.
- **Phase:** `opening` while free land is reachable; `consolidate` when it
  is gone and troops < `fightAbove`·cap; `war` when a war is affordable or
  troops ≥ 0.95·cap; `endgame` when rank ≤ 3 and an unfriendly silo exists,
  or tick ≥ 15000 as a floor. Log every transition.
- **RivalView:** ring buffer per rival (8 samples, every 50 ticks) → deltas;
  trust updated from `events()` hooks (A2 exposes them); `borderTiles` and
  `bsr` from `me.borderTiles()` neighbours; `nationCanAttack` /
  `nationWouldSend` re-implement the checks in
  `src/core/execution/utils/AiAttackBehavior.ts` (`isAttackTooWeak`,
  `troopSendCap`, `hasTriggerRatioTroops`, `shouldAttack` by difficulty) —
  read that file, don't guess; include the difficulty constants.
- **Tests:** phase transitions on a scripted game; `nationCanAttack` matches
  what a real `NationExecution` does over 200 ticks in two set-ups (we are
  above / below its send cap).
- **Done when:** golden unchanged (exposure only), tests green.

### B3 — Scored spending with one escrow model

- **Owner files:** `Spend.ts` (new), `Economy.ts`, `tests/playbook/spend.test.ts`.
- **Flag:** `scoredSpend: boolean` (default false).
- **Values:** encode the lab numbers that live in the guide. City: cap and
  gold return per level; port: marginal trade income vs map-wide ship
  saturation (`seaFullShips`) and own level count; port level vs new port
  (`portLevelBeforeSecond` becomes a curve); factory + rail: only with
  stations within 110 tiles; silo/SAM: value from threat (enemy silos,
  rank) not tick; warship: per 6 ports after 15:00. Horizon = time left in
  the phase (endgame horizon is short, which retires "nothing after 25:00
  pays back" as a rule).
- **Escrow:** `mirvFund`, `siloReserve`, bomb reserve become entries in one
  list; `available = gold − Σ escrow`.
- **Tests:** with fixed inputs the top candidate is the one the lab found
  (three cases from the ports and rail labs); escrow is subtracted once.
- **Done when:** tests green; 30-game A/B in the PR.

### B4 — Tuning infrastructure

- **Owner files:** `scripts/lab/**`, `docs/PlaybookBotLab.md`.
- **Move** the scratchpad summariser (`ab30sum.py`) and `ab30.sh` pattern
  into `scripts/lab/` so results are reproducible from the repo.
- **`scripts/lab/cmaes.py`:** CMA-ES (pure numpy or a 60-line
  implementation, no new project deps) over a named list of continuous
  `PlaybookParams`; each generation = one `remote.sh` sweep with
  `CONFIGS` = the population; fitness = mean over the 30-game grid of
  `alive + share + (top3 ? 1 : 0)`; same grid every generation (paired
  seeds); writes `gen_N.json` with the population and scores; resumable.
- **`scripts/lab/ladder.sh`:** stores each graduated default set as
  `scripts/lab/versions/vN.json`; runs a candidate against the last three
  versions on the grid and prints a Bradley–Terry-style table.
- **Done when:** a 2-generation dry run with population 4 at `MINUTES=5`
  completes on Hetzner and the doc explains both scripts.

### C1 — Wire consumers (after B1–B3 merge) — done

Four new default-off `PlaybookParams` flags, one per consumer, so each can
be A/B'd on its own (`PARAMS='{"<flag>":true}'`):

- `bsrReserve`: `sit.reserve = troops × reserveShare × clamp(0.5 + 0.5·maxBsr, 0.5, 2.0)`
  over the unfriendly neighbours' `bsr` (`SituationQueries.reserveFactor`);
  reserveShare is the value at bsr 1. The phase is computed after the
  reserve (it reads spendable), so `enrich` is split into `enrichRivals` +
  `enrichPhase`.
- `trustWars`: `Military.fight()` drops a candidate whose living ally on
  our border has `nationCanAttack` with `nationWouldSend ≥ 0.5 × spendable`
  (`allyThatCanPileIn`, logged once per 600 ticks) and adds
  `2 × (1 − trust)` to the score (both scorers).
- `nationAware`: the expiry hold and the renewal gift ask
  `Rivals.couldAttackAtExpiry` (the RivalView rules with us counted as the
  unfriendly neighbour we become) instead of the 0.85× / 0.9× heuristics.
- `phaseGates`: `SituationQueries.phaseOr(literal, "endgame" | "pastOpening")`
  replaces the phase-proxy tick literals (25:00/20:00/15:00/12:00 → endgame;
  5:00/3:00/2:30 wars, silos, rail → past opening) in Military, Economy
  (both build passes) and Diplomacy; `Spend.horizonForPhase` gives the
  scored-spend horizon (opening/consolidate 6000, war 4000, endgame
  max(1000, 15000 − tick)). Genuine timers stay: `bombEvery`,
  `botFollowUpTicks`, `allianceEvery`, `siloAtTick`, `fightNotBeforeTick`,
  `boatAtTick`, `portWithoutPartnerTick`, the 0:30 / 1:00 boat-rule gates,
  the 1:30 threat-post gate, and the pure `Spend.siloReturn` /
  `samReturn` tick inputs.

Tests: `tests/playbook/{bsrReserve,trustWars,nationAware,phaseGates}.test.ts`.
With all four off the lab transcript is byte-identical to before (golden
unchanged). C3 runs the four A/Bs.

### C2 — Flag consolidation — done

- Folded into the code (the param and its dead branch removed): `wholeWars`,
  `stickyWar`, `splitWatch`, `econWar`, `postsBeforeCity2`,
  `retreatOnAllianceEnd`, `spawnBasin`. Deleted: `openingAllIn` /
  `openingKeep` (lost their A/B) and `homeFloor` (A1 found it declared and
  defaulted but read nowhere — the expansion floor is `reserveShare`, the
  cap floor is `send()`'s `capFloor` argument). `endgameV2` stays until the
  finish rule is settled. Behaviour-neutral for default params: golden
  unchanged, lab transcript byte-identical. Lab `PARAMS` JSON must not name
  the removed keys; `ALLIN` / `KEEP` env overrides are gone from
  `tests/lab/playbook.lab.test.ts`.

### C3 — Lab campaign

**Round 1 (2026-08-29, dc3d1d6c3; 150 games, Medium 20 min, 3× cpx62):**

| config                                           | alive | crowns | top-3 | total tiles | median | paired vs base |
| ------------------------------------------------ | ----- | ------ | ----- | ----------- | ------ | -------------- |
| base `{}`                                        | 30    | 2      | 14    | 2.08M       | 84k    | —              |
| realRetreats                                     | 30    | 5      | 17    | 3.53M       | 101k   | 18W 11L        |
| c1 (bsrReserve+trustWars+nationAware+phaseGates) | 30    | 6      | 12    | 3.20M       | 63k    | 18W 12L        |
| scoredSpend                                      | 29    | 3      | 9     | 1.99M       | 59k    | 12W 17L        |
| simWars                                          | 30    | 0      | 0     | 0.68M       | 25k    | 7W 23L         |

realRetreats graduated (default true). scoredSpend dropped as is (buys fewer
ports than the ladder; `Spend.ts` constants unswept). simWars dropped as
tuned — never a crown or top-3; retune wave margin / free-land gates before
another A/B. Round 2 unbundles c1 on top of realRetreats.

**Round 2 (216f4ddaf; 180 games; base = realRetreats on):**

| config              | alive | crowns | top-3 | total tiles | median | paired vs base      |
| ------------------- | ----- | ------ | ----- | ----------- | ------ | ------------------- |
| base (realRetreats) | 30    | 5      | 17    | 3.53M       | 101k   | —                   |
| + c1 bundle         | 30    | 4      | 14    | 2.99M       | 66k    | 17W 13L             |
| + bsrReserve        | 30    | 7      | 13    | 3.21M       | 63k    | 14W 16L             |
| + trustWars         | 30    | 7      | 19    | 3.91M       | 108k   | 6W 4L, 20 identical |
| + nationAware       | 30    | 4      | 18    | 3.34M       | 98k    | 9W 6L, 15 identical |
| + phaseGates        | 30    | 7      | 13    | 3.13M       | 78k    | 11W 18L             |

The c1 bundle's round-1 gain was realRetreats' gain in disguise. bsrReserve
and phaseGates dropped (phaseGates delays silos/SAMs to the endgame phase and
costs land). trustWars and nationAware are mild positives that rarely trigger.

**Round 3 (60 games; base = realRetreats on):** trustWars + nationAware
together: 30 alive, 8 crowns (base 5), 21 top-3 (17), 4.19M tiles (3.53M),
median 111k (101k), paired 11W 8L with 11 identical. Both graduated (default
true, bc9108bd1). Remaining default-off flags: simWars, scoredSpend,
bsrReserve, phaseGates — each needs a rework before another A/B.

**Round 4:** CMA-ES over the 11 continuous params, population 10 + base,
12 generations, 20-minute games, 3× cpx62 (`lab-out/cma`, NAME=openfront-cma).

1. Each B-flag: 30-game Medium A/B, graduate or drop.
2. CMA-ES over: `expandContested expandFree botRatio botClickCap
fightAbove fightMaxShare reserveShare retreatBelowRatio capFullShare
bombReserve railSpacing` (11 params; `homeFloor` was removed in C2), population 10, 12 generations
   ≈ 3.6k games ≈ €1.5 on cpx51.
3. Ladder run of the result vs v-current; if it wins, it becomes the next
   version and the guide's "Pressure-tested" table is updated.
4. Repeat 1–3 on Hard.

## Scoring (2026-08-30)

Why the old objective was not enough (seen in the day's sweeps): on Medium
`alive` is 30/30 for every config (zero information), `top3` is a step,
`share` swings ±0.3 on a single war, crowns were not scored, and paired A/Bs
counted games where the flag never fired (trustWars: 20/30 identical) as 30
games. Fixed in `scripts/lab/summarize.py`, `cmaes.py`, `ladder.sh`.

**Per-game score** (summarize.py; the old fitness stays as `fit_old`):

```
score     = landScore + rankScore + crown                 # [0.4, 2.25]
landScore = log10(max(tiles, 100)) / 5                    # 100k tiles = 1.0, 10k = 0.8, dead = 0.4
rankScore = alive ? 1 - (rank - 1) / (players - 1) : 0    # 1st = 1.0, last = 0.0
crown     = rank == 1 ? 0.25 : 0
```

`players` = the new `players=N` FINAL field; if absent, N of the last
`rank=x/N` transcript row (`p_<config>_<batch>_<region>.txt`), else N=40
with a printed note. The real N at 20 min on Medium is ~21–26, so the 40
fallback is lenient — keep transcripts (or the new field) for real scoring.
The optional FINAL field `fired=flag:count,…` (`-` = none) marks which
flagged branches ran.

**Paired report** (per config vs the first config named): the old table,
then over _live_ games only (config's `fired` non-empty, or (alive, tiles)
differ from the baseline): `n_live`, W/L/T by score, mean paired score
difference with a bootstrap 95% CI (1000 resamples, seed 0), a two-sided
exact sign test on W vs L, and a verdict — `decisive win` / `decisive loss`
when p < 0.05, else `undecided (n_live=…)`. `--fitness` emits the new score
(`--old-fitness` for the old one) plus `per_game` matrices; `--ladder`,
`--at`, `--verdict` are unchanged; `--selftest` checks the formulas on an
inline 3-game fixture.

**cmaes.py noise handling:** every generation also runs the distribution
mean as config `mean` (`--reeval-mean`, default on); the value handed to
CMA-ES for a member is the mean over the grid of (member score − `mean`
score on the same game), a common-random-numbers paired difference
(`--raw-fitness` = old behaviour). `--games-growth` adds `--extra-batches`
(`med5 … med9`, SPAWNRANK 5–9) once sigma < `--grow-below` (0.12), so late
generations run 60 games per config. `gen_N.json` stores `batches`,
`per_game` / `per_game_old` matrices, `objective`, `objective_kind`;
`--rescore OUT` recomputes those from the stored ab30 files without running
anything (CMA states are left alone — populations were sampled from them).
Verified with `--dry-run --pop 4 --gens 3 --grow-below 1.0 --games-growth`
(forces the 60-game grid from gen 0), a resume and a `--rescore`.

**ladder.sh:** `MINUTES` defaults to 30 (graduation length — 20-minute games
truncate the endgame) and `SHIFT` (default 150) moves every spawn region by
that many tiles (`tests/lab/playbook.lab.ts` reads `process.env.SHIFT`), so a
candidate is confirmed on a grid it was not tuned on. `sweep.sh` passes it
through implicitly (the game processes inherit the environment), so
`RUNNER=local` honours it; **`remote.sh` builds the box's env list by hand
(`CONFIGS MINUTES SHARD BATCHES SPAWNS JOBS`) and does not forward `SHIFT`**
— a remote ladder runs on the unshifted grid until `remote.sh` adds
`${SHIFT:+SHIFT=$SHIFT}` to that list (not edited here; ladder.sh prints a
note). Both tables (`fit_old` and `score`) and the Bradley–Terry ladder are
printed.

**C3 rounds re-scored** (no `players=` field yet; N from the transcripts).
Live stats vs base, `dScore` = mean paired score difference [bootstrap 95% CI],
p = sign test:

Round 1 (`lab-out/c3`, base = `{}`):

| config       | fit_old | score | n_live | W-L-T   | dScore                  | p     | verdict           | recorded in C3          |
| ------------ | ------- | ----- | ------ | ------- | ----------------------- | ----- | ----------------- | ----------------------- |
| base         | 1.846   | 1.672 | —      | —       | —                       | —     | —                 | —                       |
| realRetreats | 2.091   | 1.793 | 29/30  | 17-12-0 | +0.126 [−0.036, +0.293] | 0.458 | undecided         | **graduated** (18W 11L) |
| c1 bundle    | 1.907   | 1.802 | 30/30  | 18-12-0 | +0.131 [−0.062, +0.318] | 0.362 | undecided         | 18W 12L, unbundled      |
| scoredSpend  | 1.652   | 1.604 | 29/30  | 14-15-0 | −0.070 [−0.240, +0.086] | 1.000 | undecided         | dropped (12W 17L)       |
| simWars      | 1.126   | 1.394 | 30/30  | 8-22-0  | −0.277 [−0.430, −0.102] | 0.016 | **decisive loss** | dropped (7W 23L)        |

Round 2 (`lab-out/c3b`, base = realRetreats):

| config        | fit_old | score | n_live | W-L-T   | dScore                  | p     | verdict   | recorded in C3                   |
| ------------- | ------- | ----- | ------ | ------- | ----------------------- | ----- | --------- | -------------------------------- |
| base          | 2.091   | 1.793 | —      | —       | —                       | —     | —         | —                                |
| + c1 bundle   | 1.936   | 1.736 | 30/30  | 18-12-0 | −0.058 [−0.294, +0.172] | 0.362 | undecided | 17W 13L, "gain was realRetreats" |
| + bsrReserve  | 1.893   | 1.819 | 30/30  | 14-16-0 | +0.025 [−0.162, +0.212] | 0.856 | undecided | dropped (14W 16L)                |
| + trustWars   | 2.200   | 1.845 | 10/30  | 6-4-0   | +0.155 [−0.199, +0.501] | 0.754 | undecided | mild positive, 20 identical      |
| + nationAware | 2.148   | 1.853 | 15/30  | 9-6-0   | +0.119 [−0.047, +0.283] | 0.607 | undecided | mild positive, 15 identical      |
| + phaseGates  | 1.919   | 1.768 | 29/30  | 11-18-0 | −0.027 [−0.216, +0.156] | 0.265 | undecided | dropped (11W 18L)                |

Round 3 (`lab-out/c3c`, base = realRetreats):

| config                    | fit_old | score | n_live | W-L-T  | dScore                  | p     | verdict   | recorded in C3                       |
| ------------------------- | ------- | ----- | ------ | ------ | ----------------------- | ----- | --------- | ------------------------------------ |
| base                      | 2.091   | 1.793 | —      | —      | —                       | —     | —         | —                                    |
| + trustWars + nationAware | 2.336   | 1.917 | 19/30  | 10-9-0 | +0.194 [+0.018, +0.363] | 1.000 | undecided | **graduated** (11W 8L, 11 identical) |

Where the verdicts differ from the C3 record: **realRetreats** and
**trustWars+nationAware** were graduated on raw W/L counts; under the new
scoring both are `undecided` — realRetreats' CI straddles zero (p = 0.46),
and trustWars+nationAware has only 19 live games at 10-9 (p = 1.0) although
its mean gain is positive with a CI that just excludes zero (+0.018 … +0.363;
the gain is in magnitude — 3 more crowns — not in the count of games won).
Neither is contradicted, but neither was decisive at 30 games; a 60-game
shifted-grid confirmation (`ladder.sh`, SHIFT=150, 30 min) is the right
next step for both. The c1 bundle on top of realRetreats flips from a mild
paired win (17W 13L on tiles) to a slight negative mean score (−0.058),
consistent with the C3 note that its round-1 gain was realRetreats'. Of the
drops only **simWars** is a decisive loss (p = 0.016); scoredSpend,
bsrReserve and phaseGates are undecided — dropped on direction, not
evidence. Nothing on Hetzner was run for this section.

## Training-loop fixes (2026-08-29, evening)

Findings and what was done about them; see "Scoring" above for the formulas.

1. **Flag liveness** — `fired=` on the FINAL line counts how often a flag
   changed a decision vs off (`ctx.fire()` at every flagged branch); the
   summariser pairs over live games only. (ada3a998b)
2. **Score** — `landScore + rankScore + crown` with bootstrap CI and a sign
   test replaces `alive + share + top3`; verdicts are decisive only at
   p < 0.05. (e6e16b345)
3. **CMA-ES noise** — the distribution mean is re-evaluated every generation
   and members are scored as paired differences against it on shared games;
   the grid grows to 60 games once sigma < 0.12; generations can be
   re-scored offline. (e6e16b345)
4. **Shifted confirmation grid** — `ladder.sh` runs 30-minute games with
   `SHIFT=150`; `remote.sh` must forward `SHIFT` (peer's file; requested).
5. **Graduations re-examined** — under the new score `realRetreats` and
   `trustWars`+`nationAware` are _undecided_; their defaults stay on as
   PROVISIONAL (bug fix with positive mean; positive mean with CI just
   above zero) until a ladder confirmation. `simWars` is a decisive loss.
   The four losers (`simWars`, `scoredSpend`, `bsrReserve`, `phaseGates`)
   were removed from the code in 7cd2c9c56; `Estimate.ts`/`Spend.ts` last
   exist at 95f4b634a if either idea is picked up again.
6. **Early stopping: no.** Over 390 games, Spearman(rank at t, final rank)
   = 0.27 / 0.48 / 0.56 / 0.58 / 0.74 at 5 / 8 / 10 / 12 / 15 min; only 43 of
   101 crowns held at 12:00 survive to 20:00. Games are decided late — do not
   shorten tuning games; graduation runs are 30 minutes.
7. **Not done yet:** engine profiling for the remaining ~90 % of game CPU
   (AttackExecution, trade ships, 400 tribes); a `nearbyEvery` variant that
   caches only after the opening phase (peer's `--at 600` finding: the stale
   neighbour set slows the opening, 9W/21L at 10:00 despite the 20-min wash).

**Next lab session:** `ladder.sh` on the two provisional flags (60 games,
30 min, SHIFT=150) → fold or revert; then `cmaes.py --pop 10 --gens 12
--games-growth`; then Hard.

## Ladder (2026-08-29 late; `lab-out/ladder1`)

Shifted grid (`SHIFT=150`, `med0–med9`), 30-minute games, 45 paired games
per config (some shifted spawn slots are empty), 4× cpx62.

| config | alive | crowns | top-3 | total tiles | median | live W-L-T | dScore [95 % CI] | p | verdict |
|---|---|---|---|---|---|---|---|---|---|
| base (retreats + trust/nation on) | 44 | 11 | 32 | 6.66M | 127k | — | — | — | — |
| retreats off | 45 | 1 | 22 | 3.71M | 74k | 13-32-0 | −0.175 [−0.339, +0.003] | 0.007 | decisive loss |
| trustWars + nationAware off | 43 | 12 | 30 | 7.62M | 127k | 11-17-17 | −0.061 [−0.193, +0.045] | 0.345 | undecided |
| all three off | 45 | 8 | 26 | 4.97M | 86k | 14-31-0 | −0.065 [−0.250, +0.115] | 0.016 | decisive loss |

Decisions: retreats folded (the `realRetreats` flag removed; the fix is
unconditional). `trustWars`/`nationAware` kept on: neutral-to-positive, cheap,
rarely fire. `PlaybookParams` now carries no feature flags.

Midgame observation from the same 45 base games: median land 25k / 71k / 94k /
127k / 125k / 129k tiles at 5 / 10 / 15 / 20 / 25 / 30 min — growth stops at
20:00; ATTACK lines per 5-minute bucket 396 / 778 / 745 / 683 / 534 / 394;
`INVADE` (sea invasion) fired 0 times in 45 games; "idle at cap" logged 20
times, always naming one giant neighbour (e.g. Japan 260k tiles / 6.3M).

Lab can now run to a real win: `MIN=full` (170-minute ceiling), the loop
stops on `game.getWinner()`, FINAL carries `winner=us|other|none`.

## Border threat map (`threatMap`, review opportunity #5, 2026-08-29)

**Removed 2026-08-31 (branch `bot/prune`; the code lives in git history, last at 38219433a).**
A per-border-segment influence map (ThreatMap.ts) drove the reserve, the war scorer, threat-post placement
and a pre-positioned post. ab1: 46W/51L/2, dScore −0.073 [−0.170, +0.018] — noise; the CMA-tuned constants
(threatReserveGain/threatBusyWeight/threatVulnWeight/threatPreRatio) only helped inside the m4 bundle, which
lost the full-game gate (full1). Deleted with the flag, its params, ThreatMap.ts and tests.

## Sequential evaluation loop (2026-08-29, branch bot/lab-sprt)

Review opportunity #1: the accept gate is no longer a fixed 30 games.
`scripts/lab/summarize.py --sprt` runs a generalised SPRT on the paired
score difference (H0 d ≤ 0 vs H1 d ≥ δ = 0.10, α = β = 0.05, bounds
±2.94); `remote.sh` / `sweep.sh` `SPRT=1` keep adding chunks of `STAGE1`
batches (pool `BATCHES` + `EXTRA` = med0 … med9, `MAXBATCHES` 10) until
every config has ACCEPT or REJECT; `MIRROR=1` plays each scenario in two
slots (shifted grid + other opponent field, averaged into one observation,
pentanomial line); `cmaes.py --race` drops members the same test puts below
`mean` after 3 batches and spends the saved games on the survivors;
`retreatBelowRatio` left `BUILTIN_SPEC` (read nowhere) and the spec is
checked against `Params.ts` at start-up; `summarize.py --cycles` (and the
ladder) reports non-transitive triples. Full write-up and commands:
`docs/PlaybookBotLab.md` "Sequential testing".

**How to graduate `realRetreats`, `trustWars`, `nationAware`** (all default
on, PROVISIONAL): run each as a *removal* against the current default, so
the baseline is the code as shipped and REJECT means "turning it off is not
better" — i.e. keep it:

```bash
CONFIGS='{"base":{},"noRet":{"realRetreats":false},"noTrust":{"trustWars":false},"noNA":{"nationAware":false}}' \
  MINUTES=30 WORKERS=3 SPRT=1 MIRROR=1 DEST=lab-out/grad-2026-08 scripts/lab/remote.sh
python3 scripts/lab/summarize.py --sprt lab-out/grad-2026-08 base noRet noTrust noNA
```

Read the SPRT line per config: **REJECT** (off is not better by δ) with a
non-positive live mean → the flag stays on and graduates (fold it as C2
did, note n and the LLR next to the parameter). **ACCEPT** (off is better
by ≥ δ) → revert the default and delete the branch. **CONTINUE after 10
batches** (60 games, 120 with MIRROR) → the effect is below 0.10 score
units either way; keep the simpler code path (off) and record it as
"no measurable effect at n=…". Because `trustWars`/`nationAware` fire in
only a third of the games, expect them to need the mirrored 120 and read
`n_live`; `realRetreats` fires everywhere and should decide by 36–60.
## #4 — Calibrating the estimator, `simWars` and `hystRetreats` (2026-08-29, branch bot/estimator)

**Removed 2026-08-31 (branch `bot/prune`; the code lives in git history, last at 38219433a).**
`hystRetreats` (estimator-judged retreat hysteresis; hystMargin/hystSlope/hystStrikes, retreatBelowRatio):
ab1 −0.100 leaning harmful, ab2 on the calibrated scales dScore −0.06 — SPRT REJECT; never helped in the
gate era either. `simWars` had already lost twice (C3 7W-23L; ab2 −0.43, deleted at dfacb785f). With both
gone the estimator layer had no consumer left, so it went too: Estimate.ts, Military.estOpts, the always-on
EST/ACT calibration log, estLossScaleNation/Human/Bot + estSpeedScale, scripts/lab/calibrate.py, and the
estimate/calibration tests. The per-war WAR RESULT accounting stays (warYield reads it; loss_analysis.py
parses it). Removing the EST/ACT lines changes no decision: the golden material and MIN=3/MIN=6 africa lab
transcripts are byte-identical to base after stripping those lines (see "Pruning" below).

## Opportunity #2 — the nation AI as a perfect-information opponent (2026-08-29)

**Removed 2026-08-31 (branch `bot/prune2`; the code lives in git history, last at 0a8f35bc4).**
The five nation-script flags are all gone now. `markTargets` (ab1 41W/58L, 4 deaths vs 0) and `wildernessAware`
(never fires) went with `bot/prune`; `drainedNations` (+ drainRatio/drainBelow, RivalView.drainedUntil; flips1
+0.01 and mapped to no loss cluster), `retaliateAware` (+ retalRatio, the shadow-wave logic,
RivalView.largestAttacker; flips1 −0.07) and `relationAware` (+ the wouldAcceptAlliance replay of
getAllianceDecision, RivalView.relation, the prey-pick preference; flips1 −0.31) went with `bot/prune2` after
losing flips1 against the combo defaults. `Rivals.NATION_RULES` keeps only the attack-rule constants
`trustWars`/`nationAware` still read (reserveRatio, tooWeakShare, retain, targetDuration/targetCooldown).

## Review packages (2026-08-29, "PlaybookBot vs the field")

### #7 — Fast-forward build search (`buildSearch`) and a value function from records

**Removed 2026-08-31 (branch `bot/prune`; the code lives in git history, last at 38219433a).**
A BOSS-style fast-forward search (BuildSearch.ts) replaced Economy.build's ordered chain behind the
`buildSearch` flag. ab1: 49W/50L/0, dScore −0.002 [−0.095, +0.095] — pure noise for real planner CPU
(+11 % median tiles but fewer crowns); the CMA-tuned buildCapGoldPerTroop/buildHorizon only helped inside
the m4 bundle, which lost the full-game gate. Deleted with the flag, both params, BuildSearch.ts and tests.

## Fixes + perf package (2026-08-29, branch `bot/fixes-perf`)

> **Pruned 2026-08-31:** `steamrollCap` (ab1 2W/1L/95T) and `holdHumans` (never fires in the lab) went with
> `bot/prune` (last at 38219433a); `strictOneWar` (the only ab1 positive, +0.02) followed with `bot/prune2` after
> flips1 rejected it against the combo defaults (SPRT REJECT −0.07; last at 0a8f35bc4). The perf work and the
> no-flag bug fixes below are all still in.

Review opportunity #8 ("cheap CPU wins") and the bug table.

**Performance (decision-identical; golden hash unchanged, 6-minute africa/Medium
smoke row-for-row identical, botMs 394 → 306):** the MIRV-threat scan, the
expiring list and the expiry hold are computed on the 10-tick cadence every
consumer runs on (`readSlow`); `Rivals.troopSendCap` memoises each rival's
`nearby()` for `nearbyEvery` ticks; `watchSplit` derives the 4-connected pieces
from the border runs alone (`Military.pieces`, exact — tested against the old
flood fill on constructed shapes and 200 random blobs; only the sampled gap
estimate moved, to border samples); `neighbours()` memoises the friend/rival
split per tick (invalidated after `acceptAlliances`); `interiorTile` ranks the
40 samples with one walk of the border, once per tick; a `prune` rule (every
300 ticks) drops dead players, finished attacks and passed windows from every
per-player map (`bombed` is kept on purpose: a structure is bombed once).

**Bug fixes (no flag):** `reachable()` blacklists only a wave that vanished
uncontested without taking a tile (a won fight, a dead target or a cancelled
counter no longer blacklist; a diagonal-only neighbour still does);
a lapse we planned (`plannedTarget`) leaves trust unchanged; `manageExpiries`
runs every 50 ticks and retries a gift/renewal that could not go through, once
per alliance; the MIRV-threat gate reads the live MIRV price; `maybeMIRV`
shifts off a SAM-covered centre (or holds when every tile is covered); the rule
table reads `expandEvery` / `allianceEvery`. None of these reach the golden
window (its hash is unchanged); each has a test in `tests/playbook/fixesPerf.test.ts`.

The package's three flags (`steamrollCap`, `holdHumans`, `strictOneWar`) are described in the pruning note above;
the tests that remain are `tests/playbook/fixesPerf.test.ts`.

### #3 — One currency for troops (`utility`)

**Removed 2026-08-31 (branch `bot/prune`; the code lives in git history, last at 38219433a).**
One `troops` rule (Utility.ts scoring + Military.troopsRule) replaced counter/expand/tribes/wars behind the
`utility` flag. ab1: 53W/44L/2, dScore −0.006 [−0.089, +0.084] — the best of the twelve review flags and
still noise (SPRT CONTINUE after 10 batches, 1,287 games); it also carried the estimator's CPU on every
pass. Deleted with the flag, utilCapMid/utilCapSteep/utilCommit/utilFreeLandCost/utilScoreFull, Utility.ts
and tests.

### #6 — A war plan with a preparation phase (`campaigns`) — removed

Removed after ab1 (38W/60L, dScore −0.19, p = 0.03). `Campaign.ts`, the troop escrow in `send()`/`boat()`, the prep-target post and the no-alliance rule are in git history at 85ce33c8e.

## Review-package A/B `ab1` (2026-08-29 late, `lab-out/ab1`)

`CONFIGS` = base + the twelve review flags (simWars deferred until calibration), `SPRT=1 MIRROR=1 MINUTES=20 WORKERS=4` on cpx62@fsn1; 10 batches (med0–med9, mirrored), 1,287 games, ~€0.3, 32 min wall clock. Score = summarize.py's land+rank+crown; pairs are live games vs base.

| flag | W/L/T | dScore [95 % CI] | sign p | verdict |
|---|---|---|---|---|
| campaigns | 38/60/1 | −0.186 [−0.298, −0.075] | 0.033 | **decisive loss — delete** |
| hystRetreats | 46/49/3 | −0.100 [−0.226, +0.009] | 0.84 | leaning harmful |
| markTargets | 41/58/0 | −0.081 [−0.175, +0.019] | 0.11 | leaning harmful (4 deaths vs 0) |
| threatMap | 46/51/2 | −0.073 [−0.170, +0.018] | 0.69 | noise |
| drainedNations | 46/51/2 | −0.067 [−0.151, +0.022] | 0.69 | noise |
| relationAware | 42/46/11 | −0.037 [−0.132, +0.059] | 0.75 | noise |
| retaliateAware | 42/36/20 | −0.025 [−0.117, +0.054] | 0.57 | noise |
| utility | 53/44/2 | −0.006 [−0.089, +0.084] | 0.42 | noise (SPRT: CONTINUE after 10 batches) |
| buildSearch | 49/50/0 | −0.002 [−0.095, +0.095] | 1.0 | noise (+11 % median tiles, fewer crowns) |
| strictOneWar | 19/13/66 | +0.018 [−0.027, +0.066] | 0.38 | only positive; fires in a third of games |
| wildernessAware | 11/7/81 | −0.005 | — | never changes a decision in this lab |
| steamrollCap | 2/1/95 | −0.001 | — | never changes a decision in this lab |

Reading: none of the mechanisms beats the CMA-ES-tuned base at its hand-picked constants; the SPRT (δ = 0.10) rejected every flag except utility. Next: delete campaigns; put the constants of the neutral flags (threatReserveGain, the utility curve midpoints, buildSearch's CAP_GOLD_PER_TROOP, retaliate/drained ratios) into `cmaes.py --race` with the flag on before judging them; run simWars with the calibrated scales (calibrate.py on ab1's base: estLossScaleNation 0.868, estLossScaleBot 0.719, estSpeedScale 1.285, from 17k engaged waves; spread ≈ 1.0 in log space).

Grid note: with `MIRROR=1` the shifted slots med3+/australia, med8/africa and med9/north-russia, south-america, east-asia(b) have no valid spawn (`pickSpawn` throws "no spawn near"); they fail identically for every config, so pairing is unaffected but the later batches carry fewer pairs.
**A/B:** `CONFIGS='{"base":{},"x":{"campaigns":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`
(and `{"utility":true,"campaigns":true}` for the pair — the review suggested
#3 / #5 / #6 as one package).

## Boats (`boatsNearest`, `finishByBoat`, 2026-08-29, branch `bot/boats`)

Josh, from watching games: boats sail past a shore they could have taken
first, and a war target that lives on across a strait is never finished. The
cause in code: every boat rule measured a candidate from
`shore[Math.floor(shore.length / 2)]` — an arbitrary middle tile of the border
list, possibly on the far side of the empire — while the engine launches from
the shore nearest the landing (`TransportShipUtils.bestShoreDeploymentSource` →
`SpatialQuery.closestShoreByWater`); the free-shore scan skipped anything under
30 tiles; and nothing looked at a war target's land beyond the front.

**`boatsNearest`.** `Military.shoreSample()` is every k-th ocean-shore border
tile (≤ 200, cached per tick) and `nearestShoreDist(t)` the minimum manhattan
distance from it — the bot's estimate now matches what the engine will do.
`seaExpansion`, `earlyBoat`, `huntBotsByBoat` and `seaInvasion` measure with it;
the free-shore scans cover the sampled coast's bounding box (± 300 / ± 200)
instead of a window around the middle tile, so a shore off either end of a
long coast is seen at all. Ranking: every value is divided by
`max(1, d / 40)` instead of the flat `− d / 2` (free shore 300, collapsed 600,
weak 400, tribe 250, + 10 a city), so an unowned shore 60 tiles away (200)
beats a collapsed player 200 tiles away (120) — the stepping stone first. The
"d < 30" skip on a free shore drops to 10; because `acrossWater` is a
depth-first fill that gives up at 4000 tiles and on a big landmass calls a
tile fourteen tiles up our own coast "across water", the flagged branches use
`SituationQueries.acrossWaterNear(t, d)` — breadth-first inside a radius of
`2d + 20` — instead. Troop sizes are unchanged. Fires (one count per site per
100 ticks) when the launched candidate is not the one the old ranking —
middle tile, flat penalty, 30-tile floor, its own scan grid, its own
`acrossWater` — would have launched at.

**`finishByBoat`.** A rule every 100 ticks from tick 1200: for the current war
target (hit inside 1800 ticks) and every non-bot rival one of our waves is on,
`Military.unreachablePart(t)` = the 4-connected pieces of it
(`Military.pieces`, exact from the border — the flood fill the brief asked
for costs O(tiles)) with no border tile beside one of ours; AttackExecution
only takes tiles adjacent to ours, so a land war never reaches those. When
that part has an ocean shore, a boat goes from our nearest shore to its shore
tile nearest our coast (≤ 600 tiles): `2 × its troops × (unreachable / its
tiles) + 2000`, at most 40 % of the spendable, through `ctx.boat()`. One boat
per target at a time (a transport still bound for it, or one launched inside
600 ticks, holds the next). Logs `FINISH BY BOAT <name> <n> unreachable tiles
of <total>, troops <t> spendable <s> → <sent> landing <d> tiles out`; fires on
every launch.

**Tests.** `tests/playbook/boats.test.ts` on the world test map at
Bab-el-Mandeb (the 16 × 16 water test maps are too small for a boat rule):
the early boat off sails 80 tiles from the middle shore tile while a free
shore 32 tiles from our nearest shore exists, on it takes that one and the
flag fires; the shore sample and the nearest distance; a target holding a
piece beside us and a remnant across the strait — the remnant is the
unreachable part with its shore, at tick 1200 the boat lands on it with the
formula's troops (the 40 % cap binding) and the next pass holds; off no boat;
no boat when every tile of the target borders us. Golden hash unchanged with
both flags off; `MIN=3` africa transcript byte-identical but `botMs`/`gameMs`.

**Smoke** (`MIN=8 SPAWN=africa DIFF=medium`, one game each): off rank 2,
46.6k tiles, `botMs=657`; both on rank 1, 61.8k tiles, `botMs=729`,
`fired=boatsNearest:31,finishByBoat:10`. Boat lines now carry the distance
the engine will sail (`free shore (18 tiles)`, `collapsed Algeria … (18
tiles)` where the old rule's picks read 60–200); ten `FINISH BY BOAT` lines,
from a 2k boat at a 4-tile enclave to 288k at Sri Lanka's last 859 tiles
across the strait.

**A/B:** `CONFIGS='{"base":{},"near":{"boatsNearest":true},"finish":{"finishByBoat":true},"both":{"boatsNearest":true,"finishByBoat":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`.

## `ab2` — calibrated estimator flags (2026-08-29 late, `lab-out/ab2`)

Same harness as ab1 (SPRT + MIRROR, 20-min Medium, 4× cpx62), 94 pairs per config, est scales from calibrate.py on ab1's base (nation loss ×0.868, tribe loss ×0.719, speed ×1.285).

| config | dScore vs base | verdict |
|---|---|---|
| simWars (calibrated) | −0.43 | decisive loss — flag deleted (dfacb785f); the calibration makes the wave picker more aggressive, the free-land gate / wave margin were the real problem |
| hystRetreats (calibrated) | −0.06 | rejected; kept as a flag for the CMA race (hystMargin/hystSlope/hystStrikes now params) |
| simWars + hystRetreats | −0.52 | decisive loss |
| strictOneWar | −0.01 (same games as ab1) | rarely fires; unchanged |
## Annexations and alliances (`annexWars`, `lapseToAttack`, 2026-08-29, branch `bot/annex-alliances`)

Two things Josh saw in games: the bot fails to get annexations and then gets
split, and it renews alliances it should let expire so it can attack the ally.
In the code: `Situation.annexable()` returned false the moment the target had
one ocean-shore or map-edge border tile, so a coastal player could never be
annexed, and when it did pass it only set expand's `ringing` — it never became
a war (only the gap owner did). `manageExpiries` let an ally lapse only if it
was under 0.4× our troops *and* we were above `fightAbove` *and* we had at
most one other unfriendly neighbour (or annexable, or an endgame rule) — so a
weak ally that is the obvious next conquest was renewed whenever a second
rival existed.

**`annexWars`.** (a) `annexable()` samples the target's border (every third
tile) and classes each sample as ours-adjacent, other (touching a third
party's or unowned land) or coast-or-edge (ocean shore, map edge, lake-only
shore — nobody reinforces through it). Annexable = ours-adjacent ≥ 40 % and
other ≤ 15 % of the samples and smaller than us. The test is geometry only:
the consumers apply "not our ally" (warPick's rivals and Diplomacy's
request/accept lists are unfriendly by construction) and `manageExpiries`
reads it for an ally on purpose, to let that alliance lapse. The old rule runs
unchanged with the flag off; `annexableChanged(p)` says whether the two
disagree (the liveness counter). (b) In `warPick` an annexable unfriendly
neighbour is an opportunity like the gap owner: it passes the affordability
gate, the sticky-target filter and the one-war limit, scores 25 + ratio at
ratio ≥ 1.2 (we attack from most of its border and it cannot be reinforced),
and the wave is 1.2× its troops + 1000 (`ANNEX WAR <name>` beside the ATTACK
line; `simWars` gets the same +25 and the opportunity loss bar). With
`campaigns` it goes at once (an opportunity, no prepare); with `utility` the
alt carries `annex` and rank 1. (c) Diplomacy neither requests nor accepts an
alliance with an annexable player (it already did; the wider definition now
reaches coastal players). Fires on each ANNEX WAR wave and on a refusal or a
lapse the old rule would not have made. The scorer of `warPick` was lifted
into `Military.warScorer(gapOwner, threatHere, annex, quiet)` so the next
flag could reuse it; golden unchanged.

**`lapseToAttack`.** `Military.wouldTarget(p): { ok, score }` runs warPick's
gates on `p` as if it were an unfriendly neighbour — affordable out of
spendable × fightMaxShare (or an opportunity, or troops above fightAbove ×
cap), the early 2.5× prey filter, reachability, the hold — and the same
scorer (ratio ≥ fightRatio from maxSend, posts / density / size rules, every
bonus) with the flag counters muted. In `manageExpiries`, after the
`campaigns` prep-target check and before the gift, an ally that `wouldTarget`
accepts and whose score beats every current unfriendly neighbour's
`wouldTarget` score becomes the planned target whatever `rivals.length` is —
unless an unfriendly neighbour with troops > 0.6× ours borders us and the ally
is not annexable. Logged `let alliance lapse to attack <name> (score …)`;
fires on each such lapse. The old prey rule is untouched and runs first.

**Tests.** `tests/playbook/annexWars.test.ts`: a 4 × 4 target on the ocean
shore of `half_land_half_ocean` with the rest of the land ours is annexable
on, not off (the ANNEX target line says `coastal`); the same on a big_plains
map edge; a third party on 17 % of the border refuses; an encircled neighbour
at 1.8× (under fightRatio, not affordable) gets a 1.2× ANNEX WAR wave on and
nothing off; nothing under 1.2×; no alliance request to, and no acceptance
from, an annexable player (off: both go). `tests/playbook/lapseToAttack.test.ts`:
a 10 × 10 ally at ~0.2× our troops with two unfriendly strips north and south
— off renews (`onlyOneAgreedToExtend()` after our AllianceExtensionExecution),
on lets it lapse, logs the score, fires once, and the war rule takes it when
the alliance ends; a neighbour above 0.6× keeps the alliance; an ally the
ratio gate refuses is renewed. Sizes, not troop counts, fix the ratios: every
player grows toward its cap inside the 600-tick alliance.

**Proof.** 3-minute africa/Medium lab game before and after, flags off:
identical except botMs/gameMs (`/tmp/lab-annex/{before,after}.txt`); golden
unchanged. Smokes, both flags on vs off (one game each, Medium):
africa 8 min — identical (rank 2, 46,567 tiles, nothing fired: the only annex
target of the old rule was a tribe and no ally met the scorer in the window);
north-america 12 min — on rank 1 / 92,024 tiles, off rank 3 / 84,160
(`lapseToAttack` fired 4: Quebec at 3350, Nunavut, Norway, Texas — the first
three lapsed and were attacked, Texas lapsed at 5436 and was not); east-asia 12 min — on rank 25 / 97 tiles, off rank 3 /
68,384, with *nothing* fired: the divergence is the wider annex ring in
`expandOption` (two coastal tribes ringed at 780 / 1280, so the click share
was 0.2 not 0.1 — now counted as a fire), the game then went a different way
and a 2× war on Siberia at 4060 met Bhutan's 927k pile-in and a 60-piece
split. One game is not evidence either way; it is why the A/B exists.
Also seen (pre-existing): with two allies in their windows, `manageExpiries`
logs `let alliance with … lapse` for both every 50 ticks — `plannedTarget_`
holds one player, so each pass re-plans the other.

**A/B:** `CONFIGS='{"base":{},"annex":{"annexWars":true},"lapse":{"lapseToAttack":true},"both":{"annexWars":true,"lapseToAttack":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

## Opportunistic wars and multitasking (`borderRatio`, `multiWar`, 2026-08-29, branch bot/multiwar)

Josh's observation from the ladder games: the bot stops attacking in the
midgame — land plateaus at 20:00, `ATTACK` lines fall from 778 to 394 per
5-minute bucket, and every "idle at cap" line names one giant neighbour. The
causes in code: `warPick` compares the wave (≤ `fightMaxShare` of troops, minus
the 30 % reserve) to the target's **whole** army at `fightRatio` 2×, so once
the neighbours are large nothing qualifies; one war at a time (two only at cap
after 25:00) plus the sticky target; one tribe click per pass. Two default-off
flags, in clearly separable blocks (no dependency on `Campaign.ts`):

**`borderRatio`** — a target whose whole army is out of reach at the gate
(`maxSend / troops < minRatio`, whatever the gate's special case — shadowed,
richer, attacking us) is measured instead against what it can bring to *our*
border: `defenders = (troops + regen × 100 ticks) × max(0.25, borderShare)`,
where `borderShare` = its border tiles facing us / its total border tiles
(new `RivalView.borderShare`, the same approximation `bsr` already uses; a
target facing us on ≤ 25 % of its border still counts a quarter). The regen
horizon is 10 s — the time a wave takes to bite in — because a minute of the
engine's regen exceeds the army itself at midgame troop counts, which would
have made every bite dearer than the whole-army war. The gate is then `wave ≥
fightRatio × defenders` and the wave is `fightRatio × defenders + 1000` (a
bite, not a whole-army fight), capped at `maxSend`; the density veto (`ratio <
3 && tiles > 1.5× ours && density < 40 → never`) is skipped on that path and
the size penalty stays; the affordability gate accepts a bite too. Logged as
`BITE <name> border share 0.xx, defenders Nk` before the `ATTACK` line. Fires
(`borderRatio`) whenever a target passes only via the border ratio. With
`fightRatio` 2 and the 0.25 floor the bite reaches a neighbour up to ~1.2× our
troops (0.6 / (2 × 0.25)) — bigger than that, nothing fits, whichever gate.

**`multiWar`** — (a) wars: `fight()` keeps calling `warPick` inside the pass;
once the plain rule's slot is used (`wars ≥ limit`) a second and third war may
open when the next wave is affordable above the reserve (`send()`'s
whole-or-nothing test, unchanged) and the total committed — `attackStart`'s
send per running non-counter war, else what is left of the wave, plus the
waves opened earlier in the pass — stays under `fightMaxShare` of the army
(`troops + committed`); each wave ≥ 1000. `MULTI_WAR_SLOTS` = 3 counts every
running non-bot attack, so **a running counter occupies a slot** (the old
`strictOneWar` finding, 15W/6L, carried over). The sticky-target filter binds
the first war only; an extra war never becomes `currentTarget_` and does not
refresh `lastWarTick`. With `utility` on, a further war option in the ranked
list re-runs `warPick` against the slots and commitments the first one left.
Logged `WAR #n beside the running ones`; fires per extra war. (b) tribes:
concurrency 2 below 60 % of cap, 3 above (never under the old value), and
`harvestBots` / the troops rule keep clicking while the next click is
affordable, at most three per pass; fires per click the one-at-a-time rule
would not have made. (c) building: verified that `Economy.build` waits on
`outgoingAttacks().length === 0` only in the idle-at-cap silo rule (and the
bomb reserve that reads the same `idleAtCap`); the campaigns escrow trims
builds only while a campaign prepares — that is `campaigns`' own flag and is
left alone.

Tests: `tests/playbook/borderRatio.test.ts` (a 150k neighbour facing our
200k on ~20 % of its border: off → no war; on → `BITE` with the wave at
2 × (troops + 10 s regen) × 0.25 + 1000; a target wrapped by us on > 80 % of
its border is still gated by its whole army) and
`tests/playbook/multiWar.test.ts` (two weak neighbours: off → one war per
pass, on → both in the same pass under `fightMaxShare`, with `utility` on
too; three neighbours fill three slots; a counter on the current target
leaves room for two; three tribes
below 60 % of cap: on → two first clicks in one pass, off → one). Golden
unchanged; a 3-minute africa transcript with `{}` is byte-identical before
and after (only `botMs`/`gameMs` differ).

Smoke (africa, Medium, 12 min, one seed — not evidence): see the package
report in the commit message.

A/B: `CONFIGS='{"base":{},"bite":{"borderRatio":true},"multi":{"multiWar":true},"both":{"borderRatio":true,"multiWar":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

**Smoke result and a caveat on the premise (africa, Medium, 12 min, one seed).**
Off: rank 6/30, 49.5k tiles, 38 `ATTACK`, 5 retreats, 0 counters, botMs 1138.
Both on: rank 13/29, 22.8k tiles, 59 `ATTACK` (36 `BITE`, 32 `WAR #n`), 17
retreats, 17 counters, botMs 910; `fired` multiWar:45, borderRatio:60. Every
`BITE` line shows the 0.25 floor (no midgame neighbour faces us on more than a
quarter of its border), the bites went at 0.57–0.78× of the target's army and
lost (Libya 144k → 140 tiles for 128k lost; Morocco 202k → 243 tiles for 177k;
Spain 286k, 25k left), and each opened a front that came back as an
`INCOMING`/`COUNTER` pair. The reason is in the engine, not the tuning:
`Config.attackLogic` prices the attacker's per-tile loss by
`within(defender.troops() / attackTroops, 0.6, 2) × mag` — the defender's
**whole** army, wherever it sits — so a 0.75× wave pays 2.2× the per-tile loss
of a 2× wave and takes fewer tiles. The border-share premise ("a target can
only bring what faces us") does not hold in OpenFront; the A/B is expected to
confirm this. `multiWar` on its own is the part worth the A/B (its extra wars
in the smoke were mostly bites, so the pair confounds it — run the four
CONFIGS above, not just `both`).

**borderRatio deleted (2026-08-30).** Built and smoked in the multiwar package; it
loses by construction: `Config.attackLogic` prices the attacker's per-tile loss by
`within(defender.troops() / attackTroops, 0.6, 2)` — the defender's whole army —
so a "bite" at a thin border pays the full price (africa 12-min smoke: 36 bites,
rank 13 vs 6 off). The flag, `Military.bite()` and its tests are gone; the
`RivalView.borderShare` field it added stays (cheap, used by nothing yet).

## Boats II (`boatsWaterPath`, `boatsAfterCoast`, 2026-08-29, branch `bot/boats2`)

Josh, from the GUI: boats still take far paths, and go before the bot has
expanded to the coast. The 45-game lab data agrees — every game launches an
early boat at tick 60 (6k troops, "empty shore" 54–112 tiles straight-line) and
tribe/island boats sail a median 156 tiles (p90 292). The cause: every boat rule
ranks by manhattan distance, while the engine paths the transport over water
(`TransportShipExecution` → `WaterPathFinder`, the tiles where
`GameMap.isWater`) around every coast, often several times the straight line —
and manhattan crosses land, so a shore on the far side of the continent reads
"200 tiles". Two default-off flags, composing with `boatsNearest` on or off:

**`boatsWaterPath`.** `Military.waterPath()` is one breadth-first fill over
water tiles (4-connected, ocean and lake alike, shoreline water included — the
transport's graph) from every water neighbour of `shoreSample()` (the tiles
`boatsNearest` measures from; with it off, the same sample of the whole ocean
shore), out to `WATER_MAX_DIST` = 300 tiles (the longest cap below) and at most
`WATER_BFS_TILES` = 400k of them, into one map-sized `Uint16Array` reused
across fills; computed at most once per pass and cached 100 ticks
(`waterPathRuns` counts the fills). `WaterPath.len(t)` is the tiles a boat
sails to shore tile `t` — its nearest reached water neighbour + 1 — or
Infinity beyond the fill. Every boat rule ranks by that length instead of
manhattan (the value formulas are unchanged, `d` substituted) and refuses a
candidate whose path exceeds `Military.BOAT_MAX_PATH`: early 80, tribe hunt /
island 150, sea expansion 200, finishByBoat 250, seaInvasion 300. With the flag
on the land check is the bounded `acrossWaterNear(t, dm)` in every rule
(`acrossWater`'s depth-first fill calls a tile up our own coast "across water" on
a big landmass) and the early / sea-expansion rules try 48 / 30 candidates
instead of 16 / 10, because our own coast is near by water too. Boat lines carry
the sailed distance (`… 32 tiles by water`). Fires (one count per site per 100
ticks) when the launched candidate differs from the straight-line pick — the
same rule with the flag off, `boatsNearest` as configured — or when the cap
refuses a launch the straight-line ranking would have made.

_A first cut capped the fill at 40k tiles and read Infinity beyond it, as the
brief said; on an 8-minute africa empire the ocean shore is 125–160 sampled
tiles and the fill within 300 sails is 113–133k water tiles, so 40k was a
40-tile band and every candidate read Infinity: zero boats, rank 24 vs 2. The
fill is bounded by distance now and the tile budget is a safety._

**`boatsAfterCoast`.** `PlaybookBotExecution.coastFirst()`: no early boat and no
tribe boat (`huntBotsByBoat`) while free land is still reachable by land on our
own landmass — `sit.wilderness` (a border tile beside unowned land) or
`Situation.freeLandReachable` (the phase model's capped flood fill, now public)
— unless we started on a small landmass (`onSmallLandmass`, `islandMaxTiles`),
where the only way out is a boat. Sea expansion keeps its own
`wilderness && capShare < 0.4` gate; finishByBoat and seaInvasion are unchanged.
The early-boat window (`boatAtTick` … + 600) is not extended: when the coast
comes later the tribe and sea rules take over. Liveness: the suppressed rule is
dry-run (`BotContext.dry` — `boat()` reports the launch instead of making it,
`fire()` and the `FireLimiter` count nothing, `boatedAt` stays untouched) and
the flag fires once for the early boat (the old rule launches once) and per
tribe-boat pass the old rule would have launched on.

**Tests.** `tests/playbook/boats2.test.ts` on the world test map at
Bab-el-Mandeb: the fill — Arabia's Red Sea coast at (1172, 412) reads 32 both
ways, the Persian Gulf at (1238, 352) 274 by water vs 136 straight-line (round
the peninsula), the Mediterranean at (1106, 286) 148 either way; a tribe on the
Gulf alone gets the boat off (136 straight-line) and is refused on (the flag
fires); with a Mediterranean tribe too, off boats to the Gulf and on to the
Mediterranean, `129 tiles by water`; the early boat with `boatsNearest` off is
refused (the middle-tile scan's 80-tile pick sails more than 80) and with it on
goes to the strait shore at 32 by water without firing (the same pick); the
fill runs once per pass — one fill at tick 300, the same object 50 ticks later,
one fill for the tick-600 pass where tribe boats and sea expansion both run.
`boatsAfterCoast`: the Red Sea bank with free land behind it sends the early
boat at tick 60 off and none by tick 500 on (with a tribe across the strait; the
flag fires for the early boat and each tribe pass); a 1365-tile island start at
(1620, 438) still boats at tick 60. Golden unchanged; the 3-minute africa
transcript with `{}` is byte-identical before and after (only `botMs`/`gameMs`).

**Smoke** (`MIN=8 SPAWN=africa DIFF=medium`, one seed — not evidence):

| config | rank | share | boats | first boat | sailed (median / p90 / max) | botMs | fired |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{}` | 2 | 0.62 | 26 | t60, empty shore 64 straight-line | — (not logged) | 812 | — |
| `boatsNearest` + `boatsWaterPath` | 2 | 1.00 (leader) | 26 | t80, empty shore 52 by water | 26 / 187 / 193 | 1365 | boatsWaterPath 40, boatsNearest 19 |
| all four (`+ boatsAfterCoast, finishByBoat`) | 24 | 0.17 | 0 | none | — | 789 | boatsWaterPath 53, boatsAfterCoast 1 |

The all-four game is the finding: `boatsAfterCoast` held the early boat until
the free land ran out at t297, by when the 52-tile shore was taken; the only
early candidate left was 153 tiles off (refused), and from t600 every
sea-expansion candidate this landlocked-by-water empire could see was on the far
side of the continent — manhattan 150–490, Infinity by water — so it sat at
its cap (`idle at cap: Libya`) while the `{}` game boated hundreds
of tiles to Polish Army, Tang Dominion and India and took rank 2. Whether the
early stepping stone matters that much, and whether the 200-tile sea cap is too
tight for a big empire, is what the A/B is for; on this seed `boatsWaterPath`
alone is a clear win and `boatsAfterCoast` a clear loss. BFS cost: the flag adds
~550 ms over 48 fills (≈ 11 ms each, 113–133k tiles) to an 8-minute game —
`WATER_CACHE_TICKS` 200 would halve it if that matters.

**A/B:** `CONFIGS='{"base":{},"near":{"boatsNearest":true},"wp":{"boatsNearest":true,"boatsWaterPath":true},"coast":{"boatsNearest":true,"boatsAfterCoast":true},"all":{"boatsNearest":true,"boatsWaterPath":true,"boatsAfterCoast":true,"finishByBoat":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`.

## Irradiated land (`takeFallout`, 2026-08-30)

Josh: "the bot never takes irradiated land". Cause: `PlayerImpl.nearby()`
(line 532) hides unowned fallout tiles, so a bot whose only free land is
irradiated has `wilderness = false` and `expand()` returns before sending a
click. A TerraNullius attack does take those tiles — `AttackExecution` never
looks at fallout; `attackLogic` multiplies the loss by `falloutDefenseModifier`
(5 → 2.5 as the map's fallout share rises) and `GameImpl.conquer` clears the
fallout on capture.

With the flag on, `Military.expandOption()` sends the contested-share click
whenever `SituationQueries.falloutBordering()` (every 3rd border tile, cached
100 ticks) finds unowned fallout next to us and troops are ≥ fightAbove × cap —
idle troops cost nothing, and irradiated land at 2.5–5× the free-land price is
still cheaper than most wars per tile. Logs `FALLOUT expand: ~N irradiated
tiles …` every 600 ticks; fires per click. Tests: `tests/playbook/takeFallout.test.ts`.

A/B (removal form once on by default): `CONFIGS='{"base":{},"nofo":{"takeFallout":false}}'`.

## Bomb fund and war yield (`bombBudget`, `warYield`, 2026-08-30, branch `bot/bombs-yield`)

Josh, from the GUI: (1) the bot rarely saves for a bomb; (2) it never asks what
a push is returning. The 45-game data agrees: 1,071 atom bombs to 7 hydrogen
bombs, first bomb ~9:00 — `Economy.build` spends on cities and ports first and
`maybeBomb` buys whatever is left above `bombReserve` (250k); nothing measured
a war's return (waves are sized by ratio to the target's army), and 8,048
`war held: wants X, only Y spare` lines show the whole-war rule refusing waves
constantly. Two default-off flags and one always-on log line.

**`WAR RESULT` (always on, no flag).** Every war or tribe wave already opens a
calibration record (`noteWave`, the EST/ACT pair); the record now samples the
war every 100 ticks (`sampleYield`): the target's tile drop since the last
sample, credited to us in proportion to our attack's share of the troops
attacking it (all of it while ours is the only one; a final sample after ours
is gone uses its last troop count against whoever is still on the target), and
the troops the attack lost (its troop delta, the follow-ups merged into it
counted as sent). When the attack is gone or the target dead, every non-bot war
logs `WAR RESULT <name>: +T tiles, -L troops, X troops/tile, D s` — L = the
wave minus what came home (a recalled wave brings `RETREAT_MALUS` = 75 % of its
survivors), X = L / T (`inf` when no tile was taken), D in seconds. The
measured X is remembered per target (`yieldSeen`, when L ≥ 1000). This is the
accounting Josh asked for and the future scorer's training data; the golden
hash changed for these lines alone (a 3-minute africa transcript is
byte-identical after stripping them). The attribution is conservative: a war
beside other attackers gets only its share of the target's losses, and a target
that expands elsewhere while we hit it under-counts.

**`bombBudget`.** `Military.bombPlan(ticks)` (computed once per tick) is the
NEXT bomb we are saving for: with a silo owned, maybeBomb's target set
(`bombEnemies` — the war target, attackers over 5 % of our troops, Diplomacy's
planned target, the collapsed, the threats to a crown; when `endgameV2` gold
can never reach the MIRV price, the largest un-allied neighbour; idle at ≥ 90 %
of cap with no attack out, the neighbour with the most buildings we could take
at 1.2×) and maybeBomb's value search (`bombSearch`: the structure whose blast
covers the most building value per 100k of the bomb's price, never under a SAM,
32 tiles clear of friends, a Hydrogen only 105 clear on an owner of ≥ 8,000
tiles) run with the price ignored: a Hydrogen pick stands when 5M is within
`BOMB_FUND_HORIZON` = 900 ticks of income (an EMA of gold deltas per pass,
windfalls entering at ≤ 3× the running rate), else the best Atom. `Economy.build`
holds the plan's price (`bombFund`) out of every discretionary buy — the first
three city levels, ports past the first and port levels, rail, SAM level-ups
and the second SAM, warships, the spare-gold city — and out of the `buildSearch`
planner's gold; the hard overrides go first as before (a post where a non-bot
attack lands, the threat post, the first SAM, the silo, the cap-needed city at
`capFullShare`). With a plan the fund replaces the old flat 1M "bomb reserve"
of step 8 (the silo escrow stays on top). `maybeBomb` then buys the planned
bomb the pass gold covers it — no `bombReserve` add-on, and net of what
`build()` committed this pass (`Economy.spentThisPass`: the executions deduct
next tick, and the old rule could bomb with gold a post had just spent) — and
logs `BOMB FUND: saving Nk for Hydrogen|Atom at <target> (have Gk, +Ik/min)`
every 600 ticks while saving, at once when the plan changes. Fires (one count
per site per 100 ticks) when the fund alone defers a buy the chain would have
made, and on every bomb bought that the old rule would not have afforded
(gold < price + reserve). Bomb prices are flat (`Config`: atom 750k, hydrogen
5M; only the MIRV escalates, 25M + 15M per launch on the map). Off, the
maybeBomb path is the same code composed the old way (byte-identical).

**`warYield`.** (a) `manageRetreats`: a running non-bot, non-counter war whose
cost over the last two samples (200 ticks, ≥ 1,000 troops lost;
`Military.runningCost`) exceeds `yieldMaxTroopsPerTile` (new param, default
120 = 6× free land's ~20 a tile) comes home — unless the target is collapsed,
annexable (`annexWars`) or the gap owner, where the tiles are the point — with
`YIELD retreat from <name>: X troops/tile (Nk left)`; the target is then
refused by the scorer for `YIELD_COOLDOWN` = 600 ticks unless it becomes an
opportunity (without it the sticky target re-declared the same war the pass the
wave was home — the test caught it). Fires per retreat. (b) The war scorer adds
`4 × clamp(1 − expectedCost / yieldMaxTroopsPerTile, 0, 1)`, expectedCost =
the target's last measured troops/tile against us (`yieldSeen`), else its
troops/tiles density × 1.3 — `Config.attackLogic`: `altAttackerLoss = 1.3 ×
defenderTroopLoss × (mag / 100) × traitorMod` with `defenderTroopLoss =
defender.troops() / defender.numTilesOwned()` and mag 80–120 by terrain (×5
under a post), 40 % of the per-tile loss; the other 60 % is the
`within(defender/attacker, 0.6, 2) × mag × 0.8` term that does not depend on
density. Fires when the bonus changes the pick.

**Tests.** `tests/playbook/bombBudget.test.ts` (big_plains with the production
blast radii — `PlaybookSetupOptions.realNukes`, a new harness option; the
1-tile TestConfig blast never covers two buildings): with a silo, R as the war
target and 900k, off buys three city levels and never bombs; on buys the first
city out of what is above the fund and the atom in the same pass (fires: the
old rule wanted 1M), then holds the second city for the next fund; at 500k on
logs `BOMB FUND` (again 600 ticks later), buys nothing, and bombs the pass the
fund is covered; a 16-city cluster on a 29k-tile neighbour plans the Hydrogen
at 4.95M with income measured (nothing else bought, the bomb goes ~500 ticks
later) and the Atom pair at 1M; an incoming attack gets its post before the
fund and the bomb waits for the 50k. `tests/playbook/warYield.test.ts`: a
3-wide L-shaped neck of 720 tiles held at its troop cap under two posts (~700
troops a tile, no literal rule fires for 200+ ticks) — off ends with WAR RESULT
at > 120/tile and no YIELD; on retreats with the YIELD line after ≥ 200 ticks,
fires, logs WAR RESULT and stays home; the same neck held by 12k troops (~35 a
tile) runs to the end; of two identical neighbours the scorer avoids the one
whose tiles measured 300 last time. Golden regenerated for the WAR RESULT lines
(the only diff).

**Smoke** (`MIN=12 SPAWN=africa DIFF=medium`, one seed — not evidence):

| config | rank | tiles | bombs (atom / hydrogen, first) | WAR RESULT n / median troops/tile | YIELD retreats | botMs |
| --- | --- | --- | --- | --- | --- | --- |
| `{}` | 1 (leader, 141,786 tiles) | 141,786 | 8 / 0, first t4480 | 37 / 104 (10 wars at `inf`: no tile credited) | — | 1,592 |
| `bombBudget` | 3 | 79,394 | 8 / 0, first t4520 | 29 / 118 | — | 1,333 (fired 21) |
| `bombBudget` + `warYield` (120) | 12 | 18,828 | 0 (no silo ever bought) | 6 / 141 | 1: Ireland at t1980, 238/tile, 76k left | 837 (fired 1) |
| `bombBudget` + `warYield` at 250 | 7 | 39,232 | 3 / 0, first t6310 | 17 / 190 | 2: Latvia 401/tile, Ireland 299/tile | 919 (fired 2) |

The finding is the `warYield` row: the one yield retreat — from Ireland at
t1980, 238 troops/tile with 76k of a 631k wave left — is a war the `{}` game
finished 30 ticks later (`WAR RESULT Ireland: +2415 tiles, -561813 troops, 233
troops/tile`) on its way to the crown; the recalled wave met Ireland's counter,
the game went defensive (11 pieces by t3000) and never bought a silo. At 250
the same seed still loses two wars it would have won. The measured prices in
the winning `{}` game (median 104, the decisive wars 140–270 a tile) say the
brief's 120 is below what a winning push costs on Medium; the A/B should carry
`yieldMaxTroopsPerTile` 250–400 alongside 120, and the rule should probably
spare a wave that is nearly spent (the retreat malus on 76k is cheaper than the
233/tile it was still paying, but the tiles were about to fall). `bombBudget`
alone: the same 8 atoms (the first 40 ticks later), 21 deferrals fired, rank 3
vs 1 on this seed — the fund held city levels the leader bought; no cluster
qualified for a hydrogen (≥ 8,000 tiles and 105 clear of friends: on africa
the neighbours are allies or small). The income EMA reads 8–11M/min late in
the game (trade-ship lumps every pass, each clipped at 3× the running rate but
compounding), so any hydrogen cluster that qualifies will be planned; harmless
here, worth a cap if hydrogen plans start starving the economy. botMs are
wall-clock under parallel runs.

**A/B** (both flags, then each alone; the removal form once on by default):
`CONFIGS='{"base":{},"bb":{"bombBudget":true},"wy":{"warYield":true},"wy250":{"warYield":true,"yieldMaxTroopsPerTile":250},"both":{"bombBudget":true,"warYield":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`
— removal form: `CONFIGS='{"base":{},"nobb":{"bombBudget":false},"nowy":{"warYield":false}}'`.

## War ROI cap (`warRoiCap`, 2026-08-30, branch `bot/war-roi`)

**Removed 2026-08-31 (branch `bot/prune`; the code lives in git history, last at 38219433a).**
A per-target realized troops-lost-per-tile EMA that retreated and blacklisted dear wars. fix1 (120 mirrored
full games): 70 wins vs base 78, McNemar p=0.33, SPRT CONTINUE −0.16 — leaning harmful (warRoiMax 500
likely too aggressive, but the mechanism never earned its complexity). Deleted with
warRoiMax/warRoiMinTiles/warRoiWindow/warRoiCooldown, the ROI bookkeeping in Military and its tests.
warYield (the same signal as a scorer bonus + running-cost retreat) stays a flag.

## CMA-ES race over the neutral flags' constants (2026-08-30, `lab-out/cma-neutral`, `lab-out/cma-confirm`)

`cmaes.py --spec scripts/lab/specs/neutral-flags.json --fixed '{utility, threatMap, buildSearch, retaliateAware, drainedNations, relationAware, hystRetreats on; est scales 0.868/0.719/1.285}' --pop 14 --gens 8 --race`, 4× cpx62, ~11 min per generation, ~2,900 games. The tuned flags-on mean beat base in 6 of 8 generations (30 mirrored games each: +0.10, +0.17 (p=0.016), +0.14, −0.02, +0.08, +0.20, −0.11, +0.09); the base changed at generation 4 when ac86780e6 flipped the five boat/annex/multiwar flags on.

Confirmation (SPRT + MIRROR, 20-min Medium, 68 mirrored pairs vs the ac86780e6 base): m4 (mean after gen 4) **45W/23L, dScore +0.209 [+0.069, +0.348], p=0.010, decisive win**; m8 (final mean) 42W/26L, +0.195 [+0.039, +0.359], p=0.068; m5 (mean after gen 5) 34/34, +0.04 — a cliff between neighbouring constants (fightMaxShare 0.79 with fightAbove 0.49 over-commits). Crowns 41 vs 26, median tiles 246k vs 110k. m4 constants: {"expandContested": 0.1057, "expandFree": 0.0826, "botRatio": 1.8723, "botClickCap": 0.2966, "fightAbove": 0.4927, "fightMaxShare": 0.7314, "reserveShare": 0.3525, "capFullShare": 0.599, "bombReserve": 356782, "railSpacing": 18, "utilCapMid": 0.9458, "utilCapSteep": 13.3553, "utilCommit": 1.6947, "utilFreeLandCost": 18.2376, "utilScoreFull": 15.2896, "threatReserveGain": 3.531, "threatBusyWeight": 2.6165, "threatVulnWeight": 2.1101, "threatPreRatio": 1.3274, "buildCapGoldPerTroop": 13.7695, "buildHorizon": 7549, "retalRatio": 1.2063, "drainRatio": 1.65, "drainBelow": 0.3805, "hystMargin": 0.1814, "hystSlope": 0.2642, "hystStrikes": 2}

Lesson (restating ab1): the same seven mechanisms were noise at hand-picked constants and +0.2 tuned together — tune flag-on before judging a flag. Final gate before flipping defaults: m4/m8 vs the d8b8c89cc defaults (`lab-out/final`).

**m4 was found on 20-minute games.** The objective is winning full games, and the 20-minute score is only a proxy (games are decided late — see the early-stop analysis). Before m4's constants become defaults they need the full-game gate: `CONFIGS='{"base":{},"m4":{…}}' SPRT=1 MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh`, judged on `summarize.py`'s `wscore` / paired WIN line (docs/PlaybookBotLab.md, "Full games and win scoring"). A CMA campaign on the full-game objective (`cmaes.py --minutes full`, ~8× the cost per game) is the follow-up if the gate fails.

## Exploiting the nations' MIRV rules (`nationMirvAware`, `MirvRisk.ts`, 2026-08-30, branch `bot/mirv-aware`)

Josh, watching the GUI: "the bot still triggers MIRVs a lot — check it exploits
nation behaviour, it should." A nation fires a MIRV
(`NationMIRVBehavior.considerMIRV`, every attack tick, after a silo, the live
MIRV price — 25M + 15M per launch on the map — and a 1-in-4 hesitation on
Medium) for exactly three reasons, in this order, each with a 300-tick per-target
cooldown shared by every nation: **counter** (one of ours is inbound at a tile
it owns), **victory denial** (our share of `numLandTiles` ≥ 0.65 Medium / 0.55
Hard / 0.75 Easy / 0.4 Impossible; team share ≥ 0.8 / 0.7 / 0.9 / 0.6 at the
largest member) and **steamroll** (we lead the city ranking with > 10 units
(Easy 20, Impossible 8) at ≥ 1.5× (Medium; 1.25 Hard, 2 Easy, 1.15 Impossible)
the runner-up's count). Two things were wrong with how the bot modelled that:

1. **The rule counts city LEVELS.** `selectSteamrollStopTarget` reads
   `Player.unitCount(City)`, and `PlayerImpl.unitCount` sums `unit.level()` — a
   level-3 city is three units to it. `Economy.cityUnitCap` compared our
   unit count (`units(City).length`) to the runner-up's level sum and its
   comment promised "cap comes from city levels, which the rule does not count".
   A crown with 12 cities levelled to 3 reads 36 against a field of 14. The
   flag-off cap is left as it was (baseline fidelity); the flag reads the real
   count, and the comment is corrected.
2. **The crown MIRV asks for a counter.** 5 of the 6 lab launches were the 25:00
   "crown" MIRV at the largest un-allied player above us; a nation with a silo
   and the price answers it with its own within the tick (rule 1), so the launch
   was a trade of one MIRV for two.

Also found: cities captured in wars (`UnitImpl.setOwner`) push the count over
the line with nothing reacting; in hold mode a war on a threat can carry the
share past the denial line.

**Always-on diagnostics (`MirvRisk`, no flag).** Every 100 ticks the three
rules are evaluated against us exactly as a nation would (`MirvRisk.steamroll` /
`denial` / `counter`, the thresholds in `mirvRules(difficulty)`), plus who could
actually fire (a Nation, not on our team, with a silo and either the live price
or a MIRV unit — `considerMIRV`'s own gates). The log gets one line per change
of the risk state (`MIRV RISK steamroll: 12 city units (levels) vs 10.5 (7 ×
1.5, leader > 10) — 1 nation can fire (R)`, `MIRV RISK denial: share 65.4 % vs
65 % — …`, `MIRV RISK counter: our MIRV is inbound at …`, `MIRV RISK clear: …`);
nothing is logged while the state stays the same, so the golden hash is
unchanged (big_plains vs three small nations never enters a rule). Every 10
ticks enemy MIRV units are scanned: one aimed at a tile we own logs `MIRVED by
<name> (<rule true at that moment>, <n>th)` once per unit and counts in
`bot.mirvsTaken`, which the lab FINAL line carries as `mirvsTaken=` (one
append-only field).

**`nationMirvAware` (default off).**

1. *Crown MIRV only at a target that cannot counter.* `MirvRisk.canCounter(p)`
   = a silo and (the live price or a MIRV unit). Of the candidates (un-allied,
   > 0.8× our tiles, largest first) the first that cannot counter gets it; when
   every candidate can, the launch is held and `MIRV held: <name> can counter`
   is logged once per 600 ticks. The counter of an inbound MIRV, the victory
   denial launch and the finish-mode launch at the richest threat are unchanged.
2. *Steamroll guard.* `near` = units ≥ 0.9 × (mult × runner-up) and > minLeader
   − 1, evaluated on the level sum. While `near` and a nation is **armed**
   (`MirvRisk.armed()`: it can fire, or has a silo and at least half the live
   price — the first 30-min smoke with the gate on "can fire" showed why:
   `MIRV RISK … 1 nation can fire (Türkiye)` at t7800 and `MIRVED by Türkiye`
   at t7810; a nation fires the tick it reaches the price, so a guard that
   waits for that is ten ticks too late):
   (a) `Economy.build` buys no new city **and no city level** (levels count —
   the planner's `cityLevel` too); (b) SAM cover for every city unit is the top
   discretionary buy: a SAM under level 3 is levelled first (range grows with
   level, `Config.samRange`), then a launcher beside the uncovered city whose
   level-1 umbrella covers the most of the others (`Economy.samCoverTile`, 300
   ticks between launchers); its price is escrowed out of every discretionary
   buy exactly as the bomb fund is (`fund = bombFund + samFund` in `spare()`,
   `spareR()`, the rail budget and the planner's gold), the hard overrides
   (posts under attack / vs a threat, the first SAM under an enemy silo) still
   go first; `STEAMROLL LINE: <units> vs <threshold> — SAM cover <k>/<n>
   cities` every 600 ticks; (c) the war scorer refuses (−1) a target whose city
   units would carry us over the line with it out of the ranking
   (`MirvRisk.steamroll(extra, without)`) unless it is the only MIRV-capable
   rival or an opportunity (collapsed / gap owner / threatHere / annexable, which
   return before the guard); `no war on <name>: its N cities would carry us
   over the steamroll line (13 vs 12)` once per 600 ticks per target. The
   same armed gate applies to (a)–(c); the diagnostics line reports both
   (`1 nation can fire (X), 2 saving (Y, Z)`).
3. *Denial guard.* In hold mode (and push with a threat left) the scorer
   refuses a target whose tiles would carry our share to ≥ denial − 0.01 unless
   it is the last threat (taking it ends the hold). Counters and tribes are
   untouched (they do not go through the scorer).

Every guard fires through the `FireLimiter` per site (`crown`, `cap`, `sam`,
`steamroll`, `denial`, the escrow sites).

**What `NationNukeBehavior` retaliates to** (atom / hydrogen, `maybeSendNuke`
every attack tick once the nation has a silo): the target is, in order — on
Hard/Impossible with two players left, the other one; **the largest incoming
non-bot, non-friendly attack's owner** (`AiAttackBehavior.findIncomingAttackPlayer`
— the retaliation, "most important"); on Impossible, the richest nation hunts
the densest structure owner (level sum / tiles > 1/75); on Impossible FFA the
crown over 50 % of the fallout-free land; any player its allies have
`target()`ed; the most hated (`Relation.Hostile`) player unless the nation's
max troops are ≥ 2× theirs; in FFA the crown whose share exceeds its own by
0.3 (Medium; 0.4 Easy, 0.2 Hard, 0.1 Impossible); in teams the strongest team.
Tribes are never nuked, nor teammates, and on Medium `shouldAttack` drops a
human target 1 time in 4. The nuke goes only if the gold covers the *perceived*
price (the real price × 1.5 per atom / 1.25 per hydrogen already launched —
"saving for a MIRV" — waived with two players left, with MIRVs disabled, in
team games above the hydrogen price, with a MIRV + hydrogen in the bank, or on
Hard/Impossible under an attack ≥ its own troops); a third of nations throw
hydrogens only unless under heavy attack. The tile is the best-scoring of ten
random tiles plus every structure (city 25k, silo 50k, port/factory 15k, post
5k per level, minus 30 per tile of distance to its nearest silo, keeping at
least 20 %); on Easy/Medium every tile inside the blast must be the target's
own (no border shots), on Medium a SAM within 50 tiles voids the tile, on
Hard/Impossible the trajectory must clear every enemy SAM's range. So: **a
war wave that is the largest attack a nation is under makes us its nuke target
for as long as the wave runs**, and being the crown by 30 % of the map on
Medium makes us every unallied nation's fallback target.

**Tests** (`tests/playbook/mirvAware.test.ts`, 13): the steamroll line with its
numbers and a level counting as a unit, a silo + 30M turning "nobody can fire"
into "1 nation can fire (R)"; a real Medium `NationExecution` with a silo and
60M launching at a 12-vs-7 leader within 1500 ticks (`MIRVED by N (steamroll,
1st)`, once per unit, `mirvsTaken` 1); the crown MIRV at 25:00 fired flag-off,
held (`MIRV held: T can counter`, no MIRV unit) flag-on against a silo + 30M
target, fired against a silo-less one; near the line (11 vs 12, N can fire)
flag-off buys a city level, flag-on logs `STEAMROLL LINE: 11 vs 12 — SAM cover
3/11 cities` and buys `level SAM → 2`, `→ 3`, `build SAM` with no city level;
the escrow (at 2:30 with the rail line wanting its factory, 2M buys only the
threat post while a SAM costs 3M, off buys the factory; at 12M the SAM precedes
the factory); the war target with 2 cities skipped (`13 vs 12`, off attacks
it); in hold mode at 62.5 % the crossing threat refused and the other fought,
then fought as the last threat once the other is dead, and fought at once when
it is the only threat. Golden unchanged; flag-off `MIN=3 SPAWN=africa
DIFF=medium` transcript byte-identical after stripping `MIRV RISK` / `MIRVED`
lines and the `mirvsTaken=` field.

**Smoke** (`MIN=30 SPAWN=africa DIFF=medium`, one seed — not evidence):

| config | rank / tiles | troops / cap at 30:00 | city levels | SAMs | our MIRVs | `mirvsTaken` (rule) | fired |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `{}` | 1 / 330,362 | 15.0M / 34.4M | 121 | 15 | 0 | 3 (steamroll ×3) | — |
| `nationMirvAware`, gate "can fire" | 1 / 329,835 | 49.4M / 90.7M | 346 | 15 | 0 | 3 (steamroll ×3) | 9 |
| `nationMirvAware`, gate "armed" (shipped) | 1 / 334,661 | 51.4M / 64.0M | 239 | 80 | 0 | 4 (steamroll ×4) | 144 |

What the diagnostics say about the baseline: the first `MIRV RISK steamroll`
line is at t5700 (27 levels vs 22.5) with nobody able to fire; by t7800 the
bot is at 101 levels vs 37.5 — nearly 3× the line, all of it city levels bought
for troop cap while no nation had a silo and 25M — and Türkiye fires the tick
it reaches the price (t7800 → t7810). Every MIRV in all three games was the
steamroll rule; no crown MIRV of ours was ever affordable on this seed (the
price climbs 15M per launch), so guard 1 did not come up, and the share never
reached the denial line, so guard 3 did not either. With the "armed" gate the
war guard refused 15 city-rich targets, SAM cover went from 21/39 to 75/83
cities, and the level sum still climbed from 42 to 180 in the windows where no
nation had a silo and half the price — a line crossed with levels cannot be
un-crossed, and captured cities keep adding. The open question for the A/B is
the economic one this smoke cannot answer: holding the level sum under 1.5×
the runner-up's for the whole game (a `steamrollCap` on the level sum, no gate)
costs most of the city-level troop cap; letting it climb costs a MIRV every
time a nation reaches 25M. Run as `CONFIGS='{"base":{},"nma":{"nationMirvAware":true}}'`
with `mirvsTaken=` in `summarize.py`, and read the `MIRV RISK` lines of the
base games first: if every MIRV taken is `steamroll`, the level-sum cap is the
next package.
## Full-game gate of the CMA-tuned constants (2026-08-30, `lab-out/full1`) — NOT graduated

Objective changed to winning full games (Josh, 2026-08-30): `MINUTES=170`, the loop stops on `getWinner()`, summarize.py scores `wscore` = score + 1 per win (d0deb3ccd). Games end at 18–73 sim-minutes, ≈4× a 20-min game.

base (d8b8c89cc defaults) vs m4, 36 mirrored full games each: **base wins 19/36 (53 %), m4 wins 9/36** — pairs base-only 14 / m4-only 4 / both 5 / neither 13, McNemar p=0.031; m4 dwscore −0.53 [−1.01, −0.03], median tiles 115k vs 448k. The 20-minute-tuned constants (fightAbove 0.49, fightMaxShare 0.73, reserveShare 0.35 …) win the land race and lose the game. `bot/tuned-defaults` (8c7c23b39) is kept as a branch for reference and must not be merged.

Lessons: (1) a 20-minute score is a screen, never a graduation — the same config was +0.21 (p=0.010) at 20 min and −0.53 on wins; (2) re-run the CMA race with `--minutes full` and the wscore objective before trusting any constant; (3) the version-history ladder (run 1) is 20-minute and needs a full-game run 2.

## `rm1` — removal A/Bs of the eight default-on flags, full games (2026-08-30, `lab-out/rm1`)

96 mirrored full games per config on head 937640535 (5× cpx62 IPv6 pool), scored on wins (wscore). Removing a flag and WINNING MORE means the flag was hurting.

| removed | wins (base 48/96) | McNemar p | verdict |
|---|---|---|---|
| finishByBoat | 21 | <0.001 | **keeper — carries the win rate** (removal: 50 % → 22 %) |
| boatsNearest | 40 | 0.28 | keeper (probable) |
| multiWar | 43 | 0.57 | mildly positive, keep |
| takeFallout | 50 | 0.87 | no measurable effect |
| annexWars | 52 | 0.66 | no measurable effect |
| steamrollLevels | 52 | 0.61 | no measurable effect |
| lapseToAttack | 54 | 0.35 | leaning harmful |
| boatsWaterPath | **63** | **0.032** | **harmful — flip back off** (removal: 50 % → 66 % wins) |

Base wins 50 % of full games on this grid. Actions (pending Josh): revert the boatsWaterPath default; consider pruning annexWars/takeFallout/steamrollLevels/lapseToAttack for simplicity or re-testing at tuned constants.

Caveat (2026-08-30): 13 (batch, region) slot groups of this grid collapsed onto one spawn tile — 17 of the 96 base games were replicates (96 files = 79 unique games; `loss_analysis.py` REPLICATES over `lab-out/rm1`). Cross-region: the picker's staged 250→400-tile search re-found the same best tile from different shifted centres (med5b/med8b africa == australia at 1569,681; med2b east-asia == north-russia at 1611,261; med6 north-america == south-america at 522,267; …). Same-region: the rank walk's restart-with-smaller-radius re-found a lower rank's tile (med5/med9 africa at 903,480; med2/med7 australia at 1458,396). The rm1 numbers above stand as measured (both sides of every A/B played the same collapsed grid, so the pairing is intact — the effective sample is 79 scenarios, not 96). Fixed for later sweeps in `src/core/lab/LabReplay.ts` `pickLabSpawn`: each region is vetoed outside its own Voronoi cell (closest shifted centre wins) and the rank walk is one canonical sequence per region — verify with `node --import tsx tests/lab/spawn_dedupe.lab.ts`.

## Why we lose full games (2026-08-30, loss_analysis.py over rm1's 96 base games)

Outcomes: 48 won · 37 alive-but-lost · 4 died · 7 hit the cap (6 as rank 1). Caveat: 13 file groups share one spawn (region labels collapsed onto the same spot) — 96 files = 79 unique games; dedupe the spawn slots before the next sweep.

Loss clusters (41): **MIRVed down after leading — 19** (steamroll rule in 80 of 85 MIRVED-by lines; the bot's own `MIRV RISK steamroll` detector fires minutes earlier, then the game builds ~3 SAMs); **lost the endgame race at rank 2–3 — 13**; **plateaued behind a runaway — 5**; died 4. Losses peak at 33 min (wins at 61) holding 0.3 of peak; the 10-minute states of wins and losses are nearly identical — games are decided in the mid-game. Wins average 27 silos/97 SAMs vs 6.8/12 in losses. War efficiency is similar; the failure is growth stalling + MIRV exposure, plus no leader-contest behaviour (a rank-3 bot spends the last 5 minutes boating a 1,500-tile weakling while the leader closes to 80 %).

Ranked proposals (each a default-off flag + full-game A/B): 1) `samOnRisk` — on `MIRV RISK steamroll`, divert gold to a SAM wall + counter-silos (touches ~half the losses); 2) `contestLeader` — rank ≤ 3 with a runaway leader → boats/nukes at the leader, not "weak X"; 3) `plateauBreak` — <5 % tile growth over 5 min while rank > 1 → forced cross-water expansion or war on the largest adjacent non-ally; 4) `warRoiCap` — abort wars beyond ~500 troops/tile realized; 5) `webDefense` — ally/post against a mutual-ally border web before 10:00. Script: scratchpad loss_analysis.py (re-run on every sweep).

## Web defence (`webDefense`, 2026-08-30, branch `bot/web-defense`)

**Removed 2026-08-31 (branch `bot/prune`; the code lives in git history, last at 38219433a).**
Detection of a mutual-ally border web before 10:00 (ask the likeliest member, post against every member,
reserve reads the web's combined sendable). fix1: 78 wins vs base 78 with **1 live pair in 120 games** —
the situation it defends against effectively never occurs since the boatsWaterPath revert; SPRT REJECT.
Deleted with webRatio/webUntil, Situation.web and its tests.

## Contest the leader (`contestLeader`, 2026-08-30, branch `bot/contest-leader`)

Loss cluster 2 above (13/41 rm1 losses ended rank 2–3 while the winner ran away — p_base_med2b_australia.txt spends
its last minutes boating 1,500-tile weaklings and finishes `rank=3 share=0.08 winner=other`). `Situation` now keeps,
on the existing 100-tick rank cadence plus a 300-tick tile sample for the trend, the leader by tiles among non-bot
players. The contest is on while our rank ≤ `contestRank` (3), the leader is not us / a friend / a teammate, its
tiles exceed `contestLeadRatio` (1.5) × ours, and its last two samples rose — a leader that stopped growing is
contained, not contested. While on (`sit.contest`; `CONTEST leader …` / `CONTEST over` logged on entry/exit):

- `seaExpansion` re-aims the boat it was about to send at a "weak X" / tribe candidate at the leader's ocean shore
  (its ports/cities coastline preferred — `Military.contestShore`), same wave and same distance / across-water
  gates; a collapsed follow-up or a free-shore boat keeps its target. `huntBotsByBoat` does the same with its tribe
  boat (900-tick per-leader cooldown through `boatedAt`).
- `maybeBomb` puts the leader on the enemy list like a threat (the value search still does the prioritising, so
  range and affordability keep their say); `maybeMIRV` takes the leader as a priority target with no 12000-tick /
  0.8×-tiles gate beyond the contest state itself, and keeps `nationMirvAware`'s never-at-a-counterer rule when
  that flag is on.
- The war scorer adds +4 (the planned-target weight) on the leader when it borders us; every gate stays.

No new troop spending: targets are redirected, sizes and budgets are the rules' own. Fires (`contestLeader`) on a
redirected boat, on a bomb/MIRV pick only the flag put on the list, and on a war pick the +4 changed.
Tests: `tests/playbook/contestLeader.test.ts`. A/B (full games — the cluster is an endgame failure):
`CONFIGS='{"base":{},"cl":{"contestLeader":true}}' MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh`.
## Aggressive multi-boat opening (`boatOpening`, 2026-08-30, branch `bot/boat-opening`)

Josh's request: open with several boats, not one. While `tick < boatOpeningUntil` (3000) the early-boat rule keeps
up to `boatOpeningCount` (2, int) transports alive at once instead of the single 20 % boat: whenever fewer of our
transports are at sea, an extra boat goes through `Military.earlyBoat`'s own picker (no new scorer — the tribe 2×
ratios, empty-shore scan, boatsNearest/boatsWaterPath ranking and the across-water launch check are all reused)
with two opening adjustments — an open shore on a landmass we own no tile of is preferred (a bounded 1500-tile
flood fill from the candidate; +200 ranking tiles on our own landmass — the second-continent beachhead), and every
boat is capped at `boatShare` of home (a tribe whose 2× wave would not fit is skipped). The reserve, the hold and
finish gates and boatDedupe still apply (extras go through ctx.boat); the plain first boat, its `boatSent`
bookkeeping, huntBotsByBoat and seaExpansion are untouched (their boats count toward the opening's cap of live
transports), the other boat flags' liveness counters are not polluted by extras, and the flag is inert on a small
landmass (`onSmallLandmass` — the island spawn's plain rules already boat continuously). After `boatOpeningUntil`
the normal rules resume unchanged. Each extra launch logs `BOAT OPENING n/count out → …` (the fire site: a boat
the plain rules would not have launched this tick) and fires `boatOpening` via the FireLimiter.
Params: `boatOpening` (default off), `boatOpeningCount` (int 2), `boatOpeningUntil` (int 3000).

**v2 (branch `bot/boat-opening-v2`)** — two flaws Josh saw in the GUI, fixed inside the same flag (flag-off
byte-identical): the opening picker (1) ignored how much free land sat behind a landing (it boated to the nearest
scrap over a big wilderness mass slightly farther) and (2) landed on the far side of a landmass that was just
across a tiny gap (the boatsNearest 10-tile floor skipped the near shore). Now the head of `earlyBoat`'s candidate
list (opening mode only) is deduped to one candidate per landmass — a bounded flood labels each candidate's mass
(1500 tiles, the old onOurLandmass fill, which now also reports "ours") and only the min-sail shore of each mass
survives — then scored `basin / max(sail, 20)`: basin = unowned land reachable from the landing
(`Situation.basin`, the spawn picker's flood, radius `boatBasinRadius` (int 100), cap 8000, cached per candidate
tile for the whole opening), sail = the water-path length with `boatsWaterPath` on, else the straight-line
distance. The second-continent preference became a ×1.5 score multiplier (`OPENING_NEW_MASS`), not a veto, and in
opening mode the empty-shore floor drops to 2 tiles so a tiny-gap crossing to a big basin can be the top pick
(the across-water launch check still refuses anything land-reachable). Every existing gate stays (reserve,
boatShare cap, across-water, hold/finish, boatDedupe); the BOAT OPENING log line now ends `basin=… sail=…`.

Josh's World-spawn addendum (same flag): (a) the near-shore dedupe keys on the landing tile's landmass — one
candidate per (mass, shore-or-tribe) at min sail; (b) **tribe masses are first-class opening targets**: a tribe
candidate scores `OPENING_TRIBE_WORTH (0.5) × tiles + basin`, ×`OPENING_CONTESTED (1.5)` when a rival borders the
tribe (its wilderness is getting eaten either way), with the existing 2× beach sizing and boatShare skip; (c) a
landing whose free land a tribe ate before the wave finished is **pushed, not stranded** — the transport's wave
targets the launch-time owner (terra nullius) and fizzles on a now-tribe shore, so each opening landing is watched
600 ticks (`Military.openingPush`) and the tribe owning/bordering the beachhead is clicked like harvestBots would
(botRatio + 500 in total, botClickCap of home now, one wave per tribe — but no botMaxShare/concurrency gate: the
boat is already committed over there), logged `BOAT OPENING push → tribe …` and fired via the limiter.
Tests: tests/playbook/boatOpening.test.ts (Bab-el-Mandeb fixture: two boats out by t200, one on the other
landmass; plain sends one; extras stop at the cutoff; an inert opening is log-identical to plain; v2 — a big
wilderness mass beats a nearer small basin, the near shore of a tiny-strait island beats its far coast, a big
tribe mass beats a small contested free basin, and a tribe that eats the landing gets clicked from the beachhead).
A/B: `CONFIGS='{"base":{},"x":{"boatOpening":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`
Watch it in the GUI: `localStorage.playbookParams = '{"boatOpening":true}'` then load `?bot=1` (PlaybookBotGUI.md).

**v3 (branch `bot/boat-opening-v3`)** — three refinements from Josh's v2 GUI session ("the boats are really
excellent now"), all inside the same flag, flag-off byte-identical:

1. **Don't target wilderness that will be gone before the boat lands.** The basin flood
   (`Situation.basinContact`) now also counts the owned land tiles on the basin's perimeter — the eaters —
   and a candidate's worth is `max(0, basin − boatEatRate × contact × sail)`; the transport sails 1 tile/tick
   (`TransportShipExecution.ticksPerMove`), so sail = arrival ticks. `boatEatRate` (0.02) was measured, not
   guessed: over t100–3000 of one Medium lab game, tribes expand a mean 0.0244 (median 0.0168) and nations
   0.0228 (median 0.0125) tiles per tick per border tile. Tribe tiles are never discounted (tribes get eaten,
   they don't evaporate), so a soon-to-be-eaten free basin beside a tribe mass tilts the pick toward the tribe
   itself. A basin the eaters will have consumed entirely before arrival (discounted worth 0) is dropped
   outright, not merely down-ranked — the extras hold the boat rather than feed a doomed crossing, and a later
   pass re-scans. The basin cache now refreshes every 100 ticks (contact grows as rivals close in) and the
   BOAT OPENING line ends `… eta=… eaten=…`.
2. **Tribes weigh more.** The tribe-tile coefficient is `boatTribeWorth` (1.0, CMA-tunable; v2 hardcoded 0.5,
   which Josh judged a systematic undervaluation) — a mid-size tribe mass now beats an equal-size contested
   wilderness; ×OPENING_CONTESTED (1.5) with a rival adjacent is unchanged.
3. **Cross the ocean before warships appear.** Nations build their first warship once they have a port, no
   warship yet and 250k gold (1-in-50 chance per attack pass, NationWarshipBehavior via NationExecution);
   measured on Medium: first enemy port t1060, first enemy warship t1730. While `tick < boatOceanUntil`
   (int 1500) the opening extras may sail up to the full BOAT_MAX_PATH (250; otherwise the 80-tile early cap),
   and a new-landmass candidate whose sail exceeds that early cap scores ×`boatOceanBonus` (1.3) on top of the
   ×1.5 second-continent preference. The plain first boat, wave sizes (boatShare cap) and every other gate are
   unchanged; after the window, long crossings fall back to v2 behaviour.

Params: `boatEatRate` (0.02), `boatTribeWorth` (1.0), `boatOceanUntil` (int 1500), `boatOceanBonus` (1.3) —
all appended to scripts/lab/specs/wins.json for the CMA (validated with `cmaes.py --dry-run`).
Tests: v3 block in tests/playbook/boatOpening.test.ts (an eaten-out basin at long sail loses to the nearer safe
pick and wins with the discount off; boatTribeWorth 1.0 picks the tribe mass where 0.2 picks the equal
contested wilderness; the ocean window lifts the sail cap before boatOceanUntil and not after).
A/B: `CONFIGS='{"base":{},"x":{"boatOpening":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

**v4 (branch `bot/boat-opening-v4`)** — the arctic magnet, from Josh's east-asia World GUI session ("one point
far to the arctic north always gets picked, wasting a lot of boat time"). Lab repro (east-asia + north-russia,
Medium, flag on): the far north coast of our OWN 225k-tile Eurasian mainland — same mass as the spawn by an
unbounded flood — saturates the 1500-tile landmass fill, reads as a NEW landmass and collects ×1.5 × ×1.3 ≈
×1.95 every pass; with contact ≈ 0 up there the v3 ETA discount never touches it while every temperate
alternative is eaten down, so the arctic coast is re-picked all game (6+ far-north BOAT OPENING lines per game,
plus repeated pushes for the same eaten landing, plus a junk tail of basin<200 empty shores at sail 140+ once
good targets are taken — basin=5 sail=142 was launched). Three changes inside the same flag, flag-off
byte-identical:

1. **No second-continent bonus on a mass the fill cannot finish.** `Military.landmass` now reports `capped`;
   the ×OPENING_NEW_MASS and ×boatOceanBonus multipliers apply only to a fully-enumerated mass with no tile of
   ours (a genuine islet/small mass). A cap-saturated fill is treated as "not new" — it is almost always our own
   mainland's far coast; it stays a target, but wins on real worth or not at all (v2 deliberately chose the
   opposite reading; the magnet proved it wrong).
2. **Long crossings pay their way, and junk holds the boat.** A candidate's worth is charged
   `boatOpeningSailCost` (8) per sail tile beyond BOAT_MAX_PATH.early (80) — troops locked at sea, growth
   deferred — and an EMPTY-SHORE candidate below `boatOpeningMinScore` (4 tiles per sail tick) is dropped
   outright like v3's eaten-out basins: the extras hold the boat rather than launch the best of a garbage list.
   Tribe candidates are exempt from the floor (their 2× wave is affordability-gated and takes real enemy tiles;
   far tribe junk dies to the sail cost instead — v3 boated basin=1 tribes at sail 237). The launch loop now sees
   ONLY the scored candidates: v3's two escape hatches — the never-scored distance-sorted tail past the 24-entry
   head, and the un-scored same-mass fallback shores behind it — each re-leaked the dropped junk the moment the
   scored head emptied or its top pick was refused; a refused or dropped pick now holds the pass and re-scans
   20 ticks later.
3. **A landing a tribe ate is blacklisted.** When openingPush detects a tribe took an opening landing, the tile
   goes on `openingFailed`; no new opening candidate within boatBasinRadius of it is scored for the rest of the
   opening — the committed wave is pushed, the coast is not re-fed from home (the repro showed a new boat 62
   tiles from the eaten landing on the very tick of its push).

The BOAT OPENING log line now carries the target's `x,y` (helps every GUI session). Params: `boatOpeningSailCost`
(8), `boatOpeningMinScore` (4) — appended to scripts/lab/specs/wins.json for the CMA. Measured on the repro:
east-asia far-north lines drop from 8 to the 1–2 early large-basin landings, the junk tail is gone.
Tests: v4 block in tests/playbook/boatOpening.test.ts (a remote cap-saturated basin at long sail loses to the
nearer contested tribe; a landing a tribe ate is not re-boated while the push fights; the sail cost and the
floor each hold the boat home when only a long junk crossing remains).
A/B: `CONFIGS='{"base":{},"x":{"boatOpening":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

**v5 (branch `bot/boat-opening-v5`)** — own-mass shores are (almost) never worth a boat, from Josh's v4 GUI
session on a Japan-area World spawn ("that russia/asia coastline is difficult for the algo still"): the bot kept
spending opening boats on the far coast of its OWN landmass — v4 removed the arctic mass's spurious ×1.95 bonus,
but a big own-coast basin still won on raw worth, and land expansion reaches every own-mass shore free. One
change inside the same flag, flag-off byte-identical (MIN=3 default transcript diff-identical vs a57c5a650 but
botMs/gameMs):

1. **Own-mass empty shores score ×`boatOwnMassFactor` (0.15, CMA 0–0.6).** An empty-shore candidate whose
   landmass (v4's `landmass()` fill) is ours — with a cap-saturated fill counted as own, the conservative
   reading that also mops up acrossWaterNear's saturation ambiguity from the v2 caveat — is effectively
   excluded: at the default it needs a raw score of ~27 to clear the `boatOpeningMinScore` 4 floor, so only a
   genuinely huge basin (the measured east-asia 7657-tile arctic pocket still clears at ~87 raw) ever launches;
   everything else holds the boat or yields to a separate mass/tribe. Tribe candidates are exempt — a tribe
   across a bay on our own mass is still a fine boat (its wave takes real enemy tiles land expansion pays for).
2. **The escape hatch: a basin walled off by rivals keeps full score.** `Military.openingCutOff` — a
   breadth-first flood from the candidate over land no other player owns (unowned and ours pass), capped at
   OPENING_REACH_TILES (8000), cached per tile for WATER_CACHE_TICKS — decides land-reachability: meeting a
   tile of ours means land expansion can walk there (penalty applies); a fill that exhausts without meeting us
   is a cut-off peninsula behind rivals (boat-worthy, ×1); a fill that hits the cap is undecided and treated as
   reachable (open wilderness that large is exactly what land expansion eats). This also keeps a genuinely
   separate mass that a capped `landmass()` fill mislabels as own un-penalized whenever its free land is
   enclosed and small enough to enumerate.

The BOAT OPENING line now ends `own=yes/no` (the landing's mass is our own) plus `blocked=yes` when the escape
hatch fired — the GUI shows the reasoning. Param: `boatOwnMassFactor` (0.15) appended to
scripts/lab/specs/wins.json (validated with `cmaes.py --dry-run`). Measured on the 6-min Medium smokes, flag on:
east-asia 8 launches / north-russia 11, own-mass EMPTY-SHORE launches 1 each (the t80 genuine 7657- and
4159-tile basins), every other empty-shore launch own=no; own=yes tribe launches (6 in north-russia) are the
intended exemption.
Tests: v5 block in tests/playbook/boatOpening.test.ts (the cove fixture: an own-mass far coast reachable
through a free lane loses to a separate-mass candidate and, under the floor, to holding the boat — both flip at
×1 pinned, so the factor is what decides; the rival-walled carve still launches at factor 0 with blocked=yes;
a tribe on our own mass is exempt at factor 0).
A/B: `CONFIGS='{"base":{},"x":{"boatOpening":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

**v6 (branch `bot/boat-opening-v6`)** — three opening-boat findings from Josh's Hard GUI sessions, all inside
the (now default-ON) flag; flag-off byte-identical to base (MIN=3 across all 6 regions, transcripts equal
modulo the wall-clock botMs/gameMs fields):

1. **The sail is the true water path, always.** The opening scorer priced a crossing by straight line unless
   `boatsWaterPath` was on — but that flag is default OFF (its ranking lost the rm1 full-game A/B), so the
   extras kept landing on the far side of rivers and peninsulas ("the straight line looks short"). The
   opening now always runs `Military.waterPath()` (the same cached fill boatsWaterPath uses; one fill per
   pass, cached 100 ticks) for BOTH the sail term and the eta discount, independent of that flag; a shore no
   water path reaches within WATER_MAX_DIST (250) is no candidate. The plain first boat and the mid-game
   boat rules keep boatsWaterPath's own (off) behaviour, untouched. Test fixture: the Skagerrak — Jutland's
   Kattegat shore is chord ~8 from southern Norway but ~115 real water tiles (the Danish straits are closed
   on the test map); the plain straight-line boat picks it, the v6 extras land on the North Sea side at
   sail ~25-40.
2. **An escalating sail budget replaces the ocean window** (`boatOceanUntil` REMOVED — its all-or-nothing
   window is gone; Josh: "close boats very early, then further and further attempts before warships are
   everywhere"). maxSail(t) = `boatSailMin` (50) + (250 − boatSailMin) × clamp(t / `boatSailRampTicks`
   (2000), 0, 1): ~50 tiles at spawn, the full BOAT_MAX_PATH at t2000 — first enemy warship t1489–t2205
   across the 6 measurement games, so the longest attempts run right as the ocean closes. `boatOceanBonus`
   (1.3) survives: a new-landmass candidate beyond the 80-tile early cap still gets it, now inside the
   budget. The BOAT OPENING line gains `cap=` (the budget at launch).
3. **Difficulty-aware eat rate + landing-eaten re-anchor.** Measured the v3 way on Hard (3 Hard + 3 Medium
   lab games, tiles/tick per frontier-contact tile, t100–3000 africa): the pooled Hard/Medium ratio is only
   1.013 (tribes 1.012, nations 1.031) — per-contact-tile expansion is nearly difficulty-independent, so
   `boatEatRateHard` defaults to 0.0245 × 1.013 = 0.0248 (the knob exists for the CMA; Hard/Impossible read
   it, Medium keeps boatEatRate). What Josh actually keeps seeing — landing INTO a just-taken shore — is
   attacked directly: an empty-shore candidate whose basin is still worth the trip but whose LANDING tile
   has an eater within eatRate × sail (the frontier advances ~eatRate tiles/tick locally; the wave targets
   the launch-time owner, so an eaten shore fizzles it) is re-anchored to the nearest safe shore of the same
   basin inside the budget (`reanchored=yes` on the log line, fire site `reanchor`), or dropped when every
   reachable shore is projected eaten. Tribe candidates are exempt (their wave targets the tribe itself).

Params: `boatSailMin` (int 50), `boatSailRampTicks` (int 2000), `boatEatRateHard` (0.0248); `boatOceanUntil`
deleted. Golden unchanged: big_plains has zero water tiles, no boat rule can run there (verified).
Tests: v6 block in tests/playbook/boatOpening.test.ts (the Skagerrak far-side fixture; the ramp holds the
~124-tile carve at t100 and releases it once maxSail covers its path; a planted eater beside the discovered
Arabia landing re-anchors the candidate and a full shore picket drops it; the same pins forfeit the carve on
Hard via boatEatRateHard and take it on Medium).
A/B: `CONFIGS='{"base":{},"x":{"boatOpening":false}}' MIN=full WORKERS=3 scripts/lab/remote.sh` (a removal —
the flag is default-on; judge on winner= per the wins objective)

## Plateau break (`plateauBreak`, 2026-08-30, branch `bot/plateau-break`)

**Removed 2026-08-31 (branch `bot/prune2`; the code lives in git history, last at 0a8f35bc4).**
A stalled-growth escalation (Military.plateauRule: tile count sampled every 300 ticks; on a plateau a forced sea
expansion, else a forced war on the largest adjacent non-ally, else the weakest alliance lapses). fix1 +0.05 (led
+0.24 at 18 pairs, faded), flips1 −0.14 against the combo defaults — the combo's own pressure already fills the
role. Deleted with `plateauWindow`/`plateauGrowth`, the `forced=` plumbing through
seaExpansion/warPick/warScorer, `Diplomacy.planLapse`, `WarPick.alts` and its tests.

## `fix1` — the five loss-analysis flags, full games (2026-08-30, `lab-out/fix1`)

120 mirrored full games per config on 553568ce4 (5× cpx62 IPv6). Note the base now wins **65 %** (78/120) — up from rm1's 50 % after the boatsWaterPath revert and the review-fix pass; the loss clusters these flags target are already rarer.

| flag | wins vs base 78 | McNemar p | SPRT (δ 0.10) |
|---|---|---|---|
| contestLeader | 81 | 0.73 | CONTINUE +0.03 |
| plateauBreak | 80 | 0.88 | CONTINUE +0.05 (led +0.24 at 18 pairs, faded) |
| webDefense | 78 (1 live pair in 120) | 1.00 | REJECT — never fires |
| samOnRisk | 76 | 0.87 | CONTINUE −0.06 |
| warRoiCap | 70 | 0.33 | CONTINUE −0.16 |

Verdict: none decisive at default constants; contestLeader/plateauBreak lean positive, warRoiCap leans harmful (warRoiMax 500 likely too aggressive), webDefense needs a rarer-situation test or deletion. Next: append the five flags' constants to specs/wins.json and let the full-game CMA (flags on) settle them together, per the ab1 lesson.

## Finish a won duel (`duelPush`, 2026-08-30, branch `bot/duel-push`)

Josh's GUI endgame: two living non-bot players left, the bot at 38.3 % of the land with 13.3M troops against the
rival's 61.7 % / 7.55M — near-double, "basically won" — and it spent 10+ minutes REQUESTING ALLIANCES with its only
rival instead of finishing. Verified in code: (a) the finish rule's push needs `denialShare ≥ min(0.45, denial − 0.03)`
(readSlow), so a won duel at 38 % never leaves `grow`; (b) `Diplomacy.requestAlliances` walks the unfriendly
neighbours strongest-first with no notion of "the last one", so the sole rival is asked every `allianceEvery` ticks
for as long as it refuses (and accepted the moment it agrees, which locks the war behind an alliance).

`Situation.duel` (`SituationQueries.duel`, on the 100-tick rank scan; the troops test is read every tick): the **foe** of
a **won duel** — the strongest by troops of the other living non-bot players off our team while they number ≤
`duelPlayers − 1` (default 2 players: exactly one) and our troops are ≥ `duelRatio` (1.2) × its. Null with the flag
off, with more players left, or while we are behind — behind, nothing changes (the flag finishes a won game, it does
not martyr a lost one). Entry/exit logged `DUEL vs <name> troops us …k / them …k — pushing` / `DUEL over` (≤ 1 per
300 ticks). While set:

- **Diplomacy** never asks the foe for an alliance, never accepts one from it, and never renews one with it — an
  existing alliance lapses through the planned-target path (`manageExpiries`: no extension, no gift; the war rule's
  +4 once it has ended), **never a betrayal** (the traitor debuff halves our defence for the very finish). Below
  `duelRatio` the foe's peace offer is accepted as before: a losing duel may want peace. Logged
  `DUEL: no alliance request to / with / renewal with <name>` (≤ 1 per site per 1800 ticks).
- **Mode** is `push` whatever our share (readSlow): contested expansion rates, the endgame war ratio (1.2×) and 70 %
  sends, the finish MIRV at the richest MIRV-capable rival. **Hold keeps precedence**: `hold` (under the denial line
  with a MIRV-capable rival, finishRule) is left alone — the hold's own war (`threatHere`) already goes at that rival,
  and pushing land there is exactly what gets us MIRVed. So a MIRV-capable foe near the denial line is still handled
  by the hold: the duel changes `grow` only.
- **War rule** (`warPick`/`warScorer`): the foe on our border is an opportunity — no affordability / `fightAbove`
  gate, the war-count invariant lets it open beside counters, the sticky-target filter admits it — scored
  `22 + ratio` at ratio ≥ `duelRatio` (the posts / thin-empire gates do not apply: it is the only target left; the
  `nationMirvAware` denial / steamroll guards keep their say) with a `min(fightRatio, duelRatio)` wave. The
  opportunity branch returns before the bonuses, so `contestLeader`'s +4 (the foe is usually the leader) is not
  stacked — one rank, no double bonus. Note the send is still 70 % of home at most: at 1.2 ≤ troops/foe < 1.71 the
  duel is on (diplomacy and mode change) but the wave does not fit yet — the war opens when cap growth or the foe's
  losses carry the ratio over (Josh's 1.76 was just past it). `warRoiCap` treats the foe as an opportunity too.
- **Bombs / MIRV**: the foe joins `bombEnemies` like a threat (before the contest leader — one entry) and is a
  priority MIRV target after the finish / counter / denial branches (with `nationMirvAware` on, never at a foe that
  can counter).

Fires (`duelPush`, FireLimiter): `mode` (grow → push), `gate` (a war pass the plain gates would have refused),
`score`, `request` / `accept` / `renew` (an alliance the plain path was about to make), `bomb`, `mirv`. Params:
`duelPlayers` (int), `duelRatio` (appended to `scripts/lab/specs/wins.json`, 1.0–2.0). Tests:
`tests/playbook/duelPush.test.ts` (two-player fixture, armies pinned: the war at duelRatio below fightAbove; the
diplomacy half alone in the 1.2–1.71 band; behind → no change; three players → no duel; an existing alliance lapses
and is never broken, off it renews). Golden unchanged; the MIN=3 africa/Medium transcript is identical with the flag
off.

A/B (full games — the stall is an endgame failure; a 20-minute game rarely reaches a duel):
`CONFIGS='{"base":{},"duel":{"duelPush":true}}' MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh`.

## Boat escorts (`boatEscort`, 2026-08-30, branch `bot/boat-escort`)

Josh (GUI): "the last thing it needs is moving warships to corridors where it's trying to place a boat so it can get
across" — and, same flag, "it can try multiple boats to get across contested waters". The opening boats (`boatOpening`)
and the later sea expansion cross water; enemy warships appear from ~t1730 and sink transports, which is why the
opening's ocean window closes at `boatOceanUntil` = 1500. Until now the bot bought warships only from 15:00 (one per six
ports) and never positioned them.

**What the engine's warships actually do** (`WarshipExecution`, `ShellExecution`, `Config`): a warship picks the
nearest enemy unit within `warshipTargettingRange` = 130 tiles, **transports first**, then warships, then trade ships
(the last only inside its 100-tile patrol radius). Against a transport it **does not reload** (one shell per transport,
a new target every tick), the shell homes at 3 tiles/tick and never expires while the warship lives, and a transport has
no health — one hit sinks it (the troops are lost). Warships are 1000 HP, a shell does ~200–325, one every 20 ticks
against a warship; a warship retreats to port at 75 % and keeps firing on the way, and stops only once docked. Owners
that cannot attack us (allies, teammates) never fire. Consequences: **an escort cannot screen a transport** — the
threat shoots the transport before the warship, whatever sails beside it — it can only **clear the corridor** (three
hits send the threat home; two escorts do it in 40 ticks); and **a swarm does not saturate** a warship: three boats
draw three shells in three ticks. What a swarm can do is get the boats the threat has not reached yet ashore — a
transport within ~40 tiles of the far shore lands before a shell from 130 tiles arrives — so it is a gamble, kept
because Josh asked for the attempt; the A/B judges it.

So the flag is an **escort-clears, boat-waits** rule, with the swarm as the fallback, all in `Military.escortGate`,
called by the loop's `boat()` before every launch (every boat rule, dry runs excepted):

- From `escortFromTick` (1200, a little before the first enemy warships) a crossing longer than `escortMinSail` (60
  sail tiles; the corridor = `WaterPath.path`, the fill's shortest route walked back from the landing — the engine's
  `WaterPathFinder` takes the same route give or take — or the straight line from our nearest sampled shore beyond the
  fill's 250-tile reach; every 4th tile) is checked: a **live** enemy warship (not docked, owner may attack us) within
  `escortThreatRange` (130 = the sink range) of a corridor tile contests it. Short hops sail as before.
- Contested: the crossing is **held** (`boat()` returns 0; the rule moves on to its next candidate and re-picks next
  pass), and the **idle warship of ours nearest the threat** on that water (not docked, not on another corridor) is
  moved with the real `MoveWarshipExecution` to the corridor tile nearest the threat, where the engine's own targeting
  engages it. Logged `ESCORT <ship id> → corridor (x,y) for boat to (x,y); threat <owner> at d`. No idle warship:
  with `escortBuy` and fewer than `escortMaxShips` warships of ours, `Economy.build` buys one patrolling that corridor
  point (it spawns at our nearest port on that water — `PlayerImpl.warshipSpawn`), behind the bomb / SAM funds,
  `mirvFund` and the silo escrow, ahead of port levels and rail, behind the first three cities; logged
  `ESCORT buy Warship for corridor (x,y)`. The request lives `escortDeferTicks`.
- The crossing **sails on a later pass once the corridor reads clear** (the threat dead, docked, or out of range).
  The escort then watches that transport (by its landing, within `boatDedupeRadius`) and is released — idle for the
  next corridor, not moved back — when it has landed or died; a corridor never sailed releases after
  2 × `escortDeferTicks`. Assignments live in Military (`escorts`), the `escorts` rule every 10 ticks does the
  releases and the swarm launches, `prune()` is the backstop.
- **Swarm**: a **worthy** target — an opening pick scoring ≥ 2 × `boatOpeningMinScore`, a `CONTEST leader` boat, a
  boat onto the `duelPush` foe's shore — with **no escort possible** (no idle
  warship, no purchase pending) or **held `escortDeferTicks`** launches `escortSwarm` (3) boats instead: the same
  troops split evenly (each ≥ 500, else fewer boats), the first now and the rest one `escorts` pass (10 ticks) apart
  (they skip `boatDedupe` and the gate). Logged `ESCORT swarm n boats → (x,y)`. Prefer escort, swarm second, defer last.
- Held with nothing possible: `ESCORT none: crossing deferred (...)`; held for an escort on its way: `ESCORT hold:`.

Fires (`boatEscort`, FireLimiter, 1 per 100 ticks per site): `move`, `buy`, `swarm`, `defer`. Params: `escortMinSail`,
`escortFromTick`, `escortThreatRange`, `escortMaxShips`, `escortSwarm`, `escortDeferTicks` (ints, appended to
`scripts/lab/specs/wins.json`; `cmaes --dry-run` validated), `escortBuy` (bool). Off = unchanged (golden unchanged, the
MIN=3 africa/Medium transcript identical; the `escorts` rule and the gate return at once). Tests
`tests/playbook/boatEscort.test.ts` (the Red Sea → Suez → Med fixture from boats2, 148 tiles by water, an enemy
warship in the Med): the idle warship is moved onto the corridor at the point nearest the threat and the crossing is
held, then sails once the threat is deleted and the escort is released after the landing; off, the boat sails
unescorted; no warship and no gold → `ESCORT none: crossing deferred` and no launch, with gold a warship is bought at
the corridor and takes the escort; a short hop (under `escortMinSail`) sails past the warship; a worthy contested
crossing with no escort possible launches three staggered 3k boats under the flag, one boat without it.

A/B (full games — the losses this addresses are late crossings; note `boatsWaterPath` is off, so the corridor comes
from the fill the flag runs on its own):
`CONFIGS='{"base":{},"esc":{"boatEscort":true}}' MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh`, and the
opening pairing `{"boatOpening":true}` vs `{"boatOpening":true,"boatEscort":true}` (the opening's ocean window could
then be widened: `boatOceanUntil` up, escorts covering what sails after it).

## `boat1` — boatOpening v5 / duelPush / boatEscort, full games (2026-08-30 evening, `lab-out/boat1`)

120 mirrored full games per config on 896b7f749 (5× cpx62 IPv6, nbg1). Base wins 78/120 (65 %).

| config | wins | pairs (cand-only / base-only) | McNemar p |
|---|---|---|---|
| boatEscort | 82 | 24 / 20 | 0.65 |
| all three | 82 | 27 / 23 | 0.67 |
| duelPush | 81 | **3 / 0** (fires only in won duels; converts every time) | 0.25 |
| boatOpening | 73 | 22 / 27 | 0.57 |

None decisive at default constants. duelPush is a rare-but-clean converter; boatEscort leans positive; boatOpening leans negative on full games despite its opening dominance (the escort absorbs the downside: all3 ≈ escort alone). Constants of all three are in specs/wins.json for the full-game CMA.

## Full-game CMA campaign + fresh-seed gate (2026-08-31, `lab-out/cma-wins`, `lab-out/cma-gate`) — NOT graduated

cmaes.py, wins.json (41 dims incl. every fix/boat flag's constants), all 13 candidate flags fixed on, wscore objective, pop 12 × 6 gens with racing, ~2,500 full games on 5× cpx62 IPv6. In-campaign the tuned mean beat base five generations straight on the shared per-generation grids (16-15, 21-15, 20-15, 19-15, 19-15). **Fresh-seed gate (SEED=gate, 120 mirrored full games): tuned 74 wins vs base 78 of 120 (deaths 7 vs 1), dwscore −0.12, CONTINUE at MAXBATCHES, McNemar p=0.67 — the lead did not transfer.** Same failure shape as the 20-min campaign: the search fits its training worlds.

Lessons, in order: (1) any CMA re-run must rotate seeds per generation (SEED=g<N>) so memorizing worlds is impossible; (2) at 30 games/config the within-generation ranking is mostly noise for 1–3-point effects — per-parameter SPRT A/Bs are the better tool at this noise level; (3) the campaign's five-generation drift directions survive as *hypotheses*: salvage A/B (`lab-out/salv1`) tests core-war constants (fightAbove 0.81, reserveShare 0.41, capFullShare 0.67), duelPush@1.0, and the combo with tuned boat constants, on fresh seeds. CMA retired until (1) and a bigger game budget exist; the racing/SPRT/mirror infra stays (it is what every A/B runs on).
## Pruning (2026-08-31, branch `bot/prune`)

Josh: "prune and simplify as much as we can." Deleted every flag that measured dead or harmful across the
full-game A/Bs (ab1/ab2/fix1/boat1 and the CMA campaigns), with its params, code paths, tests and specs —
about 2,900 lines. Last commit with all of it: 38219433a.

| deleted | evidence |
|---|---|
| `utility` (+ Utility.ts, utilCap*/utilCommit/utilFreeLandCost/utilScoreFull) | ab1 53W/44L, noise; heavy |
| `threatMap` (+ ThreatMap.ts, threatReserveGain/Busy/Vuln/PreRatio) | ab1 −0.073; fix-era noise |
| `buildSearch` (+ BuildSearch.ts, buildCapGoldPerTroop/buildHorizon) | ab1 49W/50L; planner CPU |
| `hystRetreats` (+ hystMargin/hystSlope/hystStrikes, retreatBelowRatio) | ab2 REJECT −0.06 |
| `webDefense` (+ webRatio/webUntil, Situation.web) | fix1: 1 live pair in 120 — never fires |
| `markTargets` | ab1 41W/58L, 4 deaths vs 0 |
| `wildernessAware`, `steamrollCap`, `holdHumans` | never fire in the lab |
| `warRoiCap` (+ warRoiMax/MinTiles/Window/Cooldown, ROI bookkeeping) | fix1 70W vs 78, leaning harmful |
| estimator layer: Estimate.ts, estOpts, EST/ACT log, estLossScale*/estSpeedScale, calibrate.py | last consumers were utility/hystRetreats |

Kept: trustWars, nationAware, retaliateAware, drainedNations, relationAware, strictOneWar, contestLeader,
plateauBreak, samOnRisk, boatOpening (v5), duelPush, boatEscort, warYield, nationMirvAware, boatsAfterCoast,
bombBudget, boatsWaterPath (default off), and the default-on set (boatsNearest, finishByBoat, annexWars,
lapseToAttack, multiWar, takeFallout, steamrollLevels, boatDedupe). specs/wins.json and neutral-flags.json
trimmed to the surviving params (`cmaes.py --dry-run` clean on both).

**Decision parity.** The EST/ACT lines were always-on, so the golden hash was regenerated; the golden
material and default-config MIN=3 + MIN=6 africa/Medium lab transcripts are byte-identical to base
(38219433a) after stripping the EST/ACT log entries and the botMs/gameMs timing fields (99 entries stripped
from the MIN=6 base log; every other byte equal — the prune changes no decision).

## Salvage A/B (2026-08-31, `lab-out/salv1`, fresh seeds SEED=salv) — the campaign's drift as hypotheses

120 mirrored full games per config vs base (64 wins, 53 %): **combo** (fightAbove 0.81 / fightMaxShare 0.63 / reserveShare 0.41 / capFullShare 0.67 / bombReserve 363k + duelPush@1.0 + boatOpening with boatOwnMassFactor 0.146, boatEatRate 0.0245) **76 wins, pairs 34/22, p=0.14, deaths 1 vs 8**; core5 alone 70 (p=0.50); duelPush@1.0 alone 68 with pairs **4/0**. Cumulative duelPush across boat1+salv1: **7 candidate-only wins, 0 base-only, ~240 paired games (p≈0.008)** — recommended default-on. combo goes to a third-seed confirmation (`lab-out/salv2`) before any defaults flip.

## Combo confirmed on a third seed set (`lab-out/salv2`, 2026-08-31)

base 76/119 (64 %) vs combo 87/119 (73 %), pairs 29/18. **Combined over the two independent fresh-seed sets (478 games): combo 163/239 (68 %) vs base 140/239 (59 %), discordant 63/40, McNemar p=0.030.** Consistent +11/+12 wins on both sets, deaths 1+2 vs 8+1, crowns up on both. Pending Josh's sign-off, combo becomes the defaults: fightAbove 0.81, fightMaxShare 0.628, reserveShare 0.408, capFullShare 0.672, bombReserve 363_497, duelPush on @ duelRatio 1.0, boatOpening on @ boatOwnMassFactor 0.146 / boatEatRate 0.0245.

Signed off — landed as DEFAULT_PLAYBOOK (branch `bot/combo-defaults`, 2026-08-31). Fixtures sized against the old defaults pin them via `PRE_COMBO` in tests/util/PlaybookSetup.ts; the golden hash was regenerated (defaults changed, not behaviour-at-equal-params: an MIN=3 africa/Medium run with the old values pinned through PARAMS is transcript-identical to base). A/B any future change against these values.

## Combo loss analysis (2026-08-31, 239 fresh-seed games from salv1+salv2)

Losses 71: endgame race at top-3 25 (in 17 we never fought the winner), MIRVed-down 24 (bot fired 0 MIRVs in 239 games vs the killers' 3–8; wins carry 87–92 SAMs vs losses' 13), plateau 19, died 3 (base: 9). Combo's delayed first war (median t1670→1985) feeds the runaway-race cluster — the trade that cut deaths. boatOpening shows no at-sea loss signature. duelRatio 1.0 authorised ~3 estimator-negative all-ins (own-goals). Flag→cluster: contestLeader/boatEscort → race (now #1), samOnRisk → MIRVed-down (defence only), plateauBreak → plateau; drainedNations/retaliateAware/relationAware/strictOneWar → none. New flags proposed: mirvCounterforce (strike the named armed/saving rival's silos first), duelWaveGate (all-in wave needs 1.2× though diplomacy flips at 1.0). Caveat: MIRVED log lines undercount vs FINAL mirvsTaken — use FINAL.

## Duel wave gate (`duelWaveGate`, 2026-08-31, branch `bot/duel-wave-gate`)

**Removed 2026-08-31 (branch `bot/prune2`; the code lives in git history, last at 0a8f35bc4).**
Held `duelPush`'s war wave until troops ≥ `duelWaveRatio` × the foe's (the salv2 82.6M-on-82.7M all-in own-goal).
The plain duel branch already needs ~1.43× (maxSend ≥ duelRatio × the foe at the 0.7 send share), so the default
1.2 was a near-no-op; swept where it bites, nf1 rejected both 1.8 and 1.9 (SPRT REJECT −0.02/−0.04). Deleted with
`duelWaveRatio` and its tests; `duelPush`/`duelRatio` (default on) are untouched.

## MIRV counterforce (`mirvCounterforce`, 2026-08-31, branch `bot/mirv-counterforce`)

Combo loss analysis (above): 24 of 71 losses were MIRVed down after leading while the bot fired ZERO MIRVs in 239
full games — and the always-on MirvRisk diagnostics named the saver minutes in advance (salv1
`p_combo_med0_north-russia.txt`: `MIRV RISK steamroll: … 1 saving (Greenland)` at t6900, first MIRV eaten t8340,
no counterforce ever taken). While a MirvRisk rule is TRUE against us (steamroll / denial) and MirvRisk names
armed or saving rivals, `Military.counterforce` (its own rule, every 100 ticks, right after `mirv` in the table)
acts on the SOURCE:

- **(a) our MIRV first** at the most-armed rival (canFire outranks saving; a built MIRV, then the richer) when we
  hold a silo and the 25M price — only when `maybeMIRV`'s own rules held this pass (it runs earlier the same tick
  and shares its 600-tick cooldown, so a launch here is one the plain rules never made). With `nationMirvAware`
  on, never at a rival that can counter (every canFire rival can, so the guard leaves the saving ones).
- **(b) else a hydrogen bomb on the rival's SILO**: the plain value search's 8000-tile owner gate is relaxed (the
  silo is the target, not the land); SAM umbrellas, the once-per-tile `bombed` book, the 105-tile friend
  clearance and the engine's collateral rule (`blastCollateral`) are still respected.
- **Budget**: the bomb reserve stays (`bombReserve`, 2M when `rich` as in maybeBomb), the MIRV price is checked
  net of this pass's buys, `cfCooldown` (600) ticks between counterforce launches, never a second launch on a
  tick a bomb already went. `samOnRisk`'s defensive wall is a separate flag, untouched.

Logs `COUNTERFORCE <name>: <mirv|H at silo x,y> (<rule> risk, n can fire, m saving)`; fires `mirvCounterforce`
via the FireLimiter (the hydrogen fire is skipped when the plain bomb search would have picked the same tile).
Params: `mirvCounterforce` (bool, default off), `cfCooldown` (int). Off = unchanged (golden unchanged, the MIN=3
africa/Medium transcript identical up to botMs/gameMs). Tests `tests/playbook/mirvCounterforce.test.ts`
(samOnRisk's steamroll fixture spread over big_plains, the rival's silo beyond the 105-tile clearance; the bot's
silo gets a `MissileSiloExecution` — `buildUnit` alone never reloads it): gold for a hydrogen but not the MIRV →
the saving rival's silo is hydrogen-bombed (off: nothing); MIRV affordable → the MIRV goes first; with
`nationMirvAware` and a rival that can counter, the MIRV is held and the silo bombed; two silos → the second
launch waits the full `cfCooldown`; no risk (or flag off) → quiet. Liveness: a MIN=20 north-russia Medium smoke
fired both branches (saver named t6300, `COUNTERFORCE Uruguay: mirv` t7100, `H at silo` t11200, mirvsTaken=0,
finished rank 1, fired=mirvCounterforce:2); the 6-min africa smoke never reaches silos — the risk cannot arise
that early, the tests carry liveness there.

A/B (full games — the objective is `winner=us`):
`CONFIGS='{"base":{},"cf":{"mirvCounterforce":true}}' MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh`, and
the pairing with the wall `{"samOnRisk":true}` vs `{"samOnRisk":true,"mirvCounterforce":true}` (defence + strike
against the same MIRVed-down cluster).

## `flips1` — the shelf vs the combo baseline (2026-08-31, `lab-out/flips1`, SEED=flips, ~120 games each)

None of the eight default-off candidates graduates against the new defaults: strictOneWar REJECT (−0.07), relationAware −0.31, plateauBreak −0.14, samOnRisk −0.07, retaliateAware −0.07, boatEscort +0.03 (its early leads faded a third time), contestLeader +0.00, drainedNations +0.01. Reading: the combo defaults banked the shelf's value; these stay off. First Hetzner run of the overlapped SPRT mode — worked cleanly.

## `nf1` — the loss-cluster flags vs combo (2026-08-31, `lab-out/nf1`, SEED=nf1, 108 games each; med9 dropped after a launcher stall)

mirvCounterforce 72 wins vs base 71 (+0.003, pairs 8/7); +samOnRisk 72 (+0.011); duelWaveGate 1.8/1.9 both SPRT REJECT (−0.02/−0.04). The counterforce fires correctly (the north-russia liveness smoke reproduced the losing shape and won) but does not convert to net wins at scale — consistent with the loss analysis's own finding that winners absorb MIRVs behind SAM walls rather than prevent them. All four stay default-off. Infrastructure: the overlapped-SPRT launcher died on rsync exit 24 (a box-side sed temp file vanished mid-pull) — remote.sh now excludes sed*/queue* from pulls and tolerates exit 24. Plateau note: base wins 66–68 % across the last three sweeps; single default-off flags no longer move it.

## Pruning II (2026-08-31, branch `bot/prune2`)

Josh: "as slim and neat as possible." Second pass, deleting the flips1/nf1 shelf — every remaining default-off
flag that lost (or never beat) its full-game A/B against the combo defaults — with its params, code paths, tests
and docs section. Last commit with all of it: 0a8f35bc4.

| deleted | evidence |
|---|---|
| `strictOneWar` | flips1 SPRT REJECT −0.07 |
| `relationAware` (+ Rivals.wouldAcceptAlliance, RivalView.relation, the prey-pick preference, six NATION_RULES alliance constants) | flips1 −0.31 |
| `plateauBreak` (+ plateauWindow/plateauGrowth, Military.plateauRule, the forced= plumbing through seaExpansion/warPick/warScorer, Diplomacy.planLapse, WarPick.alts) | flips1 −0.14 (fix1 +0.05 had faded) |
| `duelWaveGate` (+ duelWaveRatio) | nf1 SPRT REJECT at 1.8 and 1.9 |
| `drainedNations` (+ drainRatio/drainBelow, RivalView.drainedUntil, NATION_RULES.triggerRatio) | flips1 +0.01; maps to no loss cluster |
| `retaliateAware` (+ retalRatio, Military.shadowWave, RivalView.largestAttacker/largestAttack) | flips1 −0.07 |
| `scripts/lab/valuefit.py` | built for the removed buildSearch's value model; unused since |

Kept as **Hard candidates** (flat on Medium, shaped for the Hard frontier — noted in the Params.ts header):
`boatEscort` (+0.03), `contestLeader` (+0.00), `samOnRisk` (−0.07 alone, +0.011 beside counterforce),
`mirvCounterforce` (+cfCooldown, +0.003) — and everything default-on is untouched.

**Decision parity.** All six flags defaulted off and no always-on logging was touched: golden unchanged, and the
default-config MIN=3 africa/Medium lab transcript is byte-identical to base (0a8f35bc4) except the FINAL line's
botMs/gameMs wall-clock fields. Full suite green, tsc, oxlint+eslint (the 14 pre-existing DetMath errors are the
same at base).

## Hard baseline (2026-08-31 evening, `lab-out/hard0`, 119 full games, SEED=hard0, combo defaults)

**22 wins (18.5 %)** vs Medium's 68 %. Clusters (95 losses): endgame race at top-3 36, plateau/outgrown 24, died-late 22, died-early 9, MIRVed 4 (the MIRV cluster nearly vanishes on Hard — nations buy armies, not silos). Deaths are mostly mid/late (only 9 before 15:00). Mechanism: Hard defenders carry +33 % troops (start 25k vs 18.75k, cap ×1.0 vs ×0.75) on the same loss formula, so expansion is slower everywhere → smaller peaks → out-raced or collapsed. Campaign plan: per-difficulty parameter overlays (HARD_OVERRIDES over DEFAULT_PLAYBOOK, same flags/code), first candidates botRatio/tribe gates/fightAbove per Josh's "pushes only work from ~3k" observation; the kept Hard-candidate flags (boatEscort, contestLeader, samOnRisk, mirvCounterforce) get their real A/B here. Lab: DIFF now passes through med* batches (f5a10424d).
## Boat defense (`boatDefense`, 2026-08-31, branch `bot/boat-defense`)

Josh (Hard GUI): the bot has no reaction to enemy amphibious play — enemy transports land on our island/coast, grow a
beachhead behind our lines, and nothing answers until the generic counter's 5/15 % floor is crossed (a small landing
never crosses it), while enemy boats also snatch the tribes inside our sphere.

**What the engine exposes** (`TransportShipExecution`): the landing tile is stored on the transport unit itself —
`buildUnit(TransportShip, src, { targetTile: dst })`, readable as `unit.targetTile()` — computed at LAUNCH
(`targetTransportTile` from the clicked ref) and only changed by a retreat or a nuked-to-water shore, so the
anticipation can be exact: destination, owner and troops are all public from the moment the boat sails. The ship
moves 1 water tile per tick, so distance-to-target ≈ eta (manhattan is a floor for the real path). All enemy
transports come from `mg.units(UnitType.TransportShip)` (map-wide, cheap). On landing the engine conquers `dst` and
opens an `AttackExecution` at the launch-time owner; a land attack of ours against the beachhead's owner conquers
from OUR border tiles adjacent to THEIR tiles — when we border only the beachhead, the wave IS the beachhead fight.

The rule (`Military.boatDefense`, every 20 ticks, right after `counter` in the table so its wave outranks
expand/wars for the pass's spendable):

1. **Inbound**: every enemy (non-friendly) transport whose landing is within `bdCoastRange` (30) of our sampled
   border is tracked and logged `BOAT INBOUND <owner> → (x,y) eta <t>`; if the landing zone has no post of ours
   (30-tile range, under-construction counts) and a post can finish before the boat lands (eta > build 50 + 20),
   `Military.bdPostWant` asks Economy.build for one — placed right after the attack-landing post, same ≤8-post
   budget, `landingPostTile` = our nearest buildable tile to the landing (defensePostTile needs an attacker with
   border tiles; a boat at sea has none). Nothing else is pre-staged.
2. **Beachhead**: a tracked boat gone from the map has landed; the blob at the landing (flooded over the owner's
   tiles, capped — a blob connected by land to its mainland blows the cap and is correctly not a beachhead) that
   touches our border and is ≤ `bdBeachheadMax` (800) tiles gets ONE counter-sized wave per attacker per 300 ticks:
   1.05× the troops that landed (counterAttack's shape, capped at half our troops), sent as "counter" (bypasses
   fightAbove / the hold) but NOT put in `counters` — a counter auto-retreats when the enemy has no wave on us, and
   a beachhead wave must run until the blob is gone. Logged `BEACHHEAD`.
3. **Tribe race**: a transport bound for a TRIBE in our sphere (borders us, or its landmass is ours — this check is
   not behind bdCoastRange: the tribe's own coast can be far from our rect) is raced: we click the tribe NOW with
   harvestBots' sizing (botRatio + 500) and affordability (botMaxShare), jumping the one-at-a-time concurrency
   queue. Logged `TRIBE RACE <tribe> vs <owner>`; a same-landmass tribe with no shared border is logged, not
   clicked (a land click cannot connect — known gap, a boat race would be the follow-up if the A/B likes the flag).

Fires (`boatDefense`, FireLimiter 1/100 ticks per site): `inbound`, `post`, `beachhead`, `race`. Params:
`bdCoastRange`, `bdBeachheadMax`. Test: `tests/playbook/boatDefense.test.ts` (Bab-el-Mandeb: an 8k invasion of our
Red Sea bank → post up BEFORE the landing and the beachhead counter-waved at 8k while the plain bot posts only
AFTER the wave is ashore and never counters an under-5 % landing; a boat at a tribe bordering us → TRIBE RACE click
while the plain rule's single slot is busy; flag off → none of it, golden unchanged).

Honest baseline note: the plain bot is not fully blind — a landing that ATTACKS US does trigger the generic
incoming-post and (if ≥ 5/15 % of our troops) the generic counter, but only after the wave is ashore; and a landing
on free land / a tribe next to us triggers nothing at all. The flag's value is the pre-landing post, the immediate
counter regardless of size, and the tribe race.

Smokes: MIN=3 africa/Medium default-config transcript byte-identical to base 25138fcfb (FINAL botMs/gameMs only).
6-min africa/Medium flag-on: fired boatDefense:29 — 20+ BOAT INBOUND, 5 BOAT DEFENSE posts, 8 BEACHHEAD waves,
1 TRIBE RACE (logged-only), FINAL rank=5 share=0.69 alive. 12-min africa/Hard flag-on: fired 29 — ~60 BOAT INBOUND,
1 post, 1 BEACHHEAD, 2 TRIBE RACE (one clicked, one no-land-contact).

A/B (full games, wins objective): `CONFIGS='{"base":{},"bd":{"boatDefense":true}}' MIRROR=1 MINUTES=full WORKERS=4
scripts/lab/remote.sh` — Hard is where Josh saw the gap, so also a DIFF=hard leg.

## Tribe traps (`tribeBorders`, `thinGuard`, 2026-08-31, branch `bot/tribe-traps`)

Josh (Hard GUI): "the bot still falls to a couple early game tribe taking traps" — (a) "it doesn't take the tribes
bordering enemies first — it should, to establish better borders", and (b) "it creates really thin parts of its
territory, open to getting cut off and giving a chunk to tribes".

**What the hard0 transcripts say about (b)** (119 Hard full games, parsed for SPLIT lines): 4,238 SPLIT log lines,
but the vast majority (~3,900) are big-gap pieces — boat landings on other landmasses, normal amphibious play, not
cuts. Deduped to first occurrences, **67 real cuts** (gap ≤ 20 tiles held by a hostile, second piece ≥ 200 tiles):
33 before t3000, 34 after. Of the 33 early cuts, 7 had an unfinished tribe wave (sent < want) running within the
previous 400 ticks and in 2 the cutter WAS the tribe being eaten (e.g. north-russia t200: `bot Wolof Regime ←
8252/18024` then `SPLIT ... gap 9 held by Hebrew Sultanate`) — so the half-eaten-tribe salient is real but not
dominant; the bigger early source is landing basins and expansion arms pinched between two nations (the australia
games: a 3–4k-tile piece cut at a 4–10-tile gap held alternately by Australia/New Zealand). Late cuts follow wars
and sea-expansion boats. Conclusion: prevention needs both the follow-up speed-up (finish the tribe) AND the
geometric pinch watch (the nation-pinch case the tribe theory does not cover).

**`tribeBorders`** — REMOVED 2026-08-31 (branch `bot/post-standoff`; Josh: "probably isn't good, remove it" — both
single-seed smokes below were bad and it never got its A/B). Last commit with the code: c38fc2020.

**`thinGuard`** — every 100 ticks (`Military.thinGuard`, rule `thin`, inert off) scan our sampled border (every
3rd tile of the borderOf snapshot) for pinches: from a border tile with non-owned LAND right behind it, walk up to
`thinWidth` (6) tiles across our territory; hitting non-owned land again is a pinch of that width (water breaks
the probe: a strait is not land-cuttable). One pinch per pass, the narrowest, 600-tick / 2×thinWidth dedupe,
logged `THIN (x,y) width~w faces A / B`. Then: (1) a side facing free land → an immediate expand click at the
contested share (the widening move, through send()'s budgets; fires `widen`); (2) a side facing a tribe → that
tribe is marked and goes FIRST in harvestBots' order for 600 ticks (through the existing budgets; the changed pick
logs `TRIBE PRIORITY <name> (thin pinch)`); (3) a rival on both sides → `Military.thinPostWant` requests a defense
post at the pinch, consumed by Economy.build right after the boatDefense landing post, same ≤8-post budget (logs
`THIN post at (x,y)`, fires `post`). Additionally, while a tribe wave is unfinished, follow-ups go at HALF
`botFollowUpTicks` (fires `followUp` when the full cadence would still have waited) — the half-eaten-tribe fix.

Params: `thinGuard` (bool, default off), `thinWidth` (int, 6). Tests:
`tests/playbook/thinGuard.test.ts` (a 6-wide corridor fixture: rival flanks → THIN + a post covering the
pinch, free flanks → the widening click, tribe flanks → TRIBE PRIORITY over a weaker tribe; follow-up jump at t61
instead of tribes.test's t111; flag off → none of it). Golden unchanged (both off); MIN=3 africa/Medium transcript
byte-identical to base bcf649f7a (FINAL botMs/gameMs only).

Smokes (single seed each — the A/B decides): 6-min africa/Medium `tribeBorders` fired 2 (4 TRIBE PRIORITY lines),
FINAL rank=14 share=0.42 vs the flags-off control rank=4 share=0.62; `thinGuard` fired 6 (12 THIN, 1 thin-pinch
TRIBE PRIORITY; 0 THIN posts — the 6 posts the generic rules had built already covered the rival-faced pinches, so
the want cleared on hasUnitNearby), FINAL rank=1 share=1.00 (control 0.62). 12-min africa/Hard: `tribeBorders` fired
2 (3 TRIBE PRIORITY), rank=25 share=0.01; `thinGuard` fired 7 (17 THIN, 1 `THIN post at (1006,473)`, 1 thin-pinch
priority), rank=12 share=0.08. Most observed pinches are width 1–2 expansion arms in the opening.

A/B (full games, wins objective): `CONFIGS='{"base":{},"tg":{"thinGuard":true}}' MIRROR=1 MINUTES=full WORKERS=4
scripts/lab/remote.sh` — the traps are a Hard finding, so also a DIFF=hard leg.

## Defense-post standoff (`postStandoff`, 2026-08-31, branch `bot/post-standoff`)

Josh (Hard GUI): "the bot builds defense posts too close to enemy borders, during pushes too — it uses the center
of the building on their edge, not the edge of the defense radius like a human would."

**Engine facts**: a defense post has no aura of its own — `AttackExecution.attackLogicInput` grants the defender
`defensePostDefenseBonus` (5× attacker loss) and `defensePostSpeedBonus` (3× tile cost) on every conquered tile
with a defender-owned post within `Config.defensePostRange()` = **30 tiles EUCLIDEAN** (`hasUnitNearby`, dist² ≤
900). So a post ON the border wastes the enemy-side half of its circle and stands where the first push captures
it; a post ~28 back protects the same border stretch AND the 28-deep band behind it, with the building a full
radius from the enemy.

**The change (default ON — a bug-shaped misplacement, no flag)**: every post site pick goes through
`Economy.standoffPostTile` — the attack-landing and threat posts via `defensePostTile` (which used to step only
8–14 tiles back), the `boatDefense` landing and `thinGuard` pinch posts via `landingPostTile` (which used to put
the post ON the contact tile). From the border-contact midpoint, candidates are our buildable tiles on the ring
~`postStandoff` away that stand at least (standoff − 2) from every scored border tile (pins them to the
border-normal, off the border itself); the winner covers the most border tiles within the 30-tile radius, logged
`POST standoff (x,y) d~N covers K/B border (contact (x,y))`. An empty ring shrinks by 4 toward the contact — a
3-tile island still builds, at the contact itself. `Situation.postFacing` widens its sampled scan by half the
standoff so the threat-post dedupe still sees the rival the post faces. Coverage trade, measured
(postStandoff.test.ts fixture, straight border): the old 8-back post covered 57 border tiles, the standoff post
29 — bought with the building 28 from the enemy instead of 8 and the radius edge AT the border.

Params: `postStandoff` (int, default 28 = defensePostRange − 2; 0 restores the old geometry byte-for-byte — the
parity pin, and the CMA can tune it). Tests: `tests/playbook/postStandoff.test.ts` (the incoming-attack post sits
~28 behind the contact with its radius still covering it, 0 reproduces the old 8-back tile, thinGuard's pinch post
inherits the shared picker shrunk to a 6-wide corridor); `build.test.ts` re-asserted to the new geometry. Golden
HASH UNCHANGED — verified: no defense post is built in the 2400-tick golden window (material has only `build City`
at t1260). Decision parity: MIN=3 africa/Medium with `PARAMS='{"postStandoff":0}'` byte-identical to base
c38fc2020 (replay-recipe PARAMS line and FINAL botMs/gameMs only) — the same diff also proves the `tribeBorders`
removal decision-neutral.

Smoke (12-min africa/Hard, defaults): FINAL rank=5 share=0.60 alive, 9 posts (8 through the picker, 1 ring-empty
fallback to the contact), e.g. `t2400 POST standoff (955,433)
d~28 covers 30/39 border (contact (954,405))`, `t2250 POST standoff (1105,317) d~24 covers 51/81 border` — d
shrinks (24/16/12) where the interior is thin.

A/B (full games, wins objective — run as a REMOVAL, the correction is default-on):
`CONFIGS='{"base":{},"old":{"postStandoff":0}}' MIRROR=1 MINUTES=full WORKERS=4 scripts/lab/remote.sh` — posts
are a Hard/push finding, so also a DIFF=hard leg; the CMA can tune the standoff on the usual grid.
