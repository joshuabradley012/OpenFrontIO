// Military: expansion, tribe harvesting, counter-attacks, wars and retreats, boats, bombs, MIRV, split watch.

import { Attack, Game, Player, PlayerType, Relation, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { ConstructionExecution } from "../ConstructionExecution";
import { MirvExecution } from "../MIRVExecution";
import { RetreatExecution } from "../RetreatExecution";
import { TargetPlayerExecution } from "../TargetPlayerExecution";
import { calculateTerritoryCenter, listNukeBreakAlliance } from "../Util";
import { BotContext, FireLimiter } from "./Context";
import { AttackEstimate, EstimateOptions, estimateAttack } from "./Estimate";
import { MirvRisk } from "./MirvRisk";
import { onTheClock, SituationQueries } from "./Situation";
import { clamp, compensate, describeOption, linear, logistic, Option, rankOptions } from "./Utility";

const CALIB_HORIZON = 3000; // calibration log: a war that has not resolved in 5 minutes is judged on where it stands then
const HYST_EVERY = 100; // hystRetreats: ticks between re-estimates of a running war
const HYST_HORIZON = 600; // hystRetreats: the 'continue' branch is judged one minute ahead
const HYST_TILE_WORTH = 60; // hystRetreats: what a tile of the target is worth in troops — the non-wilderness troop-sink bar (free land costs 16–24 a tile). The wilderness discount belongs to opening a war, not to abandoning one
const RETREAT_MALUS = 0.75; // AttackExecution.retreat(25) against a player: the share of a recalled wave that gets home
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
}
/** A war fight() would open: the decision half of the old fight(); actWar() is the other half. */
interface WarPick {
  r: Player;
  want: number;
  bomb: boolean; // open the war with a bomb on their cluster (richer, silo)
  opportunity: boolean; // collapsed / gap owner / MIRV threat / drained / annexable: goes at once (utility ranks it first)
  annex: boolean; // `annexWars`: an encircled neighbour taken from most of its border (logged ANNEX WAR)
  /** Every candidate the scorer accepted, for the utility layer (`best` first). */
  alts: { r: Player; want: number; score: number; opportunity: boolean; annex: boolean }[];
  /** `multiWar`: a war beside the running ones (the second or third slot). */
  extra: boolean;
}
const MULTI_WAR_SLOTS = 3; // multiWar: wars plus counters running at once
const UTIL_EST_EVERY = 50; // utility: ticks an option's estimate is cached
/** One war or tribe wave under calibration bookkeeping (EST at the send, ACT when the attack is gone). */
interface CalibRecord { wave: number; tick: number; sent: number; tiles0: number; ours0: number; others: number; last: number; seen: boolean; retreating: boolean; y: YieldRecord }
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

  // ---------------------------------------------------------------- opportunity #2: the nation script on the current state
  /** `markTargets`: the human 'target' button. Every allied nation whose relation to us is still Friendly answers a
   *  mark with an attack of its own (AiAttackBehavior.assistAllies) and points its nukes at the mark
   *  (NationNukeBehavior.findBestNukeTarget); the mark lives targetDuration (100) ticks and canTarget() allows one per
   *  targetCooldown (150), so a running war is re-marked from fight(). Costs: the target docks us −40 relation (it is
   *  at −70 from the attack already) and each assisting ally docks us −20. Nothing to recruit without an ally. */
  private lastMarkLog = -1e9;
  mark(target: Player, why: string): void {
    if (!this.ctx.p.markTargets) return;
    const me = this.ctx.me;
    if (!target.isAlive() || !me.canTarget(target) || me.allies().length === 0) return;
    this.ctx.mg.addExecution(new TargetPlayerExecution(me, target.id()));
    this.lim.fire("markTargets", "mark");
    if (this.ctx.mg.ticks() - this.lastMarkLog >= 600) { this.lastMarkLog = this.ctx.mg.ticks(); this.ctx.log(`t${this.ctx.mg.ticks()} MARK ${target.name()} for ${me.allies().length} allies (${why})`); }
  }
  /** `drainedNations`: a nation under its reserve ratio, not yet expected back at its trigger ratio (RivalView.drainedUntil). */
  drained(r: Player): boolean {
    if (!this.ctx.p.drainedNations || r.type() !== PlayerType.Nation) return false;
    const v = this.ctx.sit.rival.get(r);
    return v !== undefined && v.drainedUntil > this.ctx.sit.tick;
  }
  /** `retaliateAware` (with the brief's `secondAttacker` folded in): a nation retaliates only against its largest
   *  attacker, so a target already under a bigger wave than ours would be — or marked by one of our allies, whose
   *  other allies are about to hit it — can be taken as the smaller attacker at 1.2×. Returns the wave we may send
   *  without becoming the largest (Infinity for a mark with no wave yet), or 0 when the rule does not apply. */
  shadowWave(r: Player): number {
    if (!this.ctx.p.retaliateAware || r.type() !== PlayerType.Nation) return 0;
    const v = this.ctx.sit.rival.get(r);
    if (v && v.largestAttacker !== null && v.largestAttacker !== this.ctx.me) return v.largestAttack - 1;
    for (const a of this.ctx.me.allies()) if (a.isAlive() && a.targets().includes(r)) return Infinity;
    return 0;
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
    for (const m of [this.waves, this.sentAt, this.blacklist, this.lastCounter, this.embargoedAt_, this.boatedAt, this.history, this.pileInLogged, this.finishedAt]) for (const p of m.keys()) if (dead(p)) m.delete(p);
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
    for (const b of this.ctx.me.borderTiles()) if (this.ctx.mg.isOceanShore(b)) all.push(b);
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
  seaExpansion(): void {
    const me = this.ctx.me;
    if (this.ctx.sit.boats >= this.ctx.mg.config().boatMaxNumber()) return;
    if (this.ctx.mg.ticks() - this.lastSeaTick < 100) return;
    if (this.ctx.sit.wilderness && this.ctx.sit.capShare < 0.4) return; // land first while it is free and we are small
    if (this.ctx.sit.incoming.length > 0 && this.ctx.sit.capShare < 0.6) return; // under attack: the army stays
    const shore = Array.from(me.borderTiles()).filter((t) => this.ctx.mg.isOceanShore(t));
    if (shore.length === 0) return;
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
      for (const t of o.borderTiles()) {
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
      if (nearest) {
        // liveness: what the old ranking (middle tile, flat − d/2, 30-tile floor) would have launched at
        const old = cands.filter((o) => o.oldOk).sort((a, b) => b.oldScore - a.oldScore).slice(0, 10).find((o) => o.troops <= this.ctx.sit.spendable + sent && this.q.acrossWater(o.tile));
        if (old === undefined || old.tile !== c.tile) this.lim.fire("boatsNearest", "sea");
      }
      if (wp) { const sl = slPick(sent); if (sl === undefined || sl.tile !== c.tile) this.lim.fire("boatsWaterPath", "sea"); }
      return;
    }
    if (wp) { const sl = slPick(0); if (sl !== undefined && sl.score <= -1e9) this.lim.fire("boatsWaterPath", "sea"); } // refused by the cap
  }

  // ---------------------------------------------------------------- MIRV and the finish
  private lastMirvTick = -1e9;
  private lastCrownHeld = -1e9;
  private lastGuardLog = new Map<string, number>();
  private lastWarTick = -1e9;
  private strictFired = -1e9;
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
    this.ctx.log(`t${this.ctx.mg.ticks()} MIRV ${target.name()} ${target.numTilesOwned()}t (${why})${tile === center ? "" : " — aimed off-centre, the centre is under a SAM"}`);
  }
  /** The territory centre unless one of the target's SAMs covers it (Config.samRange(level) + 5, as maybeBomb): then
   *  the uncovered tile of its territory nearest the centre (sampled from its border), or null if there is none. */
  private mirvTile(target: Player, center: TileRef): TileRef | null {
    const mg = this.ctx.mg;
    const sams = target.units(UnitType.SAMLauncher);
    const covered = (t: TileRef) => sams.some((s) => mg.euclideanDistSquared(s.tile(), t) <= (mg.config().samRange(s.level()) + 5) ** 2);
    if (!covered(center)) return center;
    const border = target.borderTiles(), step = Math.max(1, Math.floor(border.size / 120));
    let best: TileRef | null = null, bestD = 1e18, i = 0;
    for (const t of border) {
      if ((i++ % step) !== 0 || covered(t)) continue;
      const d = mg.euclideanDistSquared(t, center);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
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
  /** The 4-connected pieces of `p`'s territory — exact, from the border alone. Each row's owned tiles form runs
   *  whose ends are border tiles (a run end has a non-owned tile beside it), so the runs come from the sorted border
   *  tiles of the row plus the map's left/right edges (an edge tile is not a border tile: GameMap.isBorder); runs
   *  in neighbouring rows that overlap in x are one piece (union-find). A row with no border tile is either empty or
   *  owned wall to wall. Cost O(border log border) against O(tiles) for a flood fill; tile counts are exact. */
  static pieces(mg: Game, p: Player): { tiles: number; border: TileRef[] }[] {
    const w = mg.width(), h = mg.height(), pid = p.smallID();
    const rows = new Map<number, TileRef[]>();
    for (const t of p.borderTiles()) { const y = mg.y(t); let r = rows.get(y); if (!r) { r = []; rows.set(y, r); } r.push(t); }
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
  /** The expand click this pass would make (decide half of expand()). */
  expandOption(): { troops: number; contested: boolean } | null {
    const { rivals, wilderness } = this.q.neighbours();
    if (!wilderness) {
      // `takeFallout`: nearby() hides irradiated free land, so this is the only path that ever expands into it
      if (!this.ctx.p.takeFallout || this.ctx.sit.troops < this.q.cap() * this.ctx.p.fightAbove) return null;
      const n = this.q.falloutBordering(this.ctx.mg.ticks());
      if (n === 0) return null;
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
      active++;
      clicks++;
      if (!oldOk) this.ctx.fire("multiWar");
      if (this.ctx.p.multiWar ? clicks >= 3 : !plentiful || clicks >= 2) return;
    }
  }
  /** follow-up click: the guide's two-click — a second wave 10 s later merges into the first */
  private tribeFollowUp(bot: Player): void {
    const w = this.waves.get(bot);
    if (!w || w.sent >= w.want || this.ctx.mg.ticks() - w.last < this.ctx.p.botFollowUpTicks) return;
    const send = this.ctx.send(bot.id(), Math.min(w.want - w.sent, Math.floor(this.ctx.sit.troops * this.ctx.p.botClickCap)), "tribe follow-up");
    if (send === 0) return;
    w.sent += send; w.last = this.ctx.mg.ticks();
    this.noteFollowUp(bot, send);
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
  /** utility: the tribes harvestBots would click this pass (decide half), cheapest first; follow-ups are not options
   *  (a running wave is a commitment — tribeFollowUps() sends them before the options are built). */
  private tribeOptions(): { bot: Player; want: number }[] {
    const me = this.ctx.me;
    const { bots, wilderness } = this.q.neighbours();
    const early = wilderness && this.ctx.p.botsAfterWild;
    const maxSend = Math.floor(this.ctx.sit.spendable * (early ? this.ctx.p.botEarlyShare : this.ctx.p.botMaxShare));
    const out: { bot: Player; want: number }[] = [];
    for (const bot of [...bots].sort((a, b) => a.troops() - b.troops())) {
      if (!me.canAttackPlayer(bot) || !this.reachable(bot) || this.q.outgoingTo(bot)) continue;
      const want = Math.ceil(bot.troops() * this.ctx.p.botRatio) + 500;
      if (want <= maxSend) out.push({ bot, want });
    }
    return out;
  }
  private tribeFollowUps(): void {
    for (const bot of this.q.neighbours().bots) if (this.ctx.me.canAttackPlayer(bot) && this.reachable(bot) && this.q.outgoingTo(bot)) this.tribeFollowUp(bot);
  }

  private threatFired = -1e9;
  /** review #5 (`threatMap`): the unfriendly rival massing on one of our segments (theirs > 1.5 × ours) without attacking
   *  yet; Economy's threat-post rule takes it first. No troops move pre-emptively. */
  prePosition: Player | null = null;
  /** Opposing attacks cancel troop-for-troop: answer a non-bot attack with a counter of the same size. */
  counterAttack(): void {
    const me = this.ctx.me;
    if (this.ctx.p.threatMap) {
      const tm = this.q.rivals.threat, attacking = new Set(me.incomingAttacks().map((a) => a.attacker()));
      let pre: Player | null = null;
      for (const r of this.ctx.sit.rivals) { if (attacking.has(r) || this.q.postFacing(r)) continue; const s = tm.exposedTo(r, this.ctx.p.threatPreRatio, Math.max(2000, this.ctx.sit.troops * 0.03)); if (s && (pre === null || tm.maxThreat(r) > tm.maxThreat(pre))) pre = r; }
      if (pre !== this.prePosition && pre !== null) this.ctx.log(`t${this.ctx.mg.ticks()} PRE-POSITION post vs ${pre.name()}: ${Math.round(tm.maxThreat(pre) / 1000)}k unanswered on our border`);
      this.prePosition = pre;
    }
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
      // `drainedNations`: the counter cancels troop-for-troop (AttackExecution.init), so a counter under the wave leaves
      // the rest of it standing — never below what cancels it, the reserve permitting (a Medium nation's wave is its
      // whole surplus; cancelled, it sits under its reserve ratio and cannot attack again until it regrows)
      const half = Math.floor(this.ctx.sit.troops * 0.5);
      let want = Math.min(Math.ceil(inc.troops() * 1.05), half);
      if (this.ctx.p.drainedNations && half < inc.troops() + 1) { want = Math.min(Math.ceil(inc.troops() * 1.05), inc.troops() + 1); this.lim.fire("drainedNations", "counter"); }
      const send = this.ctx.send(a.id(), want, "counter", 1000);
      if (send === 0) continue;
      this.noteSent(a);
      this.counters.add(a);
      this.ctx.log(`t${this.ctx.mg.ticks()} COUNTER ${a.name()} (${Math.round(inc.troops() / 1000)}k incoming) with ${Math.round(send / 1000)}k`);
      if (a.type() !== PlayerType.Bot) this.mark(a, "counter");
    }
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
    // `markTargets`: a running war is re-marked as soon as the cooldown allows (canTarget), so the allies keep piling on
    if (this.currentTarget_ && this.currentTarget_.isAlive() && this.q.outgoingTo(this.currentTarget_) && !me.isFriendly(this.currentTarget_)) this.mark(this.currentTarget_, "war");
    const gapOwner = this.splitOwner && this.splitOwner.isAlive() && nb.rivals.includes(this.splitOwner) ? this.splitOwner : null;
    const threatHere = this.ctx.sit.mode === "hold" ? nb.rivals.find((r) => this.ctx.sit.threats.includes(r)) ?? null : null;
    // `annexWars`: an unfriendly neighbour we hold most of the border of is an opportunity like the gap owner — we
    // attack from most of its border and nobody can reinforce it, so 1.2× is enough and the usual gates do not apply
    const annex = new Set<Player>();
    if (this.ctx.p.annexWars) for (const r of nb.rivals) if (this.q.annexable(r)) annex.add(r);
    const opportunity = (this.ctx.mg.ticks() >= 3000 && nb.rivals.some((r) => this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5)) || gapOwner !== null || threatHere !== null || annex.size > 0;
    // crown, not survival: a war is on when we can afford 2× someone's whole army out of the spendable troops,
    // not only when troops reach 70 % of a cap that cities keep raising
    // `drainedNations`: a drained nation is affordable at 1.5× — it cannot answer until it regrows past its reserve ratio
    const affordableAt = (r: Player) => r.troops() * (this.drained(r) ? Math.min(this.ctx.p.fightRatio, this.ctx.p.drainRatio) : this.ctx.p.fightRatio) + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare;
    const affordable = this.ctx.mg.ticks() >= this.ctx.p.fightNotBeforeTick && nb.rivals.some(affordableAt);
    if (affordable && !nb.rivals.some((r) => r.troops() * this.ctx.p.fightRatio + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare)) this.lim.fire("drainedNations", "affordable");
    if (!affordable && !opportunity && me.troops() < cap * this.ctx.p.fightAbove) return null; // a 1.67× push that keeps home healthy is always taken
    const atCapNow = me.troops() >= cap * 0.95;
    // invariant: one war at a time (two at cap); seven at once is how a 17M army evaporates
    const nonBot = this.ctx.sit.outgoing.filter((a) => a.target().isPlayer() && (a.target() as Player).type() !== PlayerType.Bot);
    const wars = nonBot.filter((a) => !this.counters.has(a.target() as Player)).length + this.pending.size;
    const limit = onTheClock(this.ctx.p, this.ctx.mg.ticks()) && atCapNow ? 2 : 1;
    // `multiWar`: a second and third war beside the running ones — a running counter occupies a slot (the strictOneWar
    // finding) — as long as the wave fits above the reserve and the total committed stays under fightMaxShare of the army
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
    // `strictOneWar`: counters occupy the second slot — one war plus counters, but no second war (opportunity wars
    // included) while a counter runs. A counter on the current target is that war (the old count skipped it, so
    // wars read 0 and another war could open beside it).
    if (this.ctx.p.strictOneWar) {
      const countersRunning = nonBot.some((a) => this.counters.has(a.target() as Player));
      const warsStrict = wars + nonBot.filter((a) => this.counters.has(a.target() as Player) && a.target() === this.currentTarget_).length;
      if (countersRunning && warsStrict >= 1) { if (this.ctx.mg.ticks() - this.strictFired >= 100) { this.strictFired = this.ctx.mg.ticks(); this.ctx.fire("strictOneWar"); } return null; }
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
      candidates = candidates.filter((r) => r === this.currentTarget_ || this.collapsed(r) || this.drained(r) || r === gapOwner || r === threatHere || annex.has(r));
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
    const { score, isOpp, wantFor, richer, yieldBonus } = this.warScorer(gapOwner, threatHere, annex, extra, extraRoom);
    let best: Player | null = null, bestS = 0, best0: Player | null = null, bestS0 = 0;
    const alts: WarPick["alts"] = [];
    for (const r of candidates) { const sc = score(r); if (sc > 0) alts.push({ r, want: wantFor(r), score: sc, opportunity: isOpp(r), annex: annex.has(r) }); if (sc > bestS) { bestS = sc; best = r; } const sc0 = sc - yieldBonus(r); if (sc0 > bestS0) { bestS0 = sc0; best0 = r; } }
    if (this.ctx.p.warYield && best !== best0) this.lim.fire("warYield", "pick"); // the cheaper tile changed the pick
    if (best === null) {
      if (atCapNow && this.ctx.mg.ticks() % 1200 < this.ctx.p.expandEvery) this.ctx.log(`t${this.ctx.mg.ticks()} idle at cap: ${rivals.map((r) => `${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k d${Math.round(this.q.density(r))} p${r.units(UnitType.DefensePost).length} ${candidates.includes(r) ? "" : "(no)"}`).join("; ")}`);
      return null;
    }
    const b = best;
    alts.sort((x, y) => (x.r === b ? -1 : y.r === b ? 1 : y.score - x.score));
    const bomb = richer(best) && best !== this.currentTarget_ && me.units(UnitType.MissileSilo).length > 0 && this.ctx.mg.ticks() - this.lastBombTick > 100;
    return { r: best, want: wantFor(best), bomb, opportunity: isOpp(best), annex: annex.has(best), alts, extra };
  }
  /** The scorer half of warPick, shared with wouldTarget(): the gates on ratio / posts / density / size and every
   *  bonus. `quiet` skips the flag counters (a what-if question, not a decision). */
  private warScorer(gapOwner: Player | null, threatHere: Player | null, annex: Set<Player>, extra = false, extraRoom = Infinity, quiet = false) {
    const me = this.ctx.me, cap = this.q.cap();
    const atCap = me.troops() >= cap * 0.95;
    const endgame = onTheClock(this.ctx.p, this.ctx.mg.ticks()) || this.ctx.sit.mode === "push"; // 25:00 (clockTicks − 3000) or the push — land now is worth more than troops later
    // review #5 (`threatMap`): prefer a rival whose army is committed on its other borders (+3 × busyElsewhere) and
    // avoid opening a war on a border where we are already contested (−2 × Σ vulnerability / troops)
    const threatBonus = (r: Player) => { if (!this.ctx.p.threatMap) return 0; const tm = this.q.rivals.threat; const b = this.ctx.p.threatBusyWeight * tm.busyElsewhere(r) - (this.ctx.p.threatVulnWeight * tm.vulnerability(r)) / Math.max(1, this.ctx.sit.troops); if (b !== 0 && !quiet && this.ctx.mg.ticks() - this.threatFired >= 100) { this.threatFired = this.ctx.mg.ticks(); this.ctx.fire("threatMap"); } return b; };
    const trustBonus = (r: Player) => { const b = this.ctx.p.trustWars ? 2 * (1 - (this.ctx.sit.rival.get(r)?.trust ?? 0.5)) : 0; if (b !== 0 && b !== 1 && !quiet) this.ctx.fire("trustWars"); return b; }; // C1: a rival that broke faith is the better target
    // At cap every troop above the line is wasted growth, so commit more and accept a thinner edge.
    // `multiWar`: an extra war is sized from what is left this pass, inside the army-wide share
    const maxSend = extra ? Math.min(extraRoom, Math.floor(this.ctx.sit.troops * (atCap || endgame ? 0.7 : this.ctx.p.fightMaxShare))) : Math.floor(me.troops() * (atCap || endgame ? 0.7 : this.ctx.p.fightMaxShare));
    const minRatio = atCap || endgame ? 1.2 : this.ctx.p.fightRatio;
    const richer = (r: Player) => this.q.cap() >= this.ctx.mg.config().maxTroops(r) * 2 && this.ctx.sit.gold >= 1_000_000n; // we replace losses, they cannot
    const attackingUs = new Set(me.incomingAttacks().map((a) => a.attacker()));
    // `retaliateAware`: the smaller attacker is invisible to `retaliate`; a 1.2× wave that stays under the bigger one
    const shadow = (r: Player) => { const w = this.shadowWave(r); return w >= Math.ceil(r.troops() * this.ctx.p.retalRatio) + 1000; };
    // `relationAware`: a nation still Friendly to us (a lapsed ally, a gift) drops to Distrustful on the first hit, not
    // Hostile — no `hated` hunt at 3× our troops, no embargo; Neutral is a coin toss (its raw value is not visible)
    const relationBonus = (r: Player) => { if (!this.ctx.p.relationAware) return 0; const rel = this.ctx.sit.rival.get(r)?.relation ?? null; const b = rel === Relation.Friendly ? 2 : rel === Relation.Neutral ? 0.5 : 0; if (b !== 0 && !quiet) this.lim.fire("relationAware", "score"); return b; };
    // `warYield`: a tile that will cost few troops is worth up to +4 (zero from yieldMaxTroopsPerTile up)
    const yieldBonus = (r: Player) => this.ctx.p.warYield ? 4 * clamp(1 - this.expectedCost(r) / this.ctx.p.yieldMaxTroopsPerTile, 0, 1) : 0;
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
    const score = (r: Player) => {
      const ratio = maxSend / Math.max(1, r.troops());
      if (denialGuard && !lastThreat(r)) { const d = this.risk.denial(r.numTilesOwned()); if (d.share >= d.threshold - 0.01) return guard(r, "denial", `its ${r.numTilesOwned()} tiles would carry our share to ${(d.share * 100).toFixed(1)} % (denial at ${(d.threshold * 100).toFixed(0)} %)`); }
      if (this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5) return ratio >= 1.5 ? 20 + ratio : -1; // bombed: go now at 1.5×, posts are gone
      if (r === gapOwner) return ratio >= 1.2 ? 30 + ratio : -1; // they are cutting our land in two: reconnect before the piece is handed over
      if (r === threatHere) return ratio >= 1.5 ? 25 + ratio : -1; // a MIRV-capable rival next door during the hold
      if (annex.has(r)) return ratio >= 1.2 ? 25 + ratio : -1; // `annexWars`: encircled — we come from most of its border, it cannot be reinforced
      if (steamrollGuard && !lastThreat(r)) { const s = this.risk.steamroll(r.unitCount(UnitType.City), r); if (s.over) return guard(r, "steamroll", `its ${r.unitCount(UnitType.City)} cities would carry us over the steamroll line (${s.units} vs ${s.threshold})`); }
      if (this.drained(r)) { if (!quiet) this.lim.fire("drainedNations", "score"); return ratio >= this.ctx.p.drainRatio ? 18 + ratio : -1; } // under its reserve ratio: it cannot answer until it regrows
      if (this.ctx.p.warYield && this.ctx.mg.ticks() - (this.yieldRetreatAt.get(r) ?? -1e9) < YIELD_COOLDOWN) return -1; // `warYield`: its tiles were too dear a minute ago
      const shadowed = shadow(r);
      if (shadowed && ratio >= this.ctx.p.retalRatio && ratio < minRatio && !quiet) this.lim.fire("retaliateAware", "gate");
      // at cap, a neighbour already attacking us is a fair fight at 1:1 — the counter-attack cancels its wave anyway
      const need = atCap && attackingUs.has(r) ? 1.0 : shadowed ? Math.min(minRatio, this.ctx.p.retalRatio) : richer(r) ? Math.min(minRatio, 1.5) : minRatio;
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
      if (shadowed && !quiet) this.lim.fire("retaliateAware", "score");
      return ratio * 2 + buildings + Math.min(this.q.density(r), 200) / 50 - posts * 3 - sizePenalty * 2 + bonus + (r === this.currentTarget_ ? 3 : 0) + trustBonus(r) + threatBonus(r) + (shadowed ? 2 : 0) + relationBonus(r) + yieldBonus(r);
    };
    const isOpp = (r: Player) => (this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5) || r === gapOwner || r === threatHere || this.drained(r) || annex.has(r);
    // the wave: 1.5× on a drained or a richer target, 1.2× as the smaller attacker (kept under the bigger wave by
    // shadowWave's test above) or on an annexable one, else fightRatio
    const wantFor = (r: Player) => { const mult = annex.has(r) ? Math.min(this.ctx.p.fightRatio, 1.2) : this.drained(r) ? Math.min(this.ctx.p.fightRatio, this.ctx.p.drainRatio) : shadow(r) ? Math.min(this.ctx.p.fightRatio, this.ctx.p.retalRatio) : richer(r) ? Math.min(this.ctx.p.fightRatio, 1.5) : this.ctx.p.fightRatio; return Math.min(Math.ceil(r.troops() * mult) + 1000, maxSend); };
    return { score, isOpp, wantFor, richer, yieldBonus };
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
    const ratioFor = this.drained(p) ? Math.min(this.ctx.p.fightRatio, this.ctx.p.drainRatio) : this.ctx.p.fightRatio;
    const affordable = now >= this.ctx.p.fightNotBeforeTick && p.troops() * ratioFor + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare;
    const opportunity = annex.size > 0 || this.drained(p) || (now >= 3000 && this.collapsed(p) && p.troops() < this.ctx.sit.troops * 0.5);
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
    if (pick.bomb) { this.currentTarget_ = r; this.maybeBomb(now); } // open the war with a bomb on their cluster
    if (pick.want < 1000) return false;
    if (!pick.extra) this.currentTarget_ = r; // `multiWar`: the sticky target stays the first war's
    this.counters.delete(r); // a war wave, whatever the counter before it did
    if (!me.hasEmbargoAgainst(r) && r.type() !== PlayerType.Nation) { me.addEmbargo(r, false); this.embargoedAt_.set(r, now); }
    const want = this.ctx.send(r.id(), pick.want, "war", 1000, 0.3);
    if (want === 0) return false;
    if (!pick.extra) this.lastWarTick = now;
    this.noteSent(r);
    this.pending.set(r, want);
    if (pick.extra) { this.ctx.fire("multiWar"); this.ctx.log(`t${now} WAR #${this.pending.size + this.ctx.sit.outgoing.filter((a) => a.target().isPlayer() && (a.target() as Player).type() !== PlayerType.Bot).length} beside the running ones`); }
    if (pick.annex) { this.ctx.log(`t${now} ANNEX WAR ${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k ← ${Math.round(want / 1000)}k (${(want / Math.max(1, r.troops())).toFixed(2)}×): we hold most of its border`); this.lim.fire("annexWars", "war"); }
    this.ctx.log(`t${now} ATTACK ${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k ← ${Math.round(want / 1000)}k (${(want / Math.max(1, r.troops())).toFixed(2)}×)${this.drained(r) ? " drained" : this.shadowWave(r) >= Math.ceil(r.troops() * this.ctx.p.retalRatio) + 1000 ? " as the smaller attacker" : ""}`);
    this.noteWave(r, want);
    this.mark(r, "war");
    return true;
  }

  // ---------------------------------------------------------------- utility (#3): one currency for troops
  private utilEst = new Map<Player, { tick: number; troops: number; est: AttackEstimate }>();
  private utilLogged = -1e9;
  /** The estimate of `troops` against `t` over the phase horizon, cached UTIL_EST_EVERY ticks (re-run when the wave moves by 20 %). */
  private utilEstimate(t: Player, troops: number): AttackEstimate {
    const now = this.ctx.mg.ticks(), c = this.utilEst.get(t);
    if (c && now - c.tick < UTIL_EST_EVERY && Math.abs(c.troops - troops) <= c.troops * 0.2) return c.est;
    const est = estimateAttack(this.ctx.mg, this.ctx.me, t, troops, { horizonTicks: this.utilHorizon(), ...this.estOpts(t) });
    this.utilEst.set(t, { tick: now, troops, est });
    return est;
  }
  /** The currency: tiles per troop LOST — free land's 16–24 a tile is the click's losses (the rest comes home), so a
   *  tribe or a war counts its estimated losses too, never under a tenth of the wave (troops tied up are not free). */
  private tilesPerTroop(est: AttackEstimate, want: number): number {
    return est.tilesTaken / Math.max(1, est.attackerLoss, want * 0.1);
  }
  /** How far ahead an option is judged: 2:30 in the opening (free land is cheaper than anything that takes longer),
   *  5:00 in consolidate / war, what is left of the clock (clockTicks) in the endgame (at least a minute; 5:00 with no clock). */
  private utilHorizon(): number {
    const ph = this.ctx.sit.phase;
    if (ph === "opening") return 1500;
    if (ph === "endgame") return this.ctx.p.clockTicks > 0 ? Math.max(600, Math.min(3000, this.ctx.p.clockTicks - this.ctx.sit.tick)) : 3000;
    return 3000;
  }
  /** Border-threat consideration shared by every option: 1 on a calm border, down to 0.5 when the unanswered pressure
   *  (threatMap) equals our army, or (without the map) when the worst border-security ratio reaches 2. */
  private utilThreat(): number {
    if (this.ctx.p.threatMap) return 1 - 0.5 * clamp(this.q.rivals.threat.undefended / Math.max(1, this.ctx.sit.troops));
    let maxBsr = 0;
    for (const [r, v] of this.ctx.sit.rival) if (!this.ctx.me.isFriendly(r) && v.bsr > maxBsr) maxBsr = v.bsr;
    return 1 - 0.5 * clamp(maxBsr - 1);
  }
  /** `utility`: the one troops rule. Counters (rank 0) and tribe follow-ups (commitments) go first; then every expand
   *  click, tribe click and war wave the chain could send this pass is an Option scored in tiles per troop (free land
   *  at FREE_LAND_TROOPS_PER_TILE, tribes and wars by the estimator over the phase horizon) × compensated
   *  considerations, and the options execute by rank then weight through the same act* paths and the same send():
   *  the reserve, whole-or-nothing wars, one war per pass, the tribe concurrency cap, hold and the sticky target all
   *  stay. Fires when the first thing sent differs from what the ordered rules would have sent first. */
  troopsRule(): void {
    const me = this.ctx.me, sit = this.ctx.sit, p = this.ctx.p, now = this.ctx.mg.ticks();
    this.counterAttack();
    this.tribeFollowUps();
    this.pending.clear();
    const threat = this.utilThreat();
    const options: Option[] = [];
    const ex = this.expandOption();
    if (ex !== null && ex.troops >= 100) options.push({ kind: "expand", target: null, troops: ex.troops, rank: 2, weight: (1 / p.utilFreeLandCost) * compensate([threat]), why: `${ex.contested ? "contested" : "free"} land at ${p.utilFreeLandCost}/tile, border ${threat.toFixed(2)}` });
    const tribes = this.tribeOptions();
    for (const { bot, want } of tribes) {
      const est = this.utilEstimate(bot, want);
      const size = 1 - 0.5 * linear(want / Math.max(1, sit.spendable)); // a click that eats the spendable leaves nothing for the next pass
      options.push({ kind: "tribe", target: bot, troops: want, rank: 2, weight: this.tilesPerTroop(est, want) * compensate([threat, size]), why: `${est.tilesTaken}t for ${Math.round(want / 1000)}k${est.wins ? "" : " (not won in the horizon)"}, border ${threat.toFixed(2)}, size ${size.toFixed(2)}` });
    }
    const war = this.warPick();
    if (war !== null) {
      for (const a of war.alts) {
        const est = this.utilEstimate(a.r, a.want);
        const tpt = this.tilesPerTroop(est, a.want);
        const troopsC = logistic(sit.capShare, p.utilCapMid, p.utilCapSteep); // utilCapMid (= fightAbove by default) is the midpoint, not a gate
        const marginC = (est.wins ? 1 : 0.8) * (0.6 + 0.4 * linear(est.troopsLeft / a.want, 0, 0.5)); // what the wave has left over; an estimate still open at the horizon is judged on the same footing, discounted
        const trustC = 0.5 + 0.5 * (1 - (sit.rival.get(a.r)?.trust ?? 0.5));
        const expiryC = sit.expiring.some((o) => o !== a.r && o.type() === PlayerType.Nation) ? 0.7 : 1; // an alliance about to lapse elsewhere wants the army near home
        const scoreC = 0.5 + 0.5 * linear(a.score, 0, p.utilScoreFull); // the scorer's bonuses (trust, threat map, relation, shadow, buildings) modulate, they do not gate
        const commit = a.r === this.currentTarget_ && now - this.lastWarTick < 1800 ? p.utilCommit : 1; // the running war
        const weight = tpt * compensate(a.opportunity ? [marginC, scoreC] : [troopsC, marginC, threat, trustC, expiryC, scoreC]) * commit;
        options.push({ kind: "war", target: a.r, troops: a.want, rank: a.opportunity ? 1 : 2, weight, why: `${est.tilesTaken}t for ${Math.round(a.want / 1000)}k ${est.wins ? "wins" : "open"}, cap ${troopsC.toFixed(2)}, margin ${marginC.toFixed(2)}, border ${threat.toFixed(2)}, trust ${trustC.toFixed(2)}, expiry ${expiryC}, score ${a.score.toFixed(1)}${a.opportunity ? ", opportunity" : ""}${commit > 1 ? ", committed" : ""}` });
      }
    }
    const ranked = rankOptions(options);
    if (ranked.length > 0 && now - this.utilLogged >= 300) { this.utilLogged = now; this.ctx.log(`t${now} UTIL ${ranked.slice(0, 3).map(describeOption).join(" | ")}`); }
    const plentiful = me.troops() > this.q.cap() * p.fightAbove;
    const oldMax = p.tribeConcurrency + (sit.capShare > 0.6 ? 1 : 0);
    const maxConcurrent = p.multiWar ? Math.max(oldMax, 2 + (sit.capShare > 0.6 ? 1 : 0)) : oldMax; // multiWar: as harvestBots
    let active = sit.tribeAttacks, clicks = 0, warDone = false, first: Option | null = null;
    for (const o of ranked) {
      let ok = false;
      if (o.kind === "war") {
        if (war === null) continue;
        if (warDone) {
          // `multiWar`: a further war option is re-picked against the slots and commitments the first one left
          if (!p.multiWar) continue;
          const again = this.warPick();
          const alt = again?.alts.find((a) => a.r === o.target);
          if (again === undefined || again === null || alt === undefined) continue;
          ok = this.actWar(alt.r === again.r ? again : { ...again, r: alt.r, want: alt.want, bomb: false, opportunity: alt.opportunity, annex: alt.annex });
          if (ok && first === null) first = o;
          continue;
        }
        const alt = war.alts.find((a) => a.r === o.target);
        if (alt === undefined) continue;
        ok = this.actWar(alt.r === war.r ? war : { ...war, r: alt.r, want: alt.want, bomb: false, opportunity: alt.opportunity, annex: alt.annex });
        if (ok) warDone = true;
      } else if (o.kind === "expand") ok = this.actExpand(o.troops) > 0;
      else if (o.kind === "tribe" && o.target !== null) {
        if (active >= maxConcurrent || clicks >= (p.multiWar ? 3 : plentiful ? 2 : 1)) continue;
        const oldOk = active < oldMax && clicks < (plentiful ? 2 : 1);
        ok = this.tribeClick(o.target, o.troops);
        if (ok) { active++; clicks++; if (!oldOk) this.ctx.fire("multiWar"); }
      }
      if (ok && first === null) first = o;
    }
    // liveness: the chain sends the expand click whenever it can, else the cheapest affordable tribe, else the war
    const chainFirst = ex !== null && ex.troops >= 100 ? "expand" : tribes.length > 0 ? `tribe ${tribes[0].bot.id()}` : war !== null ? `war ${war.r.id()}` : null;
    const key = first === null ? null : first.kind === "expand" ? "expand" : `${first.kind} ${first.target?.id()}`;
    if (key !== null && key !== chainFirst) this.lim.fire("utility", "pick");
  }

  // ---------------------------------------------------------------- the estimator: calibration
  /** Calibration scales for an estimate against `t` (Params.estLossScale*, estSpeedScale), plus — with trustWars on — the
   *  troops its living allies on our border could send at us (RivalView.nationWouldSend), counted as part of its army. */
  estOpts(t: Player): EstimateOptions {
    const p = this.ctx.p;
    const lossScale = t.type() === PlayerType.Nation ? p.estLossScaleNation : t.type() === PlayerType.Bot ? p.estLossScaleBot : p.estLossScaleHuman;
    let extra = 0;
    if (p.trustWars) for (const a of t.allies()) { const v = a.isAlive() ? this.ctx.sit.rival.get(a) : undefined; if (v && v.nationCanAttack) extra += v.nationWouldSend; }
    return { lossScale, speedScale: p.estSpeedScale, extraDefenderTroops: extra };
  }
  private calib = new Map<Player, CalibRecord>();
  private calibSeq = 0;
  /** Bookkeeping for the calibration log (always on, log only): a war wave or a tribe's first click opens a record and
   *  logs the estimate for it; trackCalibration() logs the outcome. */
  private noteWave(t: Player, troops: number): void {
    if (this.calib.has(t)) { this.noteFollowUp(t, troops); return; } // a second war wave merges into the running attack (AttackExecution.init)
    const now = this.ctx.mg.ticks();
    const e = estimateAttack(this.ctx.mg, this.ctx.me, t, troops, { horizonTicks: CALIB_HORIZON, ...this.estOpts(t) });
    const wave = ++this.calibSeq;
    const others = t.incomingAttacks().filter((a) => a.attacker() !== this.ctx.me).length;
    this.calib.set(t, { wave, tick: now, sent: troops, tiles0: t.numTilesOwned(), ours0: this.ctx.me.numTilesOwned(), others, last: troops, seen: false, retreating: false, y: { tick: now, tiles: 0, lost: 0, tilesAt: t.numTilesOwned(), troopsAt: troops, sentAt: troops, win: [] } });
    this.ctx.log(`t${now} EST ${t.name()} wave=${wave} troops=${troops} tilesEst=${e.tilesTaken} lossEst=${Math.round(e.attackerLoss)} ticksEst=${e.ticks} wins=${e.wins} class=${Military.klass(t)} others=${others}`);
  }
  private noteFollowUp(t: Player, troops: number): void { const c = this.calib.get(t); if (c) c.sent += troops; }
  private static klass(t: Player): string { return t.type() === PlayerType.Nation ? "nation" : t.type() === PlayerType.Bot ? "bot" : "human"; }
  /** Every 10 ticks (from manageRetreats): follow each recorded wave; when its attack has left outgoingAttacks() log
   *  ACT — tiles the target lost (and our net tile change, for the reader: other attackers and our expansion confound
   *  both), troops lost = sent − the last troop count seen on the attack, ticks, and how it ended (dead / done /
   *  retreat, or fast = gone before it was ever seen, loss unknown and logged as 0). */
  private trackCalibration(): void {
    const now = this.ctx.mg.ticks();
    for (const [t, c] of this.calib) {
      const a = this.q.outgoingTo(t);
      if (a !== undefined) { c.seen = true; c.last = a.troops(); if (a.retreating()) c.retreating = true; if (now - c.y.tick >= YIELD_EVERY) this.sampleYield(c, t, a.troops()); continue; }
      if (!c.seen && now - c.tick <= 12) continue;
      const tiles = Math.max(0, c.tiles0 - t.numTilesOwned());
      // never observed: over before the first 10-tick pass (a small tribe, logged as end=fast with the loss unknown)
      // or never materialised (no front, cancelled by an incoming wave, unreachable) — no outcome to log
      if (!c.seen && tiles === 0 && t.isAlive()) { this.calib.delete(t); continue; }
      const end = !c.seen ? "fast" : !t.isAlive() ? "dead" : c.retreating ? "retreat" : "done";
      const left = c.seen ? c.last : c.sent;
      this.ctx.log(`t${now} ACT ${t.name()} wave=${c.wave} tiles=${tiles} ours=${this.ctx.me.numTilesOwned() - c.ours0} loss=${Math.max(0, Math.round(c.sent - left))} ticks=${now - c.tick} sent=${c.sent} left=${Math.round(left)} class=${Military.klass(t)} end=${end}`);
      if (t.type() !== PlayerType.Bot && c.seen) {
        // WAR RESULT (always on): the war's return — tiles attributable to us, troops that did not come back (a
        // recalled wave gets RETREAT_MALUS of its survivors home), the price of a tile, the war's length
        this.sampleYield(c, t, left, true);
        const lost = Math.max(0, Math.round(c.sent - left * (end === "retreat" ? RETREAT_MALUS : 1)));
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
  private hyst = new Map<string, { lastCheck: number; strikes: number }>();
  /** hystRetreats: the two-branch decision for a running war. 'continue' = what the estimate says the wave has after
   *  HYST_HORIZON more ticks (survivors home at the retreat malus, plus the tiles it took at HYST_TILE_WORTH each);
   *  'retreat now' = the survivors home at the malus. Continue has to beat retreat by a margin that
   *  grows with the largest border-security ratio on our other borders — the more exposed home is, the sooner the
   *  army is wanted back. Returns the verdict and the numbers for the log. */
  private hystJudge(a: Attack, t: Player): { keep: boolean; lost: boolean; est: AttackEstimate; margin: number; cont: number; ret: number } {
    const est = estimateAttack(this.ctx.mg, this.ctx.me, t, a.troops(), { horizonTicks: HYST_HORIZON, stopBelow: 1, ...this.estOpts(t) });
    let maxBsr = 0;
    for (const [r, v] of this.ctx.sit.rival) if (r !== t && !this.ctx.me.isFriendly(r) && v.bsr > maxBsr) maxBsr = v.bsr;
    const margin = this.ctx.p.hystMargin + this.ctx.p.hystSlope * Math.max(0, Math.min(2, maxBsr - 1));
    const cont = est.troopsLeft * RETREAT_MALUS + est.tilesTaken * HYST_TILE_WORTH; // continue wins while a tile costs under HYST_TILE_WORTH / RETREAT_MALUS = 80 troops
    const ret = a.troops() * RETREAT_MALUS;
    const lost = !est.wins && a.troops() < t.troops() * this.ctx.p.retreatBelowRatio;
    return { keep: !lost && cont >= ret * (1 + margin), lost, est, margin, cont, ret };
  }
  manageRetreats(): void {
    const me = this.ctx.me;
    this.trackCalibration();
    for (const id of this.hyst.keys()) if (!me.outgoingAttacks().some((a) => a.id() === id)) this.hyst.delete(id);
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
      if (this.ctx.p.hystRetreats) {
        // #4: every HYST_EVERY ticks judge continue vs retreat; hystStrikes losing verdicts in a row (or a wave lost
        // outright) bring it home. The literal thresholds are the oscillation the field spent years removing.
        let h = this.hyst.get(a.id());
        if (!h) { h = { lastCheck: this.ctx.mg.ticks(), strikes: 0 }; this.hyst.set(a.id(), h); }
        if (this.ctx.mg.ticks() - h.lastCheck < HYST_EVERY) { if ((losing || posts) && this.ctx.mg.ticks() % HYST_EVERY === 0) this.ctx.fire("hystRetreats"); continue; } // the literals would have recalled it now
        h.lastCheck = this.ctx.mg.ticks();
        const v = this.hystJudge(a, t);
        h.strikes = v.keep ? 0 : h.strikes + 1;
        const go = v.lost || h.strikes >= this.ctx.p.hystStrikes;
        if (go !== (losing || posts)) this.ctx.fire("hystRetreats");
        if (go) {
          this.retreat(a);
          this.ctx.log(`t${this.ctx.mg.ticks()} retreat from ${t.name()} (${Math.round(a.troops() / 1000)}k left; ${v.lost ? "lost outright" : `strike ${h.strikes}`}: continue ${Math.round(v.cont / 1000)}k vs home ${Math.round(v.ret / 1000)}k, margin ${v.margin.toFixed(2)}, est ${v.est.tilesTaken}t/${Math.round(v.est.troopsLeft / 1000)}k left after ${v.est.ticks} ticks)`);
        } else if (h.strikes > 0) {
          this.ctx.log(`t${this.ctx.mg.ticks()} war on ${t.name()} losing (strike ${h.strikes}): continue ${Math.round(v.cont / 1000)}k vs home ${Math.round(v.ret / 1000)}k, margin ${v.margin.toFixed(2)}`);
        }
        continue;
      }
      if (losing || posts) {
        this.retreat(a);
        this.ctx.log(`t${this.ctx.mg.ticks()} retreat from ${t.name()} (${Math.round(a.troops() / 1000)}k left)`);
      }
    }
  }

  // ---------------------------------------------------------------- boats
  /** Playbook 0:05–0:10: one 20 % boat to a tribe across water (2× its troops) or, failing that, the nearest empty shore across water. */
  earlyBoat(): boolean {
    const me = this.ctx.me;
    if (me.unitCount(UnitType.TransportShip) >= this.ctx.mg.config().boatMaxNumber()) return false;
    const shore = Array.from(me.borderTiles()).filter((t) => this.ctx.mg.isShore(t));
    if (shore.length === 0) return false;
    const from = shore[Math.floor(shore.length / 2)];
    const fx = this.ctx.mg.x(from), fy = this.ctx.mg.y(from);
    const distOld = (t: TileRef) => Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
    const sample = this.ctx.p.boatsNearest ? this.shoreSample() : []; // `boatsNearest`: see seaExpansion
    const nearest = sample.length > 0;
    const dist = nearest ? (t: TileRef) => this.nearestShoreDist(t, sample) : distOld;
    // `boatsWaterPath`: rank by the path the ship sails (d), refuse beyond BOAT_MAX_PATH.early; dm is the
    // straight-line distance (slOk: the straight-line ranking's candidates, for the liveness count)
    const wp = this.ctx.p.boatsWaterPath ? this.waterPath() : null;
    // with the flag on, our own coast is near by water too (a tile 40 tiles up it sails 40), so more candidates are
    // tried and the bounded breadth-first acrossWaterNear (radius 2 × dm + 20) does the land check — the depth-first
    // acrossWater gives up at 4000 tiles and calls a tile up our own coast "across water" on a big landmass
    const across = (t: TileRef, dm: number) => (nearest || wp ? this.q.acrossWaterNear(t, dm) : this.q.acrossWater(t));
    const cands: { tile: TileRef; troops: number; d: number; dm: number; slOk: boolean; oldD: number; oldOk: boolean; what: string }[] = [];
    for (const bot of this.ctx.mg.players()) {
      if (bot.type() !== PlayerType.Bot || !bot.isAlive()) continue;
      const want = Math.ceil(bot.troops() * 2) + 500; // a beach landing costs more than a land attack: 2×, not 1.67×
      if (want > me.troops() * 0.4) continue;
      let i = 0, bestT: TileRef | null = null, bestD = 1e9, oldT: TileRef | null = null, oldD = 1e9, slT: TileRef | null = null, slD = 1e9;
      for (const t of bot.borderTiles()) {
        if ((i++ % 5) !== 0 || !this.ctx.mg.isShore(t)) continue;
        const dm = dist(t); if (dm < slD) { slD = dm; slT = t; }
        const d = wp ? wp.len(t) : dm; if (d < bestD) { bestD = d; bestT = t; }
        if (nearest) { const dO = distOld(t); if (dO < oldD) { oldD = dO; oldT = t; } }
      }
      if (!nearest) { oldT = slT; oldD = slD; }
      const troops = Math.max(want, Math.floor(me.troops() * this.ctx.p.boatShare));
      const ok = bestT !== null && bestD <= (wp ? BOAT_MAX_PATH.early : 250), slOk = slT !== null && slD <= 250;
      if (ok) cands.push({ tile: bestT!, troops, d: bestD + 80, dm: slD + 80, slOk: slOk && slT === bestT, oldD: oldD + 80, oldOk: oldD <= 250 && oldT === bestT, what: `tribe ${bot.name()}` }); // open shore preferred: free land, no losses; a tribe only when no empty coast is near
      if (nearest && oldT !== null && oldD <= 250 && (!ok || oldT !== bestT)) cands.push({ tile: oldT, troops, d: 1e9, dm: slD + 80, slOk: false, oldD: oldD + 80, oldOk: true, what: `tribe ${bot.name()}` }); // the old ranking's tile, for the liveness count only
      if (wp && slOk && (!ok || slT !== bestT)) cands.push({ tile: slT!, troops, d: 1e9, dm: slD + 80, slOk: true, oldD: oldD + 80, oldOk: false, what: `tribe ${bot.name()}` }); // the straight-line ranking's tile, for the liveness count only
    }
    const box = this.scanBox(sample, fx, fy, 200);
    for (let y = box.y0; y <= box.y1; y += 6) for (let x = box.x0; x <= box.x1; x += 6) {
      if (!this.ctx.mg.isValidCoord(x, y)) continue;
      const t = this.ctx.mg.ref(x, y);
      if (!this.ctx.mg.isLand(t) || !this.ctx.mg.isShore(t) || this.ctx.mg.hasOwner(t)) continue;
      const dOld = Math.abs(x - fx) + Math.abs(y - fy);
      const dm = nearest ? dist(t) : dOld;
      if (dm < (nearest ? 10 : 30)) continue;
      const slOk = !(nearest && dm > 200);
      const d = wp ? wp.len(t) : dm;
      if (wp ? d > BOAT_MAX_PATH.early && !slOk : !slOk) continue;
      cands.push({ tile: t, troops: Math.floor(me.troops() * this.ctx.p.boatShare), d: wp && d > BOAT_MAX_PATH.early ? 1e9 : d, dm, slOk, oldD: dOld, oldOk: dOld >= 30 && Math.abs(x - fx) <= 200 && Math.abs(y - fy) <= 200 && (x - fx) % 6 === 0 && (y - fy) % 6 === 0, what: "empty shore" });
    }
    cands.sort((a, b) => a.d - b.d);
    // `boatsWaterPath` liveness: what the straight-line ranking (this rule with the flag off) would have launched at
    const slPick = () => cands.filter((o) => o.slOk).sort((a, b) => a.dm - b.dm).slice(0, 16).find((o) => o.troops >= 500 && across(o.tile, o.dm));
    for (const c of cands.slice(0, wp ? 48 : 16)) {
      if (c.d >= 1e9 || c.troops < 500 || !across(c.tile, c.dm)) continue;
      if (this.ctx.boat(c.tile, c.troops, `early boat → ${c.what}, ${c.d} tiles${wp ? " by water" : ""}`) === 0) continue;
      if (nearest) {
        // liveness: what the old ranking (middle tile, 30-tile floor) would have launched at
        const old = cands.filter((o) => o.oldOk).sort((a, b) => a.oldD - b.oldD).slice(0, 16).find((o) => o.troops >= 500 && this.q.acrossWater(o.tile));
        if (old === undefined || old.tile !== c.tile) this.lim.fire("boatsNearest", "early");
      }
      if (wp) { const sl = slPick(); if (sl === undefined || sl.tile !== c.tile) this.lim.fire("boatsWaterPath", "early"); }
      return true;
    }
    if (wp) { const sl = slPick(); if (sl !== undefined && sl.d >= 1e9) this.lim.fire("boatsWaterPath", "early"); } // refused by the cap
    return false;
  }

  /** No bots on our borders: boat to the nearest bot within reach, with 1.67× its troops. */
  private boatedAt = new Map<Player, number>();
  huntBotsByBoat(): void {
    const me = this.ctx.me;
    if (this.q.neighbours().bots.length > 0) return;
    if (me.units(UnitType.TransportShip).length > 0) return; // one landing at a time; a second boat to the same beach is the 'boat that takes no land'
    if (me.troops() < this.q.cap() * 0.4) return;
    const shore = Array.from(me.borderTiles()).filter((t) => this.ctx.mg.isShore(t));
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
      for (const t of bot.borderTiles()) {
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
    if (this.ctx.boat(best, troops, `to tribe ${bestBot.name()} ${bestBot.numTilesOwned()}t/${Math.round(bestBot.troops() / 1000)}k, ${bestD} tiles${wp ? " by water" : ""}`) === 0) return;
    if (!this.ctx.dry) this.boatedAt.set(bestBot, this.ctx.mg.ticks());
    if (nearest && oldBest !== best) this.lim.fire("boatsNearest", "tribe");
    if (wp && slBest !== best) this.lim.fire("boatsWaterPath", "tribe");
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

  // ---------------------------------------------------------------- nukes
  /** `spent`: gold Economy.build committed this pass (deducted next tick). NukeExecution checks the price on its own
   *  tick and silently drops a launch it cannot pay for, while the cooldown, the `bombed` blacklist and the bomb
   *  count were already recorded here — so the bomb is judged on what is left after this pass's buys. */
  maybeBomb(ticks: number, spent = 0n): void {
    const me = this.ctx.me;
    if (me.units(UnitType.MissileSilo).length === 0) return;
    if (ticks - this.lastBombTick < this.ctx.p.bombEvery) return;
    const atomCost = this.ctx.mg.config().unitInfo(UnitType.AtomBomb).cost(this.ctx.mg, me);
    const hCost = this.ctx.mg.config().unitInfo(UnitType.HydrogenBomb).cost(this.ctx.mg, me);
    const gold = me.gold();
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
      return;
    }
    const { enemies, rich } = this.bombEnemies(gold, true);
    if (enemies.size === 0) return;
    const reserve = BigInt(rich ? 2_000_000 : this.ctx.p.bombReserve);
    const best = this.bombSearch(enemies, rich, (type) => gold - spent >= (type === UnitType.HydrogenBomb ? hCost : atomCost) + reserve);
    if (best === null) return;
    this.launch(best, ticks);
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
  private bombEnemies(gold: bigint, mutate: boolean): { enemies: Set<Player>; rich: boolean } {
    const me = this.ctx.me;
    const enemies = new Set<Player>();
    if (this.currentTarget_ && this.currentTarget_.isAlive() && !me.isFriendly(this.currentTarget_)) enemies.add(this.currentTarget_);
    for (const inc of me.incomingAttacks()) { const a = inc.attacker(); if (a.type() !== PlayerType.Bot && !me.isFriendly(a) && inc.troops() > me.troops() * 0.05) enemies.add(a); }
    const plannedTarget = this.plannedTarget();
    if (plannedTarget && plannedTarget.isAlive() && !me.isFriendly(plannedTarget)) enemies.add(plannedTarget);
    for (const r of this.ctx.sit.collapsed) if (!me.isFriendly(r)) enemies.add(r);
    if (this.ctx.sit.share >= 0.5) for (const r of this.ctx.sit.threats) if (me.canAttackPlayer(r) || this.q.neighbours().rivals.includes(r)) enemies.add(r); // whoever could fire at the crown
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
    return { enemies, rich };
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
  private bombSearch(enemies: Set<Player>, rich: boolean, allow: (type: UnitType) => boolean): BombPick | null {
    const atomCost = this.ctx.mg.config().unitInfo(UnitType.AtomBomb).cost(this.ctx.mg, this.ctx.me);
    const hCost = this.ctx.mg.config().unitInfo(UnitType.HydrogenBomb).cost(this.ctx.mg, this.ctx.me);
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
          const perGold = value / Number(cost / 100_000n);
          if (value >= 4 && (best === null || perGold > best.value) && !this.blastCollateral(tile, type, enemy)) best = { tile, value: perGold, type, enemy, cost };
        }
      }
    }
    return best;
  }
  // ---------------------------------------------------------------- bombBudget: the planned bomb and its fund
  private planCache: { tick: number; plan: BombPick | null } | null = null;
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
    let plan: BombPick | null = null;
    if (me.units(UnitType.MissileSilo).length > 0) {
      const { enemies, rich } = this.bombEnemies(gold, false);
      if (enemies.size > 0) {
        const any = this.bombSearch(enemies, rich, () => true);
        if (any !== null && any.type === UnitType.HydrogenBomb && gold + BigInt(Math.round(this.income.rate * BOMB_FUND_HORIZON)) >= any.cost) plan = any;
        else plan = any !== null && any.type === UnitType.AtomBomb ? any : this.bombSearch(enemies, rich, (type) => type === UnitType.AtomBomb);
      }
    }
    this.planCache = { tick: ticks, plan };
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
