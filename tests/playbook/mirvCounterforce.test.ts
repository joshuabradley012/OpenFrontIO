// Flag `mirvCounterforce` (combo loss analysis, docs/PlaybookBotPlan.md): 24 of 71 combo full-game losses were
// MIRVed down after leading while the bot fired ZERO MIRVs in 239 games — and the MirvRisk diagnostics named the
// saver minutes in advance (`MIRV RISK steamroll: … 1 saving (Greenland)`). While a MirvRisk rule is TRUE against
// us and rivals are armed or saving, Military.counterforce strikes the source: our MIRV at the most-armed rival
// when the price is there and maybeMIRV's own rules held, else a hydrogen bomb on the rival's silo.
//
// Fixture (samOnRisk's shape, spread over big_plains): 12 city units vs a runner-up nation R with 7 (12 ≥ 7 × 1.5
// and leader > 10 — the steamroll rule is TRUE), R saving (a silo and half the 25M MIRV price) or armed (the full
// price). R's silo sits at y=199, more than 105 tiles from our land, so the hydrogen's friend clearance passes.
// Shares stay under 0.5 (16000 of 40000 tiles each) so the plain victory-denial MIRV branch never fires.
// Noise pinned out as in samOnRisk: fightNotBeforeTick/boatAtTick 1e9 (no wars, no boats), capFullShare 2,
// expand 0, six pre-built factories (the rail line otherwise infills cities).
import { describe, expect, test } from "vitest";
import { MissileSiloExecution } from "../../src/core/execution/MissileSiloExecution";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PRE_COMBO, PlaybookHarness, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { ...PRE_COMBO, capFullShare: 2, fightAbove: 10, expandFree: 0, expandContested: 0, boatAtTick: 1e9, fightNotBeforeTick: 1e9, boatsNearest: false, boatsWaterPath: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, nationMirvAware: false, takeFallout: false, samOnRisk: false };
const ME: Rect = [0, 0, 199, 79]; // 16000 of 40000 tiles: share 0.4, under every denial line
const R: RivalSpec = { name: "R", type: PlayerType.Nation, at: [100, 150], tiles: [0, 120, 199, 199], troops: 50_000 };

function cities(h: PlaybookHarness, p: Player, n: number, x0: number, dx: number, y: number): void {
  for (let i = 0; i < n; i++) p.buildUnit(UnitType.City, h.game.ref(x0 + i * dx, y), {});
}
interface FixtureOpts {
  flags?: Partial<PlaybookParams>;
  meGold: bigint;
  rGold?: bigint; // 15M = saving (half the 25M MIRV price); 30M = can fire
  myCities?: number; // 12 puts the steamroll rule over the line against R's 7; 5 stays under minLeader 10
  rSilos?: [number, number][];
}
async function fixture({ flags = {}, meGold, rGold = 15_000_000n, myCities = 12, rSilos = [[100, 199]] }: FixtureOpts) {
  const h = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 100_000, bot: { ...QUIET, ...flags }, rivals: [R] });
  const r = h.rival("R");
  cities(h, h.me, myCities, 10, 15, 20);
  cities(h, r, 7, 20, 20, 160);
  for (let i = 0; i < 6; i++) h.me.buildUnit(UnitType.Factory, h.game.ref(15 + i * 12, 40), {}); // factories < 6 gates the rail line off
  const silo = h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 20), {});
  h.game.addExecution(new MissileSiloExecution(silo)); // buildUnit skips ConstructionExecution: attach the reload loop, or the silo fires once and stays on cooldown forever
  for (const [x, y] of rSilos) r.buildUnit(UnitType.MissileSilo, h.game.ref(x, y), {});
  r.addGold(rGold);
  h.me.addGold(meGold);
  return h;
}
const cf = (h: PlaybookHarness) => h.log.filter((l) => l.includes("COUNTERFORCE"));

describe("mirvCounterforce", () => {
  test("on, gold for a hydrogen but not the MIRV: the saving rival's silo is hydrogen-bombed; logged and fired", async () => {
    const h = await fixture({ flags: { mirvCounterforce: true }, meGold: 12_000_000n });
    expect(h.until(() => cf(h).length > 0, 300)).toBe(true);
    expect(cf(h)[0]).toMatch(/^t\d+ COUNTERFORCE R: H at silo 100,199 \(steamroll risk, 0 can fire, 1 saving\)$/);
    expect(h.log.some((l) => /BOMB Hydrogen Bomb at 100,199/.test(l))).toBe(true);
    expect(h.me.units(UnitType.MIRV).length).toBe(0); // 12M cannot reach the 25M MIRV
    expect(h.bot.fired.get("mirvCounterforce") ?? 0).toBeGreaterThan(0);
  });

  test("on, MIRV affordable: the MIRV goes first (no hydrogen), at the saving rival", async () => {
    const h = await fixture({ flags: { mirvCounterforce: true }, meGold: 40_000_000n });
    expect(h.until(() => cf(h).length > 0, 300)).toBe(true);
    expect(cf(h)[0]).toMatch(/^t\d+ COUNTERFORCE R: mirv \(steamroll risk, 0 can fire, 1 saving\)$/);
    h.step(5); // MirvExecution spawns the unit on its own first tick
    expect(h.me.units(UnitType.MIRV).length).toBe(1);
    expect(h.bot.fired.get("mirvCounterforce") ?? 0).toBeGreaterThan(0);
  });

  test("on + nationMirvAware, the rival CAN counter (silo and the full price): the MIRV is held, the silo is bombed instead", async () => {
    const h = await fixture({ flags: { mirvCounterforce: true, nationMirvAware: true }, meGold: 40_000_000n, rGold: 30_000_000n });
    expect(h.until(() => cf(h).length > 0, 300)).toBe(true);
    expect(cf(h)[0]).toMatch(/^t\d+ COUNTERFORCE R: H at silo 100,199 \(steamroll risk, 1 can fire, 0 saving\)$/);
    expect(h.me.units(UnitType.MIRV).length).toBe(0);
  });

  test("cfCooldown: with two silos to hit, the second counterforce launch waits the full cooldown", async () => {
    const h = await fixture({ flags: { mirvCounterforce: true }, meGold: 20_000_000n, rSilos: [[100, 199], [180, 199]] });
    expect(h.until(() => cf(h).length >= 2, 1200)).toBe(true);
    const at = cf(h).map((l) => Number(/^t(\d+)/.exec(l)![1]));
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(600);
    expect(cf(h)[0]).not.toBe(cf(h)[1]); // two different silos
  });

  test("off: the same picture fires nothing — no MIRV, no bomb, no log, no liveness count", async () => {
    const h = await fixture({ flags: { mirvCounterforce: false }, meGold: 40_000_000n });
    h.step(1500);
    expect(cf(h)).toEqual([]);
    expect(h.bot.bombs).toBe(0);
    expect(h.me.units(UnitType.MIRV).length).toBe(0);
    expect(h.bot.fired.get("mirvCounterforce")).toBeUndefined();
  });

  test("gate: without a live risk (5 city units stay under the rule's minLeader) the flag stays quiet", async () => {
    const h = await fixture({ flags: { mirvCounterforce: true }, meGold: 40_000_000n, myCities: 5 });
    h.step(1500);
    expect(cf(h)).toEqual([]);
    expect(h.bot.bombs).toBe(0);
    expect(h.bot.fired.get("mirvCounterforce")).toBeUndefined();
  });
});
