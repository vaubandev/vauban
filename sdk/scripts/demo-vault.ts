// Local demo only: deploy a vault to anvil, draw a sheet, queue one held move. Prints the vault address.
import { createPublicClient, createWalletClient, http, parseEther, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { VaubanAgent, VaubanOwner, NATIVE, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

const rpc = process.argv[2] ?? "http://127.0.0.1:8545";
// anvil dev keys #1 (owner) and #2 (agent)
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const chain = { ...foundry, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const ow = createWalletClient({ chain, transport: http(rpc), account: OWNER });
const ag = createWalletClient({ chain, transport: http(rpc), account: AGENT });

const h = await ow.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [OWNER.address, AGENT.address, 21600n] });
const vault = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
const sink = (await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ data: "0x6001600c60003960016000f300" as Hex }) })).contractAddress!;
await pub.waitForTransactionReceipt({ hash: await ow.sendTransaction({ to: vault, value: parseEther("3") }) });

const owner = new VaubanOwner({ vault, public: pub, wallet: ow });
const agent = new VaubanAgent({ vault, public: pub, wallet: ag });
await owner.allow(sink, [toFunctionSelector("buy()")]);
await owner.setLimits(NATIVE, { perTx: parseEther("0.1"), perHour: parseEther("0.3"), perDay: parseEther("1"), holdAbove: parseEther("0.05") });
const buy = toFunctionSelector("buy()");
await agent.execute({ target: sink, value: parseEther("0.04"), data: buy });
await agent.execute({ target: sink, value: parseEther("0.03"), data: buy });
const held = await agent.execute({ target: sink, value: parseEther("0.08"), data: buy });

console.log(JSON.stringify({ vault, sink, owner: OWNER.address, agent: AGENT.address, held }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
