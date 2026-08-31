# cmaes.py specs

`--spec <file>`: `{name: {lo, hi, init, int?}}` — one dimension per key; `init` must equal `DEFAULT_PLAYBOOK`
(check_spec warns otherwise) so generation 0's mean is the current bot.

2026-08-31 (bot/prune): the utility / threatMap / buildSearch / hystRetreats flags and their constants — and the
estimator scales (`estLossScale*`, `estSpeedScale`) — were deleted after losing their A/Bs (docs/PlaybookBotPlan.md,
Params.ts header), so both specs were trimmed to the surviving params. The old specs live in git history at
38219433a.

- `neutral-flags.json` — the 10 behaviour params of `BUILTIN_SPEC` plus the constants of the surviving
  opportunity-#2 flags (`retalRatio`, `drainRatio`, `drainBelow`), ±50–100 % around their defaults. Run it with
  the flags on for every member (`--fixed`; `base` stays `{}`):

  ```
  WORKERS=4 nohup python3 scripts/lab/cmaes.py --out lab-out/cma-neutral --spec scripts/lab/specs/neutral-flags.json \
    --fixed '{"retaliateAware":true,"drainedNations":true,"relationAware":true}' \
    --pop 10 --gens 8 --race --runner remote --with-base > lab-out/cma-neutral.log 2>&1 &
  ```

  (`cmaes.py` has no `--workers`: the remote runner reads `WORKERS` from the environment, see its docstring.)

- `wins.json` — the full-game (wins-objective) spec, per docs/PlaybookBotPlan.md "Why we lose full games": the
  loss analysis found wins and losses identical at minute 10, so the opening params (`expandContested`,
  `expandFree`, `botRatio`, `botClickCap`, `railSpacing`) are EXCLUDED and only the mid/endgame behaviour params
  (`fightAbove`, `fightMaxShare`, `reserveShare`, `capFullShare`, `bombReserve`), the surviving opportunity-#2
  constants (`retal*`, `drain*`) and the fix/boat flags' constants (`contest*`, `plateau*`, `duelRatio`,
  `escort*`, `boatEatRate`/`boatTribeWorth`/`boatOcean*`/`boatOpening*`/`boatOwnMassFactor`) are tuned — bounds
  as in `neutral-flags.json`, init = `DEFAULT_PLAYBOOK`. Run it on full games (`--minutes full`, wscore) with the
  gating flags on via `--fixed` (their constants are read only while the flag is on).
