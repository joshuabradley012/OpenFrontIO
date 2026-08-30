// Military: expansion, tribe harvesting, counter-attacks, wars and retreats, boats, bombs, MIRV, split watch.

import { Attack, Game, Player, PlayerType, Relation, UnitType } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { ConstructionExecution } from "../ConstructionExecution";
import { MirvExecution } from "../MIRVExecution";
import { RetreatExecution } from "../RetreatExecution";
import { TargetPlayerExecution } from "../TargetPlayerExecution";
import { calculateTerritoryCenter } from "../Util";
import { BotContext, FireLimiter } from "./Context";
import { AttackEstimate, EstimateOptions, estimateAttack } from "./Estimate";
import { SituationQueries } from "./Situation";

const SIM_HORIZON = 3000; // simWars: a war that has not resolved in 5 minutes is judged on where it stands then
const SIM_MARGIN = 0.2; // simWars: the wave must end with this share of itself still standing
const SIM_OPPORTUNITY_LOSS_PER_TILE = 150; // simWars: even a collapsed / gap-owner / threat target is not worth more than this per tile
const HYST_EVERY = 100; // hystRetreats: ticks between re-estimates of a running war
const HYST_HORIZON = 600; // hystRetreats: the 'continue' branch is judged one minute ahead
const HYST_STRIKES = 2; // hystRetreats: consecutive losing re-estimates before the wave comes home
const HYST_TILE_WORTH = 60; // hystRetreats: what a tile of the target is worth in troops — the non-wilderness bar of simMaxLossPerTile. The wilderness discount belongs to opening a war, not to abandoning one
const RETREAT_MALUS = 0.75; // AttackExecution.retreat(25) against a player: the share of a recalled wave that gets home
interface SimPick { troops: number; est: AttackEstimate; tilesPerLoss: number; value: number }
/** One war or tribe wave under calibration bookkeeping (EST at the send, ACT when the attack is gone). */
interface CalibRecord { wave: number; tick: number; sent: number; tiles0: number; ours0: number; others: number; last: number; seen: boolean; retreating: boolean }

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
  private lastInvasionTick = -1e9;
  private lim: FireLimiter;

  constructor(
    private ctx: BotContext,
    private q: SituationQueries,
    private plannedTarget: () => Player | null, // Diplomacy.plannedTarget
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
    for (const m of [this.waves, this.sentAt, this.blacklist, this.lastCounter, this.embargoedAt_, this.boatedAt, this.history, this.pileInLogged]) for (const p of m.keys()) if (dead(p)) m.delete(p);
    for (const [p, until] of this.blacklist) if (t >= until) this.blacklist.delete(p);
    for (const [p, s] of this.sentAt) if (t - s.tick >= 12) this.sentAt.delete(p); // reachable() only reads it inside 12 ticks
    for (const [p, at] of this.lastCounter) if (t - at >= 300) this.lastCounter.delete(p);
    for (const [p, at] of this.boatedAt) if (t - at >= 900) this.boatedAt.delete(p);
    for (const [p, at] of this.pileInLogged) if (t - at >= 600) this.pileInLogged.delete(p);
    for (const [p, at] of this.embargoedAt_) if (t - at > 1200 && !me.hasEmbargoAgainst(p)) this.embargoedAt_.delete(p);
    const running = new Set(me.outgoingAttacks().map((a) => a.id()));
    for (const id of this.attackStart.keys()) if (!running.has(id)) this.attackStart.delete(id);
    const targets = new Set(me.outgoingAttacks().map((a) => a.target()));
    for (const p of this.waves.keys()) if (!targets.has(p)) this.waves.delete(p); // read only while an attack on that tribe runs
    for (const p of this.counters) if (dead(p)) this.counters.delete(p);
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
    const dist = (t: TileRef) => Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
    const cands: { tile: TileRef; troops: number; score: number; what: string }[] = [];
    // (a) free shore across water: 15 % of home, worth the most per troop
    let seen = 0;
    for (let dy = -300; dy <= 300; dy += 8) for (let dx = -300; dx <= 300; dx += 8) {
      const x = fx + dx, y = fy + dy;
      if (!this.ctx.mg.isValidCoord(x, y)) continue;
      const t = this.ctx.mg.ref(x, y);
      if (!this.ctx.mg.isLand(t) || !this.ctx.mg.isOceanShore(t) || this.ctx.mg.hasOwner(t)) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < 30 || seen++ > 400) continue;
      cands.push({ tile: t, troops: Math.max(5000, Math.floor(this.ctx.sit.troops * 0.15)), score: 300 - d, what: "free shore" });
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
      let i = 0, bestT: TileRef | null = null, bestD = 1e9;
      for (const t of o.borderTiles()) { if ((i++ % 9) !== 0 || !this.ctx.mg.isOceanShore(t)) continue; const d = dist(t); if (d < bestD) { bestD = d; bestT = t; } }
      if (bestT === null || bestD > 500) continue;
      if (late && weak && bestD > 150 && o.troops() >= this.ctx.sit.troops * 0.25) continue; // the late-game jump is a short one
      const value = coll ? 600 : weak ? 400 : 250;
      cands.push({ tile: bestT, troops: want, score: value - bestD / 2 + (o.units(UnitType.City).length * 10), what: `${coll ? "collapsed " : weak ? "weak " : "tribe "}${o.name()} ${o.numTilesOwned()}t/${Math.round(o.troops() / 1000)}k` });
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 10)) {
      if (c.troops > this.ctx.sit.spendable) continue;
      if (!this.q.acrossWater(c.tile)) continue;
      if (this.ctx.boat(c.tile, c.troops, `sea expansion → ${c.what}`) === 0) continue;
      this.lastSeaTick = this.ctx.mg.ticks();
      return;
    }
  }

  // ---------------------------------------------------------------- MIRV and the finish
  private lastMirvTick = -1e9;
  private lastWarTick = -1e9;
  private strictFired = -1e9;
  private bombOutOfRange_ = 0;
  /** Playbook phase 6: a MIRV goes to (1) whoever has one in the air at us, (2) anyone over half the map,
   *  (3) from 25:00, the largest un-allied player above us when we are in the top three — launch first, then
   *  the collapse rule sends the army into the emptied land. */
  maybeMIRV(): void {
    const me = this.ctx.me;
    if (me.units(UnitType.MissileSilo).length === 0 || this.ctx.mg.config().isUnitDisabled(UnitType.MIRV)) return;
    if (this.ctx.mg.ticks() - this.lastMirvTick < 600) return;
    const cost = this.ctx.mg.config().unitInfo(UnitType.MIRV).cost(this.ctx.mg, me);
    if (me.gold() < cost) return;
    const total = this.ctx.mg.numLandTiles();
    const others = this.ctx.mg.players().filter((p) => p !== me && p.isAlive() && p.type() !== PlayerType.Bot && !me.isFriendly(p) && !me.isOnSameTeam(p));
    let target: Player | null = null, why = "";
    if (this.ctx.sit.mode !== "grow" && this.ctx.sit.threats.length > 0) { target = [...this.ctx.sit.threats].sort((a, b) => Number(b.gold() - a.gold()))[0]; why = `finish: ${this.ctx.sit.mode}, richest MIRV-capable rival`; }
    if (!target) for (const p of others) for (const m of p.units(UnitType.MIRV)) { const d = m.targetTile(); if (d && this.ctx.mg.hasOwner(d) && this.ctx.mg.owner(d) === me) { target = p; why = "counter"; } }
    if (!target) { const t = others.filter((p) => p.numTilesOwned() / total >= 0.5).sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0]; if (t) { target = t; why = "victory denial"; } }
    if (!target && this.ctx.mg.ticks() >= 12000) {
      const ranked = this.ctx.mg.players().filter((p) => p.isAlive() && p.type() !== PlayerType.Bot).sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      const myRank = ranked.indexOf(me) + 1;
      if (myRank <= 3) { const t = others.filter((p) => p.numTilesOwned() > me.numTilesOwned() * 0.8).sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0]; if (t) { target = t; why = `crown (we are #${myRank})`; } }
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
    const { rivals, wilderness } = this.q.neighbours();
    if (!wilderness) return;
    // free land is the cheapest growth there is and unused troops come home: only the troop reserve applies, not the cap floor
    const ringing = [...this.ctx.sit.rivals, ...this.ctx.sit.bots, ...this.ctx.sit.friends].some((r) => this.q.annexable(r));
    const frac = rivals.length > 0 || ringing || this.splitTile !== null || this.ctx.sit.mode === "push" ? this.ctx.p.expandContested : this.ctx.p.expandFree;
    this.ctx.send(this.ctx.mg.terraNullius().id(), Math.floor(this.ctx.sit.troops * frac), "expand", 100);
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
    const maxConcurrent = this.ctx.p.tribeConcurrency + (this.ctx.sit.capShare > 0.6 ? 1 : 0);
    let active = this.ctx.sit.tribeAttacks;
    let clicks = 0;
    for (const bot of bots) {
      if (!me.canAttackPlayer(bot) || !this.reachable(bot)) continue;
      const want = Math.ceil(bot.troops() * this.ctx.p.botRatio) + 500;
      const running = this.q.outgoingTo(bot);
      if (running) {
        // follow-up click: the guide's two-click — a second wave 10 s later merges into the first
        const w = this.waves.get(bot);
        if (!w || w.sent >= w.want || this.ctx.mg.ticks() - w.last < this.ctx.p.botFollowUpTicks) continue;
        const send = this.ctx.send(bot.id(), Math.min(w.want - w.sent, Math.floor(this.ctx.sit.troops * this.ctx.p.botClickCap)), "tribe follow-up");
        if (send === 0) continue;
        w.sent += send; w.last = this.ctx.mg.ticks();
        this.noteFollowUp(bot, send);
        continue;
      }
      if (active >= maxConcurrent) continue;
      const maxSend = Math.floor(this.ctx.sit.spendable * (early ? this.ctx.p.botEarlyShare : this.ctx.p.botMaxShare));
      if (want > maxSend) continue;
      const first = this.ctx.send(bot.id(), Math.min(want, Math.floor(this.ctx.sit.troops * this.ctx.p.botClickCap)), "tribe");
      if (first === 0) continue;
      active++;
      this.waves.set(bot, { want, sent: first, last: this.ctx.mg.ticks() });
      this.noteSent(bot);
      this.noteWave(bot, first);
      this.ctx.log(`t${this.ctx.mg.ticks()} bot ${bot.name()} ${bot.numTilesOwned()}t/${Math.round(bot.troops())} ← ${first}/${want}`);
      clicks++;
      if (!plentiful || clicks >= 2) return;
    }
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
      for (const r of this.ctx.sit.rivals) { if (attacking.has(r) || this.q.postFacing(r)) continue; const s = tm.exposedTo(r, 1.5, Math.max(2000, this.ctx.sit.troops * 0.03)); if (s && (pre === null || tm.maxThreat(r) > tm.maxThreat(pre))) pre = r; }
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
    const me = this.ctx.me;
    const cap = this.q.cap();
    const nb = this.q.neighbours();
    for (const r of nb.rivals) this.collapsed(r);
    // `markTargets`: a running war is re-marked as soon as the cooldown allows (canTarget), so the allies keep piling on
    if (this.currentTarget_ && this.currentTarget_.isAlive() && this.q.outgoingTo(this.currentTarget_) && !me.isFriendly(this.currentTarget_)) this.mark(this.currentTarget_, "war");
    const gapOwner = this.splitOwner && this.splitOwner.isAlive() && nb.rivals.includes(this.splitOwner) ? this.splitOwner : null;
    const threatHere = this.ctx.sit.mode === "hold" ? nb.rivals.find((r) => this.ctx.sit.threats.includes(r)) ?? null : null;
    const opportunity = (this.ctx.mg.ticks() >= 3000 && nb.rivals.some((r) => this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5)) || gapOwner !== null || threatHere !== null;
    // crown, not survival: a war is on when we can afford 2× someone's whole army out of the spendable troops,
    // not only when troops reach 70 % of a cap that cities keep raising
    // `drainedNations`: a drained nation is affordable at 1.5× — it cannot answer until it regrows past its reserve ratio
    const affordableAt = (r: Player) => r.troops() * (this.drained(r) ? Math.min(this.ctx.p.fightRatio, 1.5) : this.ctx.p.fightRatio) + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare;
    const affordable = this.ctx.mg.ticks() >= this.ctx.p.fightNotBeforeTick && nb.rivals.some(affordableAt);
    if (affordable && !nb.rivals.some((r) => r.troops() * this.ctx.p.fightRatio + 1000 <= this.ctx.sit.spendable * this.ctx.p.fightMaxShare)) this.lim.fire("drainedNations", "affordable");
    if (!affordable && !opportunity && me.troops() < cap * this.ctx.p.fightAbove) return; // a 1.67× push that keeps home healthy is always taken
    const atCapNow = me.troops() >= cap * 0.95;
    // invariant: one war at a time (two at cap); seven at once is how a 17M army evaporates
    const nonBot = this.ctx.sit.outgoing.filter((a) => a.target().isPlayer() && (a.target() as Player).type() !== PlayerType.Bot);
    const wars = nonBot.filter((a) => !this.counters.has(a.target() as Player)).length;
    const limit = this.ctx.mg.ticks() >= 15000 && atCapNow ? 2 : 1;
    if (wars >= limit && !opportunity) return;
    // `strictOneWar`: counters occupy the second slot — one war plus counters, but no second war (opportunity wars
    // included) while a counter runs. A counter on the current target is that war (the old count skipped it, so
    // wars read 0 and another war could open beside it).
    if (this.ctx.p.strictOneWar) {
      const countersRunning = nonBot.some((a) => this.counters.has(a.target() as Player));
      const warsStrict = wars + nonBot.filter((a) => this.counters.has(a.target() as Player) && a.target() === this.currentTarget_).length;
      if (countersRunning && warsStrict >= 1) { if (this.ctx.mg.ticks() - this.strictFired >= 100) { this.strictFired = this.ctx.mg.ticks(); this.ctx.fire("strictOneWar"); } return; }
    }
    const early = !atCapNow && !opportunity && (this.ctx.mg.ticks() < this.ctx.p.fightNotBeforeTick || me.unitsOwned(UnitType.City) < this.ctx.p.fightMinCities);
    let { rivals } = nb;
    // before the 5-minute mark only clear prey: a neighbour we can hit with 2.5× its whole army
    if (early) rivals = rivals.filter((r) => r.troops() * 2.5 <= me.troops() * this.ctx.p.fightMaxShare && r.numTilesOwned() <= me.numTilesOwned());
    if (rivals.length === 0) return;
    if (this.currentTarget_ && (!this.currentTarget_.isAlive() || !rivals.includes(this.currentTarget_))) this.currentTarget_ = null;
    let candidates = rivals.filter((r) => me.canAttackPlayer(r) && !this.q.outgoingTo(r) && this.reachable(r));
    // one enemy at a time, to the end: nations nuke whoever attacks them, and eight half-wars make eight nuclear enemies.
    // The current target stays the only candidate while it lives, borders us, and was hit within the last three minutes.
    if (this.currentTarget_ && this.currentTarget_.isAlive() && rivals.includes(this.currentTarget_) && this.ctx.mg.ticks() - this.lastWarTick < 1800) {
      candidates = candidates.filter((r) => r === this.currentTarget_ || this.collapsed(r) || this.drained(r) || r === gapOwner || r === threatHere);
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
    if (candidates.length === 0) return;
    const atCap = me.troops() >= cap * 0.95;
    const endgame = this.ctx.mg.ticks() >= 15000 || this.ctx.sit.mode === "push"; // 25:00 or the push — land now is worth more than troops later
    // review #5 (`threatMap`): prefer a rival whose army is committed on its other borders (+3 × busyElsewhere) and
    // avoid opening a war on a border where we are already contested (−2 × Σ vulnerability / troops)
    const threatBonus = (r: Player) => { if (!this.ctx.p.threatMap) return 0; const tm = this.q.rivals.threat; const b = 3 * tm.busyElsewhere(r) - (2 * tm.vulnerability(r)) / Math.max(1, this.ctx.sit.troops); if (b !== 0 && this.ctx.mg.ticks() - this.threatFired >= 100) { this.threatFired = this.ctx.mg.ticks(); this.ctx.fire("threatMap"); } return b; };
    const trustBonus = (r: Player) => { const b = this.ctx.p.trustWars ? 2 * (1 - (this.ctx.sit.rival.get(r)?.trust ?? 0.5)) : 0; if (b !== 0 && b !== 1) this.ctx.fire("trustWars"); return b; }; // C1: a rival that broke faith is the better target
    // At cap every troop above the line is wasted growth, so commit more and accept a thinner edge.
    const maxSend = Math.floor(me.troops() * (atCap || endgame ? 0.7 : this.ctx.p.fightMaxShare));
    const minRatio = atCap || endgame ? 1.2 : this.ctx.p.fightRatio;
    const richer = (r: Player) => this.q.cap() >= this.ctx.mg.config().maxTroops(r) * 2 && this.ctx.sit.gold >= 1_000_000n; // we replace losses, they cannot
    const attackingUs = new Set(me.incomingAttacks().map((a) => a.attacker()));
    // `retaliateAware`: the smaller attacker is invisible to `retaliate`; a 1.2× wave that stays under the bigger one
    const shadow = (r: Player) => { const w = this.shadowWave(r); return w >= Math.ceil(r.troops() * 1.2) + 1000; };
    // `relationAware`: a nation still Friendly to us (a lapsed ally, a gift) drops to Distrustful on the first hit, not
    // Hostile — no `hated` hunt at 3× our troops, no embargo; Neutral is a coin toss (its raw value is not visible)
    const relationBonus = (r: Player) => { if (!this.ctx.p.relationAware) return 0; const rel = this.ctx.sit.rival.get(r)?.relation ?? null; const b = rel === Relation.Friendly ? 2 : rel === Relation.Neutral ? 0.5 : 0; if (b !== 0) this.lim.fire("relationAware", "score"); return b; };
    const score = (r: Player) => {
      const ratio = maxSend / Math.max(1, r.troops());
      if (this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5) return ratio >= 1.5 ? 20 + ratio : -1; // bombed: go now at 1.5×, posts are gone
      if (r === gapOwner) return ratio >= 1.2 ? 30 + ratio : -1; // they are cutting our land in two: reconnect before the piece is handed over
      if (r === threatHere) return ratio >= 1.5 ? 25 + ratio : -1; // a MIRV-capable rival next door during the hold
      if (this.drained(r)) { this.lim.fire("drainedNations", "score"); return ratio >= 1.5 ? 18 + ratio : -1; } // under its reserve ratio: it cannot answer until it regrows
      const shadowed = shadow(r);
      if (shadowed && ratio >= 1.2 && ratio < minRatio) this.lim.fire("retaliateAware", "gate");
      // at cap, a neighbour already attacking us is a fair fight at 1:1 — the counter-attack cancels its wave anyway
      if (ratio < (atCap && attackingUs.has(r) ? 1.0 : shadowed ? Math.min(minRatio, 1.2) : richer(r) ? Math.min(minRatio, 1.5) : minRatio)) return -1;
      // Playbook: never attack a big, thinly held empire — that is a troop sink. Prefer small and dense.
      if (ratio < 3 && r.numTilesOwned() > me.numTilesOwned() * 1.5 && this.q.density(r) < 40) return -1;
      const buildings = r.units(UnitType.City).length * 3 + r.units(UnitType.Port).length * 2 + r.units(UnitType.MissileSilo).length * 3;
      const posts = r.units(UnitType.DefensePost).length;
      if (posts > 0 && ratio < 1.5) return -1;
      const sizePenalty = r.numTilesOwned() / Math.max(1, me.numTilesOwned());
      // Playbook: hit players who are already being hit, traitors (half defence), and the ally we let lapse.
      const underFire = r.incomingAttacks().reduce((acc, a) => acc + a.troops(), 0) / Math.max(1, r.troops());
      const bonus = Math.min(underFire, 1) * 4 + (r.isTraitor() ? 2 : 0) + (r === this.plannedTarget() ? 4 : 0);
      if (shadowed) this.lim.fire("retaliateAware", "score");
      return ratio * 2 + buildings + Math.min(this.q.density(r), 200) / 50 - posts * 3 - sizePenalty * 2 + bonus + (r === this.currentTarget_ ? 3 : 0) + trustBonus(r) + threatBonus(r) + (shadowed ? 2 : 0) + relationBonus(r);
    };
    let best: Player | null = null, bestS = 0;
    if (this.ctx.p.simWars) {
      // #4 (B1 restored on calibrated numbers): the estimator picks the target and the size. For each candidate the
      // smallest wave (1k steps) that wins with a margin is found by bisection; the candidate with the most tiles per
      // troop lost wins, keeping the opportunity bonuses (collapsed / gap owner / planned target) of the heuristic scorer.
      let bestSim: { r: Player; sim: SimPick } | null = null;
      for (const r of candidates) {
        const sim = this.simPick(r, maxSend, gapOwner, threatHere);
        if (sim === null) continue;
        const value = sim.tilesPerLoss * 100 + (this.collapsed(r) ? 20 : 0) + (r === gapOwner ? 30 : 0) + (r === threatHere ? 25 : 0) + (r === this.plannedTarget() ? 4 : 0) + (r === this.currentTarget_ ? 3 : 0) + (r.isTraitor() ? 2 : 0) + trustBonus(r);
        if (bestSim === null || value > bestSim.sim.value) { sim.value = value; bestSim = { r, sim }; }
      }
      // liveness: the flag changed a decision when it picks another target or size than the scorer would, or nothing
      for (const r of candidates) { const sc = score(r); if (sc > bestS) { bestS = sc; best = r; } }
      const heurWant = best === null ? 0 : Math.min(Math.ceil(best.troops() * (richer(best) ? Math.min(this.ctx.p.fightRatio, 1.5) : this.ctx.p.fightRatio)) + 1000, maxSend);
      if (bestSim === null) {
        if (best !== null && heurWant >= 1000 && this.ctx.mg.ticks() - this.simFired >= 100) { this.simFired = this.ctx.mg.ticks(); this.ctx.fire("simWars"); }
        if (atCapNow && this.ctx.mg.ticks() % 1200 < this.ctx.p.expandEvery) this.ctx.log(`t${this.ctx.mg.ticks()} idle at cap (sim): ${rivals.map((r) => `${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k p${r.units(UnitType.DefensePost).length} ${candidates.includes(r) ? "" : "(no)"}`).join("; ")}`);
        return;
      }
      const { r, sim } = bestSim;
      if (r !== best || Math.abs(sim.troops - heurWant) > 1000) this.ctx.fire("simWars");
      this.currentTarget_ = r;
      if (!me.hasEmbargoAgainst(r) && r.type() !== PlayerType.Nation) { me.addEmbargo(r, false); this.embargoedAt_.set(r, this.ctx.mg.ticks()); }
      const want = this.ctx.send(r.id(), sim.troops, "war", 1000, 0.3);
      if (want === 0) return;
      this.lastWarTick = this.ctx.mg.ticks();
      this.noteSent(r);
      this.simCache.clear();
      this.ctx.log(`t${this.ctx.mg.ticks()} ATTACK ${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k ← ${Math.round(want / 1000)}k (${(want / Math.max(1, r.troops())).toFixed(2)}×) sim: ${sim.est.tilesTaken}t for ${Math.round(sim.est.attackerLoss / 1000)}k in ${sim.est.ticks} ticks${sim.est.wins ? "" : ", still going at the horizon"}`);
      this.noteWave(r, want, sim.est);
      return;
    }
    for (const r of candidates) { const sc = score(r); if (sc > bestS) { bestS = sc; best = r; } }
    if (best === null) {
      if (atCapNow && this.ctx.mg.ticks() % 1200 < this.ctx.p.expandEvery) this.ctx.log(`t${this.ctx.mg.ticks()} idle at cap: ${rivals.map((r) => `${r.name()} ${r.numTilesOwned()}t/${Math.round(r.troops() / 1000)}k d${Math.round(this.q.density(r))} p${r.units(UnitType.DefensePost).length} ${candidates.includes(r) ? "" : "(no)"}`).join("; ")}`);
      return;
    }
    // the wave: 1.5× on a drained or a richer target, 1.2× as the smaller attacker (kept under the bigger wave by
    // shadowWave's test above), else fightRatio
    const mult = this.drained(best) ? Math.min(this.ctx.p.fightRatio, 1.5) : shadow(best) ? Math.min(this.ctx.p.fightRatio, 1.2) : richer(best) ? Math.min(this.ctx.p.fightRatio, 1.5) : this.ctx.p.fightRatio;
    const wantRaw = Math.min(Math.ceil(best.troops() * mult) + 1000, maxSend);
    if (richer(best) && best !== this.currentTarget_ && me.units(UnitType.MissileSilo).length > 0 && this.ctx.mg.ticks() - this.lastBombTick > 100) { this.currentTarget_ = best; this.maybeBomb(this.ctx.mg.ticks()); } // open the war with a bomb on their cluster
    if (wantRaw < 1000) return;
    this.currentTarget_ = best;
    if (!me.hasEmbargoAgainst(best) && best.type() !== PlayerType.Nation) { me.addEmbargo(best, false); this.embargoedAt_.set(best, this.ctx.mg.ticks()); }
    const want = this.ctx.send(best.id(), wantRaw, "war", 1000, 0.3);
    if (want === 0) return;
    this.lastWarTick = this.ctx.mg.ticks();
    this.noteSent(best);
    this.ctx.log(`t${this.ctx.mg.ticks()} ATTACK ${best.name()} ${best.numTilesOwned()}t/${Math.round(best.troops() / 1000)}k ← ${Math.round(want / 1000)}k (${(want / Math.max(1, best.troops())).toFixed(2)}×)${this.drained(best) ? " drained" : shadow(best) ? " as the smaller attacker" : ""}`);
    this.noteWave(best, want);
    this.mark(best, "war");
  }

  // ---------------------------------------------------------------- the estimator: calibration, simulated wars (simWars)
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
   *  logs the estimate for it (`est` when the caller already has one); trackCalibration() logs the outcome. */
  private noteWave(t: Player, troops: number, est?: AttackEstimate): void {
    if (this.calib.has(t)) { this.noteFollowUp(t, troops); return; } // a second war wave merges into the running attack (AttackExecution.init)
    const now = this.ctx.mg.ticks();
    const e = est ?? estimateAttack(this.ctx.mg, this.ctx.me, t, troops, { horizonTicks: SIM_HORIZON, ...this.estOpts(t) });
    const wave = ++this.calibSeq;
    const others = t.incomingAttacks().filter((a) => a.attacker() !== this.ctx.me).length;
    this.calib.set(t, { wave, tick: now, sent: troops, tiles0: t.numTilesOwned(), ours0: this.ctx.me.numTilesOwned(), others, last: troops, seen: false, retreating: false });
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
      if (a !== undefined) { c.seen = true; c.last = a.troops(); if (a.retreating()) c.retreating = true; continue; }
      if (!c.seen && now - c.tick <= 12) continue;
      const tiles = Math.max(0, c.tiles0 - t.numTilesOwned());
      // never observed: over before the first 10-tick pass (a small tribe, logged as end=fast with the loss unknown)
      // or never materialised (no front, cancelled by an incoming wave, unreachable) — no outcome to log
      if (!c.seen && tiles === 0 && t.isAlive()) { this.calib.delete(t); continue; }
      const end = !c.seen ? "fast" : !t.isAlive() ? "dead" : c.retreating ? "retreat" : "done";
      const left = c.seen ? c.last : c.sent;
      this.ctx.log(`t${now} ACT ${t.name()} wave=${c.wave} tiles=${tiles} ours=${this.ctx.me.numTilesOwned() - c.ours0} loss=${Math.max(0, Math.round(c.sent - left))} ticks=${now - c.tick} sent=${c.sent} left=${Math.round(left)} class=${Military.klass(t)} end=${end}`);
      this.calib.delete(t);
    }
  }

  private simCache = new Map<Player, { tick: number; pick: SimPick | null }>();
  private simFired = -1e9;
  /** Free land costs mag/5 = 16–24 troops a tile; a war is only worth it while free land remains if it is not much
   *  dearer. Once the wilderness is gone the bar is a troop-sink guard only. */
  private simMaxLossPerTile(): number { return this.ctx.sit.wilderness ? 20 : 60; }
  /** Smallest wave (1k steps, at most maxSend) whose estimate wins — or is still winning at the horizon — with a
   *  fifth of itself to spare, and takes tiles cheaply enough. A wave already running on the target is part of the
   *  estimate (the engine merges the two, AttackExecution.init), so the pick is the addition to it. Cached 50 ticks. */
  private simPick(r: Player, maxSend: number, gapOwner: Player | null, threatHere: Player | null): SimPick | null {
    const now = this.ctx.mg.ticks();
    const c = this.simCache.get(r);
    if (c && now - c.tick < 50) return c.pick;
    const opportunity = r === gapOwner || r === threatHere || (this.collapsed(r) && r.troops() < this.ctx.sit.troops * 0.5);
    const running = this.q.outgoingTo(r)?.troops() ?? 0;
    const opts = this.estOpts(r);
    const ok = (est: AttackEstimate, n: number) => est.tilesTaken > 0 && (est.wins || est.ticks >= SIM_HORIZON) && est.troopsLeft >= n * SIM_MARGIN;
    let pick: SimPick | null = null;
    const hiK = Math.floor(maxSend / 1000);
    if (hiK >= 1) {
      const run = (k: number) => estimateAttack(this.ctx.mg, this.ctx.me, r, k * 1000 + running, { horizonTicks: SIM_HORIZON, stopBelow: (k * 1000 + running) * SIM_MARGIN, ...opts });
      let bestEst = run(hiK);
      if (ok(bestEst, hiK * 1000 + running)) {
        let lo = 1, high = hiK; // invariant: high is ok
        while (lo < high) {
          const mid = Math.floor((lo + high) / 2);
          const e = run(mid);
          if (ok(e, mid * 1000 + running)) { high = mid; bestEst = e; } else lo = mid + 1;
        }
        const perTile = bestEst.attackerLoss / Math.max(1, bestEst.tilesTaken);
        if (perTile <= (opportunity ? SIM_OPPORTUNITY_LOSS_PER_TILE : this.simMaxLossPerTile())) pick = { troops: high * 1000, est: bestEst, tilesPerLoss: bestEst.tilesTaken / Math.max(1, bestEst.attackerLoss), value: 0 };
      }
    }
    this.simCache.set(r, { tick: now, pick });
    return pick;
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
    const margin = 0.1 + 0.2 * Math.max(0, Math.min(2, maxBsr - 1));
    const cont = est.troopsLeft * RETREAT_MALUS + est.tilesTaken * HYST_TILE_WORTH; // continue wins while a tile costs under HYST_TILE_WORTH / RETREAT_MALUS = 80 troops
    const ret = a.troops() * RETREAT_MALUS;
    const lost = !est.wins && a.troops() < t.troops() * this.ctx.p.retreatBelowRatio;
    return { keep: !lost && cont >= ret * (1 + margin), lost, est, margin, cont, ret };
  }
  manageRetreats(): void {
    const me = this.ctx.me;
    this.trackCalibration();
    for (const id of this.hyst.keys()) if (!me.outgoingAttacks().some((a) => a.id() === id)) this.hyst.delete(id);
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
      // Retreat only when we are losing: most of the wave is gone while the target has barely bled.
      const losing = a.troops() < st.sent * 0.2 && t.troops() > st.targetTroops * 0.7;
      const posts = t.units(UnitType.DefensePost).length > 0 && a.troops() < st.sent * 0.5 && t.troops() > st.targetTroops * 0.9;
      if (this.ctx.p.hystRetreats) {
        // #4: every HYST_EVERY ticks judge continue vs retreat; HYST_STRIKES losing verdicts in a row (or a wave lost
        // outright) bring it home. The literal thresholds are the oscillation the field spent years removing.
        let h = this.hyst.get(a.id());
        if (!h) { h = { lastCheck: this.ctx.mg.ticks(), strikes: 0 }; this.hyst.set(a.id(), h); }
        if (this.ctx.mg.ticks() - h.lastCheck < HYST_EVERY) { if ((losing || posts) && this.ctx.mg.ticks() % HYST_EVERY === 0) this.ctx.fire("hystRetreats"); continue; } // the literals would have recalled it now
        h.lastCheck = this.ctx.mg.ticks();
        const v = this.hystJudge(a, t);
        h.strikes = v.keep ? 0 : h.strikes + 1;
        const go = v.lost || h.strikes >= HYST_STRIKES;
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
    const dist = (t: TileRef) => Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
    const cands: { tile: TileRef; troops: number; d: number; what: string }[] = [];
    for (const bot of this.ctx.mg.players()) {
      if (bot.type() !== PlayerType.Bot || !bot.isAlive()) continue;
      const want = Math.ceil(bot.troops() * 2) + 500; // a beach landing costs more than a land attack: 2×, not 1.67×
      if (want > me.troops() * 0.4) continue;
      let i = 0, bestT: TileRef | null = null, bestD = 1e9;
      for (const t of bot.borderTiles()) { if ((i++ % 5) !== 0 || !this.ctx.mg.isShore(t)) continue; const d = dist(t); if (d < bestD) { bestD = d; bestT = t; } }
      if (bestT !== null && bestD <= 250) cands.push({ tile: bestT, troops: Math.max(want, Math.floor(me.troops() * this.ctx.p.boatShare)), d: bestD + 80, what: `tribe ${bot.name()}` }); // open shore preferred: free land, no losses; a tribe only when no empty coast is near
    }
    for (let dy = -200; dy <= 200; dy += 6) for (let dx = -200; dx <= 200; dx += 6) {
      const x = fx + dx, y = fy + dy;
      if (!this.ctx.mg.isValidCoord(x, y)) continue;
      const t = this.ctx.mg.ref(x, y);
      if (!this.ctx.mg.isLand(t) || !this.ctx.mg.isShore(t) || this.ctx.mg.hasOwner(t)) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d >= 30) cands.push({ tile: t, troops: Math.floor(me.troops() * this.ctx.p.boatShare), d, what: "empty shore" });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 16)) {
      if (c.troops < 500 || !this.q.acrossWater(c.tile)) continue;
      if (this.ctx.boat(c.tile, c.troops, `early boat → ${c.what}, ${c.d} tiles`) === 0) continue;
      return true;
    }
    return false;
  }

  sendBoat(): boolean {
    const me = this.ctx.me;
    if (me.unitCount(UnitType.TransportShip) >= this.ctx.mg.config().boatMaxNumber()) return false;
    const border = Array.from(me.borderTiles()).filter((t) => this.ctx.mg.isShore(t));
    if (border.length === 0) return false;
    const from = border[this.ctx.random.nextInt(0, border.length)];
    const fx = this.ctx.mg.x(from), fy = this.ctx.mg.y(from);
    const mine = this.q.landmassTiles(this.ctx.p.islandMaxTiles + 1);
    let best: TileRef | null = null, bestD = 1e9;
    for (let dy = -200; dy <= 200; dy += 6) for (let dx = -200; dx <= 200; dx += 6) {
      const x = fx + dx, y = fy + dy;
      if (!this.ctx.mg.isValidCoord(x, y)) continue;
      const t = this.ctx.mg.ref(x, y);
      if (!this.ctx.mg.isLand(t) || !this.ctx.mg.isShore(t) || this.ctx.mg.hasOwner(t) || mine.has(t)) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d >= 30 && d < bestD) { bestD = d; best = t; }
    }
    if (best === null) return false;
    return this.ctx.boat(best, Math.floor(this.ctx.sit.troops * this.ctx.p.boatShare), `island boat, ${bestD} tiles`) > 0;
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
    let best: TileRef | null = null, bestBot: Player | null = null, bestD = 1e9;
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
        const d = Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
        if (d < bestD && d <= 350) { bestD = d; best = t; bestBot = bot; }
      }
    }
    if (best === null || bestBot === null) return;
    if (!this.q.acrossWater(best)) return; // reachable by land: that is a land attack, not a boat
    const troops = Math.ceil(bestBot.troops() * 2) + 500;
    if (troops > this.ctx.sit.spendable) return;
    if (this.ctx.boat(best, troops, `to tribe ${bestBot.name()} ${bestBot.numTilesOwned()}t/${Math.round(bestBot.troops() / 1000)}k, ${bestD} tiles`) === 0) return;
    this.boatedAt.set(bestBot, this.ctx.mg.ticks());
  }

  /** Boxed in at cap with nothing to fight on land: land a big boat on the weakest unfriendly player within reach. */
  seaInvasion(): void {
    const me = this.ctx.me;
    if (me.troops() < this.q.cap() * 0.9) return;
    if (this.ctx.mg.ticks() - this.lastInvasionTick < 1800) return;
    if (me.units(UnitType.TransportShip).length > 0) return; // one landing at a time
    if (me.outgoingAttacks().length > 0 || me.incomingAttacks().some((a) => a.attacker().type() !== PlayerType.Bot)) return;
    const nb = this.q.neighbours();
    // only when genuinely boxed in: no empty land, no bots, and no neighbour we could fight on land
    if (nb.wilderness || nb.bots.length > 0) return;
    if (nb.rivals.some((r) => r.troops() < me.troops() * 0.5)) return;
    if (nb.rivals.some((r) => r.troops() > me.troops() * 0.6)) return; // a strong hostile neighbour: the army stays home
    const shore = Array.from(me.borderTiles()).filter((t) => this.ctx.mg.isShore(t));
    if (shore.length === 0) return;
    const from = shore[Math.floor(shore.length / 2)];
    const fx = this.ctx.mg.x(from), fy = this.ctx.mg.y(from);
    const { rivals } = this.q.neighbours();
    let best: { tile: TileRef; p: Player; d: number; score: number } | null = null;
    for (const o of this.ctx.mg.players()) {
      if (o === me || !o.isAlive() || me.isFriendly(o) || o.type() === PlayerType.Bot || rivals.includes(o)) continue;
      if (o.troops() > me.troops() * 0.25 || o.numTilesOwned() < 300 || o.units(UnitType.DefensePost).length > 0) continue;
      let i = 0;
      for (const t of o.borderTiles()) {
        if ((i++ % 9) !== 0 || !this.ctx.mg.isShore(t)) continue;
        const d = Math.abs(this.ctx.mg.x(t) - fx) + Math.abs(this.ctx.mg.y(t) - fy);
        if (d > 500) continue;
        const score = this.q.density(o) / 10 + o.units(UnitType.City).length * 2 - d / 100 - o.units(UnitType.DefensePost).length * 2;
        if (best === null || score > best.score) best = { tile: t, p: o, d, score };
      }
    }
    if (best === null) return;
    const troops = Math.min(Math.floor(this.ctx.sit.spendable * 0.5), Math.floor(this.ctx.sit.troops - this.ctx.sit.cap * 0.3), Math.ceil(best.p.troops() * 3) + 5000);
    if (troops < 20000 || troops < best.p.troops() * 3) return; // a landing under 3× is the boat that takes no land
    if (this.ctx.boat(best.tile, troops, `INVADE ${best.p.name()} ${best.p.numTilesOwned()}t/${Math.round(best.p.troops() / 1000)}k, ${best.d} tiles`) === 0) return;
    this.lastInvasionTick = this.ctx.mg.ticks();
  }

  // ---------------------------------------------------------------- nukes
  maybeBomb(ticks: number): void {
    const me = this.ctx.me;
    if (me.units(UnitType.MissileSilo).length === 0) return;
    if (ticks - this.lastBombTick < this.ctx.p.bombEvery) return;
    const atomCost = this.ctx.mg.config().unitInfo(UnitType.AtomBomb).cost(this.ctx.mg, me);
    const hCost = this.ctx.mg.config().unitInfo(UnitType.HydrogenBomb).cost(this.ctx.mg, me);
    const gold = me.gold();
    // targets: whoever we fight or who fights us; else the neighbour with the most buildings that is not allied
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
      if (pick) { enemies.add(pick); if (!this.currentTarget_ || !this.currentTarget_.isAlive()) this.currentTarget_ = pick; }
    }
    if (enemies.size === 0 && me.troops() > this.q.cap() * 0.9 && me.outgoingAttacks().length === 0) {
      // idle at cap: open a war — bomb the neighbour with the most buildings we could then take at 1.2×
      const { rivals } = this.q.neighbours();
      const pick = rivals.filter((r) => me.canAttackPlayer(r) && r.troops() * 1.2 < me.troops() * this.ctx.p.fightMaxShare).sort((a, b) => b.units(UnitType.City).length - a.units(UnitType.City).length)[0];
      if (pick) { enemies.add(pick); this.currentTarget_ = pick; }
    }
    if (enemies.size === 0) return;
    let best: { tile: TileRef; value: number; type: UnitType } | null = null;
    for (const enemy of enemies) {
      const structures = enemy.units([UnitType.City, UnitType.Port, UnitType.Factory, UnitType.MissileSilo, UnitType.SAMLauncher, UnitType.DefensePost]);
      const sams = enemy.units(UnitType.SAMLauncher);
      for (const u of structures) {
        const tile = u.tile();
        if ((this.bombed.get(tile) ?? 0) >= 1) continue;
        // never inside a SAM umbrella (the SAM always hits), never near our own or allied land
        if (sams.some((s) => this.ctx.mg.euclideanDistSquared(s.tile(), tile) <= (this.ctx.mg.config().samRange(s.level()) + 5) ** 2)) continue;
        if (!this.clearOfFriends(tile, 32)) continue;
        for (const type of [UnitType.HydrogenBomb, UnitType.AtomBomb]) {
          const cost = type === UnitType.HydrogenBomb ? hCost : atomCost;
          if (gold < cost + BigInt(rich ? 2_000_000 : this.ctx.p.bombReserve)) continue;
          if (type === UnitType.HydrogenBomb && (!this.clearOfFriends(tile, 105) || enemy.numTilesOwned() < (rich ? 3000 : 8000))) continue;
          const r = this.ctx.mg.config().nukeMagnitudes(type).outer;
          let value = 0;
          for (const o of structures) if (this.ctx.mg.euclideanDistSquared(o.tile(), tile) <= r * r) value += (o.type() === UnitType.City ? 3 : o.type() === UnitType.MissileSilo || o.type() === UnitType.SAMLauncher ? 4 : 2) * o.level();
          const perGold = value / Number(cost / 100_000n);
          if (value >= 4 && (best === null || perGold > best.value)) best = { tile, value: perGold, type };
        }
      }
    }
    if (best === null) return;
    if (me.canBuild(best.type, best.tile) === false) { this.bombOutOfRange_++; return; }
    this.bombOutOfRange_ = 0;
    this.ctx.mg.addExecution(new ConstructionExecution(me, best.type, best.tile));
    this.lastBombTick = ticks;
    this.bombed.set(best.tile, (this.bombed.get(best.tile) ?? 0) + 1);
    this.bombs++;
    this.ctx.log(`t${ticks} BOMB ${best.type} at ${this.ctx.mg.x(best.tile)},${this.ctx.mg.y(best.tile)}`);
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
