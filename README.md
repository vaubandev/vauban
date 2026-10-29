# Vauban

A fortification for autonomous agents. A vault the agent works inside, with four ramparts every call must cross:

| Rampart | Does |
|---|---|
| Ditch | Per-asset caps per tx, per hour, per UTC day |
| Curtain | Allowlist of (target, selector); unlimited approvals always refused |
| Gate | Moves above a threshold are held for a delay; owner can cancel, agent or owner releases |
| Keep | Owner freeze, two-step ownership, owner rescue |

Target chain: Robinhood Chain (4663). Site: [vauban.works](https://vauban.works) · X: [@vaubanworks](https://x.com/vaubanworks)

> **Status:** not audited. One reference vault, holding nothing, is live on Robinhood Chain at `0xf9322f1546de5a121cdc09522e70af79e30e4097`. Do not use with real funds.

## Layout

```
contracts/   Foundry: VaubanVault.sol, tests, deploy script
sdk/         TypeScript (viem): VaubanAgent, VaubanOwner, e2e tests, deploy script
pages/       Site sources
site/        Built static site (Vercel root)
scripts/     build.py (pages -> site), abi.py (forge -> sdk/src/abi.ts), mark_v.py, x_assets.py
```

## Run

```sh
# contracts
git submodule update --init
cd contracts && forge test

# sdk (needs anvil on PATH at ~/.foundry/bin)
cd sdk && npm ci && npm run typecheck && npm test

# site
python3 scripts/build.py
cd site && python3 -m http.server 8090
```

After changing the contract: `python3 scripts/abi.py` to regenerate `sdk/src/abi.ts` and `bytecode.ts`.

## Known limits

- Caps are fixed hour / UTC-day buckets, not rolling: up to 2x a cap can pass across a boundary.
- Only `transfer`, `transferFrom`, `approve`, `increaseAllowance` amounts are decoded. Any other value-moving function you allowlist is not capped, so list only functions you trust.
- Held moves do not expire.
