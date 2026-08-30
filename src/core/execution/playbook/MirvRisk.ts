// MirvRisk: the nations' three MIRV rules (NationMIRVBehavior.considerMIRV) evaluated against US, exactly as a
// nation would — counter-MIRV (one of ours inbound at it), victory denial (our share of the land), steamroll (our
// city units vs the runner-up) — plus who on the map could actually fire one (silo and the live MIRV price, or a
// MIRV already built). Always-on diagnostics: `MIRV RISK <rule>: <numbers>` on every change of the risk state,
// `MIRVED by <name> (<rule>, <n>th)` once per enemy MIRV aimed at our land, and the `mirvsTaken` counter.
// The `nationMirvAware` guards in Military and Economy read the same evaluation.

import { Difficulty, Player, PlayerType, UnitType } from "../../game/Game";
import { assertNever } from "../../Util";
import { BotContext } from "./Context";

/** NationMIRVBehavior's per-difficulty thresholds. */
export function mirvRules(diff: Difficulty): { denial: number; denialTeam: number; mult: number; minLeader: number } {
  switch (diff) {
    case Difficulty.Easy: return { denial: 0.75, denialTeam: 0.9, mult: 2, minLeader: 20 };
    case Difficulty.Medium: return { denial: 0.65, denialTeam: 0.8, mult: 1.5, minLeader: 10 };
    case Difficulty.Hard: return { denial: 0.55, denialTeam: 0.7, mult: 1.25, minLeader: 10 };
    case Difficulty.Impossible: return { denial: 0.4, denialTeam: 0.6, mult: 1.15, minLeader: 8 };
    default: assertNever(diff);
  }
}

export interface SteamrollView {
  /** Our city units as the rule counts them: Player.unitCount(City), which SUMS LEVELS (a level-3 city is 3). */
  units: number;
  /** The runner-up's city units among the other living players (tribes included, as the rule ranks them). */
  second: number;
  /** mult × second: the rule fires at units ≥ threshold (and units > minLeader). */
  threshold: number;
  minLeader: number;
  /** The rule is true right now. */
  over: boolean;
  /** `nationMirvAware`: units ≥ 0.9 × threshold and > minLeader − 1 — one more captured city may put us over. */
  near: boolean;
}

export interface MirvRiskView {
  steamroll: SteamrollView;
  /** Our share of the land vs the individual (or team) threshold. */
  denial: { share: number; threshold: number; over: boolean };
  /** The owner of the land one of our MIRVs is aimed at, or null. */
  counter: Player | null;
  /** Nations that could fire now: a silo and the live MIRV price, or a MIRV already built (NationMIRVBehavior's own gates). */
  canFire: Player[];
  /** Nations with a silo and at least half the live price: a nation fires the tick it reaches the price (30-min
   *  africa smoke: `MIRV RISK … 1 nation can fire` at t7800, `MIRVED` at t7810), so a guard that waits for `canFire`
   *  is too late — the `nationMirvAware` guards start while a nation saves. */
  saving: Player[];
}

export class MirvRisk {
  private lastKey = "----";
  private seen = new Set<number>();
  private taken = 0;
  private cache: { tick: number; view: MirvRiskView } | null = null;

  constructor(private ctx: BotContext) {}

  /** Enemy MIRVs seen aimed at our land this game (the lab's `mirvsTaken=`). */
  get mirvsTaken(): number {
    return this.taken;
  }

  /** Can `p` answer a MIRV with one of its own (the gates considerMIRV runs before any rule)? */
  canCounter(p: Player): boolean {
    if (p.units(UnitType.MissileSilo).length === 0) return false;
    if (p.units(UnitType.MIRV).length > 0) return true;
    return p.gold() >= this.ctx.mg.config().unitInfo(UnitType.MIRV).cost(this.ctx.mg, p);
  }

  /** The three rules against us, once per tick. */
  view(): MirvRiskView {
    const t = this.ctx.mg.ticks();
    if (this.cache !== null && this.cache.tick === t) return this.cache.view;
    const canFire = this.whoCanFire();
    const view = { steamroll: this.steamroll(), denial: this.denial(), counter: this.counter(), canFire, saving: this.whoIsSaving(canFire) };
    this.cache = { tick: t, view };
    return view;
  }
  /** `nationMirvAware`: a nation can fire, or is within half the price of it — the guards' gate. */
  armed(): boolean {
    const v = this.view();
    return v.canFire.length > 0 || v.saving.length > 0;
  }

  /** selectSteamrollStopTarget with us as the leader; `extraUnits` captured from `without` (a war target) — its
   *  units join ours and it leaves the ranking. */
  steamroll(extraUnits = 0, without: Player | null = null): SteamrollView {
    const me = this.ctx.me, mg = this.ctx.mg;
    const { mult, minLeader } = mirvRules(mg.config().gameConfig().difficulty);
    let second = 0;
    for (const p of mg.players()) { if (p === me || p === without || !p.isPlayer()) continue; second = Math.max(second, p.unitCount(UnitType.City)); }
    const units = me.unitCount(UnitType.City) + extraUnits;
    const threshold = second * mult;
    return { units, second, threshold, minLeader, over: units > minLeader && units >= threshold, near: units > minLeader - 1 && units >= threshold * 0.9 };
  }

  /** selectVictoryDenialTarget with us as the candidate; `extraTiles` a war target's land. */
  denial(extraTiles = 0): { share: number; threshold: number; over: boolean } {
    const me = this.ctx.me, mg = this.ctx.mg;
    const rules = mirvRules(mg.config().gameConfig().difficulty);
    const total = Math.max(1, mg.numLandTiles());
    const team = me.team();
    if (team !== null) {
      const members = mg.players().filter((x) => x.team() === team && x.isPlayer());
      const teamTiles = members.reduce((a, b) => a + b.numTilesOwned(), 0) + extraTiles;
      const largest = members.every((m) => m === me || m.numTilesOwned() <= me.numTilesOwned() + extraTiles);
      const share = teamTiles / total;
      return { share, threshold: rules.denialTeam, over: largest && share >= rules.denialTeam };
    }
    const share = (me.numTilesOwned() + extraTiles) / total;
    return { share, threshold: rules.denial, over: share >= rules.denial };
  }

  private counter(): Player | null {
    const me = this.ctx.me, mg = this.ctx.mg;
    for (const m of me.units(UnitType.MIRV)) {
      const dst = m.targetTile();
      if (dst === undefined || !mg.hasOwner(dst)) continue;
      const o = mg.owner(dst);
      if (o.isPlayer() && o !== me) return o;
    }
    return null;
  }

  private whoCanFire(): Player[] {
    const me = this.ctx.me, mg = this.ctx.mg;
    if (mg.config().isUnitDisabled(UnitType.MIRV)) return [];
    return mg.players().filter((p) => p !== me && p.type() === PlayerType.Nation && !me.isOnSameTeam(p) && this.canCounter(p));
  }

  private whoIsSaving(canFire: Player[]): Player[] {
    const me = this.ctx.me, mg = this.ctx.mg;
    if (mg.config().isUnitDisabled(UnitType.MIRV)) return [];
    const info = mg.config().unitInfo(UnitType.MIRV);
    return mg.players().filter((p) => p !== me && p.type() === PlayerType.Nation && !me.isOnSameTeam(p) && !canFire.includes(p) && p.units(UnitType.MissileSilo).length > 0 && p.gold() * 2n >= info.cost(mg, p));
  }

  /** Every 100 ticks: log the risk state when it changes. */
  check(): void {
    const v = this.view();
    const key = `${v.steamroll.over ? "s" : "-"}${v.denial.over ? "d" : "-"}${v.counter ? "c" : "-"}${v.canFire.length > 0 ? "f" : v.saving.length > 0 ? "v" : "-"}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const t = this.ctx.mg.ticks();
    const names = (ps: Player[]) => ps.map((p) => p.name()).join(", ");
    const fire = (v.canFire.length > 0 ? `${v.canFire.length} nation${v.canFire.length === 1 ? "" : "s"} can fire (${names(v.canFire)})` : "nobody can fire") + (v.saving.length > 0 ? `, ${v.saving.length} saving (${names(v.saving)})` : "");
    if (!v.steamroll.over && !v.denial.over && v.counter === null) { this.ctx.log(`t${t} MIRV RISK clear: ${fire}`); return; }
    if (v.steamroll.over) this.ctx.log(`t${t} MIRV RISK steamroll: ${v.steamroll.units} city units (levels) vs ${this.fmt(v.steamroll.threshold)} (${v.steamroll.second} × ${mirvRules(this.ctx.mg.config().gameConfig().difficulty).mult}, leader > ${v.steamroll.minLeader}) — ${fire}`);
    if (v.denial.over) this.ctx.log(`t${t} MIRV RISK denial: share ${(v.denial.share * 100).toFixed(1)} % vs ${(v.denial.threshold * 100).toFixed(0)} % — ${fire}`);
    if (v.counter !== null) this.ctx.log(`t${t} MIRV RISK counter: our MIRV is inbound at ${v.counter.name()} — ${fire}`);
  }

  /** Every 10 ticks: an enemy MIRV aimed at a tile we own, once per unit. */
  scan(): void {
    const me = this.ctx.me, mg = this.ctx.mg;
    for (const m of mg.units(UnitType.MIRV)) {
      if (m.owner() === me || this.seen.has(m.id())) continue;
      const dst = m.targetTile();
      if (dst === undefined || !mg.hasOwner(dst) || mg.owner(dst) !== me) continue;
      this.seen.add(m.id());
      this.taken++;
      const v = this.view();
      const rule = v.counter === m.owner() ? "counter" : v.denial.over ? "denial" : v.steamroll.over ? "steamroll" : m.owner().type() === PlayerType.Nation ? "no rule true" : "human";
      this.ctx.log(`t${mg.ticks()} MIRVED by ${m.owner().name()} (${rule}, ${this.nth(this.taken)})`);
    }
  }

  private nth(n: number): string {
    const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
    return `${n}${s}`;
  }
  private fmt(x: number): string {
    return Number.isInteger(x) ? String(x) : x.toFixed(1);
  }
}
