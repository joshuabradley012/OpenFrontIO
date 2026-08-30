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

`src/core/execution/playbook/ThreatMap.ts`, built inside the 50-tick border
pass in `Rivals.sample()` (one extra bucket per (16 × 16 cell, rival) while the
flag is on; nothing is allocated when it is off). Per segment: `theirs` =
rival troops × (their tiles touching the segment / their border) × (1 −
(d / 150)^4) with d the distance from the rival's bounding-box centre;
`ours` = our troops × (segment tiles / our border) × (1 + 1 per covering
post, capped at 2); influence / tension / vulnerability as in the review.
Per rival: `maxThreat`, Σ `vulnerability`, `busyElsewhere` (share of its
border facing a third party it is fighting), `postTileFor` (centre of its
hottest segment). `undefended` = Σ max(0, theirs − ours) over unfriendly
segments. A `THREAT` log line every 600 ticks lists the top 3 segments.

Consumers (each fires `threatMap` when its decision differs from off):

1. **Reserve** — `reserve × clamp(1 + threatReserveGain × undefended /
   troops, 1, 2)` (gain 2) in `readSituation()` after the rival view. The
   spatial successor of `bsrReserve` (which scaled by the max bsr and lost).
   The brief's `clamp(0.5 + 0.5 × undefended / troops, 0.5, 2)` was tried
   first: on a calm border it is a 15 % reserve, and the sea-expansion rule
   (gated on `want ≤ spendable / 2`) shipped the army to collapsed players
   on other continents every 100 ticks — africa 6-min smoke rank 29 / 8.8k
   tiles vs rank 2 / 44k off. The reserve now never drops below the flat
   share and doubles once the unanswered pressure reaches half our army.
2. **fight() scorer** — `+ 3 × busyElsewhere(r) − 2 × vulnerability(r) /
   troops`: prefer a rival committed on its other borders (the Civ IV
   dogpile), avoid a war on a border where we are already contested.
3. **Threat posts** — `Economy.defensePostTile()` starts from
   `postTileFor(rival)` instead of the contact midpoint; the 8–14-tile step
   inland is unchanged.
4. **Pre-position** — `Military.counterAttack()` marks the unfriendly rival
   with a segment where theirs > 1.5 × ours by at least max(2k, 3 % of our
   troops), not attacking yet and not yet
   faced by a post, as `prePosition`; Economy's threat-post rule takes it
   before the troop-count threats. No troops move (logged `PRE-POSITION`).
5. **expand()** — skipped: a TerraNullius attack has no direction (the
   engine picks the tiles), so there is nothing for the map to steer.

Tests: `tests/playbook/threatMap.test.ts` (hottest segment on the massed
rival's border, busyElsewhere from a third party's wave, empty map with the
flag off, reserve calm < massed < swamped, post tile on the hottest segment,
pre-position without troops). Golden unchanged with the flag off.

A/B: `CONFIGS='{"base":{},"threat":{"threatMap":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`.
Cost: the `busyElsewhere` pass walks each unfriendly neighbour's border every
50 ticks; see the smoke `botMs` in the package report.
**Next lab session:** graduate the PROVISIONAL flags with the sequential
test (below), then `cmaes.py --pop 10 --gens 12 --race --games-growth`;
then Hard.

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

`Estimate.ts` is back (a replay of AttackExecution's per-tile loop, within
15 % of the engine on a single attack), now with calibration inputs:
`lossScale` (× attacker loss per tile), `speedScale` (× tiles per tick) and
`extraDefenderTroops` (the target's allies' possible pile-in). The 7W-23L
loss of the original `simWars` was the model's blind spots (merges, allies,
mid-war posts, the target's other wars), not the replay — so the constants
are fitted from the games the lab already plays.

**Calibration log (always on, no flag, log lines only).** Every war wave and
every tribe's first click writes `EST <target> wave=n troops= tilesEst=
lossEst= ticksEst= wins= class=nation|human|bot others=`; when the attack has
left `outgoingAttacks()` (won, died, or retreated) the bot writes
`ACT <target> wave=n tiles= ours= loss= ticks= sent= left= class= end=`.
`tiles` is the target's tile loss over the wave (confounded by its other
attackers, hence `others=`), `ours` our net tile change, `loss` = sent − the
last troop count seen on the attack (`end=fast`: over before the first
10-tick look, loss unknown and logged as 0; calibrate.py skips those). Tribe
follow-up clicks add to `sent` of the open record. A game's decisions are unchanged (golden material identical
minus the EST/ACT lines; the hash was regenerated for them).

**How to calibrate**

1. Sweep with the base config (any results dir with `log:` lines works —
   the transcripts of every A/B from now on carry the pairs):
   `CONFIGS='{"base":{}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`
2. `python3 scripts/lab/calibrate.py lab-out/<dir>` prints, per defender
   class, the log-ratio least-squares `lossScale` / `speedScale`, their
   medians and residual spread, and a JSON blob with the Params values
   (`--selftest` checks the fit on a synthetic fixture).
3. Paste `estLossScaleNation` / `estLossScaleHuman` / `estLossScaleBot` /
   `estSpeedScale` into `DEFAULT_PLAYBOOK` (they default to 1.0 = the raw
   replay) or into the candidate's CONFIGS entry.
4. A/B the two consumers on the calibrated numbers:
   `CONFIGS='{"base":{},"sim":{"simWars":true},"hyst":{"hystRetreats":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

**`simWars` — removed (bot/drop-simwars, from a36b357b5).** Lost twice: uncalibrated 7W-23L (C3); on the calibrated
scales in ab2 dScore −0.43 at 18 mirrored pairs (−0.52 with hystRetreats). The estimator, est*Scale, calibrate.py and the EST/ACT log stay.

**`hystRetreats` (default off):** every 100 ticks a running war is judged
'continue' (estimate over 600 ticks: survivors × 0.75 + tiles × 60) against
'retreat now' (troops × 0.75); continue must win by
`0.1 + 0.2 × clamp(maxBsr − 1, 0, 2)` over our other borders' largest
border-security ratio, and lose two checks in a row before the wave is
recalled. A wave under `retreatBelowRatio` × the target's troops whose
estimate cannot win is lost outright and comes home at the first check.
`retreatBelowRatio` (0.4, in the CMA-ES set) was read nowhere before this.
Fires when the verdict differs from the literal 20 % / 70 % thresholds.
Works with `realRetreats` (the same `retreat()`).

Tests: `estimate.test.ts` (restored + scales), `hystRetreats.test.ts`,
`calibration.test.ts` (`simWars.test.ts` went with the flag).
## Opportunity #2 — the nation AI as a perfect-information opponent (2026-08-29)

Branch `bot/nation-exploit`. The opponent pool is a deterministic script whose
source is in the repo (`AiAttackBehavior.ts`, `NationAllianceBehavior.ts`,
`NationNukeBehavior.ts`); these flags evaluate that script on the current state
instead of modelling it. Five default-off `PlaybookParams` flags, one per edge
(the brief's sixth, `secondAttacker`, is folded into `retaliateAware`: "join an
ally's marked target as the smaller attacker" is the same rule with the mark as
a second trigger). All nation-only; humans keep the existing handling. The rule
constants are in `Rivals.NATION_RULES` with file:line references.

- `markTargets` — `Military.mark()`: `TargetPlayerExecution` (the human
  'target' button) on the war target when `fight()` commits, on a non-bot
  attacker when a counter starts, and again from `fight()` whenever
  `canTarget()` allows (targetCooldown 150; a mark lives 100 ticks). Every
  allied nation with relation ≥ Friendly answers with `assist` (an attack of
  its own, `AiAttackBehavior.ts:487-514`) and points its nukes at the mark
  (`NationNukeBehavior.ts:220-231`). Costs: −40 relation from the target (it is
  at −70 from the attack already), −20 from each assisting ally. No ally: no
  mark. Note the relation window: an alliance starts at +100 and decays 0.05 a
  tick, so an ally assists only inside ~1000 ticks of the alliance (or a gift).
- `wildernessAware` — `Rivals.wildernessBound(p)`: every 4th border tile of a
  nation is checked for an unowned, fallout-free, passable land neighbour
  (cached 50 ticks). `maybeAttack` (`AiAttackBehavior.ts:60-95`) sends such a
  nation's whole surplus at TerraNullius and returns, so `nationCanAttack` reads
  false and `nationWouldSend` 0 (RivalView and `couldAttackAtExpiry`): the
  trustWars pile-in veto and the nationAware expiry hold stand down. While every
  unfriendly neighbour is a wilderness-bound nation, `sit.reserve` is halved.
- `drainedNations` — `RivalView.drainedUntil`: a nation under 0.3 × max cannot
  attack anyone (`attackBestTarget` line 244); the tick it is back at 0.5 × max
  is estimated from `Config.troopIncreaseRate` (capped 3000). `fight()` accepts
  a drained nation at 1.5× in the affordable gate, scores it like `collapsed`
  (18 + ratio at ≥ 1.5×) and lets it through the sticky-target filter; the wave
  is 1.5×. `counterAttack` never sizes the counter below the incoming wave + 1
  (the reserve permitting) so the wave is cancelled, not trimmed.
- `retaliateAware` — `RivalView.largestAttacker/largestAttack`
  (`findIncomingAttackPlayer`, lines 405-426: `retaliate` and the nuke target
  answer only the largest non-bot unfriendly wave). `Military.shadowWave(r)`:
  if someone else's wave on r is larger than 1.2 × r + 1000, or an ally of ours
  has r in `targets()`, r is scored +2 and gated at 1.2× instead of fightRatio,
  with a 1.2× wave (below the bigger one). A wave that would become the largest
  gets the normal gate.
- `relationAware` — `Rivals.wouldAcceptAlliance(p)` replays
  `getAllianceDecision` (lines 88-148) dice aside: traitor, too-many-alliances
  (Hard/Impossible), threat (Medium 2.5× troops; Hard/Impossible per rules),
  relation < Neutral, Friendly, enough-alliances, early window, similarly
  strong (lowest dice values). `requestAlliances` skips a nation that would
  refuse (logged once per 1800 ticks), so no trust is docked for a refusal we
  asked for. `Diplomacy.preyPick`: among neighbours within 1.15× of the
  weakest, the nation whose relation to us is highest is the prey (a lapsed
  ally is still Friendly/Neutral: a hit leaves it Distrustful, not Hostile, so
  no `hated` hunt at 3× and no embargo). The war scorer adds +2 (Friendly) /
  +0.5 (Neutral). Only the enum is visible, not the raw value.

Each flag fires `ctx.fire()` through `FireLimiter` (Context.ts, one count per
100 ticks per site). Tests: `tests/playbook/{markTargets,wildernessAware,
drainedNations,retaliateAware,relationAware}.test.ts`. Golden unchanged with
all five off.

Local smoke (africa, Medium, 6 min, one game each): base rank 2 / 44.4k tiles
(fired realRetreats:3, trustWars:3); all five on rank 3 / 33.7k tiles (fired
wildernessAware:1, relationAware:7, markTargets:7, drainedNations:4,
retaliateAware:0). A 12-minute africa game with `retaliateAware` alone: rank 1,
197.9k tiles, seven "as the smaller attacker" waves (fired retaliateAware:2,
rate-limited). One game is not evidence either way.

A/B, one flag at a time:
`CONFIGS='{"base":{},"x":{"drainedNations":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`
(and the same for `markTargets`, `wildernessAware`, `retaliateAware`,
`relationAware`); then the combination of whichever win.
## Review packages (2026-08-29, "PlaybookBot vs the field")

### #7 — Fast-forward build search (`buildSearch`) and a value function from records

**What the flag does.** `Economy.build()` with `buildSearch` on keeps its hard
overrides (a post where a non-bot attack lands / facing a threat, the first SAM
under an enemy silo, `mirvFund`, the silo escrow) and then asks
`src/core/execution/playbook/BuildSearch.ts` — a pure BOSS-style planner
(Churchill & Buro, AIIDE 2011) — what to buy. State = tick, gold, observed
income, troops, cap, city/port units and levels, factories, posts, silos, SAMs,
ships on the map, partner, threat. Actions = city, city level, port, port level,
factory (a rail step), post, silo, SAM, plus two macros (city×3 in the opening;
the first port levelled to 3). Every action is *fast-forwarded* to the tick it
is affordable (no idle actions); costs come from the real `Config.unitInfo`
(with `extraUnits` for the later steps of a plan), build times from
`constructionDuration`, effects from Spend.ts's models (port income with sea
saturation, partner share and the own-levels curve; rail income per stop; cap
filled by the engine's regen curve in closed form; silo / SAM / post as
threat-gated gold-equivalents). Search: iterative-deepening DFS with
branch-and-bound, children ordered by their idle value, 2000-node budget
(measured 0.7 ms per search on an M-series laptop, `buildSearch.test.ts` prints
it), horizon 6000 ticks in opening/consolidate, 4000 in war, what is left of the
25:00 clock in the endgame (capped at 6000). Objective at the horizon: gold +
troops × `CAP_GOLD_PER_TROOP` + defensive worth; gold counts 1:1, so a port pays
only through what it buys inside the tree (compounding is in the search, not
the leaf) and cap only as far as regen fills it. The first step of the best plan
is executed through the existing tile pickers; when it is not affordable yet the
bot saves ("save" = nothing bought). Re-plan every 100 ticks, on a gold jump
(≥ 1.5× the planning gold + 100k) and after every purchase; a kind whose picker
finds no tile is off the menu for 30 s (10 s for a level). `PLAN …` lines every
300 ticks. The flag fires when the planner's purchase family differs from a
coarse mirror of the chain's (`Economy.chainKind`), at most once per 100 ticks.

**Where it differs from the chain** (seen in tests and the smoke): the first port
before city 2 when both are affordable (the chain finishes three city levels
first); a port level before a 1M city level when troops cannot use the cap yet;
saving for a 1M item instead of a cheaper one the chain would take. It does not
buy posts/silos/SAMs on its own while cap or ports are available — at
`CAP_GOLD_PER_TROOP = 20` those dominate — so the chain's threat posts and
first SAM stay as overrides.

**Tests.** `tests/playbook/buildSearch.test.ts`: planner on plain numbers (a
drained empire saves for the port level; a full army on a full sea buys the city
now; port before city 2; node budget and timing; horizon shrink; posts only under
a threat) and a game on the world test map (a hand-placed first city, 400k gold:
off buys City then Port, on buys Port first, `fired.buildSearch > 0`). Golden
hash unchanged with the flag off.

**Smoke** (africa, Medium, 6 min, one game each): off 44.4k tiles, 7 city
levels, 2 ports, 279k gold, rank 2/50, botMs 404; on 34.0k tiles, 4 city levels,
3 ports, 741k gold (saving for a 1M level), rank 3/53, botMs 473,
`fired=buildSearch:6`. One game — the A/B decides:

```
CONFIGS='{"base":{},"x":{"buildSearch":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh
```

**Value function** (`scripts/lab/valuefit.py`, stdlib). The lab has no
`RECORD=1` output (no `rec_*.json` writer in `tests/lab/playbook.lab.ts`), so
it reads the transcript rows (`  600s … tiles= troops= cap= gold= cities= ports=
dp= allies= rank=r/N`). One row per game at 5/8/10/12/15 min, features
log tiles / log troops / troops÷cap / log gold / cities / ports / dp / allies /
rank score / share / log cap, target = summarize.py's final score. Ridge
(closed form, standardised features, λ = 1), in-sample R², 5-fold out-of-sample
Spearman of predicted-vs-final next to the two raw baselines (rank@t vs final
rank — the early-stop analysis's 0.58 at 12:00 — and score@t vs final score).
`--out value.json` writes the models (`apply_model` shows how to use one);
`--selftest` runs on a synthetic fixture. On the 395 twenty-minute Medium games
in the scratchpad (`--diff Medium --min-length 1200`):

| t | n | R² | ρ pred (cv) | ρ rank@t | ρ score@t |
|---|---|---|---|---|---|
| 5 | 395 | 0.40 | **0.56** | 0.51 | 0.52 |
| 8 | 395 | 0.52 | **0.65** | 0.54 | 0.55 |
| 10 | 395 | 0.50 | **0.58** | 0.55 | 0.56 |
| 12 | 395 | 0.50 | 0.55 | **0.57** | 0.57 |
| 15 | 395 | 0.60 | **0.68** | 0.65 | 0.65 |

The predictor beats raw rank at 5/8/10/15 min and ties it at 12 (0.55 vs 0.57);
gold, ports and posts carry weight the rank cannot see at 8–10 min. Early
stopping stays off (item 6 above); the fit is a proxy metric and a leaf
evaluator, not a graduation criterion. Mixed-length dirs must be filtered
(`--min-length`): a 10-minute game's FINAL is its 10-minute row and inflates
every early ρ.
## Fixes + perf package (2026-08-29, branch `bot/fixes-perf`)

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

**Three new flags, default off until the 30-game Medium A/B:**
- `steamrollCap` — city-unit cap = 0.9 × the nations' steamroll multiplier
  (1.5× Medium / 1.25× Hard, never under the rule's 10-unit floor) instead of
  the flat max(9, 1.15× runner-up). Fires when it lifts a cap the flat rule hit.
- `holdHumans` — the 45 s expiry hold also for a human ally stronger than us.
- `strictOneWar` — counters occupy the second war slot: one war plus counters,
  no second war (opportunity wars included) while a counter runs; a counter on
  the current target counts as that war.

A/B: `CONFIGS='{"base":{},"cap":{"steamrollCap":true},"hold":{"holdHumans":true},"one":{"strictOneWar":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`.
Tests: `tests/playbook/{fixesPerf,steamrollCap,holdHumans,strictOneWar}.test.ts`.

### #3 — One currency for troops (`utility`)

**What the flag does.** With `utility` on, one `troops` rule (every 10 ticks,
`Military.troopsRule`) replaces counter / expand / tribes / wars in the rule
table. Counters go first (rank 0, `counterAttack` unchanged), then the
follow-up clicks of running tribe waves (commitments), then every option the
chain could send this pass becomes an `Option {kind, target, troops, rank,
weight, why}` (`Utility.ts`): the expand click (`expandOption`), each tribe's
first click (`tribeOptions`), and each war candidate the scorer accepted
(`warPick().alts` — the old `fight()` split into `warPick`, the decision, and
`actWar`, the send; every bonus lambda — trust, threat map, relation, shadow,
drained, plannedTarget, sticky target — still lives in `warPick`'s scorer).
The currency is **tiles per troop lost**: free land at 20 a tile (`mag/5`),
tribes and wars from `estimateAttack` over the phase horizon (2:30 in the
opening, 5:00 later, the rest of the clock in the endgame; cached 50 ticks),
never under a tenth of the wave. Considerations (Mark's compensated product):
border threat for every kind (`ThreatMap.undefended` / troops, else the worst
bsr), click size for tribes, and for wars troops/cap as a logistic around
`fightAbove` (a midpoint, no longer a gate), the estimate's margin, trust,
an alliance about to lapse elsewhere, the scorer's own score, and a ×1.5
commitment for the running target. Ranks (Dill): 0 counter, 1 opportunity
(collapsed / gap owner / MIRV threat / drained), 2 normal. Execution: rank,
then weight, every option takes what `send()` allows — the reserve, the
whole-or-nothing war, one war per pass, the tribe concurrency cap, hold mode
and the sticky target all stay. `UTIL` lines (top 3) every 300 ticks. Fires
when the first thing sent differs from what the chain would have sent first
(the chain: expand if it can, else the cheapest affordable tribe, else the war).

**What the numbers say** (`utility.test.ts` fixtures, the estimator against
the real attack maths): a 1.67× tribe click takes its tiles at ~21 troops each
and a 2× war wave at ~40, against free land's 20 — so while any free land
remains the expand click keeps the top weight, tribes come next and wars last,
i.e. the chain's order. That is the `botsAfterWild` A/B's finding restated in
one currency. Where the flag changes decisions: an opportunity war (rank 1)
goes before the expand click that used to starve it; wars at cap or with a
good margin outweigh free land on a contested border; the tie-break inside a
rank follows the estimate, not the table. Boats are not options yet (the
brief's "when cheap"): `earlyBoat` / `huntBotsByBoat` / `seaExpansion` keep
their own rules.

**Tests.** `tests/playbook/utility.test.ts`: the curves and compensation on
plain numbers; the ranking; a fixture with free land, a tribe and a war
candidate (all three scored, executed in weight order, no fire when the order
matches the chain); a counter still first; a whole-or-nothing war on a
drained target no longer starved by a 60 % expand click (fires). Golden hash
unchanged with the flag off.

**A/B:** `CONFIGS='{"base":{},"x":{"utility":true}}' MINUTES=20 WORKERS=3 scripts/lab/remote.sh`

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
