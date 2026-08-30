// Flag `campaigns` (review opportunity #6): a war on a normal target goes through a Campaign (Campaign.ts) — prepare
// (the wave escrowed from other spends, a threat post asked for on that border, no alliance with the target) until
// the wave is affordable and timed, then wave → follow-ups → consolidate with a cooldown; an opportunity target
// (collapsed / gap owner / MIRV threat / drained) goes at once, as without the flag; a big incoming attack aborts.
import { describe, expect, test } from "vitest";
import { Campaign, CampaignFacts, POST_WAIT, PREP_CAP } from "../../src/core/execution/playbook/Campaign";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const BELOW: Rect = [30, 58, 70, 90];
const RIGHT: Rect = [71, 25, 95, 57];
// 200k troops: the reserve (60k) and the 0.3 × cap war floor (75k) leave 125k, so a 2 × 20k + 1000 wave is affordable at once
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };

describe("Campaign: the phase machine on plain facts", () => {
  const facts = (tick: number, over: Partial<CampaignFacts> = {}): CampaignFacts => ({
    tick, affordable: true, allyExpiryOK: true, postFacing: false, opportunity: false, targetAlive: true, targetFriendly: false,
    bigIncoming: false, targetAlliedWithOurAlly: false, ratio: 2, attacking: false, ...over,
  });
  const target = { name: () => "R" } as unknown as Player;
  test("prepare waits for the post (at most POST_WAIT), goes at once on an open window, never past the cap", () => {
    const c = new Campaign(target, 41_000, 100);
    expect(c.phase).toBe("prepare");
    expect(c.prepUntil).toBe(100 + PREP_CAP);
    expect(c.ready(facts(110, { affordable: false })).go).toBe(false);
    expect(c.ready(facts(110)).why).toBe("waiting for the post");
    expect(c.ready(facts(110, { postFacing: true })).go).toBe(true);
    expect(c.ready(facts(110, { allyExpiryOK: false, postFacing: true })).go).toBe(false);
    expect(c.ready(facts(110, { opportunity: true })).go).toBe(true);
    expect(c.ready(facts(100 + POST_WAIT)).why).toBe("affordable, no post");
    expect(c.ready(facts(100 + PREP_CAP, { allyExpiryOK: false })).why).toBe("prepare cap");
  });
  test("wave → followup → consolidate, and the abort conditions", () => {
    const c = new Campaign(target, 41_000, 100);
    c.onWave(120, 41_000);
    expect(c.phase).toBe("wave");
    expect(c.advance(facts(130, { attacking: true }), 2)).toBe(true);
    expect(c.phase).toBe("followup");
    expect(c.advance(facts(140, { attacking: true }), 2)).toBe(false);
    expect(c.advance(facts(200), 2)).toBe(false); // the attack is gone: WAVE_GONE_TICKS of grace
    expect(c.advance(facts(260), 2)).toBe(true);
    expect(c.phase).toBe("consolidate");
    expect(c.done).toBe(false);
    c.advance(facts(900), 2);
    expect(c.done).toBe(true);
    expect(c.drain().filter((l) => l.includes("CAMPAIGN"))).toHaveLength(4); // prepare, wave, followup, consolidate
    const d = new Campaign(target, 41_000, 100);
    expect(d.abortReason(facts(110, { ratio: 1.5 }), 2)).toBeNull(); // under 1.6 but not for 300 ticks yet
    expect(d.abortReason(facts(409, { ratio: 1.5 }), 2)).toBeNull();
    expect(d.abortReason(facts(410, { ratio: 1.5 }), 2)).toMatch(/ratio 1\.50 under 1\.60 for 300 ticks/);
    expect(d.abortReason(facts(110, { bigIncoming: true }), 2)).toBe("we are under a large attack");
    expect(d.abortReason(facts(110, { targetAlliedWithOurAlly: true }), 2)).toBe("the target allied with our ally");
    expect(d.abortReason(facts(110, { targetFriendly: true }), 2)).toBe("the target is our ally now");
    expect(d.abortReason(facts(110, { targetAlive: false }), 2)).toBeNull(); // a dead target is a win
    const e = new Campaign(target, 41_000, 100);
    expect(e.advance(facts(500, { attacking: true }), 2)).toBe(false); // an attack on the target that is not the wave changes nothing in prepare
    expect(e.phase).toBe("prepare");
  });
});

describe("campaigns: a normal target", () => {
  async function scenario(campaigns: boolean) {
    // fightNotBeforeTick 900 (and fightAbove over 1: the prey shortcut stays shut): the war opens when the threat-post
    // rule (from 0:15, one city) can answer the campaign's request
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 200_000, bot: { ...WAR, fightNotBeforeTick: 900, fightAbove: 1.01, campaigns },
      rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: BELOW, troops: 20_000 }],
    });
    h.me.addGold(5_000_000n);
    return h;
  }

  test("off: the wave goes on the first war pass", async () => {
    const h = await scenario(false);
    h.step(901 - h.game.ticks());
    expect(h.log.some((l) => /^t900 ATTACK R /.test(l))).toBe(true);
    expect(h.log.some((l) => l.includes("CAMPAIGN"))).toBe(false);
  });

  test("on: prepare, the post on that border, then the wave; phase changes are logged", async () => {
    const h = await scenario(true);
    h.step(901 - h.game.ticks());
    const prep = h.log.find((l) => /^t900 CAMPAIGN prepare R wave \d+k, cap t1800$/.test(l));
    expect(prep).toBeDefined();
    const wave = /wave (\d+)k/.exec(prep!)![1];
    expect(h.log.some((l) => l.includes("ATTACK R"))).toBe(false);
    const attacked = h.until(() => h.log.some((l) => l.includes("ATTACK R")), POST_WAIT + 20);
    expect(attacked).toBe(true);
    const at = Number(/^t(\d+) ATTACK R/.exec(h.log.find((l) => l.includes("ATTACK R"))!)![1]);
    // the post went up on R's border (the campaign's request, before any other rival) and stood before the wave went
    const post = h.log.find((l) => /build Defense Post/.test(l));
    expect(post).toBeDefined();
    expect(Number(/^t(\d+)/.exec(post!)![1])).toBeLessThan(at);
    expect(h.me.units(UnitType.DefensePost).length).toBeGreaterThan(0);
    expect(h.log.some((l) => /CAMPAIGN go R: affordable, post in place/.test(l))).toBe(true);
    expect(h.log.some((l) => new RegExp(`^t${at} CAMPAIGN wave R ${wave}k after ${at - 900} ticks of prepare$`).test(l))).toBe(true);
    expect(at).toBeGreaterThan(900);
    expect(at).toBeLessThanOrEqual(900 + POST_WAIT);
    expect(h.bot.fired.get("campaigns")).toBeGreaterThan(0);
    // the wave is in: followup
    h.step(20);
    expect(h.log.some((l) => /CAMPAIGN followup R: the wave is in/.test(l))).toBe(true);
  });

  test("an opportunity target (drained) skips prepare", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 200_000, bot: { ...WAR, campaigns: true, drainedNations: true },
      rivals: [{ name: "R", type: PlayerType.Nation, at: [85, 50], tiles: [71, 0, 99, 99], troops: 30_000 }],
    });
    h.step(h.nextRuleTick(10));
    expect(h.log.some((l) => /^t10 ATTACK R .* drained$/.test(l))).toBe(true);
    expect(h.log.some((l) => l.includes("CAMPAIGN"))).toBe(false);
  });

  test("abort on a big incoming attack", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 200_000, bot: { ...WAR, campaigns: true },
      rivals: [
        { name: "R", type: PlayerType.Nation, at: [50, 75], tiles: BELOW, troops: 20_000 },
        { name: "A", type: PlayerType.Nation, at: [83, 40], tiles: RIGHT, troops: 150_000 },
      ],
    });
    h.step(h.nextRuleTick(10));
    expect(h.log.some((l) => /^t10 CAMPAIGN prepare R /.test(l))).toBe(true);
    h.attack(h.rival("A"), h.me, 50_000); // a quarter of our army
    h.step(h.nextRuleTick(10));
    expect(h.log.some((l) => /^t20 CAMPAIGN abort R \(we are under a large attack\); cooldown until t320$/.test(l))).toBe(true);
    expect(h.log.some((l) => l.includes("ATTACK R"))).toBe(false);
    // the counter still answers the attack, and no new campaign opens during the cooldown
    expect(h.log.some((l) => /COUNTER A/.test(l))).toBe(true);
    h.step(100);
    expect(h.log.filter((l) => l.includes("CAMPAIGN prepare"))).toHaveLength(1);
    expect(h.bot.fired.get("campaigns")).toBeGreaterThan(0);
  });
});
