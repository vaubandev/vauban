// /token/ page: the $VAUBAN facts anyone can check, read straight from Robinhood Chain.
// No price, no prediction. Every figure links back to the chain it came from.
import { type Address, createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi } from "viem";
import { robinhoodChain } from "./index.ts";
import { setShare } from "./share.ts";

const pub = createPublicClient({ chain: robinhoodChain, transport: http() });
const $ = (id: string) => document.getElementById(id)!;
const set = (id: string, v: string) => { $(id).textContent = v; };
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
const MINTED = 1_000_000_000n * 10n ** 18n;
const erc20 = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

type Token = { live: boolean; ca: string; deployer: string; launchBlock: number; fakes?: { ca: string; where: string; seen: string }[]; links?: { chart?: string } };

const whole = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (part: bigint, of: bigint) => (Number((part * 10_000n) / of) / 100).toFixed(2) + "%";

/** Burns by the deployer: every Transfer from it to 0x0 or 0x…dEaD since launch. One address-filtered query per 10M blocks. */
async function deployerBurns(ca: Address, deployer: Address, from: bigint) {
  const head = await pub.getBlockNumber();
  let n = 0, sum = 0n;
  for (let lo = from; lo <= head; lo += 10_000_000n) {
    const hi = lo + 9_999_999n > head ? head : lo + 9_999_999n;
    for (const to of [ZERO, DEAD]) {
      const logs = await pub.getLogs({ address: ca, event: erc20[2], args: { from: deployer, to }, fromBlock: lo, toBlock: hi });
      n += logs.length;
      sum += logs.reduce((s, l) => s + (l.args.value ?? 0n), 0n);
    }
  }
  return { n, sum, head };
}

async function load() {
  const t: Token = await (await fetch("/token.json?t=" + Date.now(), { cache: "no-store" })).json();
  if (!t.live || !isAddress(t.ca) || !isAddress(t.deployer) || !Number.isInteger(t.launchBlock)) {
    set("kStatus", "No token is listed on this site right now.");
    return;
  }
  const ca = getAddress(t.ca), dep = getAddress(t.deployer);
  set("kCa", ca);
  set("kDep", dep);
  ($("kCaLink") as HTMLAnchorElement).href = `https://dexscreener.com/robinhood/${ca}`;
  if (t.links?.chart && /^https:\/\//.test(t.links.chart)) ($("kChart") as HTMLAnchorElement).href = t.links.chart;
  const list = $("kFakes");
  list.replaceChildren();
  for (const f of t.fakes ?? []) {
    if (!isAddress(f.ca)) continue;
    const li = document.createElement("li");
    const a = document.createElement("span");
    a.className = "ct";
    a.textContent = getAddress(f.ca);
    const s = document.createElement("span");
    s.className = "cs";
    s.textContent = `${f.where} · seen ${f.seen}`;
    li.append(a, s);
    list.append(li);
  }

  set("kStatus", "Reading Robinhood Chain…");
  try {
    const [supply, held, dead, burns] = await Promise.all([
      pub.readContract({ address: ca, abi: erc20, functionName: "totalSupply" }),
      pub.readContract({ address: ca, abi: erc20, functionName: "balanceOf", args: [dep] }),
      pub.readContract({ address: ca, abi: erc20, functionName: "balanceOf", args: [DEAD] }),
      deployerBurns(ca, dep, BigInt(t.launchBlock)),
    ]);
    // burned = minted minus what still exists, plus anything parked at 0x…dEaD
    const gone = MINTED - supply + dead;
    set("kMinted", whole(MINTED));
    set("kSupply", whole(supply));
    set("kGone", `${whole(gone)}  (${pct(gone, MINTED)})`);
    set("kDepBurn", `${whole(burns.sum)} in ${burns.n} burn${burns.n === 1 ? "" : "s"}`);
    set("kShare", burns.sum && gone ? `${pct(burns.sum, gone)} of everything burned` : "—");
    set("kHeld", whole(held));
    // app.js counts each figure up to the exact value just written; the final text is always the chain's number
    const count = (window as unknown as { vaubanCount?: (el: HTMLElement) => void }).vaubanCount;
    if (count) ["kMinted", "kSupply"].forEach((id) => count($(id)));
    set("kStatus", `Read at block ${burns.head.toLocaleString("en-US")} · ${new Date().toLocaleTimeString()}`);
    setShare($("kTweet") as HTMLAnchorElement,
      `Vauban token, read from the chain just now:\n\n${whole(gone)} burned (${pct(gone, MINTED)} of the 1B minted), ${burns.n} burns by the deployer wallet, which holds ${whole(held)}.\n\nOne real contract: ${ca}`,
      "https://vauban.works/token/");
    $("kStatus").dataset.kind = "ok";
  } catch (e) {
    set("kStatus", "Could not read the chain right now: " + (e as Error).message.split("\n")[0]);
    $("kStatus").dataset.kind = "err";
  }
}

$("kCopy").addEventListener("click", async () => {
  const v = $("kCa").textContent ?? "";
  try { await navigator.clipboard.writeText(v); } catch {
    const ta = document.createElement("textarea");
    ta.value = v;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  set("kCopy", "Copied");
  setTimeout(() => set("kCopy", "Copy"), 1400);
});

load();
