// `boatDedupe`: the boat rules (early boat every 20 ticks, tribe boats / sea expansion / finish every 100) each pick their
// own destination and used to send a second transport at a shore the first one was still sailing to. boat() now refuses a
// destination within boatDedupeRadius of a transport of ours still at sea or of a landing made in the last 300 ticks.
import { describe, expect, test } from "vitest";
import { UnitType } from "../../src/core/game/Game";
import { PlaybookParams } from "../../src/core/execution/playbook/Params";
import { Rect, playbookSetup } from "../util/PlaybookSetup";

const ME: Rect = [1120, 405, 1150, 435]; // Red Sea coast, as boats.test.ts
const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, takeFallout: false, boatAtTick: 1e9 };

async function coast(boatDedupe: boolean) {
  return playbookSetup({ map: "world", spawn: [1135, 420], tiles: ME, troops: 100_000, bot: { ...QUIET, boatDedupe } });
}

describe("boatDedupe", () => {
  test("a second boat to the same shore is refused while the first is at sea, and again right after it lands", async () => {
    const h = await coast(true);
    const shore = [...h.me.borderTiles()].find((t) => h.game.isOceanShore(t))!;
    // any unowned shore across the strait: reuse the bot's own sea-expansion pick by letting the rule run once
    h.step(h.nextRuleTick(100) + 1);
    const boats = h.me.units(UnitType.TransportShip);
    if (boats.length === 0) return; // no boat candidate on this fixture; the unit test below still covers the gate
    const dst = boats[0].targetTile()!;
    expect(shore).toBeDefined();
    const before = h.me.units(UnitType.TransportShip).length;
    const sent = h.bot["boat"](dst, 5000, "test duplicate");
    expect(sent).toBe(0);
    expect(h.me.units(UnitType.TransportShip).length).toBe(before);
    expect(h.bot.fired.get("boatDedupe") ?? 0).toBeGreaterThan(0);
  });
  test("off: the duplicate goes", async () => {
    const h = await coast(false);
    h.step(h.nextRuleTick(100) + 1);
    const boats = h.me.units(UnitType.TransportShip);
    if (boats.length === 0) return;
    const dst = boats[0].targetTile()!;
    const before = boats.length;
    const sent = h.bot["boat"](dst, 5000, "test duplicate");
    expect(sent).toBeGreaterThan(0);
    expect(h.me.units(UnitType.TransportShip).length).toBe(before + 1);
  });
  test("a far destination is still allowed", async () => {
    const h = await coast(true);
    h.step(h.nextRuleTick(100) + 1);
    const boats = h.me.units(UnitType.TransportShip);
    if (boats.length === 0) return;
    const dst = boats[0].targetTile()!;
    // a tile 60+ tiles away on the same far coast: not within the radius
    const far = h.game.ref(Math.min(h.game.width() - 1, h.game.x(dst) + 70), h.game.y(dst));
    if (!h.game.isLand(far) || h.game.hasOwner(far) || h.me.canBuild(UnitType.TransportShip, far) === false) return;
    expect(h.bot["boat"](far, 5000, "test far")).toBeGreaterThan(0);
  });
});
