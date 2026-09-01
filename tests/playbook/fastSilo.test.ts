// Flag `fastSilo` (tempo package, docs/PlaybookBotPlan.md "Tempo: bombPush + fastSilo"): the offensive-silo
// schedule — the first silo goes when EITHER siloAtTick arrives OR rank ≤ 5 (tiles, non-bots) and gold covers
// silo + a bomb + the 400k buy reserve (2.15M), whichever is first; the port/factory gate is waived on the early
// path. A second silo follows the first bomb-opened war at the same gold bar. The 3000-tick floor and the buy
// gates stay. Fixtures pin siloAtTick to 1e9 so the plain path never wants one: every silo here is the flag's.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { playbookSetup, PlaybookHarness, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, expandEvery: 10, capFullShare: 2, fightNotBeforeTick: 1e9, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, duelPush: false, portWithoutPartnerTick: 1e9, siloAtTick: 1e9 };

function military(h: PlaybookHarness): Military {
  return (h.bot as unknown as { military: Military }).military;
}
const silosBuilt = (h: PlaybookHarness) => h.log.filter((l) => l.includes("build Missile Silo")).length;

async function fixture(flags: Partial<PlaybookParams>, tiles?: Rect) {
  const h = await playbookSetup({ map: "plains", spawn: [50, 50], tiles, troops: 5_000, bot: { ...QUIET, ...flags } });
  h.step(3010 - h.game.ticks()); // past the silo rule's hard 3000-tick floor
  // park the rail plan (buildRail retries only when ticks % 3000 === 0): rail infill cities sit BEFORE the silo in
  // the build chain and would spend the injected gold pass after pass — this fixture is about the silo schedule
  (h.bot as unknown as { economy: { rail: { failed: number } } }).economy.rail.failed = 25;
  return h;
}

describe("fastSilo", () => {
  test("on: rank 1 with silo + bomb + reserve in gold builds the first silo at the 3000-tick floor, long before siloAtTick — and a second follows the first bomb-opened war", async () => {
    const h = await fixture({ fastSilo: true }, [5, 5, 95, 95]); // 91 × 91: room for the second silo's 50-tile spacing
    h.me.addGold(6_000_000n);
    expect(h.until(() => silosBuilt(h) >= 1, 100)).toBe(true);
    expect(h.log.some((l) => /SILO early \(rank 1\)/.test(l))).toBe(true);
    expect(h.bot.fired.get("fastSilo")).toBeGreaterThanOrEqual(1);
    // no bomb war yet: no second silo, whatever the gold
    h.step(50);
    expect(silosBuilt(h)).toBe(1);
    // the first bomb-opened war unlocks the second
    (military(h) as unknown as { bombWarAt: number }).bombWarAt = h.game.ticks();
    h.me.addGold(6_000_000n);
    expect(h.until(() => silosBuilt(h) >= 2, 100)).toBe(true);
    expect(h.log.some((l) => l.includes("SILO early (second, after the bomb war)"))).toBe(true);
  });

  test("on: gold below silo + bomb + reserve builds nothing; topping it up builds", async () => {
    const h = await fixture({ fastSilo: true }, [5, 5, 95, 95]);
    h.me.removeGold(h.me.gold()); // income accrued on the way to t3010 — the test owns the treasury
    h.me.addGold(1_500_000n); // covers the plain silo buy gate (1.4M) but not the fast bar (2.15M)
    h.step(60);
    expect(silosBuilt(h)).toBe(0);
    h.me.addGold(5_000_000n);
    expect(h.until(() => silosBuilt(h) >= 1, 100)).toBe(true);
    expect(h.log.some((l) => /SILO early \(rank 1\)/.test(l))).toBe(true);
  });

  test("off: the same rank and gold build nothing before siloAtTick", async () => {
    const h = await fixture({}, [5, 5, 95, 95]);

    h.me.addGold(6_000_000n);
    h.step(200);
    expect(silosBuilt(h)).toBe(0);
    expect(h.log.some((l) => l.includes("SILO early"))).toBe(false);
    expect(h.bot.fired.get("fastSilo")).toBeUndefined();
  });
});
