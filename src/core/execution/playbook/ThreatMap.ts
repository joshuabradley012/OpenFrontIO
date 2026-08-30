// ThreatMap (`threatMap`, review opportunity #5): an influence map over our border instead of one scalar per rival.
//
// The 50-tick border pass in Rivals.sample() already walks every border tile and its neighbours; with the flag on it
// also buckets the tiles into 16 × 16 cells and hands each (cell, rival) bucket here as a *segment*. Per segment:
//   theirs   = rival troops × (their tiles touching the segment / their total border) × decay(distance from their centre)
//              decay is flat-then-steep, 1 − (d / R)^4 with R = 150 tiles: a rival's army is at its border, not at its
//              far coast, so a segment 150+ tiles from their bounding-box centre feels nothing
//   ours     = our troops × (segment tiles / our border tiles) × (1 + POST_BONUS per post whose range covers the segment)
//   influence = ours − theirs, tension = ours + theirs, vulnerability = tension − |influence| (= 2 × min(ours, theirs):
//   contested and nobody dominant)
// Per rival: maxThreat = max(theirs − ours) over its segments, vulnerability = Σ over its segments, and busyElsewhere =
// share of the rival's own border that faces a third party attacking it or under attack by it (the "dogpile" signal:
// a rival whose army is committed on its other borders is the one to hit).
// Cost: one pass over our border (shared with Rivals) plus one over each unfriendly rival's border, every 50 ticks.

import { Player, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { calculateTerritoryCenter } from "../Util";
import { BotContext } from "./Context";

export const CELL = 16; // tiles per bucket side
export const DECAY_R = 150; // tiles from the rival's centre at which its pressure reaches zero
const POST_BONUS = 1.0; // a post makes defending ~5× cheaper (Config.defensePostDefenseBonus); as a pressure multiplier one post doubles ours, two triple it (capped)

export interface Segment {
  rival: Player;
  cell: number; // (y >> 4) × cellsW + (x >> 4)
  tiles: number; // our border tiles in the cell that touch the rival
  theirTiles: number; // rival tiles adjacent to those
  centre: TileRef; // the segment tile nearest its mean position
  theirs: number;
  ours: number;
  influence: number;
  tension: number;
  vulnerability: number;
}

/** One bucket as filled by the border pass. */
export interface Bucket {
  cell: number;
  ownerID: number;
  tiles: number;
  theirTiles: number;
  sx: number;
  sy: number;
  members: TileRef[];
}

export class ThreatMap {
  segments: Segment[] = [];
  private byRival = new Map<Player, Segment[]>();
  private busy = new Map<Player, number>();
  private hottest_: Segment | null = null;
  /** Σ over unfriendly rivals' segments of max(0, theirs − ours): the pressure nobody at home answers. */
  undefended = 0;
  tick = -1e9;

  constructor(private ctx: BotContext) {}

  /** Rebuild from the border pass. `buckets` are keyed by owner smallID × 2^20 + cell; `ourBorder` = our border tile count. */
  compute(buckets: Iterable<Bucket>, watched: Player[], ourBorder: number, ourTroops: number): void {
    const mg = this.ctx.mg, me = this.ctx.me;
    this.tick = mg.ticks();
    const byID = new Map<number, Player>();
    for (const p of watched) byID.set(p.smallID(), p);
    const posts = me.units(UnitType.DefensePost).map((u) => u.tile());
    const range = mg.config().defensePostRange();
    const centre = new Map<Player, TileRef | null>();
    const theirBorder = new Map<Player, number>();
    this.segments = []; this.byRival.clear(); this.busy.clear(); this.hottest_ = null; this.undefended = 0;
    for (const b of buckets) {
      const r = byID.get(b.ownerID);
      if (!r || b.tiles === 0) continue;
      if (!centre.has(r)) { centre.set(r, calculateTerritoryCenter(mg, r)); theirBorder.set(r, r.borderTiles().size); }
      const mx = b.sx / b.tiles, my = b.sy / b.tiles;
      let seg = b.members[0], best = 1e18;
      for (const t of b.members) { const d = (mg.x(t) - mx) ** 2 + (mg.y(t) - my) ** 2; if (d < best) { best = d; seg = t; } }
      const c = centre.get(r) ?? null;
      const d = c === null ? 0 : Math.abs(mg.x(c) - mx) + Math.abs(mg.y(c) - my);
      const decay = Math.max(0, 1 - (d / DECAY_R) ** 4);
      const theirs = r.troops() * Math.min(1, b.theirTiles / Math.max(1, theirBorder.get(r) ?? 1)) * decay;
      let covering = 0;
      for (const pt of posts) if (Math.abs(mg.x(pt) - mx) + Math.abs(mg.y(pt) - my) <= range) covering++;
      const ours = ourTroops * (b.tiles / Math.max(1, ourBorder)) * (1 + POST_BONUS * Math.min(2, covering));
      const influence = ours - theirs, tension = ours + theirs;
      const s: Segment = { rival: r, cell: b.cell, tiles: b.tiles, theirTiles: b.theirTiles, centre: seg, theirs, ours, influence, tension, vulnerability: tension - Math.abs(influence) };
      this.segments.push(s);
      let list = this.byRival.get(r);
      if (!list) { list = []; this.byRival.set(r, list); }
      list.push(s);
      if (!me.isFriendly(r)) {
        this.undefended += Math.max(0, theirs - ours);
        if (this.hottest_ === null || theirs - ours > this.hottest_.theirs - this.hottest_.ours) this.hottest_ = s;
      }
    }
    for (const r of this.byRival.keys()) if (!me.isFriendly(r)) this.busy.set(r, this.busyShare(r));
  }

  /** Share of `r`'s border facing living third parties it is at war with (they attack it, or it attacks them), us excluded. */
  private busyShare(r: Player): number {
    const mg = this.ctx.mg, me = this.ctx.me;
    const enemies = new Set<number>();
    for (const a of r.incomingAttacks()) if (a.attacker() !== me) enemies.add(a.attacker().smallID());
    for (const a of r.outgoingAttacks()) { const t = a.target(); if (t.isPlayer() && t !== me) enemies.add((t as Player).smallID()); }
    if (enemies.size === 0) return 0;
    let total = 0, facing = 0;
    for (const t of r.borderTiles()) {
      total++;
      for (const nb of mg.neighbors(t)) { if (enemies.has(mg.ownerID(nb))) { facing++; break; } }
    }
    return total === 0 ? 0 : facing / total;
  }

  // ---------------------------------------------------------------- queries
  /** The segment with the largest theirs − ours over unfriendly rivals. */
  hottest(): Segment | null { return this.hottest_; }
  segmentsOf(r: Player): Segment[] { return this.byRival.get(r) ?? []; }
  /** max(theirs − ours) over `r`'s segments (−∞ → 0 when none). */
  maxThreat(r: Player): number {
    let m = -Infinity;
    for (const s of this.segmentsOf(r)) if (s.theirs - s.ours > m) m = s.theirs - s.ours;
    return m === -Infinity ? 0 : m;
  }
  /** Σ vulnerability over `r`'s segments. */
  vulnerability(r: Player): number {
    let v = 0;
    for (const s of this.segmentsOf(r)) v += s.vulnerability;
    return v;
  }
  busyElsewhere(r: Player): number { return this.busy.get(r) ?? 0; }
  /** The border tile at the centre of `r`'s hottest segment; null when no segment faces it. */
  postTileFor(r: Player): TileRef | null {
    let best: Segment | null = null;
    for (const s of this.segmentsOf(r)) if (best === null || s.theirs - s.ours > best.theirs - best.ours) best = s;
    return best === null ? null : best.centre;
  }
  /** `r` has a segment where their pressure exceeds `ratio` × ours by at least `min` troops (the pre-position trigger;
   *  the floor keeps a 3k nation at 0:30 from earning a post). */
  exposedTo(r: Player, ratio: number, min = 0): Segment | null {
    for (const s of this.segmentsOf(r)) if (s.theirs > s.ours * ratio && s.theirs - s.ours >= min && s.theirs > 0) return s;
    return null;
  }
  /** The `THREAT` log line: top 3 segments and each rival's busyElsewhere. */
  summary(): string {
    const top = [...this.segments].sort((a, b) => b.theirs - b.ours - (a.theirs - a.ours)).slice(0, 3);
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    const segs = top.map((s) => `${s.rival.name()}@${this.ctx.mg.x(s.centre)},${this.ctx.mg.y(s.centre)} ${k(s.theirs)}/${k(s.ours)}`).join("; ");
    const busy = [...this.busy].filter(([, v]) => v > 0).map(([r, v]) => `${r.name()} ${(v * 100).toFixed(0)}%`).join(", ");
    return `THREAT ${this.segments.length} segs: ${segs || "none"}${busy ? ` | busy: ${busy}` : ""}`;
  }
}
