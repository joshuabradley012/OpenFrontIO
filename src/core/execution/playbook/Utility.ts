// Utility scoring (review opportunity #3, flag `utility`): one currency for every way troops can leave home.
//
// The rule table is a Dill-style priority list without the weight layer: expand → tribes → wars run in that order on
// one shared spendable, so a 10 % expand click can starve a whole-or-nothing war and no rule can compare a tribe at
// 1.67× against free land at 16–24 troops/tile against a war the estimator likes. Here every option is scored as
// expected tiles per troop over the phase horizon × a product of curved considerations (Mark, "Building a Better
// Centaur", GDC 2015), the product compensated for its length so a five-consideration option is not punished for
// having been thought about harder; invariants stay as rank buckets (Dill, "Dual-Utility Reasoning", Game AI Pro 2):
// rank 0 = counter / hold, rank 1 = opportunity (collapsed / gap owner / MIRV threat / drained), rank 2 = normal.
// Pure: no game objects are read here, so the curves are unit-tested on plain numbers.

import { Player } from "../../game/Game";

export type OptionKind = "counter" | "expand" | "tribe" | "war" | "boat";
export type Rank = 0 | 1 | 2;

export interface Option {
  kind: OptionKind;
  target: Player | null; // null = terra nullius
  troops: number; // the wave this option would send
  rank: Rank;
  weight: number; // tiles per troop × compensated considerations (the same currency for every kind)
  why: string; // for the UTIL log
}

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

/** 0 at `lo`, 1 at `hi`, straight between (works with lo > hi too). */
export function linear(x: number, lo = 0, hi = 1): number {
  if (lo === hi) return x >= hi ? 1 : 0;
  return clamp((x - lo) / (hi - lo));
}

/** 0.5 at `mid`; `steepness` = the slope at the midpoint × 4 (10 = a clear step over ±0.2). */
export function logistic(x: number, mid: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (x - mid)));
}

/** linear squared: slow to start, then fast — a consideration that only matters near `hi`. */
export function quadratic(x: number, lo = 0, hi = 1): number {
  const l = linear(x, lo, hi);
  return l * l;
}

/** Dave Mark's compensation factor: the product of n considerations in [0, 1] falls with n even when every factor is
 *  good, so each factor is lifted toward 1 by (1 − 1/n) of its distance before multiplying. compensate([0.9, 0.9])
 *  = 0.9025 instead of 0.81; a zero stays a zero. */
export function compensate(considerations: number[]): number {
  const n = considerations.length;
  if (n === 0) return 1;
  const mod = 1 - 1 / n;
  let out = 1;
  for (const c0 of considerations) {
    const c = clamp(c0);
    out *= c + (1 - c) * mod * c;
  }
  return out;
}

/** Dill: the highest rank (lowest bucket number) wins; weight decides inside a bucket; the insertion order breaks
 *  ties (stable sort), so the caller lists options in the rule table's order and a tie keeps today's decision. */
export function rankOptions(options: Option[]): Option[] {
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.rank - b.o.rank || b.o.weight - a.o.weight || a.i - b.i)
    .map((x) => x.o);
}

export function describeOption(o: Option): string {
  return `${o.kind}${o.target ? " " + o.target.name() : ""} ${Math.round(o.troops / 1000)}k r${o.rank} w${o.weight.toFixed(4)} (${o.why})`;
}
