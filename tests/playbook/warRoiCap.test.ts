// Flag `warRoiCap` (docs/PlaybookBotPlan.md "War ROI cap"): a per-target realized ROI — troops lost per tile
// gained, an EMA over the last warRoiWindow resolved waves folded with the running wave's realized-so-far — past
// warRoiMax (500) on warRoiMinTiles (50) of sample retreats the running wave through the existing retreat path and
// blacklists the target for warRoiCooldown (3000) ticks below opportunity rank; the sticky filter releases a
// vetoed target; counters are exempt. Off = the plain bot grinds the same war to its WAR RESULT and re-declares.
//
// Geometry (big_plains, 200 × 200): we hold [10..190] × [5..57]; the dear target D is a 3-wide neck down the
// middle (y 58..175, ~380 tiles) held at its troop cap, every tile of it under one of two defence posts (range 30,
// at y 85 and 145) — the post multiplies the per-tile loss by 5 (Config.attackLogic: mag 80 → 400, the density
// term alone is 1.3 × 283 × 4 ≈ 1470 at 40 %), so our 2× wave realizes ~650–1000 troops a tile from the first
// yield sample while the literal retreat rules (20 % / 70 %) never fire.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PlaybookHarness, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, fightNotBeforeTick: 0, fightMinCities: 0, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false }; // pin the 2026-08-30 defaults; each fixture sets its flags explicitly
const ME: Rect = [10, 5, 190, 57];
const NECK: Rect = [99, 58, 101, 175];
const ABANDON = /^t\d+ WAR ROI D (\d+)\/tile — abandoned \((\d+)k coming home\), blacklisted 3000 ticks$/;

type MilitaryInternals = { roiVetoUntil: Map<Player, number>; roiHist: Map<Player, { ema: number; win: { tiles: number; lost: number }[] }>; history: Map<Player, { tick: number; troops: number; tiles: number; collapsedUntil: number }>; currentTarget_: Player | null; lastWarTick: number };
function military(h: PlaybookHarness): Military {
  return (h.bot as unknown as { military: Military }).military;
}
function internals(h: PlaybookHarness): MilitaryInternals {
  return military(h) as unknown as MilitaryInternals;
}

/** The dear neck target D: at its troop cap (regrowth keeps the grind dear) with its whole territory under two
 *  posts; us at our cap. */
async function neck(flags: Partial<PlaybookParams>) {
  const h = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 1000, bot: { ...QUIET, ...flags }, rivals: [{ name: "D", type: PlayerType.Human, at: [100, 150], tiles: NECK, troops: 1000 }] });
  h.me.setTroops(h.game.config().maxTroops(h.me));
  const r = h.rival("D");
  r.buildUnit(UnitType.DefensePost, h.game.ref(100, 85), {});
  r.buildUnit(UnitType.DefensePost, h.game.ref(100, 145), {});
  r.setTroops(h.game.config().maxTroops(r));
  return { h, r };
}

describe("warRoiCap", () => {
  test("on: the post-heavy grind is abandoned through the retreat path once the realized ROI clears 500/tile on 50 tiles of sample, the target stays vetoed, and the flag fires", async () => {
    const { h } = await neck({ warRoiCap: true });
    expect(h.until(() => h.log.some((l) => l.includes(" ATTACK D ")), 100)).toBe(true);
    expect(h.until(() => h.log.some((l) => ABANDON.test(l)), 3000)).toBe(true);
    const line = h.log.find((l) => ABANDON.test(l))!;
    const [, cost] = ABANDON.exec(line)!;
    expect(Number(cost)).toBeGreaterThan(500);
    const r = military(h).roi(h.rival("D"))!;
    expect(r.enough).toBe(true);
    expect(h.log.some((l) => /^t\d+ retreat from D /.test(l))).toBe(false); // not the literal rule
    expect(h.log.some((l) => l.includes("YIELD retreat"))).toBe(false); // not warYield (off)
    expect(h.bot.fired.get("warRoiCap")).toBeGreaterThanOrEqual(1);
    // the wave comes home through RetreatExecution and no new war is declared at the vetoed target
    expect(h.until(() => h.me.outgoingAttacks().length === 0, 600)).toBe(true);
    const attacks = () => h.log.filter((l) => l.includes(" ATTACK D ")).length;
    expect(attacks()).toBe(1);
    h.step(600);
    expect(attacks()).toBe(1); // the sticky target would have re-declared; the veto holds
    expect(h.log.some((l) => /^t\d+ WAR ROI D \d+\/tile — vetoed$/.test(l))).toBe(true);
  }, 30000);

  test("off: the plain bot grinds the same war — no WAR ROI line, nothing fires, the wave is never ROI-recalled", async () => {
    const { h } = await neck({});
    expect(h.until(() => h.log.some((l) => l.includes(" ATTACK D ")), 100)).toBe(true);
    h.step(1500); // well past the flag-on abandon point
    expect(h.log.some((l) => l.includes("WAR ROI"))).toBe(false);
    expect(h.bot.fired.get("warRoiCap")).toBeUndefined();
    // still grinding (or ground to its natural WAR RESULT) — never brought home by the ROI rule
    const stillOn = h.me.outgoingAttacks().some((a) => a.target() === h.rival("D") && !a.retreating());
    const resolved = h.log.some((l) => l.includes("WAR RESULT D"));
    expect(stillOn || resolved).toBe(true);
  }, 30000);

  test("on: a vetoed sticky target releases the filter and the scorer's veto sends the war to the other neighbour; off, the sticky filter re-selects it", async () => {
    const A: RivalSpec = { name: "A", type: PlayerType.Human, at: [80, 75], tiles: [60, 58, 99, 90], troops: 30_000 };
    const B: RivalSpec = { name: "B", type: PlayerType.Human, at: [120, 75], tiles: [101, 58, 140, 90], troops: 30_000 };
    const run = async (flags: Partial<PlaybookParams>) => {
      const h = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 300_000, bot: { ...QUIET, ...flags }, rivals: [A, B] });
      const m = internals(h), dear = h.rival("A");
      m.roiVetoUntil.set(dear, h.game.ticks() + 3000); // A was abandoned for its price a moment ago
      m.roiHist.set(dear, { ema: 1400, win: [{ tiles: 60, lost: 84_000 }] });
      m.currentTarget_ = dear; // ... and is still the sticky target of that war
      m.lastWarTick = h.game.ticks();
      expect(h.until(() => h.log.some((l) => l.includes(" ATTACK ")), 100)).toBe(true);
      return { h, pick: /ATTACK (\w+) /.exec(h.log.find((l) => l.includes(" ATTACK "))!)![1] };
    };
    const off = await run({});
    expect(off.pick).toBe("A"); // the plain sticky filter holds B out and re-declares the dear war
    const on = await run({ warRoiCap: true });
    expect(on.pick).toBe("B"); // the veto releases the sticky filter and refuses A below opportunity rank
    expect(on.h.bot.fired.get("warRoiCap")).toBeGreaterThanOrEqual(1);
  }, 30000);

  test("on: an opportunity target bypasses — a collapsed neighbour is attacked despite a vetoed, terrible ROI", async () => {
    const A: RivalSpec = { name: "A", type: PlayerType.Human, at: [80, 75], tiles: [60, 58, 99, 90], troops: 30_000 };
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: ME, troops: 300_000, bot: { ...QUIET, warRoiCap: true }, rivals: [A] });
    const m = internals(h), a = h.rival("A");
    m.roiVetoUntil.set(a, h.game.ticks() + 3000);
    m.roiHist.set(a, { ema: 1400, win: [{ tiles: 60, lost: 84_000 }] });
    m.history.set(a, { tick: h.game.ticks(), troops: a.troops() * 3, tiles: a.numTilesOwned() * 3, collapsedUntil: h.game.ticks() + 600 }); // collapsed: troops down by 2/3 inside 10 s
    expect(h.until(() => h.log.some((l) => l.includes(" ATTACK A ")), 50)).toBe(true);
  }, 30000);

  test("on: counters are exempt — an incoming wave from a vetoed target is still countered and the counter is never ROI-recalled", async () => {
    const h = await playbookSetup({ spawn: [50, 40], tiles: [30, 25, 70, 57], troops: 100_000, bot: { ...QUIET, warRoiCap: true }, rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: [30, 58, 70, 90], troops: 100_000 }] });
    const m = internals(h), r = h.rival("R");
    m.roiVetoUntil.set(r, h.game.ticks() + 3000);
    m.roiHist.set(r, { ema: 1400, win: [{ tiles: 60, lost: 84_000 }] });
    h.attack(r, h.me, 20_000);
    expect(h.until(() => h.log.some((l) => l.includes("COUNTER R")), 40)).toBe(true);
    h.step(60);
    expect(h.log.some((l) => l.includes("WAR ROI R"))).toBe(false); // the counter wave was not abandoned for its price
  }, 30000);
});
