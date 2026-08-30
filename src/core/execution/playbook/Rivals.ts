// Rivals: what we know about each non-bot neighbour — trend (troops/tiles per 100 ticks from a ring buffer),
// trust (0–1, moved by alliance events and attacks), the shared border and the Risk-style border-security ratio,
// and what the nation AI's own attack rules would let it send at us right now.
//
// Exposure only: nothing here changes behaviour until a consumer (C1) reads `sit.rival`.

import { Difficulty, GameMode, Player, PlayerType, Relation, TerraNullius } from "../../game/Game";
import { BotContext, FireLimiter } from "./Context";
import type { Situation } from "./Situation";
import { Bucket, CELL, ThreatMap } from "./ThreatMap";

export interface RivalView {
  /** Troop change per 100 ticks over the ring buffer (up to 8 samples, one every 50 ticks). */
  troopsDelta: number;
  /** Tile change per 100 ticks, same window. */
  tilesDelta: number;
  /** 0–1, starts at 0.5. − broken alliance / attacked us or an ally / refused request; + natural expiry or renewal. */
  trust: number;
  /** Our border tiles that touch a tile they own. */
  borderTiles: number;
  /** their troops × (their border facing us / their total border) / our troops — see `bsr()` for the approximation. */
  bsr: number;
  /** AiAttackBehavior would let this nation attack us now (ignores its dice rolls; false for humans and bots). */
  nationCanAttack: boolean;
  /** Troops a land attack on us would carry under its reserve ratio and troopSendCap (0 for humans and bots). */
  nationWouldSend: number;
  /** `wildernessAware`: a nation with unowned, fallout-free land next to its border spends its surplus there first
   *  (AiAttackBehavior.maybeAttack) — it cannot attack a player this tick. Always false with the flag off. */
  wildernessBound: boolean;
  /** `drainedNations`: tick until which a nation under its reserve ratio is expected to stay below its trigger ratio
   *  (−1 = not drained). Its attack rules stop it from attacking anyone before the reserve ratio. */
  drainedUntil: number;
  /** `retaliateAware`: the attacker a nation's `retaliate` would answer — its largest incoming non-bot, unfriendly wave
   *  (AiAttackBehavior.findIncomingAttackPlayer) — and that wave's troops. Null / 0 when nobody attacks it. */
  largestAttacker: Player | null;
  largestAttack: number;
  /** `relationAware`: the nation's relation to us (PlayerImpl.relation: Hostile < −50 ≤ Distrustful < 0 ≤ Neutral < 50 ≤
   *  Friendly); null for humans and bots, whose relation nobody reads. */
  relation: Relation | null;
}

/** Nation attack-rule constants, copied verbatim from the AI code so a change there fails our tests, not our wars. */
export const NATION_RULES = {
  // src/core/execution/NationExecution.ts:57-59 — drawn once per nation from its seeded PRNG
  triggerRatio: [0.5, 0.6] as const, // nextInt(50, 60) / 100
  reserveRatio: [0.3, 0.4] as const, // nextInt(30, 40) / 100
  expandRatio: [0.1, 0.2] as const, // nextInt(10, 20) / 100
  // src/core/execution/utils/AiAttackBehavior.ts:878-891 isAttackTooWeak: Hard/Impossible FFA, troops < target × 0.2
  tooWeakShare: 0.2,
  // src/core/execution/utils/AiAttackBehavior.ts:903-949 troopSendCap: keep ≥ retain × strongest unfriendly non-bot neighbour
  retain: { [Difficulty.Hard]: 0.75, [Difficulty.Impossible]: 0.9 } as Partial<Record<Difficulty, number>>,
  // src/core/execution/utils/AiAttackBehavior.ts:849-871 shouldAttack: Easy passes 1 in 5, Medium 3 in 4 (dice, not modelled)
  // src/core/execution/utils/AiAttackBehavior.ts:244-247 attackBestTarget: needs troops/max ≥ reserveRatio; below triggerRatio only 1 in 10
  // src/core/execution/utils/AiAttackBehavior.ts:1002-1006 sendLandAttack: troops = own troops − maxTroops × reserveRatio
  // src/core/execution/utils/AiAttackBehavior.ts:60-95 maybeAttack: unowned, fallout-free land next to the border (or a
  // TerraNullius in nearby()) → sendAttack(terraNullius) and return; only when that send fails do players get a look.
  // The TN wave keeps maxTroops × expandRatio (lines 960-964), so it always goes through above the reserve ratio.
  // src/core/execution/utils/AiAttackBehavior.ts:393-403 hasReserveRatioTroops / hasTriggerRatioTroops: troops / maxTroops
  // src/core/execution/utils/AiAttackBehavior.ts:405-426 findIncomingAttackPlayer: `retaliate` (and the nuke target,
  // NationNukeBehavior.ts:180-183) answers only the largest incoming non-bot, non-friendly wave
  // src/core/execution/utils/AiAttackBehavior.ts:487-514 assistAllies: every ally with relation ≥ Friendly attacks the
  // players in our targets() (cost: it docks us −20 relation per assist); NationNukeBehavior.ts:220-231 nukes them too
  // src/core/execution/TargetPlayerExecution.ts:23-27 target(): needs canTarget (not friendly, targetCooldown since our
  // last mark) and docks the target's relation to us by 40; src/core/configuration/Config.ts:631-636
  targetDuration: 100, // ticks a mark stays in targets()
  targetCooldown: 150, // ticks between two marks by the same player
  // src/core/execution/nation/NationAllianceBehavior.ts:88-148 getAllianceDecision, dice aside: traitor → no;
  // too many alliances (150-169: Hard ≥ 50 % / Impossible ≥ 25 % of the non-bot players) → no; threat (220-252) → yes;
  // relation < Neutral → no; Friendly (308-327) → yes; enough alliances (274-306: Medium ≥ nextInt(4, 6), Hard/Impossible
  // "not all my neighbours", else ≥ nextInt(3, 5) / nextInt(2, 4)) → no; early game (187-218) → yes; similarly strong
  // (330-369: their troops+outgoing > ours × nextInt(70, 80) %, or tiles > ours × nextInt(80, 90) % with half our troops).
  threatTroops: { [Difficulty.Medium]: 2.5, [Difficulty.Impossible]: 1.5 } as Partial<Record<Difficulty, number>>,
  earlyGameTicks: { [Difficulty.Easy]: 3000, [Difficulty.Medium]: 1800, [Difficulty.Hard]: 1800, [Difficulty.Impossible]: 600 } as Record<Difficulty, number>,
  enoughAlliances: { [Difficulty.Easy]: Infinity, [Difficulty.Medium]: 4, [Difficulty.Hard]: 3, [Difficulty.Impossible]: 2 } as Record<Difficulty, number>, // lower bound of the dice
  tooManyAlliancesShare: { [Difficulty.Hard]: 0.5, [Difficulty.Impossible]: 0.25 } as Partial<Record<Difficulty, number>>,
  similarTroops: { [Difficulty.Easy]: 0.6, [Difficulty.Medium]: 0.7, [Difficulty.Hard]: 0.75, [Difficulty.Impossible]: 0.8 } as Record<Difficulty, number>, // lower bound of the dice
  similarTiles: { [Difficulty.Easy]: 0.7, [Difficulty.Medium]: 0.8, [Difficulty.Hard]: 0.85, [Difficulty.Impossible]: 0.9 } as Record<Difficulty, number>,
};

interface Ring {
  troops: number[];
  tiles: number[];
  ticks: number[];
  head: number; // next write slot
  n: number; // samples held (≤ SAMPLES)
}

const SAMPLES = 8;
const SAMPLE_EVERY = 50;

export class Rivals {
  private ring = new Map<Player, Ring>();
  private trustOf = new Map<Player, number>();
  private border = new Map<Player, number>(); // our border tiles facing each player (refreshed with the samples)
  private lastSample = -1e9;
  private seenAttacks = new Set<string>(); // attack ids already charged against trust
  private pendingRequests = new Set<Player>(); // outgoing alliance requests still open last tick
  private expiry = new Map<Player, number>(); // expiresAt of each current alliance, to tell a break from a lapse
  private nationCache = new Map<Player, { tick: number; can: boolean; send: number }>();
  /** `threatMap`: the per-segment influence map, rebuilt in the same border pass (empty while the flag is off). */
  readonly threat: ThreatMap;
  private wildCache = new Map<Player, { tick: number; bound: boolean }>();
  private drained = new Map<Player, number>(); // drainedUntil per nation
  private lim: FireLimiter;

  constructor(private ctx: BotContext) {
    this.threat = new ThreatMap(ctx);
    this.lim = new FireLimiter(ctx);
  }

  trust(p: Player): number {
    return this.trustOf.get(p) ?? 0.5;
  }
  private bump(p: Player, by: number, why: string): void {
    const before = this.trust(p);
    const after = Math.min(1, Math.max(0, before + by));
    this.trustOf.set(p, after);
    if (after !== before) this.ctx.log(`t${this.ctx.mg.ticks()} trust ${p.name()} ${before.toFixed(2)} → ${after.toFixed(2)}: ${why}`); // clamped at 0/1: nothing to report
  }

  // ---------------------------------------------------------------- events
  /** An alliance with `p` ended. `broken` = ended before its expiry (they broke it; the bot never does). `planned` =
   *  we let it lapse to attack them (Diplomacy.plannedTarget): a lapse of our choosing earns them no trust — the
   *  +0.1 used to make the planned prey look trustworthy in the war scorer's trust bonus. */
  onAllianceEnded(p: Player, planned = false, broken: boolean = this.wasBroken(p)): void {
    this.expiry.delete(p);
    if (broken) this.bump(p, -0.3, "broke the alliance early");
    else if (planned) this.ctx.log(`t${this.ctx.mg.ticks()} trust ${p.name()} ${this.trust(p).toFixed(2)} unchanged: we let the alliance lapse`);
    else this.bump(p, +0.1, "alliance ran its course");
  }
  private wasBroken(p: Player): boolean {
    const at = this.expiry.get(p);
    return at !== undefined && this.ctx.mg.ticks() < at - 5;
  }
  /** They turned down (or let lapse unanswered) our alliance request. */
  onRequestRefused(p: Player): void {
    this.bump(p, -0.1, "refused our alliance request");
  }
  /** They attacked us (`ally` null) or one of our allies. */
  onAttacked(p: Player, ally: Player | null): void {
    if (ally === null) this.bump(p, -0.2, "attacked us");
    else this.bump(p, -0.1, `attacked our ally ${ally.name()}`);
  }

  // ---------------------------------------------------------------- per tick
  /** Builds this tick's RivalView map for every non-bot neighbour (rivals and friends alike). */
  update(sit: Situation): Map<Player, RivalView> {
    const me = this.ctx.me, t = sit.tick;
    const watched = sit.rivals.concat(sit.friends);
    this.watchEvents(sit, watched);
    if (t - this.lastSample >= SAMPLE_EVERY) { this.sample(t, watched); this.lastSample = t; }
    const out = new Map<Player, RivalView>();
    for (const p of watched) {
      const r = this.ring.get(p);
      const [troopsDelta, tilesDelta] = r ? this.deltas(r) : [0, 0];
      const borderTiles = this.border.get(p) ?? 0;
      // the nation rules walk its border (troopSendCap → nearby) and its units (maxTroops): refreshed every 10 ticks,
      // the cadence every rule that will read them runs on
      let nr = this.nationCache.get(p);
      if (!nr || t - nr.tick >= 10) {
        const nation = p.type() === PlayerType.Nation && !me.isFriendly(p);
        let send = nation ? this.nationWouldSend(p) : 0;
        let can = nation && this.nationCanAttack(p, send, sit.troops);
        // `wildernessAware`: free land next door takes its whole surplus before any player is considered
        if (can && this.ctx.p.wildernessAware && this.wildernessBound(p)) { can = false; send = 0; this.lim.fire("wildernessAware", "view"); }
        nr = { tick: t, can, send };
        this.nationCache.set(p, nr);
      }
      const isNation = p.type() === PlayerType.Nation;
      const [largestAttacker, largestAttack] = isNation ? this.largestAttacker(p) : [null, 0];
      out.set(p, {
        troopsDelta, tilesDelta, trust: this.trust(p), borderTiles,
        bsr: this.bsr(p, borderTiles, sit.troops),
        nationCanAttack: nr.can, nationWouldSend: nr.send,
        wildernessBound: this.ctx.p.wildernessAware && isNation && this.wildernessBound(p),
        drainedUntil: isNation ? this.drainedUntil(p, t) : -1,
        largestAttacker, largestAttack,
        relation: isNation ? p.relation(me) : null,
      });
    }
    return out;
  }

  private watchEvents(sit: Situation, watched: Player[]): void {
    const me = this.ctx.me;
    // new attacks on us
    for (const a of sit.incoming) {
      if (this.seenAttacks.has(a.id())) continue;
      this.seenAttacks.add(a.id());
      this.onAttacked(a.attacker(), null);
    }
    // alliance requests that were pending and are now gone without an alliance
    const pending = new Set<Player>();
    for (const req of me.outgoingAllianceRequests()) if (req.status() === "pending") pending.add(req.recipient());
    for (const p of this.pendingRequests) if (!pending.has(p) && !me.isAlliedWith(p) && p.isAlive()) this.onRequestRefused(p);
    this.pendingRequests = pending;
    // remember every live alliance's expiry so a lapse can be told from a break
    for (const al of me.alliances()) this.expiry.set(al.other(me), al.expiresAt());
    if (sit.tick % SAMPLE_EVERY !== 0) return;
    // attacks on our allies by someone we watch (sampled: allies' incoming lists are not ours to scan every tick)
    if (this.seenAttacks.size > 4000) this.seenAttacks.clear();
    for (const ally of me.allies()) {
      for (const a of ally.incomingAttacks()) {
        if (this.seenAttacks.has(a.id()) || !watched.includes(a.attacker())) continue;
        this.seenAttacks.add(a.id());
        this.onAttacked(a.attacker(), ally);
      }
    }
  }

  private sample(t: number, watched: Player[]): void {
    for (const p of watched) {
      let r = this.ring.get(p);
      if (!r) { r = { troops: new Array(SAMPLES).fill(0), tiles: new Array(SAMPLES).fill(0), ticks: new Array(SAMPLES).fill(0), head: 0, n: 0 }; this.ring.set(p, r); }
      r.troops[r.head] = p.troops(); r.tiles[r.head] = p.numTilesOwned(); r.ticks[r.head] = t;
      r.head = (r.head + 1) % SAMPLES; r.n = Math.min(SAMPLES, r.n + 1);
    }
    for (const p of this.ring.keys()) if (!watched.includes(p)) { this.ring.delete(p); this.nationCache.delete(p); }
    // one pass over our border: how many of our border tiles touch each neighbour. With `threatMap` on the same
    // pass buckets the tiles into CELL × CELL cells per owner (a segment) for ThreatMap.compute.
    const mg = this.ctx.mg, counts = new Map<number, number>();
    const tm = this.ctx.p.threatMap, cellsW = Math.ceil(mg.width() / CELL), buckets = new Map<number, Bucket>();
    let ourBorder = 0;
    for (const tile of this.ctx.me.borderTiles()) {
      ourBorder++;
      const owners: number[] = []; // a tile counts once per neighbouring owner
      for (const nb of mg.neighbors(tile)) {
        const id = mg.ownerID(nb);
        if (id === 0) continue;
        if (owners.includes(id)) { if (tm) { const b = buckets.get(id * 1048576 + ((mg.y(tile) >> 4) * cellsW + (mg.x(tile) >> 4))); if (b) b.theirTiles++; } continue; }
        owners.push(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (!tm) continue;
        const x = mg.x(tile), y = mg.y(tile), cell = (y >> 4) * cellsW + (x >> 4), key = id * 1048576 + cell;
        let b = buckets.get(key);
        if (!b) { b = { cell, ownerID: id, tiles: 0, theirTiles: 0, sx: 0, sy: 0, members: [] }; buckets.set(key, b); }
        b.tiles++; b.theirTiles++; b.sx += x; b.sy += y; b.members.push(tile);
      }
    }
    this.border.clear();
    for (const p of watched) this.border.set(p, counts.get(p.smallID()) ?? 0);
    if (tm) this.threat.compute(buckets.values(), watched, ourBorder, this.ctx.me.troops());
  }

  private deltas(r: Ring): [number, number] {
    if (r.n < 2) return [0, 0];
    const newest = (r.head - 1 + SAMPLES) % SAMPLES, oldest = (r.head - r.n + SAMPLES) % SAMPLES;
    const span = r.ticks[newest] - r.ticks[oldest];
    if (span <= 0) return [0, 0];
    return [((r.troops[newest] - r.troops[oldest]) * 100) / span, ((r.tiles[newest] - r.tiles[oldest]) * 100) / span];
  }

  /** Border-security ratio. Approximation: the tiles of *their* border facing us are taken to equal the tiles of *our*
   *  border facing them (a shared front has about the same length seen from both sides), so their border share is
   *  ourFacing / their total border tiles. Their troops are spread along that share and compared to our whole army. */
  private bsr(p: Player, ourFacing: number, ourTroops: number): number {
    const theirBorder = p.borderTiles().size;
    if (theirBorder === 0 || ourFacing === 0) return 0;
    const share = Math.min(1, ourFacing / theirBorder);
    return (p.troops() * share) / Math.max(1, ourTroops);
  }

  // ---------------------------------------------------------------- housekeeping
  /** `p.nearby()` walks the rival's whole border; memoised per rival for `nearbyEvery` ticks like the bot's own
   *  neighbours() (Situation.ts). nearbyEvery = 1 is the uncached behaviour. */
  private nearbyCache = new Map<Player, { tick: number; players: (Player | TerraNullius)[] }>();
  private nearbyOf(p: Player): (Player | TerraNullius)[] {
    const t = this.ctx.mg.ticks(), every = Math.max(1, this.ctx.p.nearbyEvery);
    let c = this.nearbyCache.get(p);
    if (!c || t - c.tick >= every) { c = { tick: t, players: p.nearby() }; this.nearbyCache.set(p, c); }
    return c.players;
  }
  /** Drop what is kept about players no longer on the map (called every 300 ticks). Trust survives a lapse of
   *  contact on purpose: a neighbour that broke faith and comes back is still the one that broke faith. */
  prune(): void {
    for (const m of [this.nearbyCache, this.trustOf, this.expiry, this.ring, this.nationCache, this.border]) for (const p of m.keys()) if (!p.isAlive()) m.delete(p);
    for (const p of this.nearbyCache.keys()) if (!this.ring.has(p) && !this.expiry.has(p)) this.nearbyCache.delete(p);
  }

  // ---------------------------------------------------------------- nation rules (AiAttackBehavior re-implemented)
  /** troopSendCap for `p` (AiAttackBehavior.ts:903-949): Infinity unless Hard/Impossible FFA, where it is
   *  troops − ceil(retain × strongest unfriendly non-bot neighbour's troops), raised to the incoming total if under attack. */
  troopSendCap(p: Player, asIfUnallied = false): number {
    const mg = this.ctx.mg;
    if (p.type() === PlayerType.Bot) return Infinity;
    if (mg.config().gameConfig().gameMode === GameMode.Team) return Infinity;
    const retain = NATION_RULES.retain[mg.config().gameConfig().difficulty];
    if (retain === undefined) return Infinity;
    let maxNeighborTroops = 0;
    for (const n of this.nearbyOf(p)) {
      // asIfUnallied: we are read as the unfriendly neighbour we become once the alliance lapses
      if (n.isPlayer() && (!p.isFriendly(n) || (asIfUnallied && n === this.ctx.me)) && n.type() !== PlayerType.Bot && n.troops() > maxNeighborTroops) maxNeighborTroops = n.troops();
    }
    let cap = maxNeighborTroops === 0 ? Infinity : Math.max(0, p.troops() - Math.ceil(maxNeighborTroops * retain));
    const incoming = p.incomingAttacks();
    if (incoming.length > 0) cap = Math.max(cap, incoming.reduce((s, a) => s + a.troops(), 0));
    return cap;
  }
  /** Troops a land attack from `p` on us would carry (AiAttackBehavior.ts:951-1006): troops − maxTroops × reserveRatio,
   *  capped by troopSendCap. reserveRatio is per-nation random in [0.30, 0.40] (NationExecution.ts:58); the lower bound
   *  is used, so this is the most it could send. 0 when the rules would return null (< 1 troop or too weak). */
  nationWouldSend(p: Player, asIfUnallied = false): number {
    const mg = this.ctx.mg;
    const maxTroops = mg.config().maxTroops(p);
    let troops = p.troops() - maxTroops * NATION_RULES.reserveRatio[0];
    troops = Math.min(troops, this.troopSendCap(p, asIfUnallied));
    if (troops < 1) return 0;
    if (this.isAttackTooWeak(p, troops)) return 0;
    return troops;
  }
  /** isAttackTooWeak (AiAttackBehavior.ts:878-891) with us as the target. */
  private isAttackTooWeak(p: Player, troops: number): boolean {
    const mg = this.ctx.mg;
    if (p.type() === PlayerType.Bot) return false;
    if (mg.config().gameConfig().gameMode === GameMode.Team) return false;
    if (p.incomingAttacks().length > 0) return false;
    const d = mg.config().gameConfig().difficulty;
    return (d === Difficulty.Hard || d === Difficulty.Impossible) && troops < this.ctx.me.troops() * NATION_RULES.tooWeakShare;
  }
  /** Would attackBestTarget → sendAttack(us) go through, dice aside? Needs the reserve ratio (AiAttackBehavior.ts:244,
   *  lower bound 0.30 so "can" is the permissive reading) and a positive, not-too-weak send. In FFA the strategies that
   *  pick a live, non-traitor neighbour also guard on troops: `weakest` needs ours < theirs (AiAttackBehavior.ts:342),
   *  `hated` (a Hostile relation) allows up to 3× theirs (line 323). Trigger ratio (line 247) is a 1-in-10 dice roll
   *  below it, so not a gate; `retaliate` (line 267) bypasses all of this once we attack them. */
  /** C1 (`nationAware`): would this ally's nation rules let it attack us the moment the alliance lapses, given our
   *  troops now? The same checks as the RivalView fields, with us counted as the unfriendly neighbour we become. */
  couldAttackAtExpiry(p: Player, ourTroops: number): { can: boolean; send: number } {
    if (p.type() !== PlayerType.Nation) return { can: false, send: 0 };
    const send = this.nationWouldSend(p, true);
    const can = this.nationCanAttack(p, send, ourTroops);
    if (can && this.ctx.p.wildernessAware && this.wildernessBound(p)) { this.lim.fire("wildernessAware", "expiry"); return { can: false, send: 0 }; }
    return { can, send };
  }

  // ---------------------------------------------------------------- opportunity #2: the nation script on the current state
  /** `wildernessAware`: does `p` have unowned, fallout-free, passable land next to its border? AiAttackBehavior.maybeAttack
   *  (lines 60-95) then sends troops − maxTroops × expandRatio at TerraNullius and returns without looking at players.
   *  Every 4th border tile is sampled (a wilderness edge is never one tile long); cached 50 ticks per rival. */
  wildernessBound(p: Player): boolean {
    const t = this.ctx.mg.ticks();
    const c = this.wildCache.get(p);
    if (c && t - c.tick < 50) return c.bound;
    const mg = this.ctx.mg;
    let bound = false, i = 0;
    for (const tile of p.borderTiles()) {
      if ((i++ & 3) !== 0) continue;
      for (const nb of mg.neighbors(tile)) {
        if (mg.isLand(nb) && !mg.isImpassable(nb) && !mg.hasOwner(nb) && !mg.hasFallout(nb)) { bound = true; break; }
      }
      if (bound) break;
    }
    this.wildCache.set(p, { tick: t, bound });
    return bound;
  }
  /** `drainedNations`: a nation under reserveRatio × max (the lower bound, so surely under its own) cannot attack anyone
   *  (attackBestTarget line 244). It is "drained" until its troops are expected back at triggerRatio × max, at the
   *  engine's current regrowth rate (Config.troopIncreaseRate, which only falls as troops rise — an underestimate,
   *  capped at 3000 ticks). The estimate is refreshed while it stays under the line and kept once it climbs out. */
  drainedUntil(p: Player, t: number): number {
    const mg = this.ctx.mg;
    const max = Math.max(1, mg.config().maxTroops(p));
    if (p.troops() < max * this.ctx.p.drainBelow) { // drainBelow = NATION_RULES.reserveRatio[0] by default
      const need = max * NATION_RULES.triggerRatio[0] - p.troops();
      const rate = Math.max(1, mg.config().troopIncreaseRate(p));
      const until = t + Math.min(3000, Math.ceil(need / rate));
      this.drained.set(p, until);
      return until;
    }
    const kept = this.drained.get(p);
    if (kept !== undefined && kept > t) return kept;
    this.drained.delete(p);
    return -1;
  }
  /** `retaliateAware`: AiAttackBehavior.findIncomingAttackPlayer (lines 405-426): the largest incoming wave from a
   *  non-bot the nation is not friendly with, and its troops. */
  largestAttacker(p: Player): [Player | null, number] {
    let best: Player | null = null, troops = 0;
    for (const a of p.incomingAttacks()) {
      const att = a.attacker();
      if (att.type() === PlayerType.Bot || p.isFriendly(att) || a.troops() <= troops) continue;
      troops = a.troops(); best = att;
    }
    return [best, troops];
  }
  /** `relationAware`: would NationAllianceBehavior.getAllianceDecision (lines 88-148) say yes to our request, dice aside?
   *  The dice (confusion, the early-game and Friendly rolls, the ranges) are read at their permissive end, so a `false`
   *  is a certain refusal and a `true` is the best case. Humans: always true (the rules are nation-only). */
  wouldAcceptAlliance(p: Player): boolean {
    if (p.type() !== PlayerType.Nation) return true;
    const me = this.ctx.me, mg = this.ctx.mg, cfg = mg.config(), d = cfg.gameConfig().difficulty;
    if (me.isTraitor()) return false; // line 97: 90 % refusal
    const tooMany = NATION_RULES.tooManyAlliancesShare[d];
    if (tooMany !== undefined && me.alliances().length >= mg.players().filter((o) => o.type() !== PlayerType.Bot).length * tooMany) return false;
    // threat (220-252): the one rule that beats a bad relation
    const threat = d === Difficulty.Medium ? me.troops() > p.troops() * NATION_RULES.threatTroops[d]!
      : d === Difficulty.Hard ? me.troops() > p.troops() && cfg.maxTroops(me) > cfg.maxTroops(p) * 2
      : d === Difficulty.Impossible ? me.troops() > p.troops() * NATION_RULES.threatTroops[d]! || (me.troops() > p.troops() && (cfg.maxTroops(me) > cfg.maxTroops(p) * 1.5 || me.numTilesOwned() > p.numTilesOwned() * 1.5))
      : false;
    if (threat) return true;
    if (cfg.gameConfig().gameMode === GameMode.Team && d === Difficulty.Impossible) return false; // 268: always
    const rel = p.relation(me);
    if (rel < Relation.Neutral) return false;
    if (rel === Relation.Friendly) return true;
    // enough alliances (274-306)
    if (d === Difficulty.Hard || d === Difficulty.Impossible) {
      const bordering = p.nearby().filter((n): n is Player => n.isPlayer() && n.type() !== PlayerType.Bot);
      if (bordering.length >= 2 && bordering.includes(me) && bordering.length <= bordering.filter((o) => p.isFriendly(o)).length + 1) return false;
    }
    if (p.alliances().length >= NATION_RULES.enoughAlliances[d]) return false;
    if (mg.ticks() < NATION_RULES.earlyGameTicks[d] + cfg.numSpawnPhaseTurns()) return true;
    // similarly strong (330-369), read with the lowest thresholds the dice can draw
    const out = (o: Player) => o.outgoingAttacks().reduce((s, a) => s + a.troops(), 0);
    const theirs = p.troops() + out(p), ours = me.troops() + out(me);
    if (ours > theirs * NATION_RULES.similarTroops[d]) return true;
    return me.numTilesOwned() > p.numTilesOwned() * NATION_RULES.similarTiles[d] && ours > theirs * 0.5;
  }
  nationCanAttack(p: Player, wouldSend: number, ourTroops: number): boolean {
    if (p.type() !== PlayerType.Nation || !p.isAlive()) return false;
    const mg = this.ctx.mg;
    const ratio = p.troops() / Math.max(1, mg.config().maxTroops(p));
    if (ratio < NATION_RULES.reserveRatio[0]) return false;
    if (wouldSend < 1) return false;
    if (mg.config().gameConfig().gameMode === GameMode.FFA) {
      const hostile = p.relation(this.ctx.me) === Relation.Hostile;
      if (ourTroops >= p.troops() * (hostile ? 3 : 1)) return false;
    }
    return true;
  }
}
