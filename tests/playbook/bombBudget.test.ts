// Flag `bombBudget` (docs/PlaybookBotPlan.md "Bomb fund and war yield"): once we own a silo and maybeBomb has a
// target, Economy.build holds the price of the NEXT planned bomb (Military.bombPlan) out of every discretionary buy
// and maybeBomb fires the moment gold covers it — no bombReserve on top. Off, the chain spends first and bombs with
// what is left above bombReserve (750k + 250k for an atom).
//
// Geometry (big_plains, 200 × 200): we hold the north (y ≤ 40) with a silo, 5k troops and capFullShare 2 (never a
// cap-needed city, the hard override that would otherwise eat the fund as the troops regrow); the
// rival R, our neighbour, holds the south. Its cities sit ≥ 75 tiles from our land (the value search wants 32 clear of friends; a
// hydrogen pick wants 105). The blast radii are the production ones (realNukes): two cities 11 apart are one atom
// cluster worth 6 (0.8 per 100k); 14 cities on a 40-tile grid plus that pair are one hydrogen cluster worth 48
// (0.96 per 100k) — the hydrogen wins the value search, the atom pair is the fallback plan.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PlaybookHarness, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, expandEvery: 10, capFullShare: 2, fightNotBeforeTick: 1e9, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false }; // the 2026-08-30 defaults are on; the fixtures set each flag explicitly
const ME: Rect = [10, 5, 190, 40];
const SMALL: Rect = [80, 41, 120, 170]; // 5330 tiles, our neighbour: never a hydrogen target
const BIG: Rect = [10, 41, 190, 199]; // 29k tiles, our neighbour
const PAIR: [number, number][] = [[100, 155], [108, 163]];
const GRID: [number, number][] = [...PAIR];
for (const y of [115, 155, 195]) for (const x of [20, 60, 100, 140, 180]) if (!(x === 100 && y === 155)) GRID.push([x, y]);

function military(h: PlaybookHarness): Military {
  return (h.bot as unknown as { military: Military }).military;
}
/** Us with a silo and R as the war target; `warm` build passes measure the income before `gold` lands. */
async function fixture(flags: Partial<PlaybookParams>, rivalTiles: Rect, cities: [number, number][], gold: bigint, warm = 0) {
  const h = await playbookSetup({ map: "big_plains", realNukes: true, spawn: [100, 25], tiles: ME, troops: 5_000, bot: { ...QUIET, ...flags }, rivals: [{ name: "R", type: PlayerType.Human, at: [100, 145], tiles: rivalTiles, troops: 200_000 }] });
  const r = h.rival("R");
  for (const [x, y] of cities) r.buildUnit(UnitType.City, h.game.ref(x, y), {});
  h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 25), {});
  (military(h) as unknown as { currentTarget_: Player | null }).currentTarget_ = r; // the war target: maybeBomb's first enemy
  h.step(warm * 10 + h.nextRuleTick(10) - 1); // the next build pass sees the gold
  h.me.addGold(gold);
  return { h, r };
}
const bought = (h: PlaybookHarness) => h.log.filter((l) => /^t\d+ (build|level) /.test(l)).map((l) => l.replace(/^t\d+ /, ""));
const fundLines = (h: PlaybookHarness) => h.log.filter((l) => l.includes("BOMB FUND"));

describe("bombBudget", () => {
  test("off: 900k buys three city levels first; the atom waits for gold above bombReserve", async () => {
    const { h } = await fixture({}, SMALL, PAIR, 900_000n);
    h.step(41);
    expect(bought(h)).toEqual(["build City", "build City", "build City"]);
    expect(h.log.some((l) => l.includes("BOMB"))).toBe(false);
    expect(h.bot.bombs).toBe(0);
    expect(h.bot.fired.get("bombBudget")).toBeUndefined();
  });

  test("on: 900k buys the first city out of what is above the fund and the atom in the same pass — a bomb the old rule would not have afforded; the next city waits for the next fund", async () => {
    const { h } = await fixture({ bombBudget: true }, SMALL, PAIR, 900_000n);
    h.step(1);
    expect(military(h).bombPlan(h.game.ticks() - 1)?.type).toBe(UnitType.AtomBomb);
    expect(bought(h)).toEqual(["build City"]); // 900k − 750k covers the first (125k)
    expect(h.log.some((l) => /BOMB Atom Bomb at 10[08],1[56][35]/.test(l))).toBe(true);
    expect(h.bot.bombs).toBe(1);
    expect(h.bot.fired.get("bombBudget")).toBe(1); // the bomb (900k < 750k + bombReserve)
    h.step(10);
    h.me.addGold(300_000n); // ~325k: the second city (250k) is affordable, the other city of the pair is the next plan
    h.step(10);
    expect(bought(h)).toEqual(["build City"]);
    expect(h.bot.fired.get("bombBudget")).toBe(2); // the deferred city
  });

  test("on: too poor for the plan, the bot logs BOMB FUND (again every 600 ticks), buys nothing discretionary, and fires the atom the pass the fund is covered", async () => {
    const { h } = await fixture({ bombBudget: true }, SMALL, PAIR, 500_000n);
    h.step(1);
    expect(fundLines(h)[0]).toMatch(/^t\d+ BOMB FUND: saving 750k for Atom at R \(have \d+k, \+\d+k\/min\)$/);
    expect(bought(h)).toEqual([]);
    expect(h.bot.fired.get("bombBudget")).toBe(1); // the first city (125k) deferred
    h.step(100);
    expect(bought(h)).toEqual([]);
    expect(fundLines(h).length).toBe(1);
    h.step(500);
    expect(fundLines(h).length).toBe(2);
    expect(h.bot.bombs).toBe(0);
    h.me.addGold(750_000n);
    h.step(11);
    expect(h.bot.bombs).toBe(1);
  });

  test("on: the 16-city cluster on a 16k-tile target plans a Hydrogen when 5M is within 90 s of income; 4.95M is held, nothing else is bought, the bomb goes once income covers it", async () => {
    const { h } = await fixture({ bombBudget: true }, BIG, GRID, 4_950_000n, 3);
    h.step(1);
    const plan = military(h).bombPlan(h.game.ticks() - 1);
    expect(plan?.type).toBe(UnitType.HydrogenBomb);
    expect(plan?.cost).toBe(5_000_000n);
    expect(fundLines(h)[fundLines(h).length - 1]).toMatch(/saving 5000k for Hydrogen at R/); // the warm-up passes planned the atom pair
    expect(bought(h)).toEqual([]); // 4.95M would buy every city level there is
    expect(h.bot.fired.get("bombBudget")).toBeGreaterThanOrEqual(1);
    expect(h.until(() => h.bot.bombs > 0, 1200)).toBe(true);
    expect(h.log.find((l) => / BOMB (Atom|Hydrogen)/.test(l))).toMatch(/BOMB Hydrogen Bomb at 100,155/);
    expect(h.log.some((l) => /BOMB Atom Bomb/.test(l))).toBe(false);
    expect(bought(h)).toEqual([]); // nothing passes the fund (capFullShare 2: no cap-needed city)
  });

  test("on: the same cluster plans the Atom pair when the hydrogen is out of income's reach", async () => {
    const { h } = await fixture({ bombBudget: true }, BIG, GRID, 1_000_000n, 3);
    h.step(1);
    expect(military(h).bombPlan(h.game.ticks() - 1)?.type).toBe(UnitType.AtomBomb);
    expect(h.bot.bombs).toBe(1);
    expect(h.log.some((l) => /BOMB Atom Bomb at 10[08],1[56][35]/.test(l))).toBe(true);
  });

  test("on: the hard overrides still win — an incoming attack gets its defence post before the fund, and the bomb waits for the gold the post took", async () => {
    const h = await playbookSetup({ map: "big_plains", realNukes: true, spawn: [100, 25], tiles: ME, troops: 5_000, bot: { ...QUIET, bombBudget: true }, rivals: [{ name: "R", type: PlayerType.Human, at: [100, 70], tiles: [10, 41, 190, 100], troops: 200_000 }] });
    const r = h.rival("R");
    r.buildUnit(UnitType.City, h.game.ref(100, 90), {});
    r.buildUnit(UnitType.City, h.game.ref(100, 98), {});
    h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 25), {});
    h.step(h.nextRuleTick(10) - 2);
    h.attack(r, h.me, 20_000); // > 5 % of our troops: a bomb target too
    h.step(1);
    expect(h.me.incomingAttacks().length).toBe(1);
    h.me.addGold(780_000n);
    h.step(1);
    expect(bought(h)).toEqual(["build Defense Post"]); // 780k − 750k < 50k: the fund alone would have refused it
    expect(h.bot.bombs).toBe(0); // the post's 50k left the fund short this pass
    expect(fundLines(h)[0]).toMatch(/saving 750k for Atom at R \(have 73\dk/);
  });
});
