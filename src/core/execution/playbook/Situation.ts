// Situation: the per-tick picture every rule reads (built by PlaybookBotExecution.readSituation) and the
// stateless-ish queries about the map and our neighbours that several modules share.

import { Attack, Player, PlayerType, TerraNullius, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { BotContext } from "./Context";
import { PlaybookParams } from "./Params";
import { RivalView, Rivals } from "./Rivals";

export type Phase = "opening" | "consolidate" | "war" | "endgame";
/** The timed rules' gate: `before` ticks (3000 = 5:00) before the clock the params assume the game ends at
 *  (clockTicks, 18000 for the 30-minute public game). Never true in an open-ended game (clockTicks 0): the
 *  25:00 posture — endgame phase, nothing bought, a second war at cap — used to freeze for the remaining
 *  145 minutes of a MIN=full lab game. */
export function onTheClock(p: PlaybookParams, tick: number, before = 3000): boolean {
  return p.clockTicks > 0 && tick >= p.clockTicks - before;
}
export interface Neighbours { bots: Player[]; rivals: Player[]; friends: Player[]; wilderness: boolean }

/** One evaluated picture of the game per tick; every rule reads this instead of re-deriving state. */
export interface Situation {
  tick: number; troops: number; cap: number; capShare: number; reserve: number; spendable: number;
  gold: bigint; bots: Player[]; rivals: Player[]; friends: Player[]; wilderness: boolean;
  incoming: Attack[]; incomingBots: number; outgoing: Attack[]; tribeAttacks: number; boats: number;
  collapsed: Player[]; expiring: Player[]; hold: Player | null;
  share: number; threats: Player[]; mode: "grow" | "hold" | "push";
  // B2: the phase of the game we are in and what we know about each non-bot neighbour (exposure only until C1)
  phase: Phase;
  rival: Map<Player, RivalView>;
  /** `webDefense`: the border web (SituationQueries.web) — null with the flag off, after webUntil, or when none qualifies. */
  web: { members: Player[]; send: number } | null;
}

export class SituationQueries {
  readonly rivals: Rivals;
  constructor(private ctx: BotContext) {
    this.rivals = new Rivals(ctx);
  }

  // ---------------------------------------------------------------- phase
  private lastPhase: Phase | null = null;
  private freeLandCache = { tick: -1e9, ok: true };
  private rankCache = { tick: -1e9, endgame: false };
  /** Fills `sit.phase` and `sit.rival`; the last step of readSituation. Logs every phase change. */
  enrich(sit: Situation): void {
    this.enrichRivals(sit);
    this.enrichPhase(sit);
  }
  /** Fills `sit.rival` (readSituation calls this before the phase, which reads spendable). */
  enrichRivals(sit: Situation): void {
    sit.rival = this.rivals.update(sit);
  }
  /** Fills `sit.phase` from the finished situation. */
  enrichPhase(sit: Situation): void {
    sit.phase = this.phase(sit);
    if (sit.phase !== this.lastPhase) {
      if (this.lastPhase !== null) this.ctx.log(`t${sit.tick} phase ${this.lastPhase} → ${sit.phase}`);
      this.lastPhase = sit.phase;
    }
  }
  /** opening while free land is reachable; endgame from clockTicks − 3000 (25:00) or when top-3 and an unfriendly silo exists; war when a
   *  war is affordable (Military.fight's test) or troops ≥ fightAbove·cap (fight() proceeds from there); else consolidate. */
  private phase(sit: Situation): Phase {
    const p = this.ctx.p;
    if (onTheClock(p, sit.tick) || this.endgameThreat(sit.tick)) return "endgame";
    if (sit.wilderness || this.freeLandReachable(sit.tick)) return "opening";
    const affordable = sit.tick >= p.fightNotBeforeTick && sit.rivals.some((r) => r.troops() * p.fightRatio + 1000 <= sit.spendable * p.fightMaxShare);
    if (affordable || sit.troops >= sit.cap * p.fightAbove) return "war";
    return "consolidate";
  }
  /** `takeFallout`: unowned, irradiated land tiles next to our border (every 3rd border tile sampled, refreshed every 100 ticks). */
  private falloutCache = { tick: -1e9, n: 0 };
  falloutBordering(tick: number): number {
    if (tick - this.falloutCache.tick < 100) return this.falloutCache.n;
    const mg = this.ctx.mg;
    let n = 0, i = 0;
    for (const t of this.ctx.me.borderTiles()) {
      if ((i++ % 3) !== 0) continue;
      for (const nb of mg.neighbors(t)) if (mg.isLand(nb) && !mg.hasOwner(nb) && mg.hasFallout(nb)) { n++; break; }
    }
    this.falloutCache = { tick, n };
    return n;
  }
  /** Unowned, fallout-free land on our own landmass (flood fill capped at 4000 tiles, refreshed every 100 ticks). */
  freeLandReachable(tick: number): boolean {
    if (tick - this.freeLandCache.tick < 100) return this.freeLandCache.ok;
    const mg = this.ctx.mg;
    let ok = false;
    for (const t of this.landmassTiles(4000)) { if (!mg.hasOwner(t) && !mg.hasFallout(t)) { ok = true; break; } }
    this.freeLandCache = { tick, ok };
    return ok;
  }
  /** rank ≤ 3 by land among non-bots and an unfriendly, living non-bot owns a missile silo (refreshed every 100 ticks). */
  private endgameThreat(tick: number): boolean {
    if (tick - this.rankCache.tick < 100) return this.rankCache.endgame;
    const me = this.ctx.me;
    let above = 0, silo = false;
    for (const o of this.ctx.mg.players()) {
      if (o === me || !o.isAlive() || o.type() === PlayerType.Bot) continue;
      if (o.numTilesOwned() > me.numTilesOwned()) above++;
      if (!silo && !me.isFriendly(o) && o.units(UnitType.MissileSilo).length > 0) silo = true;
    }
    this.rankCache = { tick, endgame: above < 3 && silo };
    return this.rankCache.endgame;
  }

  // ---------------------------------------------------------------- helpers
  // me.nearby() walks every border tile (thousands late-game) and was ~28 % of a 20-minute lab game
  // (profiled 2026-08-29): readSituation() asks every tick and the rules ask up to five more times. The
  // set of neighbouring players is memoised for `nearbyEvery` ticks. The friend/rival split is memoised per
  // tick (alliances change between ticks, never inside one: every rule of a tick sees the same split), so the
  // 8–12 calls of an active tick share one pass. nearbyEvery = 1 keeps the bot's decisions bit-identical to
  // the uncached code (golden test); larger values are a lab flag until A/B-ed.
  private nearbyCache: { tick: number; players: (Player | TerraNullius)[] } | null = null;
  private splitCache: { tick: number; nb: Neighbours } | null = null;
  private nearby(): (Player | TerraNullius)[] {
    const t = this.ctx.mg.ticks(), every = Math.max(1, this.ctx.p.nearbyEvery);
    if (this.nearbyCache === null || t - this.nearbyCache.tick >= every) { this.nearbyCache = { tick: t, players: this.ctx.me.nearby() }; this.splitCache = null; }
    return this.nearbyCache.players;
  }
  /** Callers get fresh arrays: several of them sort or filter the lists in place. */
  neighbours(): Neighbours {
    const players = this.nearby(), t = this.ctx.mg.ticks();
    if (this.splitCache === null || this.splitCache.tick !== t) {
      const bots: Player[] = [], rivals: Player[] = [], friends: Player[] = [];
      let wilderness = false;
      for (const n of players) {
        if (!n.isPlayer()) { wilderness = true; continue; }
        if (n.type() === PlayerType.Bot) bots.push(n);
        else if (this.ctx.me.isFriendly(n)) friends.push(n);
        else rivals.push(n);
      }
      this.splitCache = { tick: t, nb: { bots, rivals, friends, wilderness } };
    }
    const c = this.splitCache.nb;
    return { bots: c.bots.slice(), rivals: c.rivals.slice(), friends: c.friends.slice(), wilderness: c.wilderness };
  }
  /** acceptAlliances() turns a rival into a friend inside the tick: the split is redone on the next call. */
  invalidateNeighbours(): void {
    this.splitCache = null;
  }
  /** Every 300 ticks: forget what is kept about dead players. */
  prune(): void {
    for (const p of this.annexCache.keys()) if (!p.isAlive()) this.annexCache.delete(p);
    this.rivals.prune();
  }
  cap(): number {
    return this.ctx.mg.config().maxTroops(this.ctx.me);
  }
  outgoingTo(target: Player): Attack | undefined {
    return this.ctx.me.outgoingAttacks().find((a) => a.target() === target);
  }
  density(p: Player): number {
    return p.numTilesOwned() > 0 ? p.troops() / p.numTilesOwned() : 1e9;
  }

  // ---------------------------------------------------------------- annexation
  private annexCache = new Map<Player, { tick: number; ok: boolean; old: boolean }>();
  /** A neighbour we could annex by encirclement: no ocean coast, no map edge, and we already hold at least
   *  40 % of its border. Such a neighbour must never be an ally (an ally's cluster never flips).
   *  `annexWars`: the border is sampled (every third tile) and each sample classed as ours-adjacent, coast-or-edge
   *  (ocean shore, map edge, or a lake-only shore) or other (touching a third party or unowned land). Annexable =
   *  ours-adjacent ≥ 40 % and other ≤ 15 % of the samples and smaller than us — a coastal player whose land side
   *  we hold can be annexed; the old rule refused it on its first shore tile. The test is geometry only: the
   *  consumers apply "not our ally" (warPick's rivals, Diplomacy's request/accept lists are unfriendly by
   *  construction) and manageExpiries reads it for an ally on purpose, to let that alliance lapse. */
  annexable(p: Player): boolean {
    const c = this.annexCache.get(p);
    if (c && this.ctx.mg.ticks() - c.tick < 100) return c.ok;
    const mg = this.ctx.mg, me = this.ctx.me;
    let ok = true, ours = 0, n = 0, i = 0;
    if (this.ctx.p.annexWars) {
      let other = 0, anyCoast = false;
      for (const t of p.borderTiles()) {
        if (mg.isOceanShore(t) || mg.isOnEdgeOfMap(t)) anyCoast = true;
        if ((i++ % 3) !== 0) continue;
        n++;
        let mine = false, third = false;
        for (const nb of mg.neighbors(t)) { const o = mg.owner(nb); if (o === me) { mine = true; break; } if (o !== p && mg.isLand(nb)) third = true; }
        if (mine) ours++; else if (third) other++; // else: coast, map edge or a lake shore — nobody can reinforce through it
      }
      const smaller = p.numTilesOwned() < me.numTilesOwned();
      ok = n > 0 && ours / n >= 0.4 && other / n <= 0.15 && smaller;
      const old = !anyCoast && n > 0 && ours / n >= 0.4 && smaller;
      this.annexCache.set(p, { tick: mg.ticks(), ok, old });
      if (ok && !(c && c.ok)) this.ctx.log(`t${mg.ticks()} ANNEX target ${p.name()} ${p.numTilesOwned()}t (${Math.round((100 * ours) / n)} % of its border is ours, ${Math.round((100 * other) / n)} % faces others${anyCoast ? ", coastal" : ""})`);
      return ok;
    }
    for (const t of p.borderTiles()) {
      if (mg.isOceanShore(t) || mg.isOnEdgeOfMap(t)) { ok = false; break; }
      if ((i++ % 3) !== 0) continue;
      n++;
      for (const nb of mg.neighbors(t)) { if (mg.owner(nb) === me) { ours++; break; } }
    }
    ok = ok && n > 0 && ours / n >= 0.4 && p.numTilesOwned() < me.numTilesOwned();
    this.annexCache.set(p, { tick: mg.ticks(), ok, old: ok });
    if (ok && !(c && c.ok)) this.ctx.log(`t${mg.ticks()} ANNEX target ${p.name()} ${p.numTilesOwned()}t (${Math.round((100 * ours) / n)} % of its border is ours)`);
    return ok;
  }
  /** `annexWars` liveness: annexable(p) differs from what the flag-off rule would say (read after annexable(p)). */
  annexableChanged(p: Player): boolean {
    const c = this.annexCache.get(p);
    return c !== undefined && c.ok !== c.old;
  }

  // ---------------------------------------------------------------- landmass and water
  landmassSize(limit: number): number {
    return this.landmassTiles(limit).size;
  }
  landmassTiles(limit: number): Set<TileRef> {
    const start = this.ctx.me.borderTiles().values().next().value as TileRef | undefined;
    const seen = new Set<TileRef>();
    if (start === undefined) return seen;
    seen.add(start);
    const stack = [start];
    while (stack.length > 0 && seen.size < limit) {
      const t = stack.pop()!;
      this.ctx.mg.forEachNeighbor(t, (n) => { if (!seen.has(n) && this.ctx.mg.isLand(n)) { seen.add(n); stack.push(n); } });
    }
    return seen;
  }

  /** True when no land path from `t` reaches our territory (flood fill capped at `cap` tiles). */
  acrossWater(t: TileRef, cap = 4000): boolean {
    const me = this.ctx.me;
    const seen = new Set<TileRef>([t]);
    const q: TileRef[] = [t];
    while (q.length > 0 && seen.size < cap) {
      const c = q.pop()!;
      if (this.ctx.mg.owner(c) === me) return false;
      for (const n of this.ctx.mg.neighbors(c)) { if (!this.ctx.mg.isLand(n) || seen.has(n)) continue; seen.add(n); q.push(n); }
    }
    return true;
  }

  /** `boatsNearest`: acrossWater for a candidate `d` tiles from our nearest shore. acrossWater is a depth-first fill
   *  that gives up at `cap` tiles, so on a large landmass it wanders off and calls a tile fourteen tiles up our own
   *  coast "across water". This one is breadth-first inside a manhattan radius of 2 × d + 20 around `t` (capped at
   *  `cap` tiles): a land path to us that short is found, a longer one is a boat's job anyway. */
  acrossWaterNear(t: TileRef, d: number, cap = 4000): boolean {
    const me = this.ctx.me, mg = this.ctx.mg, radius = 2 * d + 20;
    const seen = new Set<TileRef>([t]);
    const q: TileRef[] = [t];
    let i = 0;
    while (i < q.length && seen.size < cap) {
      const c = q[i++];
      if (mg.owner(c) === me) return false;
      for (const n of mg.neighbors(c)) { if (seen.has(n) || !mg.isLand(n) || mg.manhattanDist(n, t) > radius) continue; seen.add(n); q.push(n); }
    }
    return true;
  }

  // ---------------------------------------------------------------- border web (`webDefense`)
  private webCache: { tick: number; web: { members: Player[]; send: number } | null } = { tick: -1e9, web: null };
  private lastWebLog = -1e9;
  /** `webDefense` (loss cluster 4, the alliance-web rush): before webUntil, ≥ 2 of our non-ally neighbours who are
   *  allied WITH EACH OTHER and whose combined nation-rule sendable troops (RivalView.nationWouldSend, what trustWars
   *  already computes) exceed webRatio × our troops. Returns the qualifying cluster with the largest combined
   *  sendable, members sorted strongest-sender-first; recomputed on the 10-tick cadence the rival view runs on.
   *  Logged `WEB <names> could send …k` (rate-limited). */
  web(sit: Situation): { members: Player[]; send: number } | null {
    const p = this.ctx.p;
    if (!p.webDefense || sit.tick >= p.webUntil) return null;
    if (sit.tick % 10 !== 0 && sit.tick - this.webCache.tick < 10) return this.webCache.web;
    const send = (r: Player) => sit.rival.get(r)?.nationWouldSend ?? 0;
    // connected components of the "allied with each other" graph over our unfriendly neighbours
    const left = new Set(sit.rivals);
    let best: { members: Player[]; send: number } | null = null;
    for (const r of sit.rivals) {
      if (!left.has(r)) continue;
      left.delete(r);
      const club = [r];
      for (let i = 0; i < club.length; i++) for (const o of left) if (club[i].isAlliedWith(o)) { left.delete(o); club.push(o); }
      if (club.length < 2) continue;
      const total = club.reduce((s, m) => s + send(m), 0);
      if (best === null || total > best.send) best = { members: club, send: total };
    }
    if (best !== null && best.send > sit.troops * p.webRatio) best.members.sort((a, b) => send(b) - send(a) || b.troops() - a.troops());
    else best = null;
    this.webCache = { tick: sit.tick, web: best };
    if (best !== null && sit.tick - this.lastWebLog >= 600) { this.lastWebLog = sit.tick; this.ctx.log(`t${sit.tick} WEB ${best.members.map((m) => m.name()).join("+")} could send ${Math.round(best.send / 1000)}k at our ${Math.round(sit.troops / 1000)}k`); }
    return best;
  }

  // ---------------------------------------------------------------- defence posts
  postFacing(r: Player): boolean {
    const rid = r.smallID();
    for (const dp of this.ctx.me.units(UnitType.DefensePost)) {
      let touches = false;
      // cheap check: any tile of r within 30 manhattan of the post along a sampled ring
      const x = this.ctx.mg.x(dp.tile()), y = this.ctx.mg.y(dp.tile());
      for (let dy = -30; dy <= 30 && !touches; dy += 6) for (let dx = -30; dx <= 30; dx += 6) {
        if (!this.ctx.mg.isValidCoord(x + dx, y + dy)) continue;
        if (this.ctx.mg.ownerID(this.ctx.mg.ref(x + dx, y + dy)) === rid) { touches = true; break; }
      }
      if (touches) return true;
    }
    return false;
  }
}
