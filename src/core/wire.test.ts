import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePayload, decodePayload } from "./wire.js";
import type { SessionMessage } from "../adapters/types.js";

// ----- encodePayload -------------------------------------------------------

test("encodePayload: produces JSON with version 2", () => {
  const json = encodePayload({
    sourceAgent: "Pi",
    timestamp: "2026-06-22T12:00:00.000Z",
    markdown: "# Brief\n",
  });
  const obj = JSON.parse(json);
  assert.equal(obj.version, 2);
});

test("encodePayload: includes source agent and captured timestamp", () => {
  const json = encodePayload({
    sourceAgent: "Claude Code",
    timestamp: "2026-06-22T12:00:00.000Z",
    markdown: "# Brief\n",
  });
  const obj = JSON.parse(json);
  assert.deepEqual(obj.source, {
    agent: "Claude Code",
    capturedAt: "2026-06-22T12:00:00.000Z",
  });
});

test("encodePayload: includes the markdown body", () => {
  const json = encodePayload({
    sourceAgent: "Pi",
    timestamp: "2026-06-22T12:00:00.000Z",
    markdown: "# Handoff Brief: foo\n\n`src/core/bar.ts` line 42.\n",
  });
  const obj = JSON.parse(json);
  assert.equal(obj.markdown, "# Handoff Brief: foo\n\n`src/core/bar.ts` line 42.\n");
});

test("encodePayload: omits the appendix key when no appendix is provided", () => {
  const json = encodePayload({
    sourceAgent: "Pi",
    timestamp: "2026-06-22T12:00:00.000Z",
    markdown: "# Brief\n",
  });
  const obj = JSON.parse(json);
  assert.equal("appendix" in obj, false);
});

test("encodePayload: includes the appendix when provided", () => {
  const appendix: SessionMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "World" },
  ];
  const json = encodePayload({
    sourceAgent: "Pi",
    timestamp: "2026-06-22T12:00:00.000Z",
    markdown: "# Brief\n",
    appendix,
  });
  const obj = JSON.parse(json);
  assert.deepEqual(obj.appendix, appendix);
});

// ----- decodePayload -------------------------------------------------------

test("decodePayload: parses a v2 payload and returns the fields", () => {
  const json = JSON.stringify({
    version: 2,
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Brief\n",
  });
  const payload = decodePayload(json);
  assert.equal(payload.version, 2);
  assert.equal(payload.source.agent, "Pi");
  assert.equal(payload.source.capturedAt, "2026-06-22T12:00:00.000Z");
  assert.equal(payload.markdown, "# Brief\n");
});

test("decodePayload: returns appendix when present", () => {
  const appendix: SessionMessage[] = [{ role: "user", content: "raw" }];
  const json = JSON.stringify({
    version: 2,
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Brief\n",
    appendix,
  });
  const payload = decodePayload(json);
  assert.deepEqual(payload.appendix, appendix);
});

test("decodePayload: rejects v1 payloads with the upgrade-required error", () => {
  const v1Json = JSON.stringify({
    // The old fixed-schema rendered output looked like a markdown doc with
    // ## 1. Primary Objective, etc. We don't introspect it; we just check
    // the version field.
    version: 1,
    markdown: "# Old format\n",
  });
  assert.throws(
    () => decodePayload(v1Json),
    /version 1|older format|ask the sender to upgrade/i,
  );
});

test("decodePayload: rejects payloads with a missing version field", () => {
  const json = JSON.stringify({
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Brief\n",
  });
  assert.throws(
    () => decodePayload(json),
    /version/i,
  );
});

test("decodePayload: rejects payloads with a future version (e.g. v3)", () => {
  const json = JSON.stringify({
    version: 3,
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Brief\n",
  });
  assert.throws(
    () => decodePayload(json),
    /version 3|ask the sender to upgrade|newer than this build/i,
  );
});

test("decodePayload: rejects payloads with missing markdown", () => {
  const json = JSON.stringify({
    version: 2,
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
  });
  assert.throws(() => decodePayload(json), /markdown/);
});

test("decodePayload: rejects payloads with missing source metadata", () => {
  const json = JSON.stringify({
    version: 2,
    markdown: "# Brief\n",
  });
  assert.throws(() => decodePayload(json), /source/);
});

test("decodePayload: rejects non-JSON input", () => {
  assert.throws(() => decodePayload("not json at all"), /JSON|parse/i);
});

test("decodePayload: the upgrade-required error message explicitly tells the user what to do", () => {
  const v1Json = JSON.stringify({ version: 1, markdown: "# x" });
  try {
    decodePayload(v1Json);
    assert.fail("should have thrown");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /older format/i);
    assert.match(msg, /ask the sender to upgrade/i);
  }
});

// ----- round-trip ----------------------------------------------------------

test("encodePayload → decodePayload: round-trips a typical distill payload", () => {
  const original = {
    sourceAgent: "Pi",
    timestamp: "2026-06-22T12:00:00.000Z",
    markdown: "# Verbose Brief\n\n`src/core/foo.ts` lines 1-50.\n\n```bash\nnpm run dev -- send\n```\n",
  };
  const json = encodePayload(original);
  const decoded = decodePayload(json);
  assert.equal(decoded.version, 2);
  assert.equal(decoded.source.agent, original.sourceAgent);
  assert.equal(decoded.source.capturedAt, original.timestamp);
  assert.equal(decoded.markdown, original.markdown);
});
