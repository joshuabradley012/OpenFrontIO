// Spawn-slot dedupe check: runs the lab spawn picker (src/core/lab/LabReplay.ts pickLabSpawn) for every
// (batch, region) slot of the standard full-game grid — 6 regions × med0–med9, both mirror slots of
// scripts/lab/sweep.sh (slot a: SHIFT=0 SEED='', slot b: SHIFT=150 SEED='b', its MIRRORSHIFT/MIRRORSEED
// defaults) — prints the spawn table and asserts every slot of one mirror slot (one shared world: games
// that cannot see each other) picks a pairwise-distinct tile. A slot the region cannot fill (australia at
// high ranks) may throw "no spawn near"; that is allowed and printed as '-'.
//
//   node --import tsx tests/lab/spawn_dedupe.lab.ts
//
// Exits 1 when any two slots of one mirror slot collapse onto the same tile (what happened in rm1:
// docs/PlaybookBotPlan.md "rm1", loss_analysis.py REPLICATES).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULT_PLAYBOOK, PlaybookBotExecution } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Difficulty, Game } from "../../src/core/game/Game";
import { genTerrainFromBin } from "../../src/core/game/TerrainMapLoader";
import { LAB_REGIONS, LabSpec, LabWorld, labReplaySteps, pickLabSpawn } from "../../src/core/lab/LabReplay";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadWorld(): Promise<LabWorld> {
  // terrain from the test bins; nations from the REAL manifest — same as tests/lab/playbook.lab.ts
  const dir = path.join(__dirname, "../testdata/maps/world");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const gameMap = await genTerrainFromBin(manifest.map, fs.readFileSync(path.join(dir, "map.bin")));
  const miniMap = await genTerrainFromBin(manifest.map4x, fs.readFileSync(path.join(dir, "map4x.bin")));
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "../../resources/maps/world/manifest.json"), "utf8"));
  return { gameMap, miniMap, nations: real.nations };
}

function spec(region: string, rank: number, shift: number, seed: string): LabSpec {
  const pref0 = LAB_REGIONS.find(([n]) => n === region)![1];
  return {
    minutes: 170, difficulty: Difficulty.Medium, global: false, spawnRank: rank, region,
    prefer: [pref0[0] + shift, pref0[1] + shift], seed, tribes: 400, params: { ...DEFAULT_PLAYBOOK },
  };
}

/** The world of one mirror slot at the pick moment: nations + tribes placed (3 ticks), no spawn taken.
 *  All 60 slots of the mirror slot pick from this one state — pickLabSpawn does not mutate the game.
 *  The world is loaded fresh per slot: GameImpl writes ownership into the GameMap, so a second game on the
 *  same LabWorld would inherit the first slot's tiles (the real lab loads the world fresh per game too). */
async function worldAtPick(shift: number, seed: string): Promise<Game> {
  const steps = labReplaySteps(spec(LAB_REGIONS[0][0], 0, shift, seed), await loadWorld());
  for (let i = 0; i < 3; i++) steps.game.executeNextTick();
  return steps.game;
}

let failures = 0;
for (const [slot, shift, seed] of [["a", 0, ""], ["b", 150, "b"]] as [string, number, string][]) {
  const game = await worldAtPick(shift, seed);
  const picks = new Map<string, string[]>(); // "x,y" -> slot names
  console.log(`\n== mirror slot ${slot} (SHIFT=${shift} SEED='${seed}') ==`);
  console.log(["batch".padEnd(6), ...LAB_REGIONS.map(([n]) => n.padEnd(14))].join(" "));
  for (let rank = 0; rank <= 9; rank++) {
    const row = [`med${rank}${slot === "b" ? "b" : ""}`.padEnd(6)];
    for (const [region] of LAB_REGIONS) {
      let cell = "-";
      try {
        const { tile } = pickLabSpawn(game, spec(region, rank, shift, seed), PlaybookBotExecution);
        cell = `${game.x(tile)},${game.y(tile)}`;
        const names = picks.get(cell) ?? [];
        names.push(`med${rank}${slot === "b" ? "b" : ""} ${region}`);
        picks.set(cell, names);
      } catch {
        // "no spawn near": the region has no spawn at this rank — an empty slot is allowed
      }
      row.push(cell.padEnd(14));
    }
    console.log(row.join(" "));
  }
  const dups = [...picks.entries()].filter(([, names]) => names.length > 1);
  for (const [tile, names] of dups) console.log(`COLLAPSED: ${tile} shared by ${names.join(", ")}`);
  failures += dups.length;
  const n = [...picks.values()].reduce((a, v) => a + v.length, 0);
  console.log(dups.length === 0 ? `slot ${slot}: all ${n} filled slots pairwise distinct` : `slot ${slot}: ${dups.length} collapsed tiles`);
}
if (failures > 0) { console.error(`\nFAIL: ${failures} collapsed spawn tiles`); process.exit(1); }
console.log("\nOK: no two slots of a mirror slot share a spawn tile");
