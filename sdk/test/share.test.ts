import { test } from "node:test";
import assert from "node:assert/strict";
import { tweetUrl } from "../src/share.ts";

test("a share link is an X intent with the text and url encoded", () => {
  const u = new URL(tweetUrl("burned 4.51% & <b>held</b> 0\nline two", "https://vauban.works/token/"));
  assert.equal(u.origin + u.pathname, "https://twitter.com/intent/tweet");
  assert.equal(u.searchParams.get("text"), "burned 4.51% & <b>held</b> 0\nline two");
  assert.equal(u.searchParams.get("url"), "https://vauban.works/token/");
  assert.deepEqual([...u.searchParams.keys()], ["text", "url"], "nothing else can ride along");
});

test("long text is trimmed so text plus the link fit in one post", () => {
  const u = new URL(tweetUrl("x".repeat(400), "https://vauban.works/table/?vault=0xf9322f1546de5a121cdc09522e70af79e30e4097&to=0x000000000000000000000000000000000000dEaD&value=1"));
  const text = u.searchParams.get("text")!;
  // X counts any link as 23 characters, plus one space between text and link
  assert.ok(text.length + 1 + 23 <= 280, `${text.length} + link is over 280`);
  assert.ok(text.endsWith("…"));
  assert.equal(new URL(tweetUrl("short", "https://vauban.works/")).searchParams.get("text"), "short");
});
