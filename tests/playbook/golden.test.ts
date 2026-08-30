// Golden test: the bot on `big_plains` against three real nations (NationExecution, Medium) and a weak scripted human for 2400 ticks (4:00)
// with a fixed seed — past fightNotBeforeTick (3:00), so the material covers the opening, tribe-free expansion,
// posts, alliances and the first war. The simulation is deterministic, so the bot's log, its per-flag `fired`
// counters, and every player's tiles / troops / gold every 300 ticks hash to one constant. A pure refactor of the bot must leave GOLDEN unchanged; a behaviour change updates it
// in the same PR and says why (docs/PlaybookBotPlan.md, ground rule 3).
//
// Regenerate:   GOLDEN=1 npx vitest tests/playbook/golden.test.ts --run
// The run prints the new hash and the snapshot behind it to stderr and passes; paste the hash into GOLDEN below.
import { createHash } from "crypto";
import { describe, expect, test } from "vitest";
import { PlayerType } from "../../src/core/game/Game";
import { playbookSetup } from "../util/PlaybookSetup";

const GOLDEN =
  "0543927031e0ec8d52d85cc88b863084f03f610b3b52c1d3167de80e5719c09c";
const SNAPSHOT_TICKS = [100, 300, 600, 900, 1200, 1500, 1800, 2100, 2400];

describe("golden", () => {
  test("bot log, fired counters and all players' state on big_plains vs three nations, 2400 ticks", async () => {
    const h = await playbookSetup({
      map: "big_plains",
      spawn: [100, 100],
      rivals: [
        { name: "North", type: PlayerType.Nation, at: [60, 40], ai: true },
        { name: "East", type: PlayerType.Nation, at: [170, 110], ai: true },
        { name: "South", type: PlayerType.Nation, at: [90, 170], ai: true },
        // a weak scripted human next door: never allied (the bot only asks players >= half its size), so the
        // war rules (prey, posts, waves, retreats) run inside the golden window
        { name: "West", type: PlayerType.Human, at: [45, 100], tiles: [25, 85, 60, 115], troops: 15_000 },
      ],
    });
    for (const r of h.rivals) expect(r.numTilesOwned()).toBeGreaterThan(0);
    const snaps: string[] = [];
    for (const t of SNAPSHOT_TICKS) {
      h.step(t - h.game.ticks());
      const players = [h.me, ...h.rivals]
        .map((p) => `${p.name()}:${p.numTilesOwned()}/${Math.round(p.troops())}/${p.gold()}`)
        .join(" ");
      snaps.push(`t${t} ${players} out=${h.me.outgoingAttacks().length} allies=${h.me.allies().length}`);
    }
    const fired = [...h.bot.fired].map(([k, v]) => `${k}:${v}`).join(",");
    const material = [...h.log, `fired=${fired}`, ...snaps].join("\n");
    const hash = createHash("sha256").update(material).digest("hex");
    if (process.env.GOLDEN === "1") {
      process.stderr.write(`\n${material}\n\nGOLDEN = "${hash}"\n`);
      return;
    }
    expect(h.log.length).toBeGreaterThan(0);
    expect(hash).toBe(GOLDEN);
  });
});
