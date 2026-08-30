// Flag `boatOpening` (docs/PlaybookBotPlan.md "Aggressive multi-boat opening"): while tick < boatOpeningUntil the
// early-boat rule keeps up to boatOpeningCount transports alive at once instead of the single early boat, the
// extras picked by earlyBoat's own scorer with an open shore on a landmass we own no tile of preferred.
//
// Geometry (the world test map, Bab-el-Mandeb, as tests/playbook/boats.test.ts): the Red Sea runs diagonally from
// about (1148, 396) to (1176, 436) with Africa west of it and Arabia east; a 4–6-tile channel separates them. Our
// rect on Africa's east bank has Arabia's free coast — a second continent — a short sail across the strait.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Game, Player, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

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

  test("an opening that never becomes active is decision-identical to the plain bot (log equality)", async () => {
    const a = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET } });
    const b = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET, boatOpening: true, boatOpeningUntil: 40 } }); // cutoff before boatAtTick: the flag never changes a decision
    a.step(500);
    b.step(500);
    expect(b.log).toEqual(a.log);
    expect(b.bot.fired.get("boatOpening")).toBeUndefined();
  });
});
