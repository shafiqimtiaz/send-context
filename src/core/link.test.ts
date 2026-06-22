import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeLink, decodeLink, workerBaseUrl } from "./link.js";

test("link: roundtrip a minimal link", () => {
  const original = { workerHost: "ctx-handoff.example.deno.net", id: "abc123" };
  const encoded = encodeLink(original);
  assert.equal(encoded, "ctx-handoff://ctx-handoff.example.deno.net/abc123");
  assert.deepEqual(decodeLink(encoded), original);
});

test("link: encode URL-encodes the id", () => {
  const link = encodeLink({ workerHost: "h.deno.net", id: "has/slash and space" });
  // decodeURIComponent should recover it.
  assert.deepEqual(decodeLink(link), { workerHost: "h.deno.net", id: "has/slash and space" });
});

test("link: decode rejects garbage", () => {
  assert.throws(() => decodeLink("garbage"), /Invalid ctx-handoff link/);
  assert.throws(() => decodeLink("https://example.com/abc"), /Invalid ctx-handoff link/);
  assert.throws(() => decodeLink("ctx-handoff://host"), /Invalid ctx-handoff link/);
  assert.throws(() => decodeLink(""), /Invalid ctx-handoff link/);
});

test("link: encode rejects empty fields", () => {
  assert.throws(() => encodeLink({ workerHost: "", id: "x" }), /required/);
  assert.throws(() => encodeLink({ workerHost: "h", id: "" }), /required/);
});

test("link: decode strips surrounding whitespace", () => {
  const decoded = decodeLink("  ctx-handoff://h.deno.net/abc  \n");
  assert.deepEqual(decoded, { workerHost: "h.deno.net", id: "abc" });
});

test("link: workerBaseUrl strips scheme and trailing slash", () => {
  assert.equal(workerBaseUrl("h.deno.net"), "https://h.deno.net");
  assert.equal(workerBaseUrl("https://h.deno.net"), "https://h.deno.net");
  assert.equal(workerBaseUrl("http://h.deno.net/"), "https://h.deno.net");
});