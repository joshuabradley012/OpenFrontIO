// Flag `strictOneWar`: counters occupy the second war slot — one war plus counters, but no second war while a
// counter runs. Off = the old count, which skipped counters: a counter on the current target read as "no war", so
// fight() could open another war beside it.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const LEFT: Rect = [29, 58, 49, 90];
const RIGHT: Rect = [50, 58, 70, 90];
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };

async function counterOnCurrentTarget(strictOneWar: boolean) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 300_000, bot: { ...WAR, strictOneWar },
    rivals: [
      { name: "A", type: PlayerType.Nation, at: [40, 75], tiles: LEFT, troops: 20_000 }, // the current target, held by a counter
      { name: "C", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: 200_000 }, // not affordable yet
    ],
  });
  const a = h.rival("A"), c = h.rival("C");
  const mil = (h.bot as unknown as { military: Military }).military as unknown as { currentTarget_: Player | null; counters: Set<Player> };
  mil.currentTarget_ = a;
  mil.counters.add(a);
  h.attack(h.me, a, 20_000); // the counter wave, as counterAttack() leaves it
  h.step(h.nextRuleTick(10));
  expect(h.me.outgoingAttacks().some((x) => x.target() === a)).toBe(true);
  expect(h.log.some((l) => l.includes("ATTACK"))).toBe(false);
  c.setTroops(10_000); // now a 2× war on C is affordable
  h.step(10);
  return h;
}

describe("strictOneWar", () => {
  test("off: a second war opens beside the counter on the current target", async () => {
    const h = await counterOnCurrentTarget(false);
    expect(h.log.some((l) => /ATTACK C /.test(l))).toBe(true);
    expect(h.bot.fired.get("strictOneWar")).toBeUndefined();
  });

  test("on: no second war while the counter runs, and the flag fires", async () => {
    const h = await counterOnCurrentTarget(true);
    expect(h.log.some((l) => /ATTACK C /.test(l))).toBe(false);
    expect(h.bot.fired.get("strictOneWar")).toBeGreaterThanOrEqual(1);
  });
});
