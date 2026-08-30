// Flag `borderRatio`: a target whose whole army is out of reach at fightRatio is judged instead against the troops it
// can bring to our shared border — troops × max(0.25, the share of its border facing us) plus a minute of regen — and
// the wave is fightRatio × those defenders + 1000 (a bite). Off = the whole-army gate, under which a neighbour our own
// size is never attacked at 2×.
import { describe, expect, test } from "vitest";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Situation } from "../../src/core/execution/playbook/Situation";
import { PlayerType } from "../../src/core/game/Game";
import { conquerRect, playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const WIDE: Rect = [0, 58, 99, 90]; // the whole south of the map: its top row is 100 tiles, we touch 41 of them
const SMALL: Rect = [30, 58, 70, 70]; // enclosed on three sides by our strips below
const WAR: Partial<PlaybookParams> = { fightNotBeforeTick: 0, fightMinCities: 0, expandFree: 0, expandContested: 0 };

function sit(h: { bot: unknown }): Situation {
  return (h.bot as { sit: Situation }).sit;
}

async function wideTarget(borderRatio: boolean) {
  const h = await playbookSetup({
    spawn: [50, 40], tiles: ME, troops: 200_000, bot: { ...WAR, borderRatio }, // 200k: above fightAbove, under the 95 % cap line
    rivals: [{ name: "T", type: PlayerType.Nation, at: [50, 75], tiles: WIDE, troops: 150_000 }],
  });
  h.step(h.nextRuleTick(10) + 1);
  return h;
}

describe("borderRatio", () => {
  test("off: a neighbour with three quarters of our troops is out of reach at 2× — no war", async () => {
    const h = await wideTarget(false);
    expect(h.me.troops()).toBeLessThan(h.game.config().maxTroops(h.me) * 0.95);
    expect(h.log.some((l) => l.includes("ATTACK"))).toBe(false);
    expect(h.bot.fired.get("borderRatio")).toBeUndefined();
  });

  test("on: the same neighbour faces us on ~20 % of its border — a BITE at 2× a quarter of its army (plus 10 s of regen)", async () => {
    const h = await wideTarget(true);
    const t = h.rival("T");
    const share = sit(h).rival.get(t)!.borderShare;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.25);
    const bite = h.log.find((l) => l.includes("BITE T"));
    expect(bite).toMatch(/^t10 BITE T border share 0\.\d\d, defenders \d+k$/);
    const attack = h.log.find((l) => l.includes("ATTACK T"));
    expect(attack).toBeDefined();
    const sent = Number(/← (\d+)k/.exec(attack!)![1]) * 1000;
    // the wave: fightRatio × (troops + 10 s of regen) × 0.25 + 1000 — a bite, not 2 × 150k
    const regen = h.game.config().troopIncreaseRate(t) * 100;
    const want = Math.ceil((t.troops() + regen) * 0.25 * 2) + 1000;
    expect(sent).toBeGreaterThan(want * 0.95);
    expect(sent).toBeLessThan(want * 1.05);
    expect(sent).toBeLessThan(200_000 * 0.6); // under fightMaxShare of home
    expect(sent).toBeLessThan(150_000 * 2);
    expect(h.me.outgoingAttacks().some((a) => a.target() === t)).toBe(true);
    expect(h.bot.fired.get("borderRatio") ?? 0).toBeGreaterThan(0);
  });

  test("on: a target facing us on most of its border is still gated by its whole army", async () => {
    const h = await playbookSetup({
      spawn: [50, 40], tiles: ME, troops: 200_000, bot: { ...WAR, borderRatio: true },
      rivals: [{ name: "S", type: PlayerType.Nation, at: [50, 64], tiles: SMALL, troops: 130_000 }], // under its own cap, so it does not decay
    });
    // wrap S on its left, right and bottom so nearly all of its border faces us
    conquerRect(h.game, h.me, [25, 58, 29, 75]);
    conquerRect(h.game, h.me, [71, 58, 75, 75]);
    conquerRect(h.game, h.me, [25, 71, 75, 75]);
    h.step(h.nextRuleTick(10) + 1);
    const s = h.rival("S");
    expect(sit(h).rival.get(s)!.borderShare).toBeGreaterThan(0.8);
    // defenders ≈ its whole army: 2 × 130k does not fit in 60 % of 200k, whichever gate is used
    expect(h.log.some((l) => l.includes("ATTACK"))).toBe(false);
    expect(h.log.some((l) => l.includes("BITE"))).toBe(false);
    expect(h.bot.fired.get("borderRatio")).toBeUndefined();
  });
});
