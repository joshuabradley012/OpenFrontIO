// The 2026-08-30 review fixes (/code-review of src/core/execution/playbook): one test per behaviour change.
//   1. maybeMIRV's finish path never targets an ally (`threats` lists silo owners off our team, allies included).
//   2. A cancelled counter wave leaves `counters`; a later real war on that player is not recalled as a counter.
//   3. warPick keeps the running war's target when the early prey filter leaves it out for a pass.
//   4. readSlow's denial line is MirvRisk's (0.40 on Impossible, the engine's table), not a hand copy (0.5).
//   5. A lapsed ally stays the planned target for PLANNED_TARGET_TTL ticks with no war on it, not for life.
//   6. manageEmbargoes leaves the engine's embargo on a player still attacking us.
//   7. The renewal gift clears DonateTroopExecution's random minimum on every difficulty (giftDivisor).
//   8. Estimate.posted ignores a defence post under construction, as attackLogic does.
//   9. bombSearch refuses a bomb whose blast would touch a third party (the engine's −100 relation rule).
//  10. The timed rules read PlaybookParams.clockTicks; 0 = open-ended (onTheClock, horizonForPhase).
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { horizonForPhase } from "../../src/core/execution/playbook/BuildSearch";
import { Diplomacy, giftDivisor } from "../../src/core/execution/playbook/Diplomacy";
import { estimateAttack } from "../../src/core/execution/playbook/Estimate";
import { Military } from "../../src/core/execution/playbook/Military";
import { DEFAULT_PLAYBOOK, PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { onTheClock } from "../../src/core/execution/playbook/Situation";
import { Difficulty, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PlaybookHarness, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, boatAtTick: 1e9, fightNotBeforeTick: 1e9, boatsNearest: false, boatsWaterPath: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, utility: false, nationAware: false, allianceEvery: 300 };
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];
const military = (h: PlaybookHarness) => (h.bot as unknown as { military: Military }).military;
const diplomacy = (h: PlaybookHarness) => (h.bot as unknown as { diplomacy: Diplomacy }).diplomacy;
/** A silo and the live MIRV price: NationMIRVBehavior.considerMIRV's gates, and the bot's `threats` test. */
function arm(h: PlaybookHarness, p: Player, x: number, y: number, gold = 100_000_000n): void {
  p.buildUnit(UnitType.MissileSilo, h.game.ref(x, y), {});
  p.addGold(gold);
}

describe("review fixes 2026-08-30", () => {
  test("1. hold mode: the finish MIRV never goes at an ally that can fire", async () => {
    // 62.5 % of big_plains (Medium denial 65 % − 3 %) with a silo and the price; the only MIRV-capable player is our ally
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 60], tiles: [0, 0, 199, 124], troops: 100_000, bot: { ...QUIET, finishRule: true }, rivals: [{ name: "N", type: PlayerType.Nation, at: [100, 170], tiles: [0, 140, 199, 199], troops: 100_000 }] });
    const n = h.rival("N");
    h.game.addExecution(new AllianceRequestExecution(n, h.me.id()));
    h.step(2);
    expect(h.me.isFriendly(n)).toBe(true);
    arm(h, n, 100, 170);
    arm(h, h.me, 100, 60);
    h.step(310); // three "mirv" passes (every 100) inside hold mode
    expect(h.log.some((l) => /FINISH mode \w+ → hold: share 6\d %, 1 MIRV-capable rivals \(N\)/.test(l))).toBe(true);
    expect(h.log.some((l) => / MIRV N /.test(l))).toBe(false);
    expect(h.me.units(UnitType.MIRV).length).toBe(0);
    expect(h.me.isFriendly(n)).toBe(true);
    expect(h.bot.bombs).toBe(0);
  });

  test("2. a counter cancelled troop-for-troop leaves `counters` once its wave is gone", async () => {
    const h = await playbookSetup({ spawn: [50, 40], tiles: [30, 25, 70, 57], troops: 100_000, bot: QUIET, rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: [30, 58, 70, 90], troops: 100_000 }] });
    const r = h.rival("R");
    h.attack(r, h.me, 60_000); // the counter is capped at half of home (50k) and cancels entirely against it
    h.step(h.nextRuleTick(10) + 1);
    const counters = (military(h) as unknown as { counters: Set<Player> }).counters;
    expect(h.log.some((l) => /COUNTER R/.test(l))).toBe(true);
    expect(counters.has(r)).toBe(true);
    expect(h.me.outgoingAttacks().some((a) => a.target() === r)).toBe(false); // cancelled, nothing of ours is out
    h.step(40); // past the 20-tick grace and the next retreats pass
    expect(counters.has(r)).toBe(false);
  });

  test("3. the running war's target survives a pass on which the early prey filter leaves it out", async () => {
    // at cap before fightNotBeforeTick a war opens on X (bigger than us in tiles, small army); the wave takes us
    // under 95 % of cap, the next pass is 'early' and filters X out — the target used to be forgotten there
    const ME: Rect = [0, 0, 199, 59], X: Rect = [0, 60, 199, 124];
    const h = await playbookSetup({ map: "big_plains", spawn: centre(ME), tiles: ME, troops: 1, bot: { ...QUIET, fightMinCities: 0 }, rivals: [{ name: "X", type: PlayerType.Human, at: centre(X), tiles: X, troops: 50_000 }] });
    const x = h.rival("X");
    h.me.setTroops(h.game.config().maxTroops(h.me));
    expect(h.until(() => h.log.some((l) => / ATTACK X /.test(l)), 40)).toBe(true);
    expect(military(h).currentTarget).toBe(x);
    h.step(25); // two more war passes with the wave out and troops under 95 % of cap
    expect(h.me.troops()).toBeLessThan(h.game.config().maxTroops(h.me) * 0.95);
    expect(h.me.outgoingAttacks().some((a) => a.target() === x)).toBe(true);
    expect(military(h).currentTarget).toBe(x);
  });

  test("4. Impossible: hold mode at 40 % − 3 % of the land (the engine's denial line), not at 47 %", async () => {
    const fixture = (difficulty: Difficulty) => playbookSetup({ map: "big_plains", spawn: [100, 40], tiles: [0, 0, 199, 79], troops: 100_000, bot: { ...QUIET, finishRule: true }, config: { difficulty }, rivals: [{ name: "R", type: PlayerType.Nation, at: [100, 170], tiles: [0, 140, 199, 199], troops: 100_000 }] });
    const imp = await fixture(Difficulty.Impossible);
    arm(imp, imp.rival("R"), 100, 170);
    imp.step(12);
    expect(imp.log.some((l) => /FINISH mode grow → hold: share 40 %, 1 MIRV-capable rivals \(R\)/.test(l))).toBe(true);
    const med = await fixture(Difficulty.Medium);
    arm(med, med.rival("R"), 100, 170);
    med.step(12);
    expect(med.log.some((l) => /FINISH mode/.test(l))).toBe(false); // 40 % is well under Medium's 65 %
  });

  test("5. a lapsed ally with no war opened on it stops being the planned target after 3 minutes", async () => {
    // hold mode (62.5 % of the land, a MIRV-capable nation far away) keeps every war off the pocket ally A once its
    // alliance lapses as prey; the mark used to last as long as A lived
    const ME: Rect = [0, 0, 199, 124], A: Rect = [190, 125, 199, 134], T: Rect = [0, 180, 199, 199];
    const h = await playbookSetup({ map: "big_plains", spawn: [100, 60], tiles: ME, troops: 1, bot: { ...QUIET, finishRule: true }, config: { customAllianceDuration: 1 }, rivals: [{ name: "A", type: PlayerType.Human, at: centre(A), tiles: A, troops: 5_000 }, { name: "T", type: PlayerType.Nation, at: centre(T), tiles: T, troops: 100_000 }] });
    const a = h.rival("A");
    h.me.setTroops(h.game.config().maxTroops(h.me));
    arm(h, h.rival("T"), 100, 190);
    h.game.addExecution(new AllianceRequestExecution(a, h.me.id()));
    h.step(2);
    const al = h.me.allianceWith(a);
    expect(al).not.toBeNull();
    h.step(al!.expiresAt() + 20 - h.game.ticks());
    expect(h.log.some((l) => /let alliance with A lapse/.test(l))).toBe(true);
    expect(h.me.isFriendly(a)).toBe(false);
    expect(diplomacy(h).plannedTarget).toBe(a);
    h.step(1200);
    expect(h.me.outgoingAttacks().length).toBe(0); // hold: no war on A
    expect(diplomacy(h).plannedTarget).toBe(a); // still inside the window
    h.step(700);
    expect(h.log.some((l) => /planned target A dropped: no war on it 3 min after the lapse/.test(l))).toBe(true);
    expect(diplomacy(h).plannedTarget).toBeNull();
    expect(a.isAlive()).toBe(true);
  });

  test("6. the engine's embargo on a player attacking us is not lifted after tick 1200", async () => {
    const ME: Rect = [0, 0, 199, 99], R: Rect = [0, 100, 199, 199];
    const h = await playbookSetup({ map: "big_plains", spawn: centre(ME), tiles: ME, troops: 400_000, bot: QUIET, rivals: [{ name: "R", type: PlayerType.Human, at: centre(R), tiles: R, troops: 400_000 }] });
    const r = h.rival("R");
    h.me.buildUnit(UnitType.DefensePost, h.game.ref(100, 95), {}); // a post facing R: a 14 % wave is under the counter rule's 15 % bar, so nothing of ours cancels it
    h.step(1470);
    h.attack(r, h.me, 56_000);
    h.step(5);
    expect(h.me.hasEmbargoAgainst(r)).toBe(true); // AttackExecution's temporary embargo on the attacker
    h.step(1500 + 5 - h.game.ticks()); // through the alliances pass at 1500 (embargoedAt 0 + 1200 < 1500)
    expect(h.me.incomingAttacks().some((x) => x.attacker() === r)).toBe(true);
    expect(h.me.hasEmbargoAgainst(r)).toBe(true);
  });

  test("7. the renewal gift is the upper bound of DonateTroopExecution's random minimum per difficulty", () => {
    expect(giftDivisor(Difficulty.Easy)).toBe(11);
    expect(giftDivisor(Difficulty.Medium)).toBe(9);
    expect(giftDivisor(Difficulty.Hard)).toBe(7);
    expect(giftDivisor(Difficulty.Impossible)).toBe(5); // the flat / 7 fell under Impossible's [max/7, max/5) roll
  });

  test("8. the estimator ignores a defence post under construction, as attackLogic does", async () => {
    const ME: Rect = [0, 0, 199, 99], R: Rect = [0, 100, 199, 199];
    const h = await playbookSetup({ map: "big_plains", spawn: centre(ME), tiles: ME, troops: 200_000, bot: QUIET, rivals: [{ name: "R", type: PlayerType.Human, at: centre(R), tiles: R, troops: 100_000 }] });
    const r = h.rival("R");
    const est = () => estimateAttack(h.game, h.me, r, 150_000, { horizonTicks: 600 });
    const none = est();
    const post = r.buildUnit(UnitType.DefensePost, h.game.ref(100, 110), {});
    post.setUnderConstruction(true);
    const building = est();
    post.setUnderConstruction(false);
    const active = est();
    expect(building).toEqual(none);
    expect(active.tilesTaken).toBeLessThan(none.tilesTaken);
  });

  test("9. no bomb whose blast would touch a third party (the engine docks it −100 relation)", async () => {
    // bombBudget's fixture: our silo in the north, the war target R in the middle with an atom pair at (100,155) /
    // (108,163); N, unallied and not at war with us, holds the east side 21 tiles from the pair — inside the atom's
    // outer radius of 30
    const ME: Rect = [10, 5, 190, 40], R: Rect = [80, 41, 120, 170], N: Rect = [121, 41, 190, 199];
    const fixture = async (third: boolean) => {
      const rivals = [{ name: "R", type: PlayerType.Human, at: [100, 145] as [number, number], tiles: R, troops: 200_000 }];
      if (third) rivals.push({ name: "N", type: PlayerType.Human, at: centre(N), tiles: N, troops: 50_000 });
      const h = await playbookSetup({ map: "big_plains", realNukes: true, spawn: [100, 25], tiles: ME, troops: 5_000, bot: { ...QUIET, capFullShare: 2, bombBudget: true }, rivals });
      const r = h.rival("R");
      for (const [x, y] of [[100, 155], [108, 163]]) r.buildUnit(UnitType.City, h.game.ref(x, y), {});
      h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 25), {});
      (military(h) as unknown as { currentTarget_: Player | null }).currentTarget_ = r;
      h.step(h.nextRuleTick(10) - 1);
      h.me.addGold(900_000n);
      h.step(41);
      return h;
    };
    const alone = await fixture(false);
    expect(alone.log.some((l) => /BOMB Atom Bomb at 10[08],1[56][35]/.test(l))).toBe(true);
    const withN = await fixture(true);
    expect(withN.log.some((l) => /BOMB /.test(l))).toBe(false);
    expect(withN.bot.bombs).toBe(0);
  });

  test("10. the timed rules read clockTicks; 0 is open-ended", () => {
    const p: PlaybookParams = { ...DEFAULT_PLAYBOOK };
    expect(p.clockTicks).toBe(18000);
    expect(onTheClock(p, 14_999)).toBe(false);
    expect(onTheClock(p, 15_000)).toBe(true);
    expect(onTheClock({ ...p, clockTicks: 0 }, 100_000)).toBe(false);
    expect(horizonForPhase("endgame", 14_500)).toBe(1000);
    expect(horizonForPhase("endgame", 14_500, 6000, 18000)).toBe(1000);
    expect(horizonForPhase("endgame", 100_000, 6000, 0)).toBe(4000); // no clock: planned like a war
    expect(horizonForPhase("endgame", 4000, 6000, 0)).toBe(4000);
  });
});
