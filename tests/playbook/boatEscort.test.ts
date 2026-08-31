// Flag `boatEscort` (docs/PlaybookBotPlan.md "Boat escorts"): a long crossing whose corridor has a live enemy warship
// within escortThreatRange is held, our idle warship nearest the threat is moved onto the corridor (or one is bought
// there), the crossing sails once the corridor reads clear, and a worthy contested crossing with no escort possible
// swarms escortSwarm staggered boats. Short hops sail as before.
//
// Geometry (the world test map, as boats2.test.ts): we hold Africa's Red Sea bank at Bab-el-Mandeb; the tribe "Med" on
// the Mediterranean coast at (1106, 290) is 148 tiles by water (up the Red Sea, through Suez) — the tribe-boat rule's
// only target, launched at tick 300 (boatAtTick 1e9 keeps the early boat out, seaExpansion starts at 600). "Levant", a
// scripted nation on the Levant coast, owns the port the enemy warship patrols from, in the Med beside Med's shore.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { WarshipExecution } from "../../src/core/execution/WarshipExecution";
import { Game, Player, PlayerType, Unit, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { PlaybookHarness, playbookSetup, Rect, RivalSpec } from "../util/PlaybookSetup";

// pin the defaults the fixture depends on (other tests do the same with their PRE_CMA/boats pins)
const QUIET: Partial<PlaybookParams> = {
  expandFree: 0, expandContested: 0, fightNotBeforeTick: 1e9, multiWar: false, annexWars: false, lapseToAttack: false,
  takeFallout: false, finishByBoat: false, boatsWaterPath: false, boatsNearest: true, boatsAfterCoast: false, boatDedupe: true,
  boatDedupeRadius: 40, boatAtTick: 1e9, boatOpening: false, contestLeader: false, duelPush: false, plateauBreak: false,
  escortMinSail: 60, escortFromTick: 0, escortThreatRange: 130, escortBuy: true, escortMaxShips: 2, escortSwarm: 3, escortDeferTicks: 600,
};
const ME: Rect = [1120, 396, 1150, 445]; // Africa's Red Sea bank, coast at y 396–407
const SPAWN: [number, number] = [1135, 420];
const MED: RivalSpec = { name: "Med", type: PlayerType.Bot, at: [1106, 290], tiles: [1096, 280, 1118, 300], troops: 4000 }; // the Mediterranean coast, 148 tiles by water
const LEVANT: RivalSpec = { name: "Levant", type: PlayerType.Nation, at: [1150, 306], tiles: [1124, 296, 1165, 318], troops: 50_000 }; // the Levant coast (water tiles in the rect are skipped): the enemy port
const ENEMY_PATROL: [number, number] = [1108, 306]; // the Med, ~15 tiles off Med's shore — on the corridor's far end
const OUR_PATROL: [number, number] = [1160, 400]; // the Red Sea off our coast

type Priv = { military: Military; boat: (tile: TileRef, n: number, why: string) => number };
const priv = (h: PlaybookHarness) => h.bot as unknown as Priv;
const escorts = (h: PlaybookHarness) => (priv(h).military as unknown as { escorts: unknown[] }).escorts;

function oceanShore(game: Game, p: Player): TileRef {
  for (const t of p.borderTiles()) if (game.isOceanShore(t)) return t;
  throw new Error(`${p.name()} has no ocean shore`);
}
/** Gold, a port on the player's ocean shore, and a warship patrolling `at` (built by the real WarshipExecution next tick). */
function navy(game: Game, p: Player, at: [number, number], gold = 20_000_000n): void {
  p.addGold(gold);
  p.buildUnit(UnitType.Port, oceanShore(game, p), {});
  game.addExecution(new WarshipExecution({ owner: p, patrolTile: game.ref(at[0], at[1]) }));
}
const ship = (p: Player): Unit => p.units(UnitType.Warship)[0];
/** Med's shore tile nearest our coast — the tribe boat's landing and the corridor's end. */
function medShore(game: Game, med: Player): TileRef {
  let best: TileRef | null = null, bestD = 1e9;
  for (const t of med.borderTiles()) { if (!game.isOceanShore(t)) continue; const d = game.manhattanDist(t, game.ref(1150, 400)); if (d < bestD) { bestD = d; best = t; } }
  return best!;
}

async function fixture(bot: Partial<PlaybookParams>, ours: boolean, gold = 0n): Promise<PlaybookHarness> {
  const h = await playbookSetup({ map: "world", spawn: SPAWN, tiles: ME, troops: 100_000, bot: { ...QUIET, ...bot }, rivals: [MED, LEVANT] });
  navy(h.game, h.rival("Levant"), ENEMY_PATROL);
  if (ours) navy(h.game, h.me, OUR_PATROL, gold > 0n ? gold : 20_000_000n); else if (gold > 0n) h.me.addGold(gold);
  h.step(2); // the warships exist
  expect(ship(h.rival("Levant"))).toBeDefined();
  return h;
}

describe("boatEscort", () => {
  test("on: our idle warship is moved onto the contested corridor, the crossing is held, and it sails once the threat is gone", async () => {
    const h = await fixture({ boatEscort: true }, true);
    const ours = ship(h.me), enemy = ship(h.rival("Levant"));
    expect(ours).toBeDefined();
    expect(h.game.getWaterComponent(ours.tile())).toBe(h.game.getWaterComponent(enemy.tile())); // Suez is water: one sea
    const patrol0 = ours.warshipState().patrolTile;
    h.until(() => h.game.ticks() === 302, 400); // the tick-300 tribe-boat pass, and the MoveWarshipExecution it added
    const line = h.log.find((l) => /ESCORT \d+ → corridor \(\d+,\d+\) for boat to \(\d+,\d+\); threat Levant at \d+/.test(l));
    expect(line).toBeDefined();
    expect(ours.warshipState().patrolTile).not.toBe(patrol0); // moved onto the corridor …
    const at = ours.warshipState().patrolTile!;
    expect(h.game.manhattanDist(at, enemy.tile())).toBeLessThan(h.game.manhattanDist(patrol0!, enemy.tile())); // … at the point nearest the threat
    expect(h.me.units(UnitType.TransportShip).length).toBe(0); // the crossing is held, not sailed into the warship
    expect(h.bot.fired.get("boatEscort")).toBeGreaterThanOrEqual(1);
    expect(escorts(h).length).toBe(1);
    // the threat goes: the next tribe-boat pass sails
    enemy.delete();
    h.until(() => h.game.ticks() === 402, 200);
    const boats = h.me.units(UnitType.TransportShip);
    expect(boats.length).toBe(1);
    expect(h.log.some((l) => /boat \d+k: to tribe Med/.test(l))).toBe(true);
    // release: the escort watches that transport and is freed once it has landed (or died)
    expect(escorts(h).length).toBe(1);
    expect(h.until(() => !boats[0].isActive(), 400)).toBe(true);
    h.until(() => h.game.ticks() % 10 === 1, 12); // the escorts rule has run since
    expect(escorts(h).length).toBe(0);
  });

  test("off: the boat sails unescorted into the warship's range and nothing is logged", async () => {
    const h = await fixture({}, true);
    const ours = ship(h.me);
    const patrol0 = ours.warshipState().patrolTile;
    h.until(() => h.game.ticks() === 302, 400);
    expect(h.me.units(UnitType.TransportShip).length).toBe(1);
    expect(h.log.some((l) => l.includes("ESCORT"))).toBe(false);
    expect(ours.warshipState().patrolTile).toBe(patrol0);
    expect(h.bot.fired.get("boatEscort")).toBeUndefined();
  });

  test("no warship and no gold: the crossing is deferred and logged; with gold, a warship is bought at the corridor and takes the escort", async () => {
    const poor = await fixture({ boatEscort: true }, false);
    poor.until(() => poor.game.ticks() === 552, 600); // three tribe-boat passes, still before seaExpansion's tick 600
    expect(poor.me.units(UnitType.TransportShip).length).toBe(0);
    expect(poor.log.some((l) => l.includes("ESCORT none: crossing deferred"))).toBe(true);
    expect(poor.log.some((l) => l.includes("ESCORT buy"))).toBe(false);
    expect(poor.bot.fired.get("boatEscort")).toBeGreaterThanOrEqual(1);

    const rich = await fixture({ boatEscort: true }, false, 20_000_000n);
    rich.me.buildUnit(UnitType.Port, oceanShore(rich.game, rich.me), {}); // a port on the Red Sea: where the bought ship spawns
    rich.until(() => rich.log.some((l) => l.includes("ESCORT buy Warship")), 400);
    expect(rich.log.some((l) => l.includes("ESCORT buy Warship for corridor"))).toBe(true);
    expect(rich.until(() => rich.me.units(UnitType.Warship).length === 1, 50)).toBe(true);
    expect(rich.until(() => rich.log.some((l) => /ESCORT \d+ → corridor/.test(l)), 200)).toBe(true); // the new ship is assigned on the next pass
    expect(rich.me.units(UnitType.TransportShip).length).toBe(0); // still held: the threat is live
  });

  test("a short hop is never escorted: under escortMinSail the boat sails past the warship as before", async () => {
    const h = await fixture({ boatEscort: true, escortMinSail: 200 }, true); // the 148-tile crossing counts as a hop
    h.until(() => h.game.ticks() === 302, 400);
    expect(h.me.units(UnitType.TransportShip).length).toBe(1);
    expect(h.log.some((l) => l.includes("ESCORT"))).toBe(false);
  });

  test("swarm: a worthy contested crossing with no escort possible launches escortSwarm staggered boats; one without the flag", async () => {
    const run = async (boatEscort: boolean) => {
      const h = await fixture({ boatEscort, escortBuy: false }, false);
      h.until(() => h.game.ticks() === 299, 400); // just before the tick-300 tribe-boat pass (which boatDedupe then refuses: a boat is bound there)
      const target = medShore(h.game, h.rival("Med"));
      const sent = priv(h).boat(target, 9000, `CONTEST leader Med ${h.rival("Med").numTilesOwned()}t`); // the contest rule's launch: a worthy target
      expect(sent).toBeGreaterThan(0);
      h.step(30); // two escorts-rule passes: the follow-ups are due 10 and 20 ticks after the first
      return h;
    };
    const on = await run(true);
    const boats = on.me.units(UnitType.TransportShip);
    expect(boats.length).toBe(3);
    for (const b of boats) expect(b.troops()).toBe(3000);
    expect(on.log.some((l) => /ESCORT swarm 3 boats → \(\d+,\d+\)/.test(l))).toBe(true);
    expect(on.log.filter((l) => l.includes("ESCORT swarm") && l.includes("boat ")).length).toBe(2); // the two follow-up launches
    expect(on.bot.fired.get("boatEscort")).toBeGreaterThanOrEqual(1);

    const off = await run(false);
    expect(off.me.units(UnitType.TransportShip).length).toBe(1);
    expect(off.log.some((l) => l.includes("ESCORT"))).toBe(false);
  });
});
