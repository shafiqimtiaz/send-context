import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHandoff,
  CancelledError,
  HandoffBuilderDeps,
  Prompter,
  Spinner,
} from "./handoff-builder.js";
import { AgentAdapter } from "../adapters/types.js";
import { HandoffLink } from "./link.js";

// ----- Test doubles --------------------------------------------------------

function noopSpinner(): Spinner {
  return { start() {}, stop() {} };
}

class FakePrompter implements Prompter {
  introCalls: string[] = [];
  outroCalls: string[] = [];
  cancelCalls: string[] = [];
  noteCalls: Array<{ msg: string; title?: string }> = [];
  warns: string[] = [];

  selectAnswer: unknown = undefined;
  multiselectAnswer: unknown[] = [];
  textAnswer: string = "";
  passwordAnswer: string = "";
  confirmAnswer: boolean = true;

  intro(msg: string) { this.introCalls.push(msg); }
  outro(msg: string) { this.outroCalls.push(msg); }
  cancel(msg: string) { this.cancelCalls.push(msg); }
  note(msg: string, title?: string) { this.noteCalls.push({ msg, title }); }
  log = { warn: (m: string) => { this.warns.push(m); }, info: () => {} };
  spinner(): Spinner { return noopSpinner(); }
  async select<T>(): Promise<T> { return this.selectAnswer as T; }
  async multiselect<T>(): Promise<T[]> { return this.multiselectAnswer as T[]; }
  async text(): Promise<string> { return this.textAnswer; }
  async password(): Promise<string> { return this.passwordAnswer; }
  async confirm(): Promise<boolean> { return this.confirmAnswer; }
}

function fakeAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    getName: () => "Pi",
    listSessions: async () => [{ id: "sess-1", title: "first session", mtime: 1 }],
    extractSession: async () => [
      { role: "user", content: "Refactor the worker" },
      { role: "assistant", content: "Plan: split into modules" },
    ],
    ...overrides,
  };
}

function baseDeps(p: Prompter, adapter: AgentAdapter, overrides: Partial<HandoffBuilderDeps> = {}): HandoffBuilderDeps {
  const deps: HandoffBuilderDeps = {
    prompter: p,
    detectAgents: () => ["pi"],
    createAdapter: () => adapter,
    encrypt: () => ({ salt: "x", iv: "y", ciphertext: "z" }),
    uploadPayload: async () => "abc123",
    encodeLink: ({ workerHost, id }: HandoffLink) =>
      `ctx-handoff://${workerHost}/${id}`,
    geminiAvailable: () => false,
    distillSession: async () => ({
      objective: "",
      currentState: "",
      completedSteps: "",
      failedApproaches: "",
      nextSteps: "",
    }),
    formatToHandoffSkill: (input) =>
      `mock-doc:${input.sections.objective ?? ""}`,
    isStdoutTty: true,
  };
  return { ...deps, ...overrides };
}

// ----- Tests ---------------------------------------------------------------

test("harness: smoke test the test doubles", () => {
  // Sanity: the doubles behave as expected.
  const p = new FakePrompter();
  assert.equal(p.introCalls.length, 0);
  p.intro("x");
  assert.deepEqual(p.introCalls, ["x"]);
});

test("builder: preset agent skips detection, returns a link", async () => {
  const p = new FakePrompter();
  const adapter = fakeAdapter();
  const deps = baseDeps(p, adapter);

  const result = await buildHandoff({
    workerHost: "h.deno.net",
    password: "secret",
    presetAgent: "pi",
    cwd: "/tmp",
    deps,
  });

  assert.equal(result.link, "ctx-handoff://h.deno.net/abc123");
  // Manual flow was used (no gemini), so note/link was called with the link.
  assert.ok(p.noteCalls.some((n) => n.msg.startsWith("ctx-handoff://")));
});

test("builder: detects multiple agents and asks user to pick", async () => {
  const p = new FakePrompter();
  p.selectAnswer = "pi"; // user picked pi
  const adapter = fakeAdapter();
  const deps = baseDeps(p, adapter, {
    detectAgents: () => ["pi", "claude"],
  });

  const result = await buildHandoff({
    workerHost: "h.deno.net",
    password: "secret",
    cwd: "/tmp",
    deps,
  });
  assert.equal(result.link, "ctx-handoff://h.deno.net/abc123");
});

test("builder: non-TTY auto-selects newest session without prompting", async () => {
  const p = new FakePrompter();
  const adapter = fakeAdapter({
    listSessions: async () => [
      { id: "older", title: "older", mtime: 1 },
      { id: "newest", title: "newest", mtime: 9 },
    ],
  });
  const deps = baseDeps(p, adapter, { isStdoutTty: false });

  const result = await buildHandoff({
    workerHost: "h.deno.net",
    password: "secret",
    presetAgent: "pi",
    cwd: "/tmp",
    deps,
  });
  assert.equal(result.link, "ctx-handoff://h.deno.net/abc123");
  // No multiselect was shown — fake's multiselectAnswer stays [].
  assert.deepEqual(p.multiselectAnswer, []);
});

test("builder: empty session list throws a no-sessions error", async () => {
  const p = new FakePrompter();
  const adapter = fakeAdapter({ listSessions: async () => [] });
  const deps = baseDeps(p, adapter);

  await assert.rejects(
    buildHandoff({
      workerHost: "h.deno.net",
      password: "secret",
      presetAgent: "pi",
      cwd: "/tmp",
      deps,
    }),
    /No sessions found/,
  );
});

test("builder: distill path uses Gemini and skips manual prompts", async () => {
  const p = new FakePrompter();
  let distillCalled = false;
  const adapter = fakeAdapter();
  const deps = baseDeps(p, adapter, {
    geminiAvailable: () => true,
    distillSession: async () => {
      distillCalled = true;
      return {
        objective: "Distilled",
        currentState: "",
        completedSteps: "",
        failedApproaches: "",
        nextSteps: "",
      };
    },
  });

  await buildHandoff({
    workerHost: "h.deno.net",
    password: "secret",
    presetAgent: "pi",
    cwd: "/tmp",
    deps,
  });
  assert.equal(distillCalled, true);
  // Manual flow's text/confirm prompts were NOT invoked.
  assert.equal(p.textAnswer, "");
});

test("builder: distill failure falls back to manual flow with a warning", async () => {
  const p = new FakePrompter();
  p.textAnswer = "manual objective";
  const adapter = fakeAdapter();
  const deps = baseDeps(p, adapter, {
    geminiAvailable: () => true,
    distillSession: async () => {
      throw new Error("Gemini down");
    },
  });

  await buildHandoff({
    workerHost: "h.deno.net",
    password: "secret",
    presetAgent: "pi",
    cwd: "/tmp",
    deps,
  });
  assert.ok(p.warns.some((w) => /Gemini down/.test(w)));
});

test("builder: user cancel during section prompt throws CancelledError", async () => {
  const baseP = new FakePrompter();
  // FakePrompter doesn't model cancel — clone it with confirm() that throws.
  const cancelPrompter: Prompter = {
    intro: (m) => baseP.intro(m),
    outro: (m) => baseP.outro(m),
    cancel: (m) => baseP.cancel(m),
    note: (m, t) => baseP.note(m, t),
    log: baseP.log,
    spinner: () => noopSpinner(),
    select: <T,>() => baseP.select<T>(),
    multiselect: <T,>() => baseP.multiselect<T[]>(),
    text: () => Promise.resolve(baseP.textAnswer),
    password: () => Promise.resolve(baseP.passwordAnswer),
    confirm: () => { throw new CancelledError(); },
  };
  const adapter = fakeAdapter();
  const deps = baseDeps(cancelPrompter, adapter);

  await assert.rejects(
    buildHandoff({
      workerHost: "h.deno.net",
      password: "secret",
      presetAgent: "pi",
      cwd: "/tmp",
      deps,
    }),
    CancelledError,
  );
});

test("builder: password too short via env var throws", async () => {
  const p = new FakePrompter();
  const adapter = fakeAdapter();
  const deps = baseDeps(p, adapter);

  await assert.rejects(
    buildHandoff({
      workerHost: "h.deno.net",
      password: "abc", // < 4 chars
      presetAgent: "pi",
      cwd: "/tmp",
      deps,
    }),
    /at least 4 characters/,
  );
});

test("builder: upload failure propagates as a thrown error", async () => {
  const p = new FakePrompter();
  const adapter = fakeAdapter();
  const deps = baseDeps(p, adapter, {
    uploadPayload: async () => {
      throw new Error("server 500");
    },
  });

  await assert.rejects(
    buildHandoff({
      workerHost: "h.deno.net",
      password: "secret",
      presetAgent: "pi",
      cwd: "/tmp",
      deps,
    }),
    /server 500/,
  );
});