// The Aeon pack's inspect.mjs against real vaults on anvil: findings must equal the SDK's inspect(), code for code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, parseEther, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { VaubanAgent, VaubanOwner, NATIVE, Refused, toRefused, headroom, inspect, findings, readFacts, draftSheet, draftCalls, targetInfo, type Draft, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

type F = { level: string; code: string; text: string };
type Pack = {
  inspectOf: (url: string, vault: string) => Promise<{ isVauban: boolean; findings?: F[] }>;
  render: (r: unknown) => string;
};
const pack: Pack = await import(new URL("../../aeon/skills/vauban-vault/inspect.mjs", import.meta.url).href);

// anvil dev keys #1 (owner), #2 (agent), #3 (handover target), local chain only
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
let token: Address;

const MOCK = new URL("../../contracts/out/Mocks.sol/MockToken.json", import.meta.url);
const tokenSkip = existsSync(MOCK) ? false : "run `forge build` in contracts/ first";
const tx = toFunctionSelector("transfer(address,uint256)");
const usd = (n: string) => BigInt(Math.round(Number(n) * 1e6));

before(async () => {
  process.env.VAUBAN_CHAIN_ID = String(foundry.id);
  const local = `${homedir()}/.foundry/bin/anvil`;
  anvil = spawn(existsSync(local) ? local : "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  router = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: "0x6001600c60003960016000f300" as Hex }) })).contractAddress!;
  if (!tokenSkip) {
    const bc = JSON.parse(readFileSync(MOCK, "utf8")).bytecode.object as Hex;
    token = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: bc }) })).contractAddress!;
  }
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

test("token limits get the same checks as ETH, in the token's own units", { skip: tokenSkip }, async () => {
  const { vault, owner } = await deploy(AGENT.address, 21600n);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
  await owner.allow(token, [tx]);
  await owner.setLimits(token, { perTx: usd("500"), perHour: usd("200"), perDay: usd("100"), holdAbove: 0n });
  assert.deepEqual(await same(vault), ["token-tx-over-hour", "token-hour-over-day", "token-gate-off"]);
  const f = await inspect(pub, vault);
  assert.equal(f[0].text, "Per-call limit 500 MOCK is above the hourly 200 MOCK; the real per-call limit is 200 MOCK.");

  await owner.setLimits(token, { perTx: usd("100"), perHour: usd("300"), perDay: usd("1000"), holdAbove: usd("100") });
  assert.deepEqual(await same(vault), ["token-gate-unreachable"]);
  await owner.setLimits(token, { perTx: usd("100"), perHour: usd("300"), perDay: usd("1000"), holdAbove: usd("50") });
  assert.deepEqual(await same(vault), []);
  await owner.setLimits(token, { perTx: 0n, perHour: 0n, perDay: 0n, holdAbove: 0n });
  assert.deepEqual(await same(vault), ["token-zero", "token-gate-off"]);
});

test("a token gate alone is enough to make a 0 delay matter", { skip: tokenSkip }, async () => {
  const { vault, owner } = await deploy(AGENT.address, 0n);
  await owner.allow(token, [tx]);
  await owner.setLimits(token, { perTx: usd("100"), perHour: usd("300"), perDay: usd("1000"), holdAbove: usd("50") });
  assert.deepEqual(await same(vault), ["eth-unset", "gate-instant"]);
});

test("a draft is checked before signing, and the chain agrees once it lands", { skip: tokenSkip }, async () => {
  const { vault, owner } = await deploy(AGENT.address, 21600n);
  await owner.allow(router, [toFunctionSelector("buy()")]);
  const drafts: Draft[] = [
    { allow: [{ target: WALLET, selectors: [toFunctionSelector("buy()")], on: true }],
      limits: [{ asset: NATIVE, caps: { set: true, perTx: parseEther("1"), perHour: parseEther("0.5"), perDay: parseEther("2"), holdAbove: parseEther("1") } }] },
    { gateDelay: 0n, allow: [{ target: token, selectors: [tx], on: true }, { target: WALLET, selectors: [toFunctionSelector("buy()")], on: false }],
      limits: [{ asset: token, caps: { set: true, perTx: usd("100"), perHour: usd("300"), perDay: usd("1000"), holdAbove: usd("50") } }] },
    { gateDelay: 3600n, allow: [{ target: router, selectors: [toFunctionSelector("buy()")], on: false }] },
  ];
  for (const d of drafts) {
    const now = await readFacts(pub, vault);
    const info = new Map<string, Awaited<ReturnType<typeof targetInfo>>>();
    for (const a of d.allow ?? []) info.set(a.target.toLowerCase(), await targetInfo(pub, a.target));
    for (const l of d.limits ?? []) if (l.asset !== NATIVE) info.set(l.asset.toLowerCase(), await targetInfo(pub, l.asset));
    const predicted = findings(draftSheet(now, d, info));
    for (const c of draftCalls(d)) {
      await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ to: vault, data: c.data }) });
    }
    assert.deepEqual(await inspect(pub, vault), predicted, "the draft check must predict what the chain says after signing");
  }
  // draft 1 set ETH caps that cancel out and nothing since has fixed them
  assert.deepEqual((await inspect(pub, vault)).map((x) => x.code), ["tx-over-hour", "gate-unreachable"]);
});

test("a draft step the vault refuses is named before anything is sent", async () => {
  const { vault } = await deploy(AGENT.address, 21600n);
  const [c] = draftCalls({ allow: [{ target: vault, selectors: [toFunctionSelector("buy()")], on: true }] });
  // a stranger, and then the vault itself as target: both must come back as a named refusal, not a raw revert
  await assert.rejects(pub.call({ account: AGENT.address, to: vault, data: c.data }).catch(toRefused), (e: unknown) => e instanceof Refused && e.code === "NotOwner");
  await assert.rejects(pub.call({ account: OWNER.address, to: vault, data: c.data }).catch(toRefused), (e: unknown) => e instanceof Refused && e.code === "CurtainSelfCall");
});

test("the watch reports a full handover and an agent change from real logs", async () => {
  const watch: { changesSince: (url: string, vaults: string[], from: bigint, to: bigint) => Promise<string[]> } =
    await import(new URL("../../aeon/skills/vauban-vault/watch.mjs", import.meta.url).href);
  const { vault } = await deploy(AGENT.address, 21600n);
  const from = await pub.getBlockNumber({ cacheTime: 0 });
  const NEW = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
  const nw = createWalletClient({ chain: foundry, transport, account: NEW });
  const send = async (w: typeof ow, functionName: "transferOwnership" | "acceptOwnership" | "setAgent", args: readonly unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: vault, abi: vaubanVaultAbi, functionName, args: args as any }) });
  await send(ow, "transferOwnership", [NEW.address]);
  await send(ow, "transferOwnership", ["0x0000000000000000000000000000000000000000"]);
  await send(ow, "transferOwnership", [NEW.address]);
  await send(nw, "acceptOwnership", []);
  const BOT: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
  await send(nw, "setAgent", [BOT]);
  // cacheTime 0: a cached head can sit below `from` and make the range backwards
  const lines = await watch.changesSince(URL_, [vault.toLowerCase()], from, await pub.getBlockNumber({ cacheTime: 0 }));
  const v = vault.toLowerCase(), n = NEW.address.toLowerCase();
  assert.deepEqual(lines.filter((l) => /OWNER|AGENT/.test(l)), [
    `${v} OWNER offered the vault to ${n} (not accepted yet)`,
    `${v} OWNER withdrew the handover offer`,
    `${v} OWNER offered the vault to ${n} (not accepted yet)`,
    `${v} OWNER is now ${n} (was ${OWNER.address.toLowerCase()})`,
    `${v} AGENT set to ${BOT.toLowerCase()}`,
  ]);
  assert.notEqual(n, BOT.toLowerCase(), "owner and agent must differ so the lines can't be confused");
});

test("the status report and headroom() agree on what the ditch still allows", async () => {
  const status: { statusOf: (url: string, vault: string) => Promise<{ caps: { asset: string; now: bigint; hourLeft: bigint; dayLeft: bigint; hourResets: bigint; dayResets: bigint }[] }> } =
    await import(new URL("../../aeon/skills/vauban-vault/status.mjs", import.meta.url).href);
  const { vault, owner } = await deploy(AGENT.address, 21600n);
  await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ to: vault, value: parseEther("1") }) });
  await owner.allow(router, [toFunctionSelector("buy()")]);
  await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1") });
  const agent = new VaubanAgent({ vault, public: pub, wallet: createWalletClient({ chain: foundry, transport, account: AGENT }) });
  const buy = { target: router, value: parseEther("0.09"), data: toFunctionSelector("buy()") };
  for (let i = 0; i < 3; i++) await agent.execute(buy);

  const sdk = await headroom(pub, vault);
  const row = (await status.statusOf(URL_, vault)).caps.find((c) => c.asset === NATIVE)!;
  assert.equal(sdk.now, parseEther("0.03"), "0.27 spent this hour leaves 0.03");
  assert.deepEqual(
    [row.now, row.hourLeft, row.dayLeft, row.hourResets, row.dayResets],
    [sdk.now, sdk.hourLeft, sdk.dayLeft, BigInt(sdk.hourResets.getTime() / 1000), BigInt(sdk.dayResets.getTime() / 1000)],
  );
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
