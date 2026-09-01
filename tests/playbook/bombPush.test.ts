// Flag `bombPush` (tempo package, docs/PlaybookBotPlan.md "Tempo: bombPush + fastSilo"): bombs as push-enablers,
// Enzo-style — (a) EVERY war wave opens with a pre-bomb on the target's cluster nearest our shared border when a
// silo is up and gold covers the bomb + bombReserve (off, only a `richer` target gets one, and through maybeBomb's
// bombEvery cadence); (b) an enemy neighbour's NEW silo is bombed within bombSiloTicks of appearing; (c) the bomb
// cooldown during an active war is bombWarEvery (150) instead of bombEvery (300).
//
// Geometry (big_plains, 200 × 200, production blast radii): we hold the north (y ≤ 40) with a silo at (100,25);
// R holds a strip to the south. Its city pair sits ≥ 70 tiles from our land (clearOfFriends wants 32; the atom's
// outer blast is 30, so no collateral). lastBombTick is seeded 160 ticks back: the war cadence (150) has passed,
// the plain cadence (300) has not — the flag-off bot can only bomb ~140 ticks later.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { playbookSetup, PlaybookHarness, Rect } from "../util/PlaybookSetup";

const QUIET: Partial<PlaybookParams> = { expandFree: 0, expandContested: 0, expandEvery: 10, capFullShare: 2, boatAtTick: 1e9, boatsNearest: false, multiWar: false, annexWars: false, lapseToAttack: false, finishByBoat: false, duelPush: false, portWithoutPartnerTick: 1e9, bombReserve: 200_000 }; // bombReserve pinned under the combo default so 980k of gold covers atom + reserve while staying under `richer`'s 1M gate
const ME: Rect = [10, 5, 190, 40];
const R_TILES: Rect = [80, 41, 120, 170];
const PAIR: [number, number][] = [[100, 110], [108, 118]]; // one atom cluster, value 6

function military(h: PlaybookHarness): Military {
  return (h.bot as unknown as { military: Military }).military;
}
const tickOf = (line: string): number => Number(/^t(\d+)/.exec(line.trim())![1]);

/** Us with a firing silo, 3 cities (build() buys nothing) and a war-ready rival with a bombable city pair. */
async function warFixture(flags: Partial<PlaybookParams>) {
  const h = await playbookSetup({ map: "big_plains", realNukes: true, spawn: [100, 25], tiles: ME, troops: 500_000, bot: { ...QUIET, ...flags, fightNotBeforeTick: 0 }, rivals: [{ name: "R", type: PlayerType.Human, at: [100, 145], tiles: R_TILES, troops: 30_000 }] }); // 500k troops: above send()'s 0.3 × cap war floor, so the first wave leaves at once
  const r = h.rival("R");
  for (const [x, y] of PAIR) r.buildUnit(UnitType.City, h.game.ref(x, y), {});
  h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 25), {});
  for (const x of [40, 100, 160]) h.me.buildUnit(UnitType.City, h.game.ref(x, 20), {}); // 3 cities: step 3 of build() is satisfied, the gold stays for the bomb
  (military(h) as unknown as { lastBombTick: number }).lastBombTick = h.game.ticks() - 160; // a bomb 16 s ago: the 300-tick plain cadence holds, the 150-tick war cadence does not
  h.step(h.nextRuleTick(10) - 1);
  h.me.addGold(980_000n); // ≥ atom 750k + bombReserve 200k; < 1M so `richer` (the flag-off pre-bomb) stays false
  return h;
}

/** Us with a firing silo watching R (no wars: fightNotBeforeTick stays 1e9) — the counter-silo fixture. */
async function watchFixture(flags: Partial<PlaybookParams>) {
  const h = await playbookSetup({ map: "big_plains", realNukes: true, spawn: [100, 25], tiles: ME, troops: 5_000, bot: { ...QUIET, fightNotBeforeTick: 1e9, ...flags }, rivals: [{ name: "R", type: PlayerType.Human, at: [100, 145], tiles: R_TILES, troops: 200_000 }] });
  h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 25), {});
  for (const x of [40, 100, 160]) h.me.buildUnit(UnitType.City, h.game.ref(x, 20), {});
  h.step(110); // at least one 100-tick watch pass: R's (empty) silo set is seeded — an existing silo is never "new"
  h.me.removeGold(h.me.gold());
  h.me.addGold(980_000n); // ≥ atom + bombReserve (950k) but under the 1M city level, so build() cannot spend it
  return h;
}

describe("bombPush", () => {
  test("on: the war wave is preceded by a pre-bomb on the target's cluster, in the same pass", async () => {
    const h = await warFixture({ bombPush: true });
    expect(h.until(() => h.log.some((l) => / ATTACK R /.test(l)), 60)).toBe(true);
    const iBomb = h.log.findIndex((l) => l.includes("BOMB push R"));
    const iAtk = h.log.findIndex((l) => / ATTACK R /.test(l));
    expect(iBomb).toBeGreaterThanOrEqual(0);
    expect(iBomb).toBeLessThan(iAtk); // the bomb goes IMMEDIATELY before the wave
    expect(tickOf(h.log[iBomb])).toBe(tickOf(h.log[iAtk])); // same wars pass
    expect(h.log.some((l) => /BOMB Atom Bomb at 10[08],1[01][08]/.test(l))).toBe(true); // on the pair, not elsewhere
    expect(h.bot.fired.get("bombPush")).toBeGreaterThanOrEqual(1);
  });

  test("off: the same wave goes without a bomb; the plain bot bombs ~140 ticks later on its own cadence", async () => {
    const h = await warFixture({});
    expect(h.until(() => h.log.some((l) => / ATTACK R /.test(l)), 60)).toBe(true);
    expect(h.log.some((l) => l.includes("BOMB"))).toBe(false); // no bomb with the wave
    expect(h.until(() => h.log.some((l) => /BOMB Atom Bomb/.test(l)), 400)).toBe(true); // maybeBomb, once bombEvery passes
    const tAtk = tickOf(h.log.find((l) => / ATTACK R /.test(l))!);
    const tBomb = tickOf(h.log.find((l) => /BOMB Atom Bomb/.test(l))!);
    expect(tBomb - tAtk).toBeGreaterThanOrEqual(120);
    expect(h.log.some((l) => l.includes("BOMB push"))).toBe(false);
    expect(h.bot.fired.get("bombPush")).toBeUndefined();
  });

  test("on: a NEW enemy silo draws a counter-silo bomb within bombSiloTicks", async () => {
    const h = await watchFixture({ bombPush: true });
    expect(h.log.some((l) => l.includes("BOMB"))).toBe(false); // nothing to bomb yet (no war, no new silo)
    h.rival("R").buildUnit(UnitType.MissileSilo, h.game.ref(100, 110), {});
    const built = h.game.ticks();
    expect(h.until(() => h.log.some((l) => l.includes("BOMB silo-kill R")), 600)).toBe(true);
    expect(h.log.some((l) => /NEW SILO R at 100,110/.test(l))).toBe(true);
    expect(h.log.some((l) => /BOMB Atom Bomb at 100,110/.test(l))).toBe(true); // the launcher itself
    const tKill = tickOf(h.log.find((l) => l.includes("BOMB silo-kill R"))!);
    expect(tKill - built).toBeLessThanOrEqual(600); // bombSiloTicks
    expect(h.bot.fired.get("bombPush")).toBeGreaterThanOrEqual(1);
  });

  test("off: the same new silo is never bombed (it is nobody's bomb enemy)", async () => {
    const h = await watchFixture({});
    h.rival("R").buildUnit(UnitType.MissileSilo, h.game.ref(100, 110), {});
    h.step(650);
    expect(h.log.some((l) => l.includes("BOMB"))).toBe(false);
    expect(h.log.some((l) => l.includes("NEW SILO"))).toBe(false);
  });
});
