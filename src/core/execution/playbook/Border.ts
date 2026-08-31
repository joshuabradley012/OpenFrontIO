// Border snapshot, memoised per player on tileChangeVersion. A player's border set (content AND
// insertion order) changes only when that player's own tiles change: membership of tile t is
// "t is ours and a neighbour is not", so a third player's conquest elsewhere cannot move it —
// and every own-tile change bumps tileChangeVersion (GameImpl.conquer/relinquish). Iterating the
// cached array replaces the TileSet.values() generator, which alone was ~10 % of a long headless
// game across the bot's border walks; the array is also reused for whole windows between fights.
// Read-only: callers must copy before mutating (filter/map already do).
import { Player } from "../../game/Game";
import { TileRef } from "../../game/GameMap";

const cache = new WeakMap<Player, { version: number; tiles: TileRef[] }>();

export function borderOf(p: Player): readonly TileRef[] {
  const version = p.tileChangeVersion();
  const c = cache.get(p);
  if (c !== undefined && c.version === version) return c.tiles;
  const tiles: TileRef[] = [];
  p.borderTiles().forEach((t) => tiles.push(t));
  cache.set(p, { version, tiles });
  return tiles;
}
