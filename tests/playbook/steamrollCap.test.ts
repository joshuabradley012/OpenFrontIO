// Flag `steamrollCap`: the city-unit cap follows the nations' steamroll-MIRV rule (NationMIRVBehavior: the leader is
// MIRVed past 10 city units at ≥ 1.5× the runner-up on Medium, 1.25× Hard) at 0.9× the multiplier and never under
// the rule's minimum, instead of the flat max(9, 1.15× runner-up) that pins the cap at 9 for most of a game.
import { describe, expect, test } from "vitest";
import { Economy } from "../../src/core/execution/playbook/Economy";
import { Difficulty, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const RV: Rect = [30, 58, 70, 90];

async function field(second: number, steamrollCap: boolean, difficulty = Difficulty.Medium, mine = 0) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 100_000, bot: { steamrollCap },
    config: { difficulty },
    rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 100_000 }],
  });
  const r = h.rival("R");
  for (let i = 0; i < second; i++) r.buildUnit(UnitType.City, h.game.ref(32 + (i % 12) * 3, 62 + Math.floor(i / 12) * 4), {});
  for (let i = 0; i < mine; i++) h.me.buildUnit(UnitType.City, h.game.ref(32 + (i % 12) * 3, 28 + Math.floor(i / 12) * 4), {});
  h.step(1); // the bot reads the game on its first tick
  const economy = (h.bot as unknown as { economy: Economy }).economy;
  return { h, economy };
}

describe("steamrollCap", () => {
  test("off: max(9, 1.15 × the runner-up)", async () => {
    expect((await field(8, false)).economy.cityUnitCap()).toBe(9);
    expect((await field(12, false)).economy.cityUnitCap()).toBe(13);
  });

  test("on: 0.9 × the rule's multiplier, never under its minimum leader size", async () => {
    expect((await field(8, true)).economy.cityUnitCap()).toBe(10); // 8 × 1.5 × 0.9 = 10.8 → 10, and the rule ignores leaders of ≤ 10
    expect((await field(12, true)).economy.cityUnitCap()).toBe(16); // 12 × 1.5 × 0.9
    expect((await field(12, true, Difficulty.Hard)).economy.cityUnitCap()).toBe(13); // 12 × 1.25 × 0.9
    expect((await field(4, true, Difficulty.Easy)).economy.cityUnitCap()).toBe(20);
  });

  test("on: fires when it lifts a cap the flat rule would have hit", async () => {
    const { h } = await field(12, true, Difficulty.Medium, 14); // 14 units: over 13 (off), under 16 (on)
    h.step(h.nextRuleTick(10));
    expect(h.bot.fired.get("steamrollCap")).toBeGreaterThanOrEqual(1);
    const off = await field(12, false, Difficulty.Medium, 14);
    off.h.step(off.h.nextRuleTick(10));
    expect(off.h.bot.fired.get("steamrollCap")).toBeUndefined();
  });
});
