// War accounting (docs/PlaybookBotPlan.md "Bomb fund and war yield"). Always on: every non-bot war ends with a
// `WAR RESULT <name>: +T tiles, -L troops, X troops/tile, D s` line. Flag `warYield`: manageRetreats brings a war
// home when its running cost over the last 200 ticks exceeds yieldMaxTroopsPerTile (120), and the war scorer adds
// 4 × clamp(1 − expectedCost / 120, 0, 1), expectedCost = the target's last measured troops/tile against us, else
// its density × 1.3 (Config.attackLogic's altAttackerLoss).
//
// Geometry (big_plains, 200 × 200): we hold [10..190] × [5..57]. The dear target D is a 3-wide, 240-long L-shaped neck
// (down x 99–101, then along y 197–199) held at its troop cap (203k, so it does not regrow) under two defence posts (the neck’s first 120 tiles): the front is
// three tiles, the post multiplies the loss by 5 and the per-tile time by 3, so our 2× wave (we sit at our 590k cap) buys
// ~700 troops a tile for minutes without the literal rules firing (D bleeds 282 a tile: under 90 % of its army
// after 72 tiles, so the "posts" rule is off before the wave halves, and under 70 % before the wave is at 20 %).
// The cheap target C is the same neck held by 12k troops and no post: ~35 troops a tile, over in a couple of minutes.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PRE_COMBO, PlaybookHarness, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { ...PRE_COMBO, expandFree: 0, expandContested: 0, fightNotBeforeTick: 0, fightMinCities: 0, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false }; // the 2026-08-30 defaults are on; the fixtures set each flag explicitly
const ME: Rect = [10, 5, 190, 57]; // 9593 tiles: a 590k troop cap
const NECK: Rect = [99, 58, 101, 199]; // 426 tiles down the middle ...
const NECK2: Rect = [102, 197, 199, 199]; // ... then 294 along the bottom edge: 720 in all
const RESULT = /^t\d+ WAR RESULT (\w+): \+(\d+) tiles, -(\d+) troops, (\d+|inf) troops\/tile, (\d+) s$/;

function military(h: PlaybookHarness): Military {
  return (h.bot as unknown as { military: Military }).military;
}
/** The neck target: `troops` ("cap" = its troop cap) on 720 tiles, two posts when `posted`; us with `ours` troops. */
async function neck(name: string, troops: number | "cap", posted: boolean, flags: Partial<PlaybookParams>, ours: number | "cap" = 300_000) {
  const h = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 1000, bot: { ...QUIET, ...flags }, rivals: [{ name, type: PlayerType.Human, at: [100, 150], tiles: NECK, troops: 1000 }] });
  h.me.setTroops(ours === "cap" ? h.game.config().maxTroops(h.me) : ours);
  const r = h.rival(name);
  for (let y = NECK2[1]; y <= NECK2[3]; y++) for (let x = NECK2[0]; x <= NECK2[2]; x++) r.conquer(h.game.ref(x, y));
  if (posted) { r.buildUnit(UnitType.DefensePost, h.game.ref(100, 85), {}); r.buildUnit(UnitType.DefensePost, h.game.ref(100, 145), {}); }
  r.setTroops(troops === "cap" ? h.game.config().maxTroops(r) : troops);
  return { h, r };
}
const results = (h: PlaybookHarness) => h.log.filter((l) => RESULT.test(l)).map((l) => RESULT.exec(l)!);

describe("WAR RESULT (always on)", () => {
  test("off: the dear war on the posted neck ends with a WAR RESULT line — tiles, troops that did not come back, the price of a tile, the length", async () => {
    const { h } = await neck("D", "cap", true, {}, "cap");
    expect(h.until(() => h.log.some((l) => l.includes(" ATTACK D ")), 100)).toBe(true);
    expect(h.until(() => results(h).length > 0, 3000)).toBe(true);
    const [, name, tiles, lost, cost, secs] = results(h)[0];
    expect(name).toBe("D");
    expect(Number(tiles)).toBeGreaterThan(0);
    expect(Number(lost)).toBeGreaterThan(1000);
    expect(Number(cost)).toBeGreaterThan(120); // the neck under a post is dear
    expect(Number(secs)).toBeGreaterThan(0);
    expect(h.log.some((l) => l.includes("YIELD retreat"))).toBe(false);
    expect(h.bot.fired.get("warYield")).toBeUndefined();
  });
});

describe("warYield", () => {
  test("on: the dear war is retreated with a YIELD line once its 200-tick cost exceeds yieldMaxTroopsPerTile, then WAR RESULT follows; the retreat fires", async () => {
    const { h } = await neck("D", "cap", true, { warYield: true }, "cap");
    expect(h.until(() => h.log.some((l) => l.includes(" ATTACK D ")), 100)).toBe(true);
    const t0 = h.game.ticks();
    expect(h.until(() => h.log.some((l) => l.includes("YIELD retreat")), 600)).toBe(true);
    const line = h.log.find((l) => l.includes("YIELD retreat"))!;
    expect(line).toMatch(/^t\d+ YIELD retreat from D: (\d+|inf) troops\/tile \(\d+k left\)$/);
    expect(h.game.ticks() - t0).toBeGreaterThanOrEqual(200); // two samples
    expect(Number(/: (\d+) troops/.exec(line)?.[1] ?? Infinity)).toBeGreaterThan(120);
    expect(h.log.some((l) => /^t\d+ retreat from D /.test(l))).toBe(false); // the literal rule had not fired
    expect(h.bot.fired.get("warYield")).toBeGreaterThanOrEqual(1);
    expect(h.until(() => results(h).length > 0, 600)).toBe(true);
    expect(results(h)[0][1]).toBe("D");
    expect(h.me.outgoingAttacks().length).toBe(0);
  });

  test("on: a cheap war (thin target, no post) runs to the end with no YIELD retreat", async () => {
    const { h } = await neck("C", 12_000, false, { warYield: true });
    expect(h.until(() => h.log.some((l) => l.includes(" ATTACK C ")), 100)).toBe(true);
    expect(h.until(() => results(h).length > 0, 3000)).toBe(true);
    expect(h.log.some((l) => l.includes("YIELD retreat"))).toBe(false);
    const [, , tiles, , cost] = results(h)[0];
    expect(Number(tiles)).toBeGreaterThan(250);
    expect(Number(cost)).toBeLessThan(120);
  });

  test("on: of two otherwise-equal neighbours the scorer prefers the one whose tiles are expected to be cheaper — the measured price of the other; the changed pick fires", async () => {
    const A: RivalSpec = { name: "A", type: PlayerType.Human, at: [80, 75], tiles: [60, 58, 99, 90], troops: 30_000 };
    const B: RivalSpec = { name: "B", type: PlayerType.Human, at: [120, 75], tiles: [101, 58, 140, 90], troops: 30_000 };
    const pickOf = (h: PlaybookHarness) => /ATTACK (\w+) /.exec(h.log.find((l) => l.includes(" ATTACK "))!)![1];
    const off = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 300_000, bot: QUIET, rivals: [A, B] });
    expect(off.until(() => off.log.some((l) => l.includes(" ATTACK ")), 100)).toBe(true);
    const first = pickOf(off);
    const on = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 300_000, bot: { ...QUIET, warYield: true }, rivals: [A, B] });
    const dear = on.rival(first) as Player;
    (military(on) as unknown as { yieldSeen: Map<Player, number> }).yieldSeen.set(dear, 300); // last time its tiles cost 300 troops each
    expect(on.until(() => on.log.some((l) => l.includes(" ATTACK ")), 100)).toBe(true);
    expect(pickOf(on)).not.toBe(first);
    expect(on.bot.fired.get("warYield")).toBeGreaterThanOrEqual(1);
    const other = on.rival(pickOf(on));
    expect(military(on).expectedCost(dear)).toBe(300);
    expect(military(on).expectedCost(other)).toBeCloseTo((other.troops() / other.numTilesOwned()) * 1.3, 5);
  });
});
