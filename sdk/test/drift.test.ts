// The vault's shape is copied into the SDK and the Aeon pack. Fail when any copy drifts from the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from "viem";
import { vaubanVaultAbi } from "../src/abi.ts";
import { vaubanVaultBytecode } from "../src/bytecode.ts";

type Pack = { CODEHASH: string; TOPIC: Record<string, string>; SEL: Record<string, string>; REFUSAL: Record<string, string> };
const { CODEHASH, TOPIC, SEL, REFUSAL }: Pack = await import(new URL("../../aeon/skills/vauban-vault/vault.mjs", import.meta.url).href);

const ARTIFACT = new URL("../../contracts/out/VaubanVault.sol/VaubanVault.json", import.meta.url);
const built = existsSync(ARTIFACT) ? JSON.parse(readFileSync(ARTIFACT, "utf8")) : null;
const skip = built ? false : "run `forge build` in contracts/ first";

const abi: Abi = vaubanVaultAbi;
const events = abi.filter((x): x is AbiEvent => x.type === "event");
const fns = abi.filter((x): x is AbiFunction => x.type === "function");
const errors = abi.filter((x) => x.type === "error");
const topicOf = (name: string) => toEventSelector(events.find((e) => e.name === name)!);

test("SDK abi and bytecode match the forge build", { skip }, () => {
  assert.deepEqual(JSON.parse(JSON.stringify(vaubanVaultAbi)), built.abi, "run python3 scripts/abi.py");
  assert.equal(vaubanVaultBytecode, built.bytecode.object, "run python3 scripts/abi.py");
});

test("Aeon CODEHASH is the hash of the built runtime code", { skip }, () => {
  assert.equal(Object.keys(built.deployedBytecode.immutableReferences ?? {}).length, 0, "immutables make on-chain code differ from the artifact");
  const runtime = Buffer.from(built.deployedBytecode.object.slice(2), "hex");
  assert.equal(createHash("sha256").update(runtime).digest("hex"), CODEHASH);
});

test("Aeon event topics match the ABI", () => {
  const want: Record<string, string> = {
    born: "OwnershipTransferred", listed: "Listed", limits: "LimitsSet", held: "HeldAtGate",
    passed: "Passed", cancelled: "Cancelled", frozen: "Frozen", revised: "PolicyRevised",
  };
  for (const [key, name] of Object.entries(want)) assert.equal(TOPIC[key], topicOf(name), key);
});

test("Aeon decodes each watched event from the right place", () => {
  // The pack reads these fields from data; an indexed field there has empty data and throws.
  const fromData: Record<string, string[]> = {
    Listed: ["ok"], LimitsSet: ["set"], HeldAtGate: ["value", "eta"], Passed: ["value", "heldId"], Frozen: ["frozen"],
  };
  for (const [name, fields] of Object.entries(fromData)) {
    const ev = events.find((e) => e.name === name)!;
    for (const f of fields) assert.equal(ev.inputs.find((i) => i.name === f)?.indexed ?? false, false, `${name}.${f} is indexed`);
  }
  assert.equal(events.find((e) => e.name === "PolicyRevised")!.inputs[0].indexed, true, "watch reads revision from topics[1]");
});

test("Aeon function selectors match the ABI", () => {
  const erc20 = { symbol: "function symbol()", decimals: "function decimals()" } as Record<string, string>;
  for (const [name, sel] of Object.entries(SEL)) {
    const sig = erc20[name] ?? fns.find((f) => f.name === name);
    assert.ok(sig, `${name} not in ABI`);
    assert.equal(toFunctionSelector(sig as never).slice(2), sel, name);
  }
});

test("every refusal selector the pack names is a real vault error", () => {
  const known = new Set(errors.map((e) => toFunctionSelector(e as never).slice(2)));
  for (const sel of Object.keys(REFUSAL)) assert.ok(known.has(sel), `0x${sel} is not a VaubanVault error`);
});
