import { test } from "node:test";
import assert from "node:assert/strict";
import { renderParts, type PiPart } from "./pi.js";

test("renderParts: joins multiple text parts with newlines", () => {
  const parts: PiPart[] = [
    { type: "text", text: "Hello" },
    { type: "text", text: "World" },
  ];
  assert.equal(renderParts(parts), "Hello\nWorld");
});

test("renderParts: drops toolCall parts entirely", () => {
  const parts: PiPart[] = [
    { type: "text", text: "before" },
    { type: "toolCall", name: "Bash", input: { cmd: "ls" } },
    { type: "text", text: "after" },
  ];
  assert.equal(renderParts(parts), "before\nafter");
});

test("renderParts: drops toolCall parts even when the only content", () => {
  const parts: PiPart[] = [
    { type: "toolCall", name: "Read", input: { path: "/foo" } },
  ];
  assert.equal(renderParts(parts), "");
});

test("renderParts: drops thinking parts", () => {
  const parts: PiPart[] = [
    { type: "text", text: "visible" },
    { type: "thinking", text: "internal musing" },
  ];
  assert.equal(renderParts(parts), "visible");
});

test("renderParts: returns empty string for empty input", () => {
  assert.equal(renderParts([]), "");
});

test("renderParts: returns empty string when all parts are noise", () => {
  const parts: PiPart[] = [
    { type: "toolCall", name: "Bash", input: { cmd: "ls" } },
    { type: "thinking", text: "..." },
  ];
  assert.equal(renderParts(parts), "");
});

test("renderParts: trims leading and trailing whitespace of the final output, preserves internal whitespace", () => {
  const parts: PiPart[] = [
    { type: "text", text: "  spaced  " },
    { type: "text", text: "more" },
  ];
  assert.equal(renderParts(parts), "spaced  \nmore");
});

test("renderParts: skips text parts with empty text", () => {
  const parts: PiPart[] = [
    { type: "text", text: "" },
    { type: "text", text: "real content" },
  ];
  assert.equal(renderParts(parts), "real content");
});
