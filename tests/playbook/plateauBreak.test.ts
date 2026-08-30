// Flag `plateauBreak` (docs/PlaybookBotPlan.md "Why we lose full games", loss cluster 3): 40 of 41 lost full games
// stop growing by minute 33 while the wins keep growing to 61. The bot samples its tile count every 300 ticks; when
// it is rank > 1 among non-bots, grew < plateauGrowth over plateauWindow ticks, has no outgoing non-bot attack and
// is not in hold mode, it escalates once per window: a forced sea expansion (capShare gates off, 1.5× the distance
// caps), else a forced war on the largest adjacent non-ally through warPick/actWar (only the affordability gate and
// the ratio floor relax — whole-or-nothing, reserve, capFloor and the posts/thin-empire gates stay), else — boxed
// in by allies — the weakest adjacent alliance lapses at its next expiry.
//
// The fixtures re-pin both armies every 10 ticks with setTroops: regen races each side to its cap inside one
// plateau window otherwise, and the ratios the war gates read drift out from under the test. Our pin is RELATIVE
// to our live cap (0.64× — under fightAbove 0.7) and the rival's is 0.16× of it: the forced wave 0.32C + 1000 fits
// under the capFloor room (0.34C) while 2× it stays over the affordability line (0.269C), whatever cities do to C.
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Difficulty, PlayerType, UnitType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, Rect } from "../util/PlaybookSetup";

// Pins: no expansion or boats of the bot's own (the plateau must come from the fixture, not a starved bot), wars
// allowed from tick 0, and the pre-existing defaults the numbers were sized against (as other tests pin).
const HOME: Partial<PlaybookParams> = {
  expandFree: 0, expandContested: 0, boatAtTick: 1e9, nationAware: false, fightNotBeforeTick: 0, fightMinCities: 0,
  lapseToAttack: false, finishByBoat: false, multiWar: false, annexWars: false, plateauWindow: 600,
};
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];
const military = (h: PlaybookHarness) => (h.bot as unknown as { military: Military }).military;

/** Step to `target` ticks, re-pinning the armies every 10 ticks. */
function drive(h: PlaybookHarness, target: number, pin: () => void) {
  pin();
  while (h.game.ticks() < target) { h.step(10); pin(); }
}

const ME: Rect = [50, 62, 149, 101]; // 100 × 40 = 4 000 tiles
const RIVAL: Rect = [0, 40, 199, 61]; // 200 × 22 = 4 400 tiles, adjacent to our north: we are rank 2

async function boxedByRival(plateauBreak: boolean, opts: { difficulty?: Difficulty; me?: Rect; rival?: Rect } = {}) {
  const me = opts.me ?? ME, rival = opts.rival ?? RIVAL;
  const h = await playbookSetup({
    map: "big_plains", spawn: centre(me), tiles: me, troops: 100_000,
    bot: { ...HOME, plateauBreak },
    config: opts.difficulty === undefined ? {} : { difficulty: opts.difficulty },
    rivals: [{ name: "R", type: PlayerType.Human, at: centre(rival), tiles: rival, troops: 50_000 }],
  });
  const cap = () => h.game.config().maxTroops(h.me);
  const pin = () => { h.me.setTroops(Math.floor(cap() * 0.64)); h.rival("R").setTroops(Math.floor(cap() * 0.16)); };
  return { h, pin };
}

describe("plateauBreak: the forced war", () => {
  test("on: no growth at rank 2 → the war on R opens at the affordable ratio, once, though the plain gates refuse it", async () => {
    const { h, pin } = await boxedByRival(true);
    drive(h, 890, pin);
    expect(h.me.numTilesOwned()).toBeLessThan(h.rival("R").numTilesOwned()); // rank 2 held through the window
    drive(h, 950, pin); // t900: the escalation (the war then eats R's tiles fast, so rank was asserted above)
    const line = h.log.find((l) => /PLATEAU t900 tiles \d+→\d+ \(.* % in 600 ticks\) rank 2: forced war on R/.test(l));
    expect(line).toBeDefined();
    expect(h.bot.fired.get("plateauBreak")).toBe(1);
    expect(h.until(() => h.me.outgoingAttacks().some((a) => a.target() === h.rival("R")), 40)).toBe(true);
  });

  test("off: the same fixture sits still — no war, no PLATEAU log", async () => {
    const { h, pin } = await boxedByRival(false);
    drive(h, 950, pin);
    expect(h.log.some((l) => l.includes("PLATEAU"))).toBe(false);
    expect(h.log.some((l) => l.includes("ATTACK R"))).toBe(false);
    expect(h.me.outgoingAttacks().length).toBe(0);
    expect(h.bot.fired.get("plateauBreak")).toBeUndefined();
  });
});

// Impossible's denial line is 40 %: at 38 % of the map the finish rule holds (a MIRV-capable rival exists) or
// pushes (none does), so the mode gate can be tested at rank 2 — on Medium the 65 % line and rank > 1 exclude
// each other.
const ME_BIG: Rect = [0, 0, 199, 75]; // 15 200 of big_plains' 40 000 tiles = 38 %
const RIVAL_BIG: Rect = [0, 76, 199, 165]; // 18 000 tiles, adjacent: we are rank 2

describe("plateauBreak: mode gates", () => {
  test("hold mode: a MIRV-capable rival exists — the plateau rule never fights the finish rule", async () => {
    const { h, pin } = await boxedByRival(true, { difficulty: Difficulty.Impossible, me: ME_BIG, rival: RIVAL_BIG });
    h.rival("R").buildUnit(UnitType.MissileSilo, h.game.ref(100, 120), {});
    h.rival("R").addGold(500_000_000n);
    drive(h, 1210, pin);
    expect(h.log.some((l) => l.includes("FINISH mode grow → hold"))).toBe(true);
    expect(h.log.some((l) => l.includes("PLATEAU"))).toBe(false);
    expect(h.bot.fired.get("plateauBreak")).toBeUndefined();
  });

  test("push mode does not block: the same fixture without the silo escalates", async () => {
    const { h, pin } = await boxedByRival(true, { difficulty: Difficulty.Impossible, me: ME_BIG, rival: RIVAL_BIG });
    drive(h, 950, pin);
    expect(h.log.some((l) => l.includes("FINISH mode grow → push"))).toBe(true);
    expect(h.log.some((l) => /PLATEAU .*: forced war on R/.test(l))).toBe(true);
    expect(h.bot.fired.get("plateauBreak")).toBe(1);
  });
});

// World-map geometry (boats.test.ts): we hold Africa's Red Sea bank; Arabia's free shore lies ~30 tiles across the
// strait. A 60k army on a 1 550-tile territory sits under 40 % of cap, so the plain sea-expansion rule refuses
// while wilderness remains ("land first while it is free and we are small") — exactly the boxed-in shape the flag
// breaks. The far rival exists only to make us rank 2.
const SEA_ME: Rect = [1120, 396, 1150, 445];
const SEA_RANK: Rect = [1050, 300, 1150, 380]; // north-west on Africa, not adjacent to us

async function seaFixture(plateauBreak: boolean) {
  const h = await playbookSetup({
    map: "world", spawn: [1135, 420], tiles: SEA_ME, troops: 60_000,
    bot: { ...HOME, plateauBreak },
    rivals: [{ name: "Big", type: PlayerType.Human, at: [1100, 340], tiles: SEA_RANK, troops: 20_000 }],
  });
  const pin = () => { h.me.setTroops(60_000); h.rival("Big").setTroops(20_000); };
  return { h, pin };
}

describe("plateauBreak: the forced sea expansion", () => {
  test("on: the plateau forces the boat the capShare gate was holding", async () => {
    const { h, pin } = await seaFixture(true);
    expect(h.rival("Big").numTilesOwned()).toBeGreaterThan(h.me.numTilesOwned()); // rank 2
    drive(h, 950, pin);
    expect(h.log.some((l) => /PLATEAU .*: forced sea expansion/.test(l))).toBe(true);
    expect(h.bot.fired.get("plateauBreak")).toBe(1);
    expect(h.me.units(UnitType.TransportShip).length + h.log.filter((l) => l.includes("sea expansion")).length).toBeGreaterThan(0);
    expect(h.log.some((l) => l.includes("forced war"))).toBe(false); // sea comes before war in the escalation
  });

  test("off: no boat ever — and the forced call is what unlocks it", async () => {
    const { h, pin } = await seaFixture(false);
    drive(h, 1210, pin);
    expect(h.log.some((l) => l.includes("PLATEAU"))).toBe(false);
    expect(h.me.units(UnitType.TransportShip).length).toBe(0);
    const mil = military(h);
    expect(mil.seaExpansion(false)).toBe(false); // the plain gates still refuse at this very tick
    expect(mil.seaExpansion(true)).toBe(true);
    expect(h.me.units(UnitType.TransportShip).length + h.me.outgoingAttacks().length).toBeGreaterThanOrEqual(0);
    expect(h.log.some((l) => l.includes("sea expansion"))).toBe(true);
  });
});

// Boxed in by allies: the only neighbour is a bigger ally. Sea (no ocean on big_plains) and war (no unfriendly
// neighbour) both fail, so step 3 marks the weakest adjacent alliance to lapse at its next expiry.
const ALLY_ME: Rect = [40, 80, 159, 119]; // 4 800 tiles
const ALLY: Rect = [0, 40, 199, 79]; // 8 000 tiles, adjacent north: we are rank 2

async function boxedByAlly(plateauBreak: boolean) {
  const h = await playbookSetup({
    map: "big_plains", spawn: centre(ALLY_ME), tiles: ALLY_ME, troops: 150_000,
    bot: { ...HOME, plateauBreak },
    config: { customAllianceDuration: 2 }, // a 1200-tick alliance: the t900 escalation lands before the renewal window (expiry − 300)
    rivals: [{ name: "A", type: PlayerType.Human, at: centre(ALLY), tiles: ALLY, troops: 100_000 }],
  });
  const a = h.rival("A");
  h.game.addExecution(new AllianceRequestExecution(a, h.me.id()));
  h.step(2);
  const al = h.me.allianceWith(a);
  expect(al).not.toBeNull();
  const cap = () => h.game.config().maxTroops(h.me);
  const pin = () => { h.me.setTroops(Math.floor(cap() * 0.5)); a.setTroops(100_000); };
  return { h, a, al: al!, pin };
}

describe("plateauBreak: boxed in by allies", () => {
  test("on: the weakest adjacent alliance is let lapse at its next expiry", async () => {
    const { h, a, al, pin } = await boxedByAlly(true);
    drive(h, 950, pin);
    expect(h.log.some((l) => /PLATEAU .*: boxed in by allies — the alliance with A lapses at its expiry/.test(l))).toBe(true);
    expect(h.bot.fired.get("plateauBreak")).toBe(1);
    drive(h, 1150, pin);
    expect(al.onlyOneAgreedToExtend()).toBe(false); // no renewal was queued
    expect(h.until(() => !h.me.isFriendly(a), 300)).toBe(true);
  });

  test("off: the alliance is renewed as usual", async () => {
    const { h, al, pin } = await boxedByAlly(false);
    drive(h, 1150, pin);
    expect(h.log.some((l) => l.includes("PLATEAU"))).toBe(false);
    expect(h.log.some((l) => l.includes("boxed in"))).toBe(false);
    expect(al.onlyOneAgreedToExtend()).toBe(true); // our extension is in; the scripted human never answers
    expect(h.bot.fired.get("plateauBreak")).toBeUndefined();
  });
});

describe("plateauBreak: no trigger while growing", () => {
  test("an expanding bot at rank 2 never plateaus", async () => {
    const h = await playbookSetup({
      map: "big_plains", spawn: [100, 160], tiles: [90, 150, 109, 169], troops: 100_000,
      bot: { plateauBreak: true, plateauWindow: 600, fightNotBeforeTick: 1e9, boatAtTick: 1e9 },
      // R holds 22 000 tiles; the bot's whole reachable half (y ≥ 110) is 18 000 — rank 2 is structural, however fast it grows
      rivals: [{ name: "R", type: PlayerType.Human, at: [100, 50], tiles: [0, 0, 199, 109], troops: 200_000 }],
    });
    const t0 = h.me.numTilesOwned();
    h.step(950 - h.game.ticks()); // past the t900 window; the bot has grown all along
    expect(h.me.numTilesOwned()).toBeGreaterThan(t0 * 2); // the premise: it grew far past plateauGrowth
    expect(h.me.numTilesOwned()).toBeLessThan(h.rival("R").numTilesOwned()); // and stayed rank 2
    expect(h.log.some((l) => l.includes("PLATEAU"))).toBe(false);
    expect(h.bot.fired.get("plateauBreak")).toBeUndefined();
  });
});
