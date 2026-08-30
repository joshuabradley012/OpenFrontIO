// Flag `retaliateAware` (opportunity #2, with the brief's `secondAttacker` folded in): a nation's `retaliate` and its
// nuke targeting answer only the largest incoming attacker (AiAttackBehavior.findIncomingAttackPlayer). A target already
// under a bigger wave than ours would be — or marked by one of our allies, whose other allies are about to hit it — is
// preferred (+2) and taken at 1.2× instead of fightRatio, the wave kept below the bigger one. RivalView carries the
// largest attacker's identity and wave.
import { describe, expect, test } from "vitest";
import { TargetPlayerExecution } from "../../src/core/execution/TargetPlayerExecution";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Situation } from "../../src/core/execution/playbook/Situation";
import { PlayerType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const RV: Rect = [30, 58, 70, 75];
const H: Rect = [30, 76, 70, 95]; // borders R, not us
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };
const sitOf = (h: PlaybookHarness) => (h.bot as unknown as { sit: Situation }).sit;

/** Our army at 75 % of cap (past fightAbove, under the at-cap 1.2× rule): maxSend ≈ 113k. R at 70k (it bleeds a little
 *  under H's wave) is a ≈1.7× target — short of fightRatio, above 1.2. */
async function scenario(retaliateAware: boolean, ally = false) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 10_000, bot: { ...WAR, retaliateAware },
    rivals: [
      { name: "R", type: PlayerType.Nation, at: [50, 66], tiles: RV, troops: 70_000 },
      { name: "H", type: PlayerType.Human, at: [50, 85], tiles: H, troops: 200_000 },
    ],
  });
  const cap = h.game.config().maxTroops(h.me);
  h.me.setTroops(Math.floor(cap * 0.75));
  const r = h.rival("R"), hu = h.rival("H");
  if (ally) { hu.createAllianceRequest(h.me)!.accept(); expect(h.me.isAlliedWith(hu)).toBe(true); }
  return { h, r, hu };
}

describe("retaliateAware: the smaller attacker", () => {
  test("off: 1.7× is short of fightRatio, no war even though H is hitting R with 100k", async () => {
    const { h, r, hu } = await scenario(false);
    h.attack(hu, r, 100_000);
    h.step(h.nextRuleTick(10));
    const v = sitOf(h).rival.get(r)!;
    expect(v.largestAttacker).toBe(hu);
    expect(v.largestAttack).toBeGreaterThan(80_000);
    expect(h.log.some((l) => l.includes("ATTACK R"))).toBe(false);
  });

  test("on: R is taken at 1.2× with a wave under H's, so R's retaliation stays on H", async () => {
    const { h, r, hu } = await scenario(true);
    h.attack(hu, r, 100_000);
    h.step(h.nextRuleTick(10));
    const line = h.log.find((l) => l.includes("ATTACK R"));
    expect(line).toMatch(/ATTACK R \d+t\/6\dk ← \d+k \(1\.2\d×\) as the smaller attacker$/);
    expect(h.me.outgoingAttacks().find((a) => a.target() === r)!.troops()).toBeLessThan(sitOf(h).rival.get(r)!.largestAttack);
    expect(sitOf(h).rival.get(r)!.largestAttacker).toBe(hu);
    expect(h.bot.fired.get("retaliateAware")).toBeGreaterThan(0);
  });

  test("on: a wave that would become the largest gets the normal gate", async () => {
    const { h, r, hu } = await scenario(true);
    h.attack(hu, r, 30_000); // 1.2 × 70k + 1000 = 85k would top it
    h.step(h.nextRuleTick(10));
    expect(sitOf(h).rival.get(r)!.largestAttacker).toBe(hu);
    expect(h.log.some((l) => l.includes("ATTACK R"))).toBe(false);
  });

  test("on: a target marked by our ally is joined at 1.2× (secondAttacker)", async () => {
    const { h, r, hu } = await scenario(true, true);
    h.game.addExecution(new TargetPlayerExecution(hu, r.id()));
    h.step(2); // init, then the tick that marks
    expect(hu.targets()).toContain(r);
    h.step(h.nextRuleTick(10));
    expect(h.log.find((l) => l.includes("ATTACK R"))).toMatch(/as the smaller attacker$/);
  });
});
