import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceiverBrief, ReceiverBriefDeps, CancelledError } from "./receiver-brief.js";
import type { AgentId } from "../adapters/index.js";

interface FakePrompterShape {
  answers: Record<string, unknown>;
  notes: Array<{ msg: string; title?: string }>;
  warns: string[];
}

class FakePrompter {
  private p: FakePrompterShape = { answers: {}, notes: [], warns: [] };
  // Test code can mutate `.answers` directly. The Prompter interface methods
  // read from there.
  intro(_msg: string) {}
  outro(_msg: string) {}
  cancel(_msg: string) {}
  note(msg: string, title?: string) { this.p.notes.push({ msg, title }); }
  log = {
    warn: (m: string) => { this.p.warns.push(m); },
    info: (_m: string) => {},
  };
  spinner() { return { start: () => {}, stop: () => {} }; }
  async confirm(o: { message: string; initialValue?: boolean }): Promise<boolean> {
    const k = `confirm:${o.message}`;
    if (k in this.p.answers) return this.p.answers[k] as boolean;
    return o.initialValue ?? true;
  }
  async select<T>(o: { message: string; options: Array<{ value: T; label: string }> }): Promise<T> {
    const k = `select:${o.message}`;
    if (k in this.p.answers) return this.p.answers[k] as T;
    return o.options[0].value;
  }
  async text(_o: { message: string }): Promise<string> { return ""; }
  async password(_o: { message: string }): Promise<string> { return "x"; }
}

function makeDeps(overrides: Partial<ReceiverBriefDeps> = {}): { deps: ReceiverBriefDeps; fake: FakePrompter } {
  const fake = new FakePrompter();
  const deps: ReceiverBriefDeps = {
    prompter: fake as never,
    receiverGeminiAvailable: () => false,
    distillToHtmlAndMarkdown: async (md) => ({ markdown: md, html: "<!doctype html>" }),
    openInBrowser: async () => {},
    resolveCwd: () => process.cwd(),
    resolveTmpdir: () => tmpdir(),
    now: () => 1700000000000,
    ...overrides,
  };
  return { deps, fake };
}

test("buildReceiverBrief writes markdown to .claude/ when claude is picked", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  deps.resolveCwd = () => cwd;

  const result = await buildReceiverBrief({
    decrypted: "# Handoff\n\n## 1. Primary Objective\n- x",
    userRequest: "Continue the work",
    deps,
  });

  const targetPath = join(cwd, ".claude", "handoff.md");
  assert.equal(existsSync(targetPath), true);
  assert.equal(readFileSync(targetPath, "utf8"), "# Handoff\n\n## 1. Primary Objective\n- x");
  assert.equal(result.targetAgent, "claude");
  assert.equal(result.markdown, "# Handoff\n\n## 1. Primary Objective\n- x");
});

test("buildReceiverBrief creates the agent directory if missing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "pi" as AgentId;
  deps.resolveCwd = () => cwd;

  await buildReceiverBrief({ decrypted: "x", userRequest: "y", deps });

  assert.equal(existsSync(join(cwd, ".pi")), true);
  assert.equal(existsSync(join(cwd, ".pi", "handoff.md")), true);
});

test("buildReceiverBrief without GEMINI key skips HTML step", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "opencode" as AgentId;
  deps.resolveCwd = () => cwd;
  let distillCalls = 0;
  deps.distillToHtmlAndMarkdown = async (md) => {
    distillCalls++;
    return { markdown: md, html: "" };
  };
  deps.receiverGeminiAvailable = () => false;

  await buildReceiverBrief({ decrypted: "verbatim", userRequest: "", deps });

  assert.equal(distillCalls, 0);
  assert.equal(readFileSync(join(cwd, ".opencode", "handoff.md"), "utf8"), "verbatim");
  // No HTML note was rendered.
  assert.equal(fake.p.notes.filter((n) => n.title === "HTML preview").length, 0);
});

test("buildReceiverBrief with GEMINI key renders HTML and opens it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const tmp = mkdtempSync(join(tmpdir(), "ctx-handoff-tmp-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  deps.resolveCwd = () => cwd;
  deps.resolveTmpdir = () => tmp;
  deps.receiverGeminiAvailable = () => true;
  deps.distillToHtmlAndMarkdown = async (md) => ({ markdown: md + " (refined)", html: "<!doctype html>rendered" });
  const opened: string[] = [];
  deps.openInBrowser = async (path) => { opened.push(path); };

  await buildReceiverBrief({ decrypted: "raw", userRequest: "", deps });

  assert.equal(readFileSync(join(cwd, ".claude", "handoff.md"), "utf8"), "raw (refined)");
  assert.equal(opened.length, 1);
  assert.match(opened[0], /handoff-\d+\.html$/);
  assert.equal(existsSync(opened[0]), true);
  assert.equal(readFileSync(opened[0], "utf8"), "<!doctype html>rendered");
});

test("buildReceiverBrief skips the agent picker when presetAgent is supplied", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  deps.resolveCwd = () => cwd;
  // Note: no answer for the picker. If the picker runs, the test fails because
  // it would either return the first option ("pi", going to .pi/) or block.
  // We set a cancel sentinel just in case the picker DOES run — it'd throw.
  fake.p.answers["select:Which coding agent to hand off to?"] = "clack:cancel";

  const result = await buildReceiverBrief({
    decrypted: "md",
    userRequest: "",
    presetAgent: "claude",
    deps,
  });
  assert.equal(result.targetAgent, "claude");
  assert.equal(existsSync(join(cwd, ".claude", "handoff.md")), true);
});

test("buildReceiverBrief throws CancelledError when user cancels the agent picker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "clack:cancel";
  deps.resolveCwd = () => cwd;

  await assert.rejects(
    () => buildReceiverBrief({ decrypted: "x", userRequest: "", deps }),
    CancelledError,
  );
  // No files written on cancel.
  assert.equal(existsSync(join(cwd, ".claude")), false);
});

test("buildReceiverBrief declines overwrite by default when handoff.md exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "handoff.md"), "old content", "utf8");
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  // No confirm answer — defaults to initialValue: false → decline.
  deps.resolveCwd = () => cwd;

  await buildReceiverBrief({ decrypted: "new", userRequest: "", deps });

  assert.equal(readFileSync(join(cwd, ".claude", "handoff.md"), "utf8"), "old content");
});

test("buildReceiverBrief overwrites when user confirms", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "handoff.md"), "old content", "utf8");
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  fake.p.answers["confirm:handoff.md already exists in .claude/. Overwrite?"] = true;
  deps.resolveCwd = () => cwd;

  await buildReceiverBrief({ decrypted: "new", userRequest: "", deps });

  assert.equal(readFileSync(join(cwd, ".claude", "handoff.md"), "utf8"), "new");
});

test("buildReceiverBrief declines injection by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  fake.p.answers["confirm:Launch claude with this handoff injected?"] = false;
  deps.resolveCwd = () => cwd;

  const result = await buildReceiverBrief({ decrypted: "x", userRequest: "y", deps });

  assert.equal(result.spawnInjection, null);
});

test("buildReceiverBrief with confirmed injection returns spawn payload", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "pi" as AgentId;
  fake.p.answers["confirm:Launch pi with this handoff injected?"] = true;
  deps.resolveCwd = () => cwd;

  const result = await buildReceiverBrief({
    decrypted: "# Handoff\n\n## 1. Primary Objective\n- a",
    userRequest: "pick up from there",
    deps,
  });

  assert.ok(result.spawnInjection, "spawnInjection should be present");
  assert.equal(result.spawnInjection!.bin, "pi");
  // The injection arg embeds the markdown and the user request.
  assert.match(result.spawnInjection!.args[0], /# Handoff/);
  assert.match(result.spawnInjection!.args[0], /pick up from there/);
  assert.match(result.spawnInjection!.args[0], /SYSTEM CONTEXT INJECTION/);
});

test("buildReceiverBrief injection preamble does NOT reference the old fixed-schema section names", async () => {
  // The dynamic redesign removed the 5-field schema. The injection preamble
  // must not tell the agent to "avoid Failed Approaches" or "acknowledge
  // Current State" — those assume a fixed schema that no longer exists.
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "pi" as AgentId;
  fake.p.answers["confirm:Launch pi with this handoff injected?"] = true;
  deps.resolveCwd = () => cwd;

  const result = await buildReceiverBrief({
    decrypted: "# Brief",
    userRequest: "continue",
    deps,
  });

  const injection = result.spawnInjection!.args[0];
  assert.doesNotMatch(injection, /Completed Steps/);
  assert.doesNotMatch(injection, /Failed Approaches/);
  assert.doesNotMatch(injection, /Current State/);
  assert.doesNotMatch(injection, /Next Steps/);
});

test("buildReceiverBrief injection preamble describes the brief as a verbose Markdown document", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "pi" as AgentId;
  fake.p.answers["confirm:Launch pi with this handoff injected?"] = true;
  deps.resolveCwd = () => cwd;

  const result = await buildReceiverBrief({
    decrypted: "# Brief",
    userRequest: "continue",
    deps,
  });

  const injection = result.spawnInjection!.args[0];
  // The new preamble frames the input as a verbose Markdown handoff.
  assert.match(injection, /Context Handoff Document/);
  assert.match(injection, /continue the work/i);
});

test("buildReceiverBrief falls back to default user request when none provided", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "pi" as AgentId;
  fake.p.answers["confirm:Launch pi with this handoff injected?"] = true;
  deps.resolveCwd = () => cwd;

  const result = await buildReceiverBrief({ decrypted: "md", userRequest: "", deps });

  assert.match(result.spawnInjection!.args[0], /Continue the work described above\./);
});

test("buildReceiverBrief degrades gracefully when Gemini render fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const { deps, fake } = makeDeps();
  fake.p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  deps.resolveCwd = () => cwd;
  deps.receiverGeminiAvailable = () => true;
  deps.distillToHtmlAndMarkdown = async () => { throw new Error("rate limited"); };

  await buildReceiverBrief({ decrypted: "fallback", userRequest: "", deps });

  // Falls back to verbatim markdown.
  assert.equal(readFileSync(join(cwd, ".claude", "handoff.md"), "utf8"), "fallback");
  assert.equal(fake.p.warns.length >= 1, true);
  assert.match(fake.p.warns[0], /rate limited/);
});
