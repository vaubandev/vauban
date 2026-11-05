# @vaubanworks/sdk

TypeScript client for [Vauban](https://vauban.works) vaults on Robinhood Chain (4663), built on [viem](https://viem.sh).

A Vauban vault holds an agent's funds and checks every call against four ramparts: spend caps (ditch), an allowlist (curtain), a time-lock on large moves (gate) and an owner freeze (keep). This SDK is the agent's and the owner's side of that vault.

> **Not audited.** One empty reference vault is live at `0xf9322f1546de5a121cdc09522e70af79e30e4097`. Do not route real funds through a Vauban vault yet.

```bash
npm install @vaubanworks/sdk viem
```

## Ask before you sign

`rule()` is a read-only dry run. It returns `"pass"` or `"hold"`, or throws `Refused` with the rampart that would stop the call. Nothing is signed or sent.

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VaubanAgent, Refused, robinhoodChain } from "@vaubanworks/sdk";

const transport = http();
const agent = new VaubanAgent({
  vault: "0xYourVault",
  public: createPublicClient({ chain: robinhoodChain, transport }),
  wallet: createWalletClient({ chain: robinhoodChain, transport, account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`) }),
});

try {
  console.log(await agent.rule({ target: "0x000000000000000000000000000000000000dEaD", value: 10n ** 18n }));
} catch (e) {
  if (e instanceof Refused) console.log(e.rampart, e.code, e.reason);
  // curtain CurtainNotListed 0x…dEaD selector 0x00000000 is not on the allowlist
}
```

## Agent

```ts
const r = await agent.execute({ target, value, data }); // simulated first, then sent
if (r.kind === "held") console.log("waits at the gate until", r.eta);
await agent.release(r.id, { target, value, data });     // after the delay
```

`execute`, `release` and `rule` throw `Refused` before any gas is spent when a rampart would refuse. `transferToken` and `approveToken` are shortcuts for ERC-20 moves; unlimited approvals are always refused.

## Owner

```ts
import { VaubanOwner, NATIVE } from "@vaubanworks/sdk";
import { parseEther, toFunctionSelector } from "viem";

const owner = new VaubanOwner({ vault, public: pub, wallet: ownerWallet });
await owner.allow(router, [toFunctionSelector("buy()")]);
await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
await owner.freeze();
```

Also: `disallow`, `setGateDelay`, `unfreeze`, `cancel` (a held move), `withdraw`.

## Reading

`readState(pub, vault)` returns owner, agent, frozen, gate delay, revision and balance. `listHeld(pub, vault, fromBlock)` returns the moves waiting at the gate. `listAllowed(pub, vault)` returns the curtain as it stands: each target with the selectors the agent may call, confirmed against `allowed()`. `listRecord(pub, vault, { times: true })` returns every event the vault has emitted, newest first.

`inspect(pub, vault)` checks the vault's own settings and returns findings (`risk`, `warn` or `info`) for the ones that do not do what they look like: an agent that is also the owner, caps that cancel each other out, a gate that can never hold. ETH and token limits are both checked, token amounts in the token's own units. It reads the chain only and is not an audit of the contract.

## Check a change before you sign it

`inspect` is `findings(await readFacts(pub, vault))`. `findings` is pure, so it can run on a sheet that does not exist yet:

```ts
import { readFacts, draftSheet, draftCalls, findings, NATIVE } from "@vaubanworks/sdk";
import { parseEther } from "viem";

const draft = {
  limits: [{ asset: NATIVE, caps: { set: true, perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.1") } }],
};
const after = findings(draftSheet(await readFacts(pub, vault), draft, new Map()));
// [{ level: "warn", code: "gate-unreachable", ... }]: fix the draft before anything is signed

for (const c of draftCalls(draft)) await ownerWallet.sendTransaction({ to: vault, data: c.data });
```

For a target the vault has never seen, pass what `targetInfo(pub, target)` returns in the map (keyed by lowercase address), so code, symbol and decimals are known. After the calls land, `inspect` returns exactly what `findings` predicted.

## Deploying a vault

The creation bytecode is a separate entry point, so the main import stays small:

```ts
import { vaubanVaultAbi } from "@vaubanworks/sdk";
import { vaubanVaultBytecode } from "@vaubanworks/sdk/bytecode";

await wallet.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [owner, agent, 21600n] });
```

## Known limits

- Caps are fixed clock-hour and UTC-day buckets, not rolling: up to twice one cap can pass across a boundary.
- Only `transfer`, `transferFrom`, `approve` and `increaseAllowance` amounts are decoded. Any other value-moving function you allowlist is not capped, so list only functions you trust.
- Held moves do not expire.

Source, contract and tests: [github.com/vaubandev/vauban](https://github.com/vaubandev/vauban). MIT.
