// Flags `boatsNearest` and `finishByBoat` (docs/PlaybookBotPlan.md "Boats"): a boat's distance is measured from the
// shore the engine will launch it from, not from an arbitrary middle border tile; and a war target's remnant across
// a strait — the piece no land wave can reach — gets a boat.
//
// Geometry (the world test map, Bab-el-Mandeb): the Red Sea runs diagonally from about (1148, 396) to (1176, 436)
// with Africa west of it and Arabia east; a 4–6-tile channel separates them. Africa's east bank at y 396–407 is an
// ocean shore, so a rect ending at x 1150 there has a short coast on the Red Sea and Arabia's free coast across it.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { conquerRect, distToPlayer, playbookSetup, PRE_COMBO, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { ...PRE_COMBO, expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false, boatsNearest: false, boatsWaterPath: false, takeFallout: false }; // the other 2026-08-30 flags are on by default; the fixtures assume them off
const ME: Rect = [1120, 396, 1150, 445]; // Africa's Red Sea bank, coast at y 396–407
const ME_WAR: Rect = [1120, 400, 1160, 445]; // the same bank, out to the war target's border
const T_AFRICA: Rect = [1161, 425, 1170, 445]; // the war target's piece beside us
const T_ARABIA: Rect = [1173, 415, 1205, 434]; // its remnant across the strait

type MilInternals = { currentTarget_: Player | null; lastWarTick: number };

describe("boatsNearest", () => {
  async function earlyBoat(boatsNearest: boolean) {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest } });
    expect(h.until(() => h.me.units(UnitType.TransportShip).length > 0, 300)).toBe(true);
    const dst = h.me.units(UnitType.TransportShip)[0].targetTile()!;
    const shore = Array.from(h.me.borderTiles()).filter((t) => h.game.isShore(t));
    const mid = shore[Math.floor(shore.length / 2)];
    return { h, dst, mid, line: h.log.find((l) => l.includes("early boat"))! };
  }

  test("off: the early boat is measured from the middle shore tile and sails 80 tiles when a shore 32 tiles off is nearer our coast", async () => {
    const { h, dst, mid, line } = await earlyBoat(false);
    expect(line).toMatch(/empty shore, 80 tiles/);
    expect(h.game.manhattanDist(dst, mid)).toBe(80);
    expect(distToPlayer(h.game, dst, h.me)).toBeGreaterThanOrEqual(40);
    expect(h.bot.fired.get("boatsNearest")).toBeUndefined();
  });

  test("on: the early boat goes to the free shore nearest our nearest shore, and the flag fires", async () => {
    const { h, dst, mid, line } = await earlyBoat(true);
    expect(line).toMatch(/empty shore, 32 tiles/);
    expect(h.game.manhattanDist(dst, mid)).toBeLessThan(80); // not the old pick
    expect(distToPlayer(h.game, dst, h.me)).toBeLessThanOrEqual(25);
    expect(h.game.owner(dst).isPlayer()).toBe(false); // Arabia's free coast, across the strait
    expect(h.bot.fired.get("boatsNearest")).toBe(1);
  });

  test("the shore sample is every k-th ocean-shore border tile, at most 200, and the nearest distance is the minimum over it", async () => {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatAtTick: 1e9 } });
    h.step(1);
    const mil = (h.bot as unknown as { military: Military }).military;
    const sample = mil.shoreSample();
    const all = Array.from(h.me.borderTiles()).filter((t) => h.game.isOceanShore(t));
    expect(sample.length).toBeGreaterThan(0);
    expect(sample.length).toBeLessThanOrEqual(Math.min(200, all.length));
    for (const s of sample) expect(all).toContain(s);
    const far = h.game.ref(1200, 426);
    expect(mil.nearestShoreDist(far)).toBe(Math.min(...all.map((t) => h.game.manhattanDist(t, far))));
    expect(mil.shoreSample()).toBe(sample); // cached inside the tick
  });
});

describe("finishByBoat", () => {
  /** We hold Africa's bank; the target T holds a piece beside us and a remnant across the strait in Arabia. */
  async function warAcrossStrait(finishByBoat: boolean, remnant: boolean) {
    const h = await playbookSetup({
      map: "world", spawn: [1140, 420], tiles: ME_WAR, troops: 200_000,
      bot: { ...QUIET, finishByBoat, boatAtTick: 1e9 },
      rivals: [{ name: "T", type: PlayerType.Human, at: [1165, 435], troops: 60_000 }],
    });
    const t = h.rival("T");
    conquerRect(h.game, t, T_AFRICA);
    if (remnant) conquerRect(h.game, t, T_ARABIA);
    h.step(1);
    const mil = (h.bot as unknown as { military: Military }).military;
    return { h, t, mil };
  }

  test("a target split by water: the remnant's tiles are the unreachable part, with its shore", async () => {
    const { h, t, mil } = await warAcrossStrait(true, true);
    const pieces = Military.pieces(h.game, t);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    const part = mil.unreachablePart(t)!;
    expect(part).not.toBeNull();
    const beside = pieces.filter((p) => p.border.some((b) => h.game.neighbors(b).some((n) => h.game.owner(n) === h.me)));
    expect(part.tiles).toBe(t.numTilesOwned() - beside.reduce((a, p) => a + p.tiles, 0));
    expect(part.tiles).toBeGreaterThan(400);
    expect(part.shore.length).toBeGreaterThan(0);
    for (const s of part.shore) { expect(h.game.owner(s)).toBe(t); expect(h.game.isOceanShore(s)).toBe(true); }
  });

  test("on: at tick 1200 a boat of 2 × troops × unreachable share + 2000 (at most 40 % of spendable) lands on the remnant", async () => {
    const { h, t, mil } = await warAcrossStrait(true, true);
    h.until(() => h.game.ticks() === 1200, 1300);
    const internals = mil as unknown as MilInternals;
    internals.currentTarget_ = t; internals.lastWarTick = h.game.ticks();
    const unreachable = mil.unreachablePart(t)!.tiles;
    h.step(1);
    const line = h.log.find((l) => l.includes("FINISH BY BOAT"))!;
    const m = /FINISH BY BOAT T (\d+) unreachable tiles of (\d+), troops (\d+) spendable (\d+) → (\d+) landing/.exec(line)!;
    expect(m).not.toBeNull();
    const [tilesU, tilesT, troopsT, spendable, sent] = m.slice(1).map(Number);
    expect(tilesU).toBe(unreachable);
    const boat = h.me.units(UnitType.TransportShip).find((u) => h.game.owner(u.targetTile()!) === t)!; // the sea-expansion rule may launch its own boat the same tick
    expect(boat).toBeDefined();
    expect(boat.troops()).toBe(sent);
    expect(distToPlayer(h.game, boat.targetTile()!, h.me)).toBeLessThanOrEqual(25); // the remnant's shore nearest our coast
    const want = Math.ceil(2 * troopsT * (tilesU / tilesT)) + 2000;
    expect(sent).toBe(Math.min(want, Math.floor(spendable * 0.4)));
    expect(want).toBeGreaterThan(sent); // the cap binds here: the remnant is most of a 200k army
    expect(sent).toBeGreaterThan(50_000);
    expect(h.bot.fired.get("finishByBoat")).toBe(1);
    // one boat per target: the next pass holds while that boat is bound for T
    h.step(100);
    expect(h.log.filter((l) => l.includes("FINISH BY BOAT")).length).toBe(1);
  });

  test("off: no boat at the remnant", async () => {
    const { h, t, mil } = await warAcrossStrait(false, true);
    h.until(() => h.game.ticks() === 1200, 1300);
    const internals = mil as unknown as MilInternals;
    internals.currentTarget_ = t; internals.lastWarTick = h.game.ticks();
    h.step(101);
    expect(h.log.some((l) => l.includes("FINISH BY BOAT") || l.includes("finish T"))).toBe(false);
    expect(h.me.units(UnitType.TransportShip).every((u) => h.game.owner(u.targetTile()!) !== t)).toBe(true);
    expect(h.bot.fired.get("finishByBoat")).toBeUndefined();
  });

  test("no boat when every tile of the target is reachable by land", async () => {
    const { h, t, mil } = await warAcrossStrait(true, false);
    expect(mil.unreachablePart(t)).toBeNull();
    h.until(() => h.game.ticks() === 1200, 1300);
    const internals = mil as unknown as MilInternals;
    internals.currentTarget_ = t; internals.lastWarTick = h.game.ticks();
    h.step(101);
    expect(h.log.some((l) => l.includes("FINISH BY BOAT"))).toBe(false);
    expect(h.bot.fired.get("finishByBoat")).toBeUndefined();
  });
});
