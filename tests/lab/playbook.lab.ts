// Playbook lab: runs PlaybookBotExecution against nations + tribes on the World map.
// Not a correctness test — a harness. Two entry points share this module:
//   node --import tsx tests/lab/playbook.lab.ts       (bare node; what sweep.sh runs)
//   npx vitest --dir tests tests/lab/playbook.lab.test.ts --run   (same game under vitest)
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PlaybookBotExecution as CurrentBot, PlaybookParams } from "../../src/core/execution/playbook/PlaybookBotExecution";
import { Difficulty, Player, PlayerType, UnitType } from "../../src/core/game/Game";
import { genTerrainFromBin } from "../../src/core/game/TerrainMapLoader";
import { UserSettings } from "../../src/core/game/UserSettings";
import { buildLabGame, HeadlessLabConfig, LAB_REGIONS, labGameConfig, LabSpec, LabWorld } from "../../src/core/lab/LabReplay";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
// The bot under test: today's src/core/execution/playbook by default; BOT_DIR=<dir> (or PARAMS {"__bot":"<tag>"}
// = .history/<tag>/src/core/execution/playbook, scripts/lab/history.sh) loads an extracted milestone bot against
// today's engine so a sweep can play several bot versions on one grid (scripts/lab/versions/HISTORY.md).
type BotModule = typeof import("../../src/core/execution/playbook/PlaybookBotExecution");
let Bot: BotModule;
let botDir = "";
async function loadBot(dir: string | undefined): Promise<void> {
  botDir = dir ?? "";
  Bot = dir ? ((await import(path.resolve(ROOT, dir, "PlaybookBotExecution.ts"))) as BotModule)
            : await import("../../src/core/execution/playbook/PlaybookBotExecution");
}
const OUT = process.env.LAB_OUT ? process.env.LAB_OUT.replace(/\/?$/, "/") : "/private/tmp/claude-501/-Users-josh-Code-openfront/f46e4d3b-aecb-4e40-bb41-205a4bfbadb7/scratchpad/";

async function loadWorld(): Promise<LabWorld> {
  // terrain from the test bins; nations from the REAL manifest (the client's map loader serves the same file,
  // so a `replay:` recipe rebuilds the identical world in the GUI — src/core/lab/LabReplay.ts)
  const dir = path.join(__dirname, "../testdata/maps/world");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const gameMap = await genTerrainFromBin(manifest.map, fs.readFileSync(path.join(dir, "map.bin")));
  const miniMap = await genTerrainFromBin(manifest.map4x, fs.readFileSync(path.join(dir, "map4x.bin")));
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "../../resources/maps/world/manifest.json"), "utf8"));
  return { gameMap, miniMap, nations: real.nations };
}

let spawnNote = "";

/** The env assignments that fully determine this game (see the `replay:` line). PARAMS is the verbatim env value
 *  (it carries __bot); LAB_OUT/OUTFILE/TAG are output-only and left to the caller. */
function replayRecipe(spawn: string): string {
  const parts: string[] = [];
  for (const k of ["MIN", "DIFF", "GLOBAL", "SPAWNRANK", "SHIFT", "SEED", "TRIBES", "EXPAND", "EVERY", "BOT_DIR"]) {
    const v = process.env[k];
    if (v !== undefined && v !== "") parts.push(`${k}=${v}`);
  }
  parts.push(`SPAWN=${spawn}`);
  if (process.env.PARAMS) parts.push(`PARAMS='${process.env.PARAMS}'`);
  return parts.join(" ");
}
function neighboursBots(me: Player): string { return me.nearby().filter((n): n is Player => n.isPlayer() && n.type() === PlayerType.Bot).map((b) => Math.round(b.troops() / 1000) + "k/" + b.numTilesOwned() + "t").join(" ") || "-"; }
async function runGame(label: string, params: PlaybookParams, minutes: number, difficulty: Difficulty, prefer: [number, number]) {
  // Common random numbers (scripts/lab/sweep.sh MIRROR/SPRT): the whole game derives from the spec — see
  // src/core/lab/LabReplay.ts (shared with the client's ?labreplay mode), which keeps the exact assembly order.
  const spec: LabSpec = {
    minutes, difficulty, global: process.env.GLOBAL === "1", spawnRank: Number(process.env.SPAWNRANK ?? 0),
    region: label, prefer, seed: process.env.SEED ?? "",
    tribes: process.env.TRIBES ? Number(process.env.TRIBES) : 400, // online default
    params,
  };
  const world = await loadWorld();
  // a milestone bot without the exclude parameter (before 1926105b6) cannot walk the ranks: use today's picker
  const own = typeof Bot.PlaybookBotExecution.pickSpawn === "function" && Bot.PlaybookBotExecution.pickSpawn.length >= 3;
  const picker = own ? Bot.PlaybookBotExecution : CurrentBot;
  const { game, me, bot, spawn, rank: pickRank, excludeRadius } = buildLabGame(spec, world, null, Bot.PlaybookBotExecution, picker, new HeadlessLabConfig(labGameConfig(spec), new UserSettings(), false));
  spawnNote = (spec.global ? `global rank ${pickRank}` : `bot picker rank ${pickRank}`) + (excludeRadius !== 120 ? `, exclude ${excludeRadius}` : "") + (botDir ? `, bot ${botDir}${own ? "" : ", today's picker"}` : "");
  let botMs = 0; const origTick = bot.tick.bind(bot); bot.tick = (t: number) => { const s0 = performance.now(); origTick(t); botMs += performance.now() - s0; }; // wrapped before the first loop tick; buildLabGame already attached bot + WinCheck
  const rows: string[] = [`== ${label} | spawn ${game.x(spawn)},${game.y(spawn)} (${spawnNote}) | ${difficulty} ==`];
  // The sim is deterministic, so this env recipe IS the whole game: re-running it replays every tick bit-identically
  // (same engine commit — an engine change invalidates old replays). aggregate.sh drops the line from ab30 files;
  // it lives in p_*.txt for `summarize.py --replays` (the exceptional games worth watching again).
  rows.push(`  replay: ${replayRecipe(label)} node --import tsx tests/lab/playbook.lab.ts`);
  const ticks = minutes * 600; // MIN=full → 170 (WinCheckExecution's hard limit): the game runs until someone wins
  let allMs = 0;
  for (let t = 0; t < ticks; t++) {
    const s0 = performance.now(); game.executeNextTick(); allMs += performance.now() - s0;
    if (!me.isAlive()) { rows.push(`  DEAD at ${(t / 10).toFixed(0)}s`); break; }
    const w = game.getWinner();
    if (w !== null) { rows.push(`  WINNER ${typeof w === "string" ? w : w.name()} at ${(t / 10).toFixed(0)}s (${w === me ? "us" : "not us"})`); break; }
    if ((t + 1) % 300 === 0) {
      const ranked = game.players().filter((p) => p.type() !== PlayerType.Bot).sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
      const rank = ranked.findIndex((p) => p === me) + 1; const share = (me.numTilesOwned() / Math.max(1, ranked[0]?.numTilesOwned() ?? 1)).toFixed(2);
      const bots = game.players().filter((p) => p.type() === PlayerType.Bot && p.isAlive()); const bt = bots.reduce((a, b) => a + b.troops(), 0) / Math.max(1, bots.length); const bl = bots.reduce((a, b) => a + b.numTilesOwned(), 0) / Math.max(1, bots.length); const nb = neighboursBots(me); rows.push(`  ${String((t + 1) / 10).padStart(4)}s bots=${bots.length} botTroops=${Math.round(bt)} botTiles=${Math.round(bl)} nearBotTroops=${nb} tiles=${String(me.numTilesOwned()).padStart(6)} troops=${String(Math.round(me.troops() / 1000)).padStart(5)}k cap=${String(Math.round(game.config().maxTroops(me) / 1000)).padStart(5)}k gold=${String(Math.round(Number(me.gold()) / 1000)).padStart(6)}k cities=${me.unitsOwned(UnitType.City)} ports=${me.unitsOwned(UnitType.Port)} dp=${me.unitsOwned(UnitType.DefensePost)} allies=${me.alliances().length} rank=${rank}/${ranked.length} share=${share}`);
    }
  }
  const ranked = game.players().filter((p) => p.type() !== PlayerType.Bot && p.isAlive()).sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  const rank = ranked.findIndex((p) => p === me) + 1; const leader = ranked[0]?.numTilesOwned() ?? 1;
  rows.push(`  FINAL rank=${rank || 99} share=${(me.numTilesOwned() / Math.max(1, leader)).toFixed(2)} botMs=${Math.round(botMs)} gameMs=${Math.round(allMs)} alive=${me.isAlive()} tiles=${me.numTilesOwned()} troops=${Math.round(me.troops()/1000)}k cities=${me.unitsOwned(UnitType.City)} ports=${me.unitsOwned(UnitType.Port)} factories=${me.unitsOwned(UnitType.Factory)} silos=${me.unitsOwned(UnitType.MissileSilo)} sams=${me.unitsOwned(UnitType.SAMLauncher)} bombs=${bot.bombs} trainGold=${Math.round(Number(me.trainGold())/1000)}k gold=${Math.round(Number(me.gold())/1000)}k winner=${game.getWinner() === null ? "none" : game.getWinner() === me ? "us" : "other"} players=${game.players().filter((p) => p.type() !== PlayerType.Bot).length} fired=${[...(bot.fired ?? [])].map(([k, v]) => `${k}:${v}`).join(",")} mirvsTaken=${bot.mirvsTaken ?? 0}`);
  rows.push("  log: " + bot.log.join(" | "));
  return rows.join("\n");
}

/** One lab run: the configured spawns (env SPAWN filters), MIN minutes, PARAMS overrides; writes LAB_OUT/OUTFILE. */
export async function runLab(): Promise<void> {
  const out: string[] = [];
  const spawns = LAB_REGIONS;
  const o = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {};
  await loadBot(botDirFromEnv(o));
  delete o.__bot;
  const { DEFAULT_PLAYBOOK } = Bot;
  const params: PlaybookParams = { ...DEFAULT_PLAYBOOK };
  if (process.env.EXPAND) { params.expandContested = Number(process.env.EXPAND); params.expandFree = Number(process.env.EXPAND) / 2; }
  if (process.env.EVERY) params.expandEvery = Number(process.env.EVERY);
  if (process.env.PARAMS) { Object.assign(params, o); if (o.spawnInland !== undefined) DEFAULT_PLAYBOOK.spawnInland = o.spawnInland; }
  const minutes = process.env.MIN === "full" ? 170 : process.env.MIN ? Number(process.env.MIN) : 20;
  if (process.env.MIN === "full" && o.clockTicks === undefined) params.clockTicks = 0; // open-ended: the 25:00 posture must not freeze for 145 minutes (PlaybookParams.clockTicks)
  const shift = Number(process.env.SHIFT ?? 0);
  for (const [name, pref0] of spawns) { const pref: [number, number] = [pref0[0] + shift, pref0[1] + shift]; if (process.env.SPAWN && process.env.SPAWN !== name) continue; out.push(await runGame(name, params, minutes, process.env.DIFF === "medium" ? Difficulty.Medium : Difficulty.Hard, pref)); fs.writeFileSync(OUT + (process.env.OUTFILE ?? "lab_v10.txt"), out.join("\n\n")); }
  fs.writeFileSync(OUT + "lab_baseline.txt", out.join("\n\n"));
}

/** BOT_DIR, or .history/<tag>/... for PARAMS {"__bot": tag}; undefined = today's bot. */
function botDirFromEnv(params: { __bot?: string }): string | undefined {
  return params.__bot !== undefined ? `.history/${params.__bot}/src/core/execution/playbook` : process.env.BOT_DIR;
}

// Bare-node entry (no vitest: ~2 s less startup a game and no path-filter foot-guns).
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // An extracted bot needs tsx to compile it with the repo's compiler options (useDefineForClassFields: false —
  // see history.sh), which tsx only applies inside its tsconfig's include: re-exec once with TSX_TSCONFIG_PATH
  // pointing at .history/<tag>/tsconfig.json.
  const dir = botDirFromEnv(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {});
  const tsconfig = dir !== undefined ? path.join(dir, "../../../../tsconfig.json") : undefined;
  if (tsconfig !== undefined && process.env.TSX_TSCONFIG_PATH === undefined && fs.existsSync(tsconfig)) {
    const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig } });
    process.exit(r.status ?? 1);
  }
  await runLab();
}
