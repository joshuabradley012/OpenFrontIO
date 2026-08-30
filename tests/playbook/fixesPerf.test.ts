// Package "fixes + perf" (docs/PlaybookBotPlan.md): the border-only split watch must find the same pieces as the
// old flood fill; reachable() must not blacklist a target whose wave was cancelled or that we simply won against;
// a lapse we planned leaves trust alone; a failed renewal gift is retried; a MIRV never aims under a SAM.
import { describe, expect, test } from "vitest";
import { Military } from "../../src/core/execution/playbook/Military";
import { Game, Player, PlayerType } from "../../src/core/game/Game";
import { TileRef } from "../../src/core/game/GameMap";
import { PseudoRandom } from "../../src/core/PseudoRandom";
import { conquerRect, playbookSetup } from "../util/PlaybookSetup";

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
