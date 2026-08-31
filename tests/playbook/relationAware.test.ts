// Flag `relationAware` (opportunity #2): requestAlliances asks a nation only when NationAllianceBehavior.getAllianceDecision
// would say yes dice aside (Rivals.wouldAcceptAlliance: traitor, capacity, threat, relation, early window, similar
// strength) — a refusal we asked for is no signal and used to dock trust. Prey selection prefers, among neighbours within
// 1.15× of the weakest, the nation whose relation to us is highest (a lapsed ally stays Friendly/Neutral; the first hit
// leaves it Distrustful, whereas a never-allied nation goes Hostile and hunts us at 3×); the war scorer adds +2 / +0.5.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType, Relation } from "../../src/core/game/Game";
import { playbookSetup, PRE_COMBO, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const LEFT: Rect = [29, 58, 49, 90];
const RIGHT: Rect = [50, 58, 70, 90];
const RV: Rect = [30, 58, 70, 90];
const WAR: Partial<PlaybookParams> = { ...PRE_COMBO, fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };

describe("relationAware: alliance requests", () => {
  async function request(relationAware: boolean, relation: number) {
    // 100k vs 80k: no threat (Medium: > 2.5×), not prey; inside the early-game window the nation says yes unless
    // the relation is under Neutral
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, relationAware, fightNotBeforeTick: 1e9 }, // no expansion: on plains we would soon hold 40 % of its border and it would be annexable, never asked
      rivals: [{ name: "N", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 80_000 }],
    });
    const n = h.rival("N");
    n.updateRelation(h.me, relation);
    h.step(h.nextRuleTick(300));
    return { h, n };
  }

  test("off: a Hostile nation is asked anyway", async () => {
    const { h, n } = await request(false, -80);
    expect(n.relation(h.me)).toBe(Relation.Hostile);
    expect(h.me.outgoingAllianceRequests().map((r) => r.recipient())).toContain(n);
  });

  test("on: a Hostile nation would refuse, so it is not asked; a Neutral one is", async () => {
    const hostile = await request(true, -80);
    expect(hostile.h.me.outgoingAllianceRequests()).toHaveLength(0);
    expect(hostile.h.log.some((l) => /no alliance request to N: its rules would refuse \(relation Hostile, 0 alliances\)/.test(l))).toBe(true);
    expect(hostile.h.bot.fired.get("relationAware")).toBeGreaterThan(0);
    const neutral = await request(true, 0);
    expect(neutral.h.me.outgoingAllianceRequests().map((r) => r.recipient())).toContain(neutral.n);
  });

  test("on: a threat is asked whatever the relation (Medium: 2.5× its troops)", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, relationAware: true, fightNotBeforeTick: 1e9, fightMaxShare: 0.01 },
      rivals: [{ name: "N", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 60_000 }],
    });
    const n = h.rival("N");
    n.updateRelation(h.me, -80);
    // pinned: > 2.5 × 60k (a nation on this cap regrows past that inside 300 ticks), with fightMaxShare 0.01 not prey
    for (let i = h.nextRuleTick(300); i > 0; i--) { h.me.setTroops(200_000); n.setTroops(60_000); h.step(1); }
    expect(h.me.outgoingAllianceRequests().map((r) => r.recipient())).toContain(n);
  });
});

describe("relationAware: prey and the war scorer prefer the nation that is still on good terms", () => {
  async function twins(relationAware: boolean) {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, relationAware, fightNotBeforeTick: 1e9 },
      rivals: [
        { name: "L", type: PlayerType.Nation, at: [40, 75], tiles: LEFT, troops: 10_500 }, // Friendly to us, a shade stronger
        { name: "R", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: 10_000 }, // the plain weakest
      ],
    });
    const l = h.rival("L"), r = h.rival("R");
    h.step(300 - h.game.ticks()); // isPrey is off before 0:30
    l.updateRelation(h.me, 60); // after the wait: relations decay 0.05 a tick towards 0
    for (const p of [l, r]) p.setTroops(p === l ? 10_500 : 10_000);
    return { h, l, r };
  }

  test("off: the weakest twin is the prey — its request is refused, the other's accepted", async () => {
    const { h, l, r } = await twins(false);
    l.createAllianceRequest(h.me); r.createAllianceRequest(h.me);
    h.step(2);
    expect(h.me.isAlliedWith(l)).toBe(true);
    expect(h.me.isAlliedWith(r)).toBe(false);
  });

  test("on: the Friendly twin within 1.15× of the weakest is the prey instead", async () => {
    const { h, l, r } = await twins(true);
    l.createAllianceRequest(h.me); r.createAllianceRequest(h.me);
    h.step(2);
    expect(h.me.isAlliedWith(l)).toBe(false);
    expect(h.me.isAlliedWith(r)).toBe(true);
    expect(h.bot.fired.get("relationAware")).toBeGreaterThan(0);
  });

  test("on: the scorer goes for the Friendly twin", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, relationAware: true },
      rivals: [
        { name: "L", type: PlayerType.Nation, at: [40, 75], tiles: LEFT, troops: 10_000 },
        { name: "R", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: 10_000 },
      ],
    });
    h.rival("R").updateRelation(h.me, 60);
    h.step(h.nextRuleTick(10));
    expect(h.log.find((l) => l.includes("ATTACK "))).toMatch(/ATTACK R /);
  });
});
