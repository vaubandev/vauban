# Vauban Pack

An [Aeon](https://www.aeon.fun) skill pack that reads a [Vauban](https://vauban.works) vault on Robinhood Chain (chain ID 4663).

```bash
bin/install-skill-pack vaubanworks/vauban --path aeon
```

| Skill | What it does | Secrets | Capabilities | Default schedule |
|---|---|---|---|---|
| `vauban-vault` | Reports the sheet a vault enforces on its agent: allowlist, caps left this hour and UTC day, moves held at the gate, freeze and revision. `watch:0xVAULT` reports only what changed since the last run. | none | `read_only`, `sends_notifications` | `0 */6 * * *`, disabled until you enable it |

The vault holds an agent's funds and checks every call against four ramparts: spend caps, an allowlist, a time-lock and an owner freeze. This pack only reads that vault. It never signs, never broadcasts and never asks for a key.

It reads the official RPC `rpc.mainnet.chain.robinhood.com` and checks the bytecode at the address against the pinned build hash in `skills/vauban-vault/vault.mjs` before trusting it.

## Status

The contract passes its own test suite and is **not audited** and **not deployed** to Robinhood Chain yet. The skill reports that honestly: until a vault exists at an address, it says the address is not a Vauban vault.

## Verify

```bash
node --test aeon/test/vault.test.mjs
```

No network and no dependency beyond Node.js.
