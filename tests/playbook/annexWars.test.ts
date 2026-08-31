// Flag `annexWars`: Situation.annexable samples the target's border (ours-adjacent ≥ 40 %, third-party-or-unowned
// ≤ 15 %; a coast or map edge no longer disqualifies), an annexable unfriendly neighbour is a war opportunity at
// 1.2× (ANNEX WAR), and no alliance is requested from or accepted with one. Off = the old rule (a single ocean-shore
// or map-edge border tile refuses; annexable only rings expand's click).
//
// The coastal case runs on half_land_half_ocean (8 land columns, the ocean east of x = 7): the target's east side is
// ocean shore and we hold its other three sides. The war and alliance cases run on big_plains, which has no water,
// with the target on the west map edge: annexable treats an ocean shore and a map edge as one class (nobody
// reinforces through either), and the old rule refused the target on its edge corner tiles.
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { SituationQueries } from "../../src/core/execution/playbook/Situation";
import { Player, PlayerType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, PRE_COMBO, Rect } from "../util/PlaybookSetup";

const ME: Rect = [0, 60, 79, 159];
const TARGET: Rect = [0, 80, 29, 139]; // 30 × 60 on the west edge, inside ME's rectangle (conquered after it)
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];
const HOME: Partial<PlaybookParams> = { ...PRE_COMBO, expandFree: 0, expandContested: 0, boatAtTick: 1e9 };
const queries = (h: PlaybookHarness) => (h.bot as unknown as { q: SituationQueries }).q;

async function edgeTarget(annexWars: boolean, troops: number, targetTroops: number, bot: Partial<PlaybookParams> = {}) {
  const h = await playbookSetup({
    map: "big_plains", spawn: [55, 110], tiles: ME, troops, bot: { ...HOME, annexWars, ...bot },
    rivals: [{ name: "T", type: PlayerType.Human, at: centre(TARGET), tiles: TARGET, troops: targetTroops }],
  });
  return { h, t: h.rival("T") };
}

/** Border classes as annexable() sees them (every tile, not the sample). */
function borderClasses(h: PlaybookHarness, p: Player): { ours: number; coast: number; other: number; n: number } {
  const mg = h.game;
  let ours = 0, coast = 0, other = 0, n = 0;
  for (const t of p.borderTiles()) {
    n++;
    let mine = false, third = false;
    for (const nb of mg.neighbors(t)) { const o = mg.owner(nb); if (o === h.me) { mine = true; break; } if (o !== p && mg.isLand(nb)) third = true; }
    if (mine) ours++; else if (third) other++; else if (mg.isOnEdgeOfMap(t) || mg.isOceanShore(t)) coast++;
  }
  return { ours, coast, other, n };
}

/** A 4 × 4 target on the ocean shore of half_land_half_ocean, the rest of the land ours. */
async function coastalTarget(annexWars: boolean) {
  const h = await playbookSetup({
    map: "half_land_half_ocean", spawn: [2, 2], tiles: [0, 0, 7, 15], troops: 50_000, bot: { ...HOME, annexWars },
    rivals: [{ name: "T", type: PlayerType.Human, at: [5, 7], tiles: [4, 6, 7, 9], troops: 5_000 }],
  });
  return { h, t: h.rival("T") };
}

describe("annexWars: annexable on an ocean coast", () => {
  test("the fixture: the target's shore is a sixth of its border, the rest is ours", async () => {
    const { h, t } = await coastalTarget(false);
    const c = borderClasses(h, t);
    expect(c.coast).toBeGreaterThan(0);
    expect(c.ours / c.n).toBeGreaterThan(0.6);
    expect(c.other).toBe(0);
    expect([...t.borderTiles()].some((x) => h.game.isOceanShore(x))).toBe(true);
    expect(t.numTilesOwned()).toBeLessThan(h.me.numTilesOwned());
  });

  test("off: one shore tile refuses the whole target", async () => {
    const { h, t } = await coastalTarget(false);
    h.step(1);
    expect(queries(h).annexable(t)).toBe(false);
    expect(queries(h).annexableChanged(t)).toBe(false);
  });

  test("on: annexable from its land side, logged as coastal, and the flag knows the old rule said no", async () => {
    const { h, t } = await coastalTarget(true);
    h.step(1);
    expect(queries(h).annexable(t)).toBe(true);
    expect(queries(h).annexableChanged(t)).toBe(true);
    expect(h.log.some((l) => /ANNEX target T \d+t \(\d+ % of its border is ours, 0 % faces others, coastal\)/.test(l))).toBe(true);
  });
});

describe("annexWars: annexable on a map edge", () => {
  test("off: the edge corner tiles refuse the whole target", async () => {
    const { h, t } = await edgeTarget(false, 300_000, 400_000);
    h.step(1);
    expect(queries(h).annexable(t)).toBe(false);
    expect(queries(h).annexableChanged(t)).toBe(false);
  });

  test("on: annexable — every border tile that is not on the edge is ours", async () => {
    const { h, t } = await edgeTarget(true, 300_000, 400_000);
    h.step(1);
    const c = borderClasses(h, t);
    expect(c.ours / c.n).toBeGreaterThan(0.9); // an edge tile is a border tile only where it touches us (GameMap.isBorder)
    expect(queries(h).annexable(t)).toBe(true);
    expect(queries(h).annexableChanged(t)).toBe(true);
  });

  test("on: a target with a third party on more than 15 % of its border is not annexable", async () => {
    // T's south side faces R instead of us: 30 of ~180 border tiles → 17 %
    const h = await playbookSetup({
      map: "big_plains", spawn: [55, 110], tiles: ME, troops: 300_000, bot: { ...HOME, annexWars: true },
      rivals: [
        { name: "T", type: PlayerType.Human, at: centre(TARGET), tiles: TARGET, troops: 400_000 },
        { name: "R", type: PlayerType.Human, at: [15, 150], tiles: [0, 140, 29, 159], troops: 400_000 },
      ],
    });
    h.step(1);
    const c = borderClasses(h, h.rival("T"));
    expect(c.other / c.n).toBeGreaterThan(0.15);
    expect(queries(h).annexable(h.rival("T"))).toBe(false);
  });
});

describe("annexWars: the war", () => {
  // 300k vs 100k: maxSend = 0.6 × 300k = 180k, ratio 1.8 — under fightRatio (2.0) and not affordable (2 × 100k + 1k
  // > spendable × 0.6), so the plain war rule never opens it
  test("off: an encircled neighbour at 1.8× is below fightRatio, no war", async () => {
    const { h, t } = await edgeTarget(false, 300_000, 100_000);
    h.step(41);
    expect(h.me.outgoingAttacks().some((a) => a.target() === t)).toBe(false);
    expect(h.log.some((l) => l.includes("ANNEX WAR"))).toBe(false);
    expect(h.bot.fired.get("annexWars")).toBeUndefined();
  });

  test("on: the annexable neighbour is an opportunity — a 1.2× wave goes, logged ANNEX WAR, the flag fires", async () => {
    const { h, t } = await edgeTarget(true, 300_000, 100_000);
    expect(h.until(() => h.me.outgoingAttacks().some((a) => a.target() === t), 41)).toBe(true);
    const line = h.log.find((l) => l.includes("ANNEX WAR T"));
    expect(line).toBeDefined();
    expect(line).toMatch(/← 1\d\dk \(1\.2\d×\): we hold most of its border/); // 1.2 × its troops + 1000, not fightRatio
    expect(h.log.some((l) => /ATTACK T /.test(l))).toBe(true);
    expect(h.bot.fired.get("annexWars")).toBeGreaterThanOrEqual(1);
  });

  test("on: below 1.2× nothing goes", async () => {
    const { h, t } = await edgeTarget(true, 300_000, 200_000); // maxSend 180k / 200k = 0.9
    h.step(41);
    expect(h.me.outgoingAttacks().some((a) => a.target() === t)).toBe(false);
    expect(h.log.some((l) => l.includes("ANNEX WAR"))).toBe(false);
  });
});

describe("annexWars: no alliance with an annexable player", () => {
  // 400k vs our 300k: no war either way; the alliance rule runs at t300
  test("off: the edge target is not annexable, so the request goes and its own is accepted", async () => {
    const { h, t } = await edgeTarget(false, 300_000, 400_000);
    h.step(h.nextRuleTick(300));
    expect(t.incomingAllianceRequests().some((r) => r.requestor() === h.me)).toBe(true);
  });

  test("on: no request, and the target's request is refused; the flag fires on the refusal", async () => {
    const { h, t } = await edgeTarget(true, 300_000, 400_000);
    h.step(h.nextRuleTick(300));
    expect(t.incomingAllianceRequests().some((r) => r.requestor() === h.me)).toBe(false);
    h.game.addExecution(new AllianceRequestExecution(t, h.me.id()));
    h.step(3);
    expect(h.me.allianceWith(t)).toBeNull();
    expect(h.bot.fired.get("annexWars")).toBeGreaterThanOrEqual(1);
  });

  test("off: the target's request is accepted", async () => {
    const { h, t } = await edgeTarget(false, 300_000, 400_000);
    h.step(h.nextRuleTick(300));
    h.game.addExecution(new AllianceRequestExecution(t, h.me.id()));
    h.step(3);
    expect(h.me.allianceWith(t)).not.toBeNull();
  });
});
