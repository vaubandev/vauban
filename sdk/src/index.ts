import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatUnits,
  parseAbi,
  zeroAddress,
  zeroHash,
} from "viem";
import { vaubanVaultAbi } from "./abi.ts";

export { vaubanVaultAbi };

export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

export type Rampart = "keep" | "curtain" | "ditch" | "gate" | "access" | "call";

/** A refusal from one of the ramparts, decoded from the vault's custom error. */
export class Refused extends Error {
  readonly rampart: Rampart;
  readonly code: string;
  readonly args: readonly unknown[];
  readonly reason: string;
  constructor(rampart: Rampart, code: string, args: readonly unknown[], reason: string) {
    super(`${rampart.toUpperCase()} refused: ${reason}`);
    this.name = "Refused";
    this.rampart = rampart;
    this.code = code;
    this.args = args;
    this.reason = reason;
  }
}

const RAMPART: Record<string, Rampart> = {
  KeepSealed: "keep",
  CurtainNotListed: "curtain",
  CurtainSelfCall: "curtain",
  CurtainUnlimitedApproval: "curtain",
  CurtainUnknownSpender: "curtain",
  DitchUncapped: "ditch",
  DitchPerTx: "ditch",
  DitchPerHour: "ditch",
  DitchPerDay: "ditch",
  GateUnknown: "gate",
  GateNotYet: "gate",
  GateMismatch: "gate",
  NotAgent: "access",
  NotOwner: "access",
  Reentrant: "access",
  ZeroAddress: "access",
  CallFailed: "call",
};

function explain(code: string, a: readonly unknown[]): string {
  const eth = a[0] === "0x0000000000000000000000000000000000000000";
  const asset = (x: unknown) => (x === "0x0000000000000000000000000000000000000000" ? "ETH" : String(x));
  // Token decimals are not known here, so only ETH amounts are scaled.
  const amt = (x: unknown) => (eth && typeof x === "bigint" ? formatEther(x) : String(x));
  switch (code) {
    case "KeepSealed": return "the fort is frozen by the owner";
    case "CurtainNotListed": return `${a[0]} selector ${a[1]} is not on the allowlist`;
    case "CurtainSelfCall": return "the agent may not call the vault itself";
    case "CurtainUnlimitedApproval": return "unlimited approvals are never allowed";
    case "CurtainUnknownSpender": return `spender ${a[0]} is not a listed contract`;
    case "DitchUncapped": return `no limits set for ${asset(a[0])}, so it cannot move`;
    case "DitchPerTx": return `${amt(a[1])} over per-tx cap ${amt(a[2])} for ${asset(a[0])}`;
    case "DitchPerHour": return `would reach ${amt(a[1])}, over hourly cap ${amt(a[2])} for ${asset(a[0])}`;
    case "DitchPerDay": return `would reach ${amt(a[1])}, over daily cap ${amt(a[2])} for ${asset(a[0])}`;
    case "GateUnknown": return `nothing held under ${a[0]}`;
    case "GateNotYet": return `held until ${new Date(Number(a[1]) * 1000).toISOString()}`;
    case "GateMismatch": return "release payload differs from what was held";
    case "NotAgent": return "caller is not the vault's agent";
    case "NotOwner": return "caller is not the owner";
    case "CallFailed": return `target call reverted (${a[0]})`;
    default: return code;
  }
}

/** Turn any viem error from a vault call into a `Refused`, or rethrow. */
export function toRefused(err: unknown): never {
  if (err instanceof BaseError) {
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) {
      const code = rev.data.errorName;
      const args = rev.data.args ?? [];
      throw new Refused(RAMPART[code] ?? "call", code, args, explain(code, args));
    }
    // a raw eth_call (no ABI attached) carries the revert bytes instead of a decoded error
    const raw = err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
    if (raw?.data && /^0x[0-9a-fA-F]{8}/.test(raw.data)) {
      let d;
      try { d = decodeErrorResult({ abi: vaubanVaultAbi, data: raw.data }); } catch { d = null; }
      if (d) {
        const args = d.args ?? [];
        throw new Refused(RAMPART[d.errorName] ?? "call", d.errorName, args, explain(d.errorName, args));
      }
    }
  }
  throw err;
}

export type Ruling =
  | { kind: "passed"; hash: Hex }
  | { kind: "held"; hash: Hex; id: Hex; eta: Date };

export type Call = { target: Address; value?: bigint; data?: Hex };

export type Limits = { perTx: bigint; perHour: bigint; perDay: bigint; holdAbove?: bigint };

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

type Clients = {
  vault: Address;
  public: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
};

/**
 * The agent's side. Every move goes through the vault; refusals come back as `Refused`
 * with the rampart that stopped it, before any gas is spent (simulated first).
 */
export class VaubanAgent {
  readonly c: Clients;
  constructor(c: Clients) {
    this.c = c;
  }

  /** Dry run: "pass" | "hold", or throws `Refused`. No transaction. */
  async rule({ target, value = 0n, data = "0x" }: Call): Promise<"pass" | "hold"> {
    try {
      const r = await this.c.public.readContract({
        address: this.c.vault, abi: vaubanVaultAbi, functionName: "rule", args: [target, value, data],
      });
      return r === 0 ? "pass" : "hold";
    } catch (e) {
      return toRefused(e);
    }
  }

  async execute({ target, value = 0n, data = "0x" }: Call): Promise<Ruling> {
    let request;
    try {
      ({ request } = await this.c.public.simulateContract({
        account: this.c.wallet.account, address: this.c.vault, abi: vaubanVaultAbi,
        functionName: "execute", args: [target, value, data],
      }));
    } catch (e) {
      return toRefused(e);
    }
    const hash = await this.c.wallet.writeContract(request);
    const rcpt = await this.c.public.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`execute reverted on-chain: ${hash}`);

    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== this.c.vault.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: vaubanVaultAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "HeldAtGate") {
          return { kind: "held", hash, id: ev.args.id, eta: new Date(Number(ev.args.eta) * 1000) };
        }
      } catch {
        /* not ours */
      }
    }
    return { kind: "passed", hash };
  }

  async release(id: Hex, { target, value = 0n, data = "0x" }: Call): Promise<Hex> {
    let request;
    try {
      ({ request } = await this.c.public.simulateContract({
        account: this.c.wallet.account, address: this.c.vault, abi: vaubanVaultAbi,
        functionName: "release", args: [id, target, value, data],
      }));
    } catch (e) {
      return toRefused(e);
    }
    const hash = await this.c.wallet.writeContract(request);
    const rcpt = await this.c.public.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`release reverted on-chain: ${hash}`);
    return hash;
  }

  /** ERC-20 transfer through the vault. */
  transferToken(token: Address, to: Address, amount: bigint) {
    return this.execute({ target: token, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] }) });
  }

  /** Bounded ERC-20 approve through the vault (unlimited is always refused). */
  approveToken(token: Address, spender: Address, amount: bigint) {
    return this.execute({ target: token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender, amount] }) });
  }
}

const erc20 = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);

/** The owner's side: draw the sheet, freeze, cancel. */
export class VaubanOwner {
  readonly c: Clients;
  constructor(c: Clients) {
    this.c = c;
  }

  private async send(functionName: string, args: readonly unknown[]): Promise<Hex> {
    let request;
    try {
      ({ request } = await this.c.public.simulateContract({
        account: this.c.wallet.account, address: this.c.vault, abi: vaubanVaultAbi,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        functionName: functionName as any, args: args as any,
      }));
    } catch (e) {
      return toRefused(e);
    }
    const hash = await this.c.wallet.writeContract(request);
    const rcpt = await this.c.public.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${functionName} reverted on-chain: ${hash}`);
    return hash;
  }

  allow(target: Address, selectors: Hex[]) { return this.send("setAllowed", [target, selectors, true]); }
  disallow(target: Address, selectors: Hex[]) { return this.send("setAllowed", [target, selectors, false]); }
  setLimits(asset: Address, l: Limits) {
    return this.send("setLimits", [asset, { set: true, perTx: l.perTx, perHour: l.perHour, perDay: l.perDay, holdAbove: l.holdAbove ?? 0n }]);
  }
  setGateDelay(seconds: bigint) { return this.send("setGateDelay", [seconds]); }
  freeze() { return this.send("freeze", []); }
  unfreeze() { return this.send("unfreeze", []); }
  cancel(id: Hex) { return this.send("cancel", [id]); }
  withdraw(to: Address, value: bigint) { return this.send("ownerExecute", [to, value, "0x"]); }
}

export type HeldMove = { id: Hex; target: Address; value: bigint; data: Hex; eta: Date; block: bigint };

export type VaultState = {
  owner: Address;
  agent: Address;
  frozen: boolean;
  gateDelay: bigint;
  revision: bigint;
  balance: bigint;
};

export async function readState(pub: PublicClient, vault: Address): Promise<VaultState> {
  const base = { address: vault, abi: vaubanVaultAbi } as const;
  const [owner, agent, frozen, gateDelay, revision, balance] = await Promise.all([
    pub.readContract({ ...base, functionName: "owner" }),
    pub.readContract({ ...base, functionName: "agent" }),
    pub.readContract({ ...base, functionName: "frozen" }),
    pub.readContract({ ...base, functionName: "gateDelay" }),
    pub.readContract({ ...base, functionName: "revision" }),
    pub.getBalance({ address: vault }),
  ]);
  return { owner, agent, frozen, gateDelay: BigInt(gateDelay), revision: BigInt(revision), balance };
}

export type Listing = { target: Address; selectors: Hex[] };

/**
 * The curtain as it stands: every (target, selector) pair currently on the allowlist,
 * rebuilt from `Listed` events and confirmed against `allowed()` so a pruned log range
 * can never show a stale entry.
 */
export async function listAllowed(pub: PublicClient, vault: Address, step: bigint = 10_000_000n): Promise<Listing[]> {
  // Walk back from head and stop at the constructor's OwnershipTransferred(0x0, owner).
  // The public Robinhood RPC caps one log query at 10M blocks.
  // One event per query: the public RPC allows 10M blocks for a single topic, only 100k for several.
  // cacheTime 0: viem otherwise reuses a head up to pollingInterval old and misses a just-mined Listed
  const head = await pub.getBlockNumber({ cacheTime: 0 });
  const logs = [];
  for (let to = head; to >= 0n;) {
    const from = to >= step ? to - step + 1n : 0n;
    logs.push(...(await pub.getContractEvents({ address: vault, abi: vaubanVaultAbi, eventName: "Listed", fromBlock: from, toBlock: to })));
    const born = await pub.getContractEvents({ address: vault, abi: vaubanVaultAbi, eventName: "OwnershipTransferred", args: { from: zeroAddress }, fromBlock: from, toBlock: to });
    if (born.length || from === 0n) break;
    to = from - 1n;
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const seen = new Map<string, { target: Address; selector: Hex }>();
  for (const l of logs) seen.set(`${l.args.target}:${l.args.selector}`, { target: l.args.target!, selector: l.args.selector! });
  const pairs = [...seen.values()];
  const live = await Promise.all(pairs.map((p) =>
    pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "allowed", args: [p.target, p.selector] })));
  const byTarget = new Map<Address, Hex[]>();
  pairs.forEach((p, i) => {
    if (!live[i]) return;
    byTarget.set(p.target, [...(byTarget.get(p.target) ?? []), p.selector].sort());
  });
  return [...byTarget].map(([target, selectors]) => ({ target, selectors }));
}

export type Finding = { level: "risk" | "warn" | "info"; code: string; text: string };

const TOKEN_MOVES = new Set(["0xa9059cbb", "0x23b872dd", "0x095ea7b3", "0x39509351"]);
const PLAIN_SEL = "0x00000000";

export type CapSheet = { perTx: bigint; perHour: bigint; perDay: bigint; holdAbove: bigint };
export type Caps = CapSheet & { set: boolean };
export type TargetFacts = { target: Address; selectors: Hex[]; hasCode: boolean; caps: Caps; symbol: string | null; decimals: number };
/** Everything inspection looks at. Read from the chain by readFacts(), or built from a draft by draftSheet(). */
export type Facts = {
  owner: Address; agent: Address; pendingOwner: Address; frozen: boolean; gateDelay: bigint;
  eth: Caps; targets: TargetFacts[];
};

/** Limit findings for one asset. ETH keeps its original codes; tokens get the same checks prefixed "token-". */
function capFindings(c: CapSheet, label: string, fmt: (v: bigint) => string, token: boolean): Finding[] {
  const f: Finding[] = [];
  const code = (k: string) => (token ? "token-" + k : k);
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
const gateCanHold = (c: CapSheet) => c.holdAbove !== 0n && c.holdAbove < c.perTx;

/**
 * Reads a vault's own settings and reports the ones that do not do what an owner would expect.
 * Every rule mirrors the contract's ruling order: keep, curtain, ditch, gate.
 */
export async function inspect(pub: PublicClient, vault: Address): Promise<Finding[]> {
  return findings(await readFacts(pub, vault));
}

/** Pure: the same rules for a live vault or a draft that has not been signed yet. */
export function findings(v: Facts): Finding[] {
  const f: Finding[] = [];
  if (v.owner.toLowerCase() === v.agent.toLowerCase())
    f.push({ level: "risk", code: "owner-is-agent", text: "The agent is also the owner, so it can rewrite its own rules. Give the agent its own key." });
  if (v.pendingOwner !== zeroAddress)
    f.push({ level: "warn", code: "pending-owner", text: `Ownership is offered to ${v.pendingOwner} and not yet accepted. Until it is, the current owner still holds the vault.` });
  if (v.frozen)
    f.push({ level: "info", code: "sealed", text: "The keep is sealed: the agent can do nothing until the owner opens it." });

  if (!v.eth.set) f.push({ level: "info", code: "eth-unset", text: "No ETH limits: any call that sends ETH is refused." });
  else f.push(...capFindings(v.eth, "ETH", (x) => formatEther(x) + " ETH", false));

  const later: Finding[] = [];
  let anyGate = v.eth.set && gateCanHold(v.eth);
  for (const t of v.targets) {
    const calls = t.selectors.filter((x) => x !== PLAIN_SEL);
    if (!t.hasCode && calls.length)
      later.push({ level: "warn", code: "eoa-target", text: `${t.target} has no contract code, yet ${calls.join(", ")} is allowed on it. A call there only sends ETH.` });
    const moves = t.selectors.filter((x) => TOKEN_MOVES.has(x));
    if (!moves.length) continue;
    if (!t.caps.set) {
      later.push({ level: "warn", code: "token-unset", text: `Token moves (${moves.join(", ")}) are allowed on ${t.target}, but it has no limits, so any amount above 0 is refused.` });
      continue;
    }
    const label = t.symbol ?? t.target;
    later.push(...capFindings(t.caps, label, (x) => `${formatUnits(x, t.decimals)} ${label}`, true));
    anyGate ||= gateCanHold(t.caps);
  }
  if (anyGate && v.gateDelay === 0n)
    f.push({ level: "warn", code: "gate-instant", text: "Gate delay is 0: held moves can be released at once, the owner has no time to cancel." });
  f.push(...later);
  if (!v.targets.length)
    f.push({ level: "info", code: "curtain-empty", text: "Nothing is allowed yet: the agent can call nothing." });
  return f;
}

const erc20Meta = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const capsOf = (l: readonly [boolean, bigint, bigint, bigint, bigint]): Caps =>
  ({ set: l[0], perTx: l[1], perHour: l[2], perDay: l[3], holdAbove: l[4] });

/** What a target is on chain: code, symbol, decimals. Read once per address. */
export async function targetInfo(pub: PublicClient, target: Address) {
  const [code, symbol, decimals] = await Promise.all([
    pub.getCode({ address: target }),
    pub.readContract({ address: target, abi: erc20Meta, functionName: "symbol" }).catch(() => null),
    pub.readContract({ address: target, abi: erc20Meta, functionName: "decimals" }).then(Number).catch(() => 18),
  ]);
  return { hasCode: !!code && code !== "0x", symbol, decimals };
}

export async function readFacts(pub: PublicClient, vault: Address): Promise<Facts> {
  const base = { address: vault, abi: vaubanVaultAbi } as const;
  const [s, pendingOwner, eth, allow] = await Promise.all([
    readState(pub, vault),
    pub.readContract({ ...base, functionName: "pendingOwner" }),
    pub.readContract({ ...base, functionName: "limits", args: [NATIVE] }),
    listAllowed(pub, vault),
  ]);
  const targets = await Promise.all(allow.map(async (l) => {
    const [info, lim] = await Promise.all([
      targetInfo(pub, l.target),
      pub.readContract({ ...base, functionName: "limits", args: [l.target] }),
    ]);
    return { target: l.target, selectors: l.selectors, ...info, caps: capsOf(lim) };
  }));
  return { owner: s.owner, agent: s.agent, pendingOwner, frozen: s.frozen, gateDelay: s.gateDelay, eth: capsOf(eth), targets };
}

export type Draft = {
  gateDelay?: bigint;
  allow?: { target: Address; selectors: Hex[]; on: boolean }[];
  limits?: { asset: Address; caps: Caps }[];
};

/** The vault's facts as they would stand after `draft` lands. Same shape inspection reads. */
export function draftSheet(now: Facts, draft: Draft, info: Map<string, { hasCode: boolean; symbol: string | null; decimals: number }>): Facts {
  const k = (a: string) => a.toLowerCase();
  const sel = new Map(now.targets.map((t) => [k(t.target), new Set(t.selectors)]));
  const caps = new Map(now.targets.map((t) => [k(t.target), t.caps]));
  let eth = now.eth;
  for (const a of draft.allow ?? []) {
    const s = sel.get(k(a.target)) ?? new Set<Hex>();
    a.selectors.forEach((x) => (a.on ? s.add(x) : s.delete(x)));
    sel.set(k(a.target), s);
  }
  for (const l of draft.limits ?? []) {
    if (l.asset === NATIVE) eth = l.caps;
    else caps.set(k(l.asset), l.caps);
  }
  const unset: Caps = { set: false, perTx: 0n, perHour: 0n, perDay: 0n, holdAbove: 0n };
  const byAddr = new Map(now.targets.map((t) => [k(t.target), t.target]));
  for (const a of draft.allow ?? []) if (!byAddr.has(k(a.target))) byAddr.set(k(a.target), a.target);
  const targets: TargetFacts[] = [];
  for (const [key, s] of sel) {
    if (!s.size) continue;
    const known = now.targets.find((t) => k(t.target) === key);
    const i = info.get(key) ?? known ?? { hasCode: true, symbol: null, decimals: 18 };
    targets.push({ target: byAddr.get(key)!, selectors: [...s].sort(), hasCode: i.hasCode, symbol: i.symbol, decimals: i.decimals, caps: caps.get(key) ?? unset });
  }
  return { ...now, gateDelay: draft.gateDelay ?? now.gateDelay, eth, targets };
}

export type DraftCall =
  | { functionName: "setLimits"; args: readonly [Address, Caps]; data: Hex }
  | { functionName: "setGateDelay"; args: readonly [bigint]; data: Hex }
  | { functionName: "setAllowed"; args: readonly [Address, readonly Hex[], boolean]; data: Hex };

/** The owner transactions that turn the current sheet into `draft`, in signing order. `data` is the calldata for the vault. */
export function draftCalls(draft: Draft): DraftCall[] {
  const out: DraftCall[] = [];
  for (const l of draft.limits ?? []) {
    const args = [l.asset, l.caps] as const;
    out.push({ functionName: "setLimits", args, data: encodeFunctionData({ abi: vaubanVaultAbi, functionName: "setLimits", args }) });
  }
  if (draft.gateDelay !== undefined) {
    const args = [draft.gateDelay] as const;
    out.push({ functionName: "setGateDelay", args, data: encodeFunctionData({ abi: vaubanVaultAbi, functionName: "setGateDelay", args }) });
  }
  for (const a of draft.allow ?? []) {
    if (!a.selectors.length) continue;
    const args = [a.target, a.selectors, a.on] as const;
    out.push({ functionName: "setAllowed", args, data: encodeFunctionData({ abi: vaubanVaultAbi, functionName: "setAllowed", args }) });
  }
  return out;
}

export type RecordEntry = { event: string; args: Record<string, unknown>; block: bigint; logIndex: number; tx: Hex; time?: Date };

/**
 * Every event the vault has emitted, newest first: rule changes, freezes, passes, holds.
 * One address-only query per window; the public RPC allows 10M blocks for that.
 */
export async function listRecord(pub: PublicClient, vault: Address, opts: { step?: bigint; times?: boolean } = {}): Promise<RecordEntry[]> {
  const step = opts.step ?? 10_000_000n;
  const head = await pub.getBlockNumber({ cacheTime: 0 });
  const out: RecordEntry[] = [];
  let born = false;
  for (let to = head; to >= 0n && !born;) {
    const from = to >= step ? to - step + 1n : 0n;
    for (const l of await pub.getLogs({ address: vault, fromBlock: from, toBlock: to })) {
      let d;
      try { d = decodeEventLog({ abi: vaubanVaultAbi, data: l.data, topics: l.topics }); } catch { continue; }
      const args = (d.args ?? {}) as Record<string, unknown>;
      if (d.eventName === "OwnershipTransferred" && args.from === zeroAddress) born = true;
      out.push({ event: d.eventName, args, block: l.blockNumber!, logIndex: l.logIndex!, tx: l.transactionHash! });
    }
    if (from === 0n) break;
    to = from - 1n;
  }
  out.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
  if (opts.times) {
    const blocks = [...new Set(out.map((e) => e.block))];
    const ts = new Map(await Promise.all(blocks.map(async (n) => [n, (await pub.getBlock({ blockNumber: n })).timestamp] as const)));
    for (const e of out) e.time = new Date(Number(ts.get(e.block)) * 1000);
  }
  return out;
}

/** Moves still waiting at the gate (held, not yet released or cancelled). */
export async function listHeld(pub: PublicClient, vault: Address, fromBlock: bigint = 0n): Promise<HeldMove[]> {
  const logs = await pub.getContractEvents({ address: vault, abi: vaubanVaultAbi, eventName: "HeldAtGate", fromBlock });
  const out: HeldMove[] = [];
  for (const l of logs) {
    const id = l.args.id!;
    const h = await pub.readContract({ address: vault, abi: vaubanVaultAbi, functionName: "held", args: [id] });
    if (h[1] === 0n || h[0] === zeroHash) continue;
    out.push({ id, target: l.args.target!, value: l.args.value!, data: l.args.data!, eta: new Date(Number(l.args.eta!) * 1000), block: l.blockNumber });
  }
  return out;
}
