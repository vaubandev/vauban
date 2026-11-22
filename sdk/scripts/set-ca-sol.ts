// Put a pump.fun (Solana) mint on the site's CA bar and /token/. Refuses anything that is not a live SPL mint
// whose on-chain symbol is VAUBAN, then deploys and checks the live site serves it.
//   node --experimental-strip-types scripts/set-ca-sol.ts <MINT> [--no-deploy]
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SITE = new URL("../../site/", import.meta.url);
const RPC = "https://api.mainnet-beta.solana.com";
const TICKER = "VAUBAN";
const SPL = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EpFLC1PSnBkp7Ma2wJNSb"]);

const argv = process.argv.slice(2);
const mint = argv.find((a) => !a.startsWith("--")) ?? "";
const die = (m: string): never => { console.error("REFUSED: " + m); process.exit(1); };
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) die("not a Solana address: " + mint);

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) die(`${method}: ${j.error.message}`);
  return j.result;
}

const acct = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
if (!acct?.value) die("no account at this address on Solana mainnet");
if (!SPL.has(acct.value.owner) || acct.value.data?.parsed?.type !== "mint") die("this address is not an SPL token mint");
const supply = (await rpc("getTokenSupply", [mint])).value;

// pump.fun's own API carries the symbol the mint was launched with
let symbol = "", name = "";
try {
  const p = await (await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`)).json();
  symbol = String(p.symbol ?? ""); name = String(p.name ?? "");
} catch { /* checked below */ }
if (!symbol) {
  const d = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`)).json();
  symbol = String(d?.[0]?.baseToken?.symbol ?? ""); name = String(d?.[0]?.baseToken?.name ?? "");
}
if (symbol.toUpperCase() !== TICKER) die(`symbol is "${symbol || "unknown"}", expected ${TICKER}`);
console.log(`ok: ${name} (${symbol}) mint ${mint}, supply ${BigInt(supply.amount) / 10n ** BigInt(supply.decimals)}`);

writeFileSync(new URL("token.json", SITE), JSON.stringify({ live: true, ticker: TICKER, chain: "solana", ca: mint, links: { chart: `https://pump.fun/coin/${mint}` } }, null, 2) + "\n");
console.log("wrote site/token.json");
if (argv.includes("--no-deploy")) process.exit(0);

execFileSync("npx", ["vercel", "deploy", "--prod", "--yes", "--scope", "paiditadis-projects"], { cwd: SITE, stdio: "inherit" });
for (let i = 0; i < 10; i++) {
  const live = await (await fetch(`https://vauban.works/token.json?t=${Date.now()}`, { cache: "no-store" })).json().catch(() => ({}));
  if (live.ca === mint) { console.log("LIVE: vauban.works serves " + mint); process.exit(0); }
  await new Promise((r) => setTimeout(r, 3000));
}
die("deployed, but vauban.works does not serve the new CA yet; check it by hand");
