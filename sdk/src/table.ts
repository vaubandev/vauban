// Owner's table: browser bundle. Reads a vault over RPC; writes only through the user's own injected wallet.
import {
  type Address, type EIP1193Provider, type Hex,
  createPublicClient, createWalletClient, custom, formatEther, getAddress, http, isAddress, isHex, parseEther, parseUnits, toFunctionSelector,
} from "viem";
import {
  type Draft, type Facts, type Finding, type HeldMove, type Listing, type RecordEntry,
  robinhoodChain, readState, readFacts, findings, draftSheet, draftCalls, targetInfo,
  listHeld, listAllowed, listRecord, toRefused, Refused, vaubanVaultAbi, NATIVE,
} from "./index.ts";

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
    const [s, eth, sp, held, allow, rec, fx] = await Promise.all([
      readState(pub, vault),
      pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "limits", args: [NATIVE] }),
      pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "spent", args: [NATIVE] }),
      fetchHeld(),
      listAllowed(pub, vault),
      listRecord(pub, vault, { times: true }),
      readFacts(pub, vault),
    ]);
    const found = findings(fx);
    // decimals for every token the record mentions, so its limits read in the token's units
    const assets = rec.filter((r) => r.event === "LimitsSet" && r.args.asset !== NATIVE).map((r) => String(r.args.asset));
    for (const t of fx.targets) info.set(t.target.toLowerCase(), t);
    await Promise.all([...new Set(assets.map((x) => x.toLowerCase()))].filter((x) => !info.has(x))
      .map(async (x) => info.set(x, await targetInfo(pub, getAddress(x)))));
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
    renderFindings(found);
    facts = fx;
    owner = s.owner;
    renderDraft();
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
    case "LimitsSet": {
      const asset = String(a.asset);
      const i = info.get(asset.toLowerCase());
      // token amounts in the token's own units; without its decimals, show raw units rather than guess 18
      const dec = asset === NATIVE ? 18 : i?.decimals;
      const unit = asset === NATIVE ? "ETH" : i?.symbol ?? short(asset);
      const f = (v: unknown) => (dec === undefined ? `${v} units` : formatUnitsSafe(v as bigint, dec));
      return ["owner", a.set
        ? `Limits for ${unit}: ${f(a.perTx)} / call · ${f(a.perHour)} / h · ${f(a.perDay)} / day · hold above ${f(a.holdAbove)}`
        : `Limits removed for ${unit}: it cannot move`];
    }
    case "PolicyRevised": return ["rev", `Rules now at revision ${a.revision}`];
    case "AgentSet": return ["owner", `Agent set to ${short(String(a.agent))}`];
    case "OwnershipTransferStarted": return ["owner", `Owner offered the vault to ${short(String(a.to))}`];
    case "OwnershipTransferred": return ["owner", a.from === "0x0000000000000000000000000000000000000000" ? `Vault built, owner ${short(String(a.to))}` : `Owner is now ${short(String(a.to))}`];
    default: return ["rev", e.event];
  }
}

const LEVEL = { risk: "Risk", warn: "Check", info: "Note" } as const;

function renderFindings(found: Finding[], listId = "iList", countId: string | null = "iCount") {
  const list = $(listId);
  list.replaceChildren();
  const serious = found.filter((x) => x.level !== "info").length;
  if (countId) {
    setText(countId, String(serious));
    $(countId).dataset.kind = serious ? "warn" : "ok";
  }
  const rows = serious ? found : [{ level: "ok", text: "Nothing to warn about: every setting does what it looks like." }, ...found];
  for (const x of rows) {
    const li = document.createElement("li");
    li.dataset.level = x.level;
    const l = document.createElement("span");
    l.className = "il";
    l.textContent = x.level === "ok" ? "Clear" : LEVEL[x.level as Finding["level"]];
    const t = document.createElement("span");
    t.className = "it";
    t.textContent = x.text;
    li.append(l, t);
    list.append(li);
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
  draft = {};
  dSay("");
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

// ---- Draw the sheet: a local draft, checked with the same findings() before anything is signed

let facts: Facts | null = null;
let owner: Address | null = null;
let draft: Draft = {};
const info = new Map<string, Awaited<ReturnType<typeof targetInfo>>>();

function dSay(text: string, kind: "pass" | "hold" | "refused" | "err" | "" = "") {
  const el = $("dOut");
  el.textContent = text;
  el.dataset.kind = kind;
}

function showFields() {
  const kind = $<HTMLSelectElement>("dKind").value;
  document.querySelectorAll<HTMLElement>("#dForm [data-for]").forEach((el) => {
    el.hidden = !el.dataset.for!.split(" ").includes(kind);
  });
}

function parseSelector(raw: string): Hex {
  const s = raw.trim();
  if (!s) return "0x00000000";
  if (/^0x[0-9a-fA-F]{8}$/.test(s)) return s.toLowerCase() as Hex;
  // a signature such as buy() or transfer(address,uint256): no spaces, one pair of brackets
  if (/^[A-Za-z_][A-Za-z0-9_]*\([A-Za-z0-9_,[\]]*\)$/.test(s)) return toFunctionSelector(s);
  throw new Error("Function must be a signature like buy() or a 4-byte selector like 0xa6f2ae3a.");
}

function amountIn(raw: string, decimals: number, what: string): bigint {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${what} must be a plain number.`);
  return parseUnits(s, decimals);
}

async function addToDraft() {
  if (!facts || !vault) return;
  const kind = $<HTMLSelectElement>("dKind").value;
  try {
    if (kind === "allow" || kind === "remove") {
      const t = $<HTMLInputElement>("dTarget").value.trim();
      if (!isAddress(t)) throw new Error("Target is not a valid address.");
      if (getAddress(t) === vault) throw new Error("The vault refuses calls to itself; that target can never be allowed.");
      const sel = parseSelector($<HTMLInputElement>("dSel").value);
      if (!info.has(t.toLowerCase())) info.set(t.toLowerCase(), await targetInfo(pub, getAddress(t)));
      (draft.allow ??= []).push({ target: getAddress(t), selectors: [sel], on: kind === "allow" });
    } else if (kind === "limits") {
      const raw = $<HTMLInputElement>("dAsset").value.trim();
      const asset = !raw || raw.toUpperCase() === "ETH" ? NATIVE : raw;
      if (!isAddress(asset)) throw new Error("Asset must be ETH or a token address.");
      let dec = 18;
      if (asset !== NATIVE) {
        const i = await targetInfo(pub, getAddress(asset));
        if (!i.hasCode) throw new Error("That asset address has no contract code; it is not a token.");
        info.set(asset.toLowerCase(), i);
        dec = i.decimals;
      }
      const caps = {
        set: true,
        perTx: amountIn($<HTMLInputElement>("dTx").value, dec, "Per call"),
        perHour: amountIn($<HTMLInputElement>("dHour").value, dec, "Per hour"),
        perDay: amountIn($<HTMLInputElement>("dDay").value, dec, "Per day"),
        holdAbove: amountIn($<HTMLInputElement>("dHold").value || "0", dec, "Hold above"),
      };
      const a = asset === NATIVE ? NATIVE : getAddress(asset);
      draft.limits = [...(draft.limits ?? []).filter((l) => l.asset !== a), { asset: a, caps }];
    } else {
      const h = $<HTMLInputElement>("dDelay").value.trim();
      if (!/^\d+(\.\d+)?$/.test(h) || Number(h) > 168) throw new Error("Delay must be a number of hours, at most 168 (7 days).");
      draft.gateDelay = BigInt(Math.round(Number(h) * 3600));
    }
    dSay("");
    renderDraft();
  } catch (e) {
    dSay((e as Error).message.split("\n")[0], "err");
  }
}

function describeStep(c: ReturnType<typeof draftCalls>[number]): string {
  const [a, b, on] = c.args as [string, unknown, unknown];
  if (c.functionName === "setGateDelay") return `Gate delay: ${Number(a) / 3600} h`;
  if (c.functionName === "setAllowed") {
    const sels = (b as Hex[]).map((x) => (x === "0x00000000" ? "plain ETH send" : x)).join(", ");
    return `${on ? "Allow" : "Remove"} ${sels} on ${short(a)}`;
  }
  const k = b as { perTx: bigint; perHour: bigint; perDay: bigint; holdAbove: bigint };
  const i = info.get(a.toLowerCase());
  const dec = a === NATIVE ? 18 : i?.decimals ?? 18;
  const unit = a === NATIVE ? "ETH" : i?.symbol ?? short(a);
  const f = (v: bigint) => formatUnitsSafe(v, dec);
  return `Limits for ${unit}: ${f(k.perTx)} / call · ${f(k.perHour)} / h · ${f(k.perDay)} / day · hold above ${f(k.holdAbove)}`;
}

function formatUnitsSafe(v: bigint, dec: number) {
  const base = 10n ** BigInt(dec);
  const frac = (v % base).toString().padStart(dec, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

function renderDraft() {
  const calls = draftCalls(draft);
  const list = $("dList");
  list.replaceChildren();
  for (const c of calls) {
    const li = document.createElement("li");
    li.textContent = describeStep(c);
    list.append(li);
  }
  const empty = !calls.length;
  $("dClear").hidden = empty;
  $("dFind").hidden = empty;
  const isOwner = !!me && !!owner && getAddress(me) === getAddress(owner);
  $("dSignRow").hidden = empty || !isOwner;
  if (empty || !facts) return;
  const after = findings(draftSheet(facts, draft, info));
  renderFindings(after, "dFind", null);
  if (!isOwner) dSay(me ? "Checked. Only the owner can sign this draft; your wallet is not the owner." : "Checked. Connect the owner's wallet to sign it.", "hold");
  else if (after.some((x) => x.level !== "info")) dSay("Checked: this draft leaves something to fix. You can still sign it, step by step.", "refused");
  else dSay(`Checked: nothing to warn about. ${calls.length} step${calls.length > 1 ? "s" : ""} to sign.`, "pass");
}

async function signDraft() {
  if (!window.ethereum || !me || !vault) return;
  const calls = draftCalls(draft);
  const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum), account: me });
  let landed = 0;
  try {
    if ((await wallet.getChainId()) !== robinhoodChain.id) {
      try { await wallet.switchChain({ id: robinhoodChain.id }); }
      catch { await wallet.addChain({ chain: robinhoodChain }); }
    }
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      dSay(`Step ${i + 1} of ${calls.length}: simulating…`, "hold");
      let request;
      try {
        ({ request } = await pub.simulateContract({
          account: me, address: vault, abi: vaubanVaultAbi,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          functionName: c.functionName, args: c.args as any,
        }));
      } catch (e) { toRefused(e); }
      dSay(`Step ${i + 1} of ${calls.length}: confirm in your wallet…`, "hold");
      const hash: Hex = await wallet.writeContract(request!);
      dSay(`Step ${i + 1} of ${calls.length}: waiting for block…`, "hold");
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`Step ${i + 1} reverted on-chain: ${hash}`);
      landed++;
    }
    draft = {};
    dSay(`Signed: ${calls.length} step${calls.length > 1 ? "s" : ""} landed.`, "pass");
    await load();
  } catch (e) {
    const why = e instanceof Refused ? e.message : (e as Error).message.split("\n")[0];
    // landed steps stay landed; drop the draft so nothing is signed twice, and read the new sheet
    if (landed) draft = {};
    await load();
    dSay(landed ? `${landed} of ${calls.length} steps landed, then: ${why} The draft was cleared; the sheet above is what stands now.` : why, "err");
  }
}

$("dKind").addEventListener("change", showFields);
$<HTMLFormElement>("dForm").addEventListener("submit", (e) => {
  e.preventDefault();
  addToDraft();
});
$("dClear").addEventListener("click", () => { draft = {}; dSay(""); renderDraft(); });
$("dSign").addEventListener("click", signDraft);
showFields();

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
