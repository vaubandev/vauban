// The Aeon pack's inspect.mjs against real vaults on anvil: findings must equal the SDK's inspect(), code for code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, parseEther, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { VaubanOwner, NATIVE, inspect, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

type F = { level: string; code: string; text: string };
type Pack = {
  inspectOf: (url: string, vault: string) => Promise<{ isVauban: boolean; findings?: F[] }>;
  render: (r: unknown) => string;
};
const pack: Pack = await import(new URL("../../aeon/skills/vauban-vault/inspect.mjs", import.meta.url).href);

// anvil dev keys #1 (owner) and #2 (agent), local chain only
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const WALLET: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PORT = 8553;
const URL_ = `http://127.0.0.1:${PORT}`;
const transport = http(URL_);
const pub = createPublicClient({ chain: foundry, transport });
const ow = createWalletClient({ chain: foundry, transport, account: OWNER });

let anvil: ChildProcess;
let router: Address;

before(async () => {
  process.env.VAUBAN_CHAIN_ID = String(foundry.id);
  const local = `${homedir()}/.foundry/bin/anvil`;
  anvil = spawn(existsSync(local) ? local : "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  router = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: "0x6001600c60003960016000f300" as Hex }) })).contractAddress!;
});
after(() => { anvil?.kill(); delete process.env.VAUBAN_CHAIN_ID; });

async function deploy(agent: Address, delay: bigint) {
  const h = await ow.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [OWNER.address, agent, delay] });
  const vault = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
  return { vault, owner: new VaubanOwner({ vault, public: pub, wallet: ow }) };
}

async function same(vault: Address) {
  const sdk = await inspect(pub, vault);
  const p = await pack.inspectOf(URL_, vault);
  assert.equal(p.isVauban, true);
  // the pack has no keccak to checksum with, so it prints addresses lowercase
  const low = (fs: F[]) => fs.map((x) => ({ ...x, text: x.text.replace(/0x[0-9a-fA-F]{40}/g, (a) => a.toLowerCase()) }));
  assert.deepEqual(low(p.findings!), low(sdk), "pack and SDK must report the same findings in the same order");
  return sdk.map((x) => x.code);
}

test("a fresh vault: the pack and the SDK agree", async () => {
  const { vault } = await deploy(AGENT.address, 21600n);
  assert.deepEqual(await same(vault), ["eth-unset", "curtain-empty"]);
});

test("a well-set vault is clear in both", async () => {
  const { vault, owner } = await deploy(AGENT.address, 21600n);
  await owner.allow(router, [toFunctionSelector("buy()")]);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
  assert.deepEqual(await same(vault), []);
});

test("a badly set vault gets every warning, identically", async () => {
  const { vault, owner } = await deploy(OWNER.address, 0n);
  await owner.setLimits(NATIVE, { perTx: parseEther("1"), perHour: parseEther("0.5"), perDay: parseEther("0.2"), holdAbove: 0n });
  await owner.allow(WALLET, [toFunctionSelector("buy()")]);
  await owner.allow(router, [toFunctionSelector("transfer(address,uint256)")]);
  await pub.waitForTransactionReceipt({ hash: await ow.writeContract({ address: vault, abi: vaubanVaultAbi, functionName: "transferOwnership", args: [AGENT.address] }) });
  assert.deepEqual(await same(vault), ["owner-is-agent", "pending-owner", "tx-over-hour", "hour-over-day", "gate-off", "eoa-target", "token-unset"]);
});

test("gate settings, removals and a freeze agree too", async () => {
  const { vault, owner } = await deploy(AGENT.address, 0n);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.1") });
  await owner.allow(router, [toFunctionSelector("buy()")]);
  assert.deepEqual(await same(vault), ["gate-unreachable"]);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
  await owner.disallow(router, [toFunctionSelector("buy()")]);
  await owner.freeze();
  assert.deepEqual(await same(vault), ["sealed", "gate-instant", "curtain-empty"]);
});

test("the report says CLEAR or how many to check, and refuses a non-vault", async () => {
  const { vault } = await deploy(OWNER.address, 21600n);
  const out = pack.render(await pack.inspectOf(URL_, vault));
  assert.match(out, /VAUBAN INSPECT 1 to check/);
  assert.match(out, /\*\*RISK\*\* The agent is also the owner/);
  assert.match(out, /not an audit/);
  const none = await pack.inspectOf(URL_, router);
  assert.equal(none.isVauban, false);
  assert.match(pack.render(none), /not a Vauban vault/);
});
