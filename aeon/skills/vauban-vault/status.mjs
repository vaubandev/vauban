#!/usr/bin/env node
// node vauban_status.mjs 0xVAULT [--json]
// Exit: 0 report, 2 VAUBAN_STATUS_RPC_DOWN, 3 VAUBAN_STATUS_BAD_VAULT, 4 VAUBAN_STATUS_NOT_VAUBAN.

import { RPC, CHAIN_ID, ZERO, SEL, isAddress, isVauban, word, addrOf, decodeString, fold, vaultLogs, amount, rpc, fail } from "./vault.mjs";

export function render(v) {
  const lines = [`# Vauban vault ${v.vault}`, "", `Block ${v.block} on chain ${v.chainId}.`];
  if (!v.isVauban) return lines.concat(["", "This address is not a Vauban vault, so nothing else was read.", ""]).join("\n");
  const name = (a) => (a === ZERO ? "ETH" : v.symbols[a] ?? a);
  lines.push(
    "", `- Owner \`${v.owner}\``, `- Agent \`${v.agent}\``, `- Frozen: ${v.frozen ? "yes" : "no"}`,
    `- Revision ${v.revision}`, `- Gate delay ${v.gateDelay}s`, "", "## Allowlist",
  );
  if (!v.allow.length) lines.push("Nothing listed.");
  for (const row of v.allow) lines.push(`- \`${row.target}\`: ${row.selectors.map((s) => `\`${s}\``).join(", ")}`);
  lines.push("", "## Caps");
  if (!v.caps.length) lines.push("No caps set. An asset without caps cannot move.");
  for (const c of v.caps) {
    lines.push(`- ${name(c.asset)}: per tx ${amount(c.perTx, c.decimals)}, per hour ${amount(c.perHour, c.decimals)} (${amount(c.hourLeft, c.decimals)} left), per day ${amount(c.perDay, c.decimals)} (${amount(c.dayLeft, c.decimals)} left), hold above ${amount(c.holdAbove, c.decimals)}`);
  }
  lines.push("", "## Held at the gate");
  if (!v.held.length) lines.push("Nothing held.");
  for (const h of v.held) lines.push(`- \`${h.id}\` to \`${h.target}\` value ${h.value}, releasable ${new Date(Number(h.eta) * 1000).toISOString()}`);
  lines.push("", "Caps cover only transfer, transferFrom, approve and increaseAllowance. The vault is not audited.", "");
  return lines.join("\n");
}

const call = (to, sel, arg = "") => ["eth_call", [{ to, data: "0x" + sel + arg }, "latest"]];

export async function statusOf(url, vault) {
  if (!isAddress(vault)) fail(3, "VAUBAN_STATUS_BAD_VAULT");
  let chain, head, code;
  try {
    [chain, head, code] = await rpc(url, [["eth_chainId", []], ["eth_blockNumber", []], ["eth_getCode", [vault, "latest"]]]);
  } catch { fail(2, "VAUBAN_STATUS_RPC_DOWN"); }
  // VAUBAN_CHAIN_ID lets a test point at a local chain. The skill never sets it.
  const expect = Number(process.env.VAUBAN_CHAIN_ID ?? CHAIN_ID);
  if (Number(chain) !== expect) fail(2, "VAUBAN_STATUS_RPC_DOWN");
  const block = BigInt(head);
  let stamp = 0n;
  try { const [b] = await rpc(url, [["eth_getBlockByNumber", [head, false]]]); stamp = BigInt(b.timestamp); }
  catch { fail(2, "VAUBAN_STATUS_RPC_DOWN"); }
  const base = { vault, chainId: Number(chain), block: block.toString(), isVauban: isVauban(code) };
  if (!base.isVauban) return base;
  try {
    const [owner, agent, frozen, gateDelay, revision] = await rpc(url, ["owner", "agent", "frozen", "gateDelay", "revision"].map((k) => call(vault, SEL[k])));
    const sheet = fold(await vaultLogs(url, vault, block));
    const rows = await Promise.all([...sheet.limits.keys()].map(async (a) => {
      const arg = a.slice(2).padStart(64, "0");
      const [limits, spent] = await rpc(url, [call(vault, SEL.limits, arg), call(vault, SEL.spent, arg)]);
      let symbol = null; let decimals = 18;
      if (a !== ZERO) {
        try { symbol = decodeString((await rpc(url, [["eth_call", [{ to: a, data: "0x" + SEL.symbol }, "latest"]]]))[0]); } catch { symbol = null; }
        try { decimals = Number(word((await rpc(url, [call(a, SEL.decimals)]))[0], 0)); } catch { /* default 18 */ }
      }
      return { asset: a, limits, spent, symbol, decimals };
    }));
    const left = (cap, used) => (cap > used ? cap - used : 0n);
    const caps = rows.filter((r) => word(r.limits, 0) === 1n).map((r) => ({
      asset: r.asset, decimals: r.decimals,
      perTx: word(r.limits, 1), perHour: word(r.limits, 2), perDay: word(r.limits, 3), holdAbove: word(r.limits, 4),
      hourLeft: left(word(r.limits, 2), word(r.spent, 0) === stamp / 3600n ? word(r.spent, 2) : 0n),
      dayLeft: left(word(r.limits, 3), word(r.spent, 1) === stamp / 86400n ? word(r.spent, 3) : 0n),
    }));
    const held = [];
    for (const [id, h] of sheet.held) {
      const [on] = await rpc(url, [call(vault, SEL.held, id.slice(2))]);
      if (word(on, 1) !== 0n) held.push({ id, target: h.target, value: h.value.toString(), eta: h.eta.toString() });
    }
    return {
      ...base, owner: addrOf(owner), agent: addrOf(agent), frozen: word(frozen, 0) === 1n,
      gateDelay: word(gateDelay, 0).toString(), revision: word(revision, 0).toString(),
      symbols: Object.fromEntries(rows.filter((r) => r.symbol).map((r) => [r.asset, r.symbol])),
      allow: [...sheet.allow].filter(([, s]) => s.size).map(([target, s]) => ({ target, selectors: [...s].sort() })),
      caps, held,
    };
  } catch { fail(2, "VAUBAN_STATUS_RPC_DOWN"); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const vault = args.find((a) => !a.startsWith("--"));
  if (!vault) fail(3, "VAUBAN_STATUS_BAD_VAULT");
  const v = await statusOf(RPC, vault);
  const json = JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
  process.stdout.write(args.includes("--json") ? json + "\n" : render(v));
  if (!v.isVauban) fail(4, "VAUBAN_STATUS_NOT_VAUBAN");
}
