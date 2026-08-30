// Flag `threatMap` (review #5): a per-border-segment influence map (ThreatMap.ts) built in the 50-tick border pass.
// Consumers: the reserve follows the undefended pressure, fight() prefers a rival busy on its other borders and avoids
// a thin border, threat posts go to the hottest segment, and a rival massing on a segment gets a pre-positioned post.
import { describe, expect, test } from "vitest";
import { Economy } from "../../src/core/execution/playbook/Economy";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Situation, SituationQueries } from "../../src/core/execution/playbook/Situation";
import { ThreatMap } from "../../src/core/execution/playbook/ThreatMap";
import { Player, PlayerType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const LEFT: Rect = [29, 58, 49, 90]; // two equal 21 × 33 rectangles under us
const RIGHT: Rect = [50, 58, 70, 90];
const THIRD: Rect = [71, 58, 95, 90]; // borders RIGHT only
const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0 };

function threat(h: PlaybookHarness): ThreatMap {
  return (h.bot as unknown as { q: SituationQueries }).q.rivals.threat;
}
function sit(h: PlaybookHarness): Situation {
  return (h.bot as unknown as { sit: Situation }).sit;
}

async function field(threatMap: boolean, rightTroops: number, ourTroops = 100_000) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: ourTroops, bot: { ...QUIET, threatMap },
    rivals: [
      { name: "L", type: PlayerType.Nation, at: [40, 75], tiles: LEFT, troops: 10_000 },
      { name: "R", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: rightTroops },
      { name: "C", type: PlayerType.Human, at: [83, 75], tiles: THIRD, troops: 50_000 },
    ],
  });
  h.step(2); // the execution is initialised on its first tick and runs on the second: readSituation samples the border at once
  return h;
}

describe("threatMap: the map", () => {
  test("a rival massed on a short border owns the hottest segment; its post tile sits on that border", async () => {
    const h = await field(true, 200_000);
    const tm = threat(h), R = h.rival("R"), L = h.rival("L");
    expect(tm.segments.length).toBeGreaterThan(0);
    expect(tm.hottest()?.rival).toBe(R);
    expect(tm.maxThreat(R)).toBeGreaterThan(tm.maxThreat(L));
    expect(tm.maxThreat(L)).toBeLessThan(0); // 10k across our whole southern half is no pressure at all
    const t = tm.postTileFor(R)!;
    expect(t).not.toBeNull();
    expect(h.game.y(t)).toBe(57);
    expect(h.game.x(t)).toBeGreaterThanOrEqual(50);
    expect(h.game.x(t)).toBeLessThanOrEqual(70);
    expect(h.me.borderTiles().has(t)).toBe(true);
    // C never touches us: no segment, no threat
    expect(tm.segmentsOf(h.rival("C")).length).toBe(0);
  });

  test("busyElsewhere: a third player attacking the rival counts the border they share, and only that", async () => {
    const h = await field(true, 100_000);
    const tm = threat(h), R = h.rival("R"), L = h.rival("L"), C = h.rival("C");
    expect(tm.busyElsewhere(R)).toBe(0);
    C.setTroops(200_000);
    h.attack(C, R, 30_000); // a third of R's army: the wave grinds on past the next 50-tick sample without killing R
    const t0 = tm.tick;
    expect(h.until(() => tm.tick > t0, 60)).toBe(true);
    expect(R.incomingAttacks().length).toBe(1);
    expect(tm.busyElsewhere(R)).toBeGreaterThan(0);
    expect(tm.busyElsewhere(R)).toBeLessThan(0.5); // one side of a rectangle
    expect(tm.busyElsewhere(L)).toBe(0);
  });

  test("off: the map stays empty and the border counts are the old ones", async () => {
    const h = await field(false, 200_000);
    expect(threat(h).segments.length).toBe(0);
    expect(sit(h).rival.get(h.rival("R"))?.borderTiles).toBeGreaterThan(0);
  });
});

describe("threatMap: consumers", () => {
  test("the reserve rises with a rival massing on the border", async () => {
    const calm = await field(true, 10_000), massed = await field(true, 200_000), swamped = await field(true, 200_000, 10_000), off = await field(false, 200_000);
    expect(sit(off).reserve).toBeCloseTo(sit(off).troops * 0.3, 0);
    expect(sit(calm).reserve).toBeCloseTo(sit(calm).troops * 0.3, 0); // nothing unanswered: the flat share, never less
    expect(sit(massed).reserve).toBeGreaterThan(sit(calm).reserve);
    expect(sit(swamped).reserve / sit(swamped).troops).toBeGreaterThan(sit(massed).reserve / sit(massed).troops);
    expect(sit(swamped).reserve).toBeGreaterThan(sit(swamped).troops * 0.55); // clamped at twice the flat share (sit.troops has since paid a click)
    massed.step(100); // the reserve site fires once per 100 ticks
    expect(massed.bot.fired.get("threatMap") ?? 0).toBeGreaterThan(0);
  });

  test("the threat post goes to the hottest segment instead of the border midpoint", async () => {
    const on = await field(true, 200_000), off = await field(false, 200_000);
    const econ = (h: PlaybookHarness) => (h.bot as unknown as { economy: Economy }).economy;
    const R = (h: PlaybookHarness) => h.rival("R");
    for (const h of [on, off]) h.me.addGold(1_000_000n); // canBuild needs the post's price
    const tOn = econ(on).defensePostTile(R(on))!, tOff = econ(off).defensePostTile(R(off))!;
    expect(tOn).not.toBeNull(); expect(tOff).not.toBeNull();
    const hot = threat(on).postTileFor(R(on))!;
    expect(on.game.manhattanDist(tOn, hot)).toBeLessThanOrEqual(16);
    expect(on.game.x(tOn)).not.toBe(off.game.x(tOff));
    expect(on.bot.fired.get("threatMap") ?? 0).toBeGreaterThan(0);
  });

  test("a rival massing without attacking is pre-positioned against: a post, not troops", async () => {
    const h = await field(true, 200_000);
    const R = h.rival("R");
    h.step(h.nextRuleTick(10));
    const mil = (h.bot as unknown as { military: { prePosition: Player | null } }).military;
    expect(mil.prePosition).toBe(R);
    expect(h.log.some((l) => /PRE-POSITION post vs R/.test(l))).toBe(true);
    expect(h.me.outgoingAttacks().length).toBe(0);
  });
});
