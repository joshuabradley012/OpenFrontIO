// PlaybookBot parameters. Re-exported from PlaybookBotExecution.ts so callers keep one import.
//
// Graduated into the code (C2, no longer parameters): wholeWars (a war wave goes whole or not at all), stickyWar
// (one enemy to the end), splitWatch (reconnect a split territory), econWar (1.5× when our cap is twice theirs and
// gold is spare), postsBeforeCity2 (threat posts never wait for city 2; 30-game lab: +8 % land, same survival),
// retreatOnAllianceEnd (tribe waves come home when a stronger ally lapses), spawnBasin (spawn candidates refined by
// reachable free land). Dropped: openingAllIn/openingKeep (30-game lab: 20 %/10 % clicks beat the all-in, 24 vs 22
// alive, 800k vs 705k tiles) and homeFloor (declared and defaulted but read nowhere — A1 finding).
// Removed after losing their 30-game A/Bs (PlaybookBotPlan.md C3): simWars (Estimate.ts), scoredSpend (Spend.ts), bsrReserve, phaseGates — the first two live in git history.
// Removed after ab1 (PlaybookBotPlan.md "Review-package A/B ab1"): campaigns (Campaign.ts, review #6; 38W/60L, dScore −0.19, p=0.03) — in git history at 85ce33c8e.
// Removed after ab2 (PlaybookBotPlan.md #4): simWars, restored on the calibrated estimator and lost again (dScore −0.43 at 18 mirrored pairs; with hystRetreats −0.52) — in git history at a36b357b5. Estimate.ts stays (hystRetreats, utility, the EST/ACT calibration log).

export interface PlaybookParams {
  expandContested: number; // share of home troops per click into empty land while a rival borders us
  expandFree: number; // same, when nobody can contest
  expandEvery: number; // ticks between clicks
  botRatio: number; // attack bots with this multiple of their troops
  botMaxShare: number; // max share of home troops per bot click
  botEarlyShare: number; // while free land remains, only eat a tribe if the click is at most this share of home troops (and we are plentiful)
  botsAfterWild: boolean; // wait for the wilderness to run out before harvesting tribes
  botClickCap: number; // guide rule: no single tribe click above this share of home; split into follow-up clicks instead
  botFollowUpTicks: number; // ticks between follow-up clicks on the same tribe (they merge into the running attack)
  boatAtTick: number;
  boatShare: number;
  islandMaxTiles: number;
  fightAbove: number; // start fighting rivals when troops exceed this share of cap
  fightRatio: number; // attack size as multiple of the target's whole army
  fightNotBeforeTick: number; // no wars with nations/humans before this tick
  fightMinCities: number; // ... or before this many cities
  fightMaxShare: number; // never commit more than this share of home troops to one target
  retreatBelowRatio: number; // hystRetreats: a wave under this × the target's troops whose re-estimate no longer wins is lost outright (read nowhere with the flag off)
  capFullShare: number; // buy cap when troops exceed this share of cap
  citiesBeforePort: number;
  portMinPartnerDist: number;
  allianceEvery: number;
  portLevelBeforeSecond: number; // level the first port to this before a second port
  maxPortUnits: number; // beyond this, only port levels
  seaFullShips: number; // map-wide trade ships at which ports stop being bought
  railSpacing: number; // tiles between infill cities on a rail
  siloAtTick: number; // earliest silo
  bombEvery: number; // ticks between bombs
  bombReserve: number; // gold kept after buying a bomb
  reserveShare: number; // share of CURRENT troops kept at home by send()/boat() (nations keep 30–40 %); a share of cap froze the bot whenever troops were low
  tribeConcurrency: number; // tribe attacks at once below 60 % of cap (one more above)
  spawnInland: number; // tiles walked inland from the chosen shore
  finishRule: boolean; // hold under the nations' victory-denial line while a MIRV-capable rival exists; remove them; then push all-out
  endgameV2: boolean; // 15:00+: hydrogen bombs instead of hoarding, weak allies lapse, short boat jumps at 2×
  portWithoutPartnerTick: number; // first port on any ocean coast from this tick even with no partner (1e9 = never)
  nearbyEvery: number; // ticks the neighbouring-player set is cached for (1 = recompute every tick, the original behaviour)
  trustWars: boolean; // C1: fight() skips a target whose living ally on our border could pile in (nationCanAttack with nationWouldSend ≥ half our spendable) and prefers low-trust targets (+2 × (1 − trust)); off = the plain scorer
  buildSearch: boolean; // #7: Economy.build() takes its purchase from BuildSearch.ts (BOSS-style fast-forward search to a phase horizon; "save" when the best plan's first buy is not affordable yet) instead of the ordered chain; posts under attack, the first SAM under an enemy silo, mirvFund and the silo escrow stay. Default off until the 30-game Medium A/B
  nationAware: boolean; // C1: the expiry hold and the renewal gift use the nation attack rules (Rivals.couldAttackAtExpiry) instead of the 0.85× / 0.9× troop heuristics
  threatReserveGain: number; // threatMap: reserve × clamp(1 + gain × undefended / troops, 1, 2) — how fast unanswered border pressure raises the reserve (the brief's 0.5 floor halved the reserve in every calm minute and the army sailed off in boats: africa smoke rank 29 vs 2)
  threatMap: boolean; // review #5: a per-border-segment influence map (ThreatMap.ts) drives the reserve (undefended pressure, not max bsr), the war scorer (busy-elsewhere bonus, thin-border penalty), threat-post placement (hottest segment, not the border midpoint) and a pre-positioned post where a rival masses; default off until the 30-game Medium A/B
  // Opportunity #4 (estimator calibration): every estimateAttack call scales its per-tile loss by the defender's class
  // and its tiles/tick by estSpeedScale. 1.0 = the raw replay; paste the values scripts/lab/calibrate.py fits from a
  // sweep's EST/ACT log pairs (docs/PlaybookBotPlan.md "Calibrating the estimator").
  estLossScaleNation: number;
  estLossScaleHuman: number;
  estLossScaleBot: number;
  estSpeedScale: number;
  hystRetreats: boolean; // #4: manageRetreats judges a war every 100 ticks as 'continue' (estimate, 600-tick horizon) vs 'retreat now', continue must win by 0.1 + 0.2 × clamp(maxBsr − 1, 0, 2) and lose twice in a row before the wave comes home; a wave under retreatBelowRatio × the target's troops that no longer wins is lost outright; off = the literal 20 % / 70 % thresholds every 10 ticks. Default off until the 30-game Medium A/B
  // Opportunity #2 (nation AI as a perfect-information opponent), one flag per edge; all default off until the 30-game Medium A/B
  markTargets: boolean; // fight()/counterAttack mark the war target (TargetPlayerExecution, the human 'target' button) so allied nations' `assist` and their nuke targeting pile on; re-marked every targetCooldown while the war runs
  wildernessAware: boolean; // a nation with unowned, fallout-free land on its border sends its surplus there and returns before looking at players (AiAttackBehavior.maybeAttack): nationCanAttack/nationWouldSend read false/0 for it, and the reserve halves while every unfriendly nation neighbour is wilderness-bound
  drainedNations: boolean; // a nation under its reserve ratio (troops < 0.3 × max) is drained until it regrows to its trigger ratio: fight() takes it at 1.5× (affordable gate and score bonus), and the counter is never sized below the wave it cancels
  retaliateAware: boolean; // nations retaliate only against their largest attacker: a target already under a bigger attack (or marked by one of our allies) is preferred and taken at 1.2× with a wave kept below the bigger one; absorbs the brief's `secondAttacker`
  utility: boolean; // #3: one `troops` rule replaces counter/expand/tribes/wars — every troop option (expand click, tribe click, war wave per candidate, counter) is scored in one currency (expected tiles per troop × curved considerations, Utility.ts) and executed by rank then weight; counters always go, one war per pass, the invariants (reserve, whole-or-nothing wars, one war at a time, hold, sticky target) stay. Default off until the 30-game Medium A/B
  relationAware: boolean; // requestAlliances only asks a nation when NationAllianceBehavior.getAllianceDecision would accept (threat, Friendly, early window, similarly strong, capacity); prey and the war scorer prefer a nation whose relation to us is still Friendly (a lapsed ally: a hit leaves it Distrustful, not Hostile)
  steamrollCap: boolean; // the city-unit cap follows the nations' steamroll-MIRV rule (NationMIRVBehavior: leader past 10 units at ≥ 1.5× the runner-up on Medium, 1.25× Hard) at 0.9× the multiplier instead of the flat 1.15×; default off until the 30-game Medium A/B
  holdHumans: boolean; // the 45 s expiry hold also applies to a human ally stronger than us (troops > 0.85× ours), not only to nations; default off until the 30-game Medium A/B
  // Constants of the ab1-neutral flags, exposed so cmaes.py can tune them with the flag on (scripts/lab/specs/neutral-flags.json).
  // Defaults = the hand-picked values, so nothing moves until a spec says so. Only read while the flag is on.
  utilCapMid: number; // utility: midpoint of the troops/cap logistic on a war option (fightAbove was the midpoint)
  utilCapSteep: number; // utility: steepness of that logistic (10 = a clear step over ±0.2)
  utilCommit: number; // utility: weight multiplier for the running war's target (sticky war)
  utilFreeLandCost: number; // utility: troops a tile of terra nullius costs the expand click (mag/5 = 16–24)
  utilScoreFull: number; // utility: the scorer's value at which its consideration saturates (0.5 + 0.5 × linear(score, 0, full))
  threatBusyWeight: number; // threatMap: war-scorer bonus per unit of the rival's busyElsewhere
  threatVulnWeight: number; // threatMap: war-scorer penalty per Σ vulnerability / our troops
  threatPreRatio: number; // threatMap: theirs/ours on a segment at which a pre-positioned post is asked for
  buildCapGoldPerTroop: number; // buildSearch: gold-equivalent of one troop of cap in the objective (BuildSearch.CAP_GOLD_PER_TROOP)
  buildHorizon: number; // buildSearch: the opening/consolidate plan horizon in ticks (war capped at 4000, endgame at the 25:00 clock)
  retalRatio: number; // retaliateAware: the wave as the smaller attacker, × the target's troops
  drainRatio: number; // drainedNations: the wave on a drained nation, × its troops (affordable gate, scorer gate, size)
  drainBelow: number; // drainedNations: a nation under this × its max troops counts as drained (nations' reserveRatio lower bound)
  hystMargin: number; // hystRetreats: 'continue' must beat 'retreat' by this share
  hystSlope: number; // hystRetreats: ... plus this × clamp(maxBsr − 1, 0, 2) on the other borders
  hystStrikes: number; // hystRetreats: consecutive losing re-estimates before the wave comes home (int)
  strictOneWar: boolean; // a running counter occupies the second war slot: one war plus counters, but no second war (opportunity wars included) while a counter runs; default off until the 30-game Medium A/B
  boatsNearest: boolean; // every boat rule (seaExpansion, earlyBoat, huntBotsByBoat, seaInvasion) measures a candidate from the nearest of a sample of our ocean-shore tiles — where the engine launches from (SpatialQuery.closestShoreByWater) — instead of an arbitrary middle border tile; candidates are ranked value / max(1, d / 40) so a free shore 60 tiles away beats a richer target 200 away, and a shore across water may be as close as 10 tiles (was 30); default off until the 30-game Medium A/B
  finishByBoat: boolean; // every 100 ticks from tick 1200: when the war target (or a rival we have a wave on) owns a piece no land attack of ours can reach (Military.pieces with no border tile beside ours) and that piece has an ocean shore, a boat of 2 × its troops × (unreachable / total tiles) + 2000 (at most 40 % of spendable) lands on that piece's shore nearest our coast; one per target, 600-tick cooldown; default off until the 30-game Medium A/B
  annexWars: boolean; // Situation.annexable samples the target's border (ours-adjacent ≥ 40 %, third-party-or-unowned ≤ 15 %, a coast or map edge no longer disqualifies, never an ally) and an annexable unfriendly neighbour is a war opportunity in warPick (1.2× wave, scored 25 + ratio, passes the affordability / sticky / one-war gates); no alliance is requested from or accepted with an annexable player; default off until the 30-game Medium A/B
  lapseToAttack: boolean; // manageExpiries lets an ally lapse when Military.wouldTarget (the war scorer run as if it were unfriendly) accepts it and its score beats every current unfriendly candidate's, whatever the number of rivals; never while a stronger unfriendly neighbour (> 0.6× our troops) borders us unless the ally is annexable; default off until the 30-game Medium A/B
}

export const DEFAULT_PLAYBOOK: PlaybookParams = {
  expandContested: 0.2,
  expandFree: 0.1,
  expandEvery: 10,
  botRatio: 1.67,
  botMaxShare: 0.5,
  botEarlyShare: 0.15,
  botClickCap: 0.3, // 30-game lab: ties the single click on land, one more survivor; matches the guide's click table
  botFollowUpTicks: 100,
  botsAfterWild: false, // 2026-08-29 Hetzner sweeps, 20-min games: Medium 30-game A/B gate off beats on 14-7-9, median land 65k vs 37k, cities 70 vs 44, same survival; Hard 30-game A/B neutral (7-6-5). Tribes cost 2-3x more by 2:00 while free land never gets cheaper.
  boatAtTick: 50,
  boatShare: 0.2,
  islandMaxTiles: 20000,
  fightAbove: 0.7,
  fightRatio: 2.0, // Medium 30-game sweep hz3: 1.67× = +1 crown but −13% land, 3 fewer top-3, loses paired 13–17; the gate (attack whenever affordable, from 3:00) stays
  fightNotBeforeTick: 1800,
  fightMinCities: 2,
  fightMaxShare: 0.6,
  retreatBelowRatio: 0.4,
  capFullShare: 0.6,
  citiesBeforePort: 1,
  portMinPartnerDist: 300,
  allianceEvery: 300,
  portLevelBeforeSecond: 3,
  maxPortUnits: 8,
  seaFullShips: 400,
  railSpacing: 16,
  siloAtTick: 6000,
  bombEvery: 300,
  bombReserve: 250_000,
  reserveShare: 0.3,
  tribeConcurrency: 1,
  spawnInland: 0, // 30-game lab: 8 tiles inland = 18/30 alive vs 27/30 on the shore (an inland circle can be surrounded; the coast cannot)
  finishRule: true,
  endgameV2: true,
  portWithoutPartnerTick: 1500,
  nearbyEvery: 10, // 90-game Medium 20-min A/B (openfront-00, 2026-08-29): 5 and 10 are a wash vs 1 (14W/15L, 14W/16L; alive 29/29/30) while bot CPU per game drops 19.0 s → 5.3 s. Details: PlaybookBotLab.md "Where a game's time goes".
  trustWars: true, // kept 2026-08-29: ladder1 (45 paired 30-min games, shifted grid) trustWars+nationAware off = 11W-17L-17T vs on, dScore −0.06 [−0.19, +0.05], undecided; small positive mean, rarely fires — see PlaybookBotPlan.md Ladder
  nationAware: true, // kept with trustWars (see above)
  threatMap: false,
  threatReserveGain: 2,
  estLossScaleNation: 1.0, // uncalibrated until a sweep has been through calibrate.py
  estLossScaleHuman: 1.0,
  estLossScaleBot: 1.0,
  estSpeedScale: 1.0,
  hystRetreats: false, // default off until the 30-game Medium A/B (PlaybookBotPlan.md #4)
  markTargets: false, // default off until the 30-game Medium A/B
  wildernessAware: false, // default off until the 30-game Medium A/B
  drainedNations: false, // default off until the 30-game Medium A/B
  retaliateAware: false, // default off until the 30-game Medium A/B
  relationAware: false, // default off until the 30-game Medium A/B
  buildSearch: false, // default off until the 30-game Medium A/B
  steamrollCap: false,
  holdHumans: false,
  strictOneWar: false,
  boatsNearest: false, // default off until the 30-game Medium A/B
  finishByBoat: false, // default off until the 30-game Medium A/B
  utility: false, // default off until the 30-game Medium A/B
  utilCapMid: 0.7,
  utilCapSteep: 10,
  utilCommit: 1.5,
  utilFreeLandCost: 20,
  utilScoreFull: 15,
  threatBusyWeight: 3,
  threatVulnWeight: 2,
  threatPreRatio: 1.5,
  buildCapGoldPerTroop: 20,
  buildHorizon: 6000,
  retalRatio: 1.2,
  drainRatio: 1.5,
  drainBelow: 0.3,
  hystMargin: 0.1,
  hystSlope: 0.2,
  hystStrikes: 2,
  annexWars: false, // default off until the 30-game Medium A/B
  lapseToAttack: false, // default off until the 30-game Medium A/B
};
