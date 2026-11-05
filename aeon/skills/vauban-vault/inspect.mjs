#!/usr/bin/env node
// node inspect.mjs 0xVAULT [--json]
// Exit: 0 report, 2 VAUBAN_INSPECT_RPC_DOWN, 3 VAUBAN_INSPECT_BAD_VAULT, 4 VAUBAN_INSPECT_NOT_VAUBAN.
// Same rules, codes and order as inspect() in @vaubanworks/sdk; sdk/test/aeon-inspect.test.ts keeps them equal.

import { RPC, CHAIN_ID, ZERO, SEL, isAddress, isVauban, word, addrOf, decodeString, fold, vaultLogs, amount, rpc, fail } from "./vault.mjs";

const TOKEN_MOVES = new Set(["0xa9059cbb", "0x23b872dd", "0x095ea7b3", "0x39509351"]);
const PLAIN = "0x00000000";
const call = (to, sel, arg = "") => ["eth_call", [{ to, data: "0x" + sel + arg }, "latest"]];
const arg = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const eth = (v) => amount(v, 18) + " ETH";
const cs = (a) => a.toLowerCase();

/** Limit findings for one asset. ETH keeps its original codes; tokens get the same checks prefixed "token-". */
function capFindings(c, label, fmt, token) {
  const f = [];
  const code = (k) => (token ? "token-" + k : k);
  if (c.perDay === 0n || c.perTx === 0n)
    f.push({ level: "info", code: token ? "token-zero" : "eth-zero", text: `A ${label} limit is 0: no ${label} can move.` });
  if (c.perTx > c.perHour)
    f.push({ level: "warn", code: code("tx-over-hour"), text: `Per-call limit ${fmt(c.perTx)} is above the hourly ${fmt(c.perHour)}; the real per-call limit is ${fmt(c.perHour)}.` });
  if (c.perHour > c.perDay)
    f.push({ level: "warn", code: code("hour-over-day"), text: `Hourly limit ${fmt(c.perHour)} is above the daily ${fmt(c.perDay)}; the real hourly limit is ${fmt(c.perDay)}.` });
  if (c.holdAbove === 0n)
    f.push({ level: "warn", code: code("gate-off"), text: `No hold threshold: every allowed ${label} move lands at once, nothing waits at the gate.` });
  else if (c.holdAbove >= c.perTx)
    f.push({ level: "warn", code: code("gate-unreachable"), text: `Hold threshold ${fmt(c.holdAbove)} is not below the per-call limit ${fmt(c.perTx)}, so nothing can ever be held: larger moves are refused first.` });
  return f;
}

// the contract checks caps before the gate, so a hold line at or above perTx never holds anything
const gateCanHold = (c) => c.holdAbove !== 0n && c.holdAbove < c.perTx;

/** Pure: facts read from the chain -> findings. */
export function findings(v) {
  const f = [];
  if (cs(v.owner) === cs(v.agent))
    f.push({ level: "risk", code: "owner-is-agent", text: "The agent is also the owner, so it can rewrite its own rules. Give the agent its own key." });
  if (cs(v.pendingOwner) !== ZERO)
    f.push({ level: "warn", code: "pending-owner", text: `Ownership is offered to ${v.pendingOwner} and not yet accepted. Until it is, the current owner still holds the vault.` });
  if (v.frozen)
    f.push({ level: "info", code: "sealed", text: "The keep is sealed: the agent can do nothing until the owner opens it." });

  if (!v.eth.set) f.push({ level: "info", code: "eth-unset", text: "No ETH limits: any call that sends ETH is refused." });
  else f.push(...capFindings(v.eth, "ETH", eth, false));

  const later = [];
  let anyGate = v.eth.set && gateCanHold(v.eth);
  for (const t of v.targets) {
    const calls = t.selectors.filter((x) => x !== PLAIN);
    if (!t.hasCode && calls.length)
      later.push({ level: "warn", code: "eoa-target", text: `${t.target} has no contract code, yet ${calls.join(", ")} is allowed on it. A call there only sends ETH.` });
    const moves = t.selectors.filter((x) => TOKEN_MOVES.has(x));
    if (!moves.length) continue;
    if (!t.caps.set) {
      later.push({ level: "warn", code: "token-unset", text: `Token moves (${moves.join(", ")}) are allowed on ${t.target}, but it has no limits, so any amount above 0 is refused.` });
      continue;
    }
    const label = t.symbol ?? t.target;
    later.push(...capFindings(t.caps, label, (x) => `${amount(x, t.decimals)} ${label}`, true));
    anyGate ||= gateCanHold(t.caps);
  }
  if (anyGate && v.gateDelay === 0n)
    f.push({ level: "warn", code: "gate-instant", text: "Gate delay is 0: held moves can be released at once, the owner has no time to cancel." });
  f.push(...later);
  if (!v.targets.length)
    f.push({ level: "info", code: "curtain-empty", text: "Nothing is allowed yet: the agent can call nothing." });
  return f;
}

export function render(r) {
  const lines = [`# Vauban inspection ${r.vault}`, "", `Block ${r.block} on chain ${r.chainId}.`, ""];
  if (!r.isVauban) return lines.concat(["This address is not a Vauban vault, so nothing was inspected.", ""]).join("\n");
  const serious = r.findings.filter((x) => x.level !== "info");
  lines.push(serious.length ? `VAUBAN INSPECT ${serious.length} to check` : "VAUBAN INSPECT CLEAR", "");
  const tag = { risk: "RISK", warn: "CHECK", info: "NOTE" };
  for (const x of r.findings) lines.push(`- **${tag[x.level]}** ${x.text}`);
  lines.push("", "Checks the vault's own settings against how it rules. It is not an audit of the contract.", "");
  return lines.join("\n");
}

export async function inspectOf(url, vault) {
  if (!isAddress(vault)) fail(3, "VAUBAN_INSPECT_BAD_VAULT");
  let chain, head, code;
  try {
    [chain, head, code] = await rpc(url, [["eth_chainId", []], ["eth_blockNumber", []], ["eth_getCode", [vault, "latest"]]]);
  } catch { fail(2, "VAUBAN_INSPECT_RPC_DOWN"); }
  // VAUBAN_CHAIN_ID lets a test point at a local chain. The skill never sets it.
  if (Number(chain) !== Number(process.env.VAUBAN_CHAIN_ID ?? CHAIN_ID)) fail(2, "VAUBAN_INSPECT_RPC_DOWN");
  const base = { vault, chainId: Number(chain), block: BigInt(head).toString(), isVauban: isVauban(code) };
  if (!base.isVauban) return base;
  try {
    const [owner, agent, pending, frozen, delay, lim] = await rpc(url, [
      call(vault, SEL.owner), call(vault, SEL.agent), call(vault, SEL.pendingOwner),
      call(vault, SEL.frozen), call(vault, SEL.gateDelay), call(vault, SEL.limits, arg(ZERO)),
    ]);
    const sheet = fold(await vaultLogs(url, vault, BigInt(head)));
    const listed = [...sheet.allow].filter(([, s]) => s.size);
    const targets = [];
    for (const [target, sels] of listed) {
      const selectors = [...sels].sort();
      // confirm against allowed(), as the SDK does, so a pruned log range never shows a stale entry
      const live = await rpc(url, selectors.map((s) => call(vault, SEL.allowed, arg(target) + s.slice(2).padEnd(64, "0"))));
      const kept = selectors.filter((_, i) => word(live[i], 0) === 1n);
      if (!kept.length) continue;
      const [tcode, tl] = await rpc(url, [["eth_getCode", [target, "latest"]], call(vault, SEL.limits, arg(target))]);
      const caps = { set: word(tl, 0) === 1n, perTx: word(tl, 1), perHour: word(tl, 2), perDay: word(tl, 3), holdAbove: word(tl, 4) };
      let symbol = null, decimals = 18;
      if (caps.set && kept.some((s) => TOKEN_MOVES.has(s))) {
        try { symbol = decodeString((await rpc(url, [call(target, SEL.symbol)]))[0]); } catch { symbol = null; }
        try { decimals = Number(word((await rpc(url, [call(target, SEL.decimals)]))[0], 0)); } catch { decimals = 18; }
      }
      targets.push({ target, selectors: kept, hasCode: !!tcode && tcode !== "0x", caps, symbol, decimals });
    }
    const v = {
      owner: addrOf(owner), agent: addrOf(agent), pendingOwner: addrOf(pending),
      frozen: word(frozen, 0) === 1n, gateDelay: word(delay, 0),
      eth: { set: word(lim, 0) === 1n, perTx: word(lim, 1), perHour: word(lim, 2), perDay: word(lim, 3), holdAbove: word(lim, 4) },
      targets,
    };
    return { ...base, findings: findings(v) };
  } catch { fail(2, "VAUBAN_INSPECT_RPC_DOWN"); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const vault = args.find((a) => !a.startsWith("--"));
  if (!vault) fail(3, "VAUBAN_INSPECT_BAD_VAULT");
  const r = await inspectOf(RPC, vault);
  process.stdout.write(args.includes("--json") ? JSON.stringify(r, null, 2) + "\n" : render(r));
  if (!r.isVauban) fail(4, "VAUBAN_INSPECT_NOT_VAUBAN");
}
