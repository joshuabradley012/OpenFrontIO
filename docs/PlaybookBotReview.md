_OpenFront · branch playbook-bot · dc98ec741 · 29 Aug 2026_

# PlaybookBot Architecture Review

_Ported from the artifact on 2026-08-30; this file is now the source of truth._

> **Status (30 Aug 2026).** This is the review that started the rebuild; it describes the bot as it was at `dc98ec741` (one 1,430-line class). Everything it recommends was built — see `PlaybookBotPlan.md` for the packages and results. What the lab then decided differs from the review in three places: (1) the forward-simulated war gate (recommendation 1, `simWars`) lost decisively twice, uncalibrated and calibrated, and was deleted — `Config.attackLogic` charges the attacker against the defender's *whole* army, so the estimate's precision did not translate into better target choice; (2) utility-scored spending (recommendation 2, `scoredSpend`) bought fewer ports than the ladder and was dropped; (3) the single biggest gain was not on the list at all — a bug the new rule tests exposed (retreats never executed; fixing it is worth ten of eleven crowns on a 45-game ladder). The tuning advice (recommendation 8) held up, with one correction from the full-game gate: constants that win at 20 minutes can lose whole games, so the objective is now full-game wins (`MIN=full`, `wscore`).

What the bot is today, how it compares with how StarCraft, Age of Empires, Risk and generals.io bots are built, and what to change next — ordered by expected payoff per hour.

**Verdict** — The bot is an AoE2-style priority rule list with a good blackboard and a single troop arbiter. That is the right shape for a hobby RTS bot; the strain is in _how decisions are scored_, not in the loop.

**Biggest lever** — Replace threshold ladders (spending, target choice) with scored candidates, and gate every war with a cheap forward simulation instead of a fixed ratio.

**Second lever** — Tune many parameters at once with CMA-ES on paired seeds instead of one-parameter 30-game A/Bs; keep a ladder of past versions to catch regressions.

## What the bot is today

One class, `src/core/execution/playbook/PlaybookBotExecution.ts` (1,430 lines). Every tick:

```
tick()
  readSituation()   → this.sit  (troops, cap, spendable, neighbours, incoming, expiring, hold)
  acceptAlliances()
  events()          → alliance ended / new incoming attack
  for rule in rules: if ticks % rule.every === 0 → rule.run()

rules: split(200) counter(10) retreats(10) expand(10) tribes(10) wars(10)
       alliances(300) early boat(20) tribe boats(100) sea expansion(100)
       build(10) mirv(100)
```

Three things hold it together:

- **`sit`** — one evaluated picture per tick that every rule reads. This is the InformationManager / blackboard pattern from UAlbertaBot, and it is the best structural decision in the file.
- **`send()`** — the only place troops leave home. It enforces the reserve, the cap floor, the pre-expiry hold and the whole-wars rule, and it decrements `sit.spendable`, so _rule order is the priority order_ (counter before expand before tribes before wars).
- **`PlaybookParams`** — ~50 knobs, each with a lab result in its comment. This is exactly AoE2's "strategic numbers": tuning is data, not code.

Decisions are made by two very different mechanisms. `fight()` filters candidates through six gates, then ranks survivors with an additive score (`ratio*2 + buildings + density/50 − posts*3 − sizePenalty*2 + bonus`). `build()` is a nine-step first-fit ladder: defence post → SAM → three cities → ports → rail → silos → cap cities → warships → spare gold, with `return` after the first purchase and three separate reserves (`mirvFund`, `siloReserve`, bomb `reserve`) subtracted at different steps.

## What is working — keep it

### The blackboard + single arbiter loop (keep)

Every serious hand-written RTS bot (UAlbertaBot, CommandCenter, AoE2 scripts) converges on "read world once, then run managers that compete for one resource pool". You already have it. Don't rewrite the loop.

### Parameters with provenance (keep)

Each default carries its 30-game result. That is a better tuning log than most published bots have. The lab (paired spawns, same grid for every config, baseline in every sweep) is the correct evaluation design — Hahn's Risk study and chess-engine tuning both do exactly this.

### Reading the opponent's source (keep)

Nations are open source (`AiAttackBehavior.ts`): Hard nations never attack under 20 % of the target's troops, never drop below 75 % of their strongest neighbour, renew alliances only if you look as strong as they do. The bot already exploits the last one (`sit.hold`). More below — this is the cheapest edge available in solo games.

## Where it strains

### 1. Spending is first-fit, not best-fit (highest cost)

`build()` buys the first affordable thing in a fixed order. It never asks "is a port level worth more than a city right now?" — the port/rail/ports labs answered that question with numbers (marginal port ≈ 1.7k/s past 40–80 levels; stations only within 110 tiles of a factory; nothing bought after 25:00 pays back), but those numbers live in the guide, not in the decision. Every new lab finding becomes another `if` in the ladder plus another reserve variable, and the reserves now interact in ways nobody can predict (`gold − reserve − mirvFund` vs `gold − siloReserve − mirvFund` vs `gold − mirvFund`).

_This is the failure AoE2 scripters hit with rule ordering, and the exact motivation for Dave Mark's utility scoring: [Utility Theory Crash Course](https://github.com/apoch/curvature/wiki/Utility-Theory-Crash-Course)._

### 2. Wars are gated by a ratio, not by an outcome

`fightRatio` 2.0 vs 1.67 cost a 30-game sweep to settle, and the answer is still a single number applied to every neighbour regardless of border length, defence posts, their income, or whether an ally of theirs will pile in. `manageRetreats()` then has to detect the losing attacks after the fact. UAlbertaBot runs every engagement through SparCraft first: "if positive we continue, if negative we retreat". OpenFront's combat maths is deterministic and in `src/core` — the bot can evaluate _this_ attack against _this_ defender (troops, posts on the shared border, their cap and gold, incoming allies) before sending it.

_[UAlbertaBot AI overview](https://github.com/davechurchill/ualbertabot/wiki/Artificial-Intelligence)_

### 3. Phase is wall-clock, scattered

Ticks 900, 1500, 1800, 3000, 6000, 7200, 9000, 12000, 15000 appear as literals across `fight()`, `build()`, `maybeBomb()`, `seaExpansion()`, and the rule table. A game that is going badly at 10:00 and one that is going well look identical to these gates. AoE2 scripts and generals.io bots use explicit phase variables driven by state (free land remaining, share of cap, rank, any unfriendly silo on the map). A single `phase()` derived in `readSituation()` — _opening / consolidate / war / endgame_ — would replace the literals and make "what does the bot do in the endgame" answerable in one place. It would also expose the still-open 75 % hold / final-push gap as a missing phase rather than a missing `if`.

### 4. Feature flags are accumulating as coupled booleans

`endgameV2, splitWatch, econWar, wholeWars, stickyWar, postsBeforeCity2, spawnBasin, retreatOnAllianceEnd, openingAllIn, botsAfterWild`. Each was a fair A/B at the time, but they were measured one at a time against a moving baseline; the space has 2¹⁰ corners and only ~12 have been visited. Once a flag has won its A/B and stayed for a few commits, fold it in and delete the branch. Keep flags only for things still under test.

### 5. No opponent model beyond "collapsed in the last 10 s"

`collapsed()` is the only temporal memory of rivals. There is no per-rival trend (troops derivative, tiles derivative), no trust score (broke an alliance? attacked an ally? rejected our requests?), and no prediction of nation behaviour from their published rules. Cicero's non-language core is a planner plus a per-opponent trust estimator; Risk bots normalise threat across all borders (`BST = Σ adjacent enemy troops`, `BSR = BST / own troops`) and put reinforcements and posts where BSR is highest. The bot's post placement is "facing the strongest rival", which is the one-border special case.

_[Hahn, Risk border security ratio](https://project.dke.maastrichtuniversity.nl/games/files/bsc/Hahn_Bsc-paper.pdf) · [Cicero](https://ai.meta.com/research/cicero/)_

### 6. Tuning is coordinate descent with a noisy oracle

One parameter, two values, 30 paired games, decide. The lab notes already record the trap: "the first 6-game +17 % was noise on bad spawns", and hz3 flipped 1.67 → 2.0 on a 13–17 paired split. Several defaults are probably at local optima that only exist because their neighbours were tuned earlier. Chess engines went through this and settled on SPSA / CMA-ES over all continuous parameters at once, with SPRT to stop early, and a ladder of past versions so a regression shows up as an Elo drop rather than a hunch.

_[Chessprogramming: Automated Tuning](https://www.chessprogramming.org/Automated_Tuning)_

### 7. No rule-level tests

The only test is the 20-minute lab game. A change to `counterAttack()` can only be verified by 30 games on Hetzner. CLAUDE.md asks for tests on every `src/core` change; the `setup()` harness can build a two-player map, add an incoming attack and assert that a counter of the right size fires in ten ticks. Cheap, and it would let you refactor (items 1–3) without fear.

## What other games' bots do, mapped onto OpenFront

| Source                         | Pattern                                                                                     | OpenFront equivalent                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UAlbertaBot                    | InformationManager blackboard; managers compete for one resource pool                       | Already have (`sit`, `send()`). Split the class along the same lines: Situation, Economy, Military, Diplomacy, Expansion.                                                                                                                               |
| UAlbertaBot / SparCraft        | Simulate every fight before committing; retreat if the sim says no                          | `willWin(target, troops)` using the core's attack maths; replaces `fightRatio` and half of `manageRetreats()`.                                                                                                                                          |
| BOSS                           | Build-order search toward a goal state                                                      | Overkill; but "reach N cap / M income by T" as the economy's goal, chosen per phase, gives the utility scorer something to score against.                                                                                                               |
| AoE2 .per                      | Strategic numbers, goals, timers, escrow                                                    | Have numbers and timers. Missing: explicit goal/phase variables; one escrow model instead of three reserve variables.                                                                                                                                   |
| Utility AI (Mark)              | Score every candidate action on several curves, pick max, small bonus to the running action | Spending and target choice. The "bonus to the running action" is `stickyWar`, generalised.                                                                                                                                                              |
| Risk (Hahn)                    | Border Security Ratio per border; full-force attacks only when win probability > 50 %       | Threat per border segment drives post placement and how much stays home; ties into the forward sim.                                                                                                                                                     |
| generals.io bots               | Expand-only until the map is claimed; then gather along a path to the front                 | Already the opening policy (labs confirmed it). The "gather to a front" idea maps to choosing _where_ the war wave enters — OpenFront attacks along the whole border, so the analogue is picking the target whose shared border is short and post-free. |
| Cicero                         | Per-opponent trust estimate from whether actions matched agreements                         | Per-rival trust score feeding alliance requests, expiry handling and the `plannedTarget` choice.                                                                                                                                                        |
| Chess engines                  | CMA-ES / SPSA over all parameters; SPRT early stop; Elo ladder of versions                  | Replace one-at-a-time A/Bs for continuous params; keep A/Bs for booleans.                                                                                                                                                                               |
| AlphaStar / openfront-ai (PPO) | Learned policy                                                                              | Not worth it at this scale: ~200 game-years per agent; the one OpenFront RL repo is mostly plumbing. Stay heuristic.                                                                                                                                    |

## Recommendations, in order

### 1. Forward-simulate wars before sending them

_Effort: ~1 day · Risk: low · Payoff: replaces the most-swept parameter with a computed answer_

Add `estimateAttack(target, troops): { landGained, troopsLeft, ticks }` that runs the core's attack maths against the target's current troops, defence posts on the shared border, and expected reinforcement (their cap × regen over the attack's duration; incoming allied waves). Gate wars on `troopsLeft > reserve` and `landGained / troops` beating the price of free land. Keep `fightRatio` as a fallback while the sim proves itself in the lab. Read `AttackExecution.ts` for the actual per-tile loss formula; it is deterministic and integer-only, so the estimate can be exact for the first N tiles.

### 2. Score purchases, don't ladder them

_Effort: ~2 days · Risk: medium (touches every lab-tuned build rule) · Payoff: absorbs all the labs' payback numbers into one decision_

Each candidate (city here, port level there, silo, SAM, factory+rail, warship, hold for MIRV) gets `value = expected return over the horizon / cost`, with the horizon from the phase (short in the endgame — that encodes "nothing after 25:00 pays back" automatically). Emergencies (a post where an attack lands) stay as hard overrides above the scorer. One _escrow_ model replaces `mirvFund`, `siloReserve` and the bomb reserve: a list of `{ purpose, amount, until }` subtracted once.

### 3. Derive a phase from state, delete the tick literals

_Effort: half a day · Risk: low_

`sit.phase` ∈ opening (free land reachable) · consolidate (no free land, below fightAbove) · war (affordable target or cap full) · endgame (rank ≤ 3 and unfriendly silos, or tick ≥ 15000 as a floor). Rules read the phase; the tick literals go. This is also where the missing "final push" behaviour gets a home.

### 4. Rule-level tests on the `setup()` harness

_Effort: ~1 day for the first six · Risk: none_

One test per rule: counter fires at the right size, expand respects `homeFloor`, `send()` holds before an expiry, retreat triggers on the losing pattern, split detection finds the gap owner, build orders a post where an attack lands. These make 1–3 safe to do.

### 5. Split the file along manager lines

_Effort: ~1 day, mechanical · Do after 4_

`Situation.ts` (readSituation, neighbours, density, landmass, phase), `Economy.ts` (build, rail, escrow), `Military.ts` (expand, tribes, wars, counter, retreats, boats, bombs), `Diplomacy.ts` (alliances, expiries, embargoes, trust). `PlaybookBotExecution` keeps `tick()`, `send()` and the rule table. No behaviour change.

### 6. Per-rival model: trend, threat per border, trust

_Effort: ~1 day_

Keep a ring buffer per rival (troops, tiles, every 50 ticks). From it: derivative (rising army = about to attack), collapsed (already have), and a trust score updated on alliance events. Compute Border Security Ratio per rival border from shared-border length and their troops; use it for post placement and for how much of the reserve is really needed at home (a border with one weak neighbour needs less than three strong ones — today `reserveShare` is flat).

### 7. Predict nations from their own rules

_Effort: hours · Payoff: Hard-specific, large_

`AiAttackBehavior.ts` says Hard nations (a) won't attack when the send would be under 20 % of the target's troops, (b) won't send below 75 % of their strongest non-allied neighbour, (c) retaliate with at least the incoming total. So: staying at ≥ 1.34× the biggest bordering nation's _spare_ troops makes their attack on us impossible by rule, and (c) means a probing attack on a nation guarantees a counter of at least that size — never probe. Expose these as `nationCanAttack(n)` / `nationWouldSend(n)` in the situation and let the war scorer and the reserve read them.

### 8. Tune with CMA-ES on paired seeds; keep a version ladder

_Effort: ~1 day of scripting · Ongoing cost: Hetzner cents_

Take the ~12 continuous params (expand shares, botRatio, fightAbove, fightMaxShare, reserveShare, retreatBelowRatio, capFullShare, portLevelBeforeSecond, homeFloor, botClickCap, bombReserve, railSpacing), fitness = mean of (alive, share, top-3) over the 30-game Medium grid with the same seeds every generation, population 8–12, ~15 generations ≈ 4–5k games ≈ a few euros on cpx51. Then store every default set as a tagged version and re-run the best three against each new candidate — a two-config sweep becomes "did the ladder move". Keep booleans on the current A/B process.

## What I would not do

- **Reinforcement learning.** AlphaStar needed ~200 game-years per agent; the one OpenFront RL repo spent its effort on plumbing. Heuristics plus a good lab beat it for a solo-game bot.
- **Behaviour trees as a framework.** The rule table with cadences already gives you the readability BTs promise; adding a BT library to a dependency-free `src/core` buys nothing.
- **Spatial pathing / influence maps for troop movement.** OpenFront attacks are per-player along the whole border, so per-tile influence maps only matter for post/SAM/silo placement and split detection — which is what item 6 covers.

## Sources

_UAlbertaBot — [architecture wiki](https://github.com/davechurchill/ualbertabot/wiki/Artificial-Intelligence), [BOSS](https://github.com/davechurchill/BOSS), [CommandCenter](https://github.com/davechurchill/commandcenter) · AoE2 scripting — [AI Scripting Encyclopedia](https://airef.github.io/), [Steam guide](https://steamcommunity.com/sharedfiles/filedetails/?id=1238296169) · Utility AI — [Curvature crash course](https://github.com/apoch/curvature/wiki/Utility-Theory-Crash-Course), [IAUS overview](https://tonogameconsultants.com/infinite-axis-utility-systems/) · Risk — [Hahn 2010](https://project.dke.maastrichtuniversity.nl/games/files/bsc/Hahn_Bsc-paper.pdf), [Stanford CS229 agent](https://cs229.stanford.edu/proj2012/LozanoBratz-ARiskyProposalDesigningARiskGamePlayingAgent.pdf) · generals.io — [twolfson strategies](https://gist.github.com/twolfson/4bbbb40bd8b7ed670694b5a4dae04931), [Generally Genius (AIIDE)](https://ojs.aaai.org/index.php/AIIDE/article/download/27536/27309/31587), [generals-bots](https://github.com/strakam/generals-bots) · Diplomacy — [Cicero](https://ai.meta.com/research/cicero/) · Tuning — [Chessprogramming Automated Tuning](https://www.chessprogramming.org/Automated_Tuning) · Learned — [AlphaStar](https://deepmind.google/discover/blog/alphastar-mastering-the-real-time-strategy-game-starcraft-ii/), [openfront-ai (PPO)](https://github.com/djmango/openfront-ai)_
