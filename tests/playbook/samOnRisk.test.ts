// Flag `samOnRisk` (rm1 loss analysis, docs/PlaybookBotPlan.md): 19 of 41 base full-game losses were
// steamroll-rule MIRVs landing minutes AFTER our own `MIRV RISK steamroll` warning, with ~3 SAMs standing.
// While the rule is true against us and a nation is armed, Economy.build raises the wall: a launcher per
// 4 city units (min 2, 300-tick spacing), every launcher to level 3, and a second silo (the counter MIRV),
// with the next launcher/silo price escrowed out of every discretionary buy like the bomb fund.
//
// Fixture (mirvAware's): 12 city units vs a runner-up nation with 7 (12 ≥ 7 × 1.5 and leader > 10 — the rule
// is TRUE), the nation armed with a silo and the MIRV price. Scripted nation: it never actually fires.
// Noise pinned out: fightAbove 10 (at cap the war gate ignores fightNotBeforeTick and would kill the armed
// nation, inheriting its gold), capFullShare 2 (no idle-at-cap buys), and six pre-built factories (the rail
// line otherwise infills cities, moving every per-city target).
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PlaybookHarness, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { capFullShare: 2, fightAbove: 10, expandFree: 0, expandContested: 0, boatAtTick: 1e9, fightNotBeforeTick: 1e9, boatsNearest: false, boatsWaterPath: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, nationMirvAware: false, takeFallout: false };
// big_plains: launchers keep a 60-tile spacing, so the 3-launcher wall needs more room than the 100 × 58 rect
const ME: Rect = [0, 0, 199, 99];
const R: RivalSpec = { name: "R", type: PlayerType.Nation, at: [100, 150], tiles: [0, 100, 199, 199], troops: 50_000 };

function cities(h: PlaybookHarness, p: Player, n: number, x0: number, dx: number, y: number): void {
  for (let i = 0; i < n; i++) p.buildUnit(UnitType.City, h.game.ref(x0 + i * dx, y), {});
}
async function fixture(samOnRisk: boolean) {
  const h = await playbookSetup({ map: "big_plains", spawn: [100, 50], tiles: ME, troops: 100_000, bot: { ...QUIET, samOnRisk }, rivals: [R] });
  const r = h.rival("R");
  cities(h, h.me, 12, 10, 15, 20);
  cities(h, r, 7, 20, 20, 160);
  for (let i = 0; i < 6; i++) h.me.buildUnit(UnitType.Factory, h.game.ref(15 + i * 12, 40), {}); // factories < 6 gates the rail line off
  r.buildUnit(UnitType.MissileSilo, h.game.ref(100, 150), {}); // armed: a silo and the MIRV price
  r.addGold(100_000_000n);
  h.me.addGold(40_000_000n);
  return h;
}
const sams = (h: PlaybookHarness) => h.me.units(UnitType.SAMLauncher);
const silos = (h: PlaybookHarness) => h.me.units(UnitType.MissileSilo);

describe("samOnRisk", () => {
  test("on: the wall goes up — 3 launchers (one per 4 city units), all to level 3, a second silo; logged and fired", async () => {
    const h = await fixture(true);
    expect(h.until(() => sams(h).length >= 3, 2500)).toBe(true); // base target is 2 (enemy silo, ceil(12/8))
    expect(h.until(() => silos(h).length >= 2, 3000)).toBe(true); // base target is 0 here (no port level / factory / idle-at-cap)
    expect(h.until(() => sams(h).length >= 3 && sams(h).every((s) => s.level() >= 3), 2500)).toBe(true);
    expect(h.log.some((l) => /^t\d+ SAM ON RISK: \d\/3 launchers, \d\/2 silos, fund \d+k$/.test(l))).toBe(true);
    expect(h.bot.fired.get("samOnRisk") ?? 0).toBeGreaterThan(0);
  });

  test("off: the same picture builds at most the base cover (2 launchers, no silo) and never fires the flag", async () => {
    const h = await fixture(false);
    h.step(4000);
    expect(sams(h).length).toBeLessThanOrEqual(2);
    expect(silos(h).length).toBe(0); // base target is 0 here: 12 city units, no port level, never idle at cap
    expect(h.bot.fired.get("samOnRisk")).toBeUndefined();
    expect(h.log.some((l) => l.includes("SAM ON RISK"))).toBe(false);
  });

  test("gate: with nobody armed (no enemy silo) the flag stays quiet even over the steamroll line", async () => {
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 50], tiles: ME, troops: 100_000, bot: { ...QUIET, samOnRisk: true }, rivals: [R] });
    const r = h.rival("R");
    cities(h, h.me, 12, 10, 15, 20);
    cities(h, r, 7, 20, 20, 160);
    for (let i = 0; i < 6; i++) h.me.buildUnit(UnitType.Factory, h.game.ref(15 + i * 12, 40), {});
    // no silo anywhere: nobody can fire or save toward a MIRV, so the rule being true stays academic
    h.me.addGold(40_000_000n);
    h.step(1500);
    expect(silos(h).length).toBe(0);
    expect(h.log.some((l) => l.includes("SAM ON RISK"))).toBe(false);
  });
});
