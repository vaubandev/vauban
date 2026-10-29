// Deploy one VaubanVault to Robinhood Chain (4663). The vault starts empty: nothing listed, nothing capped,
// so no value can leave until the owner draws the sheet.
//
//   DEPLOYER_KEY=0x… node --experimental-strip-types scripts/deploy.ts --owner 0xOwner --agent 0xAgent [--delay 21600] [--yes]
//
// Without --yes it only prints the plan and estimated cost.
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, getAddress, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain, readState, vaubanVaultAbi } from "../src/index.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const key = process.env.DEPLOYER_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set DEPLOYER_KEY (0x + 64 hex) in the environment");
const ownerArg = arg("owner"), agentArg = arg("agent");
if (!ownerArg || !isAddress(ownerArg)) throw new Error("--owner 0x… required");
if (!agentArg || !isAddress(agentArg)) throw new Error("--agent 0x… required");
const owner = getAddress(ownerArg), agent = getAddress(agentArg);
const delay = BigInt(arg("delay") ?? "21600");
if (owner === agent) throw new Error("owner and agent must be different addresses");
if (delay > 7n * 86400n) throw new Error("--delay over 7 days is almost certainly a mistake");

const account = privateKeyToAccount(key);
const rpc = process.env.RPC_URL ?? robinhoodChain.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: robinhoodChain, transport: http(rpc) });
const wallet = createWalletClient({ chain: robinhoodChain, transport: http(rpc), account });

const chainId = await pub.getChainId();
// VAUBAN_ALLOW_LOCAL=1 permits anvil (31337) for rehearsal; nothing else.
const okChain = chainId === 4663 || (process.env.VAUBAN_ALLOW_LOCAL === "1" && chainId === 31337);
if (!okChain) throw new Error(`RPC is chain ${chainId}, expected 4663`);
if (agent === account.address) console.warn("! deployer is the agent — fine, but keep this key away from the owner role");

const deployData = encodeDeployData({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [owner, agent, delay] });
const [bal, gas, price] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.estimateGas({ account, data: deployData }),
  pub.getGasPrice(),
]);
const cost = gas * price;
console.log(JSON.stringify({ chain: chainId, deployer: account.address, owner, agent, gateDelaySec: delay.toString(),
  gas: gas.toString(), estCostEth: formatEther(cost), deployerBalanceEth: formatEther(bal) }, null, 2));
if (bal < cost) throw new Error("deployer balance below estimated cost");
if (!process.argv.includes("--yes")) {
  console.log("dry run — re-run with --yes to deploy");
  process.exit(0);
}

const hash = await wallet.deployContract({ abi: vaubanVaultAbi, bytecode: vaubanVaultBytecode, args: [owner, agent, delay] });
console.log("tx", hash);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error("deploy reverted");
const s = await readState(pub, rcpt.contractAddress);
if (s.owner !== owner || s.agent !== agent || s.gateDelay !== delay || s.frozen) throw new Error("post-deploy state mismatch");
console.log(JSON.stringify({ vault: rcpt.contractAddress, block: rcpt.blockNumber.toString(), verified: true }, null, 2));
