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
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  parseAbi,
  zeroHash,
} from "viem";
import { vaubanVaultAbi } from "./abi.ts";

export { vaubanVaultAbi };

export const robinhoodChain = defineChain({
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
