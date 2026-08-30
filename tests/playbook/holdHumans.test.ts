// Flag `holdHumans`: the 45 s expiry hold (send() returns 0 while an alliance with a stronger ally is about to
// lapse) also applies to a human ally with troops > 0.85× ours. Off = nations only (hold.test.ts).
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { PlayerType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, Rect } from "../util/PlaybookSetup";

const SMALL: Rect = [80, 70, 120, 114];
const LARGE: Rect = [40, 115, 160, 190];
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];

async function alliedHuman(holdHumans: boolean) {
  const h = await playbookSetup({
    map: "big_plains", spawn: centre(SMALL), tiles: SMALL, troops: 50_000, bot: { nationAware: false, holdHumans },
    rivals: [{ name: "R", type: PlayerType.Human, at: centre(LARGE), tiles: LARGE, troops: 400_000 }],
    config: { customAllianceDuration: 1 }, // 600-tick alliances: the hold window opens at expiry − 450
  });
  const r = h.rival("R");
  h.game.addExecution(new AllianceRequestExecution(r, h.me.id()));
  h.step(2);
  const al = h.me.allianceWith(r);
  expect(al).not.toBeNull();
  const expiresAt = al!.expiresAt();
  h.step(expiresAt - 450 + 1 - h.game.ticks());
  expect(r.troops()).toBeGreaterThan(h.me.troops() * 0.85);
  return { h, r, expiresAt };
}

/** Ticks inside [now, to) on which an attack that did not exist at the start is running. */
function ticksWithNewAttacks(h: PlaybookHarness, to: number): number {
  const known = new Set(h.me.outgoingAttacks().map((a) => a.id()));
  let n = 0;
  while (h.game.ticks() < to) {
    h.step(1);
    if (h.me.outgoingAttacks().some((a) => !known.has(a.id()))) n++;
  }
  return n;
}

describe("holdHumans", () => {
  test("off: a stronger human ally about to lapse does not hold the army", async () => {
    const { h, expiresAt } = await alliedHuman(false);
    expect(ticksWithNewAttacks(h, expiresAt - 10)).toBeGreaterThan(100);
    expect(h.log.some((l) => l.includes("holding troops home"))).toBe(false);
    expect(h.bot.fired.get("holdHumans")).toBeUndefined();
  });

  test("on: nothing leaves home inside the window, and the flag fires", async () => {
    const { h, expiresAt } = await alliedHuman(true);
    expect(ticksWithNewAttacks(h, expiresAt - 10)).toBe(0);
    expect(h.log.some((l) => /holding troops home: alliance with R about to lapse/.test(l))).toBe(true);
    expect(h.bot.fired.get("holdHumans")).toBeGreaterThanOrEqual(1);
  });
});
