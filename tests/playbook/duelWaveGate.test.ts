// Flag `duelWaveGate` (docs/PlaybookBotPlan.md "Combo loss analysis"): duelPush at duelRatio 1.0 is right for
// DIPLOMACY — stop courting the last rival the moment we are level — but it also authorises the duel WAR wave near
// parity, and that wave is an all-in: it sends every troop above the reserve at a foe about our own size (salv2
// p_combo_med8_north-russia — an 82.6M wave, 1.00× the foe's 82.7M army, cap 170M→33M, a led game lost). With the
// flag on the warPick duel-opportunity branch additionally requires our troops ≥ duelWaveRatio × the foe's; in the
// band between duelRatio and duelWaveRatio the pick proceeds as if no duel opportunity existed (normal gates —
// pressure without the all-in), while Diplomacy / the push mode / bombs / MIRV keep the duelRatio threshold.
//
// A base fact these tests pin down (found while sizing the fixture): warScorer's duel branch takes the foe only at
// maxSend ≥ duelRatio × its army, and maxSend is 0.7 × our troops in the push — so the PLAIN duel wave never goes
// under ~duelRatio/0.7 ≈ 1.43× the foe (send's whole-or-nothing trim raises that further). At the default
// duelWaveRatio 1.2 the gate therefore blocks no wave the plain duel would have sent — it only strips the
// opportunity STATUS (affordability / fightAbove / sticky-target bypass) in the 1.0–1.2× band, and the fired counter
// stays at 0 there by design. The wave-holding cases below pin duelWaveRatio 2.0 so the gate covers ratios where the
// plain wave really goes.
//
// Geometry (big_plains, 200 × 200), as duelPush.test.ts: we hold the north 60 rows (12 000 tiles), the foe the other
// 28 000 (larger than us — never annexable). Armies re-pinned every 10 ticks: ours at 0.65 × our cap C (under
// fightAbove 0.7), the foe's at a share of C. With duelRatio pinned 1.0 (the combo default) and the pins below,
// room = min(spendable 0.455C, troops − 0.3 × cap = 0.35C) = 0.35C and maxSend = 0.7 × 0.65C = 0.455C, so:
//   0.35C  us/foe 1.86×: the plain duel wave GOES (score 0.455/0.35 = 1.3 ≥ 1.0; the 0.35C wave is 1.00× the foe's
//          army — the transcript's own-goal shape, home left with 0.30C against a 0.35C foe) — the gate at 2.0 holds
//          it and fires;
//   0.60C  us/foe 1.08×, the 1.0–1.2 band at the DEFAULT duelWaveRatio: held (logged), but the plain wave would not
//          have gone either (0.455C < 0.60C) — no fire; diplomacy still refuses the foe;
//   0.30C  us/foe 2.17× ≥ the pinned 2.0: the wave goes with the flag on too;
//   0.70C  us/foe 0.93× < duelRatio: no duel either way.
import { describe, expect, test } from "vitest";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { PlayerType } from "../../src/core/game/Game";
import { PlaybookHarness, playbookSetup, PRE_COMBO, Rect } from "../util/PlaybookSetup";

// Pins: no expansion or boats, wars from tick 0, and the pre-existing defaults the numbers were sized against
// (as duelPush.test.ts pins them) — plus duelPush ON at the combo default duelRatio 1.0, the behaviour this
// flag modifies.
const HOME: Partial<PlaybookParams> = { ...PRE_COMBO,
  expandFree: 0, expandContested: 0, boatAtTick: 1e9, nationAware: false, fightNotBeforeTick: 0, fightMinCities: 0,
  lapseToAttack: false, finishByBoat: false, multiWar: false, annexWars: false, contestLeader: false, plateauBreak: false,
  fightRatio: 2, fightAbove: 0.7, fightMaxShare: 0.6, reserveShare: 0.3, allianceEvery: 300,
  duelPush: true, duelRatio: 1.0,
};
const ME: Rect = [0, 0, 199, 59]; // 12 000 tiles
const FOE: Rect = [0, 60, 199, 199]; // 28 000 tiles, adjacent to our south
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)];

async function fixture(flags: Partial<PlaybookParams>, foeShare: number) {
  const h = await playbookSetup({
    map: "big_plains", spawn: centre(ME), tiles: ME, troops: 100_000,
    bot: { ...HOME, ...flags },
    rivals: [{ name: "Foe", type: PlayerType.Human, at: centre(FOE), tiles: FOE, troops: 50_000 }],
  });
  const foe = h.rival("Foe");
  const cap = () => h.game.config().maxTroops(h.me);
  const pin = () => { h.me.setTroops(Math.floor(cap() * 0.65)); foe.setTroops(Math.floor(cap() * foeShare)); };
  expect(foe.numTilesOwned()).toBeGreaterThan(h.me.numTilesOwned()); // never annexable
  return { h, foe, pin };
}
/** Step to `target` ticks, re-pinning the armies every 10 ticks. */
function drive(h: PlaybookHarness, target: number, pin: () => void) {
  pin();
  while (h.game.ticks() < target) { h.step(10); pin(); }
}
const attackLine = (h: PlaybookHarness) => h.log.find((l) => /^t\d+ ATTACK Foe /.test(l)) ?? null;
const heldLine = (h: PlaybookHarness) => h.log.find((l) => l.includes("DUEL wave held")) ?? null;

describe("duelWaveGate: the wave the plain duel sends is held in the band", () => {
  test("on at duelWaveRatio 2.0, us/foe 1.86×: no wave, the held log and the fired counter; the duel itself stays on", async () => {
    const { h, pin } = await fixture({ duelWaveGate: true, duelWaveRatio: 2.0 }, 0.35);
    drive(h, 310, pin);
    expect(attackLine(h)).toBeNull();
    expect(h.me.outgoingAttacks().length).toBe(0);
    expect(heldLine(h)).toMatch(/DUEL wave held: 1\.\d\d× in the 1–2× band/);
    expect(h.bot.fired.get("duelWaveGate")).toBeGreaterThanOrEqual(1); // it blocked a wave the plain duel sends below
    // the diplomacy half is untouched: the duel is on (push mode) and the foe is still the foe
    expect(h.log.find((l) => l.includes("DUEL vs"))).toMatch(/DUEL vs Foe/);
    expect(h.log.find((l) => l.includes("FINISH mode"))).toMatch(/FINISH mode grow → push: .*duel vs Foe/);
  });

  test("off, the same fixture: the plain duel all-in goes — 1.00× the foe's army, every troop above the reserve", async () => {
    const { h, pin } = await fixture({}, 0.35);
    drive(h, 310, pin);
    const line = attackLine(h);
    expect(line).toMatch(/ATTACK Foe \d+t\/\d+k ← \d+k \((0\.9\d|1\.00)×\)/); // the transcript's own-goal shape (whole-or-nothing lets the room trim it to ≥ 0.9×)
    expect(heldLine(h)).toBeNull();
    expect(h.bot.fired.get("duelWaveGate")).toBeUndefined();
  });

  test("on, us/foe 2.17× ≥ the 2.0 gate: the wave goes with the flag on too, nothing held or fired", async () => {
    const { h, foe, pin } = await fixture({ duelWaveGate: true, duelWaveRatio: 2.0 }, 0.3);
    drive(h, 60, pin);
    expect(attackLine(h)).toMatch(/ATTACK Foe \d+t\/\d+k ← \d+k \((0\.9\d|1\.00)×\)/);
    expect(h.until(() => h.me.outgoingAttacks().some((a) => a.target() === foe), 40)).toBe(true);
    expect(heldLine(h)).toBeNull();
    expect(h.bot.fired.get("duelWaveGate")).toBeUndefined();
  });
});

describe("duelWaveGate: the 1.0–1.2× band at the default duelWaveRatio", () => {
  test("on, us/foe 1.08×: the opportunity is stripped (logged) while diplomacy still refuses the foe — but the plain wave would not have gone either, so nothing fires", async () => {
    const { h, foe, pin } = await fixture({ duelWaveGate: true }, 0.6);
    drive(h, 310, pin); // through the t300 alliance pass
    expect(attackLine(h)).toBeNull();
    expect(heldLine(h)).toMatch(/DUEL wave held: 1\.\d\d× in the 1–1\.2× band/);
    expect(h.bot.fired.get("duelWaveGate")).toBeUndefined(); // maxSend 0.455C < 1.0 × 0.60C: no wave was blocked
    // diplomacy keeps the duelRatio threshold: no request to the foe, its peace offer refused
    expect(foe.incomingAllianceRequests().some((r) => r.requestor() === h.me)).toBe(false);
    expect(h.log.some((l) => /DUEL: no alliance request to Foe/.test(l))).toBe(true);
    h.game.addExecution(new AllianceRequestExecution(foe, h.me.id())); // the foe sues for peace
    drive(h, 340, pin);
    expect(h.me.isAlliedWith(foe)).toBe(false);
    expect(h.log.some((l) => /DUEL: no alliance with Foe/.test(l))).toBe(true);
  });

  test("off, the same fixture: byte-for-byte the plain duel — and the plain wave indeed never goes at 1.08× (the 0.7 maxSend already gates it)", async () => {
    const { h, pin } = await fixture({}, 0.6);
    drive(h, 310, pin);
    expect(attackLine(h)).toBeNull(); // score 0.455C/0.60C = 0.76 < duelRatio 1.0 — the base behaviour the header documents
    expect(heldLine(h)).toBeNull();
    expect(h.bot.fired.get("duelWaveGate")).toBeUndefined();
  });
});

describe("duelWaveGate: below duelRatio there is no duel either way", () => {
  test("on, us/foe 0.93×: no duel, no war, no held log, nothing fires", async () => {
    const { h, pin } = await fixture({ duelWaveGate: true }, 0.7);
    drive(h, 310, pin);
    expect(attackLine(h)).toBeNull();
    expect(h.log.some((l) => l.includes("DUEL"))).toBe(false);
    expect(heldLine(h)).toBeNull();
    expect(h.bot.fired.get("duelWaveGate")).toBeUndefined();
    expect(h.bot.fired.get("duelPush")).toBeUndefined();
  });
});
