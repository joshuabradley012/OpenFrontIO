// Flag `markTargets` (opportunity #2): when fight() commits to a war target, or a counter starts against a non-bot
// attacker, the bot emits TargetPlayerExecution — the human 'target' button. Every allied nation still Friendly to us
// answers a mark with an attack of its own (AiAttackBehavior.assistAllies) and nukes it (NationNukeBehavior). The mark
// lives 100 ticks, canTarget() allows one per 150, and a running war is re-marked from fight(). No ally: nothing to
// recruit, no mark.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { NATION_RULES } from "../../src/core/execution/playbook/Rivals";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const BELOW: Rect = [30, 58, 70, 90]; // the prey: as large as us, so a pinned 20k army keeps it alive for the re-mark window
const RIGHT: Rect = [71, 25, 95, 57]; // the ally, on our right
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0, fightRatio: 1.2 }; // small waves: the prey survives the re-mark window

async function scenario(markTargets: boolean, ally: boolean) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, markTargets },
    rivals: [
      { name: "R", type: PlayerType.Nation, at: [50, 75], tiles: BELOW, troops: 10_000 }, // prey at 2×
      { name: "A", type: PlayerType.Nation, at: [83, 40], tiles: RIGHT, troops: 50_000 }, // our ally, or just a neighbour
    ],
  });
  const r = h.rival("R"), a = h.rival("A");
  if (ally) { a.createAllianceRequest(h.me)!.accept(); expect(h.me.isAlliedWith(a)).toBe(true); }
  h.step(h.nextRuleTick(10) + 1); // the war rule, then the TargetPlayerExecution's tick
  return { h, r, a };
}

describe("markTargets", () => {
  test("on: the war target is marked for the ally, and re-marked once the cooldown allows", async () => {
    const { h, r } = await scenario(true, true);
    expect(h.log.some((l) => /ATTACK R /.test(l))).toBe(true);
    expect(h.log.some((l) => /MARK R for 1 allies \(war\)/.test(l))).toBe(true);
    expect(h.me.targets()).toContain(r);
    expect(h.bot.fired.get("markTargets")).toBe(1);
    // the mark expires after targetDuration; fight() (every 10 ticks) marks again once targetCooldown has passed.
    // R is pinned at 20k and we at 150k (above the 0.3 × cap war floor): each 1.2× wave dies on it without killing it,
    // and the next war click (or the running wave) is what gets re-marked
    const pin = () => { r.setTroops(20_000); h.me.setTroops(150_000); };
    for (let i = 0; i < NATION_RULES.targetDuration + 5; i++) { pin(); h.step(1); }
    expect(h.me.targets()).toHaveLength(0);
    expect(r.isAlive()).toBe(true);
    let marked = false;
    for (let i = 0; i < NATION_RULES.targetCooldown && !marked; i++) { pin(); h.step(1); marked = h.me.targets().includes(r); }
    expect(marked).toBe(true);
    expect(h.me.outgoingAttacks().some((a) => a.target() === r)).toBe(true); // the running war is what gets re-marked
  });

  test("off: the same war, no mark", async () => {
    const { h } = await scenario(false, true);
    expect(h.log.some((l) => /ATTACK R /.test(l))).toBe(true);
    expect(h.me.targets()).toHaveLength(0);
    expect(h.log.some((l) => l.includes("MARK"))).toBe(false);
  });

  test("on, no ally: nobody to recruit, no mark", async () => {
    const { h } = await scenario(true, false);
    expect(h.log.some((l) => /ATTACK R /.test(l))).toBe(true);
    expect(h.me.targets()).toHaveLength(0);
    expect(h.bot.fired.get("markTargets")).toBeUndefined();
  });

  test("on: a counter-attack against a nation marks it too", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { markTargets: true, fightNotBeforeTick: 1e9 },
      rivals: [
        { name: "R", type: PlayerType.Nation, at: [50, 75], tiles: BELOW, troops: 100_000 },
        { name: "A", type: PlayerType.Nation, at: [83, 40], tiles: RIGHT, troops: 50_000 },
      ],
    });
    const r = h.rival("R"), a = h.rival("A");
    a.createAllianceRequest(h.me)!.accept();
    h.attack(r, h.me, 20_000);
    h.step(h.nextRuleTick(10) + 1);
    expect(h.log.some((l) => l.includes("COUNTER R"))).toBe(true);
    expect(h.log.some((l) => /MARK R for 1 allies \(counter\)/.test(l))).toBe(true);
    expect(h.me.targets()).toContain(r);
  });
});
