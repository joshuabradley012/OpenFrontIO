// Flag `webDefense` (loss cluster 4, the alliance-web rush — rm1's p_base_med8b_north-russia: Sudan+Bhutan+Namibia
// mutual allies on our border, wars vetoed by the pile-in rule, the ex-ally betrays, dead at 9:15): before webUntil,
// ≥ 2 of our non-ally neighbours allied WITH EACH OTHER whose combined nation-rule sendable troops
// (RivalView.nationWouldSend) exceed webRatio × our troops are a border web. Response through the existing budgets:
// requestAlliances asks the member most likely to accept first (even one the prey rule would keep as food), the
// threat-post rule treats every member as a threat, and the reserve reads the web's combined sendable where it
// reads a max (bounded ×2 as today). Off = the plain paths.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Situation } from "../../src/core/execution/playbook/Situation";
import { Player, PlayerType } from "../../src/core/game/Game";
import { playbookSetup, PlaybookHarness, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const LEFT: Rect = [29, 58, 49, 90]; // two equal 21 × 33 rectangles under us
const RIGHT: Rect = [50, 58, 70, 90];
// pinned pre-existing defaults: wars and expansion off so the picture stays fixed; the first alliance pass lands at
// t1200, where the prey rule (troops < 0.5 × ours from tick 1200) would keep both web members as food; webRatio 0.4
// because prey-sized members (92k on a ~150k-cap rect) send ~45k each past the nations' 0.3 reserve ratio
const WEB: Partial<PlaybookParams> = {
  fightNotBeforeTick: 1e9, fightMinCities: 0, expandFree: 0, expandContested: 0,
  allianceEvery: 1200, webRatio: 0.4,
};

async function fixture(opts: { webDefense: boolean; allied?: boolean; webUntil?: number }) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 200_000,
    bot: { ...WEB, webDefense: opts.webDefense, webUntil: opts.webUntil ?? 6000 },
    rivals: [
      { name: "L", type: PlayerType.Nation, at: [40, 75], tiles: LEFT, troops: 92_000 },
      { name: "R", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: 90_000 },
    ],
  });
  const l = h.rival("L"), r = h.rival("R");
  if (opts.allied !== false) {
    l.createAllianceRequest(r)!.accept();
    expect(l.isAlliedWith(r)).toBe(true);
  }
  h.me.addGold(10_000_000n); // posts and the first city are never the binding constraint
  return { h, l, r };
}

/** Step to tick `to` with every army pinned: troop regrowth would otherwise move the prey and web thresholds. */
function run(h: PlaybookHarness, l: Player, r: Player, to: number): void {
  while (h.game.ticks() < to) {
    h.me.setTroops(200_000);
    l.setTroops(92_000);
    r.setTroops(90_000);
    h.step(1);
  }
}

const sitOf = (h: PlaybookHarness) => (h.bot as unknown as { sit: Situation }).sit;

describe("webDefense: a two-ally web on our border", () => {
  test("on: WEB logged, a post goes up, the likeliest member is asked despite being prey, the reserve doubles", async () => {
    const { h, l, r } = await fixture({ webDefense: true });
    run(h, l, r, 1210);
    expect(h.log.some((x) => /WEB L\+R could send \d+k at our 200k/.test(x))).toBe(true);
    // neither member qualifies as a plain threat (92k < 0.5 × 200k, and 200k < 3 × 90k) — the post is the web's
    expect(h.log.some((x) => /build Defense Post/.test(x))).toBe(true);
    // both members are prey at t1200 (troops < 0.5 × ours): the plain pass asks nobody; the web pass asks L, the
    // strongest sender, first
    expect(h.me.outgoingAllianceRequests().map((q) => q.recipient())).toContain(l);
    // the reserve read the web's combined sendable (~91k on 200k troops → ×1.9, bounded ×2 as the threatMap mult)
    expect(sitOf(h).web).not.toBeNull();
    expect(sitOf(h).reserve).toBeGreaterThan(200_000 * 0.3 * 1.5);
    expect(h.bot.fired.get("webDefense")).toBeGreaterThan(0);
  });

  test("off: same picture, none of it happens", async () => {
    const { h, l, r } = await fixture({ webDefense: false });
    run(h, l, r, 1210);
    expect(h.log.some((x) => /WEB /.test(x))).toBe(false);
    expect(h.log.some((x) => /build Defense Post/.test(x))).toBe(false);
    expect(h.me.outgoingAllianceRequests()).toHaveLength(0); // both members kept as prey
    expect(sitOf(h).web).toBeNull();
    expect(sitOf(h).reserve).toBeLessThan(200_000 * 0.3 * 1.01);
    expect(h.bot.fired.get("webDefense")).toBeUndefined();
  });

  test("on, but the neighbours are not allied with each other: no web", async () => {
    const { h, l, r } = await fixture({ webDefense: true, allied: false });
    run(h, l, r, 1210);
    expect(h.log.some((x) => /WEB /.test(x))).toBe(false);
    expect(h.log.some((x) => /build Defense Post/.test(x))).toBe(false);
    expect(h.me.outgoingAllianceRequests()).toHaveLength(0);
    expect(sitOf(h).web).toBeNull();
    expect(h.bot.fired.get("webDefense")).toBeUndefined();
  });

  test("on, past webUntil: detection stops and the responses with it", async () => {
    const { h, l, r } = await fixture({ webDefense: true, webUntil: 600 });
    run(h, l, r, 1210);
    // the post rule starts at t900 and the first alliance pass is t1200 — both after the webUntil 600 cut-off
    expect(h.log.some((x) => /build Defense Post/.test(x))).toBe(false);
    expect(h.me.outgoingAllianceRequests()).toHaveLength(0);
    expect(sitOf(h).web).toBeNull();
    for (const x of h.log) {
      const m = /^t(\d+) WEB /.exec(x);
      if (m) expect(Number(m[1])).toBeLessThan(600);
    }
  });
});
