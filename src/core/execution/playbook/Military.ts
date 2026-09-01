// Military: expansion, tribe harvesting, counter-attacks, wars and retreats, boats, bombs, MIRV, split watch.

import { borderOf } from "./Border";
import { Attack, Difficulty, Game, Player, PlayerType, Unit, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { ConstructionExecution } from "../ConstructionExecution";
import { MirvExecution } from "../MIRVExecution";
import { MoveWarshipExecution } from "../MoveWarshipExecution";
import { RetreatExecution } from "../RetreatExecution";
import { calculateTerritoryCenter, listNukeBreakAlliance } from "../Util";
import { BotContext, FireLimiter } from "./Context";
import { MirvRisk } from "./MirvRisk";
import { basinContact, onTheClock, SituationQueries } from "./Situation";

const RETREAT_MALUS = 0.75; // AttackExecution.retreat(25) against a player: the share of a recalled wave that gets home
const clamp = (x: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, x));
/** `boatsWaterPath`: the longest water path (tiles the transport sails, Military.waterPath) a boat rule accepts. The
 *  engine paths the ship over water around every coast (TransportShipExecution → WaterPathFinder), often several
 *  times the straight-line distance the rules used to rank by: 45 lab games launched every early boat at tick 60
 *  to an "empty shore" 54–112 tiles straight-line, and tribe/island boats sailed a median 156 tiles (p90 292). */
export const BOAT_MAX_PATH = { early: 80, tribe: 150, sea: 200, finish: 250 } as const;
const WATER_MAX_DIST = Math.max(...Object.values(BOAT_MAX_PATH)); // the fill stops at the longest cap any rule accepts (250)
const WATER_BFS_TILES = 400_000; // ... and at this many water tiles (a 1000-tile coast × 300 sails 300k; a 40k budget starved an 8-minute empire's coast to a 50-tile band)
const WATER_CACHE_TICKS = 100; // the fill is reused by every boat rule of the pass and for this long after
/** `boatsWaterPath`: water-path lengths from our shore, from one breadth-first fill over the water tiles the
 *  engine's transport path uses (GameMap.isWater — ocean and lake alike, shoreline water included), 4-connected.
 *  `dist` holds length + 1 per tile (0 = not reached), a typed array the size of the map reused across fills. */
export class WaterPath {
  size = 0; // water tiles the fill reached
  constructor(private mg: Game, private dist: Uint16Array) {}
  /** Tiles a boat sails from our nearest sampled shore to `t` (a shore tile: its nearest water neighbour + 1; a
   *  water tile: itself); Infinity when no water path inside WATER_MAX_DIST / WATER_BFS_TILES reaches it. */
  len(t: TileRef): number {
    const mg = this.mg, dist = this.dist;
    if (mg.isWater(t)) return dist[t] === 0 ? Infinity : dist[t] - 1;
    let best = Infinity;
    for (const n of mg.neighbors(t)) { if (!mg.isWater(n)) continue; const d = dist[n]; if (d !== 0 && d < best) best = d; } // d = length + 1: the step ashore
    return best;
  }
  /** `boatEscort`: the tiles of the fill's shortest path to `t` — from the first water tile off our shore to the water
   *  tile beside the landing (a water `t`: to `t` itself), in sailing order; null when len(t) is Infinity. */
  path(t: TileRef): TileRef[] | null {
    const mg = this.mg, dist = this.dist;
    let cur: TileRef | null = null;
    if (mg.isWater(t)) { if (dist[t] !== 0) cur = t; }
    else { let best = Infinity; for (const n of mg.neighbors(t)) { if (!mg.isWater(n)) continue; const d = dist[n]; if (d !== 0 && d < best) { best = d; cur = n; } } }
    if (cur === null) return null;
    const out: TileRef[] = [];
    while (cur !== null) {
      out.push(cur);
      const d: number = dist[cur];
      if (d <= 2) break;
      let next: TileRef | null = null;
      for (const n of mg.neighbors(cur)) if (mg.isWater(n) && dist[n] === d - 1) { next = n; break; }
      cur = next;
    }
    out.reverse();
    return out;
  }
}
/** A war fight() would open: the decision half of the old fight(); actWar() is the other half. */
interface WarPick {
  r: Player;
  want: number;
  bomb: boolean; // open the war with a bomb on their cluster (richer, silo — or any target with `bombPush`)
  /** `bombPush`: the bomb is the flag's alone (the plain richer-rule said no) — the liveness marker. */
  pushBomb: boolean;
  opportunity: boolean; // collapsed / gap owner / MIRV threat / annexable: goes at once
  annex: boolean; // `annexWars`: an encircled neighbour taken from most of its border (logged ANNEX WAR)
  /** `multiWar`: a war beside the running ones (the second or third slot). */
  extra: boolean;
}
const MULTI_WAR_SLOTS = 3; // multiWar: wars plus counters running at once
/** One war or tribe wave under per-war accounting (opened at the send, resolved when the attack is gone). */
interface CalibRecord { tick: number; sent: number; tiles0: number; last: number; seen: boolean; retreating: boolean; y: YieldRecord }
/** War accounting (always on, log only unless `warYield`): sampled every YIELD_EVERY ticks from trackCalibration.
 *  `tiles` = the target's tile drops while our attack is its only incoming (attributable to us), `lost` = the
 *  attack's troop delta plus the follow-ups merged into it; `win` keeps the last YIELD_WINDOW samples. */
interface YieldRecord { tick: number; tiles: number; lost: number; tilesAt: number; troopsAt: number; sentAt: number; win: { tiles: number; lost: number }[] }
const YIELD_EVERY = 100; // warYield: ticks between samples of a running war's return
const YIELD_WINDOW = 2; // warYield: samples the running cost is judged on (200 ticks)
const YIELD_MIN_LOST = 1000; // warYield: no verdict on a window that cost fewer troops than this
const YIELD_COST_CAP = 10_000; // warYield: a war that took no tile is remembered at this troops/tile
const YIELD_COOLDOWN = 600; // warYield: ticks a target retreated from for its price is refused by the scorer (unless it becomes an opportunity)
const BOMB_FUND_HORIZON = 900; // bombBudget: a Hydrogen plan stands when its price is within this many ticks of income
const OPENING_NEW_MASS = 1.5; // boatOpening: score multiplier on a candidate shore on a landmass we own no tile of — the second-continent preference (a multiplier, not a veto)
const OPENING_LANDMASS_TILES = 1500; // boatOpening: cap of the bounded flood fill that labels a candidate's landmass (a candidate whose fill never meets us inside it counts as a new landmass)
const OPENING_BASIN_TILES = 8000; // boatOpening: cap of the free-land basin flood behind a candidate landing (radius = boatBasinRadius)
const OPENING_MIN_SAIL = 20; // boatOpening: sail-distance floor in the basin/sail score — a 3-tile hop must not win on division alone
const OPENING_CONTESTED = 1.5; // boatOpening: score boost on a tribe candidate with a rival (nation/human) adjacent — the wilderness near it will be eaten soon anyway, the tribe is ours alone (the tribe-tile coefficient itself is PlaybookParams.boatTribeWorth)
const OPENING_PUSH_TICKS = 600; // boatOpening: how long a recorded opening landing is watched for a tribe having eaten its basin (sail + the wave's fight)
const OPENING_REACH_TILES = 8000; // boatOpening v5: cap of openingCutOff's flood over land no other player owns — big enough to fully enumerate a rival-walled pocket (the escape hatch needs the fill to FINISH to call a basin cut off); a capped fill is treated as land-reachable
const BOMB_PUSH_NEAR = 100; // bombPush: pre-bomb cluster distance unit — a cluster 200 tiles from our shared border needs 2× the value of one within 100
const ESCORT_SWARM_GAP = 10; // boatEscort: ticks between a swarm's boats — the escorts rule's cadence (one launch per pass)
const ESCORT_CORRIDOR_STEP = 4; // boatEscort: every k-th path tile is a corridor sample (a 250-tile path → ~60 tiles × a handful of warships per check)
/** A bomb maybeBomb's value search picked: where, of what type, at whom, and its value per 100k of gold. */
export interface BombPick { tile: TileRef; value: number; type: UnitType; enemy: Player; cost: bigint }

export class Military {
  private currentTarget_: Player | null = null;
  private waves = new Map<Player, { want: number; sent: number; last: number }>();
  private sentAt = new Map<Player, { tick: number; tiles: number; contested: boolean }>();
  private blacklist = new Map<Player, number>();
  public bombs = 0;
  private lastBombTick = -1e9;
  private lastCounter = new Map<Player, number>();
  private embargoedAt_ = new Map<Player, number>();
  private bombed = new Map<TileRef, number>();
  private lim: FireLimiter;

  constructor(
    private ctx: BotContext,
    private q: SituationQueries,
    private plannedTarget: () => Player | null, // Diplomacy.plannedTarget
    private risk: MirvRisk = new MirvRisk(ctx), // the nations' MIRV rules against us (`nationMirvAware` guards)
  ) {
    this.lim = new FireLimiter(ctx);
  }

  /** The player we are at war with (read by Diplomacy and Economy). */
  get currentTarget(): Player | null {
    return this.currentTarget_;
  }
  /** Tick at which we embargoed a war target (read by Diplomacy.manageEmbargoes). */
  get embargoedAt(): Map<Player, number> {
    return this.embargoedAt_;
  }
  /** Consecutive bomb targets out of silo range (read and reset by Economy.build). */
  get bombOutOfRange(): number {
    return this.bombOutOfRange_;
  }
  set bombOutOfRange(n: number) {
    this.bombOutOfRange_ = n;
  }

  // ---------------------------------------------------------------- reachability
  /** Record a first wave we just sent: the target's size, and whether it had a wave on us ours could cancel against. */
  noteSent(target: Player): void { this.sentAt.set(target, { tick: this.ctx.mg.ticks(), tiles: target.numTilesOwned(), contested: this.ctx.me.incomingAttacks().some((a) => a.attacker() === target) }); }
  /** A wave gone 2–12 ticks after it left means the engine dropped it. AttackExecution folds a second land attack
   *  into the running one (so an attack always remains), cancels a wave troop-for-troop against the target's own
   *  wave on us, and retreats one with nothing left to conquer — either because we took everything beside us (the
   *  target shrank or died) or because there never was anything: a neighbour `nearby()` lists only diagonally, or
   *  across a strait. Only that last case — the wave vanished uncontested without taking a tile — marks the target
   *  unreachable for 600 ticks; the old check blacklisted every vanished wave, a won fight and a cancelled counter
   *  included. */
  reachable(target: Player): boolean {
    const t = this.ctx.mg.ticks(), me = this.ctx.me;
    const bl = this.blacklist.get(target);
    if (bl !== undefined && t < bl) return false;
    const s = this.sentAt.get(target);
    if (s !== undefined && t - s.tick >= 2 && t - s.tick < 12 && !this.q.outgoingTo(target)) {
      this.sentAt.delete(target);
      if (s.contested || !target.isAlive() || me.isFriendly(target) || target.numTilesOwned() < s.tiles) return true;
      this.blacklist.set(target, t + 600);
      this.ctx.log(`t${t} ${target.name()} unreachable: the wave vanished without taking a tile`);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- housekeeping
  /** Every 300 ticks: drop entries about dead players, finished attacks and windows that have passed. Each map's
   *  reader treats a missing entry exactly like a stale one, so this changes no decision. `bombed` is kept: a
   *  structure bombed once is never bombed again, by design. */
  prune(): void {
    const t = this.ctx.mg.ticks(), me = this.ctx.me;
    const dead = (p: Player) => !p.isAlive();
    for (const m of [this.waves, this.sentAt, this.blacklist, this.lastCounter, this.embargoedAt_, this.boatedAt, this.history, this.pileInLogged, this.finishedAt, this.bdCountered, this.bdRaced]) for (const p of m.keys()) if (dead(p)) m.delete(p);
    for (const [p, until] of this.blacklist) if (t >= until) this.blacklist.delete(p);
    for (const [p, s] of this.sentAt) if (t - s.tick >= 12) this.sentAt.delete(p); // reachable() only reads it inside 12 ticks
    for (const [p, at] of this.lastCounter) if (t - at >= 300) this.lastCounter.delete(p);
    for (const [p, at] of this.boatedAt) if (t - at >= 900) this.boatedAt.delete(p);
    for (const [p, at] of this.finishedAt) if (t - at >= 600) this.finishedAt.delete(p);
    for (const [p, at] of this.pileInLogged) if (t - at >= 600) this.pileInLogged.delete(p);
    for (const [p, at] of this.embargoedAt_) if (t - at > 1200 && !me.hasEmbargoAgainst(p)) this.embargoedAt_.delete(p);
    const running = new Set(me.outgoingAttacks().map((a) => a.id()));
    for (const id of this.attackStart.keys()) if (!running.has(id)) this.attackStart.delete(id);
    const targets = new Set(me.outgoingAttacks().map((a) => a.target()));
    for (const p of this.waves.keys()) if (!targets.has(p)) this.waves.delete(p); // read only while an attack on that tribe runs
    for (const p of this.counters) if (dead(p)) this.counters.delete(p);
    // `bombPush`: the silo watch prunes itself in-pass; this is the backstop for a flag turned off mid-game
    for (const p of this.siloSeen.keys()) if (dead(p)) this.siloSeen.delete(p);
    this.newSilos = this.newSilos.filter((s) => s.owner.isAlive() && t - s.at < this.ctx.p.bombSiloTicks);
    // `boatDefense`: the rule prunes its own landings in-pass; this is the backstop for a flag turned off mid-game
    for (const [id, s] of this.bdSeen) if (t - s.last >= 200) this.bdSeen.delete(id);
    this.bdLandings = this.bdLandings.filter((l) => t - l.tick < 600 && l.owner.isAlive());
    if (!this.ctx.p.boatDefense) this.bdPostWant = null;
    // `boatEscort`: manageEscorts releases on its own cadence; this is the backstop for a flag turned off mid-game
    this.escorts = this.escorts.filter((e) => e.ship.isActive() && t - e.since < 4 * this.ctx.p.escortDeferTicks);
    this.deferrals = this.deferrals.filter((d) => t - d.since < 2 * this.ctx.p.escortDeferTicks);
    this.swarmQueue = this.swarmQueue.filter((s) => t - s.at < 300);
  }

  // ---------------------------------------------------------------- boatsNearest: measure from where the engine launches
  private shoreCache: { tick: number; shore: TileRef[] } | null = null;
  /** `boatsNearest`: a sample of our ocean-shore border tiles (every k-th, at most 200), cached per tick. The engine
   *  launches a boat from our shore nearest its landing (TransportShipUtils.bestShoreDeploymentSource →
   *  SpatialQuery.closestShoreByWater), so the distance that matters is from the nearest of these — not from the
   *  middle tile of the border list, which the old rules used and which may sit on the far side of the empire. */
  shoreSample(): TileRef[] {
    const t = this.ctx.mg.ticks();
    if (this.shoreCache !== null && this.shoreCache.tick === t) return this.shoreCache.shore;
    const all: TileRef[] = [];
    for (const b of borderOf(this.ctx.me)) if (this.ctx.mg.isOceanShore(b)) all.push(b);
    const step = Math.max(1, Math.ceil(all.length / 200));
    const shore: TileRef[] = [];
    for (let i = 0; i < all.length; i += step) shore.push(all[i]);
    this.shoreCache = { tick: t, shore };
    return shore;
  }
  /** Manhattan distance from `t` to the nearest tile of `sample` (1e9 for an empty sample). */
  nearestShoreDist(t: TileRef, sample: TileRef[] = this.shoreSample()): number {
    const mg = this.ctx.mg, x = mg.x(t), y = mg.y(t);
    let best = 1e9;
    for (const s of sample) { const d = Math.abs(mg.x(s) - x) + Math.abs(mg.y(s) - y); if (d < best) best = d; }
    return best;
  }
  /** `boatsNearest`: the scan window for free shores — around the middle tile as before, or around the whole sampled
   *  coast, so a shore near either end of a long coast is seen at all. */
  private scanBox(sample: TileRef[], fx: number, fy: number, r: number): { x0: number; y0: number; x1: number; y1: number } {
    const mg = this.ctx.mg;
    let x0 = fx, y0 = fy, x1 = fx, y1 = fy;
    if (this.ctx.p.boatsNearest) for (const s of sample) { const x = mg.x(s), y = mg.y(s); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
  }

  // ---------------------------------------------------------------- boatsWaterPath: the distance the ship will sail
  private waterCache: { tick: number; wp: WaterPath } | null = null;
  private waterDist: Uint16Array | null = null; // one map-sized array, cleared per fill
  /** How many fills ran (tests: once per pass, then cached WATER_CACHE_TICKS). */
  waterPathRuns = 0;
  private waterTouched: TileRef[] = [];
  /** `boatsWaterPath`: breadth-first over water from every water neighbour of our sampled shore (shoreSample — the
   *  same tiles boatsNearest measures from; without it, the same sample of the whole ocean shore), out to
   *  WATER_MAX_DIST tiles and at most WATER_BFS_TILES of them, cached WATER_CACHE_TICKS ticks. Every boat rule of a
   *  pass shares one fill. */
  waterPath(): WaterPath {
    const mg = this.ctx.mg, t = mg.ticks();
    if (this.waterCache !== null && t - this.waterCache.tick < WATER_CACHE_TICKS) return this.waterCache.wp;
    this.waterDist ??= new Uint16Array(mg.width() * mg.height());
    const dist = this.waterDist;
    for (const t of this.waterTouched) dist[t] = 0; // only the tiles the last fill wrote — clearing the whole World-sized array cost more than the BFS
    const q: TileRef[] = [];
    this.waterTouched = q;
    let d = 2; // length 1, stored + 1
    const visit = (n: TileRef) => { if (mg.isWater(n) && dist[n] === 0) { dist[n] = d; q.push(n); } };
    for (const s of this.shoreSample()) mg.forEachNeighbor(s, visit); // same N,S,W,E order as neighbors(), no per-tile array
    let i = 0;
    while (i < q.length && q.length < WATER_BFS_TILES) {
      const c = q[i++]; d = dist[c] + 1;
      if (d > WATER_MAX_DIST + 1) break;
      mg.forEachNeighbor(c, visit);
    }
    this.waterPathRuns++;
    const wp = new WaterPath(mg, dist);
    wp.size = q.length;
    this.waterCache = { tick: t, wp };
    return wp;
  }

  // ---------------------------------------------------------------- boats in the mid and late game
  private lastSeaTick = -1e9;
  /** Playbook: boats are the answer to a closed land border. Whenever a boat is free and either the land front is
   *  blocked or troops sit above 40 % of cap, send one to the best target across water: free shore first, then a
   *  neighbour we (or a MIRV) have just collapsed, then a weak player with no posts at 3×, then a tribe at 2×. */
  /** Returns true when a boat launched. */
  seaExpansion(): boolean {
    const me = this.ctx.me;
    if (this.ctx.sit.boats >= this.ctx.mg.config().boatMaxNumber()) return false;
    if (this.ctx.mg.ticks() - this.lastSeaTick < 100) return false;
    if (this.ctx.sit.wilderness && this.ctx.sit.capShare < 0.4) return false; // land first while it is free and we are small
    if (this.ctx.sit.incoming.length > 0 && this.ctx.sit.capShare < 0.6) return false; // under attack: the army stays
    const shore = borderOf(me).filter((t) => this.ctx.mg.isOceanShore(t));
    if (shore.length === 0) return false;
    const from = shore[Math.floor(shore.length / 2)];
    const fx = this.ctx.mg.x(from), fy = this.ctx.mg.y(from);
    const distOld = (t: TileRef) => Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
    // `boatsNearest`: the distance the engine will sail, not the one from an arbitrary border tile; every value is
    // divided by max(1, d / 40) so a stepping stone 60 tiles away beats a richer target 200 away; a shore across
    // water counts from 10 tiles (acrossWater below keeps same-landmass tiles out)
    const sample = this.ctx.p.boatsNearest ? this.shoreSample() : [];
    const nearest = sample.length > 0;
    const dist = nearest ? (t: TileRef) => this.nearestShoreDist(t, sample) : distOld;
    // `boatsWaterPath`: rank by the path the ship sails (d), refuse beyond BOAT_MAX_PATH.sea; dm is the straight-line
    // distance the rule ranks by otherwise — slScore / slOk is that ranking, kept for the liveness count
    const wp = this.ctx.p.boatsWaterPath ? this.waterPath() : null;
    // with the flag on, our own coast is near by water too (a tile 40 tiles up it sails 40), so more candidates are
    // tried and the bounded breadth-first acrossWaterNear (radius 2 × dm + 20) does the land check — the depth-first
    // acrossWater gives up at 4000 tiles and calls a tile up our own coast "across water" on a big landmass
    const across = (t: TileRef, dm: number) => (nearest || wp ? this.q.acrossWaterNear(t, dm) : this.q.acrossWater(t));
    const cands: { tile: TileRef; troops: number; score: number; dm: number; slScore: number; slOk: boolean; oldScore: number; oldOk: boolean; what: string }[] = [];
    // (a) free shore across water: 15 % of home, worth the most per troop
    let seen = 0;
    const box = this.scanBox(sample, fx, fy, 300);
    for (let y = box.y0; y <= box.y1; y += 8) for (let x = box.x0; x <= box.x1; x += 8) {
      if (!this.ctx.mg.isValidCoord(x, y)) continue;
      const t = this.ctx.mg.ref(x, y);
      if (!this.ctx.mg.isLand(t) || !this.ctx.mg.isOceanShore(t) || this.ctx.mg.hasOwner(t)) continue;
      const dOld = Math.abs(x - fx) + Math.abs(y - fy);
      const dm = nearest ? dist(t) : dOld;
      if (dm < (nearest ? 10 : 30) || seen++ > 400) continue;
      const slOk = !(nearest && dm > 300);
      const d = wp ? wp.len(t) : dm;
      const capped = wp ? d > BOAT_MAX_PATH.sea : !slOk;
      if (capped && !slOk) continue;
      const slScore = nearest ? 300 / Math.max(1, dm / 40) : 300 - dm;
      cands.push({ tile: t, troops: Math.max(5000, Math.floor(this.ctx.sit.troops * 0.15)), score: capped ? -1e9 : nearest ? 300 / Math.max(1, d / 40) : 300 - d, dm, slScore, slOk, oldScore: 300 - dOld, oldOk: dOld >= 30 && Math.abs(x - fx) <= 300 && Math.abs(y - fy) <= 300 && (x - fx) % 8 === 0 && (y - fy) % 8 === 0, what: "free shore" }); // oldOk: on the old scan's grid and inside its window
    }
    // (b) collapsed players (bombed, MIRVed): the follow-up; (c) weak players without posts; (d) tribes
    for (const o of this.ctx.mg.players()) {
      if (o === me || !o.isAlive() || me.isFriendly(o) || o.numTilesOwned() < 100) continue;
      const isBot = o.type() === PlayerType.Bot;
      const coll = !isBot && this.collapsed(o);
      const late = this.ctx.p.endgameV2 && this.ctx.mg.ticks() >= 9000;
      const weak = !isBot && ((o.troops() < this.ctx.sit.troops * 0.25 && o.units(UnitType.DefensePost).length === 0) || (late && o.troops() < this.ctx.sit.troops * 0.5));
      if (!isBot && !coll && !weak) continue;
      if (!isBot && !me.canAttackPlayer(o)) continue;
      const want = Math.ceil(o.troops() * (isBot ? 2 : 3)) + 2000;
      if (want > this.ctx.sit.spendable * 0.5) continue;
      let i = 0, bestT: TileRef | null = null, bestD = 1e9, oldT: TileRef | null = null, oldD = 1e9, slT: TileRef | null = null, slD = 1e9;
      for (const t of borderOf(o)) {
        if ((i++ % 9) !== 0 || !this.ctx.mg.isOceanShore(t)) continue;
        const dm = dist(t); if (dm < slD) { slD = dm; slT = t; }
        const d = wp ? wp.len(t) : dm; if (d < bestD) { bestD = d; bestT = t; }
        if (nearest) { const dO = distOld(t); if (dO < oldD) { oldD = dO; oldT = t; } }
      }
      if (!nearest) { oldT = slT; oldD = slD; }
      const value = coll ? 600 : weak ? 400 : 250;
      const what = `${coll ? "collapsed " : weak ? "weak " : "tribe "}${o.name()} ${o.numTilesOwned()}t/${Math.round(o.troops() / 1000)}k`;
      const oldOk = oldT !== null && oldD <= 500 && !(late && weak && oldD > 150 && o.troops() >= this.ctx.sit.troops * 0.25);
      const oldScore = value - oldD / 2 + (o.units(UnitType.City).length * 10);
      const slOk = slT !== null && slD <= 500 && !(late && weak && slD > 150 && o.troops() >= this.ctx.sit.troops * 0.25);
      const slScore = nearest ? (value + o.units(UnitType.City).length * 10) / Math.max(1, slD / 40) : value - slD / 2 + (o.units(UnitType.City).length * 10);
      const capped = bestT === null || bestD > (wp ? BOAT_MAX_PATH.sea : 500) || (late && weak && bestD > 150 && o.troops() >= this.ctx.sit.troops * 0.25); // the late-game jump is a short one
      if (capped && !(wp && slOk)) continue;
      const score = capped ? -1e9 : nearest ? (value + o.units(UnitType.City).length * 10) / Math.max(1, bestD / 40) : oldScore;
      const tile = capped ? slT! : bestT!;
      cands.push({ tile, troops: want, score, dm: slD, slScore, slOk: slOk && slT === tile, oldScore, oldOk: oldOk && oldT === tile, what });
      if (nearest && oldOk && oldT !== null && oldT !== tile) cands.push({ tile: oldT, troops: want, score: -1e9, dm: slD, slScore, slOk: false, oldScore, oldOk: true, what }); // the old ranking's tile, for the liveness count only
      if (wp && slOk && slT !== null && slT !== tile) cands.push({ tile: slT, troops: want, score: -1e9, dm: slD, slScore, slOk: true, oldScore, oldOk: false, what }); // the straight-line ranking's tile, for the liveness count only
    }
    // `contestLeader`: the boat this rule was about to send at a "weak X" / tribe / free shore goes at the runaway
    // leader's coastline instead — the SAME wave (the best such candidate's troops) re-aimed at the leader's
    // ocean-shore tile nearest our coast (its ports/cities shore preferred), inside the rule's own distance cap and
    // across water. No leader coast in range: the original boat goes — idling contests nothing.
    const lead = this.ctx.p.contestLeader ? this.ctx.sit.contest : null;
    if (lead !== null && lead.isAlive() && me.canAttackPlayer(lead)) {
      const donor = cands.filter((c) => c.score > -1e9 && c.troops <= this.ctx.sit.spendable && (c.what.startsWith("weak") || c.what.startsWith("tribe"))).sort((a, b) => b.score - a.score)[0]; // a collapsed follow-up or a free shore keeps its boat — only the "weak X" habit is redirected
      if (donor !== undefined) {
        const lt = this.contestShore(lead, dist);
        if (lt !== null && (wp ? wp.len(lt.tile) <= BOAT_MAX_PATH.sea : lt.dm <= 500)) cands.push({ tile: lt.tile, troops: donor.troops, score: donor.score + 1000, dm: lt.dm, slScore: -1e9, slOk: false, oldScore: -1e9, oldOk: false, what: `CONTEST leader ${lead.name()} ${lead.numTilesOwned()}t` });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    // `boatsWaterPath` liveness: what the straight-line ranking (this rule with the flag off) would have launched at
    const slPick = (extra: number) => cands.filter((o) => o.slOk).sort((a, b) => b.slScore - a.slScore).slice(0, 10).find((o) => o.troops <= this.ctx.sit.spendable + extra && across(o.tile, o.dm));
    for (const c of cands.slice(0, wp ? 30 : 10)) {
      if (c.score <= -1e9) continue;
      if (c.troops > this.ctx.sit.spendable) continue;
      if (!across(c.tile, c.dm)) continue;
      const sent = this.ctx.boat(c.tile, c.troops, `sea expansion → ${c.what}${wp ? ` (${wp.len(c.tile)} tiles by water)` : nearest ? ` (${dist(c.tile)} tiles)` : ""}`);
      if (sent === 0) continue;
      this.lastSeaTick = this.ctx.mg.ticks();
      if (c.what.startsWith("CONTEST")) { this.lim.fire("contestLeader", "sea"); return true; } // redirected: the other flags' liveness compares are moot
      if (nearest) {
        // liveness: what the old ranking (middle tile, flat − d/2, 30-tile floor) would have launched at
        const old = cands.filter((o) => o.oldOk).sort((a, b) => b.oldScore - a.oldScore).slice(0, 10).find((o) => o.troops <= this.ctx.sit.spendable + sent && this.q.acrossWater(o.tile));
        if (old === undefined || old.tile !== c.tile) this.lim.fire("boatsNearest", "sea");
      }
      if (wp) { const sl = slPick(sent); if (sl === undefined || sl.tile !== c.tile) this.lim.fire("boatsWaterPath", "sea"); }
      return true;
    }
    if (wp) { const sl = slPick(0); if (sl !== undefined && sl.score <= -1e9) this.lim.fire("boatsWaterPath", "sea"); } // refused by the cap
    return false;
  }

  // ---------------------------------------------------------------- MIRV and the finish
  private lastMirvTick = -1e9;
  private lastCrownHeld = -1e9;
  private lastGuardLog = new Map<string, number>();
  private lastWarTick = -1e9;
  private bombOutOfRange_ = 0;
  /** Playbook phase 6: a MIRV goes to (1) whoever has one in the air at us, (2) anyone over half the map,
   *  (3) from 25:00, the largest un-allied player above us when we are in the top three — launch first, then
   *  the collapse rule sends the army into the emptied land. */
  maybeMIRV(spent = 0n): void {
    const me = this.ctx.me;
    if (me.units(UnitType.MissileSilo).length === 0 || this.ctx.mg.config().isUnitDisabled(UnitType.MIRV)) return;
    if (this.ctx.mg.ticks() - this.lastMirvTick < 600) return;
    const cost = this.ctx.mg.config().unitInfo(UnitType.MIRV).cost(this.ctx.mg, me);
    // `spent`: gold Economy.build committed this pass (deducted next tick) — MirvExecution checks the price on its own
    // tick, and a launch it drops for gold would still have burnt the cooldown here
    if (me.gold() - spent < cost) return;
    const total = this.ctx.mg.numLandTiles();
    const others = this.ctx.mg.players().filter((p) => p !== me && p.isAlive() && p.type() !== PlayerType.Bot && !me.isFriendly(p) && !me.isOnSameTeam(p));
    let target: Player | null = null, why = "";
    // the finish: the richest MIRV-capable rival — `threats` is every silo owner off our team, allies included
    // (readSlow: an ally can still fire), so the un-allied filter of `others` is applied here
    if (this.ctx.sit.mode !== "grow") { const t = this.ctx.sit.threats.filter((p) => others.includes(p)).sort((a, b) => Number(b.gold() - a.gold()))[0]; if (t !== undefined) { target = t; why = `finish: ${this.ctx.sit.mode}, richest MIRV-capable rival`; } }
    if (!target) for (const p of others) for (const m of p.units(UnitType.MIRV)) { const d = m.targetTile(); if (d && this.ctx.mg.hasOwner(d) && this.ctx.mg.owner(d) === me) { target = p; why = "counter"; } }
    if (!target) { const t = others.filter((p) => p.numTilesOwned() / total >= 0.5).sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0]; if (t) { target = t; why = "victory denial"; } }
    // `duelPush`: the foe of a won duel is a priority MIRV target like the threats (the finish branch above already
    // takes it when it is MIRV-capable); with `nationMirvAware` on, never at a foe that can counter
    if (!target) {
      const foe = this.ctx.sit.duel;
      if (foe !== null && others.includes(foe) && !(this.ctx.p.nationMirvAware && this.risk.canCounter(foe))) { target = foe; why = `duel foe (${Math.round(foe.troops() / 1000)}k vs our ${Math.round(me.troops() / 1000)}k)`; } // the contest branch below is moot: one target
    }
    // `contestLeader`: the runaway leader is a priority MIRV target like the threats — no 12000-tick or 0.8× gate
    // beyond the contest state itself (rank ≤ contestRank, > contestLeadRatio × our tiles, still rising). With
    // `nationMirvAware` on it keeps that flag's crown discipline: never at a target that can counter.
    if (!target && this.ctx.p.contestLeader) {
      const lead = this.ctx.sit.contest;
      if (lead !== null && others.includes(lead) && !(this.ctx.p.nationMirvAware && this.risk.canCounter(lead))) { target = lead; why = `contest leader (${lead.numTilesOwned()}t vs ours ${me.numTilesOwned()}t)`; }
    }
    if (!target && this.ctx.mg.ticks() >= 12000) {
      const ranked = this.ctx.mg.players().filter((p) => p.isAlive() && p.type() !== PlayerType.Bot).sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      const myRank = ranked.indexOf(me) + 1;
      if (myRank <= 3) {
        const cands = others.filter((p) => p.numTilesOwned() > me.numTilesOwned() * 0.8).sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
        let t: Player | undefined = cands[0];
        if (t !== undefined && this.ctx.p.nationMirvAware) {
          // `nationMirvAware` (1): a nation with a silo and the MIRV price answers our MIRV with its own (NationMIRVBehavior's
          // counter rule; 5 of the 6 lab launches were crown MIRVs answered this way) — the crown MIRV goes only at a
          // target that cannot counter, else it is held
          const safe = cands.find((p) => !this.risk.canCounter(p));
          if (safe === undefined) {
            this.lim.fire("nationMirvAware", "crown", 600);
            if (this.ctx.mg.ticks() - this.lastCrownHeld >= 600) { this.lastCrownHeld = this.ctx.mg.ticks(); this.ctx.log(`t${this.ctx.mg.ticks()} MIRV held: ${t.name()} can counter`); }
            return;
          }
          if (safe !== t) this.lim.fire("nationMirvAware", "crown", 600);
          t = safe;
        }
        if (t !== undefined) { target = t; why = `crown (we are #${myRank})`; }
      }
    }
    if (!target) return;
    const center = calculateTerritoryCenter(this.ctx.mg, target);
    if (center === null) return;
    const tile = this.mirvTile(target, center);
    if (tile === null) { this.ctx.log(`t${this.ctx.mg.ticks()} MIRV ${target.name()} held: every tile of it sits under a SAM`); return; }
    if (me.canBuild(UnitType.MIRV, tile) === false) return;
    this.ctx.mg.addExecution(new MirvExecution(me, tile));
    this.lastMirvTick = this.ctx.mg.ticks();
    this.bombs++;
    if (why.startsWith("contest leader")) this.lim.fire("contestLeader", "mirv", 600); // only the flag's branch picked this target
    if (why.startsWith("duel foe")) this.lim.fire("duelPush", "mirv", 600);
    this.ctx.log(`t${this.ctx.mg.ticks()} MIRV ${target.name()} ${target.numTilesOwned()}t (${why})${tile === center ? "" : " — aimed off-centre, the centre is under a SAM"}`);
  }
  /** The territory centre unless one of the target's SAMs covers it (Config.samRange(level) + 5, as maybeBomb): then
   *  the uncovered tile of its territory nearest the centre (sampled from its border), or null if there is none. */
  private mirvTile(target: Player, center: TileRef): TileRef | null {
    const mg = this.ctx.mg;
    const sams = target.units(UnitType.SAMLauncher);
    const covered = (t: TileRef) => sams.some((s) => mg.euclideanDistSquared(s.tile(), t) <= (mg.config().samRange(s.level()) + 5) ** 2);
    if (!covered(center)) return center;
    const border = borderOf(target), step = Math.max(1, Math.floor(border.length / 120));
    let best: TileRef | null = null, bestD = 1e18, i = 0;
    for (const t of border) {
      if ((i++ % step) !== 0 || covered(t)) continue;
      const d = mg.euclideanDistSquared(t, center);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  // ---------------------------------------------------------------- mirvCounterforce: strike the named source
  private lastCfTick = -1e9;
  /** `mirvCounterforce` (combo loss analysis: 24 of 71 losses were MIRVed down after leading, while the bot fired
   *  ZERO MIRVs in 239 full games — the MirvRisk diagnostics named the saver minutes in advance): while a MirvRisk
   *  rule is TRUE against us (steamroll / denial) and MirvRisk names armed or saving rivals, act on the SOURCE
   *  instead of only walling up (`samOnRisk`, a separate flag, untouched): (a) our MIRV at the most-armed rival
   *  (canFire outranks saving; a built MIRV, then the richer) when we hold a silo and the price and maybeMIRV's own
   *  rules held this pass — it runs earlier this tick and shares lastMirvTick, so a launch here is one the plain
   *  rules never made; with `nationMirvAware` never at a rival that can counter (every canFire rival can, so that
   *  guard leaves the saving ones); (b) else a hydrogen bomb on the rival's SILO — the plain rule's 8000-tile owner
   *  gate is relaxed (the silo is the target, not the land), SAM umbrellas, the 105-tile friend clearance and the
   *  engine's collateral rule still respected. Budget: the bomb reserve stays (2M when `rich`, as maybeBomb), the
   *  MIRV price is checked net of this pass's buys, cfCooldown ticks between counterforce launches, and never a
   *  second launch on a tick a bomb already went. Logged `COUNTERFORCE <name>: <mirv|H at silo x,y>`. */
  counterforce(ticks: number, spent = 0n): void {
    const p = this.ctx.p, me = this.ctx.me, mg = this.ctx.mg;
    if (!p.mirvCounterforce) return;
    if (ticks - this.lastCfTick < p.cfCooldown) return;
    if (me.units(UnitType.MissileSilo).length === 0) return;
    const v = this.risk.view();
    if (!v.steamroll.over && !v.denial.over) return; // only while a rule is live against us
    const rank = (ps: Player[]) => ps.filter((r) => r.isAlive() && !me.isFriendly(r)).sort((a, b) => b.units(UnitType.MIRV).length - a.units(UnitType.MIRV).length || Number(b.gold() - a.gold()));
    const armed = [...rank(v.canFire), ...rank(v.saving)]; // canFire outranks saving: it can fire this tick, not soon
    if (armed.length === 0) return;
    const suffix = `${v.steamroll.over ? "steamroll" : "denial"} risk, ${v.canFire.length} can fire, ${v.saving.length} saving`;
    // (a) our MIRV first at the most-armed rival the `nationMirvAware` guard allows
    const mirvCost = mg.config().unitInfo(UnitType.MIRV).cost(mg, me);
    if (ticks - this.lastMirvTick >= 600 && !mg.config().isUnitDisabled(UnitType.MIRV) && (me.units(UnitType.MIRV).length > 0 || me.gold() - spent >= mirvCost)) {
      const target = armed.find((r) => !(p.nationMirvAware && this.risk.canCounter(r)));
      if (target !== undefined) {
        const center = calculateTerritoryCenter(mg, target);
        const tile = center === null ? null : this.mirvTile(target, center);
        if (tile !== null && me.canBuild(UnitType.MIRV, tile) !== false) {
          mg.addExecution(new MirvExecution(me, tile));
          this.lastMirvTick = ticks; this.lastCfTick = ticks; this.bombs++;
          this.lim.fire("mirvCounterforce", "mirv"); // maybeMIRV ran this tick and held: the launch is the flag's
          this.ctx.log(`t${ticks} COUNTERFORCE ${target.name()}: mirv (${suffix})`);
          return;
        }
      }
    }
    // (b) a hydrogen bomb on the most-armed rival's silo
    if (this.lastBombTick === ticks) return; // maybeBomb launched this very tick: no double spend
    const hCost = mg.config().unitInfo(UnitType.HydrogenBomb).cost(mg, me);
    const atomCost = mg.config().unitInfo(UnitType.AtomBomb).cost(mg, me);
    const gold = me.gold();
    const rich = p.endgameV2 && ticks >= 9000 && gold >= 8_000_000n && (gold < mirvCost || me.units(UnitType.MIRV).length > 0); // maybeBomb's own reserve rule
    const reserve = BigInt(rich ? 2_000_000 : p.bombReserve);
    if (gold - spent < hCost + reserve) return; // never below the bomb reserve
    // liveness: what the plain bomb rule would pick right now (before our launch marks the tile bombed) — usually
    // nothing at this silo: the saver is rarely in its enemies set, and its value search chases clusters, not silos
    const plain = this.bombSearch(this.bombEnemies(gold, false).enemies, rich, (type) => gold - spent >= (type === UnitType.HydrogenBomb ? hCost : atomCost) + reserve);
    for (const r of armed) {
      const sams = r.units(UnitType.SAMLauncher);
      for (const s of r.units(UnitType.MissileSilo)) {
        const tile = s.tile();
        if ((this.bombed.get(tile) ?? 0) >= 1) continue;
        if (sams.some((sm) => mg.euclideanDistSquared(sm.tile(), tile) <= (mg.config().samRange(sm.level()) + 5) ** 2)) continue;
        if (!this.clearOfFriends(tile, 105) || this.blastCollateral(tile, UnitType.HydrogenBomb, r)) continue;
        this.launch({ tile, value: 0, type: UnitType.HydrogenBomb, enemy: r, cost: hCost }, ticks);
        if (this.lastBombTick !== ticks) continue; // out of every ready silo's range: try the next candidate
        this.lastCfTick = ticks;
        if (plain === null || plain.tile !== tile) this.lim.fire("mirvCounterforce", "bomb");
        this.ctx.log(`t${ticks} COUNTERFORCE ${r.name()}: H at silo ${mg.x(tile)},${mg.y(tile)} (${suffix})`);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- territory integrity
  private splitOwner: Player | null = null;
  private splitTile: TileRef | null = null;
  private splitSince = -1;
  /** Every 20 s: is our land in one piece? If not, find who sits between the main body and the largest other piece.
   *  The engine hands a surrounded piece to the surrounding player, so a split is a countdown. */
  watchSplit(): void {
    const me = this.ctx.me;
    if (me.numTilesOwned() < 200) { this.splitOwner = null; return; }
    const clusters = Military.pieces(this.ctx.mg, me);
    if (clusters.length <= 1) { if (this.splitOwner !== null) this.ctx.log(`t${this.ctx.mg.ticks()} territory reconnected`); this.splitOwner = null; this.splitTile = null; return; }
    clusters.sort((a, b) => b.tiles - a.tiles);
    const main = clusters[0].border, other = clusters[1].border;
    // nearest pair of border tiles between the two pieces (sampled), then the owner of the midpoint
    let best = 1e18, bt: TileRef | null = null, bo: TileRef | null = null;
    for (let i = 0; i < main.length; i += Math.max(1, Math.floor(main.length / 60))) for (let j = 0; j < other.length; j += Math.max(1, Math.floor(other.length / 60))) {
      const d = this.ctx.mg.euclideanDistSquared(main[i], other[j]); if (d < best) { best = d; bt = main[i]; bo = other[j]; }
    }
    if (bt === null || bo === null) return;
    const mx = Math.round((this.ctx.mg.x(bt) + this.ctx.mg.x(bo)) / 2), my = Math.round((this.ctx.mg.y(bt) + this.ctx.mg.y(bo)) / 2);
    const mid = this.ctx.mg.ref(mx, my);
    const owner = this.ctx.mg.owner(mid);
    const who = owner.isPlayer() ? (owner as Player) : null;
    if (this.splitSince < 0) this.splitSince = this.ctx.mg.ticks();
    if (who !== this.splitOwner) this.ctx.log(`t${this.ctx.mg.ticks()} SPLIT: ${clusters.length} pieces, second piece ${clusters[1].tiles} tiles, gap ${Math.round(Math.sqrt(best))} tiles held by ${who ? who.name() : "nobody"}`);
    this.splitOwner = who && who !== me && !me.isFriendly(who) ? who : null;
    this.splitTile = this.ctx.mg.isLand(mid) && !this.ctx.mg.hasOwner(mid) ? mid : null;
  }
  // ---------------------------------------------------------------- thinGuard: pinch watch
  /** `thinGuard`: the pinch Economy.build should cover with a post (a rival on both sides of the corridor) —
   *  set here, consumed there, dropped when stale. */
  thinPostWant: { tile: TileRef; until: number } | null = null;
  /** `thinGuard`: the tribe a pinch faces — harvestBots eats it first (through the existing budgets). */
  private thinTribe: { bot: Player; until: number } | null = null;
  /** Pinches already acted on (a pinch within 2 × thinWidth of one handled in the last 600 ticks is the same pinch). */
  private thinHandled: { tile: TileRef; tick: number }[] = [];
  /** `thinGuard` (every 100 ticks): scan our sampled border for pinches — a run of ≤ thinWidth of our tiles with
   *  non-owned LAND on both ends (water does not count: a strait is not land-cuttable; splits ARE happening in the
   *  hard0 transcripts and prevention beats watchSplit's reconnect-after-cut). One pinch per pass, the narrowest:
   *  (1) a side facing free land → an immediate expand click at the contested share (the widening move, through
   *  send()'s budgets); (2) a side facing a tribe → mark it so harvestBots eats that side first; (3) a rival on
   *  both sides → request a defense post at the pinch through the existing ≤8-post budget. Logs `THIN (x,y) width~w`. */
  thinGuard(): void {
    const mg = this.ctx.mg, me = this.ctx.me, t = mg.ticks();
    if (this.thinPostWant !== null && t > this.thinPostWant.until) this.thinPostWant = null;
    if (this.thinTribe !== null && (t > this.thinTribe.until || !this.thinTribe.bot.isAlive())) this.thinTribe = null;
    if (me.numTilesOwned() < 200) return; // a spawn blob is all edge — watchSplit's floor
    this.thinHandled = this.thinHandled.filter((h) => t - h.tick < 600);
    const w = Math.max(1, this.ctx.p.thinWidth);
    const border = borderOf(me);
    // the not-ours-but-land test, shared by both ends of a probe (free land, a tribe or a rival — never water/edge)
    const openLand = (x: number, y: number): boolean => { if (!mg.isValidCoord(x, y)) return false; const r = mg.ref(x, y); return mg.isLand(r) && mg.owner(r) !== me; };
    let best: { tile: TileRef; width: number; near: TileRef; far: TileRef } | null = null;
    for (let i = 0; i < border.length; i += 3) {
      const tile = border[i];
      const x = mg.x(tile), y = mg.y(tile);
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (!openLand(x - dx, y - dy)) continue; // the near side of the probe: non-owned land right behind the border tile
        for (let m = 1; m <= w; m++) { // walk into our territory looking for the far side
          const px = x + dx * m, py = y + dy * m;
          if (!mg.isValidCoord(px, py)) break;
          const pr = mg.ref(px, py);
          if (mg.owner(pr) === me) continue;
          if (!mg.isLand(pr)) break; // water: a peninsula, not a land-cuttable corridor on this axis
          if (best === null || m < best.width) best = { tile, width: m, near: mg.ref(x - dx, y - dy), far: pr };
          break;
        }
      }
    }
    if (best === null) return;
    if (this.thinHandled.some((h) => mg.manhattanDist(h.tile, best!.tile) <= 2 * w)) return; // this pinch is being handled
    this.thinHandled.push({ tile: best.tile, tick: t });
    const side = (r: TileRef): Player | null => { const o = mg.owner(r); return o.isPlayer() ? (o as Player) : null; };
    const sides = [side(best.near), side(best.far)];
    const tribe = sides.find((s) => s !== null && s.type() === PlayerType.Bot) ?? null;
    const rival = sides.find((s) => s !== null && s.type() !== PlayerType.Bot && !me.isFriendly(s)) ?? null;
    const free = sides.some((s) => s === null);
    this.ctx.log(`t${t} THIN (${mg.x(best.tile)},${mg.y(best.tile)}) width~${best.width} faces ${sides.map((s) => (s === null ? "free land" : s.name())).join(" / ")}`);
    // (1) prefer the widening move: free land → expand NOW at the contested share; a tribe → eat that side first
    if (free) {
      if (this.actExpand(Math.floor(this.ctx.sit.troops * this.ctx.p.expandContested)) > 0) this.lim.fire("thinGuard", "widen");
      return;
    }
    if (tribe !== null) { this.thinTribe = { bot: tribe, until: t + 600 }; this.lim.fire("thinGuard", "pinch"); return; }
    // (2) a rival across the pinch: a post makes cutting through it 5× more expensive (Economy holds the budget)
    if (rival !== null && this.thinPostWant === null) { this.thinPostWant = { tile: best.tile, until: t + 600 }; this.lim.fire("thinGuard", "pinch"); }
  }

  /** The 4-connected pieces of `p`'s territory — exact, from the border alone. Each row's owned tiles form runs
   *  whose ends are border tiles (a run end has a non-owned tile beside it), so the runs come from the sorted border
   *  tiles of the row plus the map's left/right edges (an edge tile is not a border tile: GameMap.isBorder); runs
   *  in neighbouring rows that overlap in x are one piece (union-find). A row with no border tile is either empty or
   *  owned wall to wall. Cost O(border log border) against O(tiles) for a flood fill; tile counts are exact. */
  static pieces(mg: Game, p: Player): { tiles: number; border: TileRef[] }[] {
    const w = mg.width(), h = mg.height(), pid = p.smallID();
    const rows = new Map<number, TileRef[]>();
    for (const t of borderOf(p)) { const y = mg.y(t); let r = rows.get(y); if (!r) { r = []; rows.set(y, r); } r.push(t); }
    if (rows.size === 0) return [];
    const owned = (x: number, y: number) => mg.ownerID(mg.ref(x, y)) === pid;
    // runs: [x0, x1, id] per row; border tiles keep the run they lie in
    const parent: number[] = [];
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const runTiles: TileRef[][] = [], runLen: number[] = [];
    let prev: [number, number, number][] = [];
    for (let y = 0; y < h; y++) { // every row: a wall-to-wall row has no border tile at all (map edges are not borders)
      const cur: [number, number, number][] = [];
      const bt = rows.get(y);
      if (bt === undefined) {
        if (owned(0, y)) { const id = parent.length; parent.push(id); runTiles.push([]); runLen.push(w); cur.push([0, w - 1, id]); }
      } else {
        bt.sort((a, b) => a - b);
        let open = owned(0, y) ? 0 : -1, tiles: TileRef[] = [];
        for (const t of bt) {
          const x = mg.x(t);
          if (x > 0 && !owned(x - 1, y)) { open = x; tiles = []; }
          tiles.push(t);
          if (x === w - 1 || !owned(x + 1, y)) { const id = parent.length; parent.push(id); runTiles.push(tiles); runLen.push(x - open + 1); cur.push([open, x, id]); open = -1; tiles = []; }
        }
        if (open >= 0) { const id = parent.length; parent.push(id); runTiles.push(tiles); runLen.push(w - open); cur.push([open, w - 1, id]); }
      }
      // two-pointer merge with the row above
      let i = 0, j = 0;
      while (i < prev.length && j < cur.length) {
        const a = prev[i], b = cur[j];
        if (a[0] <= b[1] && b[0] <= a[1]) union(a[2], b[2]);
        if (a[1] < b[1]) i++; else j++;
      }
      prev = cur;
    }
    const out = new Map<number, { tiles: number; border: TileRef[] }>();
    for (let id = 0; id < parent.length; id++) {
      const root = find(id);
      let c = out.get(root);
      if (!c) { c = { tiles: 0, border: [] }; out.set(root, c); }
      c.tiles += runLen[id];
      for (const t of runTiles[id]) c.border.push(t);
    }
    return [...out.values()];
  }

  // ---------------------------------------------------------------- expansion
  expand(): void {
    const o = this.expandOption();
    if (o !== null) this.actExpand(o.troops);
  }
  private falloutLogged = -1e9;
  private falloutWaitLogged = -1e9; // the wait log's own timer: a deferral at t and the take at t+coolTicks should both log
  /** The expand click this pass would make (decide half of expand()). */
  expandOption(): { troops: number; contested: boolean } | null {
    const { rivals, wilderness } = this.q.neighbours();
    if (!wilderness) {
      // `takeFallout`: nearby() hides irradiated free land, so this is the only path that ever expands into it
      if (!this.ctx.p.takeFallout || this.ctx.sit.troops < this.q.cap() * this.ctx.p.fightAbove) return null;
      const n = this.q.falloutBordering(this.ctx.mg.ticks());
      if (n === 0) return null;
      // `falloutPatience`: engine fallout never cools (one bit, cleared only by conquest/flood; the ~5× penalty is
      // 5 − 2 × the GLOBAL fallout share — Config.falloutDefenseModifier — never tile age), so the wait is for the
      // BOMBS, not the isotopes: while a bordering basin is still growing (a nuke landed < falloutCoolTicks ago)
      // the land we clear at ~5× mag can be re-nuked away — defer, unless a hostile borders the basin (front-line
      // fallout: taking it advances the border with zero defender losses and denies the human reclaim).
      if (this.ctx.p.falloutPatience) {
        const ticks = this.ctx.mg.ticks();
        const b = this.q.falloutBasins(ticks);
        if (!b.hostile && ticks - b.lastGrowth < this.ctx.p.falloutCoolTicks) {
          this.lim.fire("falloutPatience", "defer"); // off would have clicked: the deferral is the changed decision
          if (ticks - this.falloutWaitLogged >= 600) { this.falloutWaitLogged = ticks; this.ctx.log(`t${ticks} FALLOUT wait: basin ~${b.size} tiles still hot (grew ${ticks - b.lastGrowth} ticks ago), no hostile on its rim — deferring ${this.ctx.p.falloutCoolTicks - (ticks - b.lastGrowth)} more ticks`); }
          return null;
        }
      }
      this.lim.fire("takeFallout", "expand");
      if (this.ctx.mg.ticks() - this.falloutLogged >= 600) { this.falloutLogged = this.ctx.mg.ticks(); this.ctx.log(`t${this.ctx.mg.ticks()} FALLOUT expand: ~${n * 3} irradiated tiles on our border, troops at ${Math.round(100 * this.ctx.sit.capShare)} % of cap`); }
      return { troops: Math.floor(this.ctx.sit.troops * this.ctx.p.expandContested), contested: true };
    }
    const around = [...this.ctx.sit.rivals, ...this.ctx.sit.bots, ...this.ctx.sit.friends];
    const ringing = around.some((r) => this.q.annexable(r));
    // `annexWars`: the click share follows the new definition; count it when the old one would have said otherwise
    if (this.ctx.p.annexWars && ringing !== around.some((r) => this.q.annexable(r) !== this.q.annexableChanged(r))) this.lim.fire("annexWars", "ringing");
    const contested = rivals.length > 0 || ringing || this.splitTile !== null || this.ctx.sit.mode === "push";
    const frac = contested ? this.ctx.p.expandContested : this.ctx.p.expandFree;
    return { troops: Math.floor(this.ctx.sit.troops * frac), contested };
  }
  /** free land is the cheapest growth there is and unused troops come home: only the troop reserve applies, not the cap floor */
  actExpand(troops: number): number {
    return this.ctx.send(this.ctx.mg.terraNullius().id(), troops, "expand", 100);
  }

  // ---------------------------------------------------------------- bots
  harvestBots(): void {
    const me = this.ctx.me;
    const { bots, wilderness } = this.q.neighbours();
    if (bots.length === 0) return;
    bots.sort((a, b) => a.troops() - b.troops());
    // `thinGuard`: only the ORDER changes (same sizing, gates, concurrency) — the pinch tribe goes first,
    // everything else stays weakest-first. (`tribeBorders`, the rival-bordering reorder, was removed 2026-08-31 —
    // bad single-seed smokes, never A/B'd; last commit with the code: c38fc2020.)
    const thinTribe = this.ctx.p.thinGuard && this.thinTribe !== null && bots.includes(this.thinTribe.bot) ? this.thinTribe.bot : null;
    const plainOrder = thinTribe !== null ? bots.slice() : null;
    if (plainOrder !== null) bots.sort((a, b) => {
      if (a === thinTribe) return -1;
      if (b === thinTribe) return 1;
      return a.troops() - b.troops();
    });
    const plentiful = me.troops() > this.q.cap() * this.ctx.p.fightAbove;
    // free land costs 16–24 a tile; a tribe costs its density plus the losses of the fight. Eat tribes
    // once the wilderness is gone, or earlier only when we are plentiful and the click is small.
    const early = wilderness && this.ctx.p.botsAfterWild;
    // invariant: one tribe at a time below 60 % of cap, two above — three at once is how the army disappears
    // `multiWar`: two below 60 % of cap, three above, and the pass keeps clicking while the next click is affordable (at most three)
    const oldMax = this.ctx.p.tribeConcurrency + (this.ctx.sit.capShare > 0.6 ? 1 : 0);
    const maxConcurrent = this.ctx.p.multiWar ? Math.max(oldMax, 2 + (this.ctx.sit.capShare > 0.6 ? 1 : 0)) : oldMax;
    let active = this.ctx.sit.tribeAttacks;
    let clicks = 0;
    for (const bot of bots) {
      if (!me.canAttackPlayer(bot) || !this.reachable(bot)) continue;
      const want = Math.ceil(bot.troops() * this.ctx.p.botRatio) + 500;
      if (this.q.outgoingTo(bot)) { this.tribeFollowUp(bot); continue; }
      if (active >= maxConcurrent) continue;
      const maxSend = Math.floor(this.ctx.sit.spendable * (early ? this.ctx.p.botEarlyShare : this.ctx.p.botMaxShare));
      if (want > maxSend) continue;
      const oldOk = active < oldMax && clicks < (plentiful ? 2 : 1); // what the one-at-a-time rule would have allowed
      if (!this.tribeClick(bot, want)) continue;
      if (clicks === 0 && plainOrder !== null) this.notePriority(bot, plainOrder, maxSend, thinTribe);
      active++;
      clicks++;
      if (!oldOk) this.ctx.fire("multiWar");
      if (this.ctx.p.multiWar ? clicks >= 3 : !plentiful || clicks >= 2) return;
    }
  }
  /** follow-up click: the guide's two-click — a second wave 10 s later merges into the first.
   *  `thinGuard`: while the wave is unfinished, follow-ups go at HALF botFollowUpTicks — the hard0 transcripts show
   *  the half-eaten tribe as a salient-maker (an unfinished wave leaves a thin arm into the tribe), so finish it
   *  twice as fast. */
  private tribeFollowUp(bot: Player): void {
    const w = this.waves.get(bot);
    if (!w || w.sent >= w.want) return;
    const since = this.ctx.mg.ticks() - w.last;
    const wait = this.ctx.p.thinGuard ? Math.max(1, Math.floor(this.ctx.p.botFollowUpTicks / 2)) : this.ctx.p.botFollowUpTicks;
    if (since < wait) return;
    const send = this.ctx.send(bot.id(), Math.min(w.want - w.sent, Math.floor(this.ctx.sit.troops * this.ctx.p.botClickCap)), "tribe follow-up");
    if (send === 0) return;
    if (this.ctx.p.thinGuard && since < this.ctx.p.botFollowUpTicks) this.lim.fire("thinGuard", "followUp"); // the full cadence would have waited
    w.sent += send; w.last = this.ctx.mg.ticks();
    this.noteFollowUp(bot, send);
  }
  /** The first click of the pass went to `thinGuard`'s pinch tribe when the plain weakest-first order would have
   *  picked another tribe under the same gates: the flag changed the decision — count it and log TRIBE PRIORITY. */
  private notePriority(clicked: Player, plain: Player[], maxSend: number, thinTribe: Player | null): void {
    const me = this.ctx.me;
    if (clicked !== thinTribe) return; // only thinGuard reorders
    const plainPick = plain.find((b) => me.canAttackPlayer(b) && this.reachable(b) && !this.q.outgoingTo(b) && b !== clicked && Math.ceil(b.troops() * this.ctx.p.botRatio) + 500 <= maxSend) ?? clicked;
    if (plainPick === clicked || plain.indexOf(plainPick) > plain.indexOf(clicked)) return; // same pick, or `clicked` came first in the plain order too
    this.lim.fire("thinGuard", "tribe");
    this.ctx.log(`t${this.ctx.mg.ticks()} TRIBE PRIORITY ${clicked.name()} (thin pinch)`);
  }
  /** The first click on a tribe: `want` in total, at most botClickCap of home now (act half of harvestBots). */
  private tribeClick(bot: Player, want: number): boolean {
    const first = this.ctx.send(bot.id(), Math.min(want, Math.floor(this.ctx.sit.troops * this.ctx.p.botClickCap)), "tribe");
    if (first === 0) return false;
    this.waves.set(bot, { want, sent: first, last: this.ctx.mg.ticks() });
    this.noteSent(bot);
    this.noteWave(bot, first);
    this.ctx.log(`t${this.ctx.mg.ticks()} bot ${bot.name()} ${bot.numTilesOwned()}t/${Math.round(bot.troops())} ← ${first}/${want}`);
    return true;
  }
  /** Opposing attacks cancel troop-for-troop: answer a non-bot attack with a counter of the same size. */
  counterAttack(): void {
    const me = this.ctx.me;
    for (const inc of me.incomingAttacks()) {
      const a = inc.attacker();
      if (a.type() === PlayerType.Bot || me.isFriendly(a)) continue;
      if (this.q.outgoingTo(a)) continue;
      if (!me.canAttackPlayer(a) || !this.reachable(a)) continue;
      // a post makes defending 5× cheaper than cancelling; only cancel waves that would cost real land
      const big = inc.troops() > me.troops() * 0.15 || (!this.q.postFacing(a) && inc.troops() > me.troops() * 0.05);
      const last = this.lastCounter.get(a) ?? -1e9;
      if (!big || this.ctx.mg.ticks() - last < 300) continue;
      this.lastCounter.set(a, this.ctx.mg.ticks());
      const want = Math.min(Math.ceil(inc.troops() * 1.05), Math.floor(this.ctx.sit.troops * 0.5));
      const send = this.ctx.send(a.id(), want, "counter", 1000);
      if (send === 0) continue;
      this.noteSent(a);
      this.counters.add(a);
      this.ctx.log(`t${this.ctx.mg.ticks()} COUNTER ${a.name()} (${Math.round(inc.troops() / 1000)}k incoming) with ${Math.round(send / 1000)}k`);
    }
  }

  // ---------------------------------------------------------------- boatDefense: enemy amphibious play
  /** `boatDefense`: inbound enemy transports being tracked, by unit id — owner, troops and landing tile at last
   *  sight. TransportShipExecution stores the landing tile on the unit (buildUnit {targetTile: dst}); a tracked
   *  boat gone from the map within a pass or two of its last sighting has landed (or was sunk, in which case the
   *  blob check below finds nothing and the entry ages out). */
  private bdSeen = new Map<number, { owner: Player; troops: number; dst: TileRef; last: number }>();
  /** Landings to watch for a beachhead (kept 600 ticks — a blob that took that long to touch us is contained). */
  private bdLandings: { owner: Player; troops: number; tile: TileRef; tick: number }[] = [];
  private bdCountered = new Map<Player, number>();
  private bdRaced = new Map<Player, number>();
  /** `boatDefense`: the landing zone Economy.build should cover with a post — set here, consumed (or found already
   *  covered) there, dropped when stale. `until` = estimated landing tick + the beachhead fight window. */
  bdPostWant: { tile: TileRef; until: number } | null = null;
  /** The whole rule (every 20 ticks, flag-gated by the table): scan enemy transports bound for our coast, request
   *  the landing-zone post, race tribe-bound boats, and counter-wave fresh beachheads while they are small. */
  boatDefense(): void {
    const mg = this.ctx.mg, me = this.ctx.me, t = mg.ticks();
    const border = borderOf(me);
    if (border.length === 0) return;
    // our border, sampled every 3rd tile (the annex/fallout walks' sampling), plus its bounding box: most of the
    // map's transports are rejected on the box alone, the rest pay one pass over the ~border/3 sample
    const bx: number[] = [], by: number[] = [];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < border.length; i += 3) {
      const x = mg.x(border[i]), y = mg.y(border[i]);
      bx.push(x); by.push(y);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const range = this.ctx.p.bdCoastRange;
    const live = new Set<number>();
    for (const u of mg.units(UnitType.TransportShip)) {
      const o = u.owner();
      if (o === me || me.isFriendly(o) || !u.isActive() || u.transportShipState().isRetreating) continue;
      const dst = u.targetTile();
      if (dst === undefined) continue;
      // 3. a boat bound for a TRIBE in our sphere (borders us, or sits on our landmass) — an enemy about to appear
      // inside our lines wherever the tribe's own coast is, so this check is not behind the border-range gate
      const tribe = mg.owner(dst);
      if (tribe.isPlayer() && (tribe as Player).type() === PlayerType.Bot) this.bdTribeRace(tribe as Player, o, dst, t);
      const dx = mg.x(dst), dy = mg.y(dst);
      if (dx < x0 - range || dx > x1 + range || dy < y0 - range || dy > y1 + range) continue;
      let d = 1e9;
      for (let i = 0; i < bx.length; i++) { const dd = Math.abs(bx[i] - dx) + Math.abs(by[i] - dy); if (dd < d) d = dd; }
      if (d > range) continue;
      live.add(u.id());
      const eta = mg.manhattanDist(u.tile(), dst); // the ship sails 1 water tile/tick; manhattan is a floor for the real path
      const known = this.bdSeen.has(u.id());
      this.bdSeen.set(u.id(), { owner: o, troops: u.troops(), dst, last: t });
      if (!known) {
        this.ctx.log(`t${t} BOAT INBOUND ${o.name()} → (${dx},${dy}) eta ${eta}`);
        this.lim.fire("boatDefense", "inbound");
      }
      // 1. a post covering the landing zone, if it can finish before the boat lands (Economy holds the budget)
      const postTicks = mg.config().unitInfo(UnitType.DefensePost).constructionDuration ?? 0;
      if (this.bdPostWant === null && eta > postTicks + 20 &&
        !mg.hasUnitNearby(dst, mg.config().defensePostRange(), UnitType.DefensePost, me.id(), true))
        this.bdPostWant = { tile: dst, until: t + eta + 300 }; // + the beachhead fight: gold short now may cover it in time
    }
    // tracked boats gone from the map: landed (or sunk) — watch the spot for a beachhead
    for (const [id, s] of this.bdSeen) {
      if (live.has(id)) continue;
      this.bdSeen.delete(id);
      if (t - s.last <= 60 && s.owner.isAlive() && !me.isFriendly(s.owner)) this.bdLandings.push({ owner: s.owner, troops: s.troops, tile: s.dst, tick: t });
    }
    if (this.bdPostWant !== null && t > this.bdPostWant.until) this.bdPostWant = null;
    // 2. crush the beachhead while it is small: one counter-sized wave per attacker, high priority ("counter"
    // bypasses fightAbove/hold), but NOT in `counters` — a counter auto-retreats once the enemy has no wave on us,
    // and a beachhead wave must run until the blob is gone (manageRetreats' losing/posts tests still apply)
    this.bdLandings = this.bdLandings.filter((l) => t - l.tick < 600 && l.owner.isAlive());
    for (const l of this.bdLandings) {
      const o = l.owner;
      if (me.isFriendly(o) || !me.canAttackPlayer(o) || this.q.outgoingTo(o)) continue;
      if (t - (this.bdCountered.get(o) ?? -1e9) < 300) continue;
      const blob = this.bdBlob(o, l.tile);
      if (blob === null || !blob.touchesUs) continue; // sunk / nothing survived, or not on our border yet — retry next pass
      if (blob.tiles > this.ctx.p.bdBeachheadMax) continue; // established: the generic machinery's problem
      // counterAttack's sizing against the troops that landed; we border only the blob, so the wave IS the beachhead
      // fight (AttackExecution conquers from our border tiles adjacent to the target — its mainland is across water)
      const want = Math.min(Math.ceil(l.troops * 1.05), Math.floor(this.ctx.sit.troops * 0.5));
      const send = this.ctx.send(o.id(), want, "counter", 1000);
      if (send === 0) continue;
      this.bdCountered.set(o, t);
      this.noteSent(o);
      this.ctx.log(`t${t} BEACHHEAD ${o.name()} ${blob.tiles}t at (${mg.x(l.tile)},${mg.y(l.tile)}) ← ${Math.round(send / 1000)}k`);
      this.lim.fire("boatDefense", "beachhead");
    }
  }
  /** The enemy blob at a watched landing: seeded from the nearest tile `o` owns around `at`, flooded over `o`'s
   *  tiles capped at bdBeachheadMax + 1 (a blob that connects by land to its mainland blows the cap — correctly
   *  not a beachhead), noting whether any blob tile touches ours. */
  private bdBlob(o: Player, at: TileRef): { tiles: number; touchesUs: boolean } | null {
    const mg = this.ctx.mg, me = this.ctx.me;
    const ax = mg.x(at), ay = mg.y(at);
    let seed: TileRef | null = null;
    for (let dy = -6; dy <= 6 && seed === null; dy += 2) for (let dx = -6; dx <= 6; dx += 2) {
      if (!mg.isValidCoord(ax + dx, ay + dy)) continue;
      const c = mg.ref(ax + dx, ay + dy);
      if (mg.owner(c) === o) { seed = c; break; }
    }
    if (seed === null) return null;
    const cap = this.ctx.p.bdBeachheadMax + 1;
    const seen = new Set<TileRef>([seed]);
    const q: TileRef[] = [seed];
    let i = 0, touches = false;
    while (i < q.length && seen.size < cap) {
      const c = q[i++];
      for (const n of mg.neighbors(c)) {
        if (!mg.isLand(n)) continue;
        if (mg.owner(n) === me) touches = true;
        if (seen.has(n) || mg.owner(n) !== o) continue;
        seen.add(n); q.push(n);
      }
    }
    return { tiles: seen.size, touchesUs: touches };
  }
  /** `boatDefense` (3): an enemy transport is heading for `tribe` — a tribe that borders us (or sits on our
   *  landmass) is about to become an enemy inside our lines. Click it NOW: harvestBots' sizing and affordability,
   *  but the concurrency queue is jumped (the whole point — the plain rule would wait for a slot). */
  private bdTribeRace(tribe: Player, o: Player, dst: TileRef, t: number): void {
    const me = this.ctx.me;
    if (t - (this.bdRaced.get(tribe) ?? -1e9) < 300) return; // one race per tribe per boat's sail
    const borders = this.q.neighbours().bots.includes(tribe);
    if (!borders && !this.landmass(dst).ours) return; // not in our sphere
    this.bdRaced.set(tribe, t);
    this.ctx.log(`t${t} TRIBE RACE ${tribe.name()} vs ${o.name()}${borders ? "" : " (no land contact — logged only)"}`);
    if (!borders) return; // on our landmass but no shared border: a land click cannot connect
    if (!me.canAttackPlayer(tribe) || !this.reachable(tribe) || this.q.outgoingTo(tribe)) return;
    const want = Math.ceil(tribe.troops() * this.ctx.p.botRatio) + 500;
    if (want > Math.floor(this.ctx.sit.spendable * this.ctx.p.botMaxShare)) return; // harvestBots' affordability gate
    if (this.tribeClick(tribe, want)) this.lim.fire("boatDefense", "race");
  }

  // ---------------------------------------------------------------- fighting rivals
  /** Playbook: a neighbour that has just been bombed or MIRVed is the best target on the map. Troops or land
   *  down by half inside 10 s marks it collapsed for the next 60 s. */
  collapsed(r: Player): boolean {
    const now = this.ctx.mg.ticks();
    const h = this.history.get(r);
    if (h && now - h.tick < 100) return now < h.collapsedUntil;
    const snap = { tick: now, troops: r.troops(), tiles: r.numTilesOwned(), collapsedUntil: h?.collapsedUntil ?? -1 };
    if (h && (r.troops() < h.troops * 0.5 || r.numTilesOwned() < h.tiles * 0.5)) { snap.collapsedUntil = now + 600; this.ctx.log(`t${now} ${r.name()} COLLAPSED ${Math.round(h.troops / 1000)}k→${Math.round(r.troops() / 1000)}k, ${h.tiles}→${r.numTilesOwned()} tiles`); }
    this.history.set(r, snap);
    return now < snap.collapsedUntil;
  }
  private history = new Map<Player, { tick: number; troops: number; tiles: number; collapsedUntil: number }>();

  fight(): void {
    this.pending.clear();
    const pick = this.warPick();
    if (pick !== null && !this.actWar(pick)) return;
    // `multiWar`: the pass goes on while another war fits beside the ones running and the one just opened
    if (!this.ctx.p.multiWar || pick === null) return;
    for (let i = 1; i < MULTI_WAR_SLOTS; i++) { const next = this.warPick(); if (next === null || !this.actWar(next)) return; }
  }
  // ---------------------------------------------------------------- multiWar: the slots and the commitments
  /** Wars opened earlier in this pass (target → wave): not yet in outgoingAttacks(), so counted here. */
  private pending = new Map<Player, number>();
  /** `multiWar`: troops committed to the running non-bot, non-counter wars (attackStart's send, else what is left of
   *  the wave) plus this pass's pending waves. */
  private committed(nonBot: Attack[]): number {
    let sum = 0;
    for (const a of nonBot) if (!this.counters.has(a.target() as Player)) sum += this.attackStart.get(a.id())?.sent ?? a.troops();
    for (const w of this.pending.values()) sum += w;
    return sum;
  }
  /** The decision half of the war rule: gates, candidates, the scorer and the wave size.
   *  Returns the war fight() would open now, or null. Side effects are the log and the flag counters only. */
  private warPick(): WarPick | null {
    const me = this.ctx.me;
    const cap = this.q.cap();
    const nb = this.q.neighbours();
    for (const r of nb.rivals) this.collapsed(r);
    const gapOwner = this.splitOwner && this.splitOwner.isAlive() && nb.rivals.includes(this.splitOwner) ? this.splitOwner : null;
    const threatHere = this.ctx.sit.mode === "hold" ? nb.rivals.find((r) => this.ctx.sit.threats.includes(r)) ?? null : null;
    // `annexWars`: an unfriendly neighbour we hold most of the border of is an opportunity like the gap owner — we
    // attack from most of its border and nobody can reinforce it, so 1.2× is enough and the usual gates do not apply
    const annex = new Set<Player>();
    if (this.ctx.p.annexWars) for (const r of nb.rivals) if (this.q.annexable(r)) annex.add(r);
    // `duelPush`: the foe of a won duel on our border is an opportunity — the only target left, taken at duelRatio with
    // no affordability / fightAbove gate and beside any counter; the hold's own filter (threats only) still applies
    const duelFoe = this.ctx.sit.duel !== null && nb.rivals.includes(this.ctx.sit.duel) ? this.ctx.sit.duel : null;
    const opportunity = (this.ctx.mg.ticks() >= 3000 && nb.rivals.some((r) => this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5)) || gapOwner !== null || threatHere !== null || annex.size > 0 || duelFoe !== null;
    // crown, not survival: a war is on when we can afford 2× someone's whole army out of the spendable troops,
    // not only when troops reach 70 % of a cap that cities keep raising
    const affordable = this.ctx.mg.ticks() >= this.ctx.p.fightNotBeforeTick && nb.rivals.some((r) => r.troops() * this.ctx.p.fightRatio + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare);
    if (!affordable && !opportunity && me.troops() < cap * this.ctx.p.fightAbove) return null; // a 1.67× push that keeps home healthy is always taken
    if (duelFoe !== null && !affordable && me.troops() < cap * this.ctx.p.fightAbove) this.lim.fire("duelPush", "gate"); // the plain gates would have refused the pass
    const atCapNow = me.troops() >= cap * 0.95;
    // invariant: one war at a time (two at cap); seven at once is how a 17M army evaporates
    const nonBot = this.ctx.sit.outgoing.filter((a) => a.target().isPlayer() && (a.target() as Player).type() !== PlayerType.Bot);
    const wars = nonBot.filter((a) => !this.counters.has(a.target() as Player)).length + this.pending.size;
    const limit = onTheClock(this.ctx.p, this.ctx.mg.ticks()) && atCapNow ? 2 : 1;
    // `multiWar`: a second and third war beside the running ones — a running counter occupies a slot — as long as
    // the wave fits above the reserve and the total committed stays under fightMaxShare of the army
    let extra = false, extraRoom = Infinity;
    if (wars >= limit && !opportunity) {
      if (!this.ctx.p.multiWar) return null;
      const slots = nonBot.length + this.pending.size;
      if (slots >= MULTI_WAR_SLOTS) return null;
      const committed = this.committed(nonBot);
      extraRoom = Math.floor((this.ctx.sit.troops + committed) * this.ctx.p.fightMaxShare - committed);
      if (extraRoom < 1000) return null;
      extra = true;
    }
    const early = !atCapNow && !opportunity && (this.ctx.mg.ticks() < this.ctx.p.fightNotBeforeTick || me.unitsOwned(UnitType.City) < this.ctx.p.fightMinCities);
    let { rivals } = nb;
    // before the 5-minute mark only clear prey: a neighbour we can hit with 2.5× its whole army
    if (early) rivals = rivals.filter((r) => r.troops() * 2.5 <= me.troops() * this.ctx.p.fightMaxShare && r.numTilesOwned() <= me.numTilesOwned());
    // the running war's target is forgotten only when it is dead or no longer an unfriendly neighbour — never because
    // the early prey filter above left it out for a pass (it did, until 2026-08-30, and the sticky-war filter, the
    // embargo bookkeeping and finishByBoat lost the war)
    if (this.currentTarget_ && (!this.currentTarget_.isAlive() || !nb.rivals.includes(this.currentTarget_))) this.currentTarget_ = null;
    if (rivals.length === 0) return null;
    let candidates = rivals.filter((r) => me.canAttackPlayer(r) && !this.q.outgoingTo(r) && !this.pending.has(r) && this.reachable(r));
    // one enemy at a time, to the end: nations nuke whoever attacks them, and eight half-wars make eight nuclear enemies.
    // The current target stays the only candidate while it lives, borders us, and was hit within the last three minutes.
    // `multiWar`: the sticky target binds the first war only; an extra war is by definition on someone else.
    if (!extra && this.currentTarget_ && this.currentTarget_.isAlive() && rivals.includes(this.currentTarget_) && this.ctx.mg.ticks() - this.lastWarTick < 1800) {
      candidates = candidates.filter((r) => r === this.currentTarget_ || this.collapsed(r) || r === gapOwner || r === threatHere || annex.has(r) || r === duelFoe);
    }
    if (this.ctx.sit.mode === "hold") candidates = candidates.filter((r) => this.ctx.sit.threats.includes(r)); // the hold is spent removing whoever can fire
    if (this.ctx.p.trustWars) {
      // C1: never open a war the target's ally next door can join with half our spendable — two nations at once is the troop sink
      candidates = candidates.filter((r) => {
        const ally = this.allyThatCanPileIn(r);
        if (ally !== null && this.ctx.mg.ticks() - (this.pileInLogged.get(r) ?? -1e9) >= 600) { this.pileInLogged.set(r, this.ctx.mg.ticks()); this.ctx.log(`t${this.ctx.mg.ticks()} no war on ${r.name()}: its ally ${ally.name()} could send ${Math.round((this.ctx.sit.rival.get(ally)?.nationWouldSend ?? 0) / 1000)}k at us`); }
        if (ally !== null) this.ctx.fire("trustWars");
        return ally === null;
      });
    }
    if (candidates.length === 0) return null;
    const { score, isOpp, wantFor, richer, yieldBonus, contestBonus } = this.warScorer(gapOwner, threatHere, annex, extra, extraRoom, false, duelFoe);
    let best: Player | null = null, bestS = 0, best0: Player | null = null, bestS0 = 0, bestC: Player | null = null, bestSC = 0;
    for (const r of candidates) { const sc = score(r); if (sc > bestS) { bestS = sc; best = r; } const sc0 = sc - yieldBonus(r); if (sc0 > bestS0) { bestS0 = sc0; best0 = r; } const scC = sc - contestBonus(r); if (scC > bestSC) { bestSC = scC; bestC = r; } }
    if (this.ctx.p.warYield && best !== best0) this.lim.fire("warYield", "pick"); // the cheaper tile changed the pick
    if (this.ctx.p.contestLeader && best !== bestC) this.lim.fire("contestLeader", "pick"); // the +4 changed the pick
    if (best === null) {
      if (atCapNow && this.ctx.mg.ticks() % 1200 < this.ctx.p.expandEvery) this.ctx.log(`t${this.ctx.mg.ticks()} idle at cap: ${rivals.map((r) => `${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k d${Math.round(this.q.density(r))} p${r.units(UnitType.DefensePost).length} ${candidates.includes(r) ? "" : "(no)"}`).join("; ")}`);
      return null;
    }
    const bomb = richer(best) && best !== this.currentTarget_ && me.units(UnitType.MissileSilo).length > 0 && this.ctx.mg.ticks() - this.lastBombTick > 100;
    // `bombPush` (a): EVERY war wave opens with a pre-bomb when a silo is up, the cooldown (the war cadence) has
    // passed and gold covers a bomb above bombReserve — not only a `richer` target (Enzo: bombs set up pushes)
    const pushBomb = !bomb && this.ctx.p.bombPush && me.units(UnitType.MissileSilo).length > 0
      && this.ctx.mg.ticks() - this.lastBombTick >= this.ctx.p.bombWarEvery
      && this.ctx.sit.gold >= this.ctx.mg.config().unitInfo(UnitType.AtomBomb).cost(this.ctx.mg, me) + BigInt(this.ctx.p.bombReserve);
    return { r: best, want: wantFor(best), bomb: bomb || pushBomb, pushBomb, opportunity: isOpp(best), annex: annex.has(best), extra };
  }
  /** The scorer half of warPick, shared with wouldTarget(): the gates on ratio / posts / density / size and every
   *  bonus. `quiet` skips the flag counters (a what-if question, not a decision). */
  private warScorer(gapOwner: Player | null, threatHere: Player | null, annex: Set<Player>, extra = false, extraRoom = Infinity, quiet = false, duelFoe: Player | null = null) {
    const me = this.ctx.me, cap = this.q.cap();
    const atCap = me.troops() >= cap * 0.95;
    const endgame = onTheClock(this.ctx.p, this.ctx.mg.ticks()) || this.ctx.sit.mode === "push"; // 25:00 (clockTicks − 3000) or the push — land now is worth more than troops later
    const trustBonus = (r: Player) => { const b = this.ctx.p.trustWars ? 2 * (1 - (this.ctx.sit.rival.get(r)?.trust ?? 0.5)) : 0; if (b !== 0 && b !== 1 && !quiet) this.ctx.fire("trustWars"); return b; }; // C1: a rival that broke faith is the better target
    // At cap every troop above the line is wasted growth, so commit more and accept a thinner edge.
    // `multiWar`: an extra war is sized from what is left this pass, inside the army-wide share
    const maxSend = extra ? Math.min(extraRoom, Math.floor(this.ctx.sit.troops * (atCap || endgame ? 0.7 : this.ctx.p.fightMaxShare))) : Math.floor(me.troops() * (atCap || endgame ? 0.7 : this.ctx.p.fightMaxShare));
    const minRatio = atCap || endgame ? 1.2 : this.ctx.p.fightRatio;
    const richer = (r: Player) => this.q.cap() >= this.ctx.mg.config().maxTroops(r) * 2 && this.ctx.sit.gold >= 1_000_000n; // we replace losses, they cannot
    const attackingUs = new Set(me.incomingAttacks().map((a) => a.attacker()));
    // `warYield`: a tile that will cost few troops is worth up to +4 (zero from yieldMaxTroopsPerTile up)
    const yieldBonus = (r: Player) => this.ctx.p.warYield ? 4 * clamp(1 - this.expectedCost(r) / this.ctx.p.yieldMaxTroopsPerTile, 0, 1) : 0;
    // `contestLeader`: the runaway leader on our border is the war that matters — +4, the planned-target weight.
    // The gates (ratio, posts, density, size) keep their say: a bonus opens no war the army cannot carry.
    const contestBonus = (r: Player) => (this.ctx.p.contestLeader && r === this.ctx.sit.contest ? 4 : 0);
    // `nationMirvAware`: (3) the denial guard — in hold mode (or push with a threat left) a war whose tiles would carry
    // our share to the denial line − 0.01 is refused unless the target is the last MIRV-capable rival (taking it ends
    // the hold); (2c) the steamroll guard — while a nation can fire, a target whose city units would carry us over the
    // steamroll line (it leaves the ranking, its cities join ours) is refused unless it is the only MIRV-capable rival
    // or an opportunity (collapsed / gap / threatHere / annex, returned above it)
    const aware = this.ctx.p.nationMirvAware;
    const denialGuard = aware && (this.ctx.sit.mode === "hold" || (this.ctx.sit.mode === "push" && this.ctx.sit.threats.length > 0));
    const steamrollGuard = aware && this.risk.armed(); // a nation can fire or is within half the price of it
    const lastThreat = (r: Player) => this.ctx.sit.threats.length === 1 && this.ctx.sit.threats[0] === r;
    const guard = (r: Player, site: string, line: string): number => { if (!quiet) { this.lim.fire("nationMirvAware", site); const now = this.ctx.mg.ticks(); if (now - (this.lastGuardLog.get(`${site}/${r.id()}`) ?? -1e9) >= 600) { this.lastGuardLog.set(`${site}/${r.id()}`, now); this.ctx.log(`t${now} no war on ${r.name()}: ${line}`); } } return -1; };
    const scoreBase = (r: Player) => {
      const ratio = maxSend / Math.max(1, r.troops());
      if (denialGuard && !lastThreat(r)) { const d = this.risk.denial(r.numTilesOwned()); if (d.share >= d.threshold - 0.01) return guard(r, "denial", `its ${r.numTilesOwned()} tiles would carry our share to ${(d.share * 100).toFixed(1)} % (denial at ${(d.threshold * 100).toFixed(0)} %)`); }
      if (this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5) return ratio >= 1.5 ? 20 + ratio : -1; // bombed: go now at 1.5×, posts are gone
      if (r === gapOwner) return ratio >= 1.2 ? 30 + ratio : -1; // they are cutting our land in two: reconnect before the piece is handed over
      if (r === threatHere) return ratio >= 1.5 ? 25 + ratio : -1; // a MIRV-capable rival next door during the hold
      if (annex.has(r)) return ratio >= 1.2 ? 25 + ratio : -1; // `annexWars`: encircled — we come from most of its border, it cannot be reinforced
      if (steamrollGuard && !lastThreat(r)) { const s = this.risk.steamroll(r.unitCount(UnitType.City), r); if (s.over) return guard(r, "steamroll", `its ${r.unitCount(UnitType.City)} cities would carry us over the steamroll line (${s.units} vs ${s.threshold})`); }
      // `duelPush`: the foe of a won duel goes at duelRatio (the endgame ratio) — the posts / thin-empire gates and the
      // bonuses (contestLeader's +4 among them: the foe is usually the leader, and an opportunity rank needs no bonus)
      // do not apply; the MIRV guards above keep their say
      if (r === duelFoe) { if (!quiet) this.lim.fire("duelPush", "score"); return ratio >= this.ctx.p.duelRatio ? 22 + ratio : -1; }
      if (this.ctx.p.warYield && this.ctx.mg.ticks() - (this.yieldRetreatAt.get(r) ?? -1e9) < YIELD_COOLDOWN) return -1; // `warYield`: its tiles were too dear a minute ago
      // at cap, a neighbour already attacking us is a fair fight at 1:1 — the counter-attack cancels its wave anyway
      const need = atCap && attackingUs.has(r) ? 1.0 : richer(r) ? Math.min(minRatio, 1.5) : minRatio;
      if (ratio < need) return -1;
      // Playbook: never attack a big, thinly held empire — that is a troop sink. Prefer small and dense.
      if (ratio < 3 && r.numTilesOwned() > me.numTilesOwned() * 1.5 && this.q.density(r) < 40) return -1;
      const buildings = r.units(UnitType.City).length * 3 + r.units(UnitType.Port).length * 2 + r.units(UnitType.MissileSilo).length * 3;
      const posts = r.units(UnitType.DefensePost).length;
      if (posts > 0 && ratio < 1.5) return -1;
      const sizePenalty = r.numTilesOwned() / Math.max(1, me.numTilesOwned());
      // Playbook: hit players who are already being hit, traitors (half defence), and the ally we let lapse.
      const underFire = r.incomingAttacks().reduce((acc, a) => acc + a.troops(), 0) / Math.max(1, r.troops());
      const bonus = Math.min(underFire, 1) * 4 + (r.isTraitor() ? 2 : 0) + (r === this.plannedTarget() ? 4 : 0);
      return ratio * 2 + buildings + Math.min(this.q.density(r), 200) / 50 - posts * 3 - sizePenalty * 2 + bonus + (r === this.currentTarget_ ? 3 : 0) + trustBonus(r) + yieldBonus(r) + contestBonus(r);
    };
    const isOpp = (r: Player) => (this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5) || r === gapOwner || r === threatHere || annex.has(r) || r === duelFoe;
    const score = scoreBase;
    // the wave: 1.5× on a richer target, 1.2× on an annexable one, else fightRatio
    const wantFor = (r: Player) => { const mult = r === duelFoe ? Math.min(this.ctx.p.fightRatio, this.ctx.p.duelRatio) : annex.has(r) ? Math.min(this.ctx.p.fightRatio, 1.2) : richer(r) ? Math.min(this.ctx.p.fightRatio, 1.5) : this.ctx.p.fightRatio; return Math.min(Math.ceil(r.troops() * mult) + 1000, maxSend); };
    return { score, isOpp, wantFor, richer, yieldBonus, contestBonus };
  }
  /** `lapseToAttack`: would the war rule take `p` if it were an unfriendly neighbour right now? The same gates as
   *  warPick — affordable out of spendable × fightMaxShare (or an opportunity, or troops above fightAbove × cap),
   *  the early 2.5× prey filter, reachability — and the same scorer (ratio, posts, density, size, every bonus),
   *  with the flag counters muted. `score` is the scorer's value (0 when refused), comparable across players. */
  wouldTarget(p: Player): { ok: boolean; score: number } {
    const me = this.ctx.me, cap = this.q.cap(), now = this.ctx.mg.ticks();
    if (!p.isAlive() || p.type() === PlayerType.Bot || p === me || !this.reachable(p)) return { ok: false, score: 0 };
    if (!me.isFriendly(p) && !me.canAttackPlayer(p)) return { ok: false, score: 0 };
    const annex = new Set<Player>();
    if (this.ctx.p.annexWars && this.q.annexable(p)) annex.add(p);
    const affordable = now >= this.ctx.p.fightNotBeforeTick && p.troops() * this.ctx.p.fightRatio + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare;
    const opportunity = annex.size > 0 || (now >= 3000 && this.collapsed(p) && p.troops() < this.ctx.sit.troops * 0.5);
    if (!affordable && !opportunity && me.troops() < cap * this.ctx.p.fightAbove) return { ok: false, score: 0 };
    const atCapNow = me.troops() >= cap * 0.95;
    const early = !atCapNow && !opportunity && (now < this.ctx.p.fightNotBeforeTick || me.unitsOwned(UnitType.City) < this.ctx.p.fightMinCities);
    if (early && !(p.troops() * 2.5 <= me.troops() * this.ctx.p.fightMaxShare && p.numTilesOwned() <= me.numTilesOwned())) return { ok: false, score: 0 };
    if (this.ctx.sit.mode === "hold" && !this.ctx.sit.threats.includes(p)) return { ok: false, score: 0 };
    const sc = this.warScorer(null, null, annex, false, Infinity, true).score(p);
    return { ok: sc > 0, score: Math.max(0, sc) };
  }
  /** The action half of the war rule: the embargo, the wave (whole or not at all), the log, the calibration record,
   *  the mark. Returns true when a wave went. */
  private actWar(pick: WarPick): boolean {
    const me = this.ctx.me, r = pick.r, now = this.ctx.mg.ticks();
    if (pick.bomb && !this.ctx.p.bombPush) {
      this.currentTarget_ = r; this.maybeBomb(now); // open the war with a bomb on their cluster
      if (this.lastBombTick === now) this.bombWarAt = now; // `fastSilo`: the first bomb-opened war unlocks the second silo
    }
    if (pick.want < 1000) return false;
    if (!pick.extra) this.currentTarget_ = r; // `multiWar`: the sticky target stays the first war's
    this.counters.delete(r); // a war wave, whatever the counter before it did
    if (!me.hasEmbargoAgainst(r) && r.type() !== PlayerType.Nation) { me.addEmbargo(r, false); this.embargoedAt_.set(r, now); }
    const want = this.ctx.send(r.id(), pick.want, "war", 1000, 0.3);
    if (want === 0) return false;
    if (pick.bomb && this.ctx.p.bombPush) {
      // `bombPush` (a): the pre-bomb goes the pass the wave actually leaves (a held wave must not waste a bomb),
      // aimed at THIS target's cluster nearest our shared border — the plain path's maybeBomb (above) chases the
      // best cluster among all bomb enemies of the moment instead
      this.preBomb(pick, now);
      if (this.lastBombTick === now) this.bombWarAt = now; // `fastSilo`: the first bomb-opened war unlocks the second silo
    }
    if (!pick.extra) this.lastWarTick = now;
    this.noteSent(r);
    this.pending.set(r, want);
    if (pick.extra) { this.ctx.fire("multiWar"); this.ctx.log(`t${now} WAR #${this.pending.size + this.ctx.sit.outgoing.filter((a) => a.target().isPlayer() && (a.target() as Player).type() !== PlayerType.Bot).length} beside the running ones`); }
    if (pick.annex) { this.ctx.log(`t${now} ANNEX WAR ${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k ← ${Math.round(want / 1000)}k (${(want / Math.max(1, r.troops())).toFixed(2)}×): we hold most of its border`); this.lim.fire("annexWars", "war"); }
    this.ctx.log(`t${now} ATTACK ${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k ← ${Math.round(want / 1000)}k (${(want / Math.max(1, r.troops())).toFixed(2)}×)`);
    this.noteWave(r, want);
    return true;
  }

  // ---------------------------------------------------------------- per-war accounting (WAR RESULT, warYield)
  private calib = new Map<Player, CalibRecord>();
  /** A war wave or a tribe's first click opens a record; trackCalibration() follows it and logs WAR RESULT. */
  private noteWave(t: Player, troops: number): void {
    if (this.calib.has(t)) { this.noteFollowUp(t, troops); return; } // a second war wave merges into the running attack (AttackExecution.init)
    const now = this.ctx.mg.ticks();
    this.calib.set(t, { tick: now, sent: troops, tiles0: t.numTilesOwned(), last: troops, seen: false, retreating: false, y: { tick: now, tiles: 0, lost: 0, tilesAt: t.numTilesOwned(), troopsAt: troops, sentAt: troops, win: [] } });
  }
  private noteFollowUp(t: Player, troops: number): void { const c = this.calib.get(t); if (c) c.sent += troops; }
  /** Every 10 ticks (from manageRetreats): follow each recorded wave; when its attack has left outgoingAttacks()
   *  log WAR RESULT for a non-bot target — tiles attributable to us, troops that did not come back, troops/tile. */
  private trackCalibration(): void {
    const now = this.ctx.mg.ticks();
    for (const [t, c] of this.calib) {
      const a = this.q.outgoingTo(t);
      if (a !== undefined) { c.seen = true; c.last = a.troops(); if (a.retreating()) c.retreating = true; if (now - c.y.tick >= YIELD_EVERY) this.sampleYield(c, t, a.troops()); continue; }
      if (!c.seen && now - c.tick <= 12) continue;
      if (t.type() !== PlayerType.Bot && c.seen) {
        // WAR RESULT (always on): the war's return — tiles attributable to us, troops that did not come back (a
        // recalled wave gets RETREAT_MALUS of its survivors home), the price of a tile, the war's length
        const left = c.last;
        this.sampleYield(c, t, left, true);
        const lost = Math.max(0, Math.round(c.sent - left * (c.retreating && t.isAlive() ? RETREAT_MALUS : 1)));
        const cost = lost / Math.max(1, c.y.tiles);
        this.ctx.log(`t${now} WAR RESULT ${t.name()}: +${c.y.tiles} tiles, -${lost} troops, ${c.y.tiles === 0 ? "inf" : Math.round(cost)} troops/tile, ${Math.round((now - c.tick) / 10)} s`);
        if (lost >= YIELD_MIN_LOST) this.yieldSeen.set(t, c.y.tiles === 0 ? YIELD_COST_CAP : Math.min(YIELD_COST_CAP, cost));
      }
      this.calib.delete(t);
    }
  }

  /** The target's most recent measured troops/tile against us (WAR RESULT), read by the `warYield` scorer. */
  private yieldSeen = new Map<Player, number>();
  /** `warYield`: tick of the last YIELD retreat per target — the scorer refuses it for YIELD_COOLDOWN ticks unless it
   *  becomes an opportunity, or the sticky target would re-declare the same dear war the pass the wave is home. */
  private yieldRetreatAt = new Map<Player, number>();
  /** One sample of a running war: the target's tile drop since the last sample, ours in proportion to our attack's
   *  share of the troops attacking it (all of it while ours is the only one; `final`: after ours is gone, its last
   *  troop count against whoever is still on the target), and the troops the attack lost since then (the
   *  follow-ups merged into it count as sent). */
  private sampleYield(c: CalibRecord, t: Player, troopsNow: number, final = false): void {
    const y = c.y, now = this.ctx.mg.ticks();
    let ours = final ? troopsNow : 0, all = final ? troopsNow : 0;
    for (const x of t.incomingAttacks()) { all += x.troops(); if (x.attacker() === this.ctx.me) ours += x.troops(); }
    const share = all > 0 ? ours / all : 1;
    const tiles = Math.round(Math.max(0, y.tilesAt - t.numTilesOwned()) * share);
    const lost = Math.max(0, y.troopsAt + (c.sent - y.sentAt) - troopsNow);
    y.tiles += tiles; y.lost += lost;
    y.win.push({ tiles, lost }); if (y.win.length > YIELD_WINDOW) y.win.shift();
    y.tilesAt = t.numTilesOwned(); y.troopsAt = troopsNow; y.sentAt = c.sent; y.tick = now;
  }
  /** `warYield`: the running cost of the war on `t` over the last YIELD_WINDOW samples, or null before the window
   *  is full or while it cost fewer than YIELD_MIN_LOST troops (Infinity = troops lost, no tile taken). */
  runningCost(t: Player): number | null {
    const c = this.calib.get(t);
    if (!c || c.y.win.length < YIELD_WINDOW) return null;
    let tiles = 0, lost = 0;
    for (const w of c.y.win) { tiles += w.tiles; lost += w.lost; }
    if (lost < YIELD_MIN_LOST) return null;
    return tiles === 0 ? Infinity : lost / tiles;
  }
  /** `warYield`: what a tile of `r` is expected to cost us — its last measured troops/tile, else its density × 1.3
   *  (Config.attackLogic: altAttackerLoss = 1.3 × defenderTroopLoss × mag/100, defenderTroopLoss = troops/tiles). */
  expectedCost(r: Player): number {
    return this.yieldSeen.get(r) ?? this.q.density(r) * 1.3;
  }

  // ---------------------------------------------------------------- allies that can pile in (trustWars)
  private pileInLogged = new Map<Player, number>();
  /** A living ally of `r` on our border whose nation rules would let it attack us now (RivalView.nationCanAttack)
   *  with at least half our spendable troops; null when no such ally exists. Our own allies never qualify
   *  (nationCanAttack is false for friends). */
  allyThatCanPileIn(r: Player): Player | null {
    for (const a of r.allies()) {
      if (!a.isAlive()) continue;
      const v = this.ctx.sit.rival.get(a);
      if (v && v.nationCanAttack && v.nationWouldSend >= this.ctx.sit.spendable * 0.5) return a;
    }
    return null;
  }

  /** Bring a wave home. Player.orderRetreat() only flags the attack; the troops return when a RetreatExecution
   *  runs executeRetreat() 20 ticks later, so that execution is scheduled here (once: a wave already flagged is
   *  skipped). Until 2026-08-29 the bot called orderRetreat() directly and every retreat froze forever (A1
   *  finding); fixing it was the largest single gain of the rebuild — ladder1, 45 paired 30-min games on a
   *  shifted grid: retreats off = 1 crown vs 11, 13W-32L, p = 0.007 (docs/PlaybookBotPlan.md, Ladder). */
  retreat(a: Attack): void {
    if (a.retreating() || a.retreated()) return;
    this.ctx.mg.addExecution(new RetreatExecution(this.ctx.me, a.id()));
  }

  private attackStart = new Map<string, { sent: number; targetTroops: number }>();
  private counters = new Set<Player>();
  manageRetreats(): void {
    const me = this.ctx.me;
    this.trackCalibration();
    // a counter wave that is gone (cancelled troop-for-troop by AttackExecution, or home) leaves `counters`: the entry
    // used to survive and a later real war on that player was recalled as a 'counter done'. A counter sent this pass
    // is not in outgoingAttacks() before its execution inits, hence the 20-tick grace after lastCounter.
    for (const p of this.counters) if (!this.q.outgoingTo(p) && this.ctx.mg.ticks() - (this.lastCounter.get(p) ?? -1e9) > 20) this.counters.delete(p);
    for (const a of me.outgoingAttacks()) {
      const t = a.target();
      if (!t.isPlayer() || t.type() === PlayerType.Bot) continue;
      if (a.retreating() || a.retreated()) continue;
      // a counter-attack exists to cancel a wave; once the wave is gone, bring the rest home rather than dying in their land
      if (this.counters.has(t) && t !== this.currentTarget_ && !me.incomingAttacks().some((x) => x.attacker() === t)) {
        this.retreat(a);
        this.counters.delete(t);
        this.ctx.log(`t${this.ctx.mg.ticks()} counter done vs ${t.name()}, ${Math.round(a.troops() / 1000)}k coming home`);
        continue;
      }
      let st = this.attackStart.get(a.id());
      if (!st) { st = { sent: a.troops(), targetTroops: t.troops() }; this.attackStart.set(a.id(), st); }
      // `warYield`: a war buying its tiles too dear (the last 200 ticks over yieldMaxTroopsPerTile) comes home —
      // unless the target is collapsing, encircled or cutting our land in two, where the tiles are the point
      if (this.ctx.p.warYield && !this.counters.has(t)) {
        const cost = this.runningCost(t);
        if (cost !== null && cost > this.ctx.p.yieldMaxTroopsPerTile && !this.collapsed(t) && !(this.ctx.p.annexWars && this.q.annexable(t)) && t !== this.splitOwner) {
          this.retreat(a);
          this.yieldRetreatAt.set(t, this.ctx.mg.ticks());
          this.lim.fire("warYield", "retreat", 1);
          this.ctx.log(`t${this.ctx.mg.ticks()} YIELD retreat from ${t.name()}: ${cost === Infinity ? "inf" : Math.round(cost)} troops/tile (${Math.round(a.troops() / 1000)}k left)`);
          continue;
        }
      }
      // Retreat only when we are losing: most of the wave is gone while the target has barely bled.
      const losing = a.troops() < st.sent * 0.2 && t.troops() > st.targetTroops * 0.7;
      const posts = t.units(UnitType.DefensePost).length > 0 && a.troops() < st.sent * 0.5 && t.troops() > st.targetTroops * 0.9;
      if (losing || posts) {
        this.retreat(a);
        this.ctx.log(`t${this.ctx.mg.ticks()} retreat from ${t.name()} (${Math.round(a.troops() / 1000)}k left)`);
      }
    }
  }

  // ---------------------------------------------------------------- boats
  /** `boatOpening`: which landmass does `t` sit on, and do we own tiles on it? Breadth-first over land from `t`,
   *  capped at OPENING_LANDMASS_TILES; every tile the fill touches is labeled into a per-tick map, so candidates on
   *  one mass share an id and can be deduped to the nearest shore. v4: a mass the fill cannot finish (`capped`) is
   *  NOT a known second continent — v2 counted it as distinct, which handed the far arctic coast of our own
   *  225k-tile mainland the ×OPENING_NEW_MASS and ×boatOceanBonus multipliers every game (Josh's magnet; the
   *  launch-time across-water check keeps refusing anything a land attack could reach, so such a coast is still a
   *  target — it just wins on real worth or not at all). Per tick, not per opening: ownership moves — once we land
   *  on the mass it must stop reading as a second continent. */
  private massCache: { tick: number; label: Map<TileRef, number>; ours: boolean[]; capped: boolean[] } | null = null;
  private landmass(t: TileRef): { id: number; ours: boolean; capped: boolean } {
    const tick = this.ctx.mg.ticks();
    if (this.massCache === null || this.massCache.tick !== tick) this.massCache = { tick, label: new Map(), ours: [], capped: [] };
    const { label, ours, capped } = this.massCache;
    const got = label.get(t);
    if (got !== undefined) return { id: got, ours: ours[got], capped: capped[got] };
    const mg = this.ctx.mg, me = this.ctx.me;
    const id = ours.length;
    let mine = false;
    const q: TileRef[] = [t];
    label.set(t, id);
    let i = 0, seen = 1;
    while (i < q.length && seen < OPENING_LANDMASS_TILES) {
      const c = q[i++];
      if (mg.owner(c) === me) mine = true;
      for (const n of mg.neighbors(c)) { if (!label.has(n) && mg.isLand(n)) { label.set(n, id); q.push(n); seen++; } }
    }
    ours.push(mine);
    capped.push(i < q.length); // the fill gave up with tiles still queued: the mass's edge was never seen
    return { id, ours: mine, capped: capped[id] };
  }
  /** `boatOpening` v5: is the free basin at `t` walled off from our territory by other players' land? Breadth-
   *  first from `t` over land tiles no other player owns (unowned and ours pass), capped at OPENING_REACH_TILES;
   *  meeting a tile of ours means land expansion can walk there — the boatOwnMassFactor penalty applies. A fill
   *  that exhausts without meeting us is cut off behind rivals (boat-worthy — the escape hatch lifts the
   *  penalty); a fill that hits the cap is undecided and treated as land-reachable (conservative, like
   *  landmass()'s `capped` — open wilderness that large is exactly what land expansion eats). Cached per tile
   *  for WATER_CACHE_TICKS: rivals close in and ownership moves. */
  private cutOffCache = new Map<TileRef, { tick: number; cutOff: boolean }>();
  private openingCutOff(t: TileRef): boolean {
    const got = this.cutOffCache.get(t);
    if (got !== undefined && this.ctx.mg.ticks() - got.tick < WATER_CACHE_TICKS) return got.cutOff;
    const mg = this.ctx.mg, me = this.ctx.me;
    const seen = new Set<TileRef>([t]);
    const q: TileRef[] = [t];
    let i = 0, reached = false;
    while (i < q.length && seen.size < OPENING_REACH_TILES) {
      const c = q[i++];
      if (mg.owner(c) === me) { reached = true; break; }
      for (const n of mg.neighbors(c)) {
        if (seen.has(n) || !mg.isLand(n)) continue;
        const o = mg.owner(n);
        if (o !== me && o.isPlayer()) continue; // another player's land blocks the walk
        seen.add(n); q.push(n);
      }
    }
    const cutOff = !reached && i >= q.length; // exhausted without meeting us: walled off; capped: undecided → land-reachable
    this.cutOffCache.set(t, { tick: this.ctx.mg.ticks(), cutOff });
    return cutOff;
  }
  /** `boatOpening` v6: the eat rate the opening prices a sail with — Hard/Impossible defenders get +33/+50 %
   *  troops and nations expand at full rate, so the Medium-measured boatEatRate underestimates there (Josh's
   *  Hard GUI sessions: landings on shores the tribes ate first). Medium/Easy keep boatEatRate. */
  private eatRate(): number {
    const d = this.ctx.mg.config().gameConfig().difficulty;
    return d === Difficulty.Hard || d === Difficulty.Impossible ? this.ctx.p.boatEatRateHard : this.ctx.p.boatEatRate;
  }
  /** `boatOpening`: free land behind a landing (Situation.basinContact — the spawn picker's flood, radius
   *  boatBasinRadius, cap OPENING_BASIN_TILES) plus the eaters on its perimeter, cached per candidate tile for
   *  WATER_CACHE_TICKS: basins only shrink as the world fills in, but the contact count grows as rivals close in,
   *  and the v3 discount must not read a tick-60 perimeter at tick 800. v6 collects the eater and shore tiles
   *  themselves (bounded — see basinContact) for the landing-eaten re-anchor. */
  private basinCache = new Map<TileRef, { tick: number; tiles: number; contact: number; eaters: readonly TileRef[]; shores: readonly TileRef[] }>();
  private openingBasin(t: TileRef): { tiles: number; contact: number; eaters: readonly TileRef[]; shores: readonly TileRef[] } {
    const got = this.basinCache.get(t);
    if (got !== undefined && this.ctx.mg.ticks() - got.tick < WATER_CACHE_TICKS) return got;
    const b = { tick: this.ctx.mg.ticks(), ...basinContact(this.ctx.mg, this.ctx.me, t, this.ctx.p.boatBasinRadius, OPENING_BASIN_TILES, true) };
    this.basinCache.set(t, b);
    return b;
  }
  /** `boatOpening`: a landing whose free land a tribe ate before the wave finished must not strand the beachhead
   *  (the transport's AttackExecution targets the LAUNCH-time owner — terra nullius — and fizzles on a shore that
   *  is tribe-owned by arrival). Each opening landing is watched OPENING_PUSH_TICKS; when a tribe owns the landing
   *  tile (or borders the beachhead around it), it is clicked like harvestBots would — botRatio + 500 in total,
   *  botClickCap of home now, the usual send() gates, one wave per tribe (outgoingTo). */
  private openingLandings: { tile: TileRef; tick: number }[] = [];
  /** v4: landings a tribe ate — failed magnets. The opening scorer refuses new candidates within boatBasinRadius
   *  of one for the rest of the opening (the committed wave is pushed; the coast is not re-fed from home). */
  private openingFailed: TileRef[] = [];
  private openingPush(): void {
    const mg = this.ctx.mg, me = this.ctx.me;
    this.openingLandings = this.openingLandings.filter((l) => this.ctx.sit.tick - l.tick < OPENING_PUSH_TICKS);
    for (const l of this.openingLandings) {
      const tribe = this.landingTribe(l.tile);
      if (tribe !== null && !this.openingFailed.includes(l.tile)) this.openingFailed.push(l.tile);
      if (tribe === null || !me.canAttackPlayer(tribe) || !this.reachable(tribe) || this.q.outgoingTo(tribe)) continue;
      // no botMaxShare/concurrency gate: the boat is already committed over there — tribeClick's botClickCap
      // and send()'s reserve are the limits, as for a wave that just fights on
      const want = Math.ceil(tribe.troops() * this.ctx.p.botRatio) + 500;
      if (!this.tribeClick(tribe, want)) continue;
      this.lim.fire("boatOpening", "push");
      this.ctx.log(`t${mg.ticks()} BOAT OPENING push → tribe ${tribe.name()} took the landing at ${mg.x(l.tile)},${mg.y(l.tile)}`);
    }
  }
  /** The tribe to push from the beachhead at `t`: a bounded walk over land around the landing must find BOTH a
   *  tile of ours (the beachhead — without it the boat has not landed, or nothing survived: a boat aimed at a
   *  tribe-owned shore is tribe-owned at `t` from launch, and must not be pushed while still at sea) and a
   *  tribe among the owners it meets; the cheapest such tribe is returned. */
  private landingTribe(t: TileRef): Player | null {
    const mg = this.ctx.mg, me = this.ctx.me;
    const seen = new Set<TileRef>([t]);
    const q: TileRef[] = [t];
    let i = 0, ours = false, best: Player | null = null;
    const look = (tile: TileRef) => {
      const o = mg.owner(tile);
      if (o === me) { ours = true; return; }
      if (o.isPlayer() && (o as Player).type() === PlayerType.Bot) { const p = o as Player; if (best === null || p.troops() < best.troops()) best = p; }
    };
    look(t);
    while (i < q.length && seen.size < 80) {
      const c = q[i++];
      for (const n of mg.neighbors(c)) {
        if (seen.has(n) || !mg.isLand(n)) continue;
        seen.add(n); q.push(n); look(n);
      }
    }
    return ours ? best : null;
  }
  /** Playbook 0:05–0:10: one 20 % boat to a tribe across water (2× its troops) or, failing that, the nearest empty shore across water.
   *  `boatOpening` calls it again with `opening` for the extra opening boats: same candidate scan, but the head of
   *  the list is re-ranked by what sits behind the landing per tile sailed — worth / max(sail, OPENING_MIN_SAIL),
   *  where worth = the free-land basin minus what its eaters consume during the sail (max(0, basin − boatEatRate ×
   *  contact × sail); the transport sails 1 tile/tick, so sail = arrival ticks) for an empty shore, and
   *  boatTribeWorth × tiles + that discounted basin (×OPENING_CONTESTED with a rival adjacent; tribe tiles are
   *  never discounted) for a tribe mass — one candidate per landmass and kind (the min-sail shore of each mass,
   *  never the far side of a mass across a tiny gap), ×OPENING_NEW_MASS on a landmass we own no tile of (the
   *  second-continent preference, a multiplier not a veto — v4: only when the landmass fill actually finished, a
   *  capped fill is probably our own mainland's far coast). v4 also charges boatOpeningSailCost worth per sail tile
   *  beyond BOAT_MAX_PATH.early, drops candidates below boatOpeningMinScore outright (the extras hold the boat),
   *  and refuses candidates within boatBasinRadius of a landing a tribe ate (openingFailed — the pushed wave is
   *  already committed there). v5: an empty-shore candidate on our OWN landmass (ours or a capped fill) scores
   *  ×boatOwnMassFactor — land expansion reaches our own coast free — unless openingCutOff finds its basin
   *  walled off from us by other players' land (tribe candidates exempt). Every boat is capped at boatShare of home, each launch
   *  logs BOAT OPENING (with basin=, sail= and own=/blocked=) and fires the flag, and the other boat flags' liveness counters are
   *  left alone (their plain-rule counterfactual does not exist for a boat the plain rule would not have launched). */
  earlyBoat(opening = false): boolean {
    const me = this.ctx.me;
    if (opening) this.openingPush(); // a stranded beachhead is pushed before another boat is considered
    if (me.unitCount(UnitType.TransportShip) >= this.ctx.mg.config().boatMaxNumber()) return false;
    const shore = borderOf(me).filter((t) => this.ctx.mg.isShore(t));
    if (shore.length === 0) return false;
    const from = shore[Math.floor(shore.length / 2)];
    const fx = this.ctx.mg.x(from), fy = this.ctx.mg.y(from);
    const distOld = (t: TileRef) => Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
    const sample = this.ctx.p.boatsNearest ? this.shoreSample() : []; // `boatsNearest`: see seaExpansion
    const nearest = sample.length > 0;
    const dist = nearest ? (t: TileRef) => this.nearestShoreDist(t, sample) : distOld;
    // `boatsWaterPath`: rank by the path the ship sails (d), refuse beyond BOAT_MAX_PATH.early; dm is the
    // straight-line distance (slOk: the straight-line ranking's candidates, for the liveness count).
    // `boatOpening` v6: the OPENING extras always rank by the true water path, whatever boatsWaterPath says —
    // the straight-line sail understated a crossing that rounds a river mouth or a peninsula, and Josh watched
    // the openings land on the far side of one (the sail term AND the eta discount both need arrival ticks, and
    // the transport sails the water path, not the chord). boatsWaterPath's own rule — the plain first boat and
    // the mid-game rules — is untouched (and off: rm1 showed the RANKING hurts there; here the path only prices
    // a candidate the opening scorer already chose to compare). A shore no water path reaches within
    // WATER_MAX_DIST is no candidate at all.
    const wp = this.ctx.p.boatsWaterPath || opening ? this.waterPath() : null;
    // with the flag on, our own coast is near by water too (a tile 40 tiles up it sails 40), so more candidates are
    // tried and the bounded breadth-first acrossWaterNear (radius 2 × dm + 20) does the land check — the depth-first
    // acrossWater gives up at 4000 tiles and calls a tile up our own coast "across water" on a big landmass
    const across = (t: TileRef, dm: number) => (nearest || wp ? this.q.acrossWaterNear(t, dm) : this.q.acrossWater(t));
    // `boatOpening` v6 escalating sail budget (replaces v3's boatOceanUntil ocean window — Josh: "close boats
    // very early, then further and further attempts before warships are everywhere"): the extras may sail up to
    // maxSail(t) = boatSailMin + (WATER_MAX_DIST − boatSailMin) × clamp(t / boatSailRampTicks, 0, 1) water
    // tiles — ~boatSailMin at spawn, the full BOAT_MAX_PATH (250) once warships are due (first enemy warship
    // t1489–t2205 across the 6 measurement games). The plain first boat keeps the plain 80-tile cap; wave
    // sizes (boatShare) are unchanged.
    const ramp = Math.min(1, Math.max(0, this.ctx.sit.tick / Math.max(1, this.ctx.p.boatSailRampTicks)));
    const earlyCap = opening ? Math.round(this.ctx.p.boatSailMin + (WATER_MAX_DIST - this.ctx.p.boatSailMin) * ramp) : BOAT_MAX_PATH.early;
    const cands: { tile: TileRef; troops: number; d: number; dm: number; sail: number; tribeTiles: number; contested: boolean; slOk: boolean; oldD: number; oldOk: boolean; what: string; moved?: boolean }[] = [];
    // `boatOpening` contested check: the rivals (nations/humans) whose borders tell us a tribe's wilderness is being eaten
    const rivals = opening ? this.ctx.mg.players().filter((p) => p !== me && p.isAlive() && p.type() !== PlayerType.Bot) : [];
    for (const bot of this.ctx.mg.players()) {
      if (bot.type() !== PlayerType.Bot || !bot.isAlive()) continue;
      const want = Math.ceil(bot.troops() * 2) + 500; // a beach landing costs more than a land attack: 2×, not 1.67×
      // `boatOpening`: an opening boat takes at most boatShare of home — a tribe whose 2× wave would not fit is skipped (the usual ratio, the tighter cap)
      if (want > me.troops() * (opening ? this.ctx.p.boatShare : 0.4)) continue;
      let i = 0, bestT: TileRef | null = null, bestD = 1e9, oldT: TileRef | null = null, oldD = 1e9, slT: TileRef | null = null, slD = 1e9;
      for (const t of borderOf(bot)) {
        if ((i++ % 5) !== 0 || !this.ctx.mg.isShore(t)) continue;
        const dm = dist(t); if (dm < slD) { slD = dm; slT = t; }
        const d = wp ? wp.len(t) : dm; if (d < bestD) { bestD = d; bestT = t; }
        if (nearest) { const dO = distOld(t); if (dO < oldD) { oldD = dO; oldT = t; } }
      }
      if (!nearest) { oldT = slT; oldD = slD; }
      const troops = Math.max(want, Math.floor(me.troops() * this.ctx.p.boatShare));
      // `boatOpening`: a tribe mass is a first-class opening target — its tiles count OPENING_TRIBE_WORTH each in
      // the score, boosted when a rival is adjacent (the wilderness near it is getting eaten either way)
      const tribeTiles = bot.numTilesOwned();
      const contested = opening && rivals.some((r) => bot.sharesBorderWith(r)); // walk the TRIBE's border (small), not the rival's
      const ok = bestT !== null && bestD <= (wp ? earlyCap : 250), slOk = slT !== null && slD <= 250;
      if (ok) cands.push({ tile: bestT!, troops, d: bestD + 80, dm: slD + 80, sail: bestD, tribeTiles, contested, slOk: slOk && slT === bestT, oldD: oldD + 80, oldOk: oldD <= 250 && oldT === bestT, what: `tribe ${bot.name()}` }); // open shore preferred: free land, no losses; a tribe only when no empty coast is near
      if (nearest && oldT !== null && oldD <= 250 && (!ok || oldT !== bestT)) cands.push({ tile: oldT, troops, d: 1e9, dm: slD + 80, sail: 1e9, tribeTiles, contested, slOk: false, oldD: oldD + 80, oldOk: true, what: `tribe ${bot.name()}` }); // the old ranking's tile, for the liveness count only
      if (wp && slOk && (!ok || slT !== bestT)) cands.push({ tile: slT!, troops, d: 1e9, dm: slD + 80, sail: 1e9, tribeTiles, contested, slOk: true, oldD: oldD + 80, oldOk: false, what: `tribe ${bot.name()}` }); // the straight-line ranking's tile, for the liveness count only
    }
    const box = this.scanBox(sample, fx, fy, 200);
    for (let y = box.y0; y <= box.y1; y += 6) for (let x = box.x0; x <= box.x1; x += 6) {
      if (!this.ctx.mg.isValidCoord(x, y)) continue;
      const t = this.ctx.mg.ref(x, y);
      if (!this.ctx.mg.isLand(t) || !this.ctx.mg.isShore(t) || this.ctx.mg.hasOwner(t)) continue;
      const dOld = Math.abs(x - fx) + Math.abs(y - fy);
      const dm = nearest ? dist(t) : dOld;
      if (dm < (opening ? 2 : nearest ? 10 : 30)) continue; // opening: a tiny-gap crossing to a big basin is the point — across() below still refuses anything land-reachable
      const slOk = !(nearest && dm > 200);
      const d = wp ? wp.len(t) : dm;
      if (wp ? d > earlyCap && !slOk : !slOk) continue;
      cands.push({ tile: t, troops: Math.floor(me.troops() * this.ctx.p.boatShare), d: wp && d > earlyCap ? 1e9 : d, dm, sail: wp && d > earlyCap ? 1e9 : d, tribeTiles: 0, contested: false, slOk, oldD: dOld, oldOk: dOld >= 30 && Math.abs(x - fx) <= 200 && Math.abs(y - fy) <= 200 && (x - fx) % 6 === 0 && (y - fy) % 6 === 0, what: "empty shore" });
    }
    cands.sort((a, b) => a.d - b.d);
    const openingScore = new Map<(typeof cands)[number], number>(); // `boatEscort`: an opening pick's score, for the swarm's worth test
    if (opening) {
      // `boatOpening`: rank the head of the list by free land behind the landing per tile sailed (the GUI showed
      // the pure-distance pick ignoring a big wilderness mass for a nearby scrap). One candidate per landmass, the
      // min-sail one — never the far shore of a mass that is just across a tiny gap — then score
      // basin / max(sail, OPENING_MIN_SAIL) with the second-continent preference a ×OPENING_NEW_MASS multiplier,
      // not a veto (v4: the un-scored same-mass shores no longer trail the head as fallbacks — see the splice).
      // v4: a landing a tribe ate (openingPush fired for it) is a failed magnet — the same coast must not be
      // re-fed from home every pass (Josh's GUI: the arctic point re-picked while its pushes churned)
      const head = cands.slice(0, 24).filter((c) => c.d < 1e9 && !this.openingFailed.some((f) => this.ctx.mg.manhattanDist(c.tile, f) <= this.ctx.p.boatBasinRadius));
      // one candidate per (landmass, shore-or-tribe) at its min sail — a tiny near tribe must not mask the mass's
      // free coast and vice versa; the far shore of a mass across a tiny gap never survives its own near shore
      const byMass = new Map<number, { c: (typeof cands)[number]; ours: boolean; capped: boolean }>();
      for (const c of head) { const m = this.landmass(c.tile); const k = m.id * 2 + (c.tribeTiles > 0 ? 1 : 0); const cur = byMass.get(k); if (cur === undefined || c.sail < cur.c.sail) byMass.set(k, { c, ours: m.ours, capped: m.capped }); }
      // v3: a basin is discounted by what its eaters consume before we land — eta = sail ticks (the transport
      // sails 1 tile/tick, TransportShipExecution.ticksPerMove), rate = eatRate() per perimeter tile a
      // rival/tribe touches (v6: boatEatRateHard on Hard/Impossible — the Medium-measured rate underestimated
      // there). Tribe tiles are never discounted (tribes get eaten, they don't evaporate), so a
      // soon-to-be-eaten free basin beside a tribe mass tilts the pick toward the tribe itself.
      const rate = this.eatRate();
      const left = (c: (typeof cands)[number]) => { const b = this.openingBasin(c.tile); return b.tiles - Math.min(b.tiles, rate * b.contact * c.sail); };
      const worth = (c: (typeof cands)[number]) => c.tribeTiles > 0 ? (this.ctx.p.boatTribeWorth * c.tribeTiles + left(c)) * (c.contested ? OPENING_CONTESTED : 1) : left(c);
      // v6: a candidate whose basin is still worth the trip but whose LANDING tile is itself projected eaten by
      // arrival is re-anchored to a safer shore of the same basin, or dropped when none survives — landing INTO
      // a just-taken shore fizzles the wave (the transport targets the LAUNCH-time owner, terra nullius), and
      // that is exactly what Josh keeps watching on Hard. An eater's frontier advances ~rate tiles/tick locally,
      // so a contact tile within rate × sail of a shore owns it by the boat's arrival. Tribe candidates are
      // exempt (their wave targets the tribe itself — it cannot fizzle).
      const nearEater = (eaters: readonly TileRef[], t: TileRef) => { let best = Infinity; for (const e of eaters) { const d = this.ctx.mg.manhattanDist(e, t); if (d < best) best = d; } return best; };
      const anchor = (c: (typeof cands)[number]): boolean => {
        if (c.tribeTiles > 0) return true;
        const b = this.openingBasin(c.tile);
        if (b.tiles - rate * b.contact * c.sail <= 0) return true; // worthless: the score drop below handles it
        if (nearEater(b.eaters, c.tile) >= rate * c.sail) return true; // the landing tile outlives the sail
        let bt: TileRef | null = null, bd = Infinity;
        for (const s of b.shores) {
          if (this.ctx.mg.hasOwner(s)) continue; // taken since the flood ran
          const d = wp!.len(s); // v6: wp is always live while `opening`
          if (d > earlyCap || d >= bd) continue;
          if (nearEater(b.eaters, s) < rate * d) continue; // eaten by ITS arrival too
          bt = s; bd = d;
        }
        if (bt === null) { this.lim.fire("boatOpening", "reanchor"); return false; } // every reachable shore of the basin is gone by arrival: drop
        this.lim.fire("boatOpening", "reanchor");
        c.tile = bt; c.sail = bd; c.d = bd; c.dm = bd; c.moved = true; // dm feeds acrossWaterNear's radius: the water path bounds the chord
        return true;
      };
      // v3 ocean window, v6 inside the sail budget: a new-landmass candidate whose sail the plain 80-tile cap
      // would refuse gets ×boatOceanBonus on top of the second-continent preference — the budget above is what
      // now closes the cheap continent grab as warships appear. v4: neither bonus
      // for a `capped` mass (see landmass()), and every candidate is charged boatOpeningSailCost worth-tiles per
      // sail tile beyond BOAT_MAX_PATH.early — a long crossing locks boatShare of home at sea for sail ticks.
      const cost = (c: (typeof cands)[number]) => this.ctx.p.boatOpeningSailCost * Math.max(0, c.sail - BOAT_MAX_PATH.early);
      // v5: an empty shore on our OWN landmass is (almost) never worth an opening boat — land expansion reaches
      // it free; boats are for genuinely separate masses and tribe masses. `ours || capped` counts as own (a
      // cap-saturated fill is almost always the mainland — conservative, and it mops up acrossWaterNear's
      // saturation ambiguity from the v2 caveat), tribe candidates are exempt (a tribe across a bay on our own
      // mass is still a fine boat), and openingCutOff is the escape hatch: a basin walled off from us by other
      // players' land cannot be reached by land expansion, so a cut-off peninsula behind a rival keeps ×1.
      const factor = (c: (typeof cands)[number], own: boolean) =>
        !own ? OPENING_NEW_MASS * (c.sail > BOAT_MAX_PATH.early ? this.ctx.p.boatOceanBonus : 1)
          : c.tribeTiles > 0 || this.openingCutOff(c.tile) ? 1 : this.ctx.p.boatOwnMassFactor;
      const scoredAll = [...byMass.values()].filter(({ c }) => anchor(c)).map(({ c, ours, capped }) => ({ c, s: ((worth(c) - cost(c)) / Math.max(c.sail, OPENING_MIN_SAIL)) * factor(c, ours || capped) }));
      // v3: a basin the eaters will have consumed before the boat lands is not a target at ANY rank — dropped
      // outright, not down-ranked (a later pass re-scans; the contact count refreshes with the basin cache).
      // v4: an EMPTY-SHORE candidate below boatOpeningMinScore shares that fate — the extras hold the boat rather
      // than feed the junk tail (a tribe candidate is exempt: its 2× wave is affordability-gated already and takes
      // real enemy tiles; far tribe junk still dies to the sail cost above).
      const bad = (x: (typeof scoredAll)[number]) => x.s <= 0 || (x.c.tribeTiles === 0 && x.s < this.ctx.p.boatOpeningMinScore);
      const scored = scoredAll.filter((x) => !bad(x));
      scored.sort((a, b) => b.s - a.s);
      // v4: the launch loop sees ONLY the scored candidates. v3 kept two escape hatches that both leaked exactly
      // the junk the drop refuses — the raw distance-sorted tail (candidates 25+, never scored) surfaced when the
      // floor emptied the head, and the same-mass fallback shores (head entries that are not their mass's
      // min-sail rep, never scored either) launched a 179-tile-sail basin=118 crossing when their rep was dead.
      // A refused or dropped top pick now means the extras hold this pass and re-scan 20 ticks later.
      cands.splice(0, cands.length, ...scored.map((x) => x.c));
      for (const x of scored) openingScore.set(x.c, x.s);
    }
    // `boatsWaterPath` liveness: what the straight-line ranking (this rule with the flag off) would have launched at
    const slPick = () => cands.filter((o) => o.slOk).sort((a, b) => a.dm - b.dm).slice(0, 16).find((o) => o.troops >= 500 && across(o.tile, o.dm));
    for (const c of cands.slice(0, wp ? 48 : 16)) {
      if (c.d >= 1e9 || c.troops < 500 || !across(c.tile, c.dm)) continue;
      if (opening && (openingScore.get(c) ?? 0) >= 2 * this.ctx.p.boatOpeningMinScore) this.nextBoatWorthy = this.ctx.mg.ticks(); // `boatEscort`: worth a swarm if contested
      if (this.ctx.boat(c.tile, c.troops, `early boat → ${c.what}, ${c.d} tiles${wp ? " by water" : ""}`) === 0) continue;
      // every early-boat landing (the plain first boat included) is watched by openingPush: a tribe may eat the
      // basin before the wave finishes. Pure bookkeeping with the flag off — only openingPush (flag-gated) reads it.
      this.openingLandings.push({ tile: c.tile, tick: this.ctx.mg.ticks() });
      if (opening) {
        // the fire site: this boat launches only because the flag is on — the plain rule already sent its one early boat
        this.lim.fire("boatOpening", "early");
        const b = this.openingBasin(c.tile);
        // v5 reasoning for the GUI: own = the landing's mass is our own (or the fill was capped — treated as
        // own), blocked = the escape hatch fired (the basin is walled off by rivals). Both reads hit the caches.
        const m = this.landmass(c.tile);
        const own = m.ours || m.capped;
        const blocked = own && c.tribeTiles === 0 && this.openingCutOff(c.tile);
        this.ctx.log(`t${this.ctx.mg.ticks()} BOAT OPENING ${this.ctx.sit.boats}/${this.ctx.p.boatOpeningCount} out → ${c.what} at ${this.ctx.mg.x(c.tile)},${this.ctx.mg.y(c.tile)}, ${c.d} tiles${wp ? " by water" : ""} basin=${b.tiles} sail=${c.sail} eta=${c.sail} cap=${earlyCap} eaten=${Math.round(Math.min(b.tiles, this.eatRate() * b.contact * c.sail))} own=${own ? "yes" : "no"}${blocked ? " blocked=yes" : ""}${c.moved ? " reanchored=yes" : ""}`);
      }
      if (nearest && !opening) {
        // liveness: what the old ranking (middle tile, 30-tile floor) would have launched at
        const old = cands.filter((o) => o.oldOk).sort((a, b) => a.oldD - b.oldD).slice(0, 16).find((o) => o.troops >= 500 && this.q.acrossWater(o.tile));
        if (old === undefined || old.tile !== c.tile) this.lim.fire("boatsNearest", "early");
      }
      if (wp && !opening) { const sl = slPick(); if (sl === undefined || sl.tile !== c.tile) this.lim.fire("boatsWaterPath", "early"); }
      return true;
    }
    if (wp && !opening) { const sl = slPick(); if (sl !== undefined && sl.d >= 1e9) this.lim.fire("boatsWaterPath", "early"); } // refused by the cap
    return false;
  }

  /** No bots on our borders: boat to the nearest bot within reach, with 1.67× its troops. */
  private boatedAt = new Map<Player, number>();
  huntBotsByBoat(): void {
    const me = this.ctx.me;
    if (this.q.neighbours().bots.length > 0) return;
    if (me.units(UnitType.TransportShip).length > 0) return; // one landing at a time; a second boat to the same beach is the 'boat that takes no land'
    if (me.troops() < this.q.cap() * 0.4) return;
    const shore = borderOf(me).filter((t) => this.ctx.mg.isShore(t));
    if (shore.length === 0) return;
    const from = shore[Math.floor(shore.length / 2)];
    const fx = this.ctx.mg.x(from), fy = this.ctx.mg.y(from);
    const sample = this.ctx.p.boatsNearest ? this.shoreSample() : []; // `boatsNearest`: see seaExpansion
    const nearest = sample.length > 0;
    const wp = this.ctx.p.boatsWaterPath ? this.waterPath() : null; // `boatsWaterPath`: rank by the sailed path, refuse beyond BOAT_MAX_PATH.tribe; sl* is the straight-line pick, for the liveness count
    let best: TileRef | null = null, bestBot: Player | null = null, bestD = 1e9, bestDm = 1e9, oldBest: TileRef | null = null, oldD = 1e9, slBest: TileRef | null = null, slD = 1e9;
    for (const bot of this.ctx.mg.players()) {
      if (bot.type() !== PlayerType.Bot || !bot.isAlive() || bot.numTilesOwned() < 100) continue;
      if (this.ctx.mg.ticks() - (this.boatedAt.get(bot) ?? -1e9) < 900) continue;
      const want = Math.ceil(bot.troops() * 2) + 500;
      if (want > me.troops() * 0.3) continue;
      // sample its border for a shore tile
      let i = 0;
      for (const t of borderOf(bot)) {
        if ((i++ % 7) !== 0) continue;
        if (!this.ctx.mg.isShore(t)) continue;
        const dO = Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
        const dm = nearest ? this.nearestShoreDist(t, sample) : dO;
        const d = wp ? wp.len(t) : dm;
        if (d < bestD && d <= (wp ? BOAT_MAX_PATH.tribe : 350)) { bestD = d; bestDm = dm; best = t; bestBot = bot; }
        if (dm < slD && dm <= 350) { slD = dm; slBest = t; }
        if (dO < oldD && dO <= 350) { oldD = dO; oldBest = t; }
      }
    }
    if (best === null || bestBot === null) {
      if (wp && slBest !== null && (nearest ? this.q.acrossWaterNear(slBest, slD) : this.q.acrossWater(slBest))) this.lim.fire("boatsWaterPath", "tribe"); // refused by the cap
      return;
    }
    if (nearest ? !this.q.acrossWaterNear(best, bestDm) : !this.q.acrossWater(best)) return; // reachable by land: that is a land attack, not a boat
    const troops = Math.ceil(bestBot.troops() * 2) + 500;
    if (troops > this.ctx.sit.spendable) return;
    // `contestLeader`: this tribe boat goes at the runaway leader's coastline instead — the same wave, the same
    // distance cap and across-water gate, the same 900-tick per-target cooldown (boatedAt keyed by the leader)
    const lead = this.ctx.p.contestLeader ? this.ctx.sit.contest : null;
    if (lead !== null && lead.isAlive() && me.canAttackPlayer(lead) && this.ctx.mg.ticks() - (this.boatedAt.get(lead) ?? -1e9) >= 900) {
      const distFn = nearest ? (t: TileRef) => this.nearestShoreDist(t, sample) : (t: TileRef) => Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
      const lt = this.contestShore(lead, distFn);
      if (lt !== null && (wp ? wp.len(lt.tile) <= BOAT_MAX_PATH.tribe : lt.dm <= 350) && (nearest ? this.q.acrossWaterNear(lt.tile, lt.dm) : this.q.acrossWater(lt.tile))) {
        if (this.ctx.boat(lt.tile, troops, `CONTEST leader ${lead.name()} ${lead.numTilesOwned()}t instead of tribe ${bestBot.name()}, ${lt.dm} tiles`) !== 0) {
          if (!this.ctx.dry) this.boatedAt.set(lead, this.ctx.mg.ticks());
          this.lim.fire("contestLeader", "tribeBoat");
          return;
        }
      }
    }
    if (this.ctx.boat(best, troops, `to tribe ${bestBot.name()} ${bestBot.numTilesOwned()}t/${Math.round(bestBot.troops() / 1000)}k, ${bestD} tiles${wp ? " by water" : ""}`) === 0) return;
    if (!this.ctx.dry) this.boatedAt.set(bestBot, this.ctx.mg.ticks());
    if (nearest && oldBest !== best) this.lim.fire("boatsNearest", "tribe");
    if (wp && slBest !== best) this.lim.fire("boatsWaterPath", "tribe");
  }

  /** `contestLeader`: the leader's ocean-shore tile nearest our coast (by `dist`, the calling rule's own ranking),
   *  preferring shore within 40 tiles of one of its ports or cities — the coastline its economy sits on. Sampled
   *  border walk (every 9th tile), null when it has no ocean shore. */
  private contestShore(lead: Player, dist: (t: TileRef) => number): { tile: TileRef; dm: number } | null {
    const mg = this.ctx.mg;
    const spots = [...lead.units(UnitType.Port), ...lead.units(UnitType.City)].map((u) => u.tile());
    let best: TileRef | null = null, bestD = 1e9, bestNear = false, i = 0;
    for (const t of borderOf(lead)) {
      if ((i++ % 9) !== 0 || !mg.isOceanShore(t)) continue;
      const near = spots.some((s) => mg.manhattanDist(s, t) <= 40);
      if (bestNear && !near) continue;
      const d = dist(t);
      if ((near && !bestNear) || d < bestD) { best = t; bestD = d; bestNear = near; }
    }
    return best === null ? null : { tile: best, dm: bestD };
  }

  // ---------------------------------------------------------------- finishByBoat: the remnant a land war cannot reach
  private finishedAt = new Map<Player, number>();
  /** The part of `t` no land attack of ours can reach: its 4-connected pieces (Military.pieces — exact, from the border
   *  alone, the flood fill the brief asked for costs O(tiles)) with no border tile beside one of ours. AttackExecution
   *  only takes tiles adjacent to ours, so a piece with no such tile is never conquered by a land wave; when the
   *  land war has taken what borders us the target lives on there. Returns the tile count and the piece's ocean-shore
   *  tiles (sampled to ≤ 200), or null when every piece touches us. */
  unreachablePart(t: Player): { tiles: number; shore: TileRef[] } | null {
    const mg = this.ctx.mg, me = this.ctx.me;
    let tiles = 0;
    const shore: TileRef[] = [];
    for (const piece of Military.pieces(mg, t)) {
      let touches = false;
      for (const b of piece.border) { for (const n of mg.neighbors(b)) if (mg.owner(n) === me) { touches = true; break; } if (touches) break; }
      if (touches) continue;
      tiles += piece.tiles;
      for (const b of piece.border) if (mg.isOceanShore(b)) shore.push(b);
    }
    if (tiles === 0) return null;
    const step = Math.max(1, Math.ceil(shore.length / 200));
    const sampled: TileRef[] = [];
    for (let i = 0; i < shore.length; i += step) sampled.push(shore[i]);
    return { tiles, shore: sampled };
  }
  /** `finishByBoat` (every 100 ticks from tick 1200): the current war target, or any non-bot rival one of our waves is
   *  on, that owns a piece we cannot reach by land and which has an ocean shore gets a boat from our nearest shore
   *  onto that piece's shore tile nearest our coast: 2 × its troops × (unreachable / its tiles) + 2000, at most 40 %
   *  of the spendable. One boat per target at a time (a transport of ours still bound for it, or one launched inside
   *  600 ticks, holds the next). Fires on every launch. */
  finishByBoat(): void {
    const me = this.ctx.me, mg = this.ctx.mg, now = mg.ticks();
    if (this.ctx.sit.boats >= mg.config().boatMaxNumber()) return;
    const sample = this.shoreSample();
    if (sample.length === 0) return;
    const wp = this.ctx.p.boatsWaterPath ? this.waterPath() : null; // `boatsWaterPath`: the landing nearest by sailed path, refused beyond BOAT_MAX_PATH.finish
    const targets: Player[] = [];
    if (this.currentTarget_ !== null && now - this.lastWarTick < 1800) targets.push(this.currentTarget_);
    for (const a of me.outgoingAttacks()) { const t = a.target(); if (t.isPlayer() && t.type() !== PlayerType.Bot && !targets.includes(t)) targets.push(t); }
    const bound = new Set<Player>();
    for (const u of me.units(UnitType.TransportShip)) { const d = u.targetTile(); if (d !== undefined && mg.hasOwner(d)) { const o = mg.owner(d); if (o.isPlayer()) bound.add(o); } }
    for (const t of targets) {
      if (!t.isAlive() || me.isFriendly(t) || !me.canAttackPlayer(t) || bound.has(t)) continue;
      if (now - (this.finishedAt.get(t) ?? -1e9) < 600) continue;
      const part = this.unreachablePart(t);
      if (part === null || part.shore.length === 0) continue;
      let tile: TileRef | null = null, dist = 1e9, slTile: TileRef | null = null, slDist = 1e9;
      for (const s of part.shore) {
        const dm = this.nearestShoreDist(s, sample); if (dm < slDist) { slDist = dm; slTile = s; }
        const d = wp ? wp.len(s) : dm; if (d < dist) { dist = d; tile = s; }
      }
      if (tile === null || dist > (wp ? BOAT_MAX_PATH.finish : 600)) { if (wp && slTile !== null && slDist <= 600) this.lim.fire("boatsWaterPath", "finish"); continue; } // refused by the cap
      const share = part.tiles / Math.max(1, t.numTilesOwned()), spendable = this.ctx.sit.spendable, theirs = t.troops();
      const troops = Math.min(Math.ceil(2 * theirs * share) + 2000, Math.floor(spendable * 0.4));
      const sent = this.ctx.boat(tile, troops, `finish ${t.name()} across water, ${dist} tiles${wp ? " by water" : ""}`);
      if (sent === 0) continue;
      this.finishedAt.set(t, now);
      this.ctx.fire("finishByBoat");
      if (wp && slTile !== tile) this.lim.fire("boatsWaterPath", "finish");
      this.ctx.log(`t${now} FINISH BY BOAT ${t.name()} ${part.tiles} unreachable tiles of ${t.numTilesOwned()}, troops ${Math.round(theirs)} spendable ${Math.floor(spendable)} → ${sent} landing ${dist} tiles out`);
      return;
    }
  }

  // ---------------------------------------------------------------- boatEscort: warships on the corridor a boat will sail
  /** An escort: `ship` was sent to `point`, the corridor tile nearest the threat, for the crossing to `target`;
   *  `sailedAt` ≥ 0 once that crossing launched (the transport is then tracked by its destination) and the entry is
   *  released when it has landed or died — or, never launched, after 2 × escortDeferTicks. */
  private escorts: { ship: Unit; point: TileRef; target: TileRef; since: number; sailedAt: number }[] = [];
  /** Landings held and since when (matched within boatDedupeRadius): the deferral clock a worthy crossing swarms on. */
  private deferrals: { target: TileRef; since: number }[] = [];
  /** A swarm's follow-up boats, launched by manageEscorts ESCORT_SWARM_GAP ticks apart. */
  private swarmQueue: { tile: TileRef; troops: number; at: number; k: number; n: number }[] = [];
  /** A contested corridor that wants a warship bought (Economy.build buys it patrolling `point` and clears this). */
  escortWant: { point: TileRef; since: number } | null = null;
  /** The tick a boat rule stamped just before ctx.boat() to say its target is worth a swarm (an opening pick scoring
   *  ≥ 2 × boatOpeningMinScore); read for that tick only, so a refused launch leaves no residue. */
  nextBoatWorthy = -1;
  private lastEscortLog = -1e9;
  private sameLanding(a: TileRef, b: TileRef): boolean { return this.ctx.mg.euclideanDistSquared(a, b) <= this.ctx.p.boatDedupeRadius ** 2; }
  /** `boatEscort`: the loop's boat() asks before every launch. Returns the troops to launch now — `troops` (sail as
   *  planned), a swarm's per-boat share (the rest queued), or 0 (the crossing is held this pass; the rule moves on to
   *  its next candidate and re-picks next pass). Engine facts this rests on (WarshipExecution, ShellExecution): a
   *  warship shells any enemy transport within warshipTargettingRange (130) — transports first, no reload against
   *  them, one homing shell each — and a transport has no health, so a transport whose path comes within 130 of a
   *  live enemy warship is sunk whether or not a warship of ours is beside it: an escort cannot screen a crossing,
   *  it can only CLEAR the corridor (warship 1000 HP, ~262 a shell per 20 ticks, retreat at 75 %, no fire once
   *  docked). Hence hold + send the escort at the threat + sail once the corridor reads clear; a worthy target with
   *  no escort possible, or held escortDeferTicks, swarms (the threat's no-reload rule means only what it has not
   *  reached yet gets through — Josh asked for the attempt; the A/B judges it). */
  escortGate(tile: TileRef, troops: number, why: string): number {
    const p = this.ctx.p, mg = this.ctx.mg, me = this.ctx.me, now = mg.ticks();
    const worthy = this.nextBoatWorthy === now || why.startsWith("CONTEST") || (this.ctx.sit.duel !== null && mg.hasOwner(tile) && mg.owner(tile) === this.ctx.sit.duel);
    this.nextBoatWorthy = -1;
    if (!p.boatEscort || now < p.escortFromTick) return troops;
    const cor = this.corridor(tile);
    if (cor === null || cor.len <= p.escortMinSail) return troops; // a short hop sails as before
    const threat = this.corridorThreat(cor.tiles);
    if (threat === null) { this.deferrals = this.deferrals.filter((d) => !this.sameLanding(d.target, tile)); this.escortSailed(tile); return troops; }
    // contested. The deferral clock for this landing first: it decides whether a purchase is still worth asking for
    let def = this.deferrals.find((d) => this.sameLanding(d.target, tile));
    if (def === undefined) { def = { target: tile, since: now }; this.deferrals.push(def); }
    const timedOut = now - def.since >= p.escortDeferTicks;
    // (1) an escort for this corridor: the idle warship nearest the threat, else a purchase request while the clock runs
    let esc = this.escorts.find((e) => this.sameLanding(e.target, tile));
    if (esc === undefined) {
      const ship = this.idleWarship(threat.at);
      if (ship !== null) {
        mg.addExecution(new MoveWarshipExecution(me, [ship.id()], threat.at));
        esc = { ship, point: threat.at, target: tile, since: now, sailedAt: -1 };
        this.escorts.push(esc);
        this.lim.fire("boatEscort", "move");
        this.ctx.log(`t${now} ESCORT ${ship.id()} → corridor (${mg.x(threat.at)},${mg.y(threat.at)}) for boat to (${mg.x(tile)},${mg.y(tile)}); threat ${threat.owner.name()} at ${threat.d}`);
      } else if (p.escortBuy && !timedOut && this.escortWant === null && me.units(UnitType.Warship).length < p.escortMaxShips && !mg.config().isUnitDisabled(UnitType.Warship)) {
        this.escortWant = { point: threat.at, since: now };
      }
    }
    const canEscort = esc !== undefined || this.escortWant !== null;
    // (2) a worthy target with no escort possible — or held long enough — swarms: the same troops over n boats
    if (worthy && (!canEscort || timedOut)) {
      const n = Math.min(p.escortSwarm, Math.floor(troops / 500));
      if (n >= 2) {
        const per = Math.floor(troops / n);
        for (let k = 1; k < n; k++) this.swarmQueue.push({ tile, troops: per, at: now + k * ESCORT_SWARM_GAP, k: k + 1, n });
        this.deferrals = this.deferrals.filter((d) => d !== def);
        this.lim.fire("boatEscort", "swarm");
        this.ctx.log(`t${now} ESCORT swarm ${n} boats → (${mg.x(tile)},${mg.y(tile)}) ${Math.round(per / 1000)}k each (${why}); threat ${threat.owner.name()} at ${threat.d}${esc ? `, escort ${esc.ship.id()}` : ""}`);
        this.escortSailed(tile);
        return per;
      }
    }
    // (3) held
    this.lim.fire("boatEscort", "defer");
    if (now - this.lastEscortLog >= 100) {
      this.lastEscortLog = now;
      this.ctx.log(esc !== undefined
        ? `t${now} ESCORT hold: crossing to (${mg.x(tile)},${mg.y(tile)}) waits for escort ${esc.ship.id()} (${why}, ${cor.len} tiles; threat ${threat.owner.name()} at ${threat.d})`
        : `t${now} ESCORT none: crossing deferred (${why}, ${cor.len} tiles; threat ${threat.owner.name()} warship ${threat.d} from the corridor${this.escortWant !== null ? ", buying" : ""})`);
    }
    return 0;
  }
  /** The crossing to `tile` launched: its escorts now watch that transport. */
  private escortSailed(tile: TileRef): void {
    const now = this.ctx.mg.ticks();
    for (const e of this.escorts) if (e.sailedAt < 0 && this.sameLanding(e.target, tile)) e.sailedAt = now;
  }
  /** The water a transport to `tile` will sail: the water path (WaterPath.path — the engine's WaterPathFinder takes
   *  the same shortest route, give or take), every ESCORT_CORRIDOR_STEP-th tile, with the sail length; beyond the
   *  fill's reach, the straight line from our nearest sampled shore tile (its water tiles) at manhattan length. */
  private corridor(tile: TileRef): { tiles: TileRef[]; len: number } | null {
    const mg = this.ctx.mg;
    const path = this.waterPath().path(tile);
    if (path !== null) {
      const tiles: TileRef[] = [];
      for (let i = 0; i < path.length; i += ESCORT_CORRIDOR_STEP) tiles.push(path[i]);
      if ((path.length - 1) % ESCORT_CORRIDOR_STEP !== 0) tiles.push(path[path.length - 1]);
      return { tiles, len: path.length };
    }
    const sample = this.shoreSample();
    if (sample.length === 0) return null;
    let from = sample[0], best = Infinity;
    for (const s of sample) { const d = mg.manhattanDist(s, tile); if (d < best) { best = d; from = s; } }
    const tiles: TileRef[] = [];
    const x0 = mg.x(from), y0 = mg.y(from), x1 = mg.x(tile), y1 = mg.y(tile), n = Math.max(1, Math.ceil(best / ESCORT_CORRIDOR_STEP));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n);
      if (mg.isValidCoord(x, y) && mg.isWater(mg.ref(x, y))) tiles.push(mg.ref(x, y));
    }
    return tiles.length === 0 ? null : { tiles, len: best };
  }
  /** The live enemy warship (one whose owner may attack us; a docked one does not fire) nearest the corridor, within
   *  escortThreatRange of one of its tiles — with that tile and the distance. Euclidean, as the engine's targeting. */
  private corridorThreat(tiles: TileRef[]): { ship: Unit; owner: Player; at: TileRef; d: number } | null {
    const mg = this.ctx.mg, me = this.ctx.me, r2 = this.ctx.p.escortThreatRange ** 2;
    let best: { ship: Unit; owner: Player; at: TileRef; d: number } | null = null, bestD2 = Infinity;
    for (const u of mg.units(UnitType.Warship)) {
      const o = u.owner();
      if (o === me || !u.isActive() || u.warshipState().state === "docked" || !o.canAttackPlayer(me, true)) continue;
      let d2 = Infinity, at = tiles[0];
      for (const t of tiles) { const dd = mg.euclideanDistSquared(t, u.tile()); if (dd < d2) { d2 = dd; at = t; } }
      if (d2 <= r2 && d2 < bestD2) { bestD2 = d2; best = { ship: u, owner: o, at, d: Math.round(Math.sqrt(d2)) }; }
    }
    return best;
  }
  /** Our warship nearest `point` on the same water, not docked and not already on an escort. */
  private idleWarship(point: TileRef): Unit | null {
    const mg = this.ctx.mg, comp = mg.getWaterComponent(point);
    const busy = new Set(this.escorts.map((e) => e.ship));
    let best: Unit | null = null, bestD = Infinity;
    for (const u of this.ctx.me.units(UnitType.Warship)) {
      if (!u.isActive() || busy.has(u) || u.warshipState().state === "docked") continue;
      if (comp !== null && !mg.hasWaterComponent(u.tile(), comp)) continue;
      const d = mg.manhattanDist(u.tile(), point);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }
  /** Every 10 ticks (rule "escorts"): the swarm's follow-up boats due this pass, an unaffordable purchase request
   *  expiring, and the releases — a ship gone, a sailed crossing's transport landed or dead (no transport of ours
   *  bound within boatDedupeRadius of the landing, 20 ticks after the launch), a corridor never sailed for
   *  2 × escortDeferTicks. A released ship is idle for the next corridor; it is not moved back. */
  manageEscorts(): void {
    const p = this.ctx.p;
    if (!p.boatEscort) return;
    const mg = this.ctx.mg, me = this.ctx.me, now = mg.ticks();
    if (this.swarmQueue.length > 0) {
      const due = this.swarmQueue.filter((s) => s.at <= now);
      this.swarmQueue = this.swarmQueue.filter((s) => s.at > now);
      for (const s of due) this.ctx.boat(s.tile, s.troops, `ESCORT swarm ${s.k}/${s.n} → (${mg.x(s.tile)},${mg.y(s.tile)})`);
    }
    if (this.escortWant !== null && now - this.escortWant.since >= p.escortDeferTicks) this.escortWant = null;
    if (this.escorts.length === 0 && this.deferrals.length === 0) return;
    const boats = me.units(UnitType.TransportShip);
    const bound = (t: TileRef) => boats.some((u) => { const d = u.targetTile(); return d !== undefined && this.sameLanding(d, t); });
    this.escorts = this.escorts.filter((e) => e.ship.isActive() && e.ship.owner() === me && (e.sailedAt >= 0 ? now - e.sailedAt <= 20 || bound(e.target) : now - e.since < 2 * p.escortDeferTicks));
    this.deferrals = this.deferrals.filter((d) => now - d.since < 2 * p.escortDeferTicks);
  }

  // ---------------------------------------------------------------- nukes
  /** `spent`: gold Economy.build committed this pass (deducted next tick). NukeExecution checks the price on its own
   *  tick and silently drops a launch it cannot pay for, while the cooldown, the `bombed` blacklist and the bomb
   *  count were already recorded here — so the bomb is judged on what is left after this pass's buys. */
  maybeBomb(ticks: number, spent = 0n): void {
    const me = this.ctx.me;
    if (this.ctx.p.bombPush) this.watchSilos(ticks); // (b): the watch runs even before our own silo is up
    if (me.units(UnitType.MissileSilo).length === 0) return;
    // `bombPush` (c): while a war is active the cooldown is bombWarEvery (150 = half of bombEvery) — Enzo keeps
    // bombing while he pushes; `insidePlain` marks a launch the plain cadence would still be holding
    const every = this.ctx.p.bombPush && this.warActive() ? this.ctx.p.bombWarEvery : this.ctx.p.bombEvery;
    if (ticks - this.lastBombTick < every) return;
    const insidePlain = ticks - this.lastBombTick < this.ctx.p.bombEvery;
    const atomCost = this.ctx.mg.config().unitInfo(UnitType.AtomBomb).cost(this.ctx.mg, me);
    const hCost = this.ctx.mg.config().unitInfo(UnitType.HydrogenBomb).cost(this.ctx.mg, me);
    const gold = me.gold();
    // `bombPush` (b): a NEW enemy silo outranks every other bomb this pass — kill launchers before they fire
    if (this.ctx.p.bombPush && this.siloKill(ticks, spent, gold, atomCost)) {
      if (insidePlain) this.lim.fire("bombPush", "every");
      return;
    }
    if (this.ctx.p.bombBudget) {
      // `bombBudget`: the planned bomb goes the moment the fund covers it — no reserve on top; while it does not,
      // Economy.build is holding the price out of every discretionary buy (bombFund)
      const plan = this.bombPlan(ticks);
      if (plan === null) return;
      if (gold - spent < plan.cost) {
        const key = `${plan.type}/${plan.enemy.id()}`;
        if (ticks - this.lastFundLog >= 600 || key !== this.lastFundKey) { this.lastFundLog = ticks; this.lastFundKey = key; this.ctx.log(`t${ticks} BOMB FUND: saving ${Math.round(Number(plan.cost) / 1000)}k for ${plan.type === UnitType.HydrogenBomb ? "Hydrogen" : "Atom"} at ${plan.enemy.name()} (have ${Math.round(Number(gold - spent) / 1000)}k, +${Math.round((this.income.rate * 600) / 1000)}k/min)`); }
        return;
      }
      const { rich } = this.bombEnemies(gold, true); // the buy path's side effects: a crown / idle-at-cap pick becomes the war target
      if (gold - spent < plan.cost + BigInt(rich ? 2_000_000 : this.ctx.p.bombReserve)) this.lim.fire("bombBudget", "bomb", 1); // the old rule would not have afforded this bomb yet
      this.launch(plan, ticks);
      if (this.lastBombTick === ticks && insidePlain) this.lim.fire("bombPush", "every"); // (c): only the war cadence allowed this pass
      if (this.lastBombTick === ticks && this.planCache?.contest === plan.enemy) this.lim.fire("contestLeader", "bomb"); // the leader only the flag put on the list took the bomb
      return;
    }
    const { enemies, rich, contest } = this.bombEnemies(gold, true);
    if (enemies.size === 0) return;
    const reserve = BigInt(rich ? 2_000_000 : this.ctx.p.bombReserve);
    const best = this.bombSearch(enemies, rich, (type) => gold - spent >= (type === UnitType.HydrogenBomb ? hCost : atomCost) + reserve);
    if (best === null) return;
    this.launch(best, ticks);
    if (this.lastBombTick === ticks && insidePlain) this.lim.fire("bombPush", "every"); // (c): only the war cadence allowed this pass
    if (this.lastBombTick === ticks && contest !== null && best.enemy === contest) this.lim.fire("contestLeader", "bomb"); // the leader only the flag put on the list took the bomb
  }
  // ---------------------------------------------------------------- bombPush: pre-bombs and the silo watch
  /** `fastSilo`: tick of the first war opened with a bomb (−1e9 = none yet) — Economy unlocks the second silo on it. */
  private bombWarAt = -1e9;
  get bombWarOpened(): boolean {
    return this.bombWarAt > -1e9;
  }
  /** An active war: the sticky target lives and is unfriendly, or a land wave of ours is out on a non-bot. */
  private warActive(): boolean {
    const me = this.ctx.me;
    if (this.currentTarget_ !== null && this.currentTarget_.isAlive() && !me.isFriendly(this.currentTarget_)) return true;
    return me.outgoingAttacks().some((a) => a.target().isPlayer() && (a.target() as Player).type() !== PlayerType.Bot);
  }
  /** `bombPush` (a): the pre-bomb actWar fires the moment a war wave commits — the target's densest cluster
   *  (bombSearch on it ALONE, so the wave's own enemy takes the hit) preferring clusters near our shared border
   *  (the anchor: posts/cities on our side are what the wave walks into). Same reserve rule as maybeBomb. */
  private preBomb(pick: WarPick, ticks: number): void {
    const me = this.ctx.me, mg = this.ctx.mg, r = pick.r;
    if (me.units(UnitType.MissileSilo).length === 0) return;
    if (ticks - this.lastBombTick < this.ctx.p.bombWarEvery) return;
    const atomCost = mg.config().unitInfo(UnitType.AtomBomb).cost(mg, me);
    const hCost = mg.config().unitInfo(UnitType.HydrogenBomb).cost(mg, me);
    const mirvCost = mg.config().unitInfo(UnitType.MIRV).cost(mg, me);
    const gold = me.gold();
    const rich = this.ctx.p.endgameV2 && ticks >= 9000 && gold >= 8_000_000n && (gold < mirvCost || me.units(UnitType.MIRV).length > 0); // maybeBomb's own reserve rule
    const reserve = BigInt(rich ? 2_000_000 : this.ctx.p.bombReserve);
    const allow = (type: UnitType) => gold >= (type === UnitType.HydrogenBomb ? hCost : atomCost) + reserve;
    const best = this.bombSearch(new Set([r]), rich, allow, this.borderAnchor(r));
    if (best === null) return;
    const insidePlain = ticks - this.lastBombTick < this.ctx.p.bombEvery; // the plain cadence was still holding
    const plain = pick.pushBomb || insidePlain ? null : this.bombSearch(new Set([r]), rich, allow); // the aim without the anchor
    this.launch(best, ticks);
    if (this.lastBombTick !== ticks) return;
    // liveness: the plain rule would not have bombed this wave (not richer), could not yet (cadence), or aimed elsewhere
    if (pick.pushBomb || insidePlain || plain === null || plain.tile !== best.tile) this.lim.fire("bombPush", "pre");
    this.ctx.log(`t${ticks} BOMB push ${r.name()}: pre-wave at ${mg.x(best.tile)},${mg.y(best.tile)}`);
  }
  /** Midpoint of our sampled border tiles touching `r` — the pre-bomb's "our side"; null when we share no border. */
  private borderAnchor(r: Player): TileRef | null {
    const mg = this.ctx.mg;
    let sx = 0, sy = 0, n = 0, i = 0;
    for (const t of borderOf(this.ctx.me)) {
      if ((i++ % 4) !== 0) continue;
      for (const nb of mg.neighbors(t)) if (mg.owner(nb) === r) { sx += mg.x(t); sy += mg.y(t); n++; break; }
    }
    return n === 0 ? null : mg.ref(Math.round(sx / n), Math.round(sy / n));
  }
  /** `bombPush` (b): known silo unit ids per unfriendly neighbour; a first sighting of a player seeds without
   *  flagging (a silo that predates the watch is not "new"). */
  private siloSeen = new Map<Player, Set<number>>();
  private newSilos: { owner: Player; unit: Unit; at: number }[] = [];
  private lastSiloScan = -1e9;
  /** Every 100 ticks: any NEW silo among our unfriendly neighbours joins the kill list for bombSiloTicks. */
  private watchSilos(ticks: number): void {
    if (ticks - this.lastSiloScan < 100) return;
    this.lastSiloScan = ticks;
    const me = this.ctx.me;
    const rivals = this.q.neighbours().rivals;
    const live = new Set(rivals);
    for (const p of this.siloSeen.keys()) if (!live.has(p)) this.siloSeen.delete(p); // a lost neighbour re-seeds on return
    for (const r of rivals) {
      const silos = r.units(UnitType.MissileSilo);
      const seen = this.siloSeen.get(r);
      if (seen === undefined) { this.siloSeen.set(r, new Set(silos.map((u) => u.id()))); continue; }
      for (const u of silos) {
        if (seen.has(u.id())) continue;
        seen.add(u.id());
        this.newSilos.push({ owner: r, unit: u, at: ticks });
        this.ctx.log(`t${ticks} NEW SILO ${r.name()} at ${this.ctx.mg.x(u.tile())},${this.ctx.mg.y(u.tile())}`);
      }
    }
    this.newSilos = this.newSilos.filter((s) => ticks - s.at < this.ctx.p.bombSiloTicks && s.unit.isActive() && s.owner.isAlive() && !me.isFriendly(s.owner));
  }
  /** The counter-silo bomb: an atom on the oldest killable NEW silo — SAM umbrellas, the 32-tile friend clearance,
   *  the collateral rule, the `bombed` blacklist and the bomb reserve all still apply. True when one launched. */
  private siloKill(ticks: number, spent: bigint, gold: bigint, atomCost: bigint): boolean {
    const me = this.ctx.me, mg = this.ctx.mg;
    if (this.newSilos.length === 0) return false;
    if (gold - spent < atomCost + BigInt(this.ctx.p.bombReserve)) return false;
    for (const s of this.newSilos) {
      const tile = s.unit.tile();
      if (!s.unit.isActive() || !s.owner.isAlive() || me.isFriendly(s.owner)) continue;
      if ((this.bombed.get(tile) ?? 0) >= 1) continue;
      const sams = s.owner.units(UnitType.SAMLauncher);
      if (sams.some((sm) => mg.euclideanDistSquared(sm.tile(), tile) <= (mg.config().samRange(sm.level()) + 5) ** 2)) continue;
      if (!this.clearOfFriends(tile, 32) || this.blastCollateral(tile, UnitType.AtomBomb, s.owner)) continue;
      this.launch({ tile, value: 0, type: UnitType.AtomBomb, enemy: s.owner, cost: atomCost }, ticks);
      if (this.lastBombTick !== ticks) continue; // out of every ready silo's range: try the next
      this.newSilos = this.newSilos.filter((x) => x !== s);
      this.lim.fire("bombPush", "silo");
      this.ctx.log(`t${ticks} BOMB silo-kill ${s.owner.name()} at ${mg.x(tile)},${mg.y(tile)} (up ${ticks - s.at} ticks)`);
      return true;
    }
    return false;
  }
  private lastFundLog = -1e9;
  private lastFundKey = "";
  /** Fire the bomb `best` describes: out of every ready silo's reach counts toward a silo level (Economy.build). */
  private launch(best: BombPick, ticks: number): void {
    const me = this.ctx.me;
    if (me.canBuild(best.type, best.tile) === false) { this.bombOutOfRange_++; return; }
    this.bombOutOfRange_ = 0;
    this.ctx.mg.addExecution(new ConstructionExecution(me, best.type, best.tile));
    this.lastBombTick = ticks;
    this.bombed.set(best.tile, (this.bombed.get(best.tile) ?? 0) + 1);
    this.bombs++;
    this.ctx.log(`t${ticks} BOMB ${best.type} at ${this.ctx.mg.x(best.tile)},${this.ctx.mg.y(best.tile)}`);
  }
  /** Bomb targets: whoever we fight or who fights us, Diplomacy's planned target, the collapsed, the threats to a
   *  crown; when `endgameV2` gold can never reach the MIRV price (`rich`), the largest un-allied neighbour; idle at
   *  cap with no attack out, the neighbour with the most buildings we could then take at 1.2×. `mutate` lets those
   *  last two picks become the war target (the buy path); the `bombBudget` plan reads the same set without it. */
  private bombEnemies(gold: bigint, mutate: boolean): { enemies: Set<Player>; rich: boolean; contest: Player | null } {
    const me = this.ctx.me;
    const enemies = new Set<Player>();
    if (this.currentTarget_ && this.currentTarget_.isAlive() && !me.isFriendly(this.currentTarget_)) enemies.add(this.currentTarget_);
    for (const inc of me.incomingAttacks()) { const a = inc.attacker(); if (a.type() !== PlayerType.Bot && !me.isFriendly(a) && inc.troops() > me.troops() * 0.05) enemies.add(a); }
    const plannedTarget = this.plannedTarget();
    if (plannedTarget && plannedTarget.isAlive() && !me.isFriendly(plannedTarget)) enemies.add(plannedTarget);
    for (const r of this.ctx.sit.collapsed) if (!me.isFriendly(r)) enemies.add(r);
    if (this.ctx.sit.share >= 0.5) for (const r of this.ctx.sit.threats) if (me.canAttackPlayer(r) || this.q.neighbours().rivals.includes(r)) enemies.add(r); // whoever could fire at the crown
    // `contestLeader`: the runaway leader is a bomb target like the threats — the value search does the prioritising
    // (its clusters are usually the richest on the map, and range/affordability keep their say). `contest` reports it
    // only when the flag ADDED it, so a pick on it counts as a decision the flag changed.
    // `duelPush`: the foe of a won duel is a bomb target like the threats (added before the contest leader — the foe is
    // usually the leader, and one entry is one entry); the value search prioritises
    const foe = this.ctx.sit.duel;
    if (foe !== null && foe.isAlive() && !me.isFriendly(foe) && !enemies.has(foe)) { enemies.add(foe); if (mutate) this.lim.fire("duelPush", "bomb", 300); }
    let contest: Player | null = null;
    const lead = this.ctx.p.contestLeader ? this.ctx.sit.contest : null;
    if (lead !== null && lead.isAlive() && !me.isFriendly(lead) && !enemies.has(lead)) { enemies.add(lead); contest = lead; }
    const mirvPrice = this.ctx.mg.config().unitInfo(UnitType.MIRV).cost(this.ctx.mg, me);
    const rich = this.ctx.p.endgameV2 && this.ctx.mg.ticks() >= 9000 && gold >= 8_000_000n && (gold < mirvPrice || me.units(UnitType.MIRV).length > 0);
    if (rich && enemies.size === 0) {
      // gold that can never reach the MIRV price is spent on hydrogen bombs at the strongest un-allied neighbour
      const { rivals } = this.q.neighbours();
      const pick = rivals.filter((r) => me.canAttackPlayer(r)).sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0];
      if (pick) { enemies.add(pick); if (mutate && (!this.currentTarget_ || !this.currentTarget_.isAlive())) this.currentTarget_ = pick; }
    }
    if (enemies.size === 0 && me.troops() > this.q.cap() * 0.9 && me.outgoingAttacks().length === 0) {
      // idle at cap: open a war — bomb the neighbour with the most buildings we could then take at 1.2×
      const { rivals } = this.q.neighbours();
      const pick = rivals.filter((r) => me.canAttackPlayer(r) && r.troops() * 1.2 < me.troops() * this.ctx.p.fightMaxShare).sort((a, b) => b.units(UnitType.City).length - a.units(UnitType.City).length)[0];
      if (pick) { enemies.add(pick); if (mutate) this.currentTarget_ = pick; }
    }
    return { enemies, rich, contest };
  }
  /** maybeBomb's value search: over every structure of `enemies` not yet bombed, outside a SAM umbrella (the SAM
   *  always hits) and 32 tiles clear of our own or allied land, the bomb — Hydrogen only 105 tiles clear of friends
   *  on an owner of ≥ 8000 tiles (3000 when `rich`), and only the types `allow` accepts — whose blast covers the most
   *  building value (city 3, silo / SAM 4, else 2, × level) per 100k of its price; null when nothing reaches value 4.
   *  A pick is then checked against the engine's own collateral rule (NukeExecution.maybeBreakAlliances via
   *  listNukeBreakAlliance: every player with more than nukeAllianceBreakThreshold weighted tiles in the blast, or
   *  any structure under it, is docked −100 relation and, if allied, betrayed): a bomb that would touch anyone but
   *  its target is refused. The sampled clearOfFriends misses a thin strip; this one is exact and runs only on a
   *  candidate about to become the pick. */
  private bombSearch(enemies: Set<Player>, rich: boolean, allow: (type: UnitType) => boolean, anchor: TileRef | null = null): BombPick | null {
    const atomCost = this.ctx.mg.config().unitInfo(UnitType.AtomBomb).cost(this.ctx.mg, this.ctx.me);
    const hCost = this.ctx.mg.config().unitInfo(UnitType.HydrogenBomb).cost(this.ctx.mg, this.ctx.me);
    // `bombPush`: the pre-bomb prefers the cluster on OUR side — value per gold is divided by the manhattan distance
    // from `anchor` (the shared-border midpoint) in units of BOMB_PUSH_NEAR tiles (≤ one unit is free)
    const near = (t: TileRef) => anchor === null ? 1 : Math.max(1, (Math.abs(this.ctx.mg.x(t) - this.ctx.mg.x(anchor)) + Math.abs(this.ctx.mg.y(t) - this.ctx.mg.y(anchor))) / BOMB_PUSH_NEAR);
    let best: BombPick | null = null;
    for (const enemy of enemies) {
      const structures = enemy.units([UnitType.City, UnitType.Port, UnitType.Factory, UnitType.MissileSilo, UnitType.SAMLauncher, UnitType.DefensePost]);
      const sams = enemy.units(UnitType.SAMLauncher);
      for (const u of structures) {
        const tile = u.tile();
        if ((this.bombed.get(tile) ?? 0) >= 1) continue;
        if (sams.some((s) => this.ctx.mg.euclideanDistSquared(s.tile(), tile) <= (this.ctx.mg.config().samRange(s.level()) + 5) ** 2)) continue;
        if (!this.clearOfFriends(tile, 32)) continue;
        for (const type of [UnitType.HydrogenBomb, UnitType.AtomBomb]) {
          const cost = type === UnitType.HydrogenBomb ? hCost : atomCost;
          if (!allow(type)) continue;
          if (type === UnitType.HydrogenBomb && (!this.clearOfFriends(tile, 105) || enemy.numTilesOwned() < (rich ? 3000 : 8000))) continue;
          const r = this.ctx.mg.config().nukeMagnitudes(type).outer;
          let value = 0;
          for (const o of structures) if (this.ctx.mg.euclideanDistSquared(o.tile(), tile) <= r * r) value += (o.type() === UnitType.City ? 3 : o.type() === UnitType.MissileSilo || o.type() === UnitType.SAMLauncher ? 4 : 2) * o.level();
          const perGold = value / Number(cost / 100_000n) / near(tile);
          if (value >= 4 && (best === null || perGold > best.value) && !this.blastCollateral(tile, type, enemy)) best = { tile, value: perGold, type, enemy, cost };
        }
      }
    }
    return best;
  }
  // ---------------------------------------------------------------- bombBudget: the planned bomb and its fund
  private planCache: { tick: number; plan: BombPick | null; contest: Player | null } | null = null;
  private income = { tick: -1, gold: 0n, rate: 0 };
  /** Observed income per tick: an EMA over the passes of the gold gained since the last one (a pass where gold
   *  fell — a purchase — is skipped; a windfall — conquest gold, a lane paying out — enters at no more than 3× the
   *  running rate, so one lump does not promise a hydrogen bomb). ~100-tick memory at one sample per 10 ticks. */
  private noteIncome(ticks: number): void {
    const I = this.income, gold = this.ctx.me.gold();
    if (I.tick >= 0 && ticks > I.tick && gold > I.gold) { const r = Number(gold - I.gold) / (ticks - I.tick); I.rate = I.rate <= 0 ? r : I.rate * 0.9 + Math.min(r, I.rate * 3) * 0.1; }
    I.tick = ticks; I.gold = gold;
  }
  /** `bombBudget`: the NEXT bomb we are saving for, or null (no silo, no target, no cluster worth a bomb) — the best
   *  pick of maybeBomb's value search with the price ignored; a Hydrogen pick stands when 5M is within ~90 s of
   *  income at the current rate (BOMB_FUND_HORIZON), else the best Atom. Computed once per tick (Economy.build
   *  escrows its price, maybeBomb buys it). Read-only: the buy path's side effects wait for the launch. */
  bombPlan(ticks: number): BombPick | null {
    if (this.planCache !== null && this.planCache.tick === ticks) return this.planCache.plan;
    this.noteIncome(ticks);
    const me = this.ctx.me, gold = me.gold();
    let plan: BombPick | null = null, contest: Player | null = null;
    if (me.units(UnitType.MissileSilo).length > 0) {
      const e = this.bombEnemies(gold, false);
      const { enemies, rich } = e;
      contest = e.contest;
      if (enemies.size > 0) {
        const any = this.bombSearch(enemies, rich, () => true);
        if (any !== null && any.type === UnitType.HydrogenBomb && gold + BigInt(Math.round(this.income.rate * BOMB_FUND_HORIZON)) >= any.cost) plan = any;
        else plan = any !== null && any.type === UnitType.AtomBomb ? any : this.bombSearch(enemies, rich, (type) => type === UnitType.AtomBomb);
      }
    }
    this.planCache = { tick: ticks, plan, contest };
    return plan;
  }
  /** `bombBudget`: gold Economy.build keeps out of every discretionary buy — the planned bomb's price, or 0n. */
  bombFund(ticks: number): bigint {
    return this.bombPlan(ticks)?.cost ?? 0n;
  }
  /** Would a `type` bomb at `tile` hit anyone but `enemy` by the engine's rule (see bombSearch)? */
  private blastCollateral(tile: TileRef, type: UnitType, enemy: Player): boolean {
    const mg = this.ctx.mg;
    const hit = listNukeBreakAlliance({ game: mg, targetTile: tile, magnitude: mg.config().nukeMagnitudes(type), threshold: mg.config().nukeAllianceBreakThreshold() });
    for (const id of hit) if (id !== enemy.smallID()) return true;
    return false;
  }
  clearOfFriends(tile: TileRef, r: number): boolean {
    const x = this.ctx.mg.x(tile), y = this.ctx.mg.y(tile);
    for (let dy = -r; dy <= r; dy += 8) for (let dx = -r; dx <= r; dx += 8) {
      if (dx * dx + dy * dy > r * r || !this.ctx.mg.isValidCoord(x + dx, y + dy)) continue;
      const o = this.ctx.mg.owner(this.ctx.mg.ref(x + dx, y + dy));
      if (o.isPlayer() && (o === this.ctx.me || this.ctx.me.isFriendly(o))) return false;
    }
    return true;
  }
}
