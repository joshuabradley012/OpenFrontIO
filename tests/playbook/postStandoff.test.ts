// Param `postStandoff` (docs/PlaybookBotPlan.md "Defense-post standoff"): every defense-post site pick steps
// ~postStandoff tiles back from the border contact toward our interior, so the RADIUS edge (the engine's
// defensePostRange, 30 EUCLIDEAN — AttackExecution grants the 5×/3× bonus to a conquered tile with a defender
// post in that circle) reaches the enemy border instead of the building sitting on it. Default 28 = radius − 2,
// ON as a correction; 0 restores the old contact-tile geometry (the parity pin).
//
// Geometry (big_plains, 200×200): our band [0,40,199,139]; the enemy block H [0,0,199,39] north of us. H's tiny
// attack fires the incoming-attack post (Economy.defensePostTile): the contact border is our y=40 row, the
// border-normal points south — the standoff post lands ~28 south of the row, the old geometry 8 south.
import { describe, expect, test } from "vitest";
import { borderOf } from "../../src/core/execution/playbook/Border";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { conquerRect, playbookSetup, PlaybookHarness, PRE_COMBO, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = {
  ...PRE_COMBO,
  expandFree: 0,
  expandContested: 0, // no expansion: the band's borders stay put while the post is placed
  fightNotBeforeTick: 1e9,
  multiWar: false,
  annexWars: false,
  lapseToAttack: false,
  boatsNearest: false,
  finishByBoat: false,
  takeFallout: false,
  boatAtTick: 1e9,
};
const BAND: Rect = [0, 40, 199, 139];
const BLOCK: Rect = [0, 0, 199, 39];

async function attackGame(postStandoff: number): Promise<PlaybookHarness> {
  const h = await playbookSetup({
    map: "big_plains",
    spawn: [100, 90],
    tiles: BAND,
    troops: 400_000,
    bot: { ...QUIET, postStandoff },
    rivals: [{ name: "H", type: PlayerType.Human, at: [100, 20], tiles: BLOCK, troops: 50_000 }],
    config: { instantBuild: true },
  });
  h.me.addGold(500_000n);
  // a 1k attack (0.25 % of home: under every counter threshold) makes the incoming-attack post fire
  h.attack(h.rival("H"), h.me, 1_000);
  expect(h.until(() => h.me.units(UnitType.DefensePost).length > 0, 100)).toBe(true);
  return h;
}

/** Our border tiles the engine's defense radius covers from `tile` — the band the post actually protects. */
function coveredBorder(h: PlaybookHarness, tile: TileRef): number {
  const R2 = h.game.config().defensePostRange() ** 2;
  let n = 0;
  for (const b of borderOf(h.me)) if (h.game.euclideanDistSquared(b, tile) <= R2) n++;
  return n;
}
/** Euclidean distance from `tile` to the nearest of our border tiles that touches H — the border contact. */
function contactDist(h: PlaybookHarness, tile: TileRef): number {
  const hid = h.rival("H").smallID();
  let best = Infinity;
  for (const b of borderOf(h.me)) {
    let touches = false;
    h.game.forEachNeighbor(b, (n) => { if (h.game.ownerID(n) === hid) touches = true; });
    if (touches) best = Math.min(best, Math.sqrt(h.game.euclideanDistSquared(b, tile)));
  }
  return best;
}

describe("postStandoff: the post steps back so the radius edge reaches the border", () => {
  test("default 28: the post sits ~standoff behind the contact and its radius still covers it; 0 reproduces the old step-back tile", async () => {
    const on = await attackGame(28);
    const post = on.me.units(UnitType.DefensePost)[0].tile();
    // ~standoff back from the y=40 contact row (ring ±1; the attack may have taken a row locally)
    expect(on.game.y(post)).toBeGreaterThanOrEqual(65);
    expect(on.game.y(post)).toBeLessThanOrEqual(71);
    const dOn = contactDist(on, post);
    expect(dOn).toBeGreaterThanOrEqual(25); // the building stands off the border...
    expect(dOn).toBeLessThanOrEqual(30); // ...but the radius edge still reaches the contact
    expect(on.log.some((l) => l.includes("POST standoff"))).toBe(true);

    // postStandoff 0: the OLD geometry — contact midpoint stepped 8 tiles away from the attacker's side
    const off = await attackGame(0);
    const oldPost = off.me.units(UnitType.DefensePost)[0].tile();
    expect(off.game.y(oldPost)).toBeGreaterThanOrEqual(48); // mid row (40) + the old first step d=8
    expect(off.game.y(oldPost)).toBeLessThanOrEqual(50);
    expect(off.log.some((l) => l.includes("POST standoff"))).toBe(false);

    // the trade, measured (this fixture): the old near-border post covers more raw border tiles (57 — its circle
    // is centred on the border), the standoff post still covers a real stretch (29) while the building itself is
    // a full radius from the enemy instead of 8 tiles
    const covOn = coveredBorder(on, post);
    const covOff = coveredBorder(off, oldPost);
    expect(covOn).toBeGreaterThanOrEqual(15);
    expect(covOff).toBeGreaterThan(covOn);
  });

  test("thinGuard's pinch post inherits the standoff (landingPostTile shares the picker), shrunk to the corridor", async () => {
    // the thinGuard.test corridor: our 6-wide corridor [98,20,103,39] into H's block [80,0,121,39]
    const h = await playbookSetup({
      map: "big_plains",
      spawn: [100, 90],
      tiles: BAND,
      troops: 400_000,
      bot: { ...QUIET, thinGuard: true },
      rivals: [{ name: "H", type: PlayerType.Human, at: [90, 10], tiles: [80, 0, 121, 39], troops: 10_000 }],
      config: { instantBuild: true },
    });
    conquerRect(h.game, h.me, [98, 20, 103, 39]);
    h.me.addGold(500_000n);
    expect(h.until(() => h.me.units(UnitType.DefensePost).length > 0, 200)).toBe(true);
    expect(h.log.some((l) => l.includes("THIN post at"))).toBe(true);
    expect(h.log.some((l) => l.includes("POST standoff"))).toBe(true); // the shared picker placed it
    // the standoff shrank to the corridor (no 28-deep interior): the post stands off BOTH walls, not on one
    const post = h.me.units(UnitType.DefensePost)[0].tile();
    expect(h.game.x(post)).toBeGreaterThanOrEqual(100);
    expect(h.game.x(post)).toBeLessThanOrEqual(101);
  });
});
