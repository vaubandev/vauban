// End-to-end against a throwaway anvil: deploy, draw a sheet, then let an "agent" try things.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import {
  createPublicClient, createWalletClient, http, parseEther, encodeFunctionData, parseAbi, toFunctionSelector,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { VaubanAgent, VaubanOwner, Refused, NATIVE, listHeld, readState, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

// anvil's well-known dev keys — local chain only
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const TREASURY: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PORT = 8549;

let anvil: ChildProcess;
const transport = http(`http://127.0.0.1:${PORT}`);
const pub = createPublicClient({ chain: foundry, transport });
const ownerW = createWalletClient({ chain: foundry, transport, account: OWNER });
const agentW = createWalletClient({ chain: foundry, transport, account: AGENT });
let vault: Address;
let agent: VaubanAgent;
let owner: VaubanOwner;

const SINK = parseAbi(["function buy() payable"]);
// runtime is a single STOP: accepts any call with value — stands in for a router
const SINK_CODE: Hex = "0x6001600c60003960016000f300";
let router: Address;

async function rpc(method: string, params: unknown[] = []) {
  return pub.request({ method: method as never, params: params as never });
}

before(async () => {
  anvil = spawn(`${homedir()}/.foundry/bin/anvil`, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const h1 = await ownerW.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [OWNER.address, AGENT.address, 21600n] });
  vault = (await pub.waitForTransactionReceipt({ hash: h1 })).contractAddress!;
  const h2 = await ownerW.sendTransaction({ data: SINK_CODE });
  router = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!;
  await pub.waitForTransactionReceipt({ hash: await ownerW.sendTransaction({ to: vault, value: parseEther("5") }) });

  const c = { vault, public: pub, wallet: agentW };
  agent = new VaubanAgent(c);
  owner = new VaubanOwner({ ...c, wallet: ownerW });

  await owner.allow(router, [toFunctionSelector("buy()")]);
  await owner.allow(TREASURY, ["0x00000000"]);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
});

after(() => anvil?.kill());

const buy = (v: string) => ({ target: router, value: parseEther(v), data: encodeFunctionData({ abi: SINK, functionName: "buy" }) });

test("small buy passes", async () => {
  assert.equal(await agent.rule(buy("0.04")), "pass");
  const r = await agent.execute(buy("0.04"));
  assert.equal(r.kind, "passed");
});

test("unknown target is refused at the curtain, no gas spent", async () => {
  const nonce = await pub.getTransactionCount({ address: AGENT.address });
  await assert.rejects(agent.execute({ target: "0x000000000000000000000000000000000000dEaD", value: 1n }), (e: unknown) => {
    assert.ok(e instanceof Refused);
    assert.equal(e.rampart, "curtain");
    assert.equal(e.code, "CurtainNotListed");
    return true;
  });
  assert.equal(await pub.getTransactionCount({ address: AGENT.address }), nonce);
});

test("over per-tx is refused at the ditch", async () => {
  await assert.rejects(agent.execute(buy("0.2")), (e: unknown) => e instanceof Refused && e.code === "DitchPerTx");
});

test("large move is held, listed, then released after the delay", async () => {
  const call = buy("0.08");
  const r = await agent.execute(call);
  assert.equal(r.kind, "held");
  if (r.kind !== "held") return;

  const held = await listHeld(pub, vault);
  assert.ok(held.some((h) => h.id === r.id));

  await assert.rejects(agent.release(r.id, call), (e: unknown) => e instanceof Refused && e.code === "GateNotYet");
  await rpc("evm_increaseTime", [21600]);
  await rpc("evm_mine");
  await agent.release(r.id, call);
  assert.ok(!(await listHeld(pub, vault)).some((h) => h.id === r.id));
});

test("freeze seals the keep; agent cannot lift it", async () => {
  await owner.freeze();
  assert.equal((await readState(pub, vault)).frozen, true);
  await assert.rejects(agent.execute(buy("0.01")), (e: unknown) => e instanceof Refused && e.rampart === "keep");
  const asAgentOwner = new VaubanOwner({ vault, public: pub, wallet: agentW });
  await assert.rejects(asAgentOwner.unfreeze(), (e: unknown) => e instanceof Refused && e.code === "NotOwner");
  await owner.unfreeze();
});
