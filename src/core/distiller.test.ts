import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript, distillSession, SYSTEM_PROMPT } from "./distiller.js";
import type { SessionMessage, SessionRef } from "../adapters/types.js";

// ----- buildTranscript (unchanged behavior, regression coverage) ---------

test("buildTranscript: inserts a single session boundary marker", () => {
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

test("buildTranscript: marks every session in the merged list", () => {
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
  const idxA = t.indexOf("SESSION 1: Topic A");
  const idxB = t.indexOf("SESSION 2: Topic B");
  assert.ok(idxA < idxB, "sessions should be ordered by mtime");
});

test("buildTranscript: returns empty string for empty input", () => {
  assert.equal(buildTranscript([], []), "");
});

// ----- SYSTEM_PROMPT contract --------------------------------------------

test("SYSTEM_PROMPT: does not request a JSON response format", () => {
  // Dynamic markdown only — no JSON wrapper, no schema field list.
  // The prompt is allowed to mention the word "json" while forbidding it;
  // these assertions check for the actual JSON-mode markers.
  assert.doesNotMatch(SYSTEM_PROMPT, /response_format/);
  assert.doesNotMatch(SYSTEM_PROMPT, /json_object/);
  assert.doesNotMatch(SYSTEM_PROMPT, /JSON object of this exact shape/);
});

test("SYSTEM_PROMPT: does not mention a fixed schema or field list", () => {
  // No JSON-schema field references. We check for the field name as a JSON
  // key (followed by a colon) so prose like "sub-topics" doesn't false-match.
  assert.doesNotMatch(SYSTEM_PROMPT, /objective\s*:/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /currentState\s*:/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /completedSteps\s*:/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /failedApproaches\s*:/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /nextSteps\s*:/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /topics\s*:/i);
});

test("SYSTEM_PROMPT: instructs verbose output", () => {
  assert.match(SYSTEM_PROMPT, /verbose/i);
});

test("SYSTEM_PROMPT: requires verbatim preservation of paths, commands, errors, identifiers", () => {
  assert.match(SYSTEM_PROMPT, /verbatim/i);
  assert.match(SYSTEM_PROMPT, /paths?/i);
  assert.match(SYSTEM_PROMPT, /commands?/i);
  assert.match(SYSTEM_PROMPT, /errors?/i);
  assert.match(SYSTEM_PROMPT, /identifiers?/i);
});

test("SYSTEM_PROMPT: tells the model to begin directly with the brief (no JSON wrapper)", () => {
  // The model should output ONLY the brief, not wrap it in a JSON object.
  assert.match(SYSTEM_PROMPT, /begin directly|output only|do not wrap/i);
});

// ----- distillSession: returns raw markdown, no JSON parsing --------------

test("distillSession: returns the raw markdown string from Gemini", async () => {
  const originalFetch = globalThis.fetch;
  const fakeMarkdown = "# Handoff Brief\n\nThe user asked to refactor the distiller.\n";
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as RequestInit).body as string);
    assert.equal(body.response_format, undefined, "no JSON response_format");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: fakeMarkdown } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;

  try {
    const result = await distillSession(
      [{ role: "user", content: "refactor the distiller" }],
      [{ id: "s1", title: "t", mtime: 1, messageCount: 1 }],
    );
    assert.equal(result, fakeMarkdown);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillSession: throws when GEMINI_API_KEY is missing", async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(
    () => distillSession([{ role: "user", content: "x" }]),
    /GEMINI_API_KEY/,
  );
});

test("distillSession: throws on non-OK response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    await assert.rejects(
      () => distillSession([{ role: "user", content: "x" }]),
      /Gemini request failed \(429\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillSession: throws when Gemini returns no content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: {} }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    await assert.rejects(
      () => distillSession([{ role: "user", content: "x" }]),
      /no content/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillSession: returns markdown even if it contains code fences (no JSON repair needed)", async () => {
  // Regression: the old distiller ran jsonrepair on Gemini output. The new
  // distiller passes the content through unchanged.
  const originalFetch = globalThis.fetch;
  const fakeMarkdown = "# Brief\n\n```bash\nnpm run dev -- send\n```\n";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: fakeMarkdown } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const result = await distillSession([{ role: "user", content: "x" }]);
    assert.equal(result, fakeMarkdown);
    assert.match(result, /```bash/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});
