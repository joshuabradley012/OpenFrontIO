// Flag `takeFallout`: PlayerImpl.nearby() hides unowned fallout land, so a bot ringed by irradiated land has
// `wilderness` false and never expands — although a TerraNullius attack takes those tiles (conquest clears the
// fallout). With the flag on, the expand click goes whenever fallout borders us and troops are near cap.
import { describe, expect, test } from "vitest";
import { TileRef } from "../../src/core/game/GameMap";
import { PlaybookParams } from "../../src/core/execution/playbook/Params";
import { Rect, playbookSetup } from "../util/PlaybookSetup";

const ME: Rect = [40, 40, 60, 60];
const QUIET: Partial<PlaybookParams> = { fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false, boatsNearest: false, finishByBoat: false, boatAtTick: 1e9 };

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

async function ringed(takeFallout: boolean) {
  const h = await playbookSetup({ map: "big_plains", spawn: [50, 50], tiles: ME, troops: 400_000, bot: { ...QUIET, takeFallout } });
  const n = irradiate(h, 6);
  expect(n).toBeGreaterThan(200);
  h.step(2);
  return h;
}

describe("takeFallout", () => {
  test("the engine hides fallout from nearby(): a bot ringed by irradiated land sees no wilderness", async () => {
    const h = await ringed(false);
    expect(h.me.nearby().some((n) => !n.isPlayer())).toBe(false);
    expect(h.me.numTilesOwned()).toBe(21 * 21);
  });
  test("off: no expand click, the territory never grows", async () => {
    const h = await ringed(false);
    const before = h.me.numTilesOwned();
    h.step(200);
    expect(h.me.outgoingAttacks()).toHaveLength(0);
    expect(h.me.numTilesOwned()).toBe(before);
    expect(h.bot.fired.get("takeFallout")).toBeUndefined();
  });
  test("on: an expand click goes into the fallout and the land is taken (conquest clears the fallout)", async () => {
    const h = await ringed(true);
    const before = h.me.numTilesOwned();
    h.step(200);
    expect(h.me.numTilesOwned()).toBeGreaterThan(before + 50);
    expect(h.bot.fired.get("takeFallout") ?? 0).toBeGreaterThan(0);
    expect(h.log.some((l) => l.includes("FALLOUT expand"))).toBe(true);
    const taken = [...h.me.tiles()].filter((t) => h.game.hasFallout(t));
    expect(taken).toHaveLength(0);
  });
  test("on but under fightAbove: idle troops only — no click while the army is small", async () => {
    const h = await playbookSetup({ map: "big_plains", spawn: [50, 50], tiles: ME, troops: 20_000, bot: { ...QUIET, takeFallout: true } });
    irradiate(h, 6);
    h.step(100);
    expect(h.me.outgoingAttacks()).toHaveLength(0);
  });
});
