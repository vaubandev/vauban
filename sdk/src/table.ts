// Owner's table: browser bundle. Reads a vault over RPC; writes only through the user's own injected wallet.
import {
  type Address, type EIP1193Provider, type Hex,
  createPublicClient, createWalletClient, custom, formatEther, getAddress, http, isAddress, isHex, parseEther,
} from "viem";
import { type HeldMove, type Listing, type RecordEntry, robinhoodChain, readState, listHeld, listAllowed, listRecord, toRefused, Refused, vaubanVaultAbi, NATIVE } from "./index.ts";

declare global {
  interface Window { ethereum?: EIP1193Provider }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// ?rpc= override is honoured only on localhost, for testing against anvil.
const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const rpcOverride = local ? new URLSearchParams(location.search).get("rpc") : null;
const pub = createPublicClient({
  chain: robinhoodChain,
  transport: http(rpcOverride && /^http:\/\/127\.0\.0\.1:\d+$/.test(rpcOverride) ? rpcOverride : undefined),
});
let vault: Address | null = null;
let me: Address | null = null;
let seq = 0;

function setText(id: string, v: string) { $(id).textContent = v; }

function status(msg: string, kind: "ok" | "err" | "" = "") {
  const el = $("tStatus");
  el.textContent = msg;
  el.dataset.kind = kind;
}

function short(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }

async function load() {
  if (!vault) return;
  const mine = ++seq;
  status("Reading vault…");
  try {
    const code = await pub.getCode({ address: vault });
    if (!code || code === "0x") throw new Error("No contract at this address on Robinhood Chain.");
    const [s, eth, sp, held, allow, rec] = await Promise.all([
      readState(pub, vault),
      pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "limits", args: [NATIVE] }),
      pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "spent", args: [NATIVE] }),
      fetchHeld(),
      listAllowed(pub, vault),
      listRecord(pub, vault, { times: true }),
    ]);
    // a newer load started while we were reading; let it render
    if (mine !== seq) return;

    setText("sOwner", s.owner);
    setText("sAgent", s.agent);
    setText("sBal", formatEther(s.balance) + " ETH");
    setText("sRev", "rev " + s.revision);
    setText("sDelay", Number(s.gateDelay) / 3600 + " h");
    setText("sKeep", s.frozen ? "SEALED" : "OPEN");
    $("sKeep").dataset.kind = s.frozen ? "err" : "ok";
    setText("sCaps", eth[0]
      ? `${formatEther(eth[1])} / tx · ${formatEther(eth[2])} / h · ${formatEther(eth[3])} / day`
      : "not set — ETH cannot move");
    const today = BigInt(Math.floor(Date.now() / 86_400_000));
    const daySpent = BigInt(sp[1]) === today ? sp[3] : 0n;
    setText("sSpent", eth[0] ? `${formatEther(daySpent)} of ${formatEther(eth[3])} ETH today` : "—");
    $<HTMLElement>("capFill").style.width = eth[0] && eth[3] > 0n ? Math.min(100, Number((daySpent * 100n) / eth[3])) + "%" : "0%";
    setText("sHold", eth[0] && eth[4] > 0n ? `hold above ${formatEther(eth[4])} ETH` : "no hold threshold");

    const isOwner = me && getAddress(me) === getAddress(s.owner);
    $("ownerCtl").hidden = !isOwner;
    $<HTMLButtonElement>("bFreeze").hidden = s.frozen;
    $<HTMLButtonElement>("bUnfreeze").hidden = !s.frozen;
    setText("whoami", me ? (isOwner ? `Connected as owner ${short(me)}` : `Connected ${short(me)} — not the owner, read-only`) : "Not connected — read-only");

    renderHeld(held, !!isOwner);
    renderAllowed(allow);
    renderRecord(rec);
    $("tBody").hidden = false;
    status("Up to date · " + new Date().toLocaleTimeString(), "ok");
  } catch (e) {
    if (mine !== seq) return;
    $("tBody").hidden = true;
    status((e as Error).message.split("\n")[0], "err");
  }
}

async function fetchHeld(): Promise<HeldMove[]> {
  const head = await pub.getBlockNumber();
  // public RPCs cap log ranges; recent window is enough for a 6h gate
  const from = head > 200_000n ? head - 200_000n : 0n;
  return listHeld(pub, vault!, from);
}

function renderAllowed(allow: Listing[]) {
  const list = $("cList");
  list.replaceChildren();
  const n = allow.reduce((k, l) => k + l.selectors.length, 0);
  setText("cCount", String(n));
  if (!n) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing listed: the agent can call nothing.";
    list.append(li);
    return;
  }
  for (const l of allow) {
    for (const sel of l.selectors) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "centry";
      b.title = "Rule a call to this entry";
      const t = document.createElement("span");
      t.className = "ct";
      t.textContent = l.target;
      const s = document.createElement("span");
      s.className = "cs";
      s.textContent = sel === "0x00000000" ? "plain ETH send" : sel;
      b.append(t, s);
      b.addEventListener("click", () => {
        $<HTMLInputElement>("rTo").value = l.target;
        $<HTMLInputElement>("rData").value = sel === "0x00000000" ? "" : sel;
        $<HTMLInputElement>("rValue").focus();
      });
      li.append(b);
      list.append(li);
    }
  }
}

const eth = (v: unknown) => formatEther(v as bigint) + " ETH";
const sel = (s: unknown) => (s === "0x00000000" ? "plain ETH send" : String(s));

// [kind, plain-words line] for one event; kind drives the marker colour
function describe(e: RecordEntry): [string, string] {
  const a = e.args;
  switch (e.event) {
    case "Passed": return ["pass", `Agent call passed: ${short(String(a.target))} · ${sel(a.selector)} · ${eth(a.value)}${a.heldId !== "0x" + "0".repeat(64) ? " (released from the gate)" : ""}`];
    case "HeldAtGate": return ["hold", `Held at the gate: ${short(String(a.target))} · ${eth(a.value)} · until ${new Date(Number(a.eta) * 1000).toLocaleString()}`];
    case "Cancelled": return ["owner", `Owner dropped a held move ${short(String(a.id))}`];
    case "Frozen": return [a.frozen ? "refused" : "owner", a.frozen ? "Keep sealed: the agent can do nothing" : "Keep opened again"];
    case "Listed": return ["owner", `${a.ok ? "Allowed" : "Removed"} ${sel(a.selector)} on ${short(String(a.target))}`];
    case "LimitsSet": return ["owner", a.set
      ? `Limits for ${a.asset === NATIVE ? "ETH" : short(String(a.asset))}: ${formatEther(a.perTx as bigint)} / call · ${formatEther(a.perHour as bigint)} / h · ${formatEther(a.perDay as bigint)} / day · hold above ${formatEther(a.holdAbove as bigint)}`
      : `Limits removed for ${a.asset === NATIVE ? "ETH" : short(String(a.asset))}: it cannot move`];
    case "PolicyRevised": return ["rev", `Rules now at revision ${a.revision}`];
    case "AgentSet": return ["owner", `Agent set to ${short(String(a.agent))}`];
    case "OwnershipTransferStarted": return ["owner", `Owner offered the vault to ${short(String(a.to))}`];
    case "OwnershipTransferred": return ["owner", a.from === "0x0000000000000000000000000000000000000000" ? `Vault built, owner ${short(String(a.to))}` : `Owner is now ${short(String(a.to))}`];
    default: return ["rev", e.event];
  }
}

function renderRecord(rec: RecordEntry[]) {
  const list = $("recList");
  list.replaceChildren();
  setText("recCount", String(rec.length));
  for (const e of rec) {
    const [kind, line] = describe(e);
    const li = document.createElement("li");
    li.dataset.kind = kind;
    const t = document.createElement("span");
    t.className = "rt";
    t.textContent = e.time ? e.time.toLocaleString() : "block " + e.block;
    const d = document.createElement("span");
    d.className = "rd";
    d.textContent = line;
    li.append(t, d);
    list.append(li);
  }
}

function renderHeld(held: HeldMove[], isOwner: boolean) {
  const list = $("heldList");
  list.replaceChildren();
  setText("heldCount", String(held.length));
  if (!held.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing waiting at the gate.";
    list.append(li);
    return;
  }
  for (const h of held) {
    const li = document.createElement("li");
    const ready = h.eta.getTime() <= Date.now();
    const cells: [string, string][] = [
      ["id", short(h.id)],
      ["to", short(h.target)],
      ["value", formatEther(h.value) + " ETH"],
      ["eta", ready ? "ready" : h.eta.toLocaleString()],
    ];
    for (const [k, v] of cells) {
      const s = document.createElement("span");
      s.className = k;
      s.textContent = v;
      li.append(s);
    }
    if (isOwner) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-line";
      b.textContent = "Drop gate";
      b.addEventListener("click", () => write("cancel", [h.id]));
      li.append(b);
    }
    list.append(li);
  }
}

async function write(fn: "freeze" | "unfreeze" | "cancel", args: readonly unknown[]) {
  if (!window.ethereum || !me || !vault) return;
  const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum), account: me });
  try {
    const chainId = await wallet.getChainId();
    if (chainId !== robinhoodChain.id) {
      try { await wallet.switchChain({ id: robinhoodChain.id }); }
      catch { await wallet.addChain({ chain: robinhoodChain }); }
    }
    status("Simulating…");
    let request;
    try {
      ({ request } = await pub.simulateContract({
        account: me, address: vault, abi: vaubanVaultAbi,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        functionName: fn, args: args as any,
      }));
    } catch (e) { toRefused(e); }
    status("Confirm in your wallet…");
    const hash: Hex = await wallet.writeContract(request!);
    status("Waiting for block…");
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${fn} reverted on-chain: ${hash}`);
    await load();
  } catch (e) {
    status(e instanceof Refused ? e.message : (e as Error).message.split("\n")[0], "err");
  }
}

async function connect() {
  if (!window.ethereum) { status("No browser wallet found. Reading still works.", "err"); return; }
  const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum) });
  const [a] = await wallet.requestAddresses();
  me = a;
  setText("bConnect", short(a));
  await load();
}

const RULE_KEYS = ["to", "value", "data"] as const;

function open(addr: string, keepRule = false): Promise<void> {
  if (!isAddress(addr)) { status("That is not a valid address.", "err"); return Promise.resolve(); }
  vault = getAddress(addr);
  const qs = new URLSearchParams(location.search);
  qs.set("vault", vault);
  // A ruling in the URL belongs to the vault it was asked of.
  if (!keepRule) RULE_KEYS.forEach((k) => qs.delete(k));
  history.replaceState(null, "", "?" + qs.toString());
  $("rShare").hidden = true;
  return load();
}

$<HTMLFormElement>("vForm").addEventListener("submit", (e) => {
  e.preventDefault();
  open($<HTMLInputElement>("vAddr").value.trim());
});
$("bConnect").addEventListener("click", connect);
$("bFreeze").addEventListener("click", () => write("freeze", []));
$("bUnfreeze").addEventListener("click", () => write("unfreeze", []));
$("bRefresh").addEventListener("click", load);

function verdict(text: string, kind: "pass" | "hold" | "refused" | "err") {
  const el = $("rOut");
  el.textContent = text;
  el.dataset.kind = kind;
}

async function rule() {
  if (!vault) return;
  const to = $<HTMLInputElement>("rTo").value.trim();
  const eth = $<HTMLInputElement>("rValue").value.trim() || "0";
  const data = ($<HTMLInputElement>("rData").value.trim() || "0x") as Hex;
  if (!isAddress(to)) return verdict("Target is not a valid address.", "err");
  if (!isHex(data) || data.length % 2) return verdict("Calldata must be 0x followed by whole bytes.", "err");
  let value: bigint;
  try { value = parseEther(eth); } catch { return verdict("Value must be a number of ETH.", "err"); }
  if (value < 0n) return verdict("Value cannot be negative.", "err");
  verdict("Asking the vault…", "hold");
  const qs = new URLSearchParams(location.search);
  qs.set("to", getAddress(to));
  if (value > 0n) qs.set("value", eth); else qs.delete("value");
  if (data !== "0x") qs.set("data", data); else qs.delete("data");
  history.replaceState(null, "", "?" + qs.toString());
  $("rShare").hidden = false;
  try {
    const r = await pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "rule", args: [getAddress(to), value, data] });
    if (r === 0) verdict("PASS — the vault would let this call land now.", "pass");
    else verdict("HOLD — the vault would queue this at the gate. It lands after the delay, and the owner can cancel it.", "hold");
  } catch (e) {
    try { toRefused(e); } catch (r) {
      if (r instanceof Refused) return verdict(`REFUSED at the ${r.rampart.toUpperCase()} — ${r.reason}.`, "refused");
      return verdict((r as Error).message.split("\n")[0], "err");
    }
  }
}

$<HTMLFormElement>("rForm").addEventListener("submit", (e) => {
  e.preventDefault();
  rule();
});

$("rShare").addEventListener("click", async () => {
  const btn = $("rShare");
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = location.href;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = "Copy link"), 1400);
});

const params = new URLSearchParams(location.search);
const q = params.get("vault");
if (q) {
  $<HTMLInputElement>("vAddr").value = q;
  const to = params.get("to");
  if (to) {
    $<HTMLInputElement>("rTo").value = to;
    $<HTMLInputElement>("rValue").value = params.get("value") ?? "";
    $<HTMLInputElement>("rData").value = params.get("data") ?? "";
  }
  open(q, true).then(() => {
    if (!to || $("tBody").hidden) return;
    if (!isAddress(to)) {
      // Don't leave a link that can never rule sitting in the address bar.
      const qs = new URLSearchParams(location.search);
      RULE_KEYS.forEach((k) => qs.delete(k));
      history.replaceState(null, "", "?" + qs.toString());
    }
    rule();
  });
}
