// The lab game as a shared, deterministic bootstrap. tests/lab/playbook.lab.ts (the headless lab) and the
// dev-only client lab-replay mode (GameRunner + ?labreplay / localStorage.labReplay) build their world through
// the SAME code here, so a transcript's `replay:` recipe re-creates the game bit-identically in either place —
// same engine commit, since any simulation change invalidates old recipes.
//
// A lab game is fully determined by its recipe (docs/PlaybookBotLab.md "Replays"): the seeded world
// (gameID "lab"+SEED drives nations, tribes and the bot), the spawn walk (SPAWN region / SPAWNRANK / GLOBAL /
// SHIFT), the params (PARAMS / EXPAND / EVERY, MIN=full → clockTicks 0) and TRIBES. Keep this file's game
// assembly in exact statement order — execution scheduling and PRNG draws depend on it.

import {
  AttackLogicInput,
  AttackLogicResult,
  Config,
} from "../configuration/Config";
import { NationExecution } from "../execution/NationExecution";
import {
  DEFAULT_PLAYBOOK,
  PlaybookBotExecution,
  PlaybookParams,
} from "../execution/playbook/PlaybookBotExecution";
import { SpawnExecution } from "../execution/SpawnExecution";
import { TribeSpawner } from "../execution/TribeSpawner";
import { WinCheckExecution } from "../execution/WinCheckExecution";
import {
  Cell,
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../game/Game";
import { createGame } from "../game/GameImpl";
import { GameMap, TileRef } from "../game/GameMap";
import { Nation as ManifestNation } from "../game/TerrainMapLoader";
import { UserSettings } from "../game/UserSettings";
import { GameConfig } from "../Schemas";
import { TestConfig } from "./TestConfig";

/** The lab's config: TestConfig (instant/cheap test knobs) with the production combat maths, blast radii and
 *  SAM ranges restored — what every lab result was measured under. Moved here from tests/lab/playbook.lab.ts. */
export class LabConfig extends TestConfig {
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    return Config.prototype.attackLogic.call(this, input);
  }
  disableNavMesh(): boolean {
    return false;
  }
  radiusPortSpawn(): number {
    return 20;
  }
  deletionMarkDuration(): number {
    return 300;
  }
  nukeMagnitudes(t: UnitType) {
    return Config.prototype.nukeMagnitudes.call(this, t);
  }
  nukeSpeed(t: UnitType) {
    return Config.prototype.nukeSpeed.call(this, t);
  }
  defaultSamRange(): number {
    return 70;
  }
  samRange(level: number): number {
    return Config.prototype.samRange.call(this, level);
  }
  defaultNukeTargetableRange(): number {
    return 150;
  }
  /** The headless lab overrides this to true; the client replay keeps render updates on. */
  headless(): boolean {
    return false;
  }
}

export class HeadlessLabConfig extends LabConfig {
  headless(): boolean {
    return true;
  } // no render updates / sync hash: ~5 % of a game, no effect on the sim
}

/** The six spawn regions of the standard grid, in batch order (SPAWNRANK's GLOBAL walk indexes this order). */
export const LAB_REGIONS: [string, [number, number]][] = [
  ["north-russia", [1200, 140]],
  ["north-america", [450, 300]],
  ["east-asia", [1600, 350]],
  ["africa", [1100, 550]],
  ["south-america", [620, 650]],
  ["australia", [1680, 660]],
];

export interface LabSpec {
  minutes: number;
  difficulty: Difficulty;
  global: boolean; // GLOBAL=1: the picker's k-th choice on the whole map, k = SPAWNRANK*6 + region index
  spawnRank: number;
  region: string; // a LAB_REGIONS name
  prefer: [number, number]; // the region's centre, SHIFT applied
  seed: string; // gameID = "lab" + seed
  tribes: number;
  params: PlaybookParams; // fully resolved: DEFAULT_PLAYBOOK + EXPAND/EVERY + PARAMS (+ MIN=full → clockTicks 0)
}

/** What buildLabGame needs of the world: terrain from the map bins and the RAW manifest nations
 *  (TerrainMapData.nations is exactly this; the lab reads resources/maps/world/manifest.json itself). */
export interface LabWorld {
  gameMap: GameMap;
  miniMap: GameMap;
  nations: ManifestNation[];
}

export interface LabSpawnPicker {
  pickSpawn(
    game: Game,
    prefer?: [number, number],
    exclude?: [number, number][],
    radius?: number,
  ): TileRef | null;
}

/** Parse a transcript's `replay:` line (tests/lab/playbook.lab.ts replayRecipe) back into the spec, applying
 *  exactly runLab's env derivations. Throws on a recipe the client cannot honour (BOT_DIR / __bot need that
 *  bot's code checked out) and on an unknown SPAWN region. */
export function parseReplayRecipe(recipe: string): LabSpec {
  const env: Record<string, string> = {};
  const re = /([A-Z_]+)=('[^']*'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(recipe.trim().replace(/^replay:\s*/, ""))) !== null) {
    env[m[1]] = m[2].startsWith("'") ? m[2].slice(1, -1) : m[2];
  }
  if (env.BOT_DIR)
    throw new Error(
      "lab replay: BOT_DIR recipes need that bot's code checked out — run it headless instead",
    );
  const o = env.PARAMS ? JSON.parse(env.PARAMS) : {};
  if (o.__bot !== undefined)
    throw new Error(
      `lab replay: a milestone-bot game (__bot ${o.__bot}) needs .history/${o.__bot} — run it headless instead`,
    );
  const params: PlaybookParams = { ...DEFAULT_PLAYBOOK };
  if (env.EXPAND) {
    params.expandContested = Number(env.EXPAND);
    params.expandFree = Number(env.EXPAND) / 2;
  }
  if (env.EVERY) params.expandEvery = Number(env.EVERY);
  if (env.PARAMS) {
    Object.assign(params, o);
    if (o.spawnInland !== undefined)
      DEFAULT_PLAYBOOK.spawnInland = o.spawnInland;
  } // runLab's global: the static picker reads DEFAULT_PLAYBOOK
  const minutes = env.MIN === "full" ? 170 : env.MIN ? Number(env.MIN) : 20;
  if (env.MIN === "full" && o.clockTicks === undefined) params.clockTicks = 0;
  const region = env.SPAWN ?? "";
  const pref0 = LAB_REGIONS.find(([n]) => n === region)?.[1];
  if (pref0 === undefined)
    throw new Error(`lab replay: unknown SPAWN region '${region}'`);
  const shift = Number(env.SHIFT ?? 0);
  return {
    minutes,
    difficulty: env.DIFF === "medium" ? Difficulty.Medium : Difficulty.Hard,
    global: env.GLOBAL === "1",
    spawnRank: Number(env.SPAWNRANK ?? 0),
    region,
    prefer: [pref0[0] + shift, pref0[1] + shift],
    seed: env.SEED ?? "",
    tribes: env.TRIBES ? Number(env.TRIBES) : 400, // online default
    params,
  };
}

/** The spawn walk: SPAWNRANK=k takes the k-th best spot in the region (each pick excludes a 120-tile circle
 *  around the earlier ones); GLOBAL=1 walks the whole map at k = SPAWNRANK*6 + region index.
 *
 *  Two lab-only guarantees (2026-08-30, after rm1's spawn collapses — loss_analysis.py REPLICATES):
 *  1. Voronoi veto (prefer-mode only, never the bot's real no-prefer pickSpawn): a pick that lands closer
 *     (Euclidean) to a DIFFERENT region's shifted centre than to its own is vetoed — excluded like a rank pick
 *     but consuming no rank — so each region keeps its own Voronoi cell and two regions of one slot (same
 *     SHIFT/SEED world, games that cannot see each other) can never collapse onto one tile. In rm1 the picker's
 *     staged 250→400-tile search radius re-found the same best tile from different centres (med5b/med8b
 *     africa == australia at 1569,681).
 *  2. One canonical walk per region: when the exclusion radius exhausts the region (australia at high ranks)
 *     the walk CONTINUES with the next smaller radius (120→60→30→15) keeping every earlier pick and veto
 *     excluded, instead of restarting from rank 0 — so rank i is always the i-th tile of one deterministic
 *     sequence and two ranks of one region can never coincide either (in rm1 a restarted 60-tile walk re-found
 *     a 120-tile walk's tile: med5/med9 africa at 903,480). Ranks that resolve at 120 pick the same tile as before. */
export function pickLabSpawn(
  game: Game,
  spec: LabSpec,
  picker: LabSpawnPicker,
): { tile: TileRef; rank: number; excludeRadius: number } {
  const regionIdx = LAB_REGIONS.findIndex(([n]) => n === spec.region);
  const rank = spec.global
    ? spec.spawnRank * 6 + Math.max(0, regionIdx)
    : spec.spawnRank;
  let vetoed: ((t: TileRef) => boolean) | null = null;
  if (!spec.global && regionIdx >= 0) {
    // every centre shifted by the same offset as spec.prefer (= own centre + SHIFT)
    const sx = spec.prefer[0] - LAB_REGIONS[regionIdx][1][0],
      sy = spec.prefer[1] - LAB_REGIONS[regionIdx][1][1];
    const centres: [number, number][] = LAB_REGIONS.map(([, [cx, cy]]) => [
      cx + sx,
      cy + sy,
    ]);
    vetoed = (t: TileRef) => {
      const x = game.x(t),
        y = game.y(t);
      const own = Math.hypot(
        x - centres[regionIdx][0],
        y - centres[regionIdx][1],
      );
      return centres.some(
        ([cx, cy], i) => i !== regionIdx && Math.hypot(x - cx, y - cy) < own,
      );
    };
  }
  const stages = [120, 60, 30, 15];
  const exclude: [number, number][] = [];
  let stage = 0;
  let t: TileRef | null = null;
  for (let i = 0; i <= rank; i++) {
    for (;;) {
      t = picker.pickSpawn(
        game,
        spec.global ? undefined : spec.prefer,
        exclude,
        stages[stage],
      );
      if (t === null) {
        if (stage < stages.length - 1) {
          stage++;
          continue;
        } // region exhausted: relax, keeping the walk so far
        break;
      }
      exclude.push([game.x(t), game.y(t)]);
      if (vetoed !== null && vetoed(t)) continue; // another region's cell: excluded, no rank consumed
      break;
    }
    if (t === null) break;
  }
  if (t === null) throw new Error("no spawn near " + spec.prefer);
  return { tile: t, rank, excludeRadius: stages[stage] };
}

/** The bootstrap as steps around ticks the CALLER drives, so the client's GameRunner can run every tick
 *  through its own turn loop (a player's first update emission is consumed by whoever executes the tick —
 *  pre-ticking here would eat the full-state packets the view needs; the headless lab has no view and
 *  pre-ticks via buildLabGame below). Exact statement order per stage matches the original lab loop. */
export interface LabReplaySteps {
  game: Game;
  gameID: string;
  /** Call with game.ticks() === 3 (nations and tribes have placed themselves): picks the deterministic spawn
   *  and queues the SpawnExecution. */
  placeSpawn(): { tile: TileRef; rank: number; excludeRadius: number };
  /** Call with game.ticks() === 6: ends the spawn phase and attaches the bot + WinCheck. */
  finish(): { me: Player; bot: PlaybookBotExecution };
}

export function labReplaySteps(
  spec: LabSpec,
  world: LabWorld,
  clientID: string | null = null,
  BotCls: typeof PlaybookBotExecution = PlaybookBotExecution,
  picker: LabSpawnPicker = BotCls,
  config?: LabConfig,
): LabReplaySteps {
  const nations: Nation[] = world.nations.map(
    (n, i) =>
      new Nation(
        new Cell(n.coordinates![0], n.coordinates![1]),
        new PlayerInfo(
          n.name,
          PlayerType.Nation,
          null,
          `nation_${i}`,
          false,
          null,
          [],
          null,
          n.flag ?? null,
        ),
      ),
  );
  const game = createGame(
    [],
    nations,
    world.gameMap,
    world.miniMap,
    config ?? new LabConfig(labGameConfig(spec), new UserSettings(), false),
  );
  const gameID = "lab" + spec.seed;
  // Common random numbers: every PRNG in the game derives from gameID — nations simpleHash(nation id) +
  // simpleHash(gameID), tribes simpleHash(gameID) + 2, the bot simpleHash("playbook") + 7 — and the spawn is
  // picked deterministically from the state after 3 ticks.
  game.addExecution(...nations.map((n) => new NationExecution(gameID, n)));
  game.addExecution(
    ...new TribeSpawner(
      game,
      gameID,
      nations.map((n) => n.spawnCell!),
    ).spawnTribes(spec.tribes),
  );
  const info = new PlayerInfo(
    "PlaybookBot",
    PlayerType.Human,
    clientID,
    "playbook",
  );
  game.addPlayer(info);
  return {
    game,
    gameID,
    placeSpawn() {
      const pick = pickLabSpawn(game, spec, picker);
      game.addExecution(new SpawnExecution(gameID, info, pick.tile));
      return pick;
    },
    finish() {
      game.endSpawnPhase();
      const me = game.player(info.id);
      const bot = new BotCls(me, spec.params);
      game.addExecution(bot, new WinCheckExecution());
      return { me, bot };
    },
  };
}

/** Build the lab game up to the moment the tick loop starts: world + nations + tribes, the PlaybookBot player
 *  spawned at the deterministic pick, spawn phase ended, bot and WinCheck attached — labReplaySteps with the
 *  six spawn-phase ticks driven here (the headless lab's path; byte-identical transcripts to the pre-refactor
 *  code). `clientID` is sim-inert (verified by transcript diff 2026-08-30). */
export function buildLabGame(
  spec: LabSpec,
  world: LabWorld,
  clientID: string | null = null,
  BotCls: typeof PlaybookBotExecution = PlaybookBotExecution,
  picker: LabSpawnPicker = BotCls,
  config?: LabConfig,
): {
  game: Game;
  me: Player;
  bot: PlaybookBotExecution;
  spawn: TileRef;
  rank: number;
  excludeRadius: number;
  gameID: string;
} {
  const steps = labReplaySteps(spec, world, clientID, BotCls, picker, config);
  const { game, gameID } = steps;
  // spawn phase: nations/tribes place themselves in the first ticks; we pick a spot and are placed with them
  for (let i = 0; i < 3; i++) game.executeNextTick();
  const pick = steps.placeSpawn();
  for (let i = 0; i < 3; i++) game.executeNextTick();
  const { me, bot } = steps.finish();
  return {
    game,
    me,
    bot,
    spawn: pick.tile,
    rank: pick.rank,
    excludeRadius: pick.excludeRadius,
    gameID,
  };
}

/** LabConfig factory for buildLabGame callers that need the game config first (the lab's headless variant). */
export function labGameConfig(spec: LabSpec): GameConfig {
  return {
    gameMap: GameMapType.World,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: spec.difficulty,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: spec.tribes,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
}
