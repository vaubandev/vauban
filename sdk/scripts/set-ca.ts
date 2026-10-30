// Turn the site's CA bar on or off. Refuses any address that is not a Pons v2 launch paired with USDG
// whose symbol is VAUBAN, so a lookalike token can never be published by mistake.
//   node --experimental-strip-types scripts/set-ca.ts 0xCA [--chart https://...] [--deployer 0x...] [--no-deploy]
//   node --experimental-strip-types scripts/set-ca.ts --unset [--no-deploy]
import { createPublicClient, http, getAddress, isAddress, parseAbi, type Address } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { robinhoodChain } from "../src/index.ts";

const SITE = new URL("../../site/", import.meta.url);
const TOKEN = new URL("token.json", SITE);
const FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TICKER = "VAUBAN";

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes("--" + n);
const die = (m: string): never => { console.error("REFUSED: " + m); process.exit(1); };

function write(body: object) {
  writeFileSync(TOKEN, JSON.stringify(body, null, 2) + "\n");
  console.log("wrote site/token.json");
  if (has("no-deploy")) return console.log("--no-deploy: not deployed");
  execFileSync("npx", ["vercel", "deploy", "--prod", "--yes", "--scope", "paiditadis-projects"], { cwd: SITE, stdio: "inherit" });
}

const current = JSON.parse(readFileSync(TOKEN, "utf8"));

if (has("unset")) {
  write({ live: false, ticker: "", chain: 4663, ca: "", links: { chart: "" } });
  process.exit(0);
}

const raw = argv.find((a) => !a.startsWith("--") && a !== flag("chart") && a !== flag("deployer"));
if (!raw || !isAddress(raw)) die("give the token address: set-ca.ts 0x…");
const ca = getAddress(raw!);
const chart = flag("chart") ?? "";
if (chart && !/^https:\/\/[^\s"'<>]+$/.test(chart)) die("--chart must be a plain https:// URL");

const pub = createPublicClient({ chain: robinhoodChain, transport: http(process.env.RPC_URL ?? robinhoodChain.rpcUrls.default.http[0]) });
if ((await pub.getChainId()) !== 4663) die("RPC is not Robinhood Chain (4663)");
const code = await pub.getCode({ address: ca });
if (!code || code === "0x") die(`no contract at ${ca} on 4663`);

const t = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [ca] });
if (!t.exists) die(`${ca} was not launched by the Pons v2 factory`);
if (getAddress(t.pairToken) !== USDG) die(`pair is ${t.pairToken}, expected USDG ${USDG}`);
const symbol = await pub.readContract({ address: ca, abi: erc20, functionName: "symbol" });
if (symbol !== TICKER) die(`symbol is "${symbol}", expected "${TICKER}"`);
const want = flag("deployer");
if (want && (!isAddress(want) || getAddress(want) !== getAddress(t.deployer))) die(`deployer is ${t.deployer}, not ${want}`);

const name = await pub.readContract({ address: ca, abi: erc20, functionName: "name" });
console.log(JSON.stringify({ ca, name, symbol, deployer: t.deployer, pair: "USDG", curve: t.curve, phase: t.phase, creatorTaxBps: t.creatorTaxBps }, null, 2));
if (current.live && current.ca && getAddress(current.ca) !== ca && !has("replace")) die(`site already shows ${current.ca}; pass --replace to change it`);

write({ live: true, ticker: TICKER, chain: 4663, ca, links: { chart } });
