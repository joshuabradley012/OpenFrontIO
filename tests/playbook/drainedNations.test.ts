// Flag `drainedNations` (opportunity #2): a nation under its reserve ratio (troops < 0.3 × max, AiAttackBehavior
// attackBestTarget line 244) cannot attack anyone until it regrows; RivalView.drainedUntil estimates when it is back at
// its trigger ratio. fight() takes such a nation at 1.5× — the affordable gate and the scorer — and the counter is
// never sized below the wave it cancels (a Medium nation's wave is its whole surplus; cancelled, it is drained).
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { NATION_RULES } from "../../src/core/execution/playbook/Rivals";
import { Situation } from "../../src/core/execution/playbook/Situation";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const RV: Rect = [30, 58, 70, 90]; // as large as ours: its cap is well above 100k, so 30k is under its reserve ratio
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };
const sitOf = (h: { bot: unknown }) => (h.bot as { sit: Situation }).sit;

describe("drainedNations: the war", () => {
  async function scenario(drainedNations: boolean) {
    // 120k of ours: spendable 84k × fightMaxShare 0.6 = 50.4k — 1.5 × 30k + 1000 fits, 2 × 30k + 1000 does not,
    // and 120k is under fightAbove × cap, so only the relaxed gate opens the war
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 120_000, bot: { ...WAR, drainedNations },
      rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 30_000 }],
    });
    const r = h.rival("R");
    expect(30_000).toBeLessThan(h.game.config().maxTroops(r) * NATION_RULES.reserveRatio[0]);
    expect(120_000).toBeLessThan(h.game.config().maxTroops(h.me) * 0.7);
    h.step(h.nextRuleTick(10));
    return { h, r };
  }

  test("off: 2× is not affordable, no war", async () => {
    const { h, r } = await scenario(false);
    expect(sitOf(h).rival.get(r)!.drainedUntil).toBeGreaterThan(sitOf(h).tick); // the view is filled either way
    expect(h.log.some((l) => l.includes("ATTACK R"))).toBe(false);
  });

  test("on: the drained nation is taken at 1.5×, and the estimate says when it is back", async () => {
    const { h, r } = await scenario(true);
    const v = sitOf(h).rival.get(r)!;
    expect(v.drainedUntil).toBeGreaterThan(sitOf(h).tick);
    expect(v.drainedUntil - sitOf(h).tick).toBeLessThanOrEqual(3000);
    const line = h.log.find((l) => l.includes("ATTACK R"));
    expect(line).toMatch(/ATTACK R \d+t\/3\dk ← \d+k \(1\.5\d×\) drained$/); // 30k plus a few ticks of regen
    expect(h.bot.fired.get("drainedNations")).toBeGreaterThan(0);
  });

  test("a nation above its reserve ratio is not drained", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 120_000, bot: { ...WAR, drainedNations: true },
      rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 30_000 }],
    });
    const r = h.rival("R");
    r.setTroops(Math.ceil(h.game.config().maxTroops(r) * 0.5));
    h.step(2);
    expect(sitOf(h).rival.get(r)!.drainedUntil).toBe(-1);
  });
});

describe("drainedNations: the counter", () => {
  async function counter(drainedNations: boolean) {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { drainedNations, fightNotBeforeTick: 1e9 },
      rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 200_000 }],
    });
    const r = h.rival("R");
    h.attack(r, h.me, 60_000); // more than half our home: the plain counter is capped at 50k and leaves 10k standing
    h.step(h.nextRuleTick(10) - 1);
    const inc0 = h.me.incomingAttacks().find((a) => a.attacker() === r)!.troops();
    h.step(2);
    return { h, r, inc0 };
  }

  test("off: capped at half of home, the wave survives the counter", async () => {
    const { h, r, inc0 } = await counter(false);
    expect(inc0).toBeGreaterThan(50_000);
    expect(h.log.find((l) => l.includes("COUNTER R"))).toMatch(/with 50k$/);
    expect(h.me.incomingAttacks().some((a) => a.attacker() === r)).toBe(true);
  });

  test("on: never below what cancels it — the wave is gone", async () => {
    const { h, r, inc0 } = await counter(true);
    expect(h.log.find((l) => l.includes("COUNTER R"))).toMatch(new RegExp(`with ${Math.round((inc0 + 1) / 1000)}k$`));
    expect(h.me.incomingAttacks().some((a) => a.attacker() === r)).toBe(false);
    expect(h.bot.fired.get("drainedNations")).toBeGreaterThan(0);
  });
});
