// Diplomacy: alliances (accept, request, renew or let lapse), embargoes, and the reaction to an ended alliance.

import { Difficulty, Player, PlayerType, Relation } from "../../game/Game";
import { assertNever } from "../../Util";
import { AllianceExtensionExecution } from "../alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../alliance/AllianceRequestExecution";
import { DonateTroopsExecution } from "../DonateTroopExecution";
import { BotContext, FireLimiter } from "./Context";
import { Economy } from "./Economy";
import { Military } from "./Military";
import { SituationQueries } from "./Situation";

const PLANNED_TARGET_TTL = 1800; // ticks a lapsed ally stays the planned target with no war opened on it (the sticky-war window)
/** The divisor of DonateTroopExecution.getMinTroopsForRelationUpdate's upper bound per difficulty. */
export function giftDivisor(diff: Difficulty): number {
  switch (diff) {
    case Difficulty.Easy: return 11;
    case Difficulty.Medium: return 9;
    case Difficulty.Hard: return 7;
    case Difficulty.Impossible: return 5;
    default: assertNever(diff);
  }
}

export class Diplomacy {
  private plannedTarget_: Player | null = null; // ally whose alliance we let lapse on purpose
  private plannedLapsedAt = -1; // tick its alliance actually ended (−1 while it still stands)
  private lim: FireLimiter;
  private againstRulesLogged = new Map<Player, number>();

  constructor(
    private ctx: BotContext,
    private q: SituationQueries,
    private military: Military,
    private economy: Economy,
  ) {
    this.lim = new FireLimiter(ctx);
  }

  /** Ally whose alliance we let lapse on purpose (read by Military.fight / maybeBomb). */
  get plannedTarget(): Player | null {
    return this.plannedTarget_;
  }

  // ---------------------------------------------------------------- alliances
  acceptAlliances(): void {
    for (const req of this.ctx.me.incomingAllianceRequests()) {
      const r = req.requestor();
      if (r.type() === PlayerType.Bot) continue;
      if (r === this.military.currentTarget || r === this.plannedTarget_) continue;
      if (this.isPrey(r) || this.annexRefuse(r)) continue;
      req.accept();
    }
  }
  /** No alliance with a player we could annex. `annexWars` widens what counts as annexable (Situation.annexable);
   *  the flag fires when the refusal is one the old rule would not have made. */
  private annexRefuse(o: Player): boolean {
    const a = this.q.annexable(o);
    if (a && this.ctx.p.annexWars && this.q.annexableChanged(o)) this.lim.fire("annexWars", "refuse");
    return a;
  }
  /** A weaker neighbour is food: with two or more neighbours we keep the weakest one unallied so the army has somewhere to go. */
  private isPrey(o: Player): boolean {
    const me = this.ctx.me;
    // Crown, not survival: the single weakest neighbour is never allied when we can take it (2× its army within our
    // share), from 30 s on — an alliance made at 1:00 otherwise locks the whole mid game until 11:00.
    if (this.ctx.mg.ticks() < 300) return false;
    if (o.troops() < me.troops() * 0.5 && this.ctx.mg.ticks() >= 1200) return true;
    const all = [...this.q.neighbours().rivals, ...this.q.neighbours().friends].filter((p) => p.type() !== PlayerType.Bot);
    if (all.length < 2) return false;
    const weakest = this.preyPick(all);
    return o === weakest && o.troops() * 2 < me.troops() * this.ctx.p.fightMaxShare && o.numTilesOwned() <= me.numTilesOwned() * 1.5;
  }
  /** The weakest non-bot neighbour — with `relationAware`, among those within 1.15× of the weakest's troops, the nation
   *  whose relation to us is highest: a lapsed ally (still Friendly / Neutral) drops to Distrustful on the first hit,
   *  a never-allied nation at 0 goes Hostile (−70 on Medium) and hunts us at up to 3× its troops (`hated`). */
  private preyPick(all: Player[]): Player {
    const weakest = all.reduce((a, b) => (b.troops() < a.troops() ? b : a));
    if (!this.ctx.p.relationAware) return weakest;
    const me = this.ctx.me;
    const rel = (p: Player) => (p.type() === PlayerType.Nation ? p.relation(me) : Relation.Hostile); // humans: no relation to prefer
    let best = weakest;
    for (const p of all) if (p.troops() <= weakest.troops() * 1.15 && (rel(p) > rel(best) || (rel(p) === rel(best) && p.troops() < best.troops()))) best = p;
    if (best !== weakest) this.lim.fire("relationAware", "prey");
    return best;
  }

  requestAlliances(): void {
    const me = this.ctx.me;
    const { rivals } = this.q.neighbours();
    rivals.sort((a, b) => b.troops() - a.troops());
    for (const o of rivals) {
      if (o === this.military.currentTarget || o === this.plannedTarget_) continue;
      if (this.isPrey(o) || this.annexRefuse(o)) continue; // an ally can never be annexed
      if (!me.canSendAllianceRequest(o)) continue;
      // `relationAware`: ask a nation only when its own decision rules would say yes (Rivals.wouldAcceptAlliance) —
      // a refusal we asked for is not a signal, and the trust dock for it (Rivals.onRequestRefused) counted our spam
      if (this.ctx.p.relationAware && !this.q.rivals.wouldAcceptAlliance(o)) {
        this.lim.fire("relationAware", "request");
        if (this.ctx.mg.ticks() - (this.againstRulesLogged.get(o) ?? -1e9) >= 1800) { this.againstRulesLogged.set(o, this.ctx.mg.ticks()); this.ctx.log(`t${this.ctx.mg.ticks()} no alliance request to ${o.name()}: its rules would refuse (relation ${Relation[o.relation(me)]}, ${o.alliances().length} alliances)`); }
        continue;
      }
      this.ctx.mg.addExecution(new AllianceRequestExecution(me, o.id()));
    }
  }

  /** What was already done for the alliance with each ally in its current renewal window (keyed by its expiry: a
   *  renewed alliance starts over). Runs every 50 ticks inside the 300-tick window, so a gift the donation
   *  cooldown or the ally's full cap refused on one pass is tried again on the next. */
  private expiryState = new Map<Player, { expiresAt: number; gifted: boolean; extended: boolean }>();
  /** 30 s before an alliance ends: renew it unless the ally has become prey we can take, in which case let it lapse and queue the attack. */
  manageExpiries(): void {
    const me = this.ctx.me;
    const offset = this.ctx.mg.config().allianceExtensionPromptOffset();
    for (const [p, st] of this.expiryState) if (!p.isAlive() || me.allianceWith(p)?.expiresAt() !== st.expiresAt) this.expiryState.delete(p);
    for (const al of me.alliances()) {
      const other = al.other(me);
      const left = al.expiresAt() - this.ctx.mg.ticks();
      if (left > offset || left < 0) continue;
      if (this.plannedTarget_ === other) continue; // decided on an earlier pass: it lapses
      let st = this.expiryState.get(other);
      if (!st) { st = { expiresAt: al.expiresAt(), gifted: false, extended: false }; this.expiryState.set(other, st); }
      const { rivals, friends } = this.q.neighbours();
      let prey = (friends.includes(other) && other.troops() < me.troops() * 0.4 && me.troops() > this.q.cap() * this.ctx.p.fightAbove && rivals.length <= 1) || this.q.annexable(other) || (this.ctx.p.endgameV2 && this.ctx.mg.ticks() >= 9000 && other.troops() < me.troops() * 0.5 && other.numTilesOwned() < me.numTilesOwned());
      if (prey && this.ctx.p.annexWars && this.q.annexableChanged(other)) this.lim.fire("annexWars", "lapse");
      // `lapseToAttack`: the ally is the best war the army could have — the scorer takes it as if it were unfriendly and
      // it beats every unfriendly candidate — so it lapses whatever the number of rivals; not while a stronger
      // unfriendly neighbour (> 0.6× our troops) borders us, unless the ally is annexable (a war it cannot answer)
      let lapseScore: number | null = null;
      if (!prey && this.ctx.p.lapseToAttack) {
        const w = this.military.wouldTarget(other);
        if (w.ok) {
          let bestRival = 0;
          for (const r of rivals) { const s = this.military.wouldTarget(r); if (s.ok && s.score > bestRival) bestRival = s.score; }
          const stronger = rivals.some((r) => r.troops() > me.troops() * 0.6);
          if (w.score > bestRival && (!stronger || this.q.annexable(other))) { prey = true; lapseScore = w.score; }
        }
      }
      // A Hard nation renews only if we are as strong as it, a threat to it, or on friendly terms.
      // A gift over DonateTroopExecution's random minimum (maxTroops / [13, 11) Easy, / [11, 9) Medium, / [9, 7) Hard,
      // / [7, 5) Impossible) makes it friendly (+50): cheap insurance when we are the weaker side. The gift is the
      // upper bound of that range + 1000, so it always clears the roll (a flat / 7 fell under Impossible's roll and
      // overpaid on Easy and Medium).
      // C1 (`nationAware`): "weaker side" = its own attack rules would let it hit us at expiry, not the 0.9× heuristic.
      const weakerSide = this.ctx.p.nationAware ? this.q.rivals.couldAttackAtExpiry(other, me.troops()).can : me.troops() < other.troops() * 0.9;
      if (this.ctx.p.nationAware && weakerSide !== me.troops() < other.troops() * 0.9) this.ctx.fire("nationAware");
      if (!prey && !st.gifted && other.type() === PlayerType.Nation && weakerSide && me.canDonateTroops(other)) {
        const gift = Math.ceil(this.ctx.mg.config().maxTroops(other) / giftDivisor(this.ctx.mg.config().gameConfig().difficulty)) + 1000;
        if (gift < me.troops() * 0.3 && gift <= this.ctx.mg.config().maxTroops(other) - other.troops()) {
          this.ctx.mg.addExecution(new DonateTroopsExecution(me, other.id(), gift));
          this.ctx.log(`t${this.ctx.mg.ticks()} gift ${Math.round(gift / 1000)}k troops to ${other.name()} before renewal`);
          st.gifted = true;
        }
      }
      if (prey) {
        if (this.plannedTarget_ !== other) this.plannedLapsedAt = -1;
        this.plannedTarget_ = other;
        if (lapseScore !== null) { this.ctx.fire("lapseToAttack"); this.ctx.log(`t${this.ctx.mg.ticks()} let alliance lapse to attack ${other.name()} (score ${lapseScore.toFixed(1)}, ${Math.round(other.troops() / 1000)}k vs our ${Math.round(me.troops() / 1000)}k)`); }
        else this.ctx.log(`t${this.ctx.mg.ticks()} let alliance with ${other.name()} lapse (${Math.round(other.troops() / 1000)}k vs our ${Math.round(me.troops() / 1000)}k)`);
        continue;
      }
      if (!st.extended) { this.ctx.mg.addExecution(new AllianceExtensionExecution(me, other.id())); st.extended = true; }
    }
    this.forgetPlannedTarget();
  }
  /** The planned target is forgotten when it is dead, allied again, or when its alliance has lapsed for
   *  PLANNED_TARGET_TTL ticks without a war on it and it is not the current target: the mark used to last the
   *  target's whole life, refusing every later alliance with it and feeding it to the bomb list with no war on. */
  private forgetPlannedTarget(): void {
    const t = this.plannedTarget_;
    if (t === null) return;
    const me = this.ctx.me, now = this.ctx.mg.ticks();
    if (!t.isAlive()) { this.plannedTarget_ = null; this.plannedLapsedAt = -1; return; }
    if (this.plannedLapsedAt < 0) return; // the alliance still stands (onAllianceEnded stamps the lapse)
    if (me.isFriendly(t)) { this.plannedTarget_ = null; this.plannedLapsedAt = -1; return; } // allied again after the lapse
    if (t === this.military.currentTarget || this.q.outgoingTo(t) !== undefined) return;
    if (now - this.plannedLapsedAt >= PLANNED_TARGET_TTL) { this.ctx.log(`t${now} planned target ${t.name()} dropped: no war on it ${Math.round(PLANNED_TARGET_TTL / 600)} min after the lapse`); this.plannedTarget_ = null; this.plannedLapsedAt = -1; }
  }
  /** Trade feeds whoever you trade with: embargo anyone attacking us or targeted by us; lift it when we ally. */
  manageEmbargoes(): void {
    const me = this.ctx.me;
    // Embargoes cost 20 relation with nations, so they are reserved for the player we are actually at war with — or
    // who is at war with us: the engine's own embargo on an attacker (AttackExecution, temporary) is left standing
    // while the attack runs; it used to be lifted after tick 1200 like one of ours.
    for (const e of me.getEmbargoes()) {
      const atWarWith = e.target === this.military.currentTarget && this.q.outgoingTo(e.target) !== undefined;
      const attackingUs = me.incomingAttacks().some((a) => a.attacker() === e.target);
      if (me.isFriendly(e.target) || !e.target.isAlive() || (!atWarWith && !attackingUs && this.ctx.mg.ticks() - (this.military.embargoedAt.get(e.target) ?? 0) > 1200)) me.stopEmbargo(e.target);
    }
  }

  /** An alliance ended (expired or broken): bring the army home, mark the post, and treat them as the threat. */
  onAllianceEnded(p: Player): void {
    const me = this.ctx.me;
    if (me.isFriendly(p)) return;
    if (p === this.plannedTarget_) this.plannedLapsedAt = this.ctx.sit.tick;
    this.ctx.log(`t${this.ctx.sit.tick} ALLIANCE ENDED ${p.name()} ${Math.round(p.troops() / 1000)}k vs our ${Math.round(this.ctx.sit.troops / 1000)}k`);
    // if they are stronger, every tribe wave comes home now — the nation attacks within seconds of a lapse
    if (p.troops() > this.ctx.sit.troops * 0.8) {
      for (const a of this.ctx.sit.outgoing) { const t = a.target(); if (t.isPlayer() && (t as Player).type() === PlayerType.Bot) this.military.retreat(a); }
    }
    this.economy.postFailed.delete(p);
  }
}
