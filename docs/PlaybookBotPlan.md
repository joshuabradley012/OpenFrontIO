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
fires on each such lapse. The old prey rule, `relationAware`'s prey pick and
the `campaigns` lapse are untouched and run first.

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
running non-bot attack, so **a running counter occupies a slot** (the
`strictOneWar` finding, 15W/6L, carried over). The sticky-target filter binds
the first war only; an extra war never becomes `currentTarget_` and does not
refresh `lastWarTick`. `strictOneWar` (if on) still wins: its check runs first
and refuses the pass. With `utility` on, a further war option in the ranked
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
leaves room for two; `strictOneWar` on top refuses the pass; three tribes
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

Loss cluster 1's bleed ("Why we lose full games", proposal 4): losing rm1 games
grind wars at 1,400–37,000 troops per tile — `p_base_med0_east-asia.txt` alone
has `WAR RESULT Australia: +578 tiles, -21469674 troops, 37145 troops/tile` and
three California wars at 1,190–1,688/tile, re-declared by the sticky target the
pass each one resolves. One default-off flag on top of the always-on WAR RESULT
accounting.

**Mechanism.** `Military.noteRoi` folds every resolved non-bot wave's realized
numbers (WAR RESULT's tiles and troops-not-home) into a per-target ROI: an EMA
over the last `warRoiWindow` (2) resolved waves (a 0-tile wave enters at
`max(YIELD_COST_CAP, 4 × warRoiMax)` rather than Infinity), recorded always,
read only by the flag. `Military.roi(t)` folds the running wave's
realized-so-far cost (the same `sampleYield` accounting `warYield` reads) in as
one more sample; the sample is `enough` at `warRoiMinTiles` (50) tiles, or on
troops alone at `warRoiMinTiles × warRoiMax` lost (a wave that lost 25k for no
tile has proven the price). Past `warRoiMax` (500 troops/tile) on enough
sample: (a) `manageRetreats` brings the running wave home through the existing
retreat path (`RetreatExecution`; hystRetreats untouched for other wars) with
`WAR ROI <name> X/tile — abandoned (Nk coming home), blacklisted 3000 ticks`
and fires; counters are exempt (they cancel incoming waves regardless of ROI);
(b) the target is blacklisted `warRoiCooldown` (3000) ticks — also (fired, one
per resolve) the moment a wave resolves over the line, since the sticky target
otherwise re-declares the same dear war within a pass; (c) the scorer treats the blacklist as a veto
below opportunity rank (collapsed / gap owner / hold-mode threat / drained /
annexable branches return before it) — a candidate the plain scorer accepts is
refused with `WAR ROI <name> X/tile — vetoed` and fires — and the sticky
filter releases a vetoed current target rather than holding every other
candidate hostage for the cooldown. Off = byte-identical decisions (recording
only); golden unchanged.

**Tests** (`tests/playbook/warRoiCap.test.ts`): a 3-wide neck at its troop cap
with every tile under one of two posts realizes ~650–1000 troops/tile — on,
the wave is abandoned at ~t110 through the retreat path, the veto holds for the
cooldown (no re-declaration, `vetoed` logged) and the flag fires; off, no WAR
ROI line and the plain bot grinds the same war; a vetoed sticky target releases
the filter and the war goes to the other neighbour (off re-selects the vetoed
one); a collapsed target bypasses the veto; a counter at a vetoed attacker
still goes and is never ROI-recalled.

**Smoke** (`MIN=6 SPAWN=africa DIFF=medium`, one seed — not evidence): rank 1,
share 1.00, 56,955 tiles, 44 players, botMs ~350, `fired=warRoiCap:2`. Two
abandons, both textbook:
`WAR ROI Niger 668/tile — abandoned` at t1840 after a 1,154/tile wave (the two
prior Niger waves went 71 and 294); Niger COLLAPSED at t1800 and the bypass
re-attacked at t1860, killing it in 3 s at 32/tile. `WAR ROI Chad 1947/tile`
at t3230 (139 tiles for 271k troops); Chad had COLLAPSED and the bypass
finished it at 59–188/tile. The cap cuts the dear grind and still lets the
collapse be taken.

**A/B** (full games — the objective is `winner=us`, and the bleed is a
late-game shape): `CONFIGS='{"base":{},"roi":{"warRoiCap":true},"roi1k":{"warRoiCap":true,"warRoiMax":1000}}' MINUTES=full WORKERS=3 scripts/lab/remote.sh`
— removal form once on: `CONFIGS='{"base":{},"noroi":{"warRoiCap":false}}'`.
The four constants (`warRoiMax`, `warRoiMinTiles`, `warRoiWindow`,
`warRoiCooldown`) are PlaybookParams for the CMA to tune with the flag on.

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

## Why we lose full games (2026-08-30, loss_analysis.py over rm1's 96 base games)

Outcomes: 48 won · 37 alive-but-lost · 4 died · 7 hit the cap (6 as rank 1). Caveat: 13 file groups share one spawn (region labels collapsed onto the same spot) — 96 files = 79 unique games; dedupe the spawn slots before the next sweep.

Loss clusters (41): **MIRVed down after leading — 19** (steamroll rule in 80 of 85 MIRVED-by lines; the bot's own `MIRV RISK steamroll` detector fires minutes earlier, then the game builds ~3 SAMs); **lost the endgame race at rank 2–3 — 13**; **plateaued behind a runaway — 5**; died 4. Losses peak at 33 min (wins at 61) holding 0.3 of peak; the 10-minute states of wins and losses are nearly identical — games are decided in the mid-game. Wins average 27 silos/97 SAMs vs 6.8/12 in losses. War efficiency is similar; the failure is growth stalling + MIRV exposure, plus no leader-contest behaviour (a rank-3 bot spends the last 5 minutes boating a 1,500-tile weakling while the leader closes to 80 %).

Ranked proposals (each a default-off flag + full-game A/B): 1) `samOnRisk` — on `MIRV RISK steamroll`, divert gold to a SAM wall + counter-silos (touches ~half the losses); 2) `contestLeader` — rank ≤ 3 with a runaway leader → boats/nukes at the leader, not "weak X"; 3) `plateauBreak` — <5 % tile growth over 5 min while rank > 1 → forced cross-water expansion or war on the largest adjacent non-ally; 4) `warRoiCap` — abort wars beyond ~500 troops/tile realized; 5) `webDefense` — ally/post against a mutual-ally border web before 10:00. Script: scratchpad loss_analysis.py (re-run on every sweep).
