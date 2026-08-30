// src/core/lab/LabReplay.ts — the shared lab bootstrap behind a transcript's `replay:` recipe (headless lab)
// and the dev-only client lab-replay mode (?labreplay / localStorage.labReplay → GameRunner labReplay flag).
//   - parseReplayRecipe applies exactly runLab's env derivations, and rejects what the client cannot honour.
//   - buildLabGame is deterministic: the same spec twice gives the same spawn and world.
//   - GameRunner in labReplay mode is watch-only: turn intents are dropped, init() adds nothing.
// Transcript parity of the refactor itself is checked by hand with the replay-diff method (byte-identical
// MIN=1 game before/after, 2026-08-30); this file pins the pieces the client relies on.
import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import { Executor } from "../src/core/execution/ExecutionManager";
import { Difficulty, Game } from "../src/core/game/Game";
import { genTerrainFromBin } from "../src/core/game/TerrainMapLoader";
import { GameRunner } from "../src/core/GameRunner";
import { buildLabGame, LAB_REGIONS, labReplaySteps, LabWorld, parseReplayRecipe } from "../src/core/lab/LabReplay";

const RECIPE = "MIN=20 DIFF=medium SPAWNRANK=2 SHIFT=150 SEED=b SPAWN=africa PARAMS='{\"multiWar\":false}' node --import tsx tests/lab/playbook.lab.ts";

async function loadWorld(): Promise<LabWorld> {
  const dir = path.join(__dirname, "testdata/maps/world");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const gameMap = await genTerrainFromBin(manifest.map, fs.readFileSync(path.join(dir, "map.bin")));
  const miniMap = await genTerrainFromBin(manifest.map4x, fs.readFileSync(path.join(dir, "map4x.bin")));
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "../resources/maps/world/manifest.json"), "utf8"));
  return { gameMap, miniMap, nations: real.nations };
}

describe("parseReplayRecipe", () => {
  test("a replay: line round-trips into the spec runLab would have built", () => {
    const spec = parseReplayRecipe("replay: " + RECIPE);
    expect(spec.minutes).toBe(20);
    expect(spec.difficulty).toBe(Difficulty.Medium);
    expect(spec.spawnRank).toBe(2);
    expect(spec.global).toBe(false);
    expect(spec.region).toBe("africa");
    expect(spec.prefer).toEqual([1100 + 150, 550 + 150]); // region centre + SHIFT
    expect(spec.seed).toBe("b");
    expect(spec.tribes).toBe(400); // online default
    expect(spec.params.multiWar).toBe(false); // PARAMS merged over DEFAULT_PLAYBOOK
    expect(spec.params.clockTicks).toBe(18000); // MIN=20: the clock stays
  });

  test("MIN=full is 170 minutes with no clock; a PARAMS clockTicks wins; EXPAND/EVERY apply", () => {
    const full = parseReplayRecipe("MIN=full DIFF=medium SPAWN=africa EXPAND=0.3 EVERY=20");
    expect(full.minutes).toBe(170);
    expect(full.params.clockTicks).toBe(0);
    expect(full.params.expandContested).toBe(0.3);
    expect(full.params.expandFree).toBe(0.15);
    expect(full.params.expandEvery).toBe(20);
    const pinned = parseReplayRecipe("MIN=full SPAWN=africa PARAMS='{\"clockTicks\":12000}'");
    expect(pinned.params.clockTicks).toBe(12000);
    expect(pinned.difficulty).toBe(Difficulty.Hard); // no DIFF = Hard, as runLab
  });

  test("GLOBAL rank walks the whole map at SPAWNRANK*6 + region index", () => {
    const spec = parseReplayRecipe("GLOBAL=1 DIFF=medium SPAWNRANK=2 SPAWN=east-asia");
    expect(spec.global).toBe(true);
    expect(LAB_REGIONS[2][0]).toBe("east-asia");
  });

  test("recipes the client cannot honour are refused with a pointer to the headless re-run", () => {
    expect(() => parseReplayRecipe("MIN=20 SPAWN=africa PARAMS='{\"__bot\":\"v3\"}'")).toThrow(/milestone-bot/);
    expect(() => parseReplayRecipe("MIN=20 BOT_DIR=.history/v3 SPAWN=africa")).toThrow(/BOT_DIR/);
    expect(() => parseReplayRecipe("MIN=20 SPAWN=atlantis")).toThrow(/unknown SPAWN region/);
  });
});

describe("buildLabGame + GameRunner labReplay (watch-only)", () => {
  test("deterministic bootstrap; intents are dropped so a click cannot fork the recorded game", async () => {
    const spec = parseReplayRecipe("MIN=1 DIFF=medium SPAWNRANK=0 SPAWN=africa");
    const a = buildLabGame(spec, await loadWorld(), "viewer_client");
    const b = buildLabGame(spec, await loadWorld(), "viewer_client"); // the control below needs the intent to resolve to a player
    expect(a.spawn).toBe(b.spawn); // same spec, same world, same spawn (clientID is sim-inert: transcript-diff-verified 2026-08-30)
    expect(a.me.id()).toBe("playbook");
    expect(a.game.playerByClientID("viewer_client")).toBe(a.me); // the HUD's "me" is the bot's player
    expect(a.game.ticks()).toBe(6);
    expect(a.game.inSpawnPhase()).toBe(false);
    expect(a.me.numTilesOwned()).toBeGreaterThan(0);

    // the client path: GameRunner drives the whole bootstrap through its turn loop (the spawn at tick 3,
    // endSpawnPhase + bot at tick 6 — pre-ticking would eat the first full player-update emission the view
    // needs), and every turn's intents are dropped
    const steps = labReplaySteps(parseReplayRecipe("MIN=1 DIFF=medium SPAWNRANK=0 SPAWN=africa"), await loadWorld(), "viewer_client");
    const gr = new GameRunner(steps.game, new Executor(steps.game, steps.gameID, "viewer_client"), () => {}, undefined, steps.gameID, undefined, steps);
    gr.init();
    let turn = 0;
    const tick = (intents: boolean) => {
      // the viewer clicks an attack every turn — none of it may reach the sim
      gr.addTurn({ turnNumber: turn++, intents: intents ? [{ type: "attack", clientID: "viewer_client", targetID: null, troops: 5000 } as never] : [] });
      gr.executeNextTick();
    };
    for (let i = 0; i < 9; i++) tick(true);
    const stepped = steps.game.playerByClientID("viewer_client")!;
    expect(steps.game.ticks()).toBe(9);
    expect(steps.game.inSpawnPhase()).toBe(false); // ended by finish() at tick 6
    expect(stepped.id()).toBe("playbook");
    expect(stepped.numTilesOwned()).toBeGreaterThan(0);
    expect(stepped.spawnTile()).toBe(a.spawn); // the turn-driven bootstrap picks the same spawn as the lab's
    expect(stepped.outgoingAttacks().length).toBe(0); // every click dropped (the bot itself acts later than tick 9)

    const run = (lab: { game: Game; gameID: string }) => {
      const gr2 = new GameRunner(lab.game, new Executor(lab.game, lab.gameID, "viewer_client"), () => {}, undefined, lab.gameID);
      gr2.init();
      let t2 = 0;
      return () => {
        gr2.addTurn({ turnNumber: t2++, intents: [{ type: "attack", clientID: "viewer_client", targetID: null, troops: 5000 } as never] });
        gr2.executeNextTick();
      };
    };
    const tickB = run(b);
    for (let i = 0; i < 3; i++) tickB();
    expect(b.me.outgoingAttacks().length).toBeGreaterThan(0); // control: without the lab-replay runner the click lands
  });
});
