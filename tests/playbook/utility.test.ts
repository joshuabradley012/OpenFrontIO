// Flag `utility` (review opportunity #3): one `troops` rule scores every expand click, tribe click and war wave in the
// same currency — expected tiles per troop over the phase horizon × compensated considerations (Utility.ts) — and
// executes by rank (0 counter, 1 opportunity, 2 normal) then weight, instead of the fixed expand → tribes → wars order.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { clamp, compensate, linear, logistic, Option, quadratic, rankOptions } from "../../src/core/execution/playbook/Utility";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

describe("utility curves", () => {
  test("linear, quadratic and logistic are clamped response curves", () => {
    expect(linear(-1)).toBe(0);
    expect(linear(0.25)).toBe(0.25);
    expect(linear(2)).toBe(1);
    expect(linear(5, 0, 10)).toBe(0.5);
    expect(linear(2, 4, 0)).toBe(0.5); // descending
    expect(quadratic(0.5)).toBe(0.25);
    expect(logistic(0.7, 0.7, 10)).toBeCloseTo(0.5, 6);
    expect(logistic(1, 0.7, 10)).toBeGreaterThan(0.95);
    expect(logistic(0.4, 0.7, 10)).toBeLessThan(0.05);
    expect(clamp(7, 0, 5)).toBe(5);
  });
  test("compensation lifts a product of n good considerations toward 1 and keeps a zero at zero", () => {
    expect(compensate([])).toBe(1);
    expect(compensate([0.9])).toBeCloseTo(0.9, 9); // n = 1: no compensation
    expect(compensate([0.9, 0.9])).toBeCloseTo(0.945 * 0.945, 9); // each 0.9 lifted by half its distance to 1; vs the raw 0.81
    expect(compensate([0.9, 0.9, 0.9, 0.9])).toBeGreaterThan(0.9 * 0.9 * 0.9 * 0.9);
    expect(compensate([0.9, 0.9, 0.9, 0.9])).toBeLessThan(1);
    expect(compensate([1, 1, 1])).toBe(1);
    expect(compensate([0.9, 0, 0.9])).toBe(0);
  });
  test("rank buckets first, weight inside a bucket, insertion order on a tie", () => {
    const o = (kind: Option["kind"], rank: Option["rank"], weight: number): Option => ({ kind, target: null, troops: 1000, rank, weight, why: "" });
    const ranked = rankOptions([o("expand", 2, 0.5), o("war", 1, 0.01), o("tribe", 2, 0.5), o("counter", 0, 0.001)]);
    expect(ranked.map((x) => x.kind)).toEqual(["counter", "war", "expand", "tribe"]);
  });
});

const ME: Rect = [30, 25, 70, 57]; // free land on its left and top
const BELOW: Rect = [30, 58, 70, 90];
const RIGHT: Rect = [71, 25, 95, 57];
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0 };

describe("utility: the troops rule", () => {
  async function field(utility: boolean) {
    // free land at 20 troops a tile; a tribe (the estimator: a 1.67× click takes its tiles at ~21 each — tribes are
    // never cheaper than free land on this engine, which is what the botsAfterWild A/B found); a nation at 2× whose
    // wave the estimator wins at ~40 a tile, with troops far under fightAbove × cap
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 120_000, bot: { ...WAR, utility },
      rivals: [
        { name: "T", type: PlayerType.Bot, at: [50, 75], tiles: BELOW, troops: 800 },
        { name: "R", type: PlayerType.Nation, at: [83, 40], tiles: RIGHT, troops: 15_000 },
      ],
    });
    h.step(h.nextRuleTick(10));
    return h;
  }

  test("off: the ordered rules run, no UTIL line, nothing fires", async () => {
    const h = await field(false);
    expect(h.log.some((l) => l.includes("UTIL"))).toBe(false);
    expect(h.log.some((l) => /^t10 bot T /.test(l))).toBe(true);
    expect(h.log.some((l) => /^t10 war held/.test(l))).toBe(true);
    expect(h.bot.fired.get("utility")).toBeUndefined();
  });

  test("on: every option is scored in tiles per troop and executed in weight order", async () => {
    const h = await field(true);
    const util = h.log.find((l) => l.startsWith("t10 UTIL "))!;
    expect(util).toBeDefined();
    const top = util.slice("t10 UTIL ".length).split(" | ");
    expect(top[0]).toMatch(/^expand \d+k r2 w0\.0500 \(contested land at 20\/tile/);
    expect(top[1]).toMatch(/^tribe T \d+k r2 w0\.0[34]\d\d \(\d+t for \d+k/);
    expect(top[2]).toMatch(/^war R \d+k r2 w0\.0\d\d\d \(\d+t for \d+k wins, cap 0\.1\d, margin 0\.\d\d, border 1\.00, trust 0\.75, expiry 1, score \d+\.\d\)$/);
    const w = (s: string) => Number(/ w([\d.]+) /.exec(s)![1]);
    expect(w(top[0])).toBeGreaterThan(w(top[1]));
    expect(w(top[1])).toBeGreaterThan(w(top[2]));
    // executed in that order: the expand click is the older attack, the tribe click follows, the war is held whole
    const out = h.me.outgoingAttacks();
    expect(out.findIndex((a) => !a.target().isPlayer())).toBeLessThan(out.findIndex((a) => a.target() === h.rival("T")));
    expect(h.log.some((l) => /^t10 bot T /.test(l))).toBe(true);
    expect(h.log.some((l) => /^t10 war held/.test(l))).toBe(true);
    // the same first send as the chain: nothing fired on this pass
    expect(h.bot.fired.get("utility")).toBeUndefined();
  });

  test("counters still go first (rank 0)", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { utility: true, fightNotBeforeTick: 1e9 },
      rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: BELOW, troops: 100_000 }],
    });
    const r = h.rival("R");
    h.attack(r, h.me, 30_000);
    h.step(h.nextRuleTick(10) - 1);
    h.step(1);
    expect(h.log.find((l) => l.includes("COUNTER R"))).toMatch(/with [23]\dk$/);
    const out = h.me.outgoingAttacks();
    expect(out[0].target()).toBe(r); // before the expand click of the same pass
    expect(out.some((a) => !a.target().isPlayer())).toBe(true);
  });

  test("a whole-or-nothing war is not starved by a preceding expand click", async () => {
    // 200k troops, reserve 60k, cap floor 75k: a 0.6 expand click (120k) leaves 6k for the 50k wave on the drained
    // nation, so the chain holds the war every pass. Under the flag the drained target is an opportunity (rank 1):
    // its wave goes first and whole, the expand click takes what is left.
    const params: Partial<PlaybookParams> = { ...WAR, expandContested: 0.6, expandFree: 0.6, drainedNations: true };
    const scenario = async (utility: boolean) => {
      const h = await playbookSetup({
        spawn: [50, 40], tiles: ME, troops: 200_000, bot: { ...params, utility },
        rivals: [{ name: "R", type: PlayerType.Nation, at: [85, 50], tiles: [71, 0, 99, 99], troops: 30_000 }],
      });
      h.step(h.nextRuleTick(10));
      return h;
    };
    const off = await scenario(false);
    expect(off.log.some((l) => /^t10 war held: wants 50k, only \dk spare$/.test(l))).toBe(true);
    expect(off.log.some((l) => l.includes("ATTACK R"))).toBe(false);
    const on = await scenario(true);
    expect(on.log.find((l) => l.startsWith("t10 UTIL "))).toMatch(/^t10 UTIL war R 50k r1 w0\.\d+ \(.*opportunity\) \| expand \d+k r2 /);
    expect(on.log.some((l) => /^t10 ATTACK R \d+t\/3\dk ← 50k \(1\.5\d×\) drained$/.test(l))).toBe(true);
    const out = on.me.outgoingAttacks();
    expect(out[0].target()).toBe(on.rival("R"));
    expect(out.some((a) => !a.target().isPlayer())).toBe(true); // the expand click still went, with the rest
    expect(on.bot.fired.get("utility")).toBeGreaterThan(0);
  });
});
