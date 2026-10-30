// Local only: run the demo scenes against anvil and print what really happened, as JSON for the video.
import { createPublicClient, createWalletClient, http, parseEther, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { VaubanAgent, VaubanOwner, Refused, NATIVE, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

const rpc = process.argv[2] ?? "http://127.0.0.1:8545";
// anvil dev keys #1 (owner) and #2 (agent)
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const chain = { ...foundry, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const ow = createWalletClient({ chain, transport: http(rpc), account: OWNER });
const ag = createWalletClient({ chain, transport: http(rpc), account: AGENT });

const vault = (await pub.waitForTransactionReceipt({
  hash: await ow.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [OWNER.address, AGENT.address, 21600n] }),
})).contractAddress!;
const router = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: "0x6001600c60003960016000f300" as Hex }) })).contractAddress!;
await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ to: vault, value: parseEther("3") }) });

const owner = new VaubanOwner({ vault, public: pub, wallet: ow });
const agent = new VaubanAgent({ vault, public: pub, wallet: ag });
await owner.allow(router, [toFunctionSelector("buy()")]);
await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });

const buy = toFunctionSelector("buy()");
const steps: { scene: string; ask: string; result: string; rampart?: string }[] = [];

async function attempt(scene: string, ask: string, run: () => Promise<unknown>) {
  try {
    const r = (await run()) as { kind?: string; eta?: Date } | undefined;
    const result = r?.kind === "held" ? `HELD until ${r.eta!.toISOString().slice(11, 16)} UTC` : "PASSED";
    steps.push({ scene, ask, result, rampart: r?.kind === "held" ? "gate" : undefined });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    steps.push({ scene, ask, result: e.message, rampart: e.rampart });
  }
}

await attempt("pass", "buy 0.04 ETH on the router", () => agent.execute({ target: router, value: parseEther("0.04"), data: buy }));
await attempt("curtain", "send 1 ETH to an unknown address", () => agent.execute({ target: "0x000000000000000000000000000000000000dEaD", value: parseEther("1") }));
await attempt("ditch", "buy 0.2 ETH (cap 0.1 per tx)", () => agent.execute({ target: router, value: parseEther("0.2"), data: buy }));
await attempt("gate", "buy 0.08 ETH (holds above 0.05)", () => agent.execute({ target: router, value: parseEther("0.08"), data: buy }));
await owner.freeze();
await attempt("keep", "buy 0.01 ETH after the owner froze it", () => agent.execute({ target: router, value: parseEther("0.01"), data: buy }));

console.log(JSON.stringify({ vault, steps }, null, 2));
