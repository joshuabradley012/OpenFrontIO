// Flags `boatsWaterPath` and `boatsAfterCoast` (docs/PlaybookBotPlan.md "Boats II"): a boat rule ranks by the water
// path the transport will sail — not the straight-line distance — and refuses a landing beyond BOAT_MAX_PATH; and
// no early or tribe boat goes while free land is still reachable by land on our own landmass.
//
// Geometry (the world test map): we hold Africa's Red Sea bank at Bab-el-Mandeb (boats.test.ts). From there Arabia's
// Red Sea coast at (1172, 412) is 32 tiles by water and straight-line alike; the Persian Gulf coast at (1250, 400)
// is 101 tiles straight-line but 168 by water — the ship sails round the Arabian peninsula — and (1238, 352) on the
// Gulf is 136 straight-line, 274 by water, while the Mediterranean coast at (1106, 286) is 148 either way.
// A 1365-tile island around (1620, 438) is the small-landmass start.
import { describe, expect, test } from "vitest";
import { BOAT_MAX_PATH, Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false }; // the 2026-08-30 defaults are on; the fixtures set each flag explicitly
const ME: Rect = [1120, 396, 1150, 445]; // Africa's Red Sea bank, coast at y 396–407
const GULF: RivalSpec = { name: "Gulf", type: PlayerType.Bot, at: [1245, 356], tiles: [1232, 346, 1258, 366], troops: 4000 }; // behind the Arabian peninsula
const MED: RivalSpec = { name: "Med", type: PlayerType.Bot, at: [1106, 290], tiles: [1096, 280, 1118, 300], troops: 4000 }; // the Mediterranean coast
const ISLAND: Rect = [1610, 430, 1630, 446]; // a 1365-tile island at (1620, 438), the coast 10 tiles from another

function military(h: { bot: unknown }): Military {
  return (h as { bot: { military: Military } }).bot.military;
}

describe("boatsWaterPath", () => {
  test("the water-path fill: a shore behind a peninsula reads far more than its straight-line distance, a shore across the strait the same", async () => {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatsWaterPath: true, boatAtTick: 1e9 } });
    h.step(1);
    const mil = military(h);
    const wp = mil.waterPath();
    const strait = h.game.ref(1172, 412), gulf = h.game.ref(1238, 352), med = h.game.ref(1106, 286);
    expect(wp.len(strait)).toBe(mil.nearestShoreDist(strait)); // 32: open water, the path is the straight line
    expect(wp.len(gulf)).toBeGreaterThanOrEqual(2 * mil.nearestShoreDist(gulf)); // 274 vs 136: round Arabia
    expect(wp.len(gulf)).toBeGreaterThan(BOAT_MAX_PATH.tribe);
    expect(wp.len(med)).toBeLessThan(wp.len(gulf)); // nearer by water though farther straight-line
    expect(mil.nearestShoreDist(med)).toBeGreaterThan(mil.nearestShoreDist(gulf));
    expect(wp.len(h.game.ref(1135, 420))).toBe(Infinity); // an inland tile has no water neighbour
    expect(wp.size).toBeLessThanOrEqual(400_000);
    expect(wp.size).toBeGreaterThan(1000);
  });

  /** Tribe boats (huntBotsByBoat, every 100 ticks from 300) with the Gulf tribe alone or with the Med tribe too. */
  async function tribeBoat(flags: Partial<PlaybookParams>, rivals: RivalSpec[]) {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatAtTick: 1e9, ...flags }, rivals });
    h.until(() => h.game.ticks() === 501, 600); // the 300, 400 and 500 passes; sea expansion starts at 600
    const line = h.log.find((l) => l.includes("to tribe")) ?? null; // the boat itself may have landed by 501
    return { h, to: line === null ? null : /to tribe (\w+) /.exec(line)![1], line };
  }

  test("off: the tribe behind the peninsula is 136 tiles straight-line and gets the boat", async () => {
    const { h, to, line } = await tribeBoat({}, [GULF]);
    expect(to).toBe("Gulf");
    expect(line).toMatch(/to tribe Gulf .*, \d+ tiles$/);
    expect(h.bot.fired.get("boatsWaterPath")).toBeUndefined();
  });

  test("on: its water path exceeds BOAT_MAX_PATH.tribe — no boat, and the refusal fires", async () => {
    const { h, to } = await tribeBoat({ boatsWaterPath: true }, [GULF]);
    expect(to).toBeNull();
    expect(h.bot.fired.get("boatsWaterPath")).toBeGreaterThanOrEqual(1);
  });

  test("on: with a tribe nearer by water though farther straight-line, that one gets the boat and the line carries the sailed distance", async () => {
    const off = await tribeBoat({}, [GULF, MED]);
    expect(off.to).toBe("Gulf");
    const on = await tribeBoat({ boatsWaterPath: true }, [GULF, MED]);
    expect(on.to).toBe("Med");
    expect(on.line).toMatch(/to tribe Med .*, (\d+) tiles by water/);
    const sailed = Number(/(\d+) tiles by water/.exec(on.line!)![1]);
    expect(sailed).toBeLessThanOrEqual(BOAT_MAX_PATH.tribe);
    expect(on.h.bot.fired.get("boatsWaterPath")).toBeGreaterThanOrEqual(1);
  });

  test("the early boat composes with boatsNearest: off, the middle-tile scan's pick (80 straight-line) sails over BOAT_MAX_PATH.early and is refused; on, the strait shore at 32 by water goes and no flag fires", async () => {
    const off = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsWaterPath: true } });
    expect(off.until(() => off.me.units(UnitType.TransportShip).length > 0, 300)).toBe(false);
    expect(off.log.some((l) => l.includes("early boat"))).toBe(false);
    expect(off.bot.fired.get("boatsWaterPath")).toBeGreaterThanOrEqual(1); // refused: boats.test.ts shows the flag-off boat leaving at tick 60
    const on = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatsWaterPath: true } });
    expect(on.until(() => on.me.units(UnitType.TransportShip).length > 0, 300)).toBe(true);
    const line = on.log.find((l) => l.includes("early boat"))!;
    expect(line).toMatch(/empty shore, 32 tiles by water/);
    expect(on.bot.fired.get("boatsWaterPath")).toBeUndefined(); // the straight-line pick is the same tile
    expect(on.bot.fired.get("boatsNearest")).toBe(1);
  });

  test("the fill runs once per pass and is cached for 100 ticks", async () => {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatsWaterPath: true, boatAtTick: 1e9 }, rivals: [GULF, MED] });
    const mil = military(h);
    h.until(() => h.game.ticks() === 301, 400); // the tick-300 pass: tribe boats (its boat to Med then holds the rule)
    expect(mil.waterPathRuns).toBe(1);
    const wp = mil.waterPath();
    h.step(50);
    expect(mil.waterPath()).toBe(wp);
    expect(mil.waterPathRuns).toBe(1);
    h.until(() => h.game.ticks() === 601, 400); // tick 600: tribe boats and sea expansion in the same pass — one fill
    expect(mil.waterPathRuns).toBe(2);
    expect(mil.waterPath()).not.toBe(wp);
    h.until(() => h.game.ticks() === 701, 200);
    expect(mil.waterPathRuns).toBe(3);
  });
});

describe("boatsAfterCoast", () => {
  test("off: the early boat leaves at tick 60 while free land is still reachable by land", async () => {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true } });
    h.step(1);
    expect(h.bot["q"].neighbours().wilderness || h.bot["q"].freeLandReachable(1)).toBe(true);
    expect(h.until(() => h.me.units(UnitType.TransportShip).length > 0, 300)).toBe(true);
    expect(h.game.ticks()).toBeLessThanOrEqual(61);
    expect(h.bot.fired.get("boatsAfterCoast")).toBeUndefined();
  });

  test("on: no early boat and no tribe boat while free land is reachable; the launches the old rules would have made fire", async () => {
    const h = await playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatsAfterCoast: true }, rivals: [{ ...GULF, name: "Arabia", at: [1185, 425], tiles: [1173, 415, 1205, 434] }] }); // across the strait, 32 tiles
    h.until(() => h.game.ticks() === 501, 600);
    expect(h.me.units(UnitType.TransportShip).length).toBe(0);
    expect(h.log.some((l) => l.includes("boat"))).toBe(false);
    expect(h.bot.fired.get("boatsAfterCoast")).toBeGreaterThanOrEqual(2); // the early boat once, the tribe boat per pass
    expect(h.me.numTilesOwned()).toBeGreaterThan(0);
  });

  test("on: a small-landmass start still sends the early boat", async () => {
    const h = await playbookSetup({ map: "world", spawn: [1620, 438], tiles: ISLAND, troops: 100_000, bot: { ...QUIET, boatsNearest: true, boatsAfterCoast: true } });
    h.step(2); // the execution's first tick sets onSmallLandmass
    expect(h.bot["onSmallLandmass"]).toBe(true);
    expect(h.bot["q"].landmassSize(20_001)).toBe(1365);
    expect(h.bot["q"].neighbours().wilderness).toBe(true); // free land on the island too — the island start boats anyway
    expect(h.until(() => h.me.units(UnitType.TransportShip).length > 0, 300)).toBe(true);
    expect(h.log.find((l) => l.includes("early boat"))).toBeDefined();
    expect(h.bot.fired.get("boatsAfterCoast")).toBeUndefined();
  });
});
