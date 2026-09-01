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
// Removed after ab2 (PlaybookBotPlan.md #4): simWars, restored on the calibrated estimator and lost again (dScore −0.43 at 18 mirrored pairs; with hystRetreats −0.52) — in git history at a36b357b5.
// Pruned 2026-08-31 (branch bot/prune; last commit with the code: 38219433a) — flags that measured dead or harmful
// across the full-game A/Bs, each with its params, code paths, tests and docs section:
//   utility + Utility.ts + utilCapMid/utilCapSteep/utilCommit/utilFreeLandCost/utilScoreFull (ab1: noise, 53W/44L at best)
//   threatMap + ThreatMap.ts + threatReserveGain/threatBusyWeight/threatVulnWeight/threatPreRatio (ab1 −0.07, fix-era noise)
//   buildSearch + BuildSearch.ts + buildCapGoldPerTroop/buildHorizon (ab1 49W/50L; planner CPU)
//   hystRetreats + hystMargin/hystSlope/hystStrikes/retreatBelowRatio (ab2 REJECT −0.06)
//   webDefense + webRatio/webUntil + Situation.web (fix1: 1 live pair in 120 — never fires)
//   markTargets (ab1 41W/58L, 4 deaths vs 0)
//   wildernessAware, steamrollCap, holdHumans (never fire in the lab)
//   warRoiCap + warRoiMax/warRoiMinTiles/warRoiWindow/warRoiCooldown (fix1 70W vs base 78, leaning harmful)
//   the estimator layer: Estimate.ts, estOpts, the EST/ACT calibration log, estLossScaleNation/Human/Bot,
//   estSpeedScale, scripts/lab/calibrate.py — its last consumers were utility and hystRetreats (simWars already gone).
//   The WAR RESULT per-war accounting stays (warYield reads it; loss_analysis.py parses it).
// Pruned 2026-08-31 (branch bot/prune2; last commit with the code: 0a8f35bc4) — the flips1/nf1 shelf, each flag
// with its params, code paths, tests and docs section:
//   strictOneWar (flips1 SPRT REJECT −0.07)
//   relationAware + Rivals.wouldAcceptAlliance (the getAllianceDecision replay) + RivalView.relation (flips1 −0.31)
//   plateauBreak + plateauWindow/plateauGrowth + Military.plateauRule and the forced= plumbing (flips1 −0.14)
//   duelWaveGate + duelWaveRatio (nf1 SPRT REJECT at 1.8 and 1.9)
//   drainedNations + drainRatio/drainBelow + RivalView.drainedUntil (flips1 +0.01 — maps to no loss cluster)
//   retaliateAware + retalRatio + the shadow-wave logic and RivalView.largestAttacker (flips1 −0.07)
//   scripts/lab/valuefit.py (built for the removed buildSearch's value model; unused since)
// Hard candidates (kept default off — flat on Medium in flips1/nf1, but shaped for the Hard frontier, where SAM
// walls, MIRV exchanges and contested corridors actually decide games): boatEscort (+0.03), contestLeader (+0.00),
// samOnRisk (−0.07 alone, +0.011 beside mirvCounterforce), mirvCounterforce + cfCooldown (+0.003).
// Default-on flags: boatDedupe, takeFallout, steamrollLevels, boatsNearest, finishByBoat, multiWar, annexWars,
// lapseToAttack, trustWars, nationAware — and, since the combo A/B (2026-08-31, 68% vs 59% over 478 fresh-seed
// full games, p=0.030, PlaybookBotPlan.md 'Combo confirmed'), duelPush (@ duelRatio 1.0) and boatOpening
// (@ boatOwnMassFactor 0.146, boatEatRate 0.0245); the same A/B moved fightAbove 0.7→0.81, fightMaxShare
// 0.6→0.628, reserveShare 0.3→0.408, capFullShare 0.6→0.672, bombReserve 250_000→363_497.

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
  boatDedupe: boolean; // boat() refuses a destination within boatDedupeRadius tiles of a transport of ours still sailing or of a landing made in the last 300 ticks — the boat rules pick independently every 20–100 ticks and used to send a second boat at the same shore while the first was still at sea
  boatDedupeRadius: number;
  boatAtTick: number;
  boatShare: number;
  islandMaxTiles: number;
  boatOpening: boolean; // Josh's aggressive multi-boat opening: while tick < boatOpeningUntil the early-boat rule keeps up to boatOpeningCount transports alive at once (the plain rule sends one) — extras score shores by free land behind the landing per tile sailed (basin/sail, one candidate per landmass at its nearest shore, ×1.5 on a landmass we own no tile of) and every boat is capped at boatShare of home; inert on a small landmass (the island spawn already boats); default ON since the combo A/B (2026-08-31, PlaybookBotPlan.md 'Combo confirmed')
  boatOpeningCount: number; // boatOpening: transports kept alive at once while the opening runs (int)
  boatOpeningUntil: number; // boatOpening: the tick the opening ends at — the plain rules resume unchanged (int)
  boatBasinRadius: number; // boatOpening: manhattan radius of the free-land flood behind a candidate landing — the basin in the opening's basin/sail shore score (int)
  boatEatRate: number; // boatOpening v3: wilderness tiles a rival/tribe eats per tick per basin-perimeter tile it touches — a candidate's basin is discounted by eatRate × contact × sail (the transport sails 1 tile/tick, so sail = arrival ticks) before scoring, so a basin that will be gone before the boat lands loses to a nearer/safer pick (measured in one Medium lab game: nations and tribes both expand ~0.02 tiles/tick per border tile in the opening)
  boatTribeWorth: number; // boatOpening v3: what a tribe tile is worth in free-land tiles in the opening score — v2's 0.5 systematically undervalued tribes (Josh): their tiles cost the fight but never evaporate, unlike a contested basin
  boatOceanUntil: number; // boatOpening v3: while tick < this, opening extras may sail up to the full BOAT_MAX_PATH (250, not the 80-tile early cap) and a distant new-landmass candidate scores ×boatOceanBonus — long trans-ocean crossings are only safe before warships appear (measured: first enemy warship t1730, first enemy port t1060, one Medium lab game; int)
  boatOceanBonus: number; // boatOpening v3: score multiplier on a new-landmass candidate whose sail exceeds BOAT_MAX_PATH.early while the ocean window is open
  boatOpeningSailCost: number; // boatOpening v4: worth-tiles charged per sail tile beyond BOAT_MAX_PATH.early (80) — the opportunity cost of a long crossing (troops locked at sea, growth deferred), so "big but far and empty" loses to "smaller, near, growable" (the arctic-magnet fix, Josh's east-asia GUI session)
  boatOpeningMinScore: number; // boatOpening v4: tiles-per-sail-tick floor an EMPTY-SHORE opening candidate must clear or it is no target at ANY rank (the extras hold the boat) — the junk tail of basin<200 picks once good targets are taken; tribe candidates are exempt (their 2× wave is affordability-gated and takes real enemy tiles — far tribe junk dies to boatOpeningSailCost instead)
  boatOwnMassFactor: number; // boatOpening v5: score multiplier on an empty-shore opening candidate whose landmass is our OWN (a capped fill counts as own — conservative): land expansion reaches our own coast free, opening boats are for separate masses and tribes (exempt); not applied when the shore's basin is walled off from us by other players' land (openingCutOff — a cut-off peninsula behind a rival IS boat-worthy). Josh's russia/asia far-coast GUI finding
  fightAbove: number; // start fighting rivals when troops exceed this share of cap
  fightRatio: number; // attack size as multiple of the target's whole army
  fightNotBeforeTick: number; // no wars with nations/humans before this tick
  fightMinCities: number; // ... or before this many cities
  fightMaxShare: number; // never commit more than this share of home troops to one target
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
  nationAware: boolean; // C1: the expiry hold and the renewal gift use the nation attack rules (Rivals.couldAttackAtExpiry) instead of the 0.85× / 0.9× troop heuristics
  takeFallout: boolean; // expand into irradiated land: PlayerImpl.nearby() hides unowned fallout tiles, so `wilderness` is false when only fallout borders us and expand() never sends a click — yet a TerraNullius attack takes those tiles (at 2.5–5× the loss, conquest clears the fallout). With the flag on, an expand click goes at the contested share whenever unowned fallout land touches our border and troops are ≥ fightAbove × cap (idle troops are free); default off until the 30-game Medium A/B
  steamrollLevels: boolean; // the nations' steamroll MIRV rule counts city LEVELS (Player.unitCount sums unit.level()), not units: keep our city-level sum under 0.9 × mult × the runner-up's level sum (floor: the rule's minLeader) — no new city and no city level past it; spare gold goes to ports, rail, bombs, SAMs instead. Captures can still cross the line (nationMirvAware then buys SAM cover)
  boatsNearest: boolean; // every boat rule (seaExpansion, earlyBoat, huntBotsByBoat) measures a candidate from the nearest of a sample of our ocean-shore tiles — where the engine launches from (SpatialQuery.closestShoreByWater) — instead of an arbitrary middle border tile; candidates are ranked value / max(1, d / 40) so a free shore 60 tiles away beats a richer target 200 away, and a shore across water may be as close as 10 tiles (was 30); default off until the 30-game Medium A/B
  boatsWaterPath: boolean; // every boat rule (earlyBoat, huntBotsByBoat, seaExpansion, finishByBoat) ranks a candidate by the length of the water path the transport will sail (Military.waterPath: a breadth-first fill over water tiles from our sampled shore, ≤ 40k tiles, cached 100 ticks) instead of the straight-line distance, and refuses a landing whose path exceeds Military.BOAT_MAX_PATH for that rule (early 80, tribe 150, sea 200, finish 250); composes with boatsNearest on or off; default off until the 30-game Medium A/B
  boatsAfterCoast: boolean; // no early boat and no tribe boat while free land is still reachable by land on our own landmass (sit.wilderness or Situation.freeLandReachable) unless we start on a small landmass (islandMaxTiles): expand to the coast first, then boat; seaExpansion keeps its own wilderness gate, finishByBoat is unchanged; default off until the 30-game Medium A/B
  finishByBoat: boolean; // every 100 ticks from tick 1200: when the war target (or a rival we have a wave on) owns a piece no land attack of ours can reach (Military.pieces with no border tile beside ours) and that piece has an ocean shore, a boat of 2 × its troops × (unreachable / total tiles) + 2000 (at most 40 % of spendable) lands on that piece's shore nearest our coast; one per target, 600-tick cooldown; default off until the 30-game Medium A/B
  annexWars: boolean; // Situation.annexable samples the target's border (ours-adjacent ≥ 40 %, third-party-or-unowned ≤ 15 %, a coast or map edge no longer disqualifies, never an ally) and an annexable unfriendly neighbour is a war opportunity in warPick (1.2× wave, scored 25 + ratio, passes the affordability / sticky / one-war gates); no alliance is requested from or accepted with an annexable player; default off until the 30-game Medium A/B
  lapseToAttack: boolean; // manageExpiries lets an ally lapse when Military.wouldTarget (the war scorer run as if it were unfriendly) accepts it and its score beats every current unfriendly candidate's, whatever the number of rivals; never while a stronger unfriendly neighbour (> 0.6× our troops) borders us unless the ally is annexable; default off until the 30-game Medium A/B
  bombBudget: boolean; // a planned bomb fund: once we own a silo and maybeBomb has a target, Economy.build escrows the price of the NEXT planned bomb (Military.bombPlan: Hydrogen when the best cluster's owner has ≥ 8000 tiles and 5M is within ~90 s of income, else Atom) before every discretionary buy (city levels past the cap-needed ones, ports past the first, port levels, rail, warships, SAM level-ups); the hard overrides (a post where an attack lands, the first SAM under an enemy silo, the cap-needed city at capFullShare) still go first, and maybeBomb buys the planned bomb the moment gold covers it (no bombReserve add-on). Off = spend first, bomb with what is left above bombReserve (45 lab games: 1,071 atoms vs 7 hydrogens, first bomb ~9:00). Default off until the 30-game Medium A/B
  warYield: boolean; // per-war return accounting drives decisions: manageRetreats brings a war home when its measured cost over the last 200 ticks exceeds yieldMaxTroopsPerTile (unless the target is collapsed / annexable / the gap owner), and the war scorer adds 4 × clamp(1 − expectedCost / yieldMaxTroopsPerTile, 0, 1), expectedCost = the target's last measured troops/tile against us, else its density × 1.3 (Config.attackLogic's altAttackerLoss = 1.3 × defender density × mag/100); a target retreated from for its price is refused for 600 ticks unless it becomes an opportunity. The WAR RESULT log line is always on. Default off until the 30-game Medium A/B
  yieldMaxTroopsPerTile: number; // warYield: the running cost (troops lost per tile taken over the last 200 ticks) above which a war is retreated, and the scorer's zero point; 120 = 6 × free land's ~20 a tile
  nationMirvAware: boolean; // exploit the nations' MIRV rules (MirvRisk.ts) instead of triggering them: the 25:00 crown MIRV goes only at a target that cannot counter (no silo, or neither the live MIRV price nor a built MIRV); near the steamroll line (city LEVELS — the rule sums them — ≥ 0.9 × mult × the runner-up and > minLeader − 1) while a nation is armed (can fire, or a silo and half the price: it fires the tick it reaches the price), no new city or city level, SAM cover for every city unit is the top discretionary buy (levels to 3 first, price escrowed like the bomb fund) and a war target whose cities would carry us over the line is refused (unless it is the only MIRV-capable rival or an opportunity); in hold mode a war whose tiles would carry our share to the denial line − 0.01 is refused unless it removes the last threat. Default off until the 30-game Medium A/B
  samOnRisk: boolean; // rm1 loss analysis (2026-08-30, docs/PlaybookBotPlan.md): 19 of 41 base full-game losses were steamroll-rule MIRVs landing minutes AFTER our own `MIRV RISK steamroll` warning, with ~3 SAMs standing — while the rule is true against us and a nation is armed (MirvRisk.armed), Economy.build raises the wall: a launcher per 4 city units (min 2) at 300-tick spacing, every launcher levelled to 3, a second silo (the counter MIRV), and the next launcher/silo price is escrowed out of every discretionary buy like the bomb fund; default off until the full-game A/B
  mirvCounterforce: boolean; // combo loss analysis (2026-08-31, docs/PlaybookBotPlan.md): 24 of 71 losses were MIRVed down after leading while the bot fired ZERO MIRVs in 239 full games — while a MirvRisk rule (steamroll / denial) is TRUE against us and MirvRisk names armed or saving rivals, strike the SOURCE (Military.counterforce): our MIRV at the most-armed rival when we hold a silo and the price and maybeMIRV's own rules held this pass (with `nationMirvAware` never at a rival that can counter), else a hydrogen bomb on the rival's SILO (SAM umbrellas, the 105-tile friend clearance and the engine's collateral rule still respected; the plain rule's 8000-tile owner gate is relaxed — the silo is the target, not the land). The bomb / MIRV reserves stay; `samOnRisk`'s defensive wall is a separate flag. Default off until the full-game A/B
  cfCooldown: number; // mirvCounterforce: ticks between counterforce launches (int)
  clockTicks: number; // the game clock the timed rules assume (18000 = the 30-minute public game): the endgame posture (phase 'endgame', a second war at cap, 1.2× waves and 70 % sends, no buy that cannot pay back — seaFull) starts 3000 ticks before it; 0 = an open-ended game (the lab's MIN=full, which runs until someone wins): the timed gates never fire and the endgame phase comes from the rank / enemy-silo test alone
  contestLeader: boolean; // loss cluster 2 (rm1: 13/41 losses ended rank 2–3 while the winner ran to 80 % and we boated 1,500-tile weaklings): while we are rank ≤ contestRank by tiles among non-bots, the leader is not us or a friend, its tiles exceed contestLeadRatio × ours and it is still growing (two tile samples 300 ticks apart), the boats seaExpansion / huntBotsByBoat already send are re-aimed from "weak X" / tribe targets at the leader's coastline (its ports/cities shore, same sizes and gates), maybeBomb / maybeMIRV treat the leader as a priority target like `threats`, and the war scorer adds +4 when it borders us; redirects targets, never sizes. Default off until the 30-game Medium A/B
  contestRank: number; // contestLeader: contest only while our tile rank among non-bot players is ≤ this (int)
  contestLeadRatio: number; // contestLeader: the leader's tiles must exceed this × ours
  multiWar: boolean; // a second and third simultaneous war (a running counter occupies a slot) when the next wave is affordable above the reserve and the total committed stays under fightMaxShare of the army; the sticky target applies to the first war only; tribes: concurrency 2 (+1 above 60 % of cap) and up to three first clicks per pass while the next is affordable. Default off until the 30-game Medium A/B
  duelPush: boolean; // finish a won duel (GUI 2026-08-30: two non-bot players left, us at 38 % of the land with 13.3M troops vs 7.55M, and the bot spent 10+ minutes requesting alliances with its only rival — the finish rule's push needs 45 % of the map and requestAlliances courts the sole rival forever): while the living non-bot, non-teammate players are ≤ duelPlayers (us included) and our troops are ≥ duelRatio × the strongest other's (the foe), Diplomacy never asks, accepts or renews an alliance with the foe (an existing one lapses through the planned-target mechanism, never a betrayal), the mode is `push` whatever our share (hold still wins: a MIRV-capable foe over the denial line fires whatever we do), the war rule takes the foe as an opportunity at duelRatio (no affordability / fightAbove gate, the war-count invariant lets it run beside counters, the posts / thin-empire gates do not apply — it is the only target left) with a duelRatio wave, and bombs / MIRV take the foe as a priority target like the threats. Behind (troops < duelRatio × the foe's) nothing changes — the flag finishes a won game. Default ON since the combo A/B (2026-08-31, PlaybookBotPlan.md 'Combo confirmed')
  duelPlayers: number; // duelPush: a duel while the living non-bot, non-teammate players (us included) number at most this (int)
  duelRatio: number; // duelPush: our troops over the foe's from which the duel counts as won — and the ratio the duel war is sent at
  boatDefense: boolean; // Josh (Hard GUI, 2026-08-31): the bot has no reaction to enemy amphibious play. Every 20 ticks scan enemy (non-friendly) transports whose landing (unit.targetTile() — the engine stores the landing tile on the transport, and the ship sails ~1 water tile/tick, so distance ≈ eta) is within bdCoastRange of our border: log `BOAT INBOUND`, and (1) ask Economy for a defense post covering the landing zone when one can finish before the boat lands (the existing ≤8-post budget, right after the attack-landing post); (2) a landed beachhead — the blob at a watched landing, ≤ bdBeachheadMax tiles, touching our border — is counter-waved once per attacker at 1.05× the troops that landed, through the counter path (send "counter": bypasses fightAbove/hold like counters) but NOT auto-retreated like one (it runs until the beachhead is gone or we are losing); (3) a transport bound for a TRIBE bordering us (or on our landmass) is raced — we click the tribe NOW with harvestBots sizing and affordability, jumping the concurrency queue (`TRIBE RACE`; a same-landmass tribe with no shared border is logged, not clicked — a land click cannot connect). Default off until the full-game A/B
  bdCoastRange: number; // boatDefense: a landing within this many tiles of our (sampled) border concerns us (int)
  bdBeachheadMax: number; // boatDefense: counter-wave a landed enemy blob only while it is at most this many tiles — bigger is established, the generic counter/war machinery's problem (int)
  boatEscort: boolean; // Josh (GUI): "moving warships to corridors where it's trying to place a boat so it can get across". Engine facts (WarshipExecution/ShellExecution): a warship shells every enemy transport within warshipTargettingRange (130) with no reload against transports and a homing one-shot shell, so a transport whose path passes within 130 of a live enemy warship is sunk, escorted or not — an escort cannot screen it, it can only CLEAR the corridor (1000 HP, ~262 a shell per 20 ticks, the threat retreats at 75 % and stops firing once docked). So from escortFromTick a crossing longer than escortMinSail whose corridor (Military.corridor: the water path, else the straight line) has a live enemy warship within escortThreatRange is HELD, our idle warship nearest the threat is moved (MoveWarshipExecution) to the corridor point nearest it (or one is bought there — escortBuy, under escortMaxShips, behind the funds), and the crossing sails on a later pass once the corridor is clear; a worthy target (an opening pick scoring ≥ 2× boatOpeningMinScore, a contest / duel boat) with no escort possible — or held escortDeferTicks — swarms escortSwarm staggered boats instead (Josh: "try multiple boats"; note the no-reload rule means a swarm only gets through what the threat has not yet reached). Short hops sail as before. Default off until the full-game A/B
  escortMinSail: number; // boatEscort: a crossing longer than this (sail tiles) is checked for warships (int)
  escortFromTick: number; // boatEscort: no escort logic before this tick — a little before the first enemy warships (measured t1730; int)
  escortThreatRange: number; // boatEscort: an enemy warship within this many tiles of a corridor tile contests it (the engine sinks from 130; int)
  escortBuy: boolean; // boatEscort: buy a warship for a contested corridor when no idle one exists (Economy.build, behind the funds)
  escortMaxShips: number; // boatEscort: no escort purchase while we own this many warships (int)
  escortSwarm: number; // boatEscort: transports a worthy contested crossing is split into (same total troops, each ≥ 500, one rule pass apart; int)
  escortDeferTicks: number; // boatEscort: ticks a corridor is held before a worthy crossing swarms anyway, and the life of a purchase request (int)
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
  boatDedupe: true, // ON by default 2026-08-30 (a correctness fix seen in the GUI: two boats to one shore; A/B as a removal, {"boatDedupe":false} vs {})
  boatDedupeRadius: 40,
  boatAtTick: 50,
  boatShare: 0.2,
  islandMaxTiles: 20000,
  boatOpening: true, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  boatOpeningCount: 2,
  boatOpeningUntil: 3000,
  boatBasinRadius: 100,
  boatEatRate: 0.0245, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  boatTribeWorth: 1.0, // a mid-size tribe mass beats an equal-size contested wilderness (v2 hardcoded 0.5)
  boatOceanUntil: 1500, // first enemy warship at t1730 in the measurement game — cross the ocean before that
  boatOceanBonus: 1.3,
  boatOpeningSailCost: 8, // at sail 150 a candidate forfeits 560 worth-tiles: the 100-tile junk crossings die, a genuinely rich far basin still clears it
  boatOpeningMinScore: 4, // ~80 discounted tiles for a short hop (sail floor 20), ~600 for a 150-tile crossing
  boatOwnMassFactor: 0.146, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  fightAbove: 0.81, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  fightRatio: 2.0, // Medium 30-game sweep hz3: 1.67× = +1 crown but −13% land, 3 fewer top-3, loses paired 13–17; the gate (attack whenever affordable, from 3:00) stays
  fightNotBeforeTick: 1800,
  fightMinCities: 2,
  fightMaxShare: 0.628, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  capFullShare: 0.672, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  citiesBeforePort: 1,
  portMinPartnerDist: 300,
  allianceEvery: 300,
  portLevelBeforeSecond: 3,
  maxPortUnits: 8,
  seaFullShips: 400,
  railSpacing: 16,
  siloAtTick: 6000,
  bombEvery: 300,
  bombReserve: 363_497, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  reserveShare: 0.408, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  tribeConcurrency: 1,
  spawnInland: 0, // 30-game lab: 8 tiles inland = 18/30 alive vs 27/30 on the shore (an inland circle can be surrounded; the coast cannot)
  finishRule: true,
  endgameV2: true,
  portWithoutPartnerTick: 1500,
  nearbyEvery: 10, // 90-game Medium 20-min A/B (openfront-00, 2026-08-29): 5 and 10 are a wash vs 1 (14W/15L, 14W/16L; alive 29/29/30) while bot CPU per game drops 19.0 s → 5.3 s. Details: PlaybookBotLab.md "Where a game's time goes".
  trustWars: true, // kept 2026-08-29: ladder1 (45 paired 30-min games, shifted grid) trustWars+nationAware off = 11W-17L-17T vs on, dScore −0.06 [−0.19, +0.05], undecided; small positive mean, rarely fires — see PlaybookBotPlan.md Ladder
  nationAware: true, // kept with trustWars (see above)
  takeFallout: true, // ON by Josh's call 2026-08-30 (A/B as a removal, {"takeFallout":false} vs {})
  steamrollLevels: true, // ON by default 2026-08-30: the 30-min africa baseline sat at 27 vs 22.5 by 9:30 and 101 vs 37.5 by 13:00 and every MIRV it took was this rule; A/B as a removal, {"steamrollLevels":false} vs {}
  boatsNearest: true, // ON by Josh's call 2026-08-30 after watching the GUI (not yet A/B'd: run as a removal, {"boatsNearest":false} vs {})
  finishByBoat: true, // ON by Josh's call 2026-08-30 after watching the GUI (not yet A/B'd: run as a removal, {"finishByBoat":false} vs {})
  nationMirvAware: false, // default off until the 30-game Medium A/B
  samOnRisk: false, // default off until the full-game A/B (rm1 follow-up)
  mirvCounterforce: false, // default off until the full-game A/B (combo loss-analysis follow-up)
  cfCooldown: 600,
  clockTicks: 18000, // the 30-minute public game; tests/lab/playbook.lab.ts sets 0 for MIN=full
  multiWar: true, // ON by Josh's call 2026-08-30 after watching the GUI (not yet A/B'd: run as a removal, {"multiWar":false} vs {})
  contestLeader: false, // default off until the 30-game Medium A/B
  contestRank: 3,
  contestLeadRatio: 1.5,
  duelPush: true, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  duelPlayers: 2,
  duelRatio: 1.0, // combo defaults 2026-08-31: 68% vs 59% over 478 fresh-seed full games, p=0.030 (PlaybookBotPlan.md 'Combo confirmed')
  boatsWaterPath: false, // OFF again 2026-08-30: rm1 (96 mirrored full games, wins objective, docs/PlaybookBotPlan.md) — removal won 63/96 vs base 48 (p=0.032); the water-path ranking hurts full games
  boatsAfterCoast: false, // default off until the 30-game Medium A/B
  bombBudget: false, // default off until the 30-game Medium A/B
  warYield: false, // default off until the 30-game Medium A/B
  yieldMaxTroopsPerTile: 120,
  annexWars: true, // ON by Josh's call 2026-08-30 after watching the GUI (not yet A/B'd: run as a removal, {"annexWars":false} vs {})
  lapseToAttack: true, // ON by Josh's call 2026-08-30 after watching the GUI (not yet A/B'd: run as a removal, {"lapseToAttack":false} vs {})
  boatDefense: false, // default off until the full-game A/B (Hard GUI follow-up)
  bdCoastRange: 30,
  bdBeachheadMax: 800,
  boatEscort: false, // default off until the full-game A/B
  escortMinSail: 60,
  escortFromTick: 1200,
  escortThreatRange: 130, // = Config.warshipTargettingRange: inside it the transport is sunk, outside it is not
  escortBuy: true,
  escortMaxShips: 2,
  escortSwarm: 3,
  escortDeferTicks: 600,
};
