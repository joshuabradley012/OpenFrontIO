// BuildSearch: a BOSS-style fast-forward build-order search for the economy (flag `buildSearch`, plan package #7).
//
// Churchill & Buro's BOSS (AIIDE 2011) searches build orders by fast-forwarding to the tick the next purchase is
// affordable — no idle actions, so a plan is a list of (kind, tick) and the tree is small. This module is the pure
// planner: plain numbers in, a plan out, no game objects, so tests feed it fixed states and the bot's tile pickers
// stay where they are (Economy.ts). The income/cap models and their constants are Spend.ts's (last at 95f4b634a):
// each carries the lab number it encodes and scoredSpend lost only because a one-step value cannot express
// "save 2000 gold for a port" — which is exactly what a horizon search can.
//
// Objective at the horizon: gold + troops × CAP_GOLD_PER_TROOP + the gold-equivalent worth of the defensive buys
// (posts, silos, SAMs: threat-gated constants). Gold counts 1:1, so a port pays only through what it buys inside
// the horizon (compounding is inside the tree, not in the leaf) and cap pays only as far as regen fills it.

import { Phase } from "./Situation";

export type BuildKind = "city" | "cityLevel" | "port" | "portLevel" | "factory" | "post" | "silo" | "sam";

/** The economy as the planner sees it. Gold and rates are plain numbers (gold per tick). */
export interface EconState {
  tick: number;
  gold: number;
  goldRate: number; // observed income per tick (base + trade + rail)
  troops: number;
  cap: number;
  cityUnits: number;
  cityLevels: number;
  portUnits: number;
  portLevels: number;
  factories: number;
  posts: number;
  silos: number;
  sams: number;
  seaShips: number; // trade ships on the map
  hasPartner: boolean; // a foreign port on shared water
  threatened: boolean; // a rival ≥ half our troops on the border, an incoming attack, or an enemy silo
}

/** What the planner needs from the engine, passed in so the module stays pure. */
export interface EconModel {
  /** Price of the next unit of `kind`'s cost family after `extraUnits` more of that family (the engine's unitInfo().cost extraUnits). */
  cost(kind: BuildKind, extraUnits: number): number;
  capPerLevel: number; // config.cityTroopIncrease() × the player's difficulty multiplier (a Human bot: 1)
  shipGold: number; // config.tradeShipGold at a typical lane
  seaFullShips: number; // params.seaFullShips
  selfStopGold: number; // config.trainGold("self", …)
  trainSpawnRate(factories: number): number;
  railStops: number; // our stations a new line would serve (cities within station range of the factory)
  maxCityUnits: number; // Economy.cityUnitCap(): stay under the nations' MIRV line
  maxPortUnits: number; // params.maxPortUnits
  portLevelBeforeSecond: number; // params.portLevelBeforeSecond
  enemySilos: boolean;
  rank: number; // land rank among non-bots (99 = unknown)
  idleAtCap: boolean;
  regenScale: number; // Config.troopIncreaseRate's player multiplier (Human 1, Medium nation 0.95, Bot 0.5)
  capGoldPerTroop?: number; // params.buildCapGoldPerTroop (CAP_GOLD_PER_TROOP when absent)
}

export interface PlanStep {
  kind: BuildKind;
  at: number; // tick the purchase is affordable (the order is placed then)
  cost: number;
}

export interface Plan {
  /** The step to execute now, or null when the plan buys nothing. `first.at > state.tick` means "save". */
  first: PlanStep | null;
  steps: PlanStep[];
  value: number; // objective of the plan at the horizon
  idleValue: number; // objective of buying nothing
  nodes: number; // nodes expanded (≤ budget)
  horizon: number;
}

// ---------------------------------------------------------------- constants (Spend.ts lab numbers)
/** Gold-equivalent of one troop of cap: 20 makes a city's 250k cap worth 5M, ~20 % over a port level's 10-minute
 *  income, so a full army buys cap before a port level and an empty one buys the port (the ports lab as a curve). */
export const CAP_GOLD_PER_TROOP = 20;
/** Trade ships one port level launches per tick on an empty sea (PortExecution rolls 1/100 per level per tick). */
export const SHIPS_PER_TICK_PER_LEVEL = 0.01;
/** Share of the raw lane gold a port actually yields (guide: ~7× base income once nations have ports, against the
 *  raw ~1k/tick the spawn roll implies — captured ships, dead partners, travel time). */
export const TRADE_EFFICIENCY = 0.7;
/** Own port levels at which the marginal level earns half of the first (ports lab: ~1.7k/s per extra level
 *  beyond 40–80 own levels against 80 rival levels). */
export const PORT_HALF_LEVELS = 80;
/** A second port once the first is at portLevelBeforeSecond (reaches other water, survives a captured lane). */
export const NEW_PORT_BONUS = 1.15;
/** A port with no partner in sight earns this share of a partnered one. */
export const NO_PARTNER_SHARE = 0.5;
/** Gold-equivalent of what a silo's bombs win over a phase (a 750k atom takes ~3 structures and their land). */
export const SILO_WORTH = 3_000_000;
/** Gold-equivalent of one city unit under a SAM umbrella; SAM_CITIES per launcher (Economy: one SAM per 8). */
export const SAM_CITY_WORTH = 400_000;
export const SAM_CITIES = 8;
/** Gold-equivalent of a defence post facing a threat (the land and troops a surprise attack would take). */
export const THREAT_POST_WORTH = 400_000;
/** Build times (Config.unitInfo constructionDuration): the purchase pays from tick + wait + duration. */
export const BUILD_TICKS: Record<BuildKind, number> = { city: 20, cityLevel: 0, port: 50, portLevel: 0, factory: 20, post: 50, silo: 100, sam: 300 };
/** Max plan depth; with macros a depth-8 plan already spans a 10-minute horizon. */
export const MAX_DEPTH = 8;
/** Nodes per search (measured: 2000 nodes ≈ 0.3–0.6 ms on a laptop, see tests/playbook/buildSearch.test.ts). */
export const DEFAULT_NODE_BUDGET = 2000;
/** A purchase that lands inside the last MIN_PAYBACK ticks of the horizon cannot pay: not tried. */
const MIN_PAYBACK = 200;

// ---------------------------------------------------------------- horizon
/** Opening and consolidate: a 10-minute block; war: 4000 ticks (a war resolves inside that); endgame: what is
 *  left of the 25:00 clock (guide: nothing bought after 25:00 pays back), at least 1000 and never more than the
 *  opening block (the endgame phase can start at 6:00 when we are top three under an enemy silo). */
export function horizonForPhase(phase: Phase, tick: number, block = 6000): number {
  switch (phase) {
    case "opening":
    case "consolidate":
      return block;
    case "war":
      return Math.min(block, 4000);
    case "endgame":
      return Math.min(block, Math.max(1000, 15000 - tick));
  }
}

// ---------------------------------------------------------------- income and regen models
/** Gold per tick one more port level earns: the spawn roll × lane gold × TRADE_EFFICIENCY, halved on a sea at
 *  seaFullShips (smooth cliff: the ship pool is map-wide) and halved again at PORT_HALF_LEVELS own levels. */
export function portLevelRate(m: EconModel, ownLevels: number, seaShips: number, hasPartner: boolean): number {
  const sea = 1 / (1 + Math.pow(seaShips / Math.max(1, m.seaFullShips), 3));
  const own = PORT_HALF_LEVELS / (PORT_HALF_LEVELS + ownLevels);
  return SHIPS_PER_TICK_PER_LEVEL * m.shipGold * TRADE_EFFICIENCY * sea * own * (hasPartner ? 1 : NO_PARTNER_SHARE);
}
/** Gold per tick one more factory earns: a train every trainSpawnRate ticks paying every own stop on the line. */
export function railRate(m: EconModel, factoriesAfter: number): number {
  if (m.railStops <= 0) return 0;
  return (m.railStops * m.selfStopGold) / Math.max(1, m.trainSpawnRate(factoriesAfter));
}
/** Troop regen per tick at zero fullness: Config.troopIncreaseRate's 10 + troops^0.73 / 4, × the player multiplier. */
export function regenRate(troops: number, regenScale: number): number {
  return (10 + Math.pow(Math.max(0, troops), 0.73) / 4) * regenScale;
}
/** Troops after `dt` ticks under dT/dt = r0 (1 − T/cap): cap − (cap − T0) e^(−r0 dt / cap). One exp per segment
 *  instead of a per-tick loop; r0 is frozen at the segment start (troops move slowly against a 10-minute horizon). */
export function regen(troops: number, cap: number, dt: number, regenScale: number): number {
  if (dt <= 0 || cap <= 0) return Math.min(troops, Math.max(cap, 0));
  if (troops >= cap) return cap;
  const r0 = regenRate(troops, regenScale);
  return cap - (cap - troops) * Math.exp((-r0 * dt) / cap);
}

// ---------------------------------------------------------------- search
interface Node extends EconState {
  worth: number; // gold-equivalent of defensive buys so far
  newCities: number; newPortsOrFactories: number; newPosts: number; newSilos: number; newSams: number; // cost-family counters
  steps: PlanStep[];
}

const KINDS: BuildKind[] = ["city", "cityLevel", "port", "portLevel", "factory", "post", "silo", "sam"];
/** Macro actions: the blocks the chain buys as one (three cities in the opening; the first port levelled to 3 before a
 *  second). A macro lets a shallow depth limit see a deep plan, so each is guarded to its block (`macroAllowed`) —
 *  unguarded, "port then two levels" showed a second port three purchases deep while a plain level saw one. */
const MACROS: BuildKind[][] = [["city", "city", "city"], ["port", "portLevel", "portLevel"]];
function macroAllowed(n: Node, mac: BuildKind[]): boolean {
  return mac[0] === "city" ? n.cityUnits === 0 : n.portUnits === 0;
}

function familyExtra(n: Node, kind: BuildKind): number {
  switch (kind) {
    case "city": case "cityLevel": return n.newCities;
    case "port": case "portLevel": case "factory": return n.newPortsOrFactories;
    case "post": return n.newPosts;
    case "silo": return n.newSilos;
    case "sam": return n.newSams;
  }
}

/** Is `kind` buildable in this state at all (the chain's structural gates, not its clock gates)? */
function allowed(n: Node, m: EconModel, kind: BuildKind): boolean {
  switch (kind) {
    case "city": return n.cityUnits < m.maxCityUnits;
    case "cityLevel": return n.cityUnits >= 1;
    case "port": return n.portUnits < m.maxPortUnits && n.portUnits + n.factories < 40;
    case "portLevel": return n.portUnits >= 1;
    case "factory": return n.cityLevels >= 3 && n.factories < 6;
    case "post": return n.threatened && n.posts < 6;
    case "silo": return n.tick >= 3000 && n.silos < (n.cityUnits >= 25 ? 3 : n.cityUnits >= 14 ? 2 : 1);
    case "sam": return n.sams < Math.max(1, Math.ceil(n.cityUnits / SAM_CITIES)) && (m.enemySilos || m.rank <= 3 || n.tick >= 7200);
  }
}

/** Gold-equivalent a defensive buy adds (Spend.ts siloReturn / samReturn / threatPostReturn, horizon-scaled). */
function worthOf(n: Node, m: EconModel, kind: BuildKind, remaining: number): number {
  switch (kind) {
    case "post": return THREAT_POST_WORTH;
    case "silo": {
      let threat = m.enemySilos ? 1 : 0.3; // calm: only a top-three rank or an idle full army lifts a silo over its price (v8: silos on a clock cost 36 % of land)
      if (m.rank <= 3) threat *= 1.3;
      if (m.idleAtCap) threat *= 1.3;
      const ready = Math.min(1, n.cityUnits / 4) * (n.portLevels >= 1 || n.factories > 0 || m.idleAtCap ? 1 : 0.3);
      return SILO_WORTH * threat * ready * Math.min(1, remaining / 3000);
    }
    case "sam": {
      const threat = m.enemySilos ? 1 : m.rank <= 3 ? 0.7 : n.tick >= 7200 ? 0.35 : 0;
      return Math.min(n.cityUnits, SAM_CITIES) * SAM_CITY_WORTH * threat * Math.min(1, remaining / 2000);
    }
    default: return 0;
  }
}

/** Fast-forward `n` to the tick `kind` is affordable, buy it, let it finish; null when it cannot land inside the horizon. */
function apply(n: Node, m: EconModel, kind: BuildKind, end: number): Node | null {
  const cost = m.cost(kind, familyExtra(n, kind));
  const wait = n.gold >= cost ? 0 : n.goldRate > 0 ? Math.ceil((cost - n.gold) / n.goldRate) : Infinity;
  const dt = wait + BUILD_TICKS[kind];
  const at = n.tick + wait;
  if (n.tick + dt > end - MIN_PAYBACK) return null;
  const c: Node = { ...n, steps: n.steps.concat({ kind, at, cost }) };
  c.gold = n.gold + n.goldRate * dt - cost;
  c.troops = regen(n.troops, n.cap, dt, m.regenScale);
  c.tick = n.tick + dt;
  const remaining = end - c.tick;
  switch (kind) {
    case "city": c.cityUnits++; c.cityLevels++; c.cap += m.capPerLevel; c.newCities++; break;
    case "cityLevel": c.cityLevels++; c.cap += m.capPerLevel; break; // priced like the next unit but not counted as one (costWrapper counts min(levels, constructed))
    case "port": {
      // first port: full rate; the next while the best is under portLevelBeforeSecond: the level curve; past it: NEW_PORT_BONUS
      const best = n.portUnits === 0 ? 0 : Math.max(1, Math.floor(n.portLevels / n.portUnits));
      const curve = n.portUnits === 0 ? 1 : best >= m.portLevelBeforeSecond ? NEW_PORT_BONUS : best / m.portLevelBeforeSecond;
      c.portUnits++; c.portLevels++; c.newPortsOrFactories++;
      c.goldRate += portLevelRate(m, n.portLevels, n.seaShips, n.hasPartner) * curve;
      break;
    }
    case "portLevel": c.portLevels++; c.goldRate += portLevelRate(m, n.portLevels, n.seaShips, n.hasPartner); break;
    case "factory": c.factories++; c.newPortsOrFactories++; c.goldRate += railRate(m, c.factories); break;
    case "post": c.posts++; c.newPosts++; c.worth += worthOf(n, m, kind, remaining); break;
    case "silo": c.silos++; c.newSilos++; c.worth += worthOf(n, m, kind, remaining); break;
    case "sam": c.sams++; c.newSams++; c.worth += worthOf(n, m, kind, remaining); break;
  }
  return c;
}

/** Objective if nothing more is bought: gold and troops fast-forwarded to the horizon, plus the defensive worth. */
function leafValue(n: Node, m: EconModel, end: number): number {
  const rem = Math.max(0, end - n.tick);
  const gold = n.gold + n.goldRate * rem;
  const troops = regen(n.troops, n.cap, rem, m.regenScale);
  return gold + troops * (m.capGoldPerTroop ?? CAP_GOLD_PER_TROOP) + n.worth;
}

/** Iterative-deepening depth-first branch-and-bound over build orders from `state` to `state.tick + horizon`. Children
 *  are ordered by their idle value (greedy first) so the first plans found are good ones and the bound prunes the rest; the bound
 *  is the child's idle value plus `maxGain` per purchase still possible (a purchase never gains more than the best
 *  single return at the root). Stops at `budget` nodes and returns the best plan seen. */
export function search(state: EconState, m: EconModel, horizon: number, budget = DEFAULT_NODE_BUDGET): Plan {
  const end = state.tick + horizon;
  const root: Node = { ...state, worth: 0, newCities: 0, newPortsOrFactories: 0, newPosts: 0, newSilos: 0, newSams: 0, steps: [] };
  const idleValue = leafValue(root, m, end);
  // the most one purchase can add at the root: a full cap step, the best income line over the horizon, or the biggest worth
  const maxGain = Math.max(
    m.capPerLevel * (m.capGoldPerTroop ?? CAP_GOLD_PER_TROOP),
    portLevelRate(m, state.portLevels, state.seaShips, true) * NEW_PORT_BONUS * horizon,
    railRate(m, state.factories + 1) * horizon,
    SILO_WORTH * 1.69, SAM_CITIES * SAM_CITY_WORTH, THREAT_POST_WORTH,
  );
  const minCost = Math.min(...KINDS.map((k) => m.cost(k, 0)));
  let best: Node = root, bestValue = idleValue, nodes = 0;
  // iterative deepening: a plain DFS would spend the whole budget under its first (greedy-best) child and never
  // compare "port now" with "city now, port later"; every depth limit ranks all first moves before going deeper,
  // and the best plan so far tightens the bound for the next limit
  const visit = (n: Node, depth: number, limit: number): void => {
    if (nodes >= budget || depth >= limit) return;
    const children: { node: Node; value: number }[] = [];
    const tryAction = (kinds: BuildKind[]) => {
      let c: Node | null = n;
      for (const k of kinds) { if (!allowed(c, m, k)) return; c = apply(c, m, k, end); if (c === null) return; }
      nodes++;
      const value = leafValue(c, m, end);
      if (value > bestValue) { bestValue = value; best = c; }
      children.push({ node: c, value });
    };
    for (const k of KINDS) { if (nodes >= budget) break; tryAction([k]); }
    for (const mac of MACROS) { if (nodes >= budget) break; if (macroAllowed(n, mac)) tryAction(mac); }
    children.sort((a, b) => b.value - a.value);
    for (const ch of children) {
      if (nodes >= budget) return;
      const rem = end - ch.node.tick;
      const purchasesLeft = Math.min(limit - depth - 1, Math.floor((ch.node.gold + ch.node.goldRate * rem) / Math.max(1, minCost)));
      if (ch.value + maxGain * purchasesLeft <= bestValue) continue; // bound: cannot beat the best plan
      visit(ch.node, depth + 1, limit);
    }
  };
  for (let limit = 1; limit <= MAX_DEPTH && nodes < budget; limit++) visit(root, 0, limit);
  return { first: best.steps[0] ?? null, steps: best.steps, value: bestValue, idleValue, nodes, horizon };
}

/** `city@t1200 port@t1250 portLevel@t2100` for the log. */
export function describePlan(p: Plan): string {
  return p.steps.length === 0 ? "nothing" : p.steps.map((s) => `${s.kind}@t${s.at}`).join(" ");
}
