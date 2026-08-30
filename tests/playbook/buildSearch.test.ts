// Flag `buildSearch` (#7): Economy.build() takes its purchase from a BOSS-style fast-forward search over build orders
// (src/core/execution/playbook/BuildSearch.ts) instead of the ordered chain. The planner is pure, so the first
// block feeds it plain numbers; the last block shows the flag changing a purchase in a real game.
import { describe, expect, test } from "vitest";
import {
  BuildKind, DEFAULT_NODE_BUDGET, EconModel, EconState, describePlan, horizonForPhase, regen, search,
} from "../../src/core/execution/playbook/BuildSearch";
import { UnitType } from "../../src/core/game/Game";
import { playbookSetup } from "../util/PlaybookSetup";

/** The engine's price curves (Config.unitInfo): 2^n × 125k capped at 1M for cities and ports/factories, 1M silos,
 *  (n + 1) × 50k posts capped at 250k, (n + 1) × 1.5M SAMs capped at 3M. */
function model(s: EconState, over: Partial<EconModel> = {}): EconModel {
  const curve = (n: number) => Math.min(1_000_000, Math.pow(2, n) * 125_000);
  return {
    cost: (kind: BuildKind, extra: number) => {
      switch (kind) {
        case "city": case "cityLevel": return curve(s.cityUnits + extra);
        case "port": case "portLevel": case "factory": return curve(s.portUnits + s.factories + extra);
        case "post": return Math.min(250_000, (s.posts + extra + 1) * 50_000);
        case "silo": return 1_000_000;
        case "sam": return Math.min(3_000_000, (s.sams + extra + 1) * 1_500_000);
      }
    },
    capPerLevel: 250_000, shipGold: 95_000, seaFullShips: 400, selfStopGold: 10_000, trainSpawnRate: (f) => (f + 10) * 15, railStops: 4,
    maxCityUnits: 9, maxPortUnits: 8, portLevelBeforeSecond: 3, enemySilos: false, rank: 99, idleAtCap: false, regenScale: 1,
    ...over,
  };
}
const base: EconState = {
  tick: 1000, gold: 130_000, goldRate: 100, troops: 20_000, cap: 2_100_000, cityUnits: 0, cityLevels: 0, portUnits: 1, portLevels: 1,
  factories: 0, posts: 0, silos: 0, sams: 0, seaShips: 50, hasPartner: true, threatened: false,
};

describe("BuildSearch: the planner on plain numbers", () => {
  test("a drained empire saves for the port level instead of buying the affordable city", () => {
    // troops 20k under a 2.1M cap: regen cannot reach the cap inside the horizon, so a cap step is worth nothing
    // and the 250k port level (1200 ticks away at 100/tick) is the first purchase — 'save' (first.at > tick)
    const plan = search(base, model(base), 6000);
    expect(plan.first?.kind).toBe("portLevel");
    expect(plan.first!.at).toBeGreaterThan(base.tick);
    expect(plan.steps.some((s) => s.kind === "city" && s.at === base.tick)).toBe(false);
    expect(plan.value).toBeGreaterThan(plan.idleValue);
    expect(regen(20_000, 2_100_000, 6000, 1)).toBeLessThan(2_100_000);
  });

  test("a full army on a full sea buys the city now", () => {
    // every port slot used and 400 ships on the map: a level earns a quarter of the first; the cap step fills at once
    const s: EconState = { ...base, troops: 240_000, cap: 250_000, hasPartner: false, portUnits: 8, portLevels: 8, seaShips: 400 };
    const plan = search(s, model(s), 6000);
    expect(plan.first?.kind).toBe("city");
    expect(plan.first!.at).toBe(s.tick);
  });

  test("the first port comes before the second city when both are affordable (the chain buys city 2 first)", () => {
    const s: EconState = { ...base, gold: 400_000, troops: 160_000, cap: 800_000, cityUnits: 1, cityLevels: 1, portUnits: 0, portLevels: 0, hasPartner: false };
    const plan = search(s, model(s), 6000);
    expect(plan.first?.kind).toBe("port");
    expect(plan.first!.at).toBe(s.tick);
    expect(plan.steps.some((st) => st.kind === "city")).toBe(true);
  });

  test("the node budget is respected and a search fits well under a millisecond", () => {
    const small = search(base, model(base), 6000, 50);
    expect(small.nodes).toBeLessThanOrEqual(50);
    const full = search(base, model(base), 6000);
    expect(full.nodes).toBeLessThanOrEqual(DEFAULT_NODE_BUDGET);
    for (let i = 0; i < 20; i++) search(base, model(base), 6000); // warm up
    const n = 50, t0 = performance.now();
    for (let i = 0; i < n; i++) search(base, model(base), 6000);
    const ms = (performance.now() - t0) / n;
    process.stdout.write(`buildSearch: ${full.nodes} nodes in ${ms.toFixed(3)} ms per search: ${describePlan(full)}\n`);
    expect(ms).toBeLessThan(5); // laptop: well under 1 ms; the bound is loose for CI
  });

  test("the horizon shrinks late and a short horizon drops the slow port", () => {
    expect(horizonForPhase("opening", 100)).toBe(6000);
    expect(horizonForPhase("consolidate", 5000)).toBe(6000);
    expect(horizonForPhase("war", 5000)).toBe(4000);
    expect(horizonForPhase("endgame", 14_500)).toBe(1000);
    expect(horizonForPhase("endgame", 4000)).toBe(6000); // an early endgame (top three under an enemy silo) is capped
    const long = search(base, model(base), 6000);
    const short = search(base, model(base), 800);
    expect(long.first?.kind).toBe("portLevel");
    expect(short.first?.kind).not.toBe("portLevel"); // 250k at 100/tick lands past an 800-tick horizon
  });

  test("a post is worth buying only under a threat (cap and ports crowd it out otherwise: the chain's step 1 keeps the threat posts)", () => {
    // no cap to buy (no city, the MIRV line at 0 units) and the ports full: the post is the only candidate
    const s: EconState = { ...base, gold: 400_000, portUnits: 8, portLevels: 8, seaShips: 400 };
    const calm = search(s, model(s, { maxCityUnits: 0 }), 6000);
    expect(calm.steps.some((st) => st.kind === "post")).toBe(false);
    const hot: EconState = { ...s, threatened: true };
    const plan = search(hot, model(hot, { maxCityUnits: 0 }), 6000);
    expect(plan.first?.kind).toBe("post");
    expect(plan.value - plan.idleValue).toBeGreaterThan(0);
  });
});

// The world test map: a coast in east Africa (the lab's africa spawn), no rivals. A first city is placed by hand so
// the chain and the planner start from the same state (both wait for a city before a port without a partner).
describe("buildSearch in a game", () => {
  async function coast(buildSearch: boolean) {
    const h = await playbookSetup({
      map: "world", spawn: [1155, 549], tiles: [1120, 520, 1190, 580], troops: 160_000,
      bot: { buildSearch, expandFree: 0, expandContested: 0, boatAtTick: 1e9, portWithoutPartnerTick: 0 },
    });
    h.me.addGold(525_000n); // 400k after the hand-built city (buildUnit charges 125k): city 2 (250k) and a first port (125k) are both affordable
    let tile: number | false = false;
    for (const t of h.me.tiles()) { tile = h.me.canBuild(UnitType.City, t); if (tile !== false) break; }
    expect(tile).not.toBe(false);
    h.me.buildUnit(UnitType.City, tile as number, {});

    h.step(h.nextRuleTick(10) + 30);
    const kinds = (lines: string[]) => lines.filter((l) => /(build|level) (City|Port)/.test(l)).map((l) => (/City/.test(l) ? "City" : "Port"));
    const early = kinds(h.log);
    h.step(600);
    const buys = kinds(h.log);
    return { h, buys, early };
  }

  test("off: the chain buys city 2 before the first port", async () => {
    const { h, early } = await coast(false);
    expect(early[0]).toBe("City");
    expect(h.bot.fired.get("buildSearch")).toBeUndefined();
  });

  test("on: the planner buys the port first (its income compounds inside the horizon), and the flag fires", async () => {
    const { h, early, buys } = await coast(true);
    expect(early[0]).toBe("Port");
    expect(buys).toContain("City"); // cap (a city or a level) still comes, within the minute
    expect(h.bot.fired.get("buildSearch") ?? 0).toBeGreaterThan(0);
    expect(h.log.some((l) => /PLAN h=6000/.test(l))).toBe(true);
  });
});
