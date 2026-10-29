// Shared, dependency-free reads of a Vauban vault. No network at import time.
import { createHash } from "node:crypto";
import { request } from "node:http";
import { request as requestTls } from "node:https";

export const RPC = "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
export const WINDOW = 10_000_000; // widest eth_getLogs range this RPC serves
export const CODEHASH = "68c0d5c0bd112e54d96057e0162229d01904042b6ee08e372fd8ae4f5b3d795b";
export const SEL = {owner:'8da5cb5b',agent:'f5ff5c76',frozen:'054f7d9c',gateDelay:'73d872d9',revision:'7cc96380',limits:'20d7bec1',spent:'1e6a41ea',held:'477809b1',symbol:'95d89b41',decimals:'313ce567'};
export const ZERO = "0x" + "0".repeat(40);

export const TOPIC = {
  born: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  listed: "0x0c2c6fc761095d974d40ecb258ea42c933a4da10e67273b94992758442ff970f",
  limits: "0x1da15b421511e6907467bcfbabb6e83a9759da64fb3a35ea439656391ab003a0",
  held: "0x825c8ee59c047b7a11d339901f383dac821b053cef51f44d176d21152f16aa5d",
  passed: "0x44d639f7b5d1bebd75d05b4ecac3f6e4fe7d58a893341aba34cae6613e8ea112",
  cancelled: "0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70",
  frozen: "0x59800d968fcce138300a0019410b4b75041610d65b3cdc5f31656b03ed14912e",
  revised: "0x6e396392ff3042c11f8cfbf4bd0247855ea728053f31a430df9522b044fefd57",
};

// revert selector -> rampart. From `forge inspect VaubanVault errors`.
export const REFUSAL = {
  "528ac5eb": "keep", "727969cf": "curtain", "7849ef1d": "curtain", "0a8958a9": "curtain",
  "74b4cd0c": "curtain", "708e7bd8": "ditch", "296fc248": "ditch", "95d5193f": "ditch",
  "52bcf2c9": "ditch", "ab812d61": "gate", "88c6b9be": "gate", "d193a639": "gate",
};

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s ?? "");
export const hex = (n) => "0x" + BigInt(n).toString(16);
export const word = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
export const addrOf = (word64) => "0x" + word64.slice(26);
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

export function codeHash(code) {
  return code && code !== "0x" ? createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex") : null;
}
export const isVauban = (code) => codeHash(code) === CODEHASH;

export function decodeString(data) {
  if (!data || data === "0x" || !/^0x(?:[0-9a-fA-F]{64})+$/.test(data)) return null;
  const raw = data.slice(2);
  if (raw.length === 64) return Buffer.from(raw, "hex").toString("utf8").replace(/\0+$/, "") || null;
  const start = Number(word(data, 0)) * 2;
  const len = Number(BigInt("0x" + raw.slice(start, start + 64)));
  return Buffer.from(raw.slice(start + 64, start + 64 + len * 2), "hex").toString("utf8");
}

/** What one vault log changed. Pure: same logs always rebuild the same sheet. */
export function applyLog(sheet, log) {
  const t = (log.topics?.[0] ?? "").toLowerCase();
  const id = log.topics?.[1]?.toLowerCase();
  if (t === TOPIC.listed) {
    const target = addrOf(log.topics[1]);
    const sel = "0x" + log.topics[2].slice(2, 10);
    const set = sheet.allow.get(target) ?? new Set();
    if (word(log.data, 0) === 1n) set.add(sel); else set.delete(sel);
    sheet.allow.set(target, set);
  } else if (t === TOPIC.limits) {
    const asset = addrOf(log.topics[1]);
    if (word(log.data, 0) === 1n) sheet.limits.set(asset, log.data);
    else sheet.limits.delete(asset);
  } else if (t === TOPIC.held) {
    // HeldAtGate(bytes32 indexed id, address indexed target, uint256 value, bytes data, uint64 eta).
    // Both addresses are indexed, so data is (value, offset, eta, bytes...).
    sheet.held.set(id, { target: addrOf(log.topics[2]), value: word(log.data, 0), eta: word(log.data, 2) });
  } else if (t === TOPIC.cancelled) {
    sheet.held.delete(id);
  } else if (t === TOPIC.passed && word(log.data, 1) !== 0n) {
    sheet.held.delete("0x" + log.data.slice(66, 130));
  }
  return sheet;
}

export function emptySheet() {
  return { allow: new Map(), limits: new Map(), held: new Map() };
}

export function fold(logs) {
  return logs.reduce((s, l) => applyLog(s, l), emptySheet());
}

function call(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? requestTls : request;
    const req = lib({ method: "POST", hostname: u.hostname, port: u.port || undefined, path: u.pathname, headers: { "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

export async function rpc(url, calls) {
  for (let i = 0; i < 5; i++) {
    let res;
    try { res = await call(url, calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c[0], params: c[1] }))); }
    catch { await new Promise((r) => setTimeout(r, 400 * (i + 1))); continue; }
    if ([429, 502, 503, 504].includes(res.status)) { await new Promise((r) => setTimeout(r, 400 * (i + 1))); continue; }
    const out = JSON.parse(res.body);
    const list = Array.isArray(out) ? out : [out];
    if (list.some((r) => r.error)) throw new Error(list.find((r) => r.error).error.message ?? "rpc");
    list.sort((a, b) => a.id - b.id);
    return list.map((r) => r.result);
  }
  throw new Error("gave up");
}

/** Logs from deployment to head. Stops early once the constructor event is in hand. */
export async function vaultLogs(url, vault, head) {
  const out = [];
  for (let to = BigInt(head); to > 0n;) {
    const from = to > BigInt(WINDOW) ? to - BigInt(WINDOW) + 1n : 0n;
    const [batch] = await rpc(url, [["eth_getLogs", [{ address: vault, fromBlock: hex(from), toBlock: hex(to) }]]]);
    out.push(...batch);
    if (batch.some((l) => l.topics?.[0] === TOPIC.born && l.topics?.[1] === pad(ZERO))) break;
    to = from - 1n;
  }
  return out.sort((a, b) => (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1));
}

export function amount(n, decimals) {
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}

export function fail(code, name) {
  process.stderr.write(name + "\n");
  process.exit(code);
}
