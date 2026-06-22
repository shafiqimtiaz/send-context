import { test } from "node:test";
import assert from "node:assert/strict";
import { runReceive, RunReceiveDeps } from "./receive.js";
import { decodePayload } from "../core/wire.js";

function makeDeps(overrides: Partial<RunReceiveDeps> = {}): RunReceiveDeps {
  return {
    downloadPayload: async () => ({}),
    decrypt: () => "",
    decodePayload: (json) => decodePayload(json),
    buildReceiverBrief: async () => ({
      targetAgent: "claude" as never,
      markdown: "",
      spawnInjection: null,
    }),
    distillToHtmlAndMarkdown: async (md) => ({ markdown: md, html: "" }),
    receiverGeminiAvailable: () => false,
    openInBrowser: async () => {},
    spawnAgent: async () => 0,
    resolveCwd: () => "/tmp",
    resolveTmpdir: () => "/tmp",
    now: () => 0,
    getPassword: async () => "secret",
    stdinIsTty: false,
    stdoutWrite: () => {},
    ...overrides,
  };
}

test("runReceive: decodes a v2 payload and passes the markdown to stdout", async () => {
  const written: string[] = [];
  const v2Json = JSON.stringify({
    version: 2,
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Handoff Brief: foo\n\n`src/core/distiller.ts` line 42.\n",
  });
  const deps = makeDeps({
    decrypt: () => v2Json,
    stdoutWrite: (s) => written.push(s),
  });

  await runReceive("ctx-handoff://worker/abc", [], deps);

  assert.equal(written.length, 1);
  assert.match(written[0], /# Handoff Brief: foo/);
  assert.match(written[0], /`src\/core\/distiller\.ts` line 42/);
});

test("runReceive: rejects v1 payloads with the upgrade-required error", async () => {
  const written: string[] = [];
  const v1Json = JSON.stringify({
    version: 1,
    markdown: "# Old format\n",
  });
  const deps = makeDeps({
    decrypt: () => v1Json,
    stdoutWrite: (s) => written.push(s),
  });

  // Save & restore process.exitCode so we can assert on it.
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await runReceive("ctx-handoff://worker/abc", [], deps);
    assert.equal(process.exitCode, 1, "exit code is 1 on version error");
  } finally {
    process.exitCode = saved;
  }
  // The markdown body was NOT written — version error short-circuits.
  assert.equal(written.length, 0);
});

test("runReceive: rejects payloads with a missing version field", async () => {
  const written: string[] = [];
  const noVersionJson = JSON.stringify({
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Brief\n",
  });
  const deps = makeDeps({
    decrypt: () => noVersionJson,
    stdoutWrite: (s) => written.push(s),
  });

  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await runReceive("ctx-handoff://worker/abc", [], deps);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = saved;
  }
  assert.equal(written.length, 0);
});

test("runReceive: rejects payloads with a future version (e.g. v3)", async () => {
  const written: string[] = [];
  const v3Json = JSON.stringify({
    version: 3,
    source: { agent: "Pi", capturedAt: "2026-06-22T12:00:00.000Z" },
    markdown: "# Brief\n",
  });
  const deps = makeDeps({
    decrypt: () => v3Json,
    stdoutWrite: (s) => written.push(s),
  });

  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await runReceive("ctx-handoff://worker/abc", [], deps);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = saved;
  }
  assert.equal(written.length, 0);
});

test("runReceive: reports 'Invalid password.' for a decrypt auth-tag failure", async () => {
  const written: string[] = [];
  const deps = makeDeps({
    decrypt: () => { throw new Error("INVALID_PASSWORD"); },
    stdoutWrite: (s) => written.push(s),
  });

  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await runReceive("ctx-handoff://worker/abc", [], deps);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = saved;
  }
  // The "Invalid password." path is taken; no markdown is written.
  assert.equal(written.length, 0);
});
