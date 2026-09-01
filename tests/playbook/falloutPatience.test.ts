// Flag `falloutPatience`: engine fallout never cools — one bit per tile (GameMap bit 13), cleared only by
// conquest (GameImpl.conquer) or flood, and the ~5× conquest penalty (Config.falloutDefenseModifier,
// 5 − 2 × GLOBAL fallout share) never varies with tile age. So the flag waits for the BOMBS, not the isotopes:
// takeFallout's expand is deferred while the bordering basins are still growing (a nuke landed < falloutCoolTicks
// ago), unless a living hostile non-bot owns land on a basin's rim (front-line fallout is taken at once).
import { describe, expect, test } from "vitest";
import { TileRef } from "../../src/core/game/GameMap";
import { PlayerType } from "../../src/core/game/Game";
import { PlaybookParams } from "../../src/core/execution/playbook/Params";
import { Rect, RivalSpec, playbookSetup } from "../util/PlaybookSetup";

const ME: Rect = [40, 40, 60, 60];
// Pins: the fixture needs takeFallout (default on) and quiet diplomacy/boats/wars, as the takeFallout tests pin them;
// duelPush/boatOpening off so a scripted Human rival draws no duel war or opening boats.
const QUIET: Partial<PlaybookParams> = { takeFallout: true, falloutCoolTicks: 300, fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false, boatsNearest: false, finishByBoat: false, boatAtTick: 1e9, duelPush: false, boatOpening: false };

/** Irradiate every unowned land tile within `band` of the rectangle: the only free land the bot can touch is fallout. */
function irradiate(h: Awaited<ReturnType<typeof playbookSetup>>, band: number) {
  const g = h.game as unknown as { setFallout(t: TileRef, v: boolean): void };
  let n = 0;
  for (let x = ME[0] - band; x <= ME[2] + band; x++) for (let y = ME[1] - band; y <= ME[3] + band; y++) {
    if (x >= ME[0] && x <= ME[2] && y >= ME[1] && y <= ME[3]) continue;
    const t = h.game.ref(x, y);
    if (h.game.isLand(t) && !h.game.hasOwner(t)) { g.setFallout(t, true); n++; }
  }
  return n;
}

async function ringed(bot: Partial<PlaybookParams>, rivals: RivalSpec[] = []) {
  const h = await playbookSetup({ map: "big_plains", spawn: [50, 50], tiles: ME, troops: 400_000, bot: { ...QUIET, ...bot }, rivals });
  const n = irradiate(h, 6);
  expect(n).toBeGreaterThan(200);
  h.step(2);
  return h;
}

describe("falloutPatience", () => {
  test("off: the takeFallout click goes at once into a fresh basin (existing behaviour)", async () => {
    const h = await ringed({ falloutPatience: false });
    const before = h.me.numTilesOwned();
    h.step(200);
    expect(h.me.numTilesOwned()).toBeGreaterThan(before + 50);
    expect(h.bot.fired.get("falloutPatience")).toBeUndefined();
  });
  test("on: a fresh basin (it just grew) is deferred — no click, the flag fires, the wait is logged", async () => {
    const h = await ringed({ falloutPatience: true });
    const before = h.me.numTilesOwned();
    h.step(250);
    expect(h.me.outgoingAttacks()).toHaveLength(0);
    expect(h.me.numTilesOwned()).toBe(before);
    expect(h.bot.fired.get("falloutPatience") ?? 0).toBeGreaterThan(0);
    expect(h.log.some((l) => l.includes("FALLOUT wait"))).toBe(true);
    expect(h.bot.fired.get("takeFallout")).toBeUndefined();
  });
  test("on: after falloutCoolTicks of quiet the click goes and the land is taken", async () => {
    const h = await ringed({ falloutPatience: true });
    const before = h.me.numTilesOwned();
    h.step(400);
    expect(h.me.numTilesOwned()).toBeGreaterThan(before + 50);
    expect(h.bot.fired.get("takeFallout") ?? 0).toBeGreaterThan(0);
    expect(h.log.some((l) => l.includes("FALLOUT expand"))).toBe(true);
  });
  test("on: a nuke mid-wait (the basin grows again) restarts the quiet window", async () => {
    const h = await ringed({ falloutPatience: true });
    const before = h.me.numTilesOwned();
    h.step(150);
    irradiate(h, 8); // a second nuke widens the basin; the next 100-tick scan sees the growth
    h.step(300); // past the ORIGINAL window (t≈450 > 310) but inside the restarted one
    expect(h.me.outgoingAttacks()).toHaveLength(0);
    expect(h.me.numTilesOwned()).toBe(before);
    h.step(250); // the restarted window (~t510) elapses
    expect(h.me.numTilesOwned()).toBeGreaterThan(before + 50);
  });
  test("on: a hostile on the basin's rim cancels the patience — front-line fallout is taken at once", async () => {
    const h = await ringed({ falloutPatience: true }, [
      { name: "enemy", type: PlayerType.Human, at: [71, 50], tiles: [67, 38, 75, 62], troops: 100_000 },
    ]);
    const before = h.me.numTilesOwned();
    h.step(200);
    expect(h.me.numTilesOwned()).toBeGreaterThan(before + 50);
    expect(h.bot.fired.get("falloutPatience")).toBeUndefined(); // same decision as off: nothing to count
    expect(h.bot.fired.get("takeFallout") ?? 0).toBeGreaterThan(0);
  });
});
