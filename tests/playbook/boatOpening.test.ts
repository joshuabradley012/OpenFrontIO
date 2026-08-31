// Flag `boatOpening` (docs/PlaybookBotPlan.md "Aggressive multi-boat opening"): while tick < boatOpeningUntil the
// early-boat rule keeps up to boatOpeningCount transports alive at once instead of the single early boat, the
// extras picked by earlyBoat's own scorer with an open shore on a landmass we own no tile of preferred.
//
// Geometry (the world test map, Bab-el-Mandeb, as tests/playbook/boats.test.ts): the Red Sea runs diagonally from
// about (1148, 396) to (1176, 436) with Africa west of it and Arabia east; a 4–6-tile channel separates them. Our
// rect on Africa's east bank has Arabia's free coast — a second continent — a short sail across the strait.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Game, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { conquerRect, PlaybookHarness, playbookSetup, Rect, RivalSpec } from "../util/PlaybookSetup";

// pin the defaults the fixture depends on (other tests do the same with their PRE_CMA/boats pins)
const QUIET: Partial<PlaybookParams> = {
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

  test("an opening that never becomes active is decision-identical to the plain bot (log equality)", async () => {
    const a = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET } });
    const b = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET, boatOpening: true, boatOpeningUntil: 40 } }); // cutoff before boatAtTick: the flag never changes a decision
    a.step(500);
    b.step(500);
    expect(b.log).toEqual(a.log);
    expect(b.bot.fired.get("boatOpening")).toBeUndefined();
  });
});
