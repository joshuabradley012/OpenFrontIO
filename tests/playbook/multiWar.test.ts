// Flag `multiWar`: (a) a second and third war beside the running ones when the next wave fits above the reserve and the
// total committed stays under fightMaxShare of the army — a running counter occupies a slot;
// (b) tribes: concurrency 2 below 60 % of cap (3 above) and the pass keeps clicking while the next click is affordable.
// Off = one war at a time (opened by one warPick per pass) and one tribe click per pass below fightAbove.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [0, 25, 99, 57];
const COLS: Rect[] = [[0, 58, 24, 90], [25, 58, 49, 90], [50, 58, 74, 90], [75, 58, 99, 90]]; // four columns under us
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };

const attacks = (log: string[]) => log.filter((l) => /^t\d+ ATTACK /.test(l));

async function twoWeak(multiWar: boolean) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 300_000, bot: { ...WAR, multiWar },
    rivals: [
      { name: "A", type: PlayerType.Nation, at: [37, 75], tiles: COLS[1], troops: 20_000 },
      { name: "B", type: PlayerType.Nation, at: [62, 75], tiles: COLS[2], troops: 20_000 },
    ],
  });
  h.step(h.nextRuleTick(10) + 1); // the wars rule at tick 10, the waves initialise at 11
  return h;
}

describe("multiWar: wars", () => {
  test("off: two affordable neighbours, one war per pass", async () => {
    const h = await twoWeak(false);
    expect(attacks(h.log)).toHaveLength(1);
    expect(h.me.outgoingAttacks().filter((a) => a.target().isPlayer())).toHaveLength(1);
    expect(h.bot.fired.get("multiWar")).toBeUndefined();
  });

  test("on: both wars open in the same pass, the total committed under fightMaxShare of the army", async () => {
    const h = await twoWeak(true);
    const lines = attacks(h.log);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith("t10 ATTACK "))).toBe(true);
    expect(new Set(lines.map((l) => / ATTACK (\w) /.exec(l)![1]))).toEqual(new Set(["A", "B"]));
    const sent = lines.map((l) => Number(/← (\d+)k/.exec(l)![1]) * 1000);
    expect(sent.every((s) => s >= 1000)).toBe(true);
    expect(sent[0] + sent[1]).toBeLessThanOrEqual(300_000 * 0.6);
    expect(h.log.some((l) => l.includes("WAR #2 beside the running ones"))).toBe(true);
    expect(h.me.outgoingAttacks().filter((a) => a.target().isPlayer())).toHaveLength(2);
    expect(h.bot.fired.get("multiWar")).toBe(1);
  });

  test("on: three weak neighbours fill the three slots in one pass", async () => {
    const h = await fourWeak(false);
    expect(attacks(h.log)).toHaveLength(3);
    expect(h.bot.fired.get("multiWar")).toBe(2);
  });

  test("on: a running counter occupies a slot — two wars beside it, not three", async () => {
    const h = await fourWeak(true);
    const lines = attacks(h.log);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => !/ ATTACK A /.test(l))).toBe(true);
    expect(h.me.outgoingAttacks().filter((a) => a.target().isPlayer())).toHaveLength(3); // the counter and the two wars
    expect(h.bot.fired.get("multiWar")).toBe(1);
  });

});

/** A, B, C, D under us, all affordable; with `counter` a counter wave on A (the current target, so manageRetreats keeps it)
 *  occupies a slot before the wars rule runs. */
async function fourWeak(counter: boolean) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 300_000, bot: { ...WAR, multiWar: true },
    rivals: [
      { name: "A", type: PlayerType.Nation, at: [12, 75], tiles: COLS[0], troops: 20_000 },
      { name: "B", type: PlayerType.Nation, at: [37, 75], tiles: COLS[1], troops: 20_000 },
      { name: "C", type: PlayerType.Nation, at: [62, 75], tiles: COLS[2], troops: 20_000 },
      { name: "D", type: PlayerType.Nation, at: [87, 75], tiles: COLS[3], troops: 20_000 },
    ],
  });
  if (counter) {
    const a = h.rival("A");
    const mil = (h.bot as unknown as { military: Military }).military as unknown as { currentTarget_: Player | null; counters: Set<Player> };
    mil.currentTarget_ = a;
    mil.counters.add(a);
    h.attack(h.me, a, 15_000); // the counter wave, as counterAttack() leaves it
  }
  h.step(h.nextRuleTick(10) + 1);
  return h;
}

async function threeTribes(multiWar: boolean) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 150_000, bot: { ...WAR, multiWar }, // 150k is under 60 % of cap and under fightAbove
    rivals: [
      { name: "X", type: PlayerType.Bot, at: [37, 75], tiles: COLS[1], troops: 10_000 },
      { name: "Y", type: PlayerType.Bot, at: [62, 75], tiles: COLS[2], troops: 10_000 },
      { name: "Z", type: PlayerType.Bot, at: [87, 75], tiles: COLS[3], troops: 10_000 },
    ],
  });
  expect(h.me.troops()).toBeLessThan(h.game.config().maxTroops(h.me) * 0.6);
  h.step(h.nextRuleTick(10) + 1);
  return h;
}

describe("multiWar: tribes", () => {
  test("off: one first click per pass below fightAbove", async () => {
    const h = await threeTribes(false);
    expect(h.log.filter((l) => /^t10 bot /.test(l))).toHaveLength(1);
    expect(h.bot.fired.get("multiWar")).toBeUndefined();
  });

  test("on: two first clicks in one pass (concurrency 2 below 60 % of cap), the third waits", async () => {
    const h = await threeTribes(true);
    expect(h.log.filter((l) => /^t10 bot /.test(l))).toHaveLength(2);
    expect(h.me.outgoingAttacks().filter((a) => a.target().isPlayer())).toHaveLength(2);
    expect(h.bot.fired.get("multiWar")).toBe(1);
  });
});
