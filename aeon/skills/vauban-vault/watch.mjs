#!/usr/bin/env node
// node watch.mjs --watch 0xA,0xB --state memory/state/vauban-vault.json
// Exit: 0 report, 2 VAUBAN_WATCH_RPC_DOWN, 3 VAUBAN_WATCH_BAD_WATCH, 4 VAUBAN_WATCH_NO_VAULT.
// The first run only records the current block, so installing it never replays history.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RPC, CHAIN_ID, TOPIC, isAddress, isVauban, word, addrOf, hex, rpc, fail } from "./vault.mjs";

const WATCHED = [TOPIC.held, TOPIC.passed, TOPIC.cancelled, TOPIC.frozen, TOPIC.listed, TOPIC.limits, TOPIC.revised];

function watchList(argv) {
  const i = argv.indexOf("--watch");
  const raw = i >= 0 ? argv[i + 1] ?? "" : "";
  if (raw.trim()) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    return [...readFileSync("memory/state/vauban-watch.yml", "utf8").matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
  } catch { return []; }
}

/** One vault log as a single readable line. Null for events this skill does not report. */
export function classify(log) {
  const t = (log.topics?.[0] ?? "").toLowerCase();
  const v = (log.address ?? "").toLowerCase();
  if (t === TOPIC.held) {
    const eta = word(log.data, 2);
    return `${v} held ${word(log.data, 0)} for ${addrOf(log.topics[2])} until ${new Date(Number(eta) * 1000).toISOString()}`;
  }
  if (t === TOPIC.passed) return `${v} passed ${addrOf(log.topics[1])} selector 0x${log.topics[2].slice(2, 10)} value ${word(log.data, 0)}`;
  if (t === TOPIC.cancelled) return `${v} cancelled ${log.topics[1]}`;
  if (t === TOPIC.frozen) return `${v} ${word(log.data, 0) === 1n ? "frozen" : "unfrozen"}`;
  if (t === TOPIC.listed) return `${v} ${word(log.data, 0) === 1n ? "listed" : "unlisted"} ${addrOf(log.topics[1])} 0x${log.topics[2].slice(2, 10)}`;
  if (t === TOPIC.limits) return `${v} limits ${word(log.data, 0) === 1n ? "set" : "cleared"} for ${addrOf(log.topics[1])}`;
  // PolicyRevised(uint64 indexed revision): the value is in topics[1], data is empty.
  if (t === TOPIC.revised) return `${v} revision ${BigInt(log.topics[1])}`;
  return null;
}

function describe(log) {
  try { return classify(log); }
  catch { return `${(log.address ?? "").toLowerCase()} logged an event this skill could not decode (tx ${log.transactionHash ?? "unknown"})`; }
}

export function render(lines) {
  return lines.length ? "VAUBAN CHANGED\n\n" + lines.map((l) => `- ${l}`).join("\n") + "\n" : "VAUBAN QUIET\n";
}

export async function changesSince(url, vaults, fromBlock, toBlock) {
  const [logs] = await rpc(url, [[
    "eth_getLogs",
    [{ address: vaults, fromBlock: hex(BigInt(fromBlock) + 1n), toBlock: hex(toBlock), topics: [WATCHED] }],
  ]]);
  return logs.map(describe).filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--state");
  const statePath = at >= 0 ? args[at + 1] : "memory/state/vauban-vault.json";
  const list = watchList(args);
  if (!list.length) fail(4, "VAUBAN_WATCH_NO_VAULT");
  if (list.some((a) => !isAddress(a))) fail(3, "VAUBAN_WATCH_BAD_WATCH");

  let chain, head, codes;
  try {
    [chain, head, ...codes] = await rpc(RPC, [
      ["eth_chainId", []], ["eth_blockNumber", []], ...list.map((a) => ["eth_getCode", [a, "latest"]]),
    ]);
  } catch { fail(2, "VAUBAN_WATCH_RPC_DOWN"); }
  if (Number(chain) !== CHAIN_ID) fail(2, "VAUBAN_WATCH_RPC_DOWN");

  const vaults = list.filter((_, i) => isVauban(codes[i])).map((a) => a.toLowerCase());
  const notes = list.filter((_, i) => !isVauban(codes[i])).map((a) => `${a} is not a Vauban vault`);

  let from = null;
  try { from = JSON.parse(readFileSync(statePath, "utf8")).lastBlock ?? null; } catch { /* first run */ }
  let changes = [];
  if (from !== null && vaults.length && BigInt(head) > BigInt(from)) {
    try { changes = await changesSince(RPC, vaults, from, head); }
    catch { fail(2, "VAUBAN_WATCH_RPC_DOWN"); }
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ lastBlock: head, vaults }));
  process.stdout.write(render([...notes, ...changes]));
}
