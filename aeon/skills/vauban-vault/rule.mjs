#!/usr/bin/env node
// node rule.mjs 0xVAULT --to 0xTARGET [--value WEI] [--data 0xCALLDATA] [--json]
// Asks the vault, with eth_call, how it would rule on one call. Never signs, never sends.
// Exit: 0 report, 2 VAUBAN_RULE_RPC_DOWN, 3 VAUBAN_RULE_BAD_INPUT, 4 VAUBAN_RULE_NOT_VAUBAN.

import { RPC, CHAIN_ID, ZERO, REFUSAL, SEL, isAddress, word, addrOf, amount, decodeString, call as post, isVauban, fail } from "./vault.mjs";

const RULE = "9a66303e"; // rule(address,uint256,bytes) -> uint8: 0 pass, 1 hold

// Custom error selector -> name and argument layout, from `forge inspect VaubanVault errors`.
const ERRORS = {
  "528ac5eb": ["KeepSealed", []],
  "727969cf": ["CurtainNotListed", ["address", "bytes4"]],
  "7849ef1d": ["CurtainSelfCall", []],
  "74b4cd0c": ["CurtainUnknownSpender", ["address"]],
  "0a8958a9": ["CurtainUnlimitedApproval", []],
  "708e7bd8": ["DitchUncapped", ["address"]],
  "296fc248": ["DitchPerTx", ["address", "uint256", "uint256"]],
  "95d5193f": ["DitchPerHour", ["address", "uint256", "uint256"]],
  "52bcf2c9": ["DitchPerDay", ["address", "uint256", "uint256"]],
};

const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");

/** ABI-encode rule(target, value, data). */
export function encodeRule(target, value, data) {
  const body = data.replace(/^0x/, "");
  const len = body.length / 2;
  const tail = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return "0x" + RULE + pad(target) + pad(BigInt(value).toString(16)) + pad("60") + pad(len.toString(16)) + tail;
}

/** Revert data -> { rampart, code, args, reason }. Unknown selectors are reported, not guessed. `unit` scales a token's amounts. */
export function decodeRefusal(data, unit = null) {
  const sel = (data ?? "").slice(2, 10).toLowerCase();
  const known = ERRORS[sel];
  if (!known) return { rampart: REFUSAL[sel] ?? "call", code: sel ? "0x" + sel : "unknown", args: [], reason: "the call would revert" };
  const [code, types] = known;
  const raw = "0x" + data.slice(10);
  const args = types.map((t, i) => (t === "address" ? addrOf("0x" + raw.slice(2 + i * 64, 2 + (i + 1) * 64)) : t === "bytes4" ? "0x" + raw.slice(2 + i * 64, 2 + i * 64 + 8) : word(raw, i)));
  const asset = (a) => (a === ZERO ? "ETH" : a);
  const amt = (a, n) => (a === ZERO ? amount(n, 18) + " ETH" : unit ? `${amount(n, unit.decimals)} ${unit.symbol}` : n.toString());
  const reason = {
    KeepSealed: () => "the owner has frozen the vault",
    CurtainNotListed: () => `${args[0]} selector ${args[1]} is not on the allowlist`,
    CurtainSelfCall: () => "the agent may not call the vault itself",
    CurtainUnknownSpender: () => `spender ${args[0]} is not a listed contract`,
    CurtainUnlimitedApproval: () => "unlimited approvals are always refused",
    DitchUncapped: () => `no caps are set for ${asset(args[0])}, so it cannot move`,
    DitchPerTx: () => `${amt(args[0], args[1])} is over the per-tx cap of ${amt(args[0], args[2])}`,
    DitchPerHour: () => `this hour would reach ${amt(args[0], args[1])}, over the cap of ${amt(args[0], args[2])}`,
    DitchPerDay: () => `today would reach ${amt(args[0], args[1])}, over the cap of ${amt(args[0], args[2])}`,
  }[code]();
  return { rampart: REFUSAL[sel], code, args: args.map(String), reason };
}

export function render(r) {
  const lines = [`# Vauban ruling for ${r.vault}`, "", `Block ${r.block} on chain ${r.chainId}.`, "", `Call: \`${r.to}\` value ${r.value} wei, selector ${r.selector}`, ""];
  if (!r.isVauban) return lines.concat(["This address is not a Vauban vault, so nothing was asked.", ""]).join("\n");
  if (r.ruling === "pass") lines.push("**PASS** - the vault would let this call land now.");
  else if (r.ruling === "hold") lines.push("**HOLD** - the vault would queue this at the gate. It lands only after the delay, and the owner can cancel it.");
  else lines.push(`**REFUSED** at the ${r.rampart.toUpperCase()} - ${r.reason}.`);
  if (r.room) {
    const eth = r.room.asset === ZERO, tok = r.room.unit;
    const fmt = (n) => (eth ? amount(BigInt(n), 18) + " ETH" : tok ? `${amount(BigInt(n), tok.decimals)} ${tok.symbol}` : `${n} base units`);
    const most = `Up to ${fmt(r.room.now)} would pass the caps now`;
    const at = new Date(Number(r.room.resets) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    let hint = r.code === "DitchPerTx" ? `${most}, in one call.` : BigInt(r.room.now) > 0n ? `${most}; more room at ${at}.` : `Nothing passes until ${at}.`;
    const hold = BigInt(r.room.holdAbove ?? 0);
    if (hold > 0n && BigInt(r.room.now) > hold) hint += ` Above ${fmt(hold)} it waits at the gate first.`;
    lines.push("", hint);
  }
  lines.push("", "A ruling is a dry run at this block. Caps and the sheet can change before the agent sends. The vault is not audited.", "");
  return lines.join("\n");
}

async function rawCall(url, body) {
  const res = await post(url, body);
  if ([429, 502, 503, 504].includes(res.status)) throw new Error("rpc busy");
  return JSON.parse(res.body);
}

/** A token's symbol and decimals at `head`, or null if it does not report both. */
async function unitOf(url, token, head) {
  try {
    const out = (await rawCall(url, [
      { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: token, data: "0x" + SEL.symbol }, head] },
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: "0x" + SEL.decimals }, head] },
    ])).sort((a, b) => a.id - b.id);
    if (out.some((r) => r.error || !r.result || r.result === "0x")) return null;
    const symbol = decodeString(out[0].result);
    const decimals = Number(word(out[1].result, 0));
    return symbol && decimals <= 36 ? { symbol, decimals } : null;
  } catch {
    return null;
  }
}

/** What the caps still allow for one asset at block `head`; null if any read fails. */
async function roomAt(url, vault, asset, head) {
  const arg = asset.slice(2).toLowerCase().padStart(64, "0");
  try {
    const out = (await rawCall(url, [
      { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: vault, data: "0x" + SEL.limits + arg }, head] },
      { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: vault, data: "0x" + SEL.spent + arg }, head] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [head, false] },
    ])).sort((a, b) => a.id - b.id);
    if (out.some((r) => r.error)) return null;
    const [l, s, b] = out.map((r) => r.result);
    const t = BigInt(b.timestamp), h = t / 3600n, d = t / 86400n;
    const left = (cap, used) => (cap > used ? cap - used : 0n);
    const hourLeft = left(word(l, 2), word(s, 0) === h ? word(s, 2) : 0n);
    const dayLeft = left(word(l, 3), word(s, 1) === d ? word(s, 3) : 0n);
    const now = [word(l, 1), hourLeft, dayLeft].reduce((a, x) => (x < a ? x : a));
    const resets = hourLeft < dayLeft ? (h + 1n) * 3600n : (d + 1n) * 86400n;
    return { asset: asset.toLowerCase(), now: now.toString(), hourLeft: hourLeft.toString(), dayLeft: dayLeft.toString(), resets: resets.toString(), holdAbove: word(l, 4).toString() };
  } catch {
    return null;
  }
}

export async function ruleOf(url, vault, to, value, data) {
  const [chain, head, code] = (await rawCall(url, [
    { jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [vault, "latest"] },
  ])).sort((a, b) => a.id - b.id).map((r) => r.result);
  // VAUBAN_CHAIN_ID lets a test point at a local chain. The skill never sets it.
  if (Number(chain) !== Number(process.env.VAUBAN_CHAIN_ID ?? CHAIN_ID)) throw new Error("wrong chain");
  const base = { vault, chainId: Number(chain), block: BigInt(head).toString(), to, value: value.toString(), selector: data.length >= 10 ? data.slice(0, 10) : "0x00000000 (plain send)", isVauban: isVauban(code) };
  if (!base.isVauban) return base;
  const out = await rawCall(url, { jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: vault, data: encodeRule(to, value, data) }, head] });
  if (out.error) {
    if (typeof out.error.data !== "string" || !out.error.data.startsWith("0x")) throw new Error(out.error.message ?? "rpc");
    let refusal = decodeRefusal(out.error.data);
    if (!refusal.code.startsWith("DitchPer")) return { ...base, ruling: "refused", ...refusal };
    const asset = refusal.args[0];
    const unit = asset === ZERO ? null : await unitOf(url, asset, head);
    if (unit) refusal = decodeRefusal(out.error.data, unit);
    const room = await roomAt(url, vault, asset, head);
    return { ...base, ruling: "refused", ...refusal, ...(room ? { room: { ...room, ...(unit ? { unit } : {}) } } : {}) };
  }
  return { ...base, ruling: word(out.result, 0) === 1n ? "hold" : "pass" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
  const vault = args.find((a) => isAddress(a) && a !== flag("to"));
  const to = flag("to");
  const value = flag("value") ?? "0";
  const data = flag("data") ?? "0x";
  if (!vault || !isAddress(to) || !/^\d+$/.test(value) || !/^0x([0-9a-fA-F]{2})*$/.test(data)) fail(3, "VAUBAN_RULE_BAD_INPUT");
  let r;
  try { r = await ruleOf(RPC, vault, to, BigInt(value), data); }
  catch { fail(2, "VAUBAN_RULE_RPC_DOWN"); }
  process.stdout.write(args.includes("--json") ? JSON.stringify(r, null, 2) + "\n" : render(r));
  if (!r.isVauban) fail(4, "VAUBAN_RULE_NOT_VAUBAN");
}
