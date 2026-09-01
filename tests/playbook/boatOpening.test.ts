// Flag `boatOpening` (docs/PlaybookBotPlan.md "Aggressive multi-boat opening"): while tick < boatOpeningUntil the
// early-boat rule keeps up to boatOpeningCount transports alive at once instead of the single early boat, the
// extras picked by earlyBoat's own scorer with an open shore on a landmass we own no tile of preferred.
//
// Geometry (the world test map, Bab-el-Mandeb, as tests/playbook/boats.test.ts): the Red Sea runs diagonally from
// about (1148, 396) to (1176, 436) with Africa west of it and Arabia east; a 4–6-tile channel separates them. Our
// rect on Africa's east bank has Arabia's free coast — a second continent — a short sail across the strait.
import { describe, expect, test } from "vitest";
import { BOAT_MAX_PATH } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Difficulty, Game, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { conquerRect, PlaybookHarness, playbookSetup, PRE_COMBO, Rect, RivalSpec } from "../util/PlaybookSetup";

// pin the defaults the fixture depends on (other tests do the same with their PRE_CMA/boats pins)
const QUIET: Partial<PlaybookParams> = { ...PRE_COMBO,
  expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false,
  takeFallout: false, finishByBoat: false, boatsWaterPath: false, boatsNearest: true, boatDedupe: true,
  boatDedupeRadius: 40, boatAtTick: 50, boatShare: 0.2, islandMaxTiles: 20000, boatOpeningCount: 2, boatOpeningUntil: 3000,
};
const ME: Rect = [1120, 396, 1150, 445]; // Africa's Red Sea bank, coast at y 396–407
const SPAWN: [number, number] = [1135, 420];

/** Does the landmass under `t` hold a tile of ours? Bounded flood over land — the strait keeps the fill honest. */
function ownsLandmass(game: Game, me: Player, t: TileRef, cap = 3000): boolean {
  const seen = new Set<TileRef>([t]);
  const q: TileRef[] = [t];
  let i = 0;
  while (i < q.length && seen.size < cap) {
    const c = q[i++];
    if (game.owner(c) === me) return true;
    for (const n of game.neighbors(c)) if (!seen.has(n) && game.isLand(n)) { seen.add(n); q.push(n); }
  }
  return false;
}

describe("boatOpening", () => {
  test("on: two boats are out by tick 200 and one targets the other landmass; the extra logs BOAT OPENING and fires", async () => {
    const h = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET, boatOpening: true } });
    // collect each distinct transport target the moment it is at sea (before its landing gives us tiles over there)
    const targets: { tile: TileRef; newLandmass: boolean }[] = [];
    const two = h.until(() => {
      for (const u of h.me.units(UnitType.TransportShip)) {
        const d = u.targetTile();
        if (d !== undefined && !targets.some((x) => x.tile === d)) targets.push({ tile: d, newLandmass: !ownsLandmass(h.game, h.me, d) });
      }
      return targets.length >= 2;
    }, 300);
    expect(two).toBe(true);
    expect(h.game.ticks()).toBeLessThanOrEqual(200); // boat 1 ~t60 (boatAtTick 50), the extra on the next 20-tick pass
    expect(targets.some((x) => x.newLandmass)).toBe(true); // a second-continent beachhead (Arabia, across the strait)
    const line = h.log.find((l) => l.includes("BOAT OPENING"))!;
    expect(line).toMatch(/BOAT OPENING \d\/2 out → /);
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
    // every opening boat stays within boatShare of home plus the reserve invariant (ctx.boat): 100k troops → ≤ ~20k + growth
    for (const u of h.me.units(UnitType.TransportShip)) expect(u.troops()).toBeLessThanOrEqual(Math.ceil(h.me.troops() * 0.35) + 500);
  });

  test("off: the plain bot sends exactly one early boat and never logs BOAT OPENING", async () => {
    const h = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET } });
    h.until(() => h.game.ticks() >= 550, 600); // stop before seaExpansion's tick-600 start: only the early-boat rule can launch
    expect(h.log.filter((l) => l.includes("early boat")).length).toBe(1);
    expect(h.log.some((l) => l.includes("BOAT OPENING"))).toBe(false);
    expect(h.bot.fired.get("boatOpening")).toBeUndefined();
  });

  test("after boatOpeningUntil the extras stop: every BOAT OPENING launch is before the cutoff", async () => {
    const h = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET, boatOpening: true, boatOpeningUntil: 200 } });
    h.until(() => h.game.ticks() >= 550, 600);
    const opening = h.log.filter((l) => l.includes("BOAT OPENING"));
    expect(opening.length).toBeGreaterThanOrEqual(1);
    for (const l of opening) expect(Number(/^t(\d+) /.exec(l)![1])).toBeLessThan(200);
    // and no early-boat launch at all after the cutoff (boatSent is long true; the plain rule sent its one boat)
    for (const l of h.log.filter((x) => /^t\d+ boat .*early boat/.test(x))) expect(Number(/^t(\d+) /.exec(l)![1])).toBeLessThan(200);
  });

  // ---- v2 fixtures ------------------------------------------------------------------------------------
  // Okhotsk strait (found by scanning the world test map): mainland coast to x1601, a 156-tile island at
  // 1602..1613 × 356..377 across a ~5-tile strait, its far coast ~20 tiles further down. Bab-el-Mandeb as
  // above for the basin test (Arabia's huge free coast ~16 tiles across the Red Sea; the Red Sea islets
  // near the African bank are ≤ 30 tiles).
  const ME_STRAIT: Rect = [1560, 325, 1601, 377];
  const SPAWN_STRAIT: [number, number] = [1580, 350];
  // v2 pins on top of QUIET: the flag on, boatDedupe off (the plain first boat lands on the same island and
  // its 40-tile dedupe would veto the near shore the test is about), the new basin radius pinned.
  const V2: Partial<PlaybookParams> = { ...QUIET, boatOpening: true, boatDedupe: false, boatBasinRadius: 100 };
  // Passive nation that owns every competing across-water mass in the strait's scan window (island chains
  // further out that the basin/sail score would rightly prefer — these tests are about the strait geometry).
  const BLOCKER: RivalSpec = { name: "Blocker", type: PlayerType.Nation, at: [1450, 200], troops: 5000, tiles: [1445, 195, 1455, 205] };
  function blockOcean(h: PlaybookHarness): void {
    const b = h.rival("Blocker");
    conquerRect(h.game, b, [1614, 125, 1801, 377]); // east: Kuril-side chains
    conquerRect(h.game, b, [1602, 125, 1801, 355]); // north-east coast (a 40-tile scrap at ~1610,271 otherwise wins the scan)
    conquerRect(h.game, b, [1560, 125, 1601, 324]); // mainland north of our rect: its far coast at ~80 tiles saturates acrossWaterNear's 4000-tile cap and reads as across-water, and its basin is huge
    // south: Hokkaido-side chains — minus a free ~8-tile islet at 1612..1613 × 383..387, the PLAIN boat's bait:
    // it launches there at t60 (dm ~30, a long sail), so the extras run from t80 with the island untouched and
    // no timing race against the plain landing (a beachhead on the island would make acrossWaterNear refuse it)
    conquerRect(h.game, b, [1500, 378, 1610, 390]);
    conquerRect(h.game, b, [1614, 378, 1801, 390]);
    conquerRect(h.game, b, [1500, 391, 1801, 580]);
    conquerRect(h.game, b, [1360, 125, 1559, 600]); // west+north: the rest of the mainland (also kills the wilderness distraction)
  }
  /** Transport targets by the tick first seen, run until a BOAT OPENING launch matching `match` settles.
   *  `clamp` runs every tick — the fixtures use it to pin a passive tribe's troops (tribes grow about as fast
   *  as we do, so no want-gate would otherwise separate the plain rule from the extras deterministically). */
  function watchOpening(h: PlaybookHarness, max = 400, opts: { clamp?: () => void; match?: (l: string) => boolean } = {}): Map<TileRef, number> {
    const seen = new Map<TileRef, number>();
    const match = opts.match ?? ((l: string) => l.includes("BOAT OPENING"));
    let foundTick = -1;
    h.until(() => {
      opts.clamp?.();
      for (const u of h.me.units(UnitType.TransportShip)) { const d = u.targetTile(); if (d !== undefined && !seen.has(d)) seen.set(d, h.game.ticks()); }
      if (foundTick < 0 && h.log.some((l) => match(l))) foundTick = h.game.ticks();
      return foundTick >= 0 && h.game.ticks() > foundTick + 2; // a couple more ticks so the extra's unit exists
    }, max);
    return seen;
  }
  const openingLine = (h: PlaybookHarness) => {
    const line = h.log.find((l) => l.includes("BOAT OPENING"))!;
    expect(line).toBeDefined();
    const m = /basin=(\d+) sail=(\d+)/.exec(line)!;
    return { tick: Number(/^t(\d+) /.exec(line)![1]), basin: Number(m[1]), sail: Number(m[2]), line };
  };

  // A tiny bait tribe on the carved islet: the plain first boat takes it (the only thing its gates allow) and
  // sails ~30 tiles, so the opening extras run from t80 with the island untouched — no timing race against a
  // plain landing (a beachhead on the island would make acrossWaterNear refuse the rest of its shores).
  const BAIT: RivalSpec = { name: "Bait", type: PlayerType.Bot, at: [1612, 385], troops: 1000, tiles: [1611, 383, 1614, 388] };

  const isIsland = (l: string) => l.includes("BOAT OPENING") && l.includes("tribe IslandTribe");
  const islandLine = (h: PlaybookHarness) => {
    const line = h.log.find(isIsland)!;
    expect(line).toBeDefined();
    const m = /basin=(\d+) sail=(\d+)/.exec(line)!;
    return { tick: Number(/^t(\d+) /.exec(line)![1]), basin: Number(m[1]), sail: Number(m[2]), line };
  };

  test("v2: an island across a tiny strait is landed at its NEAR shore, never far up its coast", async () => {
    // Josh's Japan/Sakhalin case. The island is one big tribe (clamped at 8k: its 2× wave stays above the plain
    // rule's 0.4×home gate while home troops are small, so the plain single boat goes to the bait and every
    // later boat is the extras'); its shores span sail ~4 at the strait to ~25 down the coast, and the opening
    // must pick the strait shore.
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 3_000,
      rivals: [BLOCKER, BAIT, { name: "IslandTribe", type: PlayerType.Bot, at: [1607, 368], troops: 8_000, tiles: [1602, 356, 1613, 377] }],
      bot: { ...V2, boatShare: 1.0 },
    });
    blockOcean(h);
    const tribe = h.rival("IslandTribe"), bait = h.rival("Bait");
    const clamp = () => { if (tribe.troops() > 8000) tribe.setTroops(8000); if (bait.troops() > 400) bait.setTroops(400); };
    const seen = watchOpening(h, 600, { clamp, match: isIsland });
    const o = islandLine(h);
    expect(o.sail).toBeLessThanOrEqual(8); // the shore right across the strait — never a far landing up the coast
    const extras = [...seen].filter(([, tk]) => tk >= o.tick && tk <= o.tick + 3).map(([t]) => t);
    expect(extras.length).toBeGreaterThanOrEqual(1);
    // the transport's dst is engine-adjusted from the picked shore (targetTransportTile), so only rule out the far tail
    for (const t of extras) { expect(h.game.x(t)).toBeGreaterThanOrEqual(1602); expect(h.game.y(t)).toBeLessThanOrEqual(372); }
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
  });

  test("v2: a large wilderness mass slightly farther beats nearer scraps (basin/sail scoring)", async () => {
    // Africa's Red Sea bank: tiny islets a couple of tiles offshore (≤ 30 tiles), Arabia's huge free coast ~16
    // tiles across. Distance ranking took the nearest new-mass scrap; the basin score must take Arabia.
    const h = await playbookSetup({ map: "world", spawn: SPAWN, tiles: [1120, 396, 1154, 445], troops: 100_000, bot: { ...V2 } });
    const seen = watchOpening(h);
    const o = openingLine(h);
    expect(o.basin).toBeGreaterThanOrEqual(1000); // Arabia-sized free land behind the landing, not an islet
    const extras = [...seen].filter(([, tk]) => tk >= o.tick && tk <= o.tick + 3).map(([t]) => t);
    for (const t of extras) {
      const x = h.game.x(t), y = h.game.y(t);
      expect(x >= 1155 && x <= 1160 && y >= 411 && y <= 416).toBe(false); // the Red Sea islet
      expect(x >= 1166 && x <= 1169 && y >= 406 && y <= 411).toBe(false); // the coastal sliver
    }
  });

  test("v2: a big tribe mass across the strait beats a small contested free basin (tribe candidates score tiles + basin)", async () => {
    // The whole island is one big tribe (clamped at 8k) with a rival nation on it (contested — its wilderness
    // is being eaten). The plain single boat can only take the bait; the extras' scored passes must pick the
    // big tribe mass — 0.5 × ~200 tiles × 1.5 contested per tile sailed dwarfs everything else in the window.
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 3_000,
      rivals: [
        BLOCKER,
        BAIT,
        { name: "IslandTribe", type: PlayerType.Bot, at: [1607, 368], troops: 8_000, tiles: [1602, 356, 1613, 377] },
        { name: "Contester", type: PlayerType.Nation, at: [1606, 374], troops: 5000, tiles: [1604, 372, 1613, 377] },
      ],
      bot: { ...V2, boatShare: 1.0 },
    });
    blockOcean(h);
    const tribe = h.rival("IslandTribe"), bait = h.rival("Bait");
    const clamp = () => { if (tribe.troops() > 8000) tribe.setTroops(8000); if (bait.troops() > 400) bait.setTroops(400); };
    watchOpening(h, 600, { clamp, match: isIsland });
    const o = islandLine(h);
    expect(o.sail).toBeLessThanOrEqual(8); // the strait shore of the tribe, not a far one
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
  });

  test("v2: a tribe that eats the landing before the wave finishes gets clicked from the beachhead (opening push)", async () => {
    // The boats sail for the island's free shore; while they are at sea a tribe conquers the whole island.
    // The transports' waves target the LAUNCH-time owner (terra nullius) and fizzle — the next opening pass
    // must re-click the tribe from the beachhead instead of stranding it. botMaxShare 0.05 mutes harvestBots
    // (its affordability gate) so the test isolates the push, which deliberately has no such gate: the boat is
    // already committed, botClickCap and the reserve are its limits.
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 50_000,
      rivals: [BLOCKER, { name: "Eater", type: PlayerType.Bot, at: [1300, 300], troops: 2500, tiles: [1295, 295, 1305, 305] }],
      bot: { ...V2, botMaxShare: 0.05 },
    });
    blockOcean(h);
    const eater = h.rival("Eater");
    const launched = h.until(() => h.me.units(UnitType.TransportShip).length > 0, 120); // the first boat, aimed at the free island (target: terra nullius)
    expect(launched).toBe(true);
    conquerRect(h.game, eater, [1602, 356, 1616, 380]); // the tribe eats the island while the boat is at sea (island only: the mainland reaches x1602 at y354-355)
    const pushed = h.until(() => h.log.some((l) => l.includes("BOAT OPENING push → tribe Eater")), 300);
    expect(pushed).toBe(true);
    const attacking = h.until(() => h.me.outgoingAttacks().some((a) => a.target() === eater), 50);
    expect(attacking).toBe(true);
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1); // the push is a fire site
  });

  // ---- v3 fixtures ------------------------------------------------------------------------------------
  // Okhotsk again, with fixture geometry checked against the empty-shore scan's 6-tile grid (a free mass is
  // invisible to the opening unless the grid lands on one of its shore tiles - probed offline):
  //  - the far target: the big mass south-west of the strait (probe: 2324 tiles), whose free carve
  //    1545..1599 x 465..509 keeps a grid shore hit at 1556,493 at water-path ~100-160 - past the 80-tile
  //    early cap, inside the full 250. The blocker owns the carve's west and south rims (contact > 0).
  //  - the near safe picks: a small tribe on the island's north half (tribes are border-scanned, grid-proof)
  //    and the free 118-tile mass at 1585,435..1604,463 (grid hits 1598,445 and 1586,463, water-path ~70 -
  //    inside the early cap, and the plain first boat's landing).
  function blockFar(h: PlaybookHarness): void {
    const b = h.rival("Blocker");
    conquerRect(h.game, b, [1614, 125, 1801, 377]); // east: Kuril-side chains
    conquerRect(h.game, b, [1602, 125, 1801, 355]); // north-east coast
    conquerRect(h.game, b, [1560, 125, 1601, 324]); // mainland north of our rect
    conquerRect(h.game, b, [1500, 378, 1610, 390]); // Hokkaido-side chains
    conquerRect(h.game, b, [1614, 378, 1801, 390]);
    conquerRect(h.game, b, [1500, 391, 1801, 464]); // everything between the strait and the carve
    conquerRect(h.game, b, [1500, 465, 1538, 580]); // west of the carve
    conquerRect(h.game, b, [1600, 465, 1801, 580]); // east of the carve
    conquerRect(h.game, b, [1539, 510, 1599, 580]); // the carve's south rows: the eater on the free basin's rim
    conquerRect(h.game, b, [1360, 125, 1544, 600]); // west continent + mainland (NOT x1545+: the carve stays free)
  }
  // the island split into two clamped tribes: the plain first boat eats one, the extras always have the other —
  // tribes are border-scanned (grid-proof) and sail ~2-8, well under the early cap
  const NEAR_TRIBES: RivalSpec[] = [
    { name: "NearTribeA", type: PlayerType.Bot, at: [1607, 360], troops: 1_000, tiles: [1602, 356, 1613, 364] },
    { name: "NearTribeB", type: PlayerType.Bot, at: [1607, 372], troops: 1_000, tiles: [1602, 365, 1613, 377] },
  ];
  // v6: the opening prices by the water path on its own; boatsWaterPath stays pinned on so the PLAIN first
  // boat keeps the fixture timing these tests were built with (it is the only rule the pin still moves here)
  const V3_OCEAN: Partial<PlaybookParams> = { ...V2, boatsWaterPath: true, boatEatRate: 0.02, boatTribeWorth: 1.0, boatOceanBonus: 1.3 };
  const sailOf = (l: string) => Number(/sail=(\d+)/.exec(l)![1]);
  const isFar = (l: string) => l.includes("BOAT OPENING") && / sail=\d+/.test(l) && sailOf(l) > BOAT_MAX_PATH.early;
  const isNear = (l: string) => l.includes("BOAT OPENING") && l.includes("tribe NearTribe");
  const oceanSetup = (bot: Partial<PlaybookParams>) => playbookSetup({ map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 100_000, rivals: [BLOCKER, ...NEAR_TRIBES], bot });
  /** Run until `stop`, clamping the near tribes (they must stay affordable and constant across configs). */
  function runOcean(h: PlaybookHarness, stop: () => boolean, max: number): boolean {
    const tribes = [h.rival("NearTribeA"), h.rival("NearTribeB")];
    return h.until(() => { for (const t of tribes) if (t.isAlive() && t.troops() > 1000) t.setTroops(1000); return stop(); }, max);
  }

  test("v3/v6: with the sail budget open (rampTicks 1) the rich carve at water-path ~100+ beats the near tribe", async () => {
    const h = await oceanSetup({ ...V3_OCEAN, boatSailRampTicks: 1 });
    blockFar(h);
    expect(runOcean(h, () => h.log.some(isFar), 500)).toBe(true);
    const line = h.log.find(isFar)!;
    expect(Number(/eta=(\d+)/.exec(line)![1])).toBe(sailOf(line)); // the transport sails 1 tile/tick: eta = sail
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
  });

  test("v3/v6: a budget pinned at the early cap holds - the extras take a near tribe, nothing sails past the cap", async () => {
    const h = await oceanSetup({ ...V3_OCEAN, boatSailMin: BOAT_MAX_PATH.early, boatSailRampTicks: 1_000_000_000 }); // maxSail stays 80 for the whole run (v3's closed window)
    blockFar(h);
    expect(runOcean(h, () => h.log.some((l) => l.includes("BOAT OPENING")), 500)).toBe(true);
    for (const l of h.log.filter((x) => x.includes("BOAT OPENING") && / sail=\d+/.test(x))) expect(sailOf(l)).toBeLessThanOrEqual(BOAT_MAX_PATH.early);
    expect(h.log.some(isNear)).toBe(true);
  });

  test("v3: ETA discount - the contested carve at long sail loses to the near tribe when boatEatRate is high, wins at 0", async () => {
    // Same carve, window open both times. At boatEatRate 2.0 the ~100-tick sail forfeits the whole basin
    // (2.0 x contact x sail >> basin, the eaters on its west and south rims), so the extras take the near
    // tribe instead; at 0 the far crossing wins as in the window test.
    const safe = await oceanSetup({ ...V3_OCEAN, boatSailRampTicks: 1, boatEatRate: 2.0 });
    blockFar(safe);
    expect(runOcean(safe, () => safe.log.some((l) => l.includes("BOAT OPENING")), 500)).toBe(true);
    for (const l of safe.log.filter((x) => x.includes("BOAT OPENING") && / sail=\d+/.test(x))) expect(sailOf(l)).toBeLessThanOrEqual(BOAT_MAX_PATH.early);
    expect(safe.log.some(isNear)).toBe(true); // the safer pick: tribes don't evaporate
    const greedy = await oceanSetup({ ...V3_OCEAN, boatSailRampTicks: 1, boatEatRate: 0 });
    blockFar(greedy);
    expect(runOcean(greedy, () => greedy.log.some(isFar), 500)).toBe(true); // discount off: the same basin is taken
  });

  test("v3: boatTribeWorth 1.0 picks the tribe mass where 0.2 picks the equal contested wilderness", async () => {
    // The island is one ~160-tile tribe at sail ~2; an equal free strip of the mass south of the strait
    // (1600..1639 x 390..414, grid shore hits at 1610,397 and 1604,403, its south rows owned by a nation -
    // contested) is the wilderness alternative at sail ~30. Both are new masses near the 20-tile sail floor, so
    // the coefficient decides. Our troops are clamped to 2000 until t651 (boatShare 0.2 keeps every plain
    // early-boat wave under the 500-troop floor, so the plain rule times out into boatSent), then jump to
    // 20k: the first opening pass sees both candidates affordable at once and the scored order picks.
    const mk = async (w: number) => {
      const h = await playbookSetup({
        map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 2_000,
        rivals: [
          BLOCKER,
          { name: "IslandTribe", type: PlayerType.Bot, at: [1607, 368], troops: 1_000, tiles: [1602, 356, 1613, 377] },
          { name: "Contester", type: PlayerType.Nation, at: [1607, 430], troops: 3_000, tiles: [1600, 415, 1639, 478] },
        ],
        bot: { ...V2, boatShare: 0.2, boatEatRate: 0.02, boatTribeWorth: w },
      });
      const b = h.rival("Blocker");
      conquerRect(h.game, b, [1614, 125, 1801, 377]);
      conquerRect(h.game, b, [1602, 125, 1801, 355]);
      conquerRect(h.game, b, [1560, 125, 1601, 324]);
      conquerRect(h.game, b, [1500, 378, 1599, 389]);
      conquerRect(h.game, b, [1614, 378, 1801, 390]);
      conquerRect(h.game, b, [1500, 391, 1599, 580]); // west of the strip's mass
      conquerRect(h.game, b, [1640, 391, 1801, 580]); // east of it
      conquerRect(h.game, b, [1600, 479, 1639, 580]); // south of it
      conquerRect(h.game, b, [1360, 125, 1559, 600]); // west continent + mainland
      const tribe = h.rival("IslandTribe");
      h.until(() => {
        if (tribe.troops() > 1000) tribe.setTroops(1000);
        if (h.game.ticks() <= 651 && h.me.troops() > 2000) h.me.setTroops(2000);
        if (h.game.ticks() === 652) h.me.setTroops(20_000);
        return h.log.some((l) => l.includes("BOAT OPENING"));
      }, 900);
      return h.log.find((l) => l.includes("BOAT OPENING"))!;
    };
    expect(await mk(1.0)).toContain("tribe IslandTribe"); // the default: tribes weigh their tiles in full
    expect(await mk(0.2)).toContain("empty shore"); // undervalued tribes: the equal contested wilderness wins
  });

  // ---- v4 fixtures ------------------------------------------------------------------------------------
  // The arctic-magnet fix (Josh's east-asia World GUI session; lab repro: the far north coast of our own
  // 225k-tile mainland saturated the 1500-tile landmass fill, read as a NEW landmass and collected the
  // ×1.5 × ×1.3 bonuses every pass — and once good targets were taken, the extras fed a junk tail of
  // basin<200 empty shores at sail 140+ and re-boated a coast whose landing a tribe had already eaten).
  const V4: Partial<PlaybookParams> = { ...V3_OCEAN, boatSailRampTicks: 1, boatOpeningSailCost: 8, boatOpeningMinScore: 4 };

  test("v4: a remote uncontested basin at long sail loses to the nearer contested tribe (no new-mass bonus on a cap-saturated mass)", async () => {
    // The carve (basin ~1300 at water-path ~124) sits on the mainland — a mass the 1500-tile fill cannot finish.
    // v3 called that a new landmass and its ×1.5 × ×1.3 made it the top pick; v4 grants the bonuses only to a
    // mass the fill actually enumerated, and charges the long sail, so the contested island tribe at the strait
    // wins (161 tiles × 1.5 contested / 20 ≈ 12 over the carve's ~6.5). The tribeWorth test's clamp dance keeps
    // the plain boat from eating the island first: our troops pinned at 2000 until t651 (the tribe unaffordable
    // at 0.4 × home, every empty-shore wave under the 500 floor at boatShare 0.2), so the plain rule times out
    // into boatSent and the first opening pass sees both candidates at once.
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 2_000,
      rivals: [BLOCKER, { name: "IslandTribe", type: PlayerType.Bot, at: [1607, 368], troops: 1_000, tiles: [1602, 356, 1613, 377] }],
      bot: { ...V4, boatShare: 0.2 },
    });
    // blockFar, except the tribeWorth test's free strip (1600..1639 × 391..414, grid shore hits 1610,397 and
    // 1604,403) stays open: at t652's troop jump the PLAIN rule's t660 pass runs before its timeout, and with no
    // empty shore at a smaller d than the tribe it would eat the island before the extras ever score it.
    const b = h.rival("Blocker");
    conquerRect(h.game, b, [1614, 125, 1801, 377]);
    conquerRect(h.game, b, [1602, 125, 1801, 355]);
    conquerRect(h.game, b, [1560, 125, 1601, 324]);
    conquerRect(h.game, b, [1500, 378, 1599, 389]);
    conquerRect(h.game, b, [1614, 378, 1801, 390]);
    conquerRect(h.game, b, [1500, 391, 1599, 464]); // west of the strip (the carve rows start at 465)
    conquerRect(h.game, b, [1640, 391, 1801, 464]); // east of it
    conquerRect(h.game, b, [1600, 415, 1639, 464]); // south of its free part
    conquerRect(h.game, b, [1500, 465, 1538, 580]); // west of the carve
    conquerRect(h.game, b, [1600, 465, 1801, 580]); // east of the carve
    conquerRect(h.game, b, [1539, 510, 1599, 580]); // the carve's south rim
    conquerRect(h.game, b, [1360, 125, 1544, 600]); // west continent + mainland
    conquerRect(h.game, b, [1360, 581, 1801, 730]); // the south (a free 8000-tile basin at ~1651,601 outranks everything)
    conquerRect(h.game, b, [1602, 356, 1603, 357]); // a blocker corner on the island: the tribe is CONTESTED
    const tribe = h.rival("IslandTribe");
    const done = h.until(() => {
      if (tribe.isAlive() && tribe.troops() > 1000) tribe.setTroops(1000);
      if (h.game.ticks() <= 651 && h.me.troops() > 2000) h.me.setTroops(2000);
      if (h.game.ticks() === 652) h.me.setTroops(20_000);
      return h.log.some((l) => l.includes("BOAT OPENING") && l.includes("out →"));
    }, 900);
    expect(done).toBe(true);
    const first = h.log.find((l) => l.includes("BOAT OPENING") && l.includes("out →"))!;
    expect(first).toContain("tribe IslandTribe"); // the near contested tribe, not the remote carve
    expect(h.log.some(isFar)).toBe(false); // and no long crossing was launched before it
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
  });

  test("v4: a landing a tribe ate is not re-boated — the blacklist holds while the push fights", async () => {
    // The v2 push fixture: the boat sails for the island's free shore, the Eater conquers the island while it is
    // at sea, the push clicks the tribe from the beachhead. v3 then happily boated the SAME island again next
    // pass (the tribe is a first-class candidate); v4 blacklists everything within boatBasinRadius of the eaten
    // landing for the rest of the opening.
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 50_000,
      rivals: [BLOCKER, { name: "Eater", type: PlayerType.Bot, at: [1300, 300], troops: 2500, tiles: [1295, 295, 1305, 305] }],
      bot: { ...V4, botMaxShare: 0.05, boatShare: 1.0 },
    });
    blockOcean(h);
    const eater = h.rival("Eater");
    const launched = h.until(() => h.me.units(UnitType.TransportShip).length > 0, 120);
    expect(launched).toBe(true);
    conquerRect(h.game, eater, [1602, 356, 1616, 380]); // the tribe eats the island while the boat is at sea
    const pushed = h.until(() => h.log.some((l) => l.includes("BOAT OPENING push → tribe Eater")), 300);
    expect(pushed).toBe(true);
    h.step(300); // many opening passes later: the island tribe would be an affordable top candidate…
    expect(h.log.some((l) => l.includes("BOAT OPENING") && l.includes("out → tribe Eater"))).toBe(false); // …but the failed landing blacklists it
  });

  test("v4: boatOpeningSailCost and boatOpeningMinScore hold the boat home when only a long junk crossing remains", async () => {
    // Only the carve is reachable (the island is blocked, so the plain boat finds nothing and times out into
    // boatSent at t652; the extras run from there). At the default cost/floor the rich carve still clears the
    // bar and the extra sails; with the cost at 50 the 124-tile crossing forfeits the whole basin, and with the
    // floor prohibitive nothing clears it — in both cases the extras hold the boat rather than launch the best
    // of a garbage list (v3 always launched).
    const mkC = async (over: Partial<PlaybookParams>) => {
      const h = await playbookSetup({
        map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 100_000,
        rivals: [BLOCKER],
        bot: { ...V4, ...over },
      });
      blockFar(h);
      conquerRect(h.game, h.rival("Blocker"), [1602, 356, 1613, 377]); // the island: only the carve stays free
      conquerRect(h.game, h.rival("Blocker"), [1360, 581, 1801, 730]); // and the south (a free 8000-tile basin at ~1651,601 otherwise clears any bar)
      h.until(() => h.log.some((l) => l.includes("BOAT OPENING") && l.includes("out →")), 900);
      return h.log.filter((l) => l.includes("BOAT OPENING") && l.includes("out →"));
    };
    expect((await mkC({})).some(isFar)).toBe(true); // defaults: the rich carve is worth the crossing
    expect(await mkC({ boatOpeningSailCost: 50 })).toEqual([]); // the sail cost eats it: hold
    expect(await mkC({ boatOpeningSailCost: 0, boatOpeningMinScore: 1e9 })).toEqual([]); // the floor: hold
  });

  // ---- v5 fixtures ------------------------------------------------------------------------------------
  // Own-mass empty shores (Josh's russia/asia coastline: opening boats kept sailing to the far coast of our
  // OWN landmass — land expansion reaches it free; boats are for separate masses and tribes). The cove
  // fixture: a far pocket of our mainland's west coast (free box x1481..1520 × y429..455, a free lane
  // x1481..1488 up to the free connector rows y375..377 that touch our rect at x1560) — openingCutOff's
  // flood over land no other player owns walks lane and connector and meets us (land-reachable, so
  // boatOwnMassFactor applies), while the launch-time acrossWaterNear still calls the cove "across water"
  // (its all-land BFS saturates its 4000-tile cap on the blocker mainland long before walking the ~140-step
  // detour — the v2-caveat saturation ambiguity this flag mops up). The separate-mass alternative is the
  // free 118-tile mass at 1585,435..1604,463 (grid shore hits 1598,445 and 1586,463, water-path ~70).
  const V5: Partial<PlaybookParams> = { ...V4, boatOpeningSailCost: 0, boatEatRate: 0 }; // cost/eat off: these tests isolate the own-mass factor
  function blockCove(h: PlaybookHarness, opts: { block118?: boolean } = {}): void {
    const b = h.rival("Blocker");
    conquerRect(h.game, b, [1614, 125, 1801, 377]); // east: Kuril-side chains
    conquerRect(h.game, b, [1602, 125, 1801, 355]); // north-east coast
    conquerRect(h.game, b, [1560, 125, 1601, 324]); // mainland north of our rect
    conquerRect(h.game, b, [1602, 356, 1613, 377]); // the strait island
    conquerRect(h.game, b, [1481, 325, 1559, 374]); // mainland north-west of us — only the connector rows stay free
    conquerRect(h.game, b, [1489, 378, 1801, 428]); // mainland + chains between the connector and the cove box
    conquerRect(h.game, b, [1521, 429, 1584, 464]); // east of the box, west of the 118-mass
    conquerRect(h.game, b, [1585, 429, 1604, 434]); // north of the 118-mass
    conquerRect(h.game, b, [1605, 429, 1801, 464]); // east of the 118-mass
    if (opts.block118) conquerRect(h.game, b, [1585, 435, 1604, 463]); // the 118-mass itself (the hold test leaves only the cove)
    conquerRect(h.game, b, [1481, 456, 1584, 600]); // below the box (the carve too)
    conquerRect(h.game, b, [1585, 464, 1801, 600]); // below the 118-mass
    conquerRect(h.game, b, [1360, 125, 1480, 600]); // west continent + the mainland's west edge column
    conquerRect(h.game, b, [1360, 601, 1801, 730]); // the south
  }
  /** v4's clamp dance: plain waves stay under the 500-troop floor until the plain rule times out into
   *  boatSent at t652, then troops jump — the extras run alone from there. */
  function dance(h: PlaybookHarness, stop: () => boolean, max = 900): boolean {
    return h.until(() => {
      if (h.game.ticks() <= 651 && h.me.troops() > 2000) h.me.setTroops(2000);
      if (h.game.ticks() === 652) h.me.setTroops(20_000);
      return stop();
    }, max);
  }
  const isOut = (l: string) => l.includes("BOAT OPENING") && l.includes("out →");

  test("v5: an own-mass far coast loses to a separate-mass candidate; ×1 pinned takes the own coast (the factor decides)", async () => {
    const mkO = async (over: Partial<PlaybookParams>) => {
      const h = await playbookSetup({ map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 2_000, rivals: [BLOCKER], bot: { ...V5, boatShare: 0.2, boatOpeningMinScore: 0.25, ...over } });
      blockCove(h);
      dance(h, () => h.log.some(isOut));
      return h.log.find(isOut)!;
    };
    const sep = await mkO({});
    expect(sep).toBeDefined();
    expect(sep).toContain("own=no"); // the 118-tile separate mass, not our own west coast
    const own = await mkO({ boatOwnMassFactor: 1 });
    expect(own).toContain("own=yes"); // ×1: the bigger own-coast basin wins — the factor is what excluded it
    expect(own).not.toContain("blocked=yes"); // land-reachable through the lane: the escape hatch did NOT fire
  });

  test("v5: the penalized own coast falls under the score floor — the extras hold the boat; ×1 pinned launches it", async () => {
    const mkH = async (over: Partial<PlaybookParams>) => {
      const h = await playbookSetup({ map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 100_000, rivals: [BLOCKER], bot: { ...V5, boatOpeningMinScore: 2, ...over } });
      blockCove(h, { block118: true });
      h.until(() => h.log.some(isOut), 900);
      return h.log.filter(isOut);
    };
    expect(await mkH({})).toEqual([]); // 0.15 × the cove's raw score is under the floor: hold home
    const out = await mkH({ boatOwnMassFactor: 1 });
    expect(out.length).toBeGreaterThanOrEqual(1); // the same fixture ×1 clears it: the factor held the boat, not the fixture
    expect(out[0]).toContain("own=yes");
  });

  test("v5: a basin walled off by rivals keeps full score — the cut-off carve is boated even at factor 0 (blocked=yes)", async () => {
    const h = await playbookSetup({ map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 100_000, rivals: [BLOCKER], bot: { ...V4, boatOwnMassFactor: 0 } });
    blockFar(h);
    conquerRect(h.game, h.rival("Blocker"), [1602, 356, 1613, 377]); // the island: only the carve stays free
    conquerRect(h.game, h.rival("Blocker"), [1360, 581, 1801, 730]); // and the south
    const done = h.until(() => h.log.some(isOut), 900);
    expect(done).toBe(true);
    const line = h.log.find(isOut)!;
    expect(line).toContain("own=yes"); // cap-saturated mainland fill: treated as our own mass…
    expect(line).toContain("blocked=yes"); // …but the Blocker walls the carve off — land expansion can never reach it
    expect(sailOf(line)).toBeGreaterThan(BOAT_MAX_PATH.early); // the long crossing to the carve
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
  });

  test("v5: a tribe on our own mass is exempt — boated at factor 0, own=yes without blocked", async () => {
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 2_000,
      rivals: [BLOCKER, { name: "MassTribe", type: PlayerType.Bot, at: [1560, 490], troops: 1_000, tiles: [1539, 465, 1599, 509] }],
      bot: { ...V4, boatOwnMassFactor: 0, boatShare: 1.0 },
    });
    blockFar(h);
    conquerRect(h.game, h.rival("Blocker"), [1602, 356, 1613, 377]);
    conquerRect(h.game, h.rival("Blocker"), [1360, 581, 1801, 730]);
    const tribe = h.rival("MassTribe");
    const done = h.until(() => {
      if (tribe.isAlive() && tribe.troops() > 1000) tribe.setTroops(1000);
      if (h.game.ticks() <= 651 && h.me.troops() > 2000) h.me.setTroops(2000);
      if (h.game.ticks() === 652) h.me.setTroops(20_000);
      return h.log.some(isOut);
    }, 900);
    expect(done).toBe(true);
    const line = h.log.find(isOut)!;
    expect(line).toContain("tribe MassTribe"); // a tribe across the bay on our own mass is still a fine boat
    expect(line).toContain("own=yes");
    expect(line).not.toContain("blocked=yes");
  });

  // ---- v6 fixtures ------------------------------------------------------------------------------------
  // 1) True water-path sail (Josh: the openings land on the far side of rivers/peninsulas because the straight
  //    line looks short — boatsWaterPath was the fix but its ranking lost the full-game A/B and is off).
  //    Real corner: the Skagerrak. Our rect is southern Norway ([894,148,924,171]); Jutland hangs south of it.
  //    Probed offline (water/land BFS on the test map): Jutland's EAST (Kattegat) shore at ~(901,178) is
  //    chord ~8 from our south coast but ~115 tiles of real water — the Danish straits are closed on this
  //    map, a boat must round Jutland's south tip (~y195) — while its WEST (North Sea) shore at ~(878,179)
  //    is chord ~24 and ~25-40 by water. The straight-line ranking (the plain first boat, untouched) picks
  //    the far Kattegat shore; the v6 extras must price the true sail and land on the North Sea side.
  //    Jutland's land path back to Norway runs through all of Europe and Russia, so acrossWaterNear
  //    saturates its 4000-tile cap and the tribe stays a boat target.
  const ME_NORWAY: Rect = [894, 148, 924, 171];
  const SPAWN_NORWAY: [number, number] = [908, 160];
  const JUTLAND: Rect = [876, 178, 901, 196];
  function blockEurope(h: PlaybookHarness): void {
    const b = h.rival("Blocker");
    conquerRect(h.game, b, [694, 0, 1124, 147]); // north of our rect, Arctic coasts included
    conquerRect(h.game, b, [694, 148, 893, 171]); // west of it
    conquerRect(h.game, b, [925, 148, 1124, 171]); // east of it (Sweden onward)
    conquerRect(h.game, b, [694, 172, 875, 571]); // the Atlantic side, west of Jutland
    conquerRect(h.game, b, [902, 172, 1124, 571]); // Sweden/Baltic/Europe east of Jutland
    conquerRect(h.game, b, [876, 172, 901, 177]); // Jutland's north strip + the Skagen islets (seals the closed lagoon's shores)
    conquerRect(h.game, b, [876, 197, 901, 571]); // Germany southward
  }

  test("v6: sail is the true water path - the extras land on Jutland's near (North Sea) shore where the straight line picks the far (Kattegat) shore", async () => {
    const h = await playbookSetup({
      map: "world", spawn: SPAWN_NORWAY, tiles: ME_NORWAY, troops: 2_000,
      rivals: [BLOCKER, { name: "Jutland", type: PlayerType.Bot, at: [893, 185], troops: 1_000, tiles: JUTLAND }],
      // islandMaxTiles 300: Scandinavia is ~1500 tiles on this map — under the 20000 default the opening
      // would read the spawn as an island and stay inert; over 300 it is a mainland like any other
      bot: { ...V2, boatShare: 0.3, boatSailRampTicks: 1, boatEatRate: 0, islandMaxTiles: 300 },
    });
    blockEurope(h);
    const tribe = h.rival("Jutland");
    const seen = new Map<TileRef, number>();
    const done = h.until(() => {
      if (tribe.isAlive() && tribe.troops() > 1000) tribe.setTroops(1000);
      if (h.game.ticks() <= 651 && h.me.troops() > 2000) h.me.setTroops(2000);
      if (h.game.ticks() === 652) h.me.setTroops(20_000);
      for (const u of h.me.units(UnitType.TransportShip)) { const dt = u.targetTile(); if (dt !== undefined && !seen.has(dt)) seen.set(dt, h.game.ticks()); }
      return h.log.some((l) => l.includes("out → tribe Jutland"));
    }, 800);
    expect(done).toBe(true);
    // the PLAIN first boat (straight-line ranking, untouched by v6) launched at the chord-8 Kattagat tip
    const plain = h.log.find((l) => /early boat → tribe Jutland, \d+ tiles$/.test(l))!;
    expect(plain).toBeDefined();
    expect(Number(/, (\d+) tiles$/.exec(plain)![1])).toBeLessThanOrEqual(110); // chord + 80: the straight line says ~8
    const plainTarget = [...seen].sort((a, b) => a[1] - b[1])[0]?.[0];
    expect(plainTarget).toBeDefined();
    expect(h.game.x(plainTarget!)).toBeGreaterThanOrEqual(896); // the far (Kattegat) shore — ~115 real water tiles away
    // the v6 extra priced the true sail and landed on the near (North Sea) side instead
    const line = h.log.find((l) => l.includes("out → tribe Jutland"))!;
    const m = /out → tribe Jutland at (\d+),(\d+), .* sail=(\d+)/.exec(line)!;
    expect(line).toContain("by water");
    expect(Number(m[1])).toBeLessThanOrEqual(890); // the North Sea coast, not the Kattegat one
    expect(Number(m[3])).toBeGreaterThanOrEqual(10);
    expect(Number(m[3])).toBeLessThanOrEqual(55); // the true water path of the near shore (the far one is ~115)
    expect(h.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
  });

  // 2) The escalating sail budget (replaces the ocean window): close boats early, the far carve only once
  //    maxSail(t) = boatSailMin + (250 − boatSailMin) × t / boatSailRampTicks reaches its water path.
  //    rampTicks is pinned to 600 (not the 2000 default) purely so the launch lands before seaExpansion's
  //    t600 start — the plain sea rule would otherwise beachhead the carve first and acrossWaterNear would
  //    rightly refuse it; the budget line is the same, scaled (at the default the same carve crosses at
  //    t ≈ (sail − 50) × 10 ≈ 740 and the full 250 opens at t2000 — comfortably inside Josh's t2500).
  test("v6: the sail budget ramps - the far carve is held at t100 and launched only once maxSail covers its ~124-tile path", async () => {
    // the BAIT tribe gives the plain rule its t60 boat, so the extras run (and hold) from t80 — without it
    // the plain rule only times out into boatSent at t652 and the early hold is unobservable
    const h = await playbookSetup({ map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 100_000, rivals: [BLOCKER, BAIT], bot: { ...V4, boatSailMin: 50, boatSailRampTicks: 600 } });
    blockFar(h);
    conquerRect(h.game, h.rival("Blocker"), [1602, 356, 1613, 377]); // the island: only the carve (and the bait islet) stay free
    conquerRect(h.game, h.rival("Blocker"), [1360, 581, 1801, 730]); // the south
    const bait = h.rival("Bait");
    const found = h.until(() => {
      if (bait.isAlive() && bait.troops() > 400) bait.setTroops(400);
      return h.log.some(isFar);
    }, 590);
    expect(found).toBe(true); // allowed once the budget covers the crossing
    const line = h.log.find(isFar)!;
    const sail = sailOf(line), tick = Number(/^t(\d+) /.exec(line)![1]);
    expect(tick).toBeGreaterThan(100); // held at t100: the budget was ~83 then
    expect(tick).toBeGreaterThanOrEqual((sail - 50) * 3 - 25); // held until maxSail(t) ≥ its sail (one 20-tick pass of slack)
    expect(Number(/cap=(\d+)/.exec(line)![1])).toBeGreaterThanOrEqual(sail); // the logged budget admits the launch
  });

  // 3) A landing the eaters reach before the boat does is re-anchored to a safer shore of the same basin,
  //    or dropped when no reachable shore survives. Two-phase: the un-eaten control finds the landing the
  //    scorer picks on Arabia, then the same fixture is rerun with an eater planted beside that exact tile.
  const V6_EAT: Partial<PlaybookParams> = { ...V2, boatEatRate: 0.5 }; // threshold = 0.5 × sail ≈ 8-10 tiles on the ~16-20-tile Arabia hop
  const outShore = (l: string) => l.includes("BOAT OPENING") && l.includes("out → empty shore");
  async function arabiaOpening(over: Partial<PlaybookParams>, plant?: (h: PlaybookHarness) => void): Promise<PlaybookHarness> {
    const h = await playbookSetup({
      map: "world", spawn: SPAWN, tiles: [1120, 396, 1154, 445], troops: 100_000,
      rivals: [{ name: "Eater", type: PlayerType.Nation, at: [1450, 200], troops: 5000, tiles: [1445, 195, 1455, 205] }],
      bot: { ...V6_EAT, ...over },
    });
    plant?.(h);
    h.until(() => h.log.some(outShore), 500);
    return h;
  }
  test("v6: a landing tile the eater reaches first is re-anchored to a safer shore of the basin; with every reachable shore eaten the candidate is dropped", async () => {
    // phase A: where does the scorer land on Arabia with nobody in the way?
    const a = await arabiaOpening({});
    const la = /out → empty shore at (\d+),(\d+), /.exec(a.log.find(outShore)!)!;
    const [lx, ly] = [Number(la[1]), Number(la[2])];
    expect(a.log.find(outShore)!).not.toContain("reanchored");
    // phase B: an eater blob on one side of that exact landing (manhattan 2-5, south side) — the landing is
    // projected eaten (dist 2 < 0.5 × sail), the coast north of it is not: the candidate re-anchors.
    const b = await arabiaOpening({}, (h) => {
      const e = h.rival("Eater");
      for (let y = ly - 6; y <= ly + 6; y++) for (let x = lx - 6; x <= lx + 6; x++) {
        const d = Math.abs(x - lx) + Math.abs(y - ly);
        if (d < 2 || d > 5 || y < ly) continue;
        const t = h.game.ref(x, y);
        if (h.game.isLand(t)) e.conquer(t);
      }
    });
    const lineB = b.log.find(outShore)!;
    expect(lineB).toContain("reanchored=yes");
    const mb = /out → empty shore at (\d+),(\d+), /.exec(lineB)!;
    expect(Math.abs(Number(mb[1]) - lx) + Math.abs(Number(mb[2]) - ly)).toBeGreaterThanOrEqual(3); // a different, safer shore of the same basin
    expect(b.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1);
    // phase C: a shore picket around the landing (every other shore tile within 60, the landing's own 2-tile
    // pocket left free) with the budget pinned at 25: every reachable shore is projected eaten — dropped, no launch.
    const c = await arabiaOpening({ boatSailMin: 25, boatSailRampTicks: 1_000_000_000 }, (h) => {
      const e = h.rival("Eater");
      for (let y = ly - 60; y <= ly + 60; y++) for (let x = lx - 60; x <= lx + 60; x++) {
        if (Math.abs(x - lx) + Math.abs(y - ly) < 3) continue;
        if (!h.game.isValidCoord(x, y)) continue;
        const t = h.game.ref(x, y);
        if (h.game.isLand(t) && h.game.isShore(t) && !h.game.hasOwner(t)) e.conquer(t);
      }
    });
    expect(c.log.some(outShore)).toBe(false); // dropped at every pass
    expect(c.bot.fired.get("boatOpening")).toBeGreaterThanOrEqual(1); // the drop is the reanchor fire site
  });

  // 4) The eat rate reads the game difficulty: boatEatRateHard on Hard (defenders +33 %), boatEatRate on Medium.
  test("v6: the discount uses boatEatRateHard on Hard - the carve is forfeited there and taken on Medium under the same pins", async () => {
    const pins: Partial<PlaybookParams> = { ...V3_OCEAN, boatSailRampTicks: 1, boatEatRate: 0, boatEatRateHard: 2.0 };
    const hard = await playbookSetup({ map: "world", spawn: SPAWN_STRAIT, tiles: ME_STRAIT, troops: 100_000, rivals: [BLOCKER, ...NEAR_TRIBES], bot: pins, config: { difficulty: Difficulty.Hard } });
    blockFar(hard);
    expect(runOcean(hard, () => hard.log.some((l) => l.includes("BOAT OPENING")), 500)).toBe(true);
    expect(hard.log.some(isFar)).toBe(false); // Hard reads boatEatRateHard 2.0: the ~100-tick sail forfeits the carve
    expect(hard.log.some(isNear)).toBe(true);
    const med = await oceanSetup(pins);
    blockFar(med);
    expect(runOcean(med, () => med.log.some(isFar), 500)).toBe(true); // Medium reads boatEatRate 0: the same carve is taken
  });

  test("an opening that never becomes active is decision-identical to the plain bot (log equality)", async () => {
    const a = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET } });
    const b = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET, boatOpening: true, boatOpeningUntil: 40 } }); // cutoff before boatAtTick: the flag never changes a decision
    a.step(500);
    b.step(500);
    expect(b.log).toEqual(a.log);
    expect(b.bot.fired.get("boatOpening")).toBeUndefined();
  });
});
