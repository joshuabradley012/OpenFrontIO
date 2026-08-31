// Flag `lapseToAttack`: manageExpiries lets an ally lapse when Military.wouldTarget (the war scorer run as if the ally
// were an unfriendly neighbour) accepts it and its score beats every unfriendly candidate's — whatever the number of
// rivals. Off = the old prey rule, which renews a weak ally as soon as a second unfriendly neighbour exists.
// Safety (both settings): never while a stronger unfriendly neighbour (> 0.6× our troops) borders us, unless the
// ally is annexable.
//
// Fixture on big_plains: we hold a 120 × 120 centre (cap 726k), the ally A is a 10 × 10 pocket on our east side (cap
// 132k — everyone grows toward its cap inside the 600-tick alliance, so the sizes are what fix the ratios in the
// renewal window), two unfriendly humans R1 / R2 are strips north and south of us, less than 40 % of their border
// ours (not annexable, not attacked: 0.6 × our troops is under 2 × theirs). At the window A is ~0.2× our troops:
// 2 × A + 1000 is affordable out of spendable × fightMaxShare and the scorer takes it; R1 / R2 are not.
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { Military } from "../../src/core/execution/playbook/Military";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType } from "../../src/core/game/Game";
import {
  PlaybookHarness,
  playbookSetup,
  PRE_COMBO,
  Rect,
} from "../util/PlaybookSetup";

const ME: Rect = [40, 40, 159, 159];
const ALLY: Rect = [160, 95, 169, 104];
const NORTH: Rect = [0, 30, 199, 39]; // 2000 tiles, cap 291k
const SOUTH: Rect = [0, 160, 199, 169];
const NORTH_BIG: Rect = [0, 0, 199, 39]; // 8000 tiles, cap 540k: the stronger-neighbour case
const SOUTH_BIG: Rect = [0, 160, 199, 199];
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [
  Math.floor((x0 + x1) / 2),
  Math.floor((y0 + y1) / 2),
];
const HOME: Partial<PlaybookParams> = {
  ...PRE_COMBO,
  expandFree: 0,
  expandContested: 0,
  boatAtTick: 1e9,
  nationAware: false,
  fightNotBeforeTick: 0,
  fightMinCities: 0,
};
const military = (h: PlaybookHarness) =>
  (h.bot as unknown as { military: Military }).military;

async function alliedWeakAlly(
  lapseToAttack: boolean,
  rivalTroops: number,
  bot: Partial<PlaybookParams> = {},
  big = false,
) {
  const h = await playbookSetup({
    map: "big_plains",
    spawn: centre(ME),
    tiles: ME,
    troops: 300_000,
    bot: { ...HOME, lapseToAttack, ...bot },
    rivals: [
      {
        name: "A",
        type: PlayerType.Human,
        at: centre(ALLY),
        tiles: ALLY,
        troops: 60_000,
      },
      {
        name: "R1",
        type: PlayerType.Human,
        at: centre(big ? NORTH_BIG : NORTH),
        tiles: big ? NORTH_BIG : NORTH,
        troops: rivalTroops,
      },
      {
        name: "R2",
        type: PlayerType.Human,
        at: centre(big ? SOUTH_BIG : SOUTH),
        tiles: big ? SOUTH_BIG : SOUTH,
        troops: rivalTroops,
      },
    ],
    config: { customAllianceDuration: 1 }, // 600-tick alliances: the renewal window opens at expiry − 300
  });
  const a = h.rival("A");
  h.game.addExecution(new AllianceRequestExecution(a, h.me.id()));
  h.step(2);
  const al = h.me.allianceWith(a);
  expect(al).not.toBeNull();
  expect(h.me.allies().length).toBe(1);
  return { h, a, al: al!, expiresAt: al!.expiresAt() };
}

/** Run to 10 ticks before the alliance expires (the renewal window has been seen five times by then). */
function toEndOfWindow(h: PlaybookHarness, expiresAt: number) {
  h.step(expiresAt - 10 - h.game.ticks());
}
const ratio = (h: PlaybookHarness, name: string) =>
  h.rival(name).troops() / h.me.troops();

describe("lapseToAttack", () => {
  test("wouldTarget: the weak ally is a war the scorer takes; the two rivals at half our troops are not", async () => {
    const { h, a } = await alliedWeakAlly(true, 150_000);
    h.step(1);
    const mil = military(h);
    const w = mil.wouldTarget(a);
    expect(w.ok).toBe(true);
    expect(w.score).toBeGreaterThan(0);
    expect(mil.wouldTarget(h.rival("R1")).ok).toBe(false); // 0.6 × 300k / 150k = 1.2 < fightRatio
    expect(mil.wouldTarget(h.rival("R2")).ok).toBe(false);
    expect(mil.wouldTarget(h.me).ok).toBe(false);
  });

  test("off: two other rivals → the weak ally is renewed (AllianceExtensionExecution queued)", async () => {
    // The bot's own wars stay off here (both war gates pinned: affordability via fightRatio and the
    // troops-above-fightAbove-x-cap path): under the 2026-08-31 engine merge's regen drift the bot
    // crossed 0.7 x cap before the window, fought and ate R1 — leaving one rival, which IS prey
    // territory. This case is about the renewal with two rivals alive; the prey rule it guards reads
    // fightAbove too, so the pin also keeps prey off, which the renewal assertion wants anyway.
    const { h, a, al, expiresAt } = await alliedWeakAlly(false, 150_000, {
      fightRatio: 1e9,
      fightAbove: 1e9,
    });
    toEndOfWindow(h, expiresAt);
    expect(h.rival("R1").isAlive() && h.rival("R2").isAlive()).toBe(true); // the premise, asserted
    expect(ratio(h, "A")).toBeLessThan(0.25);
    expect(ratio(h, "R1")).toBeLessThan(0.6);
    expect(al.onlyOneAgreedToExtend()).toBe(true); // our extension request is in; the scripted human never answers
    expect(h.log.some((l) => /let alliance/.test(l))).toBe(false);
    expect(h.bot.fired.get("lapseToAttack")).toBeUndefined();
    expect(h.me.isFriendly(a)).toBe(true);
  });

  test("on: the ally is the best war on the board → it lapses, logged with its score, the flag fires", async () => {
    const { h, a, al, expiresAt } = await alliedWeakAlly(true, 150_000);
    toEndOfWindow(h, expiresAt);
    expect(h.me.outgoingAttacks().length).toBe(0); // the strips were never a war
    expect(al.onlyOneAgreedToExtend()).toBe(false);
    const line = h.log.find((l) =>
      /let alliance lapse to attack A \(score \d+\.\d, \d+k vs our \d+k\)/.test(
        l,
      ),
    );
    expect(line).toBeDefined();
    expect(h.bot.fired.get("lapseToAttack")).toBe(1);
    // the alliance ends and the war rule takes the planned target
    expect(h.until(() => !h.me.isFriendly(a), 30)).toBe(true);
    expect(
      h.until(() => h.me.outgoingAttacks().some((x) => x.target() === a), 60),
    ).toBe(true);
  });

  test("on: a stronger unfriendly neighbour (> 0.6× our troops) on the border keeps the alliance", async () => {
    const { h, a, al, expiresAt } = await alliedWeakAlly(
      true,
      450_000,
      {},
      true,
    );
    h.step(1);
    expect(military(h).wouldTarget(a).ok).toBe(true); // the ally would still be the war; the neighbour is the reason
    toEndOfWindow(h, expiresAt);
    expect(ratio(h, "R1")).toBeGreaterThan(0.6);
    expect(al.onlyOneAgreedToExtend()).toBe(true);
    expect(h.log.some((l) => /let alliance lapse to attack/.test(l))).toBe(
      false,
    );
    expect(h.bot.fired.get("lapseToAttack")).toBeUndefined();
    expect(h.me.isFriendly(a)).toBe(true);
  });

  test("on: an ally the scorer refuses (under the ratio gate) is renewed", async () => {
    // fightMaxShare 0.28: maxSend = 84k against A's 60k = 1.4× < fightRatio 2 — the ratio gate refuses
    const { h, a, al, expiresAt } = await alliedWeakAlly(true, 60_000, {
      fightMaxShare: 0.28,
      fightAbove: 0,
    });
    h.step(1);
    expect(military(h).wouldTarget(a).ok).toBe(false);
    toEndOfWindow(h, expiresAt);
    expect(al.onlyOneAgreedToExtend()).toBe(true);
    expect(h.log.some((l) => /let alliance lapse to attack/.test(l))).toBe(
      false,
    );
  });
});
