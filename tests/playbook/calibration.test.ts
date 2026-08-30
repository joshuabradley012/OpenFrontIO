// Calibration logging (#4, always on): every war wave and every tribe's first click logs an EST line with the
// estimator's prediction, and an ACT line with what happened when the attack is gone. The two carry the same
// wave number so scripts/lab/calibrate.py can pair them.
import { describe, expect, test } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup, Rect } from "../util/PlaybookSetup";

const ME: Rect = [30, 25, 70, 57];
const RV: Rect = [30, 58, 70, 90];

const EST = /^t(\d+) EST (.+?) wave=(\d+) troops=(\d+) tilesEst=(\d+) lossEst=(\d+) ticksEst=(\d+) wins=(true|false) class=(nation|human|bot) others=(\d+)$/;
const ACT = /^t(\d+) ACT (.+?) wave=(\d+) tiles=(\d+) ours=(-?\d+) loss=(\d+) ticks=(\d+) sent=(\d+) left=(\d+) class=(nation|human|bot) end=(dead|retreat|done|fast)$/;

describe("calibration log", () => {
  test("a war wave logs EST at the send and ACT when the attack is gone, paired by wave number", async () => {
    const h = await playbookSetup({
      spawn: [50, 40],
      tiles: ME,
      troops: 200_000,
      bot: { fightNotBeforeTick: 0, fightMinCities: 0 },
      rivals: [{ name: "R", type: PlayerType.Human, at: [50, 75], tiles: RV, troops: 30_000 }],
    });
    expect(h.until(() => h.log.some((l) => EST.test(l)), 200)).toBe(true);
    const est = EST.exec(h.log.find((l) => EST.test(l))!)!;
    expect(est[2]).toBe("R");
    expect(est[9]).toBe("human");
    expect(Number(est[4])).toBeGreaterThan(0);
    expect(Number(est[5])).toBeGreaterThan(0);
    expect(h.until(() => h.log.some((l) => ACT.test(l)), 3000)).toBe(true);
    const act = ACT.exec(h.log.find((l) => ACT.test(l))!)!;
    expect(act[2]).toBe("R");
    expect(act[3]).toBe(est[3]); // same wave number
    expect(act[10]).toBe("human");
    expect(Number(act[8])).toBe(Number(est[4])); // sent = the wave's troops
    expect(Number(act[7])).toBeGreaterThan(0); // ticks
    expect(Number(act[7])).toBe(Number(act[1]) - Number(est[1]));
    expect(Number(act[6])).toBeLessThanOrEqual(Number(act[8])); // loss ≤ sent
    // exactly one record per wave: no second ACT for the same wave number
    expect(h.log.filter((l) => ACT.test(l) && ACT.exec(l)![3] === est[3]).length).toBe(1);
  });

  test("a tribe's first click logs EST class=bot; follow-up clicks add to the same record", async () => {
    const h = await playbookSetup({
      spawn: [50, 40],
      tiles: ME,
      troops: 60_000,
      bot: { botsAfterWild: false },
      rivals: [{ name: "T", type: PlayerType.Bot, at: [50, 75], tiles: [40, 60, 60, 80], troops: 8_000 }],
    });
    expect(h.until(() => h.log.some((l) => l.includes("EST T")), 600)).toBe(true);
    const est = EST.exec(h.log.find((l) => l.includes("EST T"))!)!;
    expect(est[9]).toBe("bot");
    expect(h.log.filter((l) => l.includes("EST T")).length).toBe(1);
    expect(h.until(() => h.log.some((l) => l.includes("ACT T")), 3000)).toBe(true);
    const act = ACT.exec(h.log.find((l) => l.includes("ACT T"))!)!;
    expect(act[3]).toBe(est[3]);
    expect(act[10]).toBe("bot");
    expect(Number(act[8])).toBeGreaterThanOrEqual(Number(est[4])); // follow-ups add to sent
  });
});
