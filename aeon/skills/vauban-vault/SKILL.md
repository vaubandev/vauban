---
name: vauban-vault
description: Read one Vauban vault on Robinhood Chain - the sheet in force, the caps left today, what is held at the gate, what changed since the last run, how it would rule on a call before the agent sends it, and which of its settings do not do what they look like. Keyless, read-only.
metadata:
  title: Vauban Vault
  mode: read-only
  category: crypto
  var: "Vauban vault address on Robinhood Chain (0x + 40 hex). Prefix watch: to be alerted only when it changes, rule: to dry-run one call, or inspect: to check its settings."
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
> - `rule:0xVAULT 0xTARGET [VALUE_WEI] [0xCALLDATA]` asks the vault how it would rule on that call now: pass, hold or refused, and at which rampart.
> - `inspect:0xVAULT` checks the vault's own settings for any that do not do what they look like, such as an agent that is also the owner or a gate that can never hold.
>
> If the value is empty or malformed, log `VAUBAN_BAD_VAULT` and exit without notifying.

Aeon's on-chain skills read public chains and report what happened. None of them reads the policy a vault enforces on the agent that spends from it. A [Vauban](https://vauban.works) vault holds an agent's funds and checks every call against four ramparts: spend caps (ditch), an allowlist (curtain), a time-lock (gate) and an owner freeze (keep). This skill reads that vault. It never signs and never sends.

## Network note

Public, unauthenticated reads only. `./secretcurl` is not needed because no secret is involved.

- `https://rpc.mainnet.chain.robinhood.com` - the official RPC, called only with `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber` (for the block time the hour and day caps are counted against), `eth_getCode`, `eth_call` and `eth_getLogs`. A ruling is one `eth_call` to the vault's own `rule()` view; nothing is signed or broadcast.
- The address must be the Vauban vault: its runtime code is hashed and compared with the build hash pinned in `skills/vauban-vault/vault.mjs`. Anything else is reported as not a Vauban vault and nothing more is read from it.
- Log reads walk back from the head in 10,000,000-block windows, the widest range this RPC allows, and stop at the `OwnershipTransferred` event the constructor emits.

The helpers use only Node.js, which ships with Aeon. They write nothing except the report on stdout and, for `watch:`, a bookmark at `memory/state/vauban-vault.json`.

## Steps

1. **Validate** `${var}`. Strip one leading `watch:`, `rule:` or `inspect:` if present. The vault that remains must be `0x` + 40 hex, otherwise log `VAUBAN_BAD_VAULT` and stop.
2. **Report the sheet** when there is no prefix:
   ```bash
   node skills/vauban-vault/status.mjs "${var}" > output/vauban-vault.md
   ```
   - Exit `2` (`VAUBAN_STATUS_RPC_DOWN` on stderr): the RPC was unreachable or reported the wrong chain. Log it and stop without notifying.
   - Exit `3` (`VAUBAN_STATUS_BAD_VAULT`): the address was malformed.
   - Exit `4` (`VAUBAN_STATUS_NOT_VAUBAN`): the address has no code, or its code is not the Vauban vault. The report says so; notify with it.
   - `--json` prints the same facts as JSON.
   - Under each capped asset, `next move up to X` is the largest single amount the caps let through at this block, with the UTC times the hour and day buckets reset. It covers the caps only; `rule:` says whether a given call also clears the allowlist.
3. **Watch for changes** when the prefix is `watch:`:
   ```bash
   node skills/vauban-vault/watch.mjs --watch VAULT --state memory/state/vauban-vault.json > output/vauban-vault.md
   ```
   - The first run only records the current block and prints `VAUBAN QUIET`, so installing it never replays history.
   - Later runs print `VAUBAN CHANGED` with one line per new event, or `VAUBAN QUIET`.
   - Who controls the vault is reported too: `OWNER offered the vault to 0x… (not accepted yet)`, `OWNER withdrew the handover offer`, `OWNER is now 0x… (was 0x…)` and `AGENT set to 0x…`. An offer you did not expect is the line to act on.
   - Exit `2` (`VAUBAN_WATCH_RPC_DOWN`) leaves the bookmark untouched. Log it and stop without notifying.
3b. **Rule on one call** when the prefix is `rule:`:
   ```bash
   node skills/vauban-vault/rule.mjs VAULT --to TARGET [--value WEI] [--data 0xCALLDATA] > output/vauban-vault.md
   ```
   - The report starts with `PASS`, `HOLD` or `REFUSED at the <RAMPART>` plus the reason, read at the current block. `--json` prints the same as JSON.
   - Exit `2` (`VAUBAN_RULE_RPC_DOWN`), `3` (`VAUBAN_RULE_BAD_INPUT`: target, value or calldata malformed), `4` (`VAUBAN_RULE_NOT_VAUBAN`: nothing was asked).
   - A ruling is a dry run. It does not reserve the caps, so the agent's real call can still be refused if the sheet or the spend changes first.
3c. **Inspect the settings** when the prefix is `inspect:`:
   ```bash
   node skills/vauban-vault/inspect.mjs VAULT > output/vauban-vault.md
   ```
   - The report starts with `VAUBAN INSPECT CLEAR` or `VAUBAN INSPECT <n> to check`, then one line per finding marked `RISK`, `CHECK` or `NOTE`. `--json` prints the same as JSON.
   - Exit `2` (`VAUBAN_INSPECT_RPC_DOWN`), `3` (`VAUBAN_INSPECT_BAD_VAULT`), `4` (`VAUBAN_INSPECT_NOT_VAUBAN`).
   - It checks ETH and token limits and the allowlist against how the vault rules. Token amounts are shown in the token's own units, using its `symbol()` and `decimals()`. It is not an audit of the contract.
4. **Notify** with `./notify -f output/vauban-vault.md`. A sheet report, a ruling and an inspection notify every run. A watch notifies only when the output starts with `VAUBAN CHANGED`. Never call a channel API directly.
5. **Log** to `memory/logs/YYYY-MM-DD.md` under `### vauban-vault`: `VAUBAN_STATUS <vault> rev=<n> frozen=<bool> held=<n>` or `VAUBAN_WATCH_CHANGED <n>` or `VAUBAN_WATCH_QUIET` or `VAUBAN_RULE <vault> <target> <pass|hold|refused:rampart>` or `VAUBAN_INSPECT <vault> <clear|n>`.

## Reading the output

- **Frozen** - the owner has sealed the vault. The agent can move nothing until the owner unseals it.
- **Revision** - how many times the sheet has been rewritten. It is a counter, not a hash.
- **Allowlist** - target address plus the function selectors permitted on it. `0x00000000` is a plain ETH send.
- **Caps** - per transaction, per clock hour and per UTC day. The windows are fixed buckets, not rolling, so a burst across a boundary can use up to twice one cap. `hold above` is the size that waits at the gate instead of landing.
- **Owner and agent** - ownership moves in two steps: an offer, then the new wallet accepts. Until it accepts, the old owner still holds the vault. A new agent key takes effect at once.
- **Held** - moves waiting at the gate. They do not expire. The agent or the owner releases them after the time shown, and the owner can cancel before that.
- **Refusals are absent from the logs.** A refused call reverts, so it leaves no vault log. `status` and `watch` report what the vault did; `rule:` is the only way to see what it would turn away.

## Hard limits

- Read-only on chain. Never sign, never broadcast, never ask for or store a key.
- A vault that passes these checks is not audited and not certified safe. Report the facts and the block they were read at.
- Only `transfer`, `transferFrom`, `approve` and `increaseAllowance` amounts are visible to the caps. The report says so.
