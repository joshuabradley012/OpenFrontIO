// Flag `hystRetreats` (#4): a running war is judged every 100 ticks as 'continue' vs 'retreat now' and comes home
// only after two losing verdicts in a row — or at once when it is lost outright (under retreatBelowRatio × the
// target's troops with an estimate that no longer wins). Off, the literal thresholds (under 20 % of the wave while
// the target keeps 70 %) recall it at the next 10-tick check.
import { describe, expect, test } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

// big_plains halves (~12k tiles each): a war that lasts longer than the 200 ticks the hysteresis needs
const ME: Rect = [20, 20, 180, 95];
const RV: Rect = [20, 96, 180, 180]; // adjacent to ME: a shared land border, or the attack has no front and ends at once
const SENT = 150_000;
const TARGET = 240_000; // density 20 a tile: a wave at 0.4× of it pays ~85 troops a tile, past the 80 the continue branch can carry

/** A 150k wave into a 240k nation, then the wave is held at `left` troops (and the target at its start) so every
 *  check sees the same picture: the real fight would otherwise move on between checks. */
async function heldWar(hystRetreats: boolean, left: number) {
  const h = await playbookSetup({
    map: "big_plains",
    spawn: [100, 60],
    tiles: ME,
    troops: SENT + 100_000, // 100k stays home: too few for a war of its own against 240k
    bot: { hystRetreats, realRetreats: true },
    rivals: [{ name: "R", type: PlayerType.Nation, at: [100, 140], tiles: RV, troops: TARGET }],
  });
  const r = h.rival("R");
  h.attack(h.me, r, SENT);
  h.step(2);
  const a = h.me.outgoingAttacks().find((x) => x.target() === r)!;
  expect(a).toBeDefined();
  h.step(h.nextRuleTick(10)); // the retreats rule records the wave's start (and, with the flag, its first check tick)
  const hold = (n: number) => {
    for (let i = 0; i < n; i++) {
      if (!a.retreating()) a.setTroops(left);
      r.setTroops(TARGET);
      h.step(1);
    }
  };
  return { h, r, a, hold };
}

describe("hystRetreats", () => {
  test("off: the literals recall the wave at the next 10-tick check", async () => {
    const { a, hold } = await heldWar(false, 20_000); // 13 % of the wave, target untouched
    hold(11);
    expect(a.retreating()).toBe(true);
  });

  test("on: the same wave survives the first losing check and comes home after the second", async () => {
    const { h, a, hold } = await heldWar(true, 100_000); // 100k ≥ 0.4 × 240k: not lost outright, but 0.75 × 100k home beats what it can still take
    hold(11);
    expect(a.retreating()).toBe(false); // where the literals would have recalled it
    hold(100); // first re-estimate: strike 1
    expect(a.retreating()).toBe(false);
    expect(h.log.some((l) => /war on R losing \(strike 1\)/.test(l))).toBe(true);
    hold(100); // second: home
    expect(a.retreating()).toBe(true);
    expect(h.log.some((l) => /retreat from R \(100k left; strike 2/.test(l))).toBe(true);
    expect(h.bot.fired.get("hystRetreats")).toBeGreaterThanOrEqual(1);
    expect(h.until(() => a.retreated(), 30)).toBe(true); // realRetreats: the RetreatExecution brings it home
  });

  test("on: a wave that is clearly lost retreats at the first check", async () => {
    const { h, a, hold } = await heldWar(true, 20_000); // 20k < 0.4 × 240k and the estimate cannot win
    hold(110);
    expect(a.retreating()).toBe(true);
    expect(h.log.some((l) => /retreat from R \(20k left; lost outright/.test(l))).toBe(true);
  });

  test("on: a winning wave is left alone", async () => {
    const { h, a, hold } = await heldWar(true, 400_000); // 1.67×: cheap tiles, continue wins
    hold(210);
    expect(a.retreating()).toBe(false);
    expect(h.log.some((l) => l.includes("retreat from R"))).toBe(false);
  });
});
