// `steamrollLevels`: NationMIRVBehavior.countCities() reads Player.unitCount(City), which SUMS unit levels — so the
// steamroll MIRV rule (leader > minLeader and >= mult × runner-up) is about city levels, not units. The bot keeps its
// level sum under 0.9 × mult × the runner-up's level sum: no new city and no city level past the line.
import { describe, expect, test } from "vitest";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { PlaybookParams } from "../../src/core/execution/playbook/Params";
import { Rect, playbookSetup } from "../util/PlaybookSetup";

const ME: Rect = [30, 30, 70, 70];
const RV: Rect = [100, 30, 140, 70];
const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false, boatsNearest: false, finishByBoat: false, boatsWaterPath: false, takeFallout: false, boatAtTick: 1e9, capFullShare: 0 };

async function rich(steamrollLevels: boolean, ourLevels: number, theirLevels: number) {
  const h = await playbookSetup({ map: "big_plains", spawn: [50, 50], tiles: ME, troops: 2_000_000, bot: { ...QUIET, steamrollLevels }, rivals: [{ name: "R", type: PlayerType.Nation, at: [120, 50], tiles: RV, troops: 200_000 }] });
  const r = h.rival("R");
  // hand out city levels directly: N cities at level 1 (each city unit = 1 level)
  for (let i = 0; i < ourLevels; i++) h.me.buildUnit(UnitType.City, h.game.ref(40 + (i % 6) * 4, 40 + Math.floor(i / 6) * 4), {});
  for (let i = 0; i < theirLevels; i++) r.buildUnit(UnitType.City, h.game.ref(110 + (i % 6) * 4, 40 + Math.floor(i / 6) * 4), {});
  h.me.addGold(50_000_000n);
  return h;
}

describe("steamrollLevels", () => {
  test("on: at 12 levels against a runner-up on 6 (line max(10, 8) = 10) no city or level is bought", async () => {
    const h = await rich(true, 12, 6);
    const before = h.me.unitsOwned(UnitType.City);
    h.step(300);
    expect(h.me.unitsOwned(UnitType.City)).toBe(before);
    expect(h.log.some((l) => l.includes("STEAMROLL LEVELS"))).toBe(true);
    expect(h.bot.fired.get("steamrollLevels") ?? 0).toBeGreaterThan(0);
  });
  test("off: the same bot keeps levelling", async () => {
    const h = await rich(false, 12, 6);
    const before = h.me.unitsOwned(UnitType.City);
    h.step(300);
    expect(h.me.unitsOwned(UnitType.City)).toBeGreaterThan(before);
    expect(h.bot.fired.get("steamrollLevels")).toBeUndefined();
  });
  test("on but under the line (8 vs a runner-up on 12): levels are still bought", async () => {
    const h = await rich(true, 8, 12);
    const before = h.me.unitsOwned(UnitType.City);
    h.step(300);
    expect(h.me.unitsOwned(UnitType.City)).toBeGreaterThan(before);
  });
});
