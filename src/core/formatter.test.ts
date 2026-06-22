import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToHandoffSkill } from "./formatter.js";
import { SessionMessage } from "../adapters/types.js";

const messages: SessionMessage[] = [
  { role: "user", content: "Refactor the worker into a typed module" },
  { role: "assistant", content: "Plan: split renderParts into a PartRenderer" },
];

test("formatter: renders all six sections with full input", () => {
  const out = formatToHandoffSkill({
    sourceAgent: "Pi",
    timestamp: "2025-01-01T00:00:00.000Z",
    allMessages: messages,
    appendix: messages,
    sections: {
      objective: "Make the worker type-safe",
      currentState: "Drafted",
      completedSteps: "- Skeleton",
      failedApproaches: "- None",
      nextSteps: "- Wire to HandoffBuilder",
    },
  });

  assert.match(out, /^# Context Handoff Document/);
  assert.match(out, /\*\*Source Agent:\*\* Pi/);
  assert.match(out, /\*\*Timestamp:\*\* 2025-01-01T00:00:00\.000Z/);
  assert.match(out, /## 1\. Primary Objective/);
  assert.match(out, /Make the worker type-safe/);
  assert.match(out, /## 2\. Current State & Blockers/);
  assert.match(out, /## 3\. Completed Steps/);
  assert.match(out, /## 4\. Failed Approaches \(Do Not Retry\)/);
  assert.match(out, /## 5\. Next Steps/);
  assert.match(out, /## 6\. Raw Context Appendix/);
});

test("formatter: missing sections fall back to '_Not specified by sender._'", () => {
  const out = formatToHandoffSkill({
    sourceAgent: "Claude Code",
    timestamp: "2025-01-01T00:00:00.000Z",
    allMessages: messages,
    appendix: [],
    sections: {},
  });

  // Objective falls back to first user message (not the not-specified marker).
  assert.match(out, /Refactor the worker into a typed module/);
  // The other four sections default to the not-specified marker.
  const occurrences = out.match(/_Not specified by sender\._/g) ?? [];
  assert.equal(occurrences.length, 4);
});

test("formatter: empty appendix renders the empty-appendix marker", () => {
  const out = formatToHandoffSkill({
    sourceAgent: "Pi",
    timestamp: "2025-01-01T00:00:00.000Z",
    allMessages: messages,
    appendix: [],
    sections: {},
  });
  assert.match(out, /_No raw context included\._/);
});

test("formatter: appendix renders messages as ### ROLE sections", () => {
  const out = formatToHandoffSkill({
    sourceAgent: "Pi",
    timestamp: "2025-01-01T00:00:00.000Z",
    allMessages: messages,
    appendix: messages,
    sections: {},
  });
  assert.match(out, /### USER\n\nRefactor the worker/);
  assert.match(out, /### ASSISTANT\n\nPlan: split renderParts/);
  assert.match(out, /\n---\n/); // separator between messages
});

test("formatter: objective falls back to first user line, trimmed and clipped", () => {
  const longLine = "a".repeat(500);
  const out = formatToHandoffSkill({
    sourceAgent: "Pi",
    timestamp: "t",
    allMessages: [{ role: "user", content: longLine }],
    appendix: [],
    sections: {},
  });
  // The objective is the first line of the first user message, capped at 200 chars.
  const m = out.match(/## 1\. Primary Objective\n([^\n]+)/);
  assert.ok(m);
  assert.ok(m[1].length <= 201); // 200 chars + ellipsis
  assert.ok(m[1].endsWith("…"));
});