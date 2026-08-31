// Package "fixes + perf" (docs/PlaybookBotPlan.md): the border-only split watch must find the same pieces as the
// old flood fill; reachable() must not blacklist a target whose wave was cancelled or that we simply won against;
// a lapse we planned leaves trust alone; a failed renewal gift is retried; a MIRV never aims under a SAM.
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Game, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { PseudoRandom } from "../../src/core/PseudoRandom";
import { conquerRect, PlaybookHarness, playbookSetup, PRE_COMBO, Rect } from "../util/PlaybookSetup";

/** The flood fill watchSplit used before: 4-connected pieces from every border tile, interior included. */
function floodPieces(mg: Game, me: Player): { tiles: number; border: Set<TileRef> }[] {
  const seen = new Set<TileRef>();
  const out: { tiles: number; border: Set<TileRef> }[] = [];
  const border = me.borderTiles();
  for (const t of border) {
    if (seen.has(t)) continue;
    const piece = { tiles: 0, border: new Set<TileRef>() };
    const q = [t];
    seen.add(t);
    while (q.length > 0) {
      const c = q.pop()!;
      piece.tiles++;
      if (border.has(c)) piece.border.add(c);
      for (const n of mg.neighbors(c)) {
        if (seen.has(n) || mg.owner(n) !== me) continue;
        seen.add(n);
        q.push(n);
      }
    }
    out.push(piece);
  }
  return out;
}

function same(mg: Game, me: Player) {
  const key = (p: { tiles: number; border: Iterable<TileRef> }) => [p.tiles, Math.min(...p.border)] as const; // pieces of equal size: by first border tile
  const cmp = (x: { tiles: number; border: Iterable<TileRef> }, y: { tiles: number; border: Iterable<TileRef> }) => { const [xt, xb] = key(x), [yt, yb] = key(y); return yt - xt || xb - yb; };
  const a = floodPieces(mg, me).sort(cmp);
  const b = Military.pieces(mg, me).sort(cmp);
  expect(b.map((p) => p.tiles)).toEqual(a.map((p) => p.tiles));
  expect(b.map((p) => p.tiles).reduce((s, n) => s + n, 0)).toBe(me.numTilesOwned());
  for (let i = 0; i < a.length; i++) expect(new Set(b[i].border)).toEqual(a[i].border);
  return b.length;
}

describe("watchSplit: pieces from the border alone equal the flood fill", () => {
  test("two rectangles, a diagonal touch, an enclave, a lake, a wall-to-wall band", async () => {
    const h = await playbookSetup({ spawn: [10, 10], rivals: [{ name: "E", type: PlayerType.Human, at: [90, 90] }] });
    const mg = h.game, me = h.me, w = mg.width(), hh = mg.height();
    const clear = () => { for (const t of [...me.tiles()]) h.rival("E").conquer(t); };
    clear();
    conquerRect(mg, me, [5, 5, 30, 30]);
    conquerRect(mg, me, [50, 50, 70, 60]);
    expect(same(mg, me)).toBe(2);
    conquerRect(mg, me, [31, 31, 45, 45]); // corner to corner: 8-connected, not 4-connected
    expect(same(mg, me)).toBe(3);
    conquerRect(mg, me, [30, 20, 31, 32]); // a bridge
    expect(same(mg, me)).toBe(2);
    conquerRect(mg, h.rival("E"), [12, 12, 18, 18]); // an enemy enclave: its ring is not a piece
    expect(same(mg, me)).toBe(2);
    conquerRect(mg, me, [0, 70, w - 1, 75]); // wall to wall: the edge tiles are not border tiles
    expect(same(mg, me)).toBe(3);
    conquerRect(mg, me, [0, 0, w - 1, 2]); // the top rows, fully owned
    expect(same(mg, me)).toBe(4);
    conquerRect(mg, me, [0, 0, 4, hh - 1]); // the left column joins the top rows and the band
    expect(same(mg, me)).toBe(2);
  });

  test("lakes and coast on ocean_and_land", async () => {
    const h = await playbookSetup({ map: "ocean_and_land", spawn: [10, 10] });
    const mg = h.game, me = h.me;
    conquerRect(mg, me, [0, 0, mg.width() - 1, Math.floor(mg.height() / 2)]);
    expect(same(mg, me)).toBeGreaterThanOrEqual(1);
  });

  test("200 random blobs", async () => {
    const h = await playbookSetup({ spawn: [10, 10], rivals: [{ name: "E", type: PlayerType.Human, at: [90, 90] }] });
    const mg = h.game, me = h.me, e = h.rival("E"), w = mg.width(), hh = mg.height();
    const rnd = new PseudoRandom(7);
    for (let round = 0; round < 200; round++) {
      for (const t of [...me.tiles()]) e.conquer(t);
      const n = rnd.nextInt(1, 8);
      for (let i = 0; i < n; i++) {
        const x0 = rnd.nextInt(0, w - 1), y0 = rnd.nextInt(0, hh - 1);
        const x1 = Math.min(w - 1, x0 + rnd.nextInt(0, 30)), y1 = Math.min(hh - 1, y0 + rnd.nextInt(0, 30));
        conquerRect(mg, rnd.chance(4) ? e : me, [x0, y0, x1, y1]);
      }
      same(mg, me);
    }
  });
});

// ---------------------------------------------------------------- reachable()
const ME: Rect = [30, 25, 70, 57];
const RV: Rect = [30, 58, 70, 90];
const military = (h: PlaybookHarness) => (h.bot as unknown as { military: Military }).military;

describe("reachable(): a vanished wave is not always an unreachable target", () => {
  test("a counter swallowed by a bigger incoming wave leaves the target reachable", async () => {
    const h = await playbookSetup({ spawn: [50, 40], tiles: ME, troops: 100_000, rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 200_000 }] });
    const r = h.rival("R");
    h.attack(r, h.me, 80_000); // the counter is capped at half of home (50k) and cancels out entirely
    h.step(h.nextRuleTick(10)); // counter queued
    h.step(1); // and deleted at init against the bigger wave
    expect(h.log.some((l) => l.includes("COUNTER R"))).toBe(true);
    expect(h.me.outgoingAttacks().some((a) => a.target() === r)).toBe(false);
    h.step(4); // inside the 2–12 tick window
    expect(military(h).reachable(r)).toBe(true);
    expect(h.log.some((l) => l.includes("unreachable"))).toBe(false);
  });

  test("a tribe eaten inside the window is simply gone, not unreachable", async () => {
    const h = await playbookSetup({ spawn: [50, 40], tiles: ME, troops: 100_000, rivals: [{ name: "T", type: PlayerType.Bot, at: [50, 60], troops: 10 }] });
    const t = h.rival("T");
    const keep = [...t.tiles()].slice(0, 3);
    for (const tile of [...t.tiles()]) if (!keep.includes(tile)) h.me.conquer(tile);
    expect(t.numTilesOwned()).toBe(3);
    h.step(h.nextRuleTick(10));
    expect(h.log.some((l) => /bot T /.test(l))).toBe(true);
    expect(h.until(() => !t.isAlive(), 11)).toBe(true);
    expect(military(h).reachable(t)).toBe(true);
    expect(h.log.some((l) => l.includes("unreachable"))).toBe(false);
  });

  test("a wave that dies uncontested without taking a tile blacklists the target for 600 ticks", async () => {
    const h = await playbookSetup({ spawn: [50, 40], tiles: ME, troops: 100_000, rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: RV, troops: 100_000 }] });
    const r = h.rival("R"), mil = military(h);
    h.step(1);
    mil.noteSent(r); // no attack ever ran
    h.step(3);
    expect(mil.reachable(r)).toBe(false);
    expect(h.log.some((l) => /R unreachable: the wave vanished without taking a tile/.test(l))).toBe(true);
    h.step(600);
    expect(mil.reachable(r)).toBe(true);
  });
});

// ---------------------------------------------------------------- alliances on big_plains
const HOME: Partial<PlaybookParams> = { ...PRE_COMBO, expandFree: 0, expandContested: 0, boatAtTick: 1e9, nationAware: false };
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];

async function allied(me: { tiles: Rect; troops: number }, rival: { tiles: Rect; troops: number; type?: PlayerType }) {
  const h = await playbookSetup({
    map: "big_plains", spawn: centre(me.tiles), tiles: me.tiles, troops: me.troops, bot: HOME,
    rivals: [{ name: "R", type: rival.type ?? PlayerType.Nation, at: centre(rival.tiles), tiles: rival.tiles, troops: rival.troops }],
    config: { customAllianceDuration: 1 }, // 600-tick alliances
  });
  const r = h.rival("R");
  h.game.addExecution(new AllianceRequestExecution(r, h.me.id()));
  h.step(2);
  const al = h.me.allianceWith(r);
  expect(al).not.toBeNull();
  return { h, r, expiresAt: al!.expiresAt() };
}
const trustOf = (h: PlaybookHarness, p: Player) => (h.bot as unknown as { q: { rivals: { trust(p: Player): number } } }).q.rivals.trust(p);

describe("trust: a lapse we planned earns the ally nothing", () => {
  test("prey we let lapse keeps its 0.50; an alliance that runs its course still earns +0.1", async () => {
    const prey = await allied({ tiles: [40, 40, 160, 114], troops: 550_000 }, { tiles: [80, 115, 100, 135], troops: 5_000 });
    prey.h.step(prey.expiresAt + 5 - prey.h.game.ticks());
    expect(prey.h.log.some((l) => /let alliance with R lapse/.test(l))).toBe(true);
    expect(prey.h.log.some((l) => /trust R 0\.50 unchanged: we let the alliance lapse/.test(l))).toBe(true);
    expect(trustOf(prey.h, prey.r)).toBe(0.5);
    const kept = await allied({ tiles: [40, 40, 160, 114], troops: 550_000 }, { tiles: [40, 115, 160, 190], troops: 400_000 });
    kept.h.step(kept.expiresAt + 5 - kept.h.game.ticks());
    expect(kept.h.log.some((l) => /let alliance with R lapse/.test(l))).toBe(false);
    expect(kept.h.log.some((l) => /trust R 0\.50 → 0\.60: alliance ran its course/.test(l))).toBe(true);
  });
});

describe("manageExpiries: a renewal gift with no room is retried inside the window", () => {
  test("no gift while the ally sits at its cap, the gift on the next pass once it has room", async () => {
    const { h, r, expiresAt } = await allied({ tiles: [80, 70, 120, 114], troops: 250_000 }, { tiles: [40, 115, 160, 190], troops: 400_000 });
    const cap = h.game.config().maxTroops(r);
    r.setTroops(cap);
    const first = Math.ceil((expiresAt - 300) / 50) * 50; // first expiries pass inside the 300-tick window
    h.step(first + 1 - h.game.ticks());
    expect(h.me.troops()).toBeLessThan(r.troops() * 0.9); // the weaker side: a gift is wanted
    expect(h.log.some((l) => l.includes("gift"))).toBe(false); // no room for it
    r.setTroops(cap - 100_000); // room for the gift, and still the stronger side
    h.step(50);
    expect(h.log.filter((l) => /gift \d+k troops to R before renewal/.test(l))).toHaveLength(1);
    h.step(expiresAt - 1 - h.game.ticks());
    expect(h.log.filter((l) => l.includes("gift"))).toHaveLength(1); // once per alliance, not once per pass
  });
});

// ---------------------------------------------------------------- MIRV under a SAM
describe("maybeMIRV: never under a SAM", () => {
  // the engine's territory centre is the bounding box of the border tiles, and map-edge tiles are not border tiles:
  // the target keeps off the edges so its centre is where it looks
  const CENTRE: [number, number] = [99, 59];
  async function denial(sam: boolean) {
    const h = await playbookSetup({
      map: "big_plains", spawn: [100, 160], tiles: [60, 130, 140, 190], troops: 100_000, bot: HOME,
      rivals: [{ name: "V", type: PlayerType.Human, at: CENTRE, tiles: [5, 5, 194, 114], troops: 100_000 }], // 52 % of the land: victory denial
    });
    const v = h.rival("V");
    h.me.buildUnit(UnitType.MissileSilo, h.game.ref(100, 160), {});
    if (sam) v.buildUnit(UnitType.SAMLauncher, h.game.ref(...CENTRE), {});
    h.step(h.nextRuleTick(100) - 1);
    h.me.addGold(40_000_000n);
    h.step(2);
    const line = h.log.find((l) => l.includes("MIRV V"));
    expect(line).toBeDefined();
    const mirv = h.me.units(UnitType.MIRV)[0];
    expect(mirv).toBeDefined();
    return { h, v, line: line!, target: mirv.targetTile()! };
  }
  test("the territory centre when no SAM covers it", async () => {
    const { h, line, target } = await denial(false);
    expect(line).not.toMatch(/off-centre/);
    expect(h.game.manhattanDist(target, h.game.ref(...CENTRE))).toBeLessThan(3);
  });
  test("shifted to the nearest uncovered tile when the centre is under a SAM", async () => {
    const { h, v, line, target } = await denial(true);
    expect(line).toMatch(/aimed off-centre, the centre is under a SAM/);
    const range = h.game.config().samRange(1) + 5;
    expect(h.game.euclideanDistSquared(target, v.units(UnitType.SAMLauncher)[0].tile())).toBeGreaterThan(range * range);
    expect(h.game.owner(target)).toBe(v);
  });
  test("held when every tile of the target is covered", async () => {
    const h = await playbookSetup({ spawn: [50, 40], tiles: ME, troops: 100_000, rivals: [{ name: "R", type: PlayerType.Nation, at: [50, 75], tiles: [40, 65, 60, 85], troops: 100_000 }] });
    const r = h.rival("R");
    r.buildUnit(UnitType.SAMLauncher, h.game.ref(50, 75), {});
    h.step(1);
    const range = h.game.config().samRange(1) + 5;
    for (const t of r.borderTiles()) expect(h.game.euclideanDistSquared(t, h.game.ref(50, 75))).toBeLessThanOrEqual(range * range);
    const mil = military(h) as unknown as { mirvTile(p: Player, c: TileRef): TileRef | null };
    expect(mil.mirvTile(r, h.game.ref(50, 75))).toBeNull();
  });
});
