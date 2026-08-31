// Flag `duelPush` (docs/PlaybookBotPlan.md "Finish a won duel"): Josh's GUI endgame — two non-bot players left, the
// bot at 38 % of the land with 13.3M troops against the rival's 61.7 % / 7.55M — stalled for 10+ minutes REQUESTING
// ALLIANCES with its only rival. Two causes: the finish rule's push needs share ≥ 0.45 (so a won duel at 38 % never
// pushes) and requestAlliances courts the sole rival forever. With the flag on, while the living non-bot, non-teammate
// players are ≤ duelPlayers (us included) and our troops are ≥ duelRatio × the foe's: Diplomacy never asks / accepts /
// renews an alliance with the foe (an existing one lapses), the mode is `push` whatever the share, and the war rule
// takes the foe as an opportunity at duelRatio (no affordability / fightAbove gate). Behind on troops, or with a third
// player alive, nothing changes.
//
// Geometry (big_plains, 200 × 200): we hold the north 60 rows (12 000 tiles, 30 % of the map — under the finish rule's
// 45 %), the foe the rest (28 000 — larger than us, so never annexable). The armies are re-pinned every 10 ticks
// (regen would race both to cap): ours at 0.65 × our cap C — under fightAbove (0.7) — and the foe's at a share of C:
//   0.30C  the plain gates refuse (affordable: 2 × 0.30C + 1000 > 0.65C × 0.7 × 0.6 = 0.273C; fightAbove: 0.65 < 0.7),
//          the duel takes it (0.65 ≥ 1.2 × 0.30) and the endgame send 0.7 × 0.65C = 0.455C is 1.5 × the foe's army;
//   0.50C  the duel is on (1.3×) but the send (0.455C) is under 1.2 × 0.50C: no war yet — the diplomacy half alone
//          (this is Josh's band: ahead, not yet able to send the wave, and the plain rule courting the foe meanwhile);
//   0.60C  behind (0.65 < 1.2 × 0.60): no duel.
import { describe, expect, test } from "vitest";
import { AllianceExtensionExecution } from "../../src/core/execution/alliance/AllianceExtensionExecution";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Player, PlayerType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, Rect } from "../util/PlaybookSetup";

// Pins: no expansion or boats of the bot's own, wars allowed from tick 0, and the pre-existing defaults the numbers
// were sized against (as other tests pin): fightRatio 2 / fightAbove 0.7 / fightMaxShare 0.6 / reserveShare 0.3.
const HOME: Partial<PlaybookParams> = {
  expandFree: 0, expandContested: 0, boatAtTick: 1e9, nationAware: false, fightNotBeforeTick: 0, fightMinCities: 0,
  lapseToAttack: false, finishByBoat: false, multiWar: false, annexWars: false, contestLeader: false, plateauBreak: false,
  fightRatio: 2, fightAbove: 0.7, fightMaxShare: 0.6, reserveShare: 0.3, allianceEvery: 300,
};
const ME: Rect = [0, 0, 199, 59]; // 12 000 tiles
const FOE: Rect = [0, 60, 199, 199]; // 28 000 tiles, adjacent to our south
const FOE_TWO: Rect = [0, 60, 199, 169]; // three-player variant: the foe stops at row 169 ...
const THIRD: Rect = [0, 170, 199, 199]; // ... and a third human holds the south strip (no border with us)
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];

async function duelFixture(flags: Partial<PlaybookParams>, foeShare: number, opts: { third?: boolean; allianceMinutes?: number } = {}) {
  const third = opts.third === true;
  const h = await playbookSetup({
    map: "big_plains", spawn: centre(ME), tiles: ME, troops: 100_000,
    bot: { ...HOME, ...flags },
    config: opts.allianceMinutes === undefined ? {} : { customAllianceDuration: opts.allianceMinutes },
    rivals: [
      { name: "Foe", type: PlayerType.Human, at: centre(third ? FOE_TWO : FOE), tiles: third ? FOE_TWO : FOE, troops: 50_000 },
      ...(third ? [{ name: "Third", type: PlayerType.Human, at: centre(THIRD), tiles: THIRD, troops: 10_000 }] : []),
    ],
  });
  const foe = h.rival("Foe");
  const cap = () => h.game.config().maxTroops(h.me);
  const share = { foe: foeShare };
  const pin = () => { h.me.setTroops(Math.floor(cap() * 0.65)); foe.setTroops(Math.floor(cap() * share.foe)); if (third) h.rival("Third").setTroops(Math.floor(cap() * 0.1)); };
  expect(foe.numTilesOwned()).toBeGreaterThan(h.me.numTilesOwned()); // never annexable: larger than us
  return { h, foe, pin, share };
}
/** Step to `target` ticks, re-pinning the armies every 10 ticks. */
function drive(h: PlaybookHarness, target: number, pin: () => void) {
  pin();
  while (h.game.ticks() < target) { h.step(10); pin(); }
}
const attackLine = (h: PlaybookHarness) => h.log.find((l) => /^t\d+ ATTACK Foe /.test(l)) ?? null;
const requested = (me: Player, foe: Player) => foe.incomingAllianceRequests().some((r) => r.requestor() === me);

describe("duelPush: the war", () => {
  test("on, ahead at 0.30C: the war on the foe opens at duelRatio below fightAbove, DUEL and the push are logged, the flag fires", async () => {
    const { h, foe, pin } = await duelFixture({ duelPush: true }, 0.3);
    drive(h, 60, pin);
    expect(h.log.find((l) => l.includes("DUEL vs"))).toMatch(/DUEL vs Foe troops us \d+k \/ them \d+k — pushing/);
    expect(h.log.find((l) => l.includes("FINISH mode"))).toMatch(/FINISH mode grow → push: .*duel vs Foe/);
    const line = attackLine(h);
    expect(line).toMatch(/ATTACK Foe \d+t\/\d+k ← \d+k \(\d\.\d+×\)/);
    const ratio = Number(/\((\d\.\d+)×\)/.exec(line!)![1]);
    expect(ratio).toBeGreaterThanOrEqual(1.1); // the duelRatio wave (1.2×; whole-or-nothing lets the capFloor trim it to 0.9 of that)
    expect(ratio).toBeLessThan(1.5); // not the plain fightRatio (2×) wave
    expect(h.until(() => h.me.outgoingAttacks().some((a) => a.target() === foe), 40)).toBe(true);
    expect(h.bot.fired.get("duelPush")).toBeGreaterThanOrEqual(2); // mode + gate/score
  });

  test("off, the same fixture: no war (the plain gates refuse), no DUEL, nothing fires", async () => {
    const { h, pin } = await duelFixture({}, 0.3);
    drive(h, 310, pin);
    expect(attackLine(h)).toBeNull();
    expect(h.me.outgoingAttacks().length).toBe(0);
    expect(h.log.some((l) => l.includes("DUEL") || l.includes("FINISH mode"))).toBe(false);
    expect(h.bot.fired.get("duelPush")).toBeUndefined();
  });
});

describe("duelPush: diplomacy", () => {
  test("on, ahead at 0.50C (the wave does not fit yet): no alliance request to the foe, its peace offer refused, the flag fires", async () => {
    const { h, foe, pin } = await duelFixture({ duelPush: true }, 0.5);
    drive(h, 310, pin); // the t300 alliance pass
    expect(h.log.find((l) => l.includes("DUEL vs"))).toMatch(/DUEL vs Foe/);
    expect(attackLine(h)).toBeNull(); // 0.455C < 1.2 × 0.5C: the scorer refuses, the plain rule would have as well
    expect(requested(h.me, foe)).toBe(false);
    expect(h.log.some((l) => /DUEL: no alliance request to Foe/.test(l))).toBe(true);
    const fired = h.bot.fired.get("duelPush") ?? 0;
    expect(fired).toBeGreaterThanOrEqual(1);
    h.game.addExecution(new AllianceRequestExecution(foe, h.me.id())); // the foe sues for peace
    drive(h, 340, pin);
    expect(h.me.isAlliedWith(foe)).toBe(false);
    expect(h.log.some((l) => /DUEL: no alliance with Foe/.test(l))).toBe(true);
    expect(h.bot.fired.get("duelPush")).toBeGreaterThan(fired);
  });

  test("off, the same fixture: the request to the sole rival goes out and its peace offer is accepted", async () => {
    const { h, foe, pin } = await duelFixture({}, 0.5);
    drive(h, 310, pin);
    expect(requested(h.me, foe)).toBe(true);
    expect(h.log.some((l) => l.includes("DUEL"))).toBe(false);
    expect(h.bot.fired.get("duelPush")).toBeUndefined();
  });

  test("on, behind at 0.60C: no change — the request goes out, no war, the foe's peace is accepted, nothing fires", async () => {
    const { h, foe, pin } = await duelFixture({ duelPush: true }, 0.6);
    drive(h, 310, pin);
    expect(attackLine(h)).toBeNull();
    expect(requested(h.me, foe)).toBe(true);
    expect(h.log.some((l) => l.includes("DUEL"))).toBe(false);
    h.game.addExecution(new AllianceRequestExecution(foe, h.me.id()));
    drive(h, 340, pin);
    expect(h.me.isAlliedWith(foe)).toBe(true);
    expect(h.bot.fired.get("duelPush")).toBeUndefined();
  });

  test("on, three players alive: no duel — the request goes out and no war opens", async () => {
    const { h, foe, pin } = await duelFixture({ duelPush: true }, 0.3, { third: true });
    drive(h, 310, pin);
    expect(attackLine(h)).toBeNull();
    expect(requested(h.me, foe)).toBe(true);
    expect(h.log.some((l) => l.includes("DUEL"))).toBe(false);
    expect(h.bot.fired.get("duelPush")).toBeUndefined();
  });
});

// The stall's other half: the foe is already our ally. Alliances last one minute here (customAllianceDuration 1 =
// 600 ticks); the foe asks at t20 while we are behind (accepted, as the plain rule would), we pull ahead at t100, and
// the foe asks to renew inside the 300-tick window. Off: the bot renews too (both agreed → extended), no war. On: the
// renewal is refused, the alliance lapses at ~t620 and the duel war opens on the now-unfriendly foe.
describe("duelPush: an existing alliance with the foe lapses, never breaks", () => {
  async function allied(flags: Partial<PlaybookParams>) {
    const { h, foe, pin, share } = await duelFixture(flags, 0.6, { allianceMinutes: 1 });
    drive(h, 20, pin);
    h.game.addExecution(new AllianceRequestExecution(foe, h.me.id()));
    drive(h, 40, pin);
    expect(h.me.isAlliedWith(foe)).toBe(true); // behind: accepted
    share.foe = 0.3; // we pull ahead
    drive(h, 340, pin);
    h.game.addExecution(new AllianceExtensionExecution(foe, h.me.id())); // the foe wants to renew
    drive(h, 700, pin);
    return { h, foe };
  }
  test("on: no renewal — the alliance lapses (logged), the foe is never betrayed, the war opens after the lapse", async () => {
    const { h, foe } = await allied({ duelPush: true });
    expect(h.log.some((l) => /let alliance with Foe lapse: the duel is won/.test(l))).toBe(true);
    expect(h.me.isAlliedWith(foe)).toBe(false);
    expect(h.me.isTraitor()).toBe(false);
    expect(h.log.some((l) => /ALLIANCE ENDED Foe/.test(l))).toBe(true);
    expect(attackLine(h)).not.toBeNull();
    expect(h.bot.fired.get("duelPush")).toBeGreaterThanOrEqual(1);
  });
  test("off: the bot renews with the foe and the alliance stands past its first term; no war", async () => {
    const { h, foe } = await allied({});
    expect(h.me.isAlliedWith(foe)).toBe(true);
    expect(attackLine(h)).toBeNull();
    expect(h.bot.fired.get("duelPush")).toBeUndefined();
  });
});
