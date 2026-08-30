// PlaybookBot: an AI player that follows the OpenFront Playbook rules.
// v2: expansion flow, bot harvesting, island boats, alliances, fighting by
// density with retreat, a gold-spending loop, and defense posts.
// Parameterised so a lab harness can tune the numbers.
//
// This file owns the loop (init/tick), the per-tick situation, the two ways troops leave home (send/boat),
// the event hooks, the rule table, and spawn picking. The rules themselves live in Situation.ts (queries),
// Military.ts, Economy.ts and Diplomacy.ts, all working on the shared BotContext.

import { Config } from "../../configuration/Config";
import {
  Execution,
  Game,
  Player,
  PlayerType,
  UnitType,
} from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { PseudoRandom } from "../../PseudoRandom";
import { simpleHash } from "../../Util";
import { Difficulty, GameMapType } from "../../game/Game";
import { AttackExecution } from "../AttackExecution";
import { TransportShipExecution } from "../TransportShipExecution";
import { BotContext, FireLimiter } from "./Context";
import { Diplomacy } from "./Diplomacy";
import { Economy } from "./Economy";
import { Military } from "./Military";
import { MirvRisk } from "./MirvRisk";
import { DEFAULT_PLAYBOOK, PlaybookParams } from "./Params";
import { Situation, SituationQueries } from "./Situation";

export { DEFAULT_PLAYBOOK } from "./Params";
export type { PlaybookParams } from "./Params";
export type { BotContext } from "./Context";
export type { Situation } from "./Situation";

export class PlaybookBotExecution implements Execution {
  private active = true;
  private mg!: Game;
  private config!: Config;
  private random: PseudoRandom;
  private boatSent = false;
  private earlyWould = false; // `boatsAfterCoast`: the old early-boat rule would have launched by now (it launches once)
  private dry = false; // `boatsAfterCoast`: dry-running a rule — see BotContext.dry
  private dryBoats = 0;
  private landmassChecked = false;
  private onSmallLandmass = false;
  public log: string[] = [];
  /** flag → how often it changed a decision this game (lab liveness: an A/B game where nothing fired is not evidence) */
  public fired = new Map<string, number>();
  public kills = 0;
  /** Bombs and MIRVs fired (kept by Military). */
  get bombs(): number {
    return this.military.bombs;
  }
  /** Enemy MIRVs aimed at our land (MirvRisk, always on). */
  get mirvsTaken(): number {
    return this.risk.mirvsTaken;
  }

  private ctx: BotContext;
  private lim: FireLimiter;
  private q: SituationQueries;
  private risk: MirvRisk;
  private military: Military;
  private economy: Economy;
  private diplomacy: Diplomacy;

  constructor(
    private player: Player,
    private p: PlaybookParams = DEFAULT_PLAYBOOK,
  ) {
    this.random = new PseudoRandom(simpleHash(player.id()) + 7);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const bot = this;
    this.ctx = {
      get mg() { return bot.mg; },
      get me() { return bot.player; },
      get p() { return bot.p; },
      get sit() { return bot.sit; },
      get random() { return bot.random; },
      send: (targetID, n, why, min, capFloor) => bot.send(targetID, n, why, min, capFloor),
      boat: (tile, n, why) => bot.boat(tile, n, why),
      log: (line) => { if (bot.log.length < 2000) bot.log.push(line); },
      fire: (flag) => { if (!bot.dry) bot.fired.set(flag, (bot.fired.get(flag) ?? 0) + 1); },
      get dry() { return bot.dry; },
    };
    this.lim = new FireLimiter(this.ctx);
    this.q = new SituationQueries(this.ctx);
    this.risk = new MirvRisk(this.ctx);
    this.military = new Military(this.ctx, this.q, () => this.diplomacy.plannedTarget, this.risk);
    this.economy = new Economy(this.ctx, this.q, this.military, this.risk);
    this.diplomacy = new Diplomacy(this.ctx, this.q, this.military, this.economy);
  }

  init(mg: Game): void {
    this.mg = mg;
    this.config = mg.config();
  }
  isActive(): boolean {
    return this.active;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }

  // ---------------------------------------------------------------- situation, invariants, rules
  /** One evaluated picture of the game per tick; every rule reads this instead of re-deriving state. */
  private sit!: Situation;
  private lastMode: "grow" | "hold" | "push" = "grow";
  private prevAllies = new Set<Player>();
  private prevIncoming = new Set<string>();
  /** The slow parts of the situation (a scan of every player for MIRV threats, the expiring alliances, the expiry
   *  hold with its nation-rule border walk) are computed on the 10-tick cadence every consumer runs on — send(),
   *  boat() and the rules all fire on multiples of 10 — and reused in between. Decision-identical (golden test). */
  private slow: { tick: number; threats: Player[]; expiring: Player[]; hold: Player | null; mode: "grow" | "hold" | "push" } | null = null;
  private lastHoldFire = -1e9;
  private readSituation(): void {
    const me = this.player;
    const troops = me.troops(), cap = this.q.cap();
    const nb = this.q.neighbours();
    const incoming = me.incomingAttacks().filter((a) => a.attacker().type() !== PlayerType.Bot);
    const outgoing = me.outgoingAttacks();
    let reserve = troops * this.p.reserveShare;
    const t = this.mg.ticks();
    // `wildernessAware`: while every unfriendly neighbour is a nation with free land on its border, none of them can
    // attack us this tick (their script spends the surplus on the wilderness first) — half the reserve is enough
    if (this.p.wildernessAware && nb.rivals.length > 0 && nb.rivals.every((r) => r.type() === PlayerType.Nation && this.q.rivals.wildernessBound(r))) {
      reserve *= 0.5;
      if (t % 100 === 0) this.ctx.fire("wildernessAware");
    }
    this.sit = {
      tick: t, troops, cap, capShare: cap > 0 ? troops / cap : 0, reserve, spendable: Math.max(0, troops - reserve),
      gold: me.gold(), ...nb,
      incoming, incomingBots: me.incomingAttacks().length - incoming.length, outgoing,
      tribeAttacks: outgoing.filter((a) => a.target().isPlayer() && (a.target() as Player).type() === PlayerType.Bot).length,
      boats: me.units(UnitType.TransportShip).length,
      collapsed: nb.rivals.filter((r) => this.military.collapsed(r)), // cheap (a map lookup per rival); its 100-tick snapshot keeps the original tick alignment
      expiring: [],
      hold: null,
      share: me.numTilesOwned() / Math.max(1, this.mg.numLandTiles()), threats: [], mode: "grow", phase: "opening", rival: new Map(),
    };
    if (this.slow === null || t % 10 === 0) this.slow = this.readSlow(t, troops);
    this.sit.threats = this.slow.threats; this.sit.expiring = this.slow.expiring; this.sit.hold = this.slow.hold; this.sit.mode = this.slow.mode;
    this.q.enrichRivals(this.sit); // B2: per-rival view
    if (this.p.threatMap) {
      // review #5: the reserve follows the pressure nobody at home answers (Σ max(0, theirs − ours) over unfriendly
      // segments), from the flat share up to twice it — bsrReserve scaled one reserve by the max bsr and lost its A/B.
      // Never below the flat share: the brief's 0.5 floor made every calm minute a 15 % reserve and the sea-expansion
      // rule shipped the army to collapsed players on other continents (africa 6-min smoke: 8.8k tiles vs 44k)
      const tm = this.q.rivals.threat;
      const mult = Math.min(2, Math.max(1, 1 + (this.p.threatReserveGain * tm.undefended) / Math.max(1, troops)));
      this.sit.reserve = this.sit.reserve * mult; this.sit.spendable = Math.max(0, troops - this.sit.reserve);
      if (mult !== 1 && t % 100 === 0) this.ctx.fire("threatMap");
      if (t % 600 === 0 && tm.segments.length > 0) this.ctx.log(`t${t} ${tm.summary()} reserve ×${mult.toFixed(2)}`);
    }
    this.q.enrichPhase(this.sit); // B2: phase (reads spendable)
  }
  private readSlow(t: number, troops: number): NonNullable<typeof this.slow> {
    const me = this.player;
    const share = this.sit.share;
    const expiring = me.alliances().filter((al) => al.expiresAt() - t < 450).map((al) => al.other(me));
    // the finish: nations MIRV anyone over 65 % of the map on Medium (55 % Hard), allies included. Under that line
    // while a rival can still fire; remove the rivals; then push for the win.
    const diff = this.mg.config().gameConfig().difficulty;
    const denial = diff === Difficulty.Easy ? 0.75 : diff === Difficulty.Medium ? 0.65 : diff === Difficulty.Hard ? 0.55 : 0.5;
    // a rival can fire once it has a silo and either the live MIRV price (25M + 15M per launch on the map, the gate
    // NationMIRVBehavior.considerMIRV uses) or a MIRV already built
    const mirvInfo = this.mg.config().unitInfo(UnitType.MIRV);
    const threats = this.mg.players().filter((p) => p !== me && p.isAlive() && p.type() !== PlayerType.Bot && !me.isOnSameTeam(p) && p.units(UnitType.MissileSilo).length > 0 && (p.gold() >= mirvInfo.cost(this.mg, p) || p.units(UnitType.MIRV).length > 0));
    let mode: "grow" | "hold" | "push" = "grow";
    if (this.p.finishRule && share >= denial - 0.03) mode = threats.length > 0 ? "hold" : "push";
    else if (this.p.finishRule && share >= 0.45 && threats.length === 0) mode = "push";
    if (mode !== this.lastMode) { if (this.log.length < 2000) this.log.push(`t${t} FINISH mode ${this.lastMode} → ${mode}: share ${(share * 100).toFixed(0)} %, ${threats.length} MIRV-capable rivals${threats.length ? " (" + threats.map((x) => x.name()).join(", ") + ")" : ""}`); this.lastMode = mode; }
    // A Hard nation renews only if we look as strong as it at expiry: 45 s before an alliance with a stronger
    // neighbour lapses, the army stays home so the check sees all of it.
    // C1 (`nationAware`): hold only for a nation whose own attack rules would let it hit us at expiry
    const nationHold = expiring.find((o) => o.type() === PlayerType.Nation && (this.p.nationAware ? this.q.rivals.couldAttackAtExpiry(o, troops).can : o.troops() > troops * 0.85)) ?? null;
    if (this.p.nationAware && t % 100 === 0) { const heur = expiring.find((o) => o.type() === PlayerType.Nation && o.troops() > troops * 0.85) ?? null; if (heur !== nationHold) this.ctx.fire("nationAware"); }
    // `holdHumans`: a human ally stronger than us gets the same 45 s hold — a human can attack the moment it lapses too
    let hold = nationHold;
    if (this.p.holdHumans && hold === null) {
      hold = expiring.find((o) => o.type() === PlayerType.Human && o.troops() > troops * 0.85) ?? null;
      if (hold !== null && t - this.lastHoldFire >= 100) { this.lastHoldFire = t; this.ctx.fire("holdHumans"); }
    }
    return { tick: t, threats, expiring, hold, mode };
  }
  /** The one place troops leave home. Never below the reserve; returns what was actually sent (0 = nothing). */
  private send(targetID: string | null, n: number, why: string, min = 500, capFloor = 0): number {
    // capFloor: never leave home under this share of CAP — Hard nations betray an ally under 20 % of cap on sight
    if (this.sit.mode === "hold" && why !== "counter" && why !== "war") return 0; // holding under the line: no more land until the MIRV-capable rivals are gone
    if (this.sit.hold !== null && why !== "counter") { if (this.log.length < 2000 && this.sit.tick % 300 === 0) this.log.push(`t${this.sit.tick} holding troops home: alliance with ${this.sit.hold.name()} about to lapse`); return 0; }
    const room = Math.floor(Math.min(this.sit.spendable, this.sit.troops - this.sit.cap * capFloor));
    const amount = Math.min(Math.floor(n), room);
    // a war goes whole or not at all: a 2× wave trimmed to 0.3× by the reserve is the worst attack in the game
    if (why === "war" && amount < n * 0.9) { if (this.log.length < 2000) this.log.push(`t${this.sit.tick} war held: wants ${Math.round(n / 1000)}k, only ${Math.round(room / 1000)}k spare`); return 0; }
    if (amount < min) { if (room < min && this.log.length < 2000 && this.sit.tick % 300 === 0) this.log.push(`t${this.sit.tick} held: ${why} wants ${Math.round(n / 1000)}k, ${Math.round(room / 1000)}k above reserve`); return 0; }
    this.mg.addExecution(new AttackExecution(amount, this.player, targetID));
    this.sit.spendable -= amount; this.sit.troops -= amount;
    return amount;
  }
  /** `boatDedupe`: is a boat of ours already bound for (or just landed) within boatDedupeRadius of `tile`? */
  private recentLandings: { tile: TileRef; tick: number }[] = [];
  private boatBound(tile: TileRef): boolean {
    const r2 = this.p.boatDedupeRadius ** 2, now = this.sit.tick;
    this.recentLandings = this.recentLandings.filter((l) => now - l.tick < 300);
    if (this.recentLandings.some((l) => this.mg.euclideanDistSquared(l.tile, tile) <= r2)) return true;
    for (const u of this.player.units(UnitType.TransportShip)) { const d = u.targetTile(); if (d !== undefined && this.mg.euclideanDistSquared(d, tile) <= r2) return true; }
    return false;
  }
  private boat(tile: TileRef, n: number, why: string): number {
    if (this.sit.hold !== null || (this.sit.mode === "hold" && !why.includes("collapsed"))) return 0;
    const amount = Math.min(Math.floor(n), Math.floor(this.sit.spendable));
    if (amount < 500 || this.player.canBuild(UnitType.TransportShip, tile) === false) return 0;
    if (this.p.boatDedupe && !why.startsWith("finish") && this.boatBound(tile)) { this.fired.set("boatDedupe", (this.fired.get("boatDedupe") ?? 0) + 1); return 0; } // finishByBoat keeps its own one-per-target rule
    if (this.dry) { this.dryBoats++; return amount; } // `boatsAfterCoast`: would have launched
    this.mg.addExecution(new TransportShipExecution(this.player, tile, amount));
    this.recentLandings.push({ tile, tick: this.sit.tick });
    this.sit.spendable -= amount; this.sit.troops -= amount; this.sit.boats++;
    if (this.log.length < 2000) this.log.push(`t${this.sit.tick} boat ${Math.round(amount / 1000)}k: ${why}`);
    return amount;
  }
  /** Things that happened since last tick. Reactions run before the regular rules. */
  private events(): void {
    const me = this.player;
    const allies = new Set(me.allies());
    for (const p of this.prevAllies) {
      if (allies.has(p) || !p.isAlive()) continue;
      this.diplomacy.onAllianceEnded(p);
      this.q.rivals.onAllianceEnded(p, p === this.diplomacy.plannedTarget); // a lapse we chose says nothing about them
    }
    this.prevAllies = allies;
    const inc = new Set(this.sit.incoming.map((a) => a.attacker().id()));
    for (const a of this.sit.incoming) {
      if (this.prevIncoming.has(a.attacker().id())) continue;
      if (this.log.length < 2000) this.log.push(`t${this.sit.tick} INCOMING ${a.attacker().name()} ${Math.round(a.troops() / 1000)}k`);
    }
    this.prevIncoming = inc;
  }
  // #3 (`utility`): one `troops` rule (Military.troopsRule) replaces counter / expand / tribes / wars
  private rules: { name: string; every: number; run: () => void }[] = [
    { name: "split", every: 200, run: () => this.military.watchSplit() },
    ...(this.p.utility
      ? [
          { name: "retreats", every: 10, run: () => this.military.manageRetreats() },
          { name: "troops", every: 10, run: () => this.military.troopsRule() },
        ]
      : [
          { name: "counter", every: 10, run: () => this.military.counterAttack() },
          { name: "retreats", every: 10, run: () => this.military.manageRetreats() },
          { name: "expand", every: this.p.expandEvery, run: () => this.military.expand() },
          { name: "tribes", every: 10, run: () => this.military.harvestBots() },
          { name: "wars", every: 10, run: () => this.military.fight() },
        ]),
    { name: "alliances", every: this.p.allianceEvery, run: () => { this.diplomacy.requestAlliances(); this.diplomacy.manageEmbargoes(); } },
    // every alliance inside its 300-tick renewal window is seen six times, so a gift or renewal that could not go
    // through on one pass (donation cooldown, no room for the gift) is retried before the expiry
    { name: "expiries", every: 50, run: () => this.diplomacy.manageExpiries() },
    { name: "early boat", every: 20, run: () => {
      if (this.boatSent || this.sit.tick < this.p.boatAtTick) return;
      if (this.coastFirst()) { if (!this.earlyWould && this.dryRun(() => this.military.earlyBoat())) { this.earlyWould = true; this.ctx.fire("boatsAfterCoast"); } return; }
      this.boatSent = this.military.earlyBoat() || this.sit.tick > this.p.boatAtTick + 600;
    } },
    { name: "tribe boats", every: 100, run: () => {
      if (this.sit.tick < 300) return;
      if (this.coastFirst()) { if (this.dryRun(() => this.military.huntBotsByBoat())) this.ctx.fire("boatsAfterCoast"); return; }
      this.military.huntBotsByBoat();
    } },
    { name: "sea expansion", every: 100, run: () => { if (this.sit.tick >= 600) this.military.seaExpansion(); } },
    { name: "finish by boat", every: 100, run: () => { if (this.p.finishByBoat && this.sit.tick >= 1200) this.military.finishByBoat(); } }, // `finishByBoat`: the remnant a land war cannot reach
    { name: "build", every: 10, run: () => { this.economy.build(this.sit.tick); this.military.maybeBomb(this.sit.tick, this.economy.spentThisPass); } },
    { name: "mirv", every: 100, run: () => this.military.maybeMIRV() },
    // always-on diagnostics: the nations' MIRV rules against us (logged on change) and every enemy MIRV aimed at our land
    { name: "mirv risk", every: 100, run: () => this.risk.check() },
    { name: "mirved", every: 10, run: () => this.risk.scan() },
    { name: "prune", every: 300, run: () => { this.military.prune(); this.q.prune(); } }, // the per-player maps would otherwise grow for the whole game
  ];

  /** `boatsAfterCoast`: expand to the coast first — no early or tribe boat while free land is still reachable by land
   *  on our own landmass (a border tile beside unowned land, or Situation.freeLandReachable's capped flood fill),
   *  unless we started on a small landmass (islandMaxTiles), where the only way out is a boat. */
  private coastFirst(): boolean {
    return this.p.boatsAfterCoast && !this.onSmallLandmass && (this.sit.wilderness || this.q.freeLandReachable(this.sit.tick));
  }
  /** Runs `rule` with boat() reporting launches instead of making them; true when it would have launched a boat. */
  private dryRun(rule: () => void): boolean {
    this.dry = true; this.dryBoats = 0;
    try { rule(); } finally { this.dry = false; }
    return this.dryBoats > 0;
  }

  tick(ticks: number): void {
    const me = this.player;
    if (!me.isAlive()) {
      this.active = false;
      return;
    }
    if (!this.landmassChecked && me.numTilesOwned() > 0) {
      this.landmassChecked = true;
      this.onSmallLandmass = this.q.landmassSize(this.p.islandMaxTiles + 1) <= this.p.islandMaxTiles;
    }
    this.readSituation();
    this.diplomacy.acceptAlliances();
    this.q.invalidateNeighbours(); // an accepted request is a friend from this tick on
    this.events();
    for (const r of this.rules) if (ticks % r.every === 0) r.run();
  }

  // ---------------------------------------------------------------- spawn
  /** Phase 0 of the playbook: score every shore tile. Coast required; enough land around; no nation within
   *  `veto` tiles (relaxed in stages); nations near cost points, tribes near earn them; an edge at your back
   *  helps; other humans on the spot hurt. `prefer` keeps the search inside a region (lab use). */
  static pickSpawn(game: Game, prefer?: [number, number], exclude: [number, number][] = []): TileRef | null {
    const nations: TileRef[] = [], tribes: TileRef[] = [], humans: TileRef[] = [];
    for (const p of game.players()) {
      const t = p.spawnTile();
      if (t === undefined) continue;
      if (p.type() === PlayerType.Nation) nations.push(t); else if (p.type() === PlayerType.Bot) tribes.push(t); else humans.push(t);
    }
    const W = game.width(), H = game.height();
    const isWorld = game.config().gameConfig().gameMap === GameMapType.World;
    const stages: [number, number][] = prefer ? [[110, 250], [88, 300], [66, 350], [50, 400]] : [[110, 1e9], [80, 1e9], [50, 1e9]];
    const step = prefer ? 3 : 4;
    for (const [veto, radius] of stages) {
      let best: TileRef | null = null, bestS = -1e9;
      const cands: [number, TileRef][] = [];
      for (let y = 30; y < H - 30; y += step) {
        if (isWorld && y > H * 0.88) break; // Antarctica: no nations, no trade partners, no game
        for (let x = 30; x < W - 30; x += step) {
          if (prefer && Math.hypot(x - prefer[0], y - prefer[1]) > radius) continue;
          if (exclude.some(([ex, ey]) => Math.hypot(x - ex, y - ey) < 120)) continue; // lab: distinct spawns per batch
          const t = game.ref(x, y);
          if (!game.isLand(t) || !game.isOceanShore(t) || game.hasOwner(t)) continue; // an ocean coast, not a lake: lakes have no trade partners and no un-annexable border
          let land = 0;
          for (let dy = -15; dy <= 15; dy += 5) for (let dx = -15; dx <= 15; dx += 5) { if (game.isValidCoord(x + dx, y + dy) && game.isLand(game.ref(x + dx, y + dy))) land++; }
          if (land < 22) continue; // a straight coast is about half land within 15 tiles
          let score = 0, near = 0, ok = true;
          let n300 = 0;
          for (const n of nations) { const d = Math.abs(game.x(n) - x) + Math.abs(game.y(n) - y); if (d < veto) { ok = false; break; } if (d < 200) near += 4; else if (d < 300) near += 1; if (d < 300) n300++; }
          if (!ok) continue;
          score -= Math.min(near, 12);
          // 67-spawn regression (Medium, 20 min): 12+ nations within 300 halves median land (33k vs 59k), 20+ is a
          // 2k-tile pocket (Oman, Balkans). The capped `near` term cannot see past 12.
          if (n300 >= 20) continue;
          if (n300 >= 16) score -= 8; else if (n300 >= 12) score -= 4;
          for (const b of tribes) { const d = Math.abs(game.x(b) - x) + Math.abs(game.y(b) - y); if (d < 150) score += 3; else if (d < 250) score += 1; }
          for (const h of humans) { const d = Math.abs(game.x(h) - x) + Math.abs(game.y(h) - y); if (d < 150) score -= 3; }
          if (Math.min(x, y, W - x, H - y) < 80) score += 2;
          let room = 0; for (let dy = -50; dy <= 50; dy += 10) for (let dx = -50; dx <= 50; dx += 10) { if (game.isValidCoord(x + dx, y + dy)) { const r = game.ref(x + dx, y + dy); if (game.isLand(r) && !game.hasOwner(r)) room++; } }
          score += room / 20; // free land within 50 tiles: a pocket between two nations has little
          let left = false, right = false, up = false, down = false;
          for (const n of nations) { const d = Math.abs(game.x(n) - x) + Math.abs(game.y(n) - y); if (d > 260) continue; if (game.x(n) < x - 60) left = true; if (game.x(n) > x + 60) right = true; if (game.y(n) < y - 60) up = true; if (game.y(n) > y + 60) down = true; }
          if ((left && right) || (up && down)) score -= 5; // sandwiched (67-spawn regression: no measurable effect either way; kept for continuity)
          if (prefer) score -= Math.hypot(x - prefer[0], y - prefer[1]) / 60;
          if (score > bestS) { bestS = score; best = t; }
          cands.push([score, t]);
        }
      }
      if (best !== null) {
        // second pass: the cheap score cannot tell an isthmus or island from open country. For the best 60
        // candidates, flood-fill unowned land reachable within 120 tiles. 67-spawn regression (Medium, 20 min):
        // basin < 3k = 15k median land vs 64k (vetoed), < 6k = 33k (-6). Steps, not a slope: a slope (pk1) never reordered the top.
        cands.sort((a, b) => b[0] - a[0]);
        bestS = -1e9; best = null;
        for (const [s0, t] of cands.slice(0, 60)) {
          const basin = PlaybookBotExecution.basin(game, t, 120, 12000);
          if (basin < 3000) continue;
          const s1 = s0 - (basin < 6000 ? 6 : 0);
          if (s1 > bestS) { bestS = s1; best = t; }
        }
      }
      if (best !== null) { PlaybookBotExecution.lastSpawnDiag = `tick ${game.ticks()} nations=${nations.length} tribes=${tribes.length} humans=${humans.length} stage veto=${veto} score=${bestS.toFixed(1)} at ${game.x(best)},${game.y(best)}`; return PlaybookBotExecution.inland(game, best, DEFAULT_PLAYBOOK.spawnInland); }
    }
    PlaybookBotExecution.lastSpawnDiag = `no spawn: nations=${nations.length}`;
    return null;
  }
  static lastSpawnDiag = "";
  /** Unowned land tiles reachable from `t` over unowned land within `radius` (manhattan), capped at `cap`. */
  static basin(game: Game, t: TileRef, radius: number, cap: number): number {
    const seen = new Set<TileRef>([t]);
    const q: TileRef[] = [t];
    let i = 0;
    while (i < q.length && seen.size < cap) {
      const c = q[i++];
      for (const n of game.neighbors(c)) {
        if (seen.has(n) || !game.isLand(n) || game.hasOwner(n) || game.manhattanDist(n, t) > radius) continue;
        seen.add(n); q.push(n);
      }
    }
    return seen.size;
  }
  /** Walk `d` tiles away from the sea in the direction with the most land, so the spawn circle is not half water. */
  private static inland(game: Game, shore: TileRef, d: number): TileRef {
    const sx = game.x(shore), sy = game.y(shore);
    let best = shore, bestLand = -1;
    for (let a = 0; a < 16; a++) {
      const x = Math.round(sx + Math.cos((a / 16) * Math.PI * 2) * d), y = Math.round(sy + Math.sin((a / 16) * Math.PI * 2) * d);
      if (!game.isValidCoord(x, y)) continue;
      const t = game.ref(x, y);
      if (!game.isLand(t) || game.hasOwner(t)) continue;
      let land = 0;
      for (let dy = -6; dy <= 6; dy += 3) for (let dx = -6; dx <= 6; dx += 3) { if (game.isValidCoord(x + dx, y + dy) && game.isLand(game.ref(x + dx, y + dy))) land++; }
      if (land > bestLand) { bestLand = land; best = t; }
    }
    return best;
  }
  owner(): Player {
    return this.player;
  }
}
