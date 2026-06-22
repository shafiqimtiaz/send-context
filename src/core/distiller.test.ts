import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript, parseSections } from "./distiller.js";
import type { SessionMessage, SessionRef } from "../adapters/types.js";

test("buildTranscript inserts a single session boundary marker", () => {
  const t = buildTranscript(
    [
      { role: "user", content: "first topic" },
      { role: "assistant", content: "ok 1" },
    ],
    [{ id: "s1", title: "Refactor distiller", mtime: 1, messageCount: 2 }],
  );

  assert.match(t, /### === SESSION 1: Refactor distiller \(2 msgs\) ===/);
  assert.match(t, /### USER\nfirst topic/);
  assert.match(t, /### ASSISTANT\nok 1/);
});

test("buildTranscript marks every session in the merged list", () => {
  const t = buildTranscript(
    [
      { role: "user", content: "alpha" },
      { role: "user", content: "beta" },
    ],
    [
      { id: "s1", title: "Topic A", mtime: 1, messageCount: 1 },
      { id: "s2", title: "Topic B", mtime: 2, messageCount: 1 },
    ],
  );
  assert.match(t, /SESSION 1: Topic A/);
  assert.match(t, /SESSION 2: Topic B/);
  // Sessions are in mtime order — alpha comes before beta.
  const idxA = t.indexOf("SESSION 1: Topic A");
  const idxB = t.indexOf("SESSION 2: Topic B");
  assert.ok(idxA < idxB, "sessions should be ordered by mtime");
});

test("buildTranscript returns empty string for empty input", () => {
  assert.equal(buildTranscript([], []), "");
});

test("parseSections reads topics array when present", () => {
  const sections = parseSections(JSON.stringify({
    topics: ["A", "B"],
    objective: "Two workstreams",
    currentState: "A: x\n\nB: y",
    completedSteps: "### A\n- x\n\n### B\n- y",
    failedApproaches: "None.",
    nextSteps: "### A\n- a\n\n### B\n- b",
  }));
  assert.deepEqual(sections.topics, ["A", "B"]);
  assert.equal(sections.objective, "Two workstreams");
});

test("parseSections treats absent topics as undefined", () => {
  const sections = parseSections(JSON.stringify({
    objective: "Single thread",
    currentState: "",
    completedSteps: "",
    failedApproaches: "None.",
    nextSteps: "",
  }));
  assert.equal(sections.topics, undefined);
});

test("parseSections repairs malformed JSON (trailing comma)", () => {
  const sections = parseSections(
    '{ "topics": ["A"], "objective": "ok", "currentState": "", "completedSteps": "", "failedApproaches": "None.", "nextSteps": "",',
  );
  assert.deepEqual(sections.topics, ["A"]);
  assert.equal(sections.objective, "ok");
});
