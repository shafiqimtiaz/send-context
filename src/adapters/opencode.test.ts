import { test } from "node:test";
import assert from "node:assert/strict";
import { renderParts, type OpenCodePart } from "./opencode.js";

test("renderParts: joins multiple text parts with newlines", () => {
  const parts: OpenCodePart[] = [
    { type: "text", text: "Hello" },
    { type: "text", text: "World" },
  ];
  assert.equal(renderParts(parts), "Hello\nWorld");
});

test("renderParts: drops tool parts entirely", () => {
  const parts: OpenCodePart[] = [
    { type: "text", text: "before" },
    { type: "tool", tool: "Bash", state: { input: { cmd: "ls" } } },
    { type: "text", text: "after" },
  ];
  assert.equal(renderParts(parts), "before\nafter");
});

test("renderParts: drops reasoning, step-start, and step-finish parts", () => {
  const parts: OpenCodePart[] = [
    { type: "text", text: "visible" },
    { type: "reasoning", text: "internal musing" },
    { type: "step-start" },
    { type: "step-finish" },
  ];
  assert.equal(renderParts(parts), "visible");
});

test("renderParts: returns empty string for empty input", () => {
  assert.equal(renderParts([]), "");
});

test("renderParts: returns empty string when only tool and reasoning parts", () => {
  const parts: OpenCodePart[] = [
    { type: "tool", tool: "Read", state: { input: { path: "/foo" } } },
    { type: "reasoning", text: "..." },
  ];
  assert.equal(renderParts(parts), "");
});

test("renderParts: skips text parts with empty text", () => {
  const parts: OpenCodePart[] = [
    { type: "text", text: "" },
    { type: "text", text: "real content" },
  ];
  assert.equal(renderParts(parts), "real content");
});

test("renderParts: trims leading and trailing whitespace of the final output", () => {
  const parts: OpenCodePart[] = [
    { type: "text", text: "  spaced  " },
    { type: "text", text: "more" },
  ];
  assert.equal(renderParts(parts), "spaced  \nmore");
});
