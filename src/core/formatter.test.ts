import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToHandoffSkill, type HandoffInput } from "./formatter.js";
import type { SessionMessage } from "../adapters/types.js";

const baseInput: HandoffInput = {
  sourceAgent: "Pi",
  timestamp: "2026-06-22T12:00:00.000Z",
  allMessages: [{ role: "user", content: "Refactor the distiller prompts." }],
  appendix: [],
  markdown: "# Brief\n\nOriginal task in user's words.\n",
};

test("formatToHandoffSkill: renders fixed preamble before the markdown body", () => {
  const out = formatToHandoffSkill(baseInput);
  // The preamble lines must appear, in order, before the markdown body.
  const preambleIdx = out.indexOf("# Context Handoff");
  const markdownIdx = out.indexOf("# Brief");
  assert.ok(preambleIdx >= 0, "preamble header present");
  assert.ok(markdownIdx >= 0, "markdown body present");
  assert.ok(preambleIdx < markdownIdx, "preamble precedes markdown");
});

test("formatToHandoffSkill: includes source agent, timestamp, and original task in preamble", () => {
  const out = formatToHandoffSkill(baseInput);
  assert.match(out, /\*\*Source Agent:\*\*\s*Pi/);
  assert.match(out, /\*\*Timestamp:\*\*\s*2026-06-22T12:00:00\.000Z/);
  assert.match(out, /\*\*Original Task:\*\*\s*Refactor the distiller prompts\./);
});

test("formatToHandoffSkill: original task falls back to '_Not specified by sender._' when no user message", () => {
  const out = formatToHandoffSkill({ ...baseInput, allMessages: [] });
  assert.match(out, /\*\*Original Task:\*\*\s*_Not specified by sender\._/);
});

test("formatToHandoffSkill: original task truncates very long first lines", () => {
  const longLine = "x".repeat(500);
  const out = formatToHandoffSkill({
    ...baseInput,
    allMessages: [{ role: "user", content: longLine }],
  });
  // Truncated to 200 chars + ellipsis.
  const match = out.match(/\*\*Original Task:\*\*\s*(.+)/);
  assert.ok(match, "original task line present");
  assert.ok(match[1].length <= 210, "truncated to <=210 chars");
  assert.match(match[1], /…$/);
});

test("formatToHandoffSkill: does NOT inject any fixed numbered section headers (## 1., ## 2., etc.)", () => {
  const out = formatToHandoffSkill(baseInput);
  // The old formatter emitted ## 1. Primary Objective, ## 2. Current State & Blockers, etc.
  // Dynamic markdown is the only source of structure now.
  assert.doesNotMatch(out, /##\s*1\.\s*Primary Objective/i);
  assert.doesNotMatch(out, /##\s*2\.\s*Current State/i);
  assert.doesNotMatch(out, /##\s*3\.\s*Completed Steps/i);
  assert.doesNotMatch(out, /##\s*4\.\s*Failed Approaches/i);
  assert.doesNotMatch(out, /##\s*5\.\s*Next Steps/i);
  assert.doesNotMatch(out, /##\s*6\.\s*Raw Context Appendix/i);
});

test("formatToHandoffSkill: passes the markdown body through verbatim (no transformation)", () => {
  const markdown =
    "# Handoff Brief: foo\n\n## Current State\n\n`src/core/distiller.ts` lines 1-50.\n\n```bash\nnpm run dev -- send\n```\n";
  const out = formatToHandoffSkill({ ...baseInput, markdown });
  // The exact markdown string appears in the output.
  assert.ok(out.includes(markdown), "verbatim markdown body present");
});

test("formatToHandoffSkill: renders the appendix section when messages are provided", () => {
  const appendix: SessionMessage[] = [
    { role: "user", content: "I want to refactor the distiller." },
    { role: "assistant", content: "Sure, let me look at the current prompt." },
  ];
  const out = formatToHandoffSkill({ ...baseInput, appendix });
  assert.match(out, /## Raw Context Appendix/);
  assert.match(out, /### USER\n\nI want to refactor the distiller\./);
  assert.match(out, /### ASSISTANT\n\nSure, let me look at the current prompt\./);
});

test("formatToHandoffSkill: omits the appendix section entirely when appendix is empty", () => {
  const out = formatToHandoffSkill({ ...baseInput, appendix: [] });
  // An empty "Raw Context Appendix (0 messages)" block is dead weight, so the
  // section is not emitted at all when there is no raw context to show.
  assert.doesNotMatch(out, /Raw Context Appendix/);
  assert.doesNotMatch(out, /_No raw context included\._/);
});

test("formatToHandoffSkill: preamble is emitted even when markdown is empty", () => {
  const out = formatToHandoffSkill({
    ...baseInput,
    markdown: "",
    appendix: [{ role: "user", content: "end" }],
  });
  assert.match(out, /# Context Handoff/);
  assert.match(out, /\*\*Source Agent:\*\*\s*Pi/);
  assert.match(out, /## Raw Context Appendix/);
});

test("formatToHandoffSkill: markdown body appears between preamble and appendix", () => {
  const out = formatToHandoffSkill({
    ...baseInput,
    markdown: "## Middle\n\nbody\n",
    appendix: [{ role: "user", content: "end" }],
  });
  const preambleIdx = out.indexOf("# Context Handoff");
  const middleIdx = out.indexOf("## Middle");
  const appendixIdx = out.indexOf("## Raw Context Appendix");
  assert.ok(preambleIdx < middleIdx, "preamble before markdown");
  assert.ok(middleIdx < appendixIdx, "markdown before appendix");
});
