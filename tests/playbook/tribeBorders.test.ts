// Flag `tribeBorders` (docs/PlaybookBotPlan.md "Tribe traps"): harvestBots eats the weakest bordering tribe first;
// under the flag the ORDER (and only the order) changes — a tribe that also borders a non-ally rival is eaten
// first, so its frontier becomes a real border of ours before the rival takes it.
//
// Geometry (big_plains, 200×200): our band across the middle; tribe W (weakest, 1k) in the north-west corner,
// tribe R (4k) in the north-east with the human rival H stacked directly north of it — H touches R but never us.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, PRE_COMBO } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = {
  ...PRE_COMBO,
  expandFree: 0,
  expandContested: 0, // expand runs before tribes and would shift the spendable figure
  fightNotBeforeTick: 1e9, // no war on H: the fixture is about tribe ordering only
  multiWar: false,
  annexWars: false,
  lapseToAttack: false,
  boatsNearest: false,
  finishByBoat: false,
  takeFallout: false,
  boatAtTick: 1e9,
};

async function tribeGame(tribeBorders: boolean) {
  const h = await playbookSetup({
    map: "big_plains",
    spawn: [100, 90],
    tiles: [0, 40, 199, 139],
    troops: 600_000,
    bot: { ...QUIET, tribeBorders },
    rivals: [
      // W: the weakest tribe — the plain weakest-first pick. No rival anywhere near it.
      { name: "W", type: PlayerType.Bot, at: [20, 20], tiles: [0, 0, 40, 39], troops: 1_000 },
      // R: stronger, but its northern border touches the rival H — the flag's pick.
      { name: "R", type: PlayerType.Bot, at: [175, 25], tiles: [150, 10, 199, 39], troops: 4_000 },
      // H: a human rival adjacent to R only (our band starts at y 40; R fills y 10–39 between us and H).
      { name: "H", type: PlayerType.Human, at: [175, 5], tiles: [150, 0, 199, 9], troops: 10_000 },
    ],
  });
  h.until(() => h.log.some((l) => l.includes("bot ")), 60);
  return h;
}

describe("tribeBorders: rival-bordering tribes are eaten first", () => {
  test("flag on: the first click goes at R (borders H), TRIBE PRIORITY logged and fired", async () => {
    const h = await tribeGame(true);
    const first = h.log.find((l) => l.includes("bot "))!;
    expect(first).toContain("bot R ");
    expect(h.log.some((l) => l.includes("TRIBE PRIORITY R (borders H)"))).toBe(true);
    expect(h.bot.fired.get("tribeBorders") ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("flag off: the plain weakest-first order clicks W, no TRIBE PRIORITY, nothing fired", async () => {
    const h = await tribeGame(false);
    const first = h.log.find((l) => l.includes("bot "))!;
    expect(first).toContain("bot W ");
    expect(h.log.some((l) => l.includes("TRIBE PRIORITY"))).toBe(false);
    expect(h.bot.fired.get("tribeBorders")).toBeUndefined();
  });
});
