// MirvRisk diagnostics (always on) and the `nationMirvAware` flag (docs/PlaybookBotPlan.md "Exploiting the nations'
// MIRV rules"): the nations' three MIRV rules (NationMIRVBehavior) evaluated against us, `MIRVED by` per enemy
// MIRV; with the flag, the crown MIRV goes only at a target that cannot counter, the steamroll line stops city
// levels / buys SAM cover / refuses a city-rich war target, and the denial line refuses a crossing war in hold mode.
//
// NB the steamroll rule reads Player.unitCount(City), which sums LEVELS: a level-3 city counts three.
import { describe, expect, test } from "vitest";
import { MirvRisk } from "../../src/core/execution/playbook/MirvRisk";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PRE_COMBO, PlaybookHarness, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { ...PRE_COMBO, steamrollLevels: false, expandFree: 0, expandContested: 0, capFullShare: 2, fightNotBeforeTick: 1e9, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, boatsWaterPath: false, takeFallout: false }; // the 2026-08-30 defaults are on; the fixtures set each flag explicitly

function risk(h: PlaybookHarness): MirvRisk {
  return (h.bot as unknown as { risk: MirvRisk }).risk;
}
function cities(h: PlaybookHarness, p: Player, n: number, x0: number, dx: number, y: number): void {
  for (let i = 0; i < n; i++) p.buildUnit(UnitType.City, h.game.ref(x0 + i * dx, y), {});
}
/** A silo and the live MIRV price: NationMIRVBehavior.considerMIRV's own gates, and the bot's `threats` test. */
function arm(h: PlaybookHarness, p: Player, x: number, y: number, gold = 30_000_000n): void {
  p.buildUnit(UnitType.MissileSilo, h.game.ref(x, y), {});
  p.addGold(gold);
}
const attacks = (h: PlaybookHarness) => h.log.filter((l) => / ATTACK /.test(l)).map((l) => /ATTACK (\w+) /.exec(l)![1]);
const buys = (h: PlaybookHarness) => h.log.filter((l) => /^t\d+ (build|level) /.test(l)).map((l) => l.replace(/^t\d+ /, ""));

describe("MirvRisk diagnostics (always on)", () => {
  const ME: Rect = [0, 0, 99, 57];
  const R: RivalSpec = { name: "R", type: PlayerType.Nation, at: [50, 80], tiles: [0, 58, 99, 99], troops: 50_000 };

  test("12 city units against a runner-up with 7 logs the steamroll rule with its numbers; a level counts as a unit; a silo and the MIRV price make a nation able to fire", async () => {
    const h = await playbookSetup({ spawn: [50, 30], tiles: ME, troops: 100_000, bot: QUIET, rivals: [R] });
    const r = h.rival("R");
    cities(h, h.me, 12, 5, 8, 10);
    cities(h, r, 7, 10, 10, 80);
    h.until(() => h.game.ticks() === 101, 200); // the tick-100 check
    expect(h.log).toContain("t100 MIRV RISK steamroll: 12 city units (levels) vs 10.5 (7 × 1.5, leader > 10) — nobody can fire");
    expect(h.log.filter((l) => l.includes("MIRV RISK")).length).toBe(1);
    h.me.units(UnitType.City)[0].increaseLevel();
    expect(risk(h).steamroll().units).toBe(13); // Player.unitCount sums levels
    arm(h, r, 50, 85);
    h.until(() => h.game.ticks() === 201, 200);
    expect(h.log).toContain("t200 MIRV RISK steamroll: 13 city units (levels) vs 10.5 (7 × 1.5, leader > 10) — 1 nation can fire (R)");
    expect(risk(h).canCounter(r)).toBe(true);
    expect(risk(h).canCounter(h.me)).toBe(false);
  });

  test("a real Medium nation with a silo and the MIRV price launches at the steamroll leader, and the MIRV is logged once with the rule", async () => {
    const h = await playbookSetup({ spawn: [50, 30], tiles: ME, troops: 100_000, bot: QUIET, rivals: [{ ...R, name: "N", ai: true }] });
    const n = h.rival("N");
    cities(h, h.me, 12, 5, 8, 10);
    cities(h, n, 7, 10, 10, 80);
    arm(h, n, 50, 85, 60_000_000n);
    expect(h.until(() => h.log.some((l) => l.includes("MIRVED by")), 1500)).toBe(true);
    const lines = h.log.filter((l) => l.includes("MIRVED by"));
    expect(lines[0]).toMatch(/^t\d+ MIRVED by N \(steamroll, 1st\)$/);
    expect(h.bot.mirvsTaken).toBe(1);
    h.step(50);
    expect(h.log.filter((l) => l.includes("MIRVED by")).length).toBe(1); // once per MIRV unit
    expect(h.log.some((l) => l.includes("MIRV RISK steamroll"))).toBe(true);
  });
});

describe("nationMirvAware: the crown MIRV", () => {
  const ME: Rect = [0, 0, 199, 60];
  async function crown(flag: boolean, targetSilo: boolean) {
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 30], tiles: ME, troops: 100_000, bot: { ...QUIET, nationMirvAware: flag }, rivals: [{ name: "T", type: PlayerType.Human, at: [100, 110], tiles: [0, 70, 199, 140], troops: 50_000 }] });
    const t = h.rival("T");
    h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 30), {});
    h.me.addGold(40_000_000n);
    if (targetSilo) arm(h, t, 100, 110);
    (h.game as unknown as { _ticks: number })._ticks = 12000; // the crown rule opens at 25:00
    h.until(() => h.game.ticks() === 12101, 200); // the mirv rule at 12000 and 12100
    return h;
  }

  test("off: fired at the larger un-allied player above us, silo or not", async () => {
    const h = await crown(false, true);
    expect(h.log.find((l) => /MIRV T \d+t \(crown \(we are #2\)\)/.test(l))).toBeDefined();
    expect(h.bot.fired.get("nationMirvAware")).toBeUndefined();
  });

  test("on: held while the target has a silo and the MIRV price, once per 600 ticks in the log", async () => {
    const h = await crown(true, true);
    expect(h.log.some((l) => / MIRV T /.test(l))).toBe(false);
    expect(h.log.filter((l) => l.endsWith("MIRV held: T can counter")).length).toBe(1);
    expect(h.me.units(UnitType.MIRV).length).toBe(0);
    expect(h.bot.fired.get("nationMirvAware")).toBeGreaterThanOrEqual(1);
  });

  test("on: fired at a target without a silo", async () => {
    const h = await crown(true, false);
    expect(h.log.find((l) => /MIRV T \d+t \(crown \(we are #2\)\)/.test(l))).toBeDefined();
    expect(h.log.some((l) => l.includes("MIRV held"))).toBe(false);
  });
});

describe("nationMirvAware: the steamroll line", () => {
  // us at 11 city units on the top half of big_plains; N (8 cities, a silo, the MIRV price) and R (2 cities, weak)
  // below: threshold 12, we are within one captured city of it
  const ME: Rect = [0, 0, 199, 80];
  const N: RivalSpec = { name: "N", type: PlayerType.Nation, at: [150, 140], tiles: [100, 81, 199, 199], troops: 700_000 };
  const R: RivalSpec = { name: "R", type: PlayerType.Human, at: [30, 100], tiles: [0, 81, 60, 120], troops: 20_000 };
  async function line(flags: Partial<PlaybookParams>, gold: bigint, samLevels: number[], troops = 300_000, tick = 0) {
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops, bot: { ...QUIET, ...flags }, rivals: [N, R] });
    if (tick > 0) (h.game as unknown as { _ticks: number })._ticks = tick;
    cities(h, h.me, 11, 10, 18, 20); // x 10 … 190
    cities(h, h.rival("N"), 8, 110, 10, 150);
    cities(h, h.rival("R"), 2, 30, 10, 100);
    arm(h, h.rival("N"), 150, 140);
    samLevels.forEach((lv, i) => { const s = h.me.buildUnit(UnitType.SAMLauncher, h.game.ref(10 + i * 18, 24), {}); for (let k = 1; k < lv; k++) s.increaseLevel(); }); // TestConfig.samRange = 20: a launcher covers the city beside it and the next one over
    h.step(h.nextRuleTick(10) - 1);
    h.me.addGold(gold);
    return h;
  }

  test("the rule's numbers: 11 vs 12 is near the line, one more city is over; the runner-up leaves the ranking when it is the target", async () => {
    const h = await line({ nationMirvAware: true }, 0n, []);
    const rk = risk(h);
    expect(rk.steamroll()).toMatchObject({ units: 11, second: 8, threshold: 12, near: true, over: false });
    expect(rk.steamroll(2, h.rival("R")).over).toBe(true);
    expect(rk.steamroll(8, h.rival("N"))).toMatchObject({ units: 19, second: 2, over: true });
    expect(rk.view().canFire.map((p) => p.name())).toEqual(["N"]);
  });

  test("off: gold goes to a city level; no STEAMROLL LINE line", async () => {
    const h = await line({}, 3_500_000n, [3, 3]);
    h.step(10);
    expect(buys(h)).toEqual(["level City → 2"]);
    expect(h.log.some((l) => l.includes("STEAMROLL LINE"))).toBe(false);
  });

  test("on: SAM cover first — levels to 3, then a launcher beside the uncovered cities — and no city level", async () => {
    const h = await line({ nationMirvAware: true }, 12_000_000n, [1, 3]);
    h.step(40);
    expect(h.log).toContain("t10 STEAMROLL LINE: 11 vs 12 — SAM cover 3/11 cities");
    expect(buys(h).slice(0, 3)).toEqual(["level SAM Launcher → 2", "level SAM Launcher → 3", "build SAM Launcher"]);
    expect(buys(h).some((b) => b.startsWith("level City") || b === "build City")).toBe(false);
    const sam = h.me.units(UnitType.SAMLauncher).find((s) => s.isUnderConstruction() || h.game.x(s.tile()) > 60)!;
    expect(sam).toBeDefined();
    expect(h.bot.fired.get("nationMirvAware")).toBeGreaterThanOrEqual(1);
  });

  test("on: the launcher's price is escrowed like the bomb fund — at 2:30 (the rail line wants its factory) 2M buys nothing while a SAM costs 3M; off buys the factory", async () => {
    const on = await line({ nationMirvAware: true }, 2_000_000n, [3, 3], 300_000, 1500);
    on.step(30);
    expect(buys(on)).toEqual(["build Defense Post"]); // the threat post vs N is a hard override, before the fund
    expect(on.bot.fired.get("nationMirvAware")).toBeGreaterThanOrEqual(1);
    const off = await line({}, 2_000_000n, [3, 3], 300_000, 1500);
    off.step(30);
    expect(buys(off)).toEqual(["build Defense Post", "build Factory"]);
    const rich = await line({ nationMirvAware: true }, 12_000_000n, [3, 3], 300_000, 1500);
    rich.step(60);
    expect(buys(rich).slice(0, 2)).toEqual(["build Defense Post", "build SAM Launcher"]); // the cover first, the factory out of what is left
    expect(buys(rich).indexOf("build Factory")).toBeGreaterThan(1);
  });

  test("the war target whose cities would carry us over the line is skipped (off: attacked)", async () => {
    const off = await line({ fightNotBeforeTick: 0 }, 0n, [3, 3], 2_000_000);
    expect(off.until(() => attacks(off).length > 0, 200)).toBe(true);
    expect(attacks(off)).toEqual(["R"]); // N at 700k is out of ratio
    const on = await line({ fightNotBeforeTick: 0, nationMirvAware: true }, 0n, [3, 3], 2_000_000);
    expect(on.until(() => attacks(on).length > 0, 200)).toBe(false);
    expect(on.log.find((l) => l.includes("no war on R: its 2 cities would carry us over the steamroll line (13 vs 12)"))).toBeDefined();
    expect(on.bot.fired.get("nationMirvAware")).toBeGreaterThanOrEqual(1);
  });
});

describe("nationMirvAware: the denial line in hold mode", () => {
  // 62.5 % of big_plains is ours (the hold opens at 62 % on Medium); T1's ~4400 tiles would carry the share to
  // ~74 % (denial at 65 %), T2's ~400 to ~63.5 %
  const ME: Rect = [0, 0, 199, 124];
  const T1: RivalSpec = { name: "T1", type: PlayerType.Nation, at: [110, 137], tiles: [30, 125, 199, 150], troops: 10_000 };
  const T2: RivalSpec = { name: "T2", type: PlayerType.Nation, at: [15, 131], tiles: [0, 125, 29, 137], troops: 40_000 };
  async function hold(flag: boolean, rivals: RivalSpec[]) {
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 60], tiles: ME, troops: 300_000, bot: { ...QUIET, nationMirvAware: flag, fightNotBeforeTick: 0 }, rivals });
    for (const r of rivals) arm(h, h.rival(r.name), r.at[0], r.at[1]);
    expect(h.until(() => attacks(h).length > 0, 300)).toBe(true);
    expect(h.log.some((l) => l.includes("FINISH mode grow → hold"))).toBe(true);
    return h;
  }

  test("off: the war goes to the better-scored threat although its tiles cross the line", async () => {
    const h = await hold(false, [T1, T2]);
    expect(attacks(h)).toEqual(["T1"]);
  });

  test("on: the crossing war is refused and the other threat is fought; once that one is dead T1 is the last threat and is fought", async () => {
    const h = await hold(true, [T1, T2]);
    expect(attacks(h)).toEqual(["T2"]);
    expect(h.log.find((l) => /no war on T1: its 4\d{3} tiles would carry our share to 7\d\.\d % \(denial at 65 %\)/.test(l))).toBeDefined();
    expect(h.bot.fired.get("nationMirvAware")).toBeGreaterThanOrEqual(1);
    expect(h.until(() => !h.rival("T2").isAlive(), 300)).toBe(true);
    expect(h.until(() => attacks(h).length > 1, 300)).toBe(true);
    expect(attacks(h)[1]).toBe("T1");
  });

  test("on: the last threat is fought even across the line", async () => {
    const h = await hold(true, [T1]);
    expect(attacks(h)).toEqual(["T1"]);
    expect(h.log.some((l) => l.includes("no war on T1"))).toBe(false);
  });
});
