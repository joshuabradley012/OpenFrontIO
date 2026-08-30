// Shared context handed to every PlaybookBot module: the game, the player, the params, this tick's
// situation, the PRNG, and the three primitives the loop owns (send, boat, log).

import { Game, Player } from "../../game/Game";
import { TileRef } from "../../game/GameMap";
import { PseudoRandom } from "../../PseudoRandom";
import { PlaybookParams } from "./Params";
import { Situation } from "./Situation";

export interface BotContext {
  mg: Game;
  me: Player;
  p: PlaybookParams;
  sit: Situation;
  random: PseudoRandom;
  send(targetID: string | null, n: number, why: string, min?: number, capFloor?: number): number;
  boat(tile: TileRef, n: number, why: string): number;
  log(line: string): void; // enforces the 2000 cap
  /** A flagged branch changed a decision vs the flag being off; counts land in the lab's FINAL `fired=` field. */
  fire(flag: string): void;
  /** `boatsAfterCoast`: a rule is being dry-run to see whether it would have launched — boat() reports a launch
   *  without making one, fire() and the FireLimiter count nothing, and rules keep their own bookkeeping untouched. */
  dry: boolean;
}

/** `ctx.fire` rate-limited to one count per `every` ticks per site (ground rule 2: a flag that changes the same
 *  decision every tick should not swamp the lab's liveness counter). */
export class FireLimiter {
  private at = new Map<string, number>();
  constructor(private ctx: BotContext) {}
  fire(flag: string, site: string, every = 100): void {
    if (this.ctx.dry) return;
    const t = this.ctx.mg.ticks(), k = `${flag}/${site}`;
    if (t - (this.at.get(k) ?? -1e9) < every) return;
    this.at.set(k, t);
    this.ctx.fire(flag);
  }
}
