// Flag `thinGuard` (docs/PlaybookBotPlan.md "Tribe traps"): every 100 ticks scan our border for pinches — a run
// of ≤ thinWidth of our tiles with non-owned land on both ends. A pinch facing free land gets an immediate
// widening expand click; facing a tribe, that tribe goes first in harvestBots' order; facing a rival, a defense
// post is requested at the pinch through the existing ≤8-post budget. Tribe follow-ups run at half
// botFollowUpTicks while a wave is unfinished (a half-eaten tribe is a salient-maker — hard0 transcripts).
//
// Geometry (big_plains, 200×200): our band [0,40,199,139] with a 6-wide corridor [98,20,103,39] poking north into
// a block [80,0,121,39] owned by the fixture's neighbour — the corridor's west (x 97) and east (x 104) flanks are
// that neighbour's land, so the horizontal probe finds a width-6 pinch.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { conquerRect, playbookSetup, PRE_COMBO, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = {
  ...PRE_COMBO,
  expandFree: 0,
  expandContested: 0,
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
const CORRIDOR: Rect = [98, 20, 103, 39];
const BLOCK: Rect = [80, 0, 121, 39];

describe("thinGuard: a pinch facing a rival requests a defense post", () => {
  async function pinchGame(thinGuard: boolean) {
    const h = await playbookSetup({
      map: "big_plains",
      spawn: [100, 90],
      tiles: BAND,
      troops: 400_000,
      bot: { ...QUIET, thinGuard },
      rivals: [{ name: "H", type: PlayerType.Human, at: [90, 10], tiles: BLOCK, troops: 10_000 }],
      config: { instantBuild: true },
    });
    conquerRect(h.game, h.me, CORRIDOR); // carve the corridor back out of H's block: ours, H on both flanks
    h.me.addGold(500_000n);
    return h;
  }

  test("flag on: THIN logged and a post goes up covering the pinch", async () => {
    const h = await pinchGame(true);
    expect(h.until(() => h.log.some((l) => l.includes("THIN (")), 150)).toBe(true);
    expect(h.log.some((l) => /THIN \(\d+,\d+\) width~6 faces H \/ H/.test(l))).toBe(true);
    expect(h.until(() => h.me.units(UnitType.DefensePost).length > 0, 100)).toBe(true);
    const post = h.me.units(UnitType.DefensePost)[0];
    // the pinch is inside the corridor: the post must cover it (landingPostTile searches the ±12 box around it)
    expect(h.game.x(post.tile())).toBeGreaterThanOrEqual(98 - 12);
    expect(h.game.x(post.tile())).toBeLessThanOrEqual(103 + 12);
    expect(h.log.some((l) => l.includes("THIN post at"))).toBe(true);
    expect(h.bot.fired.get("thinGuard") ?? 0).toBeGreaterThanOrEqual(2); // pinch + post
  });

  test("flag off: no scan, no THIN, no post", async () => {
    const h = await pinchGame(false);
    h.step(300);
    expect(h.log.some((l) => l.includes("THIN"))).toBe(false);
    expect(h.me.units(UnitType.DefensePost).length).toBe(0);
    expect(h.bot.fired.get("thinGuard")).toBeUndefined();
  });
});

describe("thinGuard: a pinch facing free land gets the widening expand click", () => {
  async function freePinchGame(thinGuard: boolean) {
    const h = await playbookSetup({
      map: "big_plains",
      spawn: [100, 90],
      tiles: BAND,
      troops: 400_000,
      // the widening click goes at expandContested; the plain expand rule itself never runs (expandEvery huge)
      bot: { ...QUIET, thinGuard, expandContested: 0.2, expandEvery: 999_983 },
    });
    conquerRect(h.game, h.me, CORRIDOR); // free land on both flanks: nobody owns the block
    return h;
  }

  test("flag on: THIN logged and an expand click widens it (tiles grow with the plain expand off)", async () => {
    const h = await freePinchGame(true);
    const tiles0 = h.me.numTilesOwned();
    expect(h.until(() => h.log.some((l) => l.includes("THIN (")), 150)).toBe(true);
    expect(h.log.some((l) => /THIN \(\d+,\d+\) width~6 faces free land \/ free land/.test(l))).toBe(true);
    expect(h.until(() => h.me.numTilesOwned() > tiles0, 100)).toBe(true);
    expect(h.bot.fired.get("thinGuard") ?? 0).toBeGreaterThanOrEqual(1); // widen
  });

  test("flag off: no THIN and no expansion at all", async () => {
    const h = await freePinchGame(false);
    const tiles0 = h.me.numTilesOwned();
    h.step(300);
    expect(h.log.some((l) => l.includes("THIN"))).toBe(false);
    expect(h.me.numTilesOwned()).toBe(tiles0);
  });
});

describe("thinGuard: a pinch facing a tribe puts that tribe first in harvestBots' order", () => {
  // No tribe may be clicked before the t100 pinch scan, or the single wave occupies the fixture. tribeConcurrency 0
  // keeps the slot count at zero until capShare crosses 0.6 (harvestBots' +1); at t95 the test raises our troops to
  // 0.65 × cap — the slot opens right as the scan marks T, and the tribes pass clicks T over the weaker W.
  async function tribePinchGame(thinGuard: boolean) {
    const h = await playbookSetup({
      map: "big_plains",
      spawn: [100, 90],
      tiles: BAND,
      troops: 100_000,
      bot: { ...QUIET, thinGuard, tribeConcurrency: 0 },
      rivals: [
        { name: "T", type: PlayerType.Bot, at: [90, 10], tiles: BLOCK, troops: 5_000 },
        { name: "W", type: PlayerType.Bot, at: [20, 20], tiles: [0, 0, 40, 39], troops: 1_000 },
      ],
    });
    conquerRect(h.game, h.me, CORRIDOR); // T on both flanks of the corridor
    while (h.game.ticks() < 95) h.step(1);
    h.me.setTroops(Math.ceil(h.game.config().maxTroops(h.me) * 0.65)); // capShare 0.65 > 0.6: the slot opens
    h.rival("W").setTroops(1_000); // the plain weakest-first pick
    h.rival("T").setTroops(5_000);
    h.until(() => h.log.some((l) => l.includes("bot ")), 60);
    return h;
  }

  test("flag on: T (the pinch tribe) is clicked over the weaker W, TRIBE PRIORITY (thin pinch) logged", async () => {
    const h = await tribePinchGame(true);
    expect(h.log.some((l) => /THIN \(\d+,\d+\) width~6 faces T \/ T/.test(l))).toBe(true);
    const first = h.log.find((l) => l.includes("bot "))!;
    expect(first).toContain("bot T ");
    expect(h.log.some((l) => l.includes("TRIBE PRIORITY T (thin pinch)"))).toBe(true);
    expect(h.bot.fired.get("thinGuard") ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("flag off: the plain order clicks W first", async () => {
    const h = await tribePinchGame(false);
    const first = h.log.find((l) => l.includes("bot "))!;
    expect(first).toContain("bot W ");
    expect(h.log.some((l) => l.includes("TRIBE PRIORITY") || l.includes("THIN"))).toBe(false);
  });
});

describe("thinGuard: tribe follow-ups at half botFollowUpTicks", () => {
  // tribes.test.ts's fixture: a 150k tribe forces a split click (want 251k > 30 % of 800k); the follow-up merges
  // into the running wave, visible as a troop jump. Plain cadence: click t10, follow-up t110 (jump initialises
  // t111 — asserted in tribes.test.ts). Half cadence: follow-up at the t60 pass, jump at t61.
  test("flag on: the follow-up lands 50 ticks after the click, not 100", async () => {
    const h = await playbookSetup({
      map: "big_plains",
      spawn: [100, 50],
      tiles: [0, 0, 199, 99],
      troops: 800_000,
      bot: { ...PRE_COMBO, expandFree: 0, expandContested: 0, thinGuard: true },
      rivals: [{ name: "T", type: PlayerType.Bot, at: [100, 150], tiles: [0, 100, 199, 199], troops: 150_000 }],
    });
    const t = h.rival("T");
    h.step(h.nextRuleTick(10) + 1);
    expect(h.log.find((l) => l.includes("bot T "))).toBeDefined();
    const jumps: number[] = [];
    const running = () => h.me.outgoingAttacks().find((a) => a.target() === t);
    let prev = running();
    for (let i = 0; i < 80; i++) {
      h.step(1);
      const cur = running();
      if (prev && cur && cur.troops() > prev.troops()) jumps.push(h.game.ticks());
      prev = cur;
    }
    expect(jumps).toEqual([61]); // half of botFollowUpTicks (100) after the t10 click; the plain bot jumps at 111
    expect(h.bot.fired.get("thinGuard") ?? 0).toBeGreaterThanOrEqual(1); // the followUp site
  });
});
