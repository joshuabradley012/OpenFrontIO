// Flag `contestLeader` (docs/PlaybookBotPlan.md "Contest the leader"; loss cluster 2 of "Why we lose full games"):
// while we are rank ≤ contestRank by tiles among non-bots and the leader — not us, not a friend — holds more than
// contestLeadRatio × our tiles and is still growing (two tile samples 300 ticks apart), the boats seaExpansion /
// huntBotsByBoat already send are re-aimed from "weak X" / tribe targets at the leader's coastline, maybeBomb /
// maybeMIRV treat the leader as a priority target, and the war scorer adds +4 on it. Targets are redirected, sizes
// and gates are not touched.
//
// Sea geometry (the world test map, as boats.test.ts): we hold Africa's Red Sea bank; the weak player sits across
// the strait on Arabia's coast (~32 tiles by water) and the leader holds the Arabian interior north of it, its Red
// Sea shore across water from ours. Bomb geometry (big_plains, 200 × 200): us in the north with a silo, the weak
// rival W (a two-city atom cluster, value 6) in the middle, the leader L (a three-city cluster, value 9) in the
// south — the value search picks L only when the flag puts it on the list.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { conquerRect, playbookSetup, PlaybookHarness, Rect, RivalSpec } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, boatsWaterPath: false, takeFallout: false }; // the 2026-08-30 defaults are on; the fixtures set each flag explicitly

// ---------------------------------------------------------------- sea: the boat leaves the weakling for the leader
const ME_SEA: Rect = [1120, 396, 1150, 445]; // Africa's Red Sea bank, coast at y 396–407
const WEAK_SEA: RivalSpec = { name: "Weak", type: PlayerType.Human, at: [1185, 425], tiles: [1173, 415, 1205, 434], troops: 4000 }; // across the strait: seaExpansion's "weak X" (< 25 % of our troops, no posts)
const LEAD_SEA: Rect = [1160, 300, 1255, 410]; // the Arabian interior and Red Sea coast north of the weakling
const LEAD_SEA_MORE: Rect = [1160, 300, 1270, 410]; // the growth that makes the trend
async function seaFixture(flags: Partial<PlaybookParams>) {
  const h = await playbookSetup({
    map: "world", spawn: [1135, 420], tiles: ME_SEA, troops: 200_000,
    bot: { ...QUIET, ...flags },
    rivals: [WEAK_SEA, { name: "Lead", type: PlayerType.Human, at: [1200, 360], tiles: LEAD_SEA, troops: 500_000 }],
  });
  const lead = h.rival("Lead"), weak = h.rival("Weak");
  expect(lead.numTilesOwned()).toBeGreaterThan(h.me.numTilesOwned() * 1.5); // the runaway of the fixture
  return { h, lead, weak };
}
/** Run to `tick`, pinning the weak player's troops each tick — the engine regenerates a 500-tile player to ~70k
 *  by t600, which would carry it past seaExpansion's "weak X" line (< 25 % of ours) and out of the fixture. */
function runTo(h: PlaybookHarness, tick: number, weak: Player) {
  while (h.game.ticks() < tick) { weak.setTroops(4000); h.game.executeNextTick(); }
}
/** Grow the leader at ~t150 so the 300-tick trend sample sees a rise, then run to the tick-600 sea-expansion pass. */
function growAndSail(h: PlaybookHarness, lead: Player, weak: Player) {
  runTo(h, 150, weak);
  const before = lead.numTilesOwned();
  conquerRect(h.game, lead, LEAD_SEA_MORE);
  expect(lead.numTilesOwned()).toBeGreaterThan(before); // the growth the trend sample must see
  runTo(h, 620, weak);
  return h.log.find((l) => l.includes("sea expansion")) ?? null;
}

// ---------------------------------------------------------------- bombs: the atom leaves the weakling's pair for the leader's cluster
const ME_BOMB: Rect = [10, 5, 190, 40];
const WEAK_BOMB: Rect = [60, 41, 140, 130]; // ~7.3k tiles: rank 2
const LEAD_BOMB: Rect = [10, 131, 190, 190]; // grown to LEAD_BOMB_MORE for the trend; > 1.5 × our ~6.5k tiles
const LEAD_BOMB_MORE: Rect = [10, 131, 190, 199];
async function bombFixture(flags: Partial<PlaybookParams>) {
  const h = await playbookSetup({
    map: "big_plains", realNukes: true, spawn: [100, 25], tiles: ME_BOMB, troops: 5_000,
    bot: { ...QUIET, ...flags },
    rivals: [
      { name: "Weak", type: PlayerType.Human, at: [100, 80], tiles: WEAK_BOMB, troops: 50_000 },
      { name: "Lead", type: PlayerType.Human, at: [100, 160], tiles: LEAD_BOMB, troops: 200_000 },
    ],
  });
  const weak = h.rival("Weak"), lead = h.rival("Lead");
  // W's pair (value 6) sits > 32 from our land and > 30 from L's, L's triple (value 9) > 30 from W's — every pick
  // passes clearOfFriends and blastCollateral, so only the enemy list decides who gets the bomb
  for (const [x, y] of [[100, 92], [108, 97]] as const) weak.buildUnit(UnitType.City, h.game.ref(x, y), {});
  for (const [x, y] of [[100, 161], [108, 166], [116, 161]] as const) lead.buildUnit(UnitType.City, h.game.ref(x, y), {});
  h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 25), {});
  (military(h) as unknown as { currentTarget_: Player | null }).currentTarget_ = weak; // the war target: maybeBomb's first enemy either way
  expect(lead.numTilesOwned()).toBeGreaterThan(h.me.numTilesOwned() * 1.5);
  expect(lead.numTilesOwned()).toBeGreaterThan(weak.numTilesOwned());
  // the trend: grow the leader at ~t150, wait out the 300-tick sample, then hand over the bomb gold
  h.until(() => h.game.ticks() >= 150, 200);
  conquerRect(h.game, lead, LEAD_BOMB_MORE);
  h.until(() => h.game.ticks() >= 320, 400);
  h.me.addGold(3_000_000n); // atoms (750k + 250k reserve) affordable through the build passes, hydrogens (5M) not
  h.until(() => h.bot.bombs > 0, 300);
  const line = h.log.find((l) => /BOMB Atom Bomb at \d+,\d+/.test(l));
  expect(line).toBeDefined();
  const [, x, y] = /at (\d+),(\d+)/.exec(line!)!;
  return { h, bombedOwner: h.game.owner(h.game.ref(Number(x), Number(y))), weak, lead };
}
function military(h: PlaybookHarness): Military {
  return (h.bot as unknown as { military: Military }).military;
}

describe("contestLeader", () => {
  test("off: the sea-expansion boat goes at the 'weak X' across the strait even while a runaway leader is growing next to it", async () => {
    const { h, lead, weak } = await seaFixture({});
    const line = growAndSail(h, lead, weak);
    expect(line).toMatch(/sea expansion → weak Weak/);
    expect(h.log.some((l) => l.includes("CONTEST"))).toBe(false);
    expect(h.bot.fired.get("contestLeader")).toBeUndefined();
  });

  test("on: the same boat (the weak candidate's wave) lands on the leader's coastline instead, CONTEST is logged, the flag fires", async () => {
    const { h, lead, weak } = await seaFixture({ contestLeader: true });
    const line = growAndSail(h, lead, weak);
    expect(h.log.find((l) => l.includes("CONTEST leader"))).toMatch(/CONTEST leader Lead share \d+ % \(\d+t vs ours \d+t, we are #2\)/);
    expect(line).toMatch(/sea expansion → CONTEST leader Lead \d+t/);
    expect(h.bot.fired.get("contestLeader")).toBeGreaterThanOrEqual(1);
    // the boat carries the weak candidate's wave (3 × 4000 + 2000), not a leader-sized one: targets move, sizes do not
    const boat = h.log.find((l) => /^t\d+ boat \d+k: sea expansion → CONTEST/.test(l))!;
    expect(Number(/boat (\d+)k/.exec(boat)![1])).toBe(14);
  });

  test("on, but the leader never grows: no trend, no contest — the boat keeps its weak target and nothing fires", async () => {
    const { h, weak } = await seaFixture({ contestLeader: true });
    runTo(h, 620, weak); // no conquerRect: the leader's tiles never move
    const line = h.log.find((l) => l.includes("sea expansion")) ?? null;
    expect(line).toMatch(/sea expansion → weak Weak/);
    expect(h.log.some((l) => l.includes("CONTEST"))).toBe(false);
    expect(h.bot.fired.get("contestLeader")).toBeUndefined();
  });

  test("off: the bomb goes at the war target's pair — the leader's richer cluster is not on the list", async () => {
    const { bombedOwner, weak, h } = await bombFixture({});
    expect(bombedOwner).toBe(weak);
    expect(h.bot.fired.get("contestLeader")).toBeUndefined();
  });

  test("on: the leader joins the list like a threat and its cluster wins the value search; the flag fires on the pick", async () => {
    const { bombedOwner, lead, h } = await bombFixture({ contestLeader: true });
    expect(bombedOwner).toBe(lead);
    expect(h.bot.fired.get("contestLeader")).toBeGreaterThanOrEqual(1);
  });
});
