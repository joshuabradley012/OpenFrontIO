// Flag `wildernessAware` (opportunity #2): AiAttackBehavior.maybeAttack sends a nation's whole surplus at any unowned,
// fallout-free land next to its border and returns before a player is considered (lines 60-95). Such a nation cannot
// attack us this tick: RivalView.nationCanAttack reads false and nationWouldSend 0 (so trustWars' pile-in veto and the
// nationAware expiry hold stand down), and while every unfriendly neighbour is such a nation the reserve halves.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Situation } from "../../src/core/execution/playbook/Situation";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const LEFT: Rect = [29, 58, 49, 90]; // on plains both rectangles have free land beside them
const RIGHT: Rect = [50, 58, 70, 90];
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };
const sitOf = (h: { bot: unknown }) => (h.bot as { sit: Situation }).sit;

describe("wildernessAware", () => {
  async function prey(wildernessAware: boolean) {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, trustWars: true, wildernessAware },
      rivals: [
        { name: "R", type: PlayerType.Nation, at: [40, 75], tiles: LEFT, troops: 10_000 },
        { name: "A", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: 200_000 }, // R's ally, big enough to pile in
      ],
    });
    const r = h.rival("R"), a = h.rival("A");
    a.createAllianceRequest(r)!.accept();
    h.step(h.nextRuleTick(10));
    return { h, r, a };
  }

  test("off: the wilderness-bound ally reads as able to attack, and trustWars vetoes the war", async () => {
    const { h, a } = await prey(false);
    const v = sitOf(h).rival.get(a)!;
    expect(v.wildernessBound).toBe(false);
    expect(v.nationCanAttack).toBe(true);
    expect(h.log.some((l) => /no war on R: its ally A/.test(l))).toBe(true);
    expect(h.log.some((l) => /ATTACK R /.test(l))).toBe(false);
  });

  test("on: free land beside the ally means it cannot attack us — no veto, war on the prey, half the reserve", async () => {
    const { h, a } = await prey(true);
    const v = sitOf(h).rival.get(a)!;
    expect(v.wildernessBound).toBe(true);
    expect(v.nationCanAttack).toBe(false);
    expect(v.nationWouldSend).toBe(0);
    expect(h.log.some((l) => /no war on R/.test(l))).toBe(false);
    expect(h.log.some((l) => /ATTACK R /.test(l))).toBe(true);
    expect(h.bot.fired.get("wildernessAware")).toBeGreaterThan(0);
  });

  test("the reserve halves only while every unfriendly neighbour is a wilderness-bound nation", async () => {
    // A is enclosed by our land: no free tile touches its border, so it is not wilderness-bound and the reserve stays
    const h = await playbookSetup({
      spawn: [50, 30], tiles: [10, 10, 90, 90], troops: 100_000, bot: { ...WAR, wildernessAware: true },
      rivals: [{ name: "A", type: PlayerType.Nation, at: [50, 60], tiles: [40, 50, 60, 70], troops: 50_000 }],
    });
    h.step(2);
    expect(sitOf(h).rivals).toContain(h.rival("A"));
    expect(sitOf(h).rival.get(h.rival("A"))!.wildernessBound).toBe(false);
    expect(sitOf(h).reserve).toBeCloseTo(sitOf(h).troops * 0.3, 0);
    // the same nation with an open flank
    const open = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 100_000, bot: { ...WAR, wildernessAware: true },
      rivals: [{ name: "A", type: PlayerType.Nation, at: [60, 75], tiles: RIGHT, troops: 50_000 }],
    });
    open.step(2);
    expect(sitOf(open).rival.get(open.rival("A"))!.wildernessBound).toBe(true);
    expect(sitOf(open).reserve).toBeCloseTo(sitOf(open).troops * 0.15, 0);
  });
});
