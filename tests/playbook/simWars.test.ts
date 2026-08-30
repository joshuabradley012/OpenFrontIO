// Flag `simWars` (#4): fight() sizes the war with the estimator (smallest 1k-step wave that wins with a 20 % margin)
// instead of fightRatio × the target's army. Fixture: a rich bot next to one weak scripted human, so both branches
// open the same war on the same tick and only the size (and the "sim:" annotation) differs.
import { describe, expect, test } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

// the whole 100×100 map is owned: with no free land the estimator's bar is 60 troops a tile (20 while wilderness remains,
// which a 30k-on-1.5k-tiles war never meets — that is the free-land gate the flag inherited from B1). The far half
// belongs to a 500k human nobody can afford, so R is the only candidate for both branches.
const ME: Rect = [0, 0, 99, 49];
const RV: Rect = [0, 50, 99, 64];
const WALL: Rect = [0, 65, 99, 99];

async function war(simWars: boolean) {
  const h = await playbookSetup({
    spawn: [50, 25],
    tiles: ME,
    troops: 200_000,
    bot: { simWars, fightNotBeforeTick: 0, fightMinCities: 0 },
    rivals: [
      { name: "R", type: PlayerType.Human, at: [50, 57], tiles: RV, troops: 30_000 },
      { name: "W", type: PlayerType.Human, at: [50, 85], tiles: WALL, troops: 500_000 },
    ],
  });
  const r = h.rival("R");
  expect(h.until(() => h.log.some((l) => l.includes("ATTACK R")), 200)).toBe(true);
  const line = h.log.find((l) => l.includes("ATTACK R"))!;
  const sent = Number(/← (\d+)k/.exec(line)![1]);
  return { h, r, line, sent };
}

describe("simWars", () => {
  test("off: the scorer sends fightRatio × the target's army (+1k)", async () => {
    const { line, sent } = await war(false);
    expect(line).not.toContain("sim:");
    expect(sent).toBeGreaterThanOrEqual(61); // 2 × 30k + 1k, plus what R regenerated before the first war tick
    expect(/\((2\.[0-2]\d)×\)/.test(line)).toBe(true); // 2 × its army + 1k
  });

  test("on: the estimator picks the size, the line says so, and the flag fires", async () => {
    const { h, line } = await war(true);
    expect(line).toContain("sim:");
    expect(/\((2\.[0-2]\d)×\)/.test(line)).toBe(false);
    expect(h.bot.fired.get("simWars")).toBeGreaterThanOrEqual(1);
    // the estimator's own record of the wave follows the ATTACK line
    expect(h.log.some((l) => /EST R wave=\d+ troops=\d+ tilesEst=\d+/.test(l))).toBe(true);
  });
});
