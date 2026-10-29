// Owner's table: browser bundle. Reads a vault over RPC; writes only through the user's own injected wallet.
import {
  type Address, type EIP1193Provider, type Hex,
  createPublicClient, createWalletClient, custom, formatEther, getAddress, http, isAddress,
} from "viem";
import { type HeldMove, robinhoodChain, readState, listHeld, toRefused, Refused, vaubanVaultAbi, NATIVE } from "./index.ts";

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
    const [s, eth, sp, held] = await Promise.all([
      readState(pub, vault),
      pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "limits", args: [NATIVE] }),
      pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "spent", args: [NATIVE] }),
      fetchHeld(),
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

function open(addr: string) {
  if (!isAddress(addr)) { status("That is not a valid address.", "err"); return; }
  vault = getAddress(addr);
  const qs = new URLSearchParams(location.search);
  qs.set("vault", vault);
  history.replaceState(null, "", "?" + qs.toString());
  load();
}

$<HTMLFormElement>("vForm").addEventListener("submit", (e) => {
  e.preventDefault();
  open($<HTMLInputElement>("vAddr").value.trim());
});
$("bConnect").addEventListener("click", connect);
$("bFreeze").addEventListener("click", () => write("freeze", []));
$("bUnfreeze").addEventListener("click", () => write("unfreeze", []));
$("bRefresh").addEventListener("click", load);

const q = new URLSearchParams(location.search).get("vault");
if (q) {
  $<HTMLInputElement>("vAddr").value = q;
  open(q);
}
