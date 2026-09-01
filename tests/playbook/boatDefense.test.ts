// Flag `boatDefense` (docs/PlaybookBotPlan.md "Boat defense"): react to enemy amphibious play — an inbound enemy
// transport bound for our coast gets a defense post at the landing zone before it lands, a fresh beachhead gets an
// immediate counter-sized wave, and a transport bound for a tribe in our sphere gets the tribe clicked by us first.
//
// Geometry (the world test map, Bab-el-Mandeb, as boats.test.ts): Africa's Red Sea bank at [1120, 396, 1150, 445]
// with an ocean shore at y 396–407; Arabia across the 4–6-tile strait holds the enemy. The Somali coast south of
// our rect hosts the tribe fixtures.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { TransportShipExecution } from "../../src/core/execution/TransportShipExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { borderOf } from "../../src/core/execution/playbook/Border";
import {
  playbookSetup,
  PlaybookHarness,
  PRE_COMBO,
  Rect,
  RivalSpec,
} from "../util/PlaybookSetup";

// The 2026-08-30/31 default-on flags pinned off so the only new behaviour under test is the flag's own
// (as the other boat fixtures do); PRE_COMBO pins the pre-combo core constants the sizes below assume.
const QUIET: Partial<PlaybookParams> = {
  ...PRE_COMBO,
  expandFree: 0,
  expandContested: 0,
  fightNotBeforeTick: 1e9,
  multiWar: false,
  annexWars: false,
  lapseToAttack: false,
  boatsNearest: false,
  boatsWaterPath: false,
  takeFallout: false,
  finishByBoat: false,
  boatAtTick: 1e9, // no boats of our own: every TransportShip on the map is the enemy's
};
const ME: Rect = [1120, 396, 1150, 445]; // Africa's Red Sea bank, ocean shore at y 396–407
const SEA: RivalSpec = { name: "Sea", type: PlayerType.Human, at: [1190, 424], tiles: [1173, 415, 1205, 434], troops: 60_000 }; // Arabia, across the strait — never our land neighbour

function military(h: PlaybookHarness): Military {
  return (h as unknown as { bot: { military: Military } }).bot.military;
}
/** Our shore tile nearest (x, y) — the enemy's click target on our coast. */
function shoreOf(h: PlaybookHarness, p: Player, x: number, y: number): TileRef {
  const g = h.game;
  let best: TileRef | null = null, bestD = 1e9;
  for (const t of borderOf(p)) {
    if (!g.isOceanShore(t)) continue;
    const d = Math.abs(g.x(t) - x) + Math.abs(g.y(t) - y);
    if (d < bestD) { bestD = d; best = t; }
  }
  expect(best).not.toBeNull();
  return best!;
}
/** Step to just after a tick where the boat-defense rule (every 20) has NOT just run, so an execution added now is
 *  seen by the rule at most 2–4 ticks after the transport unit exists (its eta still close to the launch value). */
function alignForScan(h: PlaybookHarness): void {
  // executions added at tick T init inside the T+1 executeNextTick; the rule runs when ticks % 20 === 0
  while ((h.game.ticks() + 3) % 20 !== 0) h.step(1);
}

describe("boatDefense: incoming transport at our coast", () => {
  async function invade(boatDefense: boolean) {
    const h = await playbookSetup({
      map: "world",
      spawn: [1135, 420],
      tiles: ME,
      troops: 300_000,
      bot: { ...QUIET, boatDefense },
      rivals: [SEA],
      config: { instantBuild: true }, // the post finishes the pass it is bought: the "in time" gate is eta > 20
    });
    h.me.addGold(500_000n); // the 50k post affordable from the first build pass
    const sea = h.rival("Sea");
    const dst = shoreOf(h, h.me, 1148, 400); // our Red Sea bank
    alignForScan(h);
    h.game.addExecution(new TransportShipExecution(sea, dst, 8_000));
    return { h, sea, dst, tiles0: sea.numTilesOwned() };
  }

  test("flag on: BOAT INBOUND logged, the landing zone gets a post before the boat lands, the beachhead is counter-waved", async () => {
    const { h, sea, dst, tiles0 } = await invade(true);
    // seen and logged within one 20-tick pass
    expect(h.until(() => h.log.some((l) => l.includes("BOAT INBOUND Sea")), 60)).toBe(true);
    expect(sea.numTilesOwned()).toBe(tiles0); // still at sea
    // the post goes up before the landing (instantBuild: the buy is the build)
    expect(h.until(() => h.me.units(UnitType.DefensePost).length > 0, 120)).toBe(true);
    expect(sea.numTilesOwned()).toBe(tiles0); // the landing has not happened yet: the post pre-empted it
    const post = h.me.units(UnitType.DefensePost)[0];
    expect(h.game.manhattanDist(post.tile(), dst)).toBeLessThanOrEqual(h.game.config().defensePostRange());
    // the boat lands (conquers a tile of ours) and the beachhead is counter-waved at 1.05× the landed troops
    expect(h.until(() => sea.numTilesOwned() > tiles0, 300)).toBe(true);
    expect(h.until(() => h.log.some((l) => l.includes("BEACHHEAD Sea")), 60)).toBe(true);
    expect(h.log.some((l) => /BEACHHEAD Sea \d+t at \(\d+,\d+\) ← 8k/.test(l))).toBe(true); // ceil(8000 × 1.05) = 8400
    expect(h.bot.fired.get("boatDefense") ?? 0).toBeGreaterThanOrEqual(2); // inbound + post/beachhead
  });

  test("flag off: nothing pre-empts the boat — the post comes only AFTER the wave is ashore (the generic incoming rule), and the 8k landing is under the generic counter's floor", async () => {
    const { h, sea, tiles0 } = await invade(false);
    expect(
      h.until(() => sea.numTilesOwned() > tiles0 || h.me.units(UnitType.DefensePost).length > 0, 400),
    ).toBe(true);
    expect(sea.numTilesOwned()).toBeGreaterThan(tiles0); // the landing came first: no post stood before it
    expect(h.me.units(UnitType.DefensePost).length).toBe(0);
    h.step(200); // the generic rules react to the wave now ashore: a post where the attack lands, but no counter
    expect(h.log.some((l) => l.includes("BOAT INBOUND") || l.includes("BEACHHEAD"))).toBe(false);
    // 8k against our 300k is under counterAttack's 5 % floor: the plain bot sends nothing at Sea
    expect(h.me.outgoingAttacks().some((a) => a.target() === sea)).toBe(false);
    expect(h.log.some((l) => l.includes("COUNTER Sea"))).toBe(false);
    expect(h.bot.fired.get("boatDefense")).toBeUndefined();
  });
});

describe("boatDefense: enemy transport bound for a tribe in our sphere", () => {
  const BUSY: RivalSpec = { name: "Busy", type: PlayerType.Bot, at: [1110, 420], tiles: [1085, 400, 1119, 440], troops: 1_500 }; // touches our west edge — fewest troops so harvestBots clicks it first, big enough that eating it outlasts the test window: the single slot stays taken
  const REEF: RivalSpec = { name: "Reef", type: PlayerType.Bot, at: [1140, 456], tiles: [1120, 446, 1218, 470], troops: 3_000 }; // borders us to the south, its own coast out east on the Gulf of Aden (~x1216)

  async function race(boatDefense: boolean) {
    const h = await playbookSetup({
      map: "world",
      spawn: [1135, 420],
      tiles: ME,
      troops: 120_000, // capShare < 0.6 and not plentiful: harvestBots keeps ONE tribe attack at a time
      bot: { ...QUIET, boatDefense }, // the tribe race triggers on the sphere test (Reef borders us), not bdCoastRange: its coast is ~70 tiles from our rect
      rivals: [SEA, BUSY, REEF],
    });
    const sea = h.rival("Sea");
    const reef = h.rival("Reef");
    const busy = h.rival("Busy");
    // let harvestBots take the single tribe slot with Busy
    expect(h.until(() => h.me.outgoingAttacks().some((a) => a.target() === busy), 60)).toBe(true);
    expect(h.me.outgoingAttacks().some((a) => a.target() === reef)).toBe(false);
    const dst = shoreOf(h, reef, 1150, 445); // Reef's shore nearest our corner
    alignForScan(h);
    h.game.addExecution(new TransportShipExecution(sea, dst, 6_000));
    return { h, sea, reef, busy };
  }

  test("flag on: we click the tribe first (TRIBE RACE), jumping the one-at-a-time queue", async () => {
    const { h, reef, busy } = await race(true);
    expect(h.until(() => h.me.outgoingAttacks().some((a) => a.target() === reef), 60)).toBe(true);
    expect(h.log.some((l) => l.includes("TRIBE RACE Reef vs Sea"))).toBe(true);
    expect(busy.isAlive()).toBe(true); // the slot was not freed by Busy dying: the race genuinely jumped the queue
    expect(h.bot.fired.get("boatDefense") ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("flag off: the tribe slot stays full and Reef is not clicked while the enemy boat sails", async () => {
    const { h, reef } = await race(false);
    h.step(80); // the ~45-tile sail and then some (longer and Busy runs out of tiles, legitimately freeing the slot)
    expect(h.me.outgoingAttacks().some((a) => a.target() === reef)).toBe(false);
    expect(h.log.some((l) => l.includes("TRIBE RACE"))).toBe(false);
    expect(h.bot.fired.get("boatDefense")).toBeUndefined();
  });
});

// keep the import used when assertions above change shape
void military;
