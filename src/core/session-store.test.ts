import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listJsonl,
  readJsonl,
  sessionTitle,
  summarizeValue,
} from "./session-store.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
}

function touchJsonl(dir: string, name: string, mtimeMs: number, lines: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  // mtime: atime and mtime.
  const atime = new Date(mtimeMs);
  const mtime = new Date(mtimeMs);
  utimesSync(path, atime, mtime);
  return path;
}

test("session-store: listJsonl returns newest-first", () => {
  const dir = freshDir();
  touchJsonl(dir, "old.jsonl", 1_000, [{ type: "message" }]);
  touchJsonl(dir, "newer.jsonl", 5_000, [{ type: "message" }]);
  touchJsonl(dir, "newest.jsonl", 9_000, [{ type: "message" }]);
  touchJsonl(dir, "ignore.txt", 9_500, ["not jsonl"]);

  const files = listJsonl(dir);
  assert.deepEqual(
    files.map((f) => f.id),
    ["newest", "newer", "old"],
  );
  assert.deepEqual(
    files.map((f) => f.mtime),
    [9_000, 5_000, 1_000],
  );
});

test("session-store: listJsonl returns empty for missing directory", () => {
  const dir = join(freshDir(), "does-not-exist");
  assert.deepEqual(listJsonl(dir), []);
});

test("session-store: readJsonl skips blanks and malformed lines", () => {
  const dir = freshDir();
  const path = join(dir, "mixed.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ role: "user", content: "first" }),
      "",
      "   ",
      "{not valid json",
      JSON.stringify({ role: "assistant", content: "second" }),
    ].join("\n"),
  );

  const rows = readJsonl(path) as Array<{ role: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.role), ["user", "assistant"]);
});

test("session-store: sessionTitle uses first user message", () => {
  assert.equal(
    sessionTitle([{ role: "user", content: "Fix the broken pipeline" }]),
    "Fix the broken pipeline",
  );
  assert.equal(sessionTitle([{ role: "assistant", content: "hi" }]), "Untitled session");
  assert.equal(sessionTitle([]), "Untitled session");
});

test("session-store: sessionTitle truncates long first lines", () => {
  const long = "x".repeat(200);
  const title = sessionTitle([{ role: "user", content: long }]);
  assert.ok(title.length <= 61, `title was ${title.length} chars`);
  assert.ok(title.endsWith("…"));
});

test("session-store: summarizeValue handles primitives and truncates", () => {
  assert.equal(summarizeValue("hi"), "hi");
  assert.equal(summarizeValue(undefined), "");
  assert.equal(summarizeValue(null), "");
  const huge = "y".repeat(2_000);
  const out = summarizeValue(huge);
  assert.ok(out.endsWith("[truncated]"));
  assert.ok(out.length < 2_000);
});

test("session-store: summarizeValue stringifies non-strings", () => {
  const out = summarizeValue({ a: 1, b: [2, 3] });
  assert.match(out, /"a":\s*1/);
  assert.match(out, /"b":\s*\[2,3\]/);
});