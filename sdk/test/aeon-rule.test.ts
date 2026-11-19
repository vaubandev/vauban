// The Aeon pack's rule.mjs against a real vault on anvil: every ruling must match what the SDK reports.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, parseEther, toFunctionSelector, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { VaubanAgent, VaubanOwner, NATIVE, headroom, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

type Rule = { ruling: string; rampart?: string; code?: string; reason?: string; isVauban: boolean; room?: { asset: string; now: string; resets: string; unit?: { symbol: string; decimals: number } } };
const MOCK = new URL("../../contracts/out/Mocks.sol/MockToken.json", import.meta.url);
const tokenSkip = existsSync(MOCK) ? false : "run `forge build` in contracts/ first";
type Pack = { ruleOf: (url: string, vault: string, to: string, value: bigint, data: string) => Promise<Rule>; encodeRule: (t: string, v: bigint, d: string) => string };
const pack: Pack = await import(new URL("../../aeon/skills/vauban-vault/rule.mjs", import.meta.url).href);

// anvil dev keys #1 (owner) and #2 (agent), local chain only
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const PORT = 8551;
const URL_ = `http://127.0.0.1:${PORT}`;
const transport = http(URL_);
const pub = createPublicClient({ chain: foundry, transport });
const ow = createWalletClient({ chain: foundry, transport, account: OWNER });
const ag = createWalletClient({ chain: foundry, transport, account: AGENT });
const TOKEN = parseAbi(["function approve(address,uint256) returns (bool)"]);

let anvil: ChildProcess;
let vault: Address, router: Address, owner: VaubanOwner;
const buy = toFunctionSelector("buy()");

before(async () => {
  process.env.VAUBAN_CHAIN_ID = String(foundry.id);
  const local = `${homedir()}/.foundry/bin/anvil`;
  anvil = spawn(existsSync(local) ? local : "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  vault = (await pub.waitForTransactionReceipt({ hash: await ow.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [OWNER.address, AGENT.address, 21600n] }) })).contractAddress!;
  router = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: "0x6001600c60003960016000f300" as Hex }) })).contractAddress!;
  await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ to: vault, value: parseEther("3") }) });
  owner = new VaubanOwner({ vault, public: pub, wallet: ow });
  await owner.allow(router, [buy]);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
});
after(() => { anvil?.kill(); delete process.env.VAUBAN_CHAIN_ID; });

const ask = (to: Address, value: bigint, data: Hex = "0x") => pack.ruleOf(URL_, vault, to, value, data);

test("rule.mjs encodes rule() the way viem does", () => {
  const data = encodeFunctionData({ abi: TOKEN, functionName: "approve", args: [router, 5n] });
  const want = encodeFunctionData({ abi: vaubanVaultAbi, functionName: "rule", args: [router, 7n, data] });
  assert.equal(pack.encodeRule(router, 7n, data), want);
  assert.equal(pack.encodeRule(router, 0n, "0x"), encodeFunctionData({ abi: vaubanVaultAbi, functionName: "rule", args: [router, 0n, "0x"] }));
});

test("a small listed buy passes, and agrees with the SDK", async () => {
  const r = await ask(router, parseEther("0.04"), buy);
  assert.equal(r.ruling, "pass");
  const sdk = new VaubanAgent({ vault, public: pub, wallet: ag });
  assert.equal(await sdk.rule({ target: router, value: parseEther("0.04"), data: buy }), "pass");
});

test("a move above the hold line is held at the gate", async () => {
  assert.equal((await ask(router, parseEther("0.08"), buy)).ruling, "hold");
});

test("an unknown address is refused at the curtain", async () => {
  const r = await ask("0x000000000000000000000000000000000000dEaD", parseEther("1"));
  assert.deepEqual([r.ruling, r.rampart, r.code], ["refused", "curtain", "CurtainNotListed"]);
});

test("over the per-tx cap is refused at the ditch, in ETH", async () => {
  const r = await ask(router, parseEther("0.2"), buy);
  assert.deepEqual([r.ruling, r.rampart, r.code], ["refused", "ditch", "DitchPerTx"]);
  assert.equal(r.reason, "0.2 ETH is over the per-tx cap of 0.1 ETH");
  assert.equal(r.room?.now, parseEther("0.1").toString());
});

test("over the hour cap names the most that passes now, matching headroom()", async () => {
  const sdk = new VaubanAgent({ vault, public: pub, wallet: ag });
  for (let i = 0; i < 6; i++) await sdk.execute({ target: router, value: parseEther("0.04"), data: buy });
  // 0.24 spent this hour leaves 0.06
  const r = await ask(router, parseEther("0.07"), buy);
  assert.deepEqual([r.ruling, r.code], ["refused", "DitchPerHour"]);
  const h = await headroom(pub, vault);
  assert.equal(r.room?.now, parseEther("0.06").toString());
  assert.equal(r.room?.now, h.now.toString());
  assert.equal(r.room?.resets, String(h.hourResets.getTime() / 1000));
  // 0.06 clears the caps but is over the 0.05 hold line, so the vault holds it rather than refusing
  assert.equal((await ask(router, h.now, buy)).ruling, "hold");
});

test("a token over its hour cap is named in the token's own units", { skip: tokenSkip }, async () => {
  const bc = JSON.parse(readFileSync(MOCK, "utf8")).bytecode.object as Hex;
  const token = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: bc }) })).contractAddress!;
  const ERC = parseAbi(["function mint(address,uint256)", "function transfer(address,uint256) returns (bool)"]);
  await pub.waitForTransactionReceipt({ hash: await ow.writeContract({ address: token, abi: ERC, functionName: "mint", args: [vault, 1_000_000000n] }) });
  await owner.allow(token, [toFunctionSelector("transfer(address,uint256)")]);
  await owner.setLimits(token, { perTx: 150_000000n, perHour: 200_000000n, perDay: 1000_000000n });
  const send = (n: bigint) => encodeFunctionData({ abi: ERC, functionName: "transfer", args: [OWNER.address, n] });
  await new VaubanAgent({ vault, public: pub, wallet: ag }).execute({ target: token, data: send(150_500000n - 500000n) });

  const r = await ask(token, 0n, send(100_000000n));
  assert.deepEqual([r.ruling, r.code], ["refused", "DitchPerHour"]);
  assert.equal(r.reason, "this hour would reach 250 MOCK, over the cap of 200 MOCK");
  assert.deepEqual(r.room?.unit, { symbol: "MOCK", decimals: 6 });
  assert.equal(r.room?.now, (await headroom(pub, vault, token)).now.toString());
  assert.equal(r.room?.now, "50000000");
});

test("after a freeze everything is refused at the keep", async () => {
  await owner.freeze();
  const r = await ask(router, parseEther("0.01"), buy);
  assert.deepEqual([r.ruling, r.rampart, r.code], ["refused", "keep", "KeepSealed"]);
  await owner.unfreeze();
});

test("an address that is not a Vauban vault is never asked", async () => {
  const r = await pack.ruleOf(URL_, router, router, 0n, "0x");
  assert.equal(r.isVauban, false);
  assert.equal("ruling" in r, false);
});
