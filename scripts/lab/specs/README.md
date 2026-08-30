# cmaes.py specs

`--spec <file>`: `{name: {lo, hi, init, int?}}` — one dimension per key; `init` must equal `DEFAULT_PLAYBOOK`
(check_spec warns otherwise) so generation 0's mean is the current bot.

- `neutral-flags.json` — the 10 behaviour params of `BUILTIN_SPEC` plus the hand-picked constants of the
  ab1-neutral flags (utility, threatMap, buildSearch, retaliateAware, drainedNations, hystRetreats; Params.ts
  "Constants of the ab1-neutral flags"), ±50–100 % around their defaults, `hystStrikes` int 1..4. Run it with the
  flags on and the calibrated estimator scales fixed for every member (`--fixed`; `base` stays `{}`):

  ```
  WORKERS=4 nohup python3 scripts/lab/cmaes.py --out lab-out/cma-neutral --spec scripts/lab/specs/neutral-flags.json \
    --fixed '{"utility":true,"threatMap":true,"buildSearch":true,"retaliateAware":true,"drainedNations":true,"relationAware":true,"hystRetreats":true,"estLossScaleNation":0.868,"estLossScaleBot":0.719,"estSpeedScale":1.285}' \
    --pop 10 --gens 8 --race --runner remote --with-base > lab-out/cma-neutral.log 2>&1 &
  ```

  (`cmaes.py` has no `--workers`: the remote runner reads `WORKERS` from the environment, see its docstring.)
