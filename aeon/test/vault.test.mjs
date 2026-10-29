// Offline tests for the Vauban pack. No network: the logs are hand-built from the
// event signatures, and the RPC is replaced with a fake.
// Run: node --test aeon/test/vault.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, amount, decodeString, isAddress, TOPIC, word } from "../skills/vauban-vault/vault.mjs";
import { render } from "../skills/vauban-vault/status.mjs";
import { classify, render as renderWatch } from "../skills/vauban-vault/watch.mjs";

const VAULT = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const BUY = "0xa9059cbb";
const pad = (n, bytes = 32) => n.toString(16).padStart(bytes * 2, "0");
const topicAddr = (a) => "0x" + pad(BigInt(a));
const topicSel = (sel) => "0x" + sel.slice(2).padEnd(64, "0");
const dataOf = (...words) => "0x" + words.map((w) => pad(BigInt(w))).join("");

function listed(target, selector, ok) {
  return { topics: [TOPIC.listed, topicAddr(target), topicSel(selector)], data: dataOf(ok ? 1 : 0) };
}
function limits(asset, set, perTx, perHour, perDay, hold) {
  return { topics: [TOPIC.limits, topicAddr(asset)], data: dataOf(set ? 1 : 0, perTx, perHour, perDay, hold) };
}

test("rebuilding the sheet is order-independent in its result", () => {
  const logs = [
    listed(ROUTER, BUY, true),
    limits(ROUTER, true, 10n, 20n, 30n, 5n),
    listed(ROUTER, BUY, false),
    limits(ROUTER, false, 0n, 0n, 0n, 0n),
    listed(ROUTER, BUY, true),
  ];
  const sheet = fold(logs);
  assert.deepEqual([...sheet.allow.get(ROUTER)], [BUY]);
  assert.equal(sheet.limits.size, 0);
});

test("a held move leaves the sheet when it is released or cancelled", () => {
  const id = "0x" + "ab".repeat(32);
  const held = {
    topics: [TOPIC.held, id, topicAddr(ROUTER)],
    // data is (value, bytes-offset, eta, bytes length, bytes body)
    data: dataOf(8n, 0xa0n, 1_700_000_000n, 4n, 0n),
  };
  assert.equal(fold([held]).held.size, 1);
  const released = { topics: [TOPIC.passed, topicAddr(ROUTER), topicSel(BUY)], data: dataOf(8n, BigInt(id)) };
  assert.equal(fold([held, released]).held.size, 0);
  const cancelled = { topics: [TOPIC.cancelled, id], data: "0x" };
  assert.equal(fold([held, cancelled]).held.size, 0);
  // A move that landed immediately carries a zero held id and removes nothing.
  const direct = { ...released, data: dataOf(8n, 0n) };
  assert.equal(fold([held, direct]).held.size, 1);
});

test("amounts and strings decode the way the chain encodes them", () => {
  assert.equal(amount(1_500_000_000_000_000_000n, 18), "1.5");
  assert.equal(amount(42n, 18), "0.000000000000000042");
  assert.equal(amount(0n, 6), "0");
  const word0 = "0x" + Buffer.from("USDG").toString("hex").padEnd(64, "0");
  assert.equal(decodeString(word0), "USDG");
  assert.equal(decodeString("0x"), null);
  assert.equal(isAddress("0x" + "a".repeat(40)), true);
  assert.equal(isAddress("0x1234"), false);
});

test("the report names a non-vault and stays quiet", () => {
  const text = render({ vault: VAULT, chainId: 4663, block: "100", isVauban: false });
  assert.match(text, /not a Vauban vault/);
  assert.doesNotMatch(text, /Allowlist/);
});

test("the report shows caps left and a held move", () => {
  const text = render({
    vault: VAULT, chainId: 4663, block: "100", isVauban: true, owner: VAULT, agent: ROUTER,
    frozen: false, revision: "3", gateDelay: "21600", symbols: {},
    allow: [{ target: ROUTER, selectors: [BUY] }],
    caps: [{ asset: "0x" + "0".repeat(40), decimals: 18, perTx: 10n ** 17n, perHour: 3n * 10n ** 17n, perDay: 10n ** 18n, holdAbove: 5n * 10n ** 16n, hourLeft: 2n * 10n ** 17n, dayLeft: 9n * 10n ** 17n }],
    held: [{ id: "0x" + "ab".repeat(32), target: ROUTER, value: "8", eta: "1700000000" }],
  });
  assert.match(text, /per tx 0\.1/);
  assert.match(text, /0\.2 left/);
  assert.match(text, /releasable 2023-11-14/);
  assert.match(text, /not audited/);
});

test("the watch names each rampart event and stays quiet when nothing happened", () => {
  assert.equal(renderWatch([]), "VAUBAN QUIET\n");
  const line = classify({ address: VAULT, topics: [TOPIC.frozen], data: dataOf(1n) });
  assert.match(line, /frozen$/);
  const out = renderWatch([line]);
  assert.match(out, /^VAUBAN CHANGED/);
  assert.equal(classify({ topics: [TOPIC.born], data: "0x" }), null);
});

test("words past the end of the data throw rather than read garbage", () => {
  assert.throws(() => word("0x" + "00".repeat(32), 3));
});
