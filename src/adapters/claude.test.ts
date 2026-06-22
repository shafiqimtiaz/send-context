import { test } from "node:test";
import assert from "node:assert/strict";
import { renderContent, type ClaudePart } from "./claude.js";

test("renderContent: passes through plain string content", () => {
  assert.equal(renderContent("hello world"), "hello world");
});

test("renderContent: trims whitespace from string content", () => {
  assert.equal(renderContent("  hello  \n  "), "hello");
});

test("renderContent: joins multiple text parts with newlines", () => {
  const parts: ClaudePart[] = [
    { type: "text", text: "Hello" },
    { type: "text", text: "World" },
  ];
  assert.equal(renderContent(parts), "Hello\nWorld");
});

test("renderContent: drops tool_use parts entirely", () => {
  const parts: ClaudePart[] = [
    { type: "text", text: "before" },
    { type: "tool_use", name: "Bash", input: { cmd: "ls" } },
    { type: "text", text: "after" },
  ];
  assert.equal(renderContent(parts), "before\nafter");
});

test("renderContent: drops tool_result parts entirely", () => {
  const parts: ClaudePart[] = [
    { type: "tool_result", content: "ENOENT: no such file" },
    { type: "text", text: "after failure" },
  ];
  assert.equal(renderContent(parts), "after failure");
});

test("renderContent: returns empty string for empty array", () => {
  assert.equal(renderContent([]), "");
});

test("renderContent: returns empty string for non-string non-array input", () => {
  // Defensive: the parse function should never produce this, but renderContent
  // is the public contract, so it should degrade gracefully.
  assert.equal(renderContent(42 as never), "");
});

test("renderContent: returns empty string when only tool_use and tool_result parts", () => {
  const parts: ClaudePart[] = [
    { type: "tool_use", name: "Read", input: { path: "/foo" } },
    { type: "tool_result", content: "file contents" },
  ];
  assert.equal(renderContent(parts), "");
});
