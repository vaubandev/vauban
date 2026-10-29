---
name: vauban-vault
description: Read one Vauban vault on Robinhood Chain - the sheet in force, the caps left today, what is held at the gate, and what changed since the last run. Keyless, read-only.
metadata:
  title: Vauban Vault
  mode: read-only
  category: crypto
  var: "Vauban vault address on Robinhood Chain (0x + 40 hex). Prefix watch: to be alerted only when it changes."
  tags:
    - crypto
    - robinhood-chain
    - vauban
  requires: []
  capabilities:
    - read_only
    - sends_notifications
---

> **${var}** - A Vauban vault address on Robinhood Chain (`0x` + 40 hex). Required.
> - `0xVAULT` reports the sheet in force now.
> - `watch:0xVAULT` reports only what changed since the last run, and stays quiet when nothing did.
>
> If the value is empty or malformed, log `VAUBAN_BAD_VAULT` and exit without notifying.

Aeon's on-chain skills read public chains and report what happened. None of them reads the policy a vault enforces on the agent that spends from it. A [Vauban](https://vauban.works) vault holds an agent's funds and checks every call against four ramparts: spend caps (ditch), an allowlist (curtain), a time-lock (gate) and an owner freeze (keep). This skill reads that vault. It never signs and never sends.

## Network note

Public, unauthenticated reads only. `./secretcurl` is not needed because no secret is involved.

- `https://rpc.mainnet.chain.robinhood.com` - the official RPC, called only with `eth_chainId`, `eth_blockNumber`, `eth_getCode`, `eth_call` and `eth_getLogs`.
- The address must be the Vauban vault: its runtime code is hashed and compared with the build hash pinned in `skills/vauban-vault/vault.mjs`. Anything else is reported as not a Vauban vault and nothing more is read from it.
- Log reads walk back from the head in 10,000,000-block windows, the widest range this RPC allows, and stop at the `OwnershipTransferred` event the constructor emits.

Both helpers use only Node.js, which ships with Aeon. They write nothing except the report on stdout and, for `watch:`, a bookmark at `memory/state/vauban-vault.json`.

## Steps

1. **Validate** `${var}`. Strip one leading `watch:` if present. What remains must be `0x` + 40 hex, otherwise log `VAUBAN_BAD_VAULT` and stop.
2. **Report the sheet** when there is no prefix:
   ```bash
   node skills/vauban-vault/status.mjs "${var}" > output/vauban-vault.md
   ```
   - Exit `2` (`VAUBAN_STATUS_RPC_DOWN` on stderr): the RPC was unreachable or reported the wrong chain. Log it and stop without notifying.
   - Exit `3` (`VAUBAN_STATUS_BAD_VAULT`): the address was malformed.
   - Exit `4` (`VAUBAN_STATUS_NOT_VAUBAN`): the address has no code, or its code is not the Vauban vault. The report says so; notify with it.
   - `--json` prints the same facts as JSON.
3. **Watch for changes** when the prefix is `watch:`:
   ```bash
   node skills/vauban-vault/watch.mjs --watch VAULT --state memory/state/vauban-vault.json > output/vauban-vault.md
   ```
   - The first run only records the current block and prints `VAUBAN QUIET`, so installing it never replays history.
   - Later runs print `VAUBAN CHANGED` with one line per new event, or `VAUBAN QUIET`.
   - Exit `2` (`VAUBAN_WATCH_RPC_DOWN`) leaves the bookmark untouched. Log it and stop without notifying.
4. **Notify** with `./notify -f output/vauban-vault.md`. A sheet report notifies every run. A watch notifies only when the output starts with `VAUBAN CHANGED`. Never call a channel API directly.
5. **Log** to `memory/logs/YYYY-MM-DD.md` under `### vauban-vault`: `VAUBAN_STATUS <vault> rev=<n> frozen=<bool> held=<n>` or `VAUBAN_WATCH_CHANGED <n>` or `VAUBAN_WATCH_QUIET`.

## Reading the output

- **Frozen** - the owner has sealed the vault. The agent can move nothing until the owner unseals it.
- **Revision** - how many times the sheet has been rewritten. It is a counter, not a hash.
- **Allowlist** - target address plus the function selectors permitted on it. `0x00000000` is a plain ETH send.
- **Caps** - per transaction, per clock hour and per UTC day. The windows are fixed buckets, not rolling, so a burst across a boundary can use up to twice one cap. `hold above` is the size that waits at the gate instead of landing.
- **Held** - moves waiting at the gate. They do not expire. The agent or the owner releases them after the time shown, and the owner can cancel before that.
- **Refusals are absent.** A refused call reverts, so it leaves no vault log. This skill reports what the vault did, not what it turned away.

## Hard limits

- Read-only on chain. Never sign, never broadcast, never ask for or store a key.
- A vault that passes these checks is not audited and not certified safe. Report the facts and the block they were read at.
- Only `transfer`, `transferFrom`, `approve` and `increaseAllowance` amounts are visible to the caps. The report says so.
