// Campaign (review opportunity #6, flag `campaigns`): the war plan for one target.
//
// Vox Populi's AI picks a target, then spends a few turns in a "war face" — reserves, builds on that border — and
// declares when the projection is favourable. PlaybookBot's equivalents were spread over four modules that could not
// see they belonged together (plannedTarget in Diplomacy, threat posts in Economy, the expiry hold in readSituation,
// the wave in fight()). This is the one small object that ties them: not a planner, a phase machine with abort
// conditions. Military owns it (Military.campaign*), Economy and Diplomacy read `Military.prepTarget`, send() reads
// `Military.escrow`. Pure: every game fact arrives as a CampaignFacts value, so the machine is unit-testable.

import { Player } from "../../game/Game";

export type CampaignPhase = "prepare" | "wave" | "followup" | "consolidate";

export const PREP_CAP = 900; // ticks after which prepare stops delaying (the wave fires whenever affordable, as without the flag)
export const POST_WAIT = 300; // ticks prepare waits for a threat post on the target's border before going without one
export const ALLY_EXPIRY_MIN = 450; // an alliance of ours with one of the target's allies must be at least this far from expiry (readSituation's `expiring` window)
export const LOW_RATIO_TICKS = 300; // ratio under fightRatio × LOW_RATIO for this long aborts the plan
export const LOW_RATIO = 0.8;
export const CONSOLIDATE_TICKS = 600; // cooldown after a fought war before the next campaign opens
export const ABORT_UNDER_ATTACK_TICKS = 300; // cooldown after an abort for a big incoming attack (the counter has the army); other aborts end at once
export const RETARGET_AFTER = 300; // a prepare younger than this refuses a different pick instead of restarting on it (the smoke: two targets with close scores swapped every pass)
export const WAVE_GONE_TICKS = 100; // follow-up phase ends this long after our last attack on the target is gone

/** What the machine needs to know this tick (Military fills it from the situation). */
export interface CampaignFacts {
  tick: number;
  affordable: boolean; // send() would take the whole wave now (room ≥ want)
  allyExpiryOK: boolean; // no alliance of ours with one of the target's allies expires within ALLY_EXPIRY_MIN (or the target has no such ally)
  postFacing: boolean; // a defence post of ours faces the target
  opportunity: boolean; // the target is drained / collapsed now: the window is open
  targetAlive: boolean;
  targetFriendly: boolean; // the target became our ally: never attack an ally
  bigIncoming: boolean; // a non-bot attack on us above 15 % of our troops
  targetAlliedWithOurAlly: boolean;
  ratio: number; // the planned wave over the target's troops now
  attacking: boolean; // one of our attacks on the target is running
}

export class Campaign {
  phase: CampaignPhase = "prepare";
  readonly since: number;
  /** The tick prepare stops delaying at (the cap); the actual go tick is the earliest of the conditions in ready()). */
  readonly prepUntil: number;
  wavesSent = 0;
  readonly log: string[] = [];
  private lowSince = -1;
  private lastAttackSeen = -1;
  private endsAt = -1; // consolidate: the cooldown's end

  constructor(
    readonly target: Player,
    /** The planned wave (troops). */
    public want: number,
    tick: number,
  ) {
    this.since = tick;
    this.prepUntil = tick + PREP_CAP;
    this.note(tick, `prepare ${target.name()} wave ${Math.round(want / 1000)}k, cap t${this.prepUntil}`);
  }

  private note(tick: number, line: string): void {
    this.log.push(`t${tick} CAMPAIGN ${line}`);
  }
  /** Lines added since the last call (Military copies them into the bot log). */
  drain(): string[] {
    return this.log.splice(0);
  }
  get done(): boolean {
    return this.phase === "consolidate" && this.endsAt >= 0 && this.endsAt <= this.lastTick;
  }
  private lastTick = -1;

  /** prepare → wave: is it time? The earliest of: affordable and timed (the target's allies' alliances with us not
   *  about to lapse, a post facing the target or POST_WAIT ticks gone), the target's drained /
   *  collapse window opening, or the cap (prepUntil) — after which only affordability gates the wave. */
  ready(f: CampaignFacts): { go: boolean; why: string } {
    if (!f.affordable) return { go: false, why: "wave not affordable" };
    if (f.opportunity) return { go: true, why: "the target's window is open" };
    if (f.tick >= this.prepUntil) return { go: true, why: "prepare cap" };
    if (!f.allyExpiryOK) return { go: false, why: "an ally of the target is about to be free of us" };
    if (!f.postFacing && f.tick - this.since < POST_WAIT) return { go: false, why: "waiting for the post" };
    return { go: true, why: f.postFacing ? "affordable, post in place" : "affordable, no post" };
  }

  /** Why the plan is off, or null. Checked in every phase but consolidate. */
  abortReason(f: CampaignFacts, fightRatio: number): string | null {
    if (!f.targetAlive) return null; // a dead target is a win, not an abort (advance() consolidates)
    if (f.targetFriendly) return "the target is our ally now";
    if (this.phase === "prepare" && f.tick >= this.prepUntil + CONSOLIDATE_TICKS) return "prepare timed out"; // the war rule stopped picking it (not affordable, out of reach)
    if (f.bigIncoming) return "we are under a large attack";
    if (f.targetAlliedWithOurAlly) return "the target allied with our ally";
    if (f.ratio < fightRatio * LOW_RATIO) {
      if (this.lowSince < 0) this.lowSince = f.tick;
      if (f.tick - this.lowSince >= LOW_RATIO_TICKS) return `ratio ${f.ratio.toFixed(2)} under ${(fightRatio * LOW_RATIO).toFixed(2)} for ${LOW_RATIO_TICKS} ticks`;
    } else this.lowSince = -1;
    return null;
  }

  /** The wave (or a follow-up) went out. */
  onWave(tick: number, sent: number): void {
    this.wavesSent++;
    this.lastAttackSeen = tick;
    if (this.phase === "prepare") { this.phase = "wave"; this.note(tick, `wave ${this.target.name()} ${Math.round(sent / 1000)}k after ${tick - this.since} ticks of prepare`); }
    else if (this.phase === "followup") this.note(tick, `follow-up ${this.wavesSent} on ${this.target.name()} ${Math.round(sent / 1000)}k`);
  }

  /** Phase bookkeeping every pass: wave → followup once the attack runs; followup → consolidate when the target is dead
   *  or our attack has been gone WAVE_GONE_TICKS; abort → consolidate. Returns true when the phase changed. */
  advance(f: CampaignFacts, fightRatio: number): boolean {
    this.lastTick = f.tick;
    if (this.phase === "consolidate") return false;
    const reason = this.abortReason(f, fightRatio);
    if (reason !== null) { this.end(f.tick, `abort ${this.target.name()} (${reason})`, f.bigIncoming ? ABORT_UNDER_ATTACK_TICKS : 0); return true; }
    if (f.attacking) this.lastAttackSeen = f.tick;
    if (this.phase === "wave" && f.attacking) { this.phase = "followup"; this.note(f.tick, `followup ${this.target.name()}: the wave is in`); return true; }
    if ((this.phase === "wave" || this.phase === "followup") && !f.targetAlive) { this.end(f.tick, `won ${this.target.name()} after ${this.wavesSent} waves`); return true; }
    if (this.phase === "followup" && !f.attacking && f.tick - this.lastAttackSeen >= WAVE_GONE_TICKS) { this.end(f.tick, `consolidate ${this.target.name()}: the war is over after ${this.wavesSent} waves`); return true; }
    return false;
  }
  private end(tick: number, line: string, cooldown = CONSOLIDATE_TICKS): void {
    this.phase = "consolidate";
    this.endsAt = tick + cooldown;
    this.note(tick, cooldown > 0 ? `${line}; cooldown until t${this.endsAt}` : line);
  }
}
