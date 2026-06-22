# `send` Rename + Receiver-Side HTML Brief — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Rename the `export` command to `send`, add topic-aware sender-side distillation, and rebuild the receiver flow so it picks the target coding agent, drops the brief into the agent's project folder, optionally renders an HTML preview, and confirms before injecting into the agent.

**Architecture:** Sender side is a prompt + transcript-marker change in `distiller.ts` plus an additive `topics` schema field. Receiver side gains two new modules: `core/receiver-prompts.ts` (Gemini system prompt, HTML scaffold, `distillToHtmlAndMarkdown`) and `core/receiver-brief.ts` (post-decryption TUI flow, mirrors `handoff-builder.ts`'s `Prompter`-driven shape). `commands/receive.ts` becomes a thin shell.

**Tech Stack:** Node 20+, TypeScript 5.6, `@clack/prompts`, `commander`, `jsonrepair`. `node:test` runner via `tsx`. No new runtime deps.

**Reference design:** `docs/plans/2026-06-22-send-receiver-html-design.md`

**Worktree:** `.worktrees/send-receiver-html` (branch `feature/send-receiver-html`)

---

## Task 1: Rename `export` → `send`

**Files:**
- Rename: `src/commands/export.ts` → `src/commands/send.ts`
- Modify: `src/index.ts`
- Modify: `README.md`

**Step 1: Rename the file**

```bash
cd .worktrees/send-receiver-html
git mv src/commands/export.ts src/commands/send.ts
```

**Step 2: Update the renamed file**

Inside `src/commands/send.ts`:
- Replace `export interface ExportOptions` with `export interface SendOptions`
- Replace `export async function runExport(opts: ExportOptions)` with `export async function runSend(opts: SendOptions)`
- Update the JSDoc comment from "Thin CLI shell around buildHandoff" — no other behavior changes

**Step 3: Update `src/index.ts`**

```typescript
import { runSend, SendOptions } from "./commands/send.js";
// ...
program
  .command("send")
  .description("Extract the current agent session, format it, encrypt it, and produce a share link.")
  .option("-a, --agent <agent>", "force agent: pi | claude | opencode")
  .option("-w, --worker <host>", "Cloudflare Worker host (or set CTX_HANDOFF_WORKER)")
  .action((opts: { agent?: string; worker?: string }) =>
    runSend({ agent: opts.agent as AgentId | undefined, worker: opts.worker } as SendOptions),
  );
```

**Step 4: Update README.md**

Replace all instances of `ctx-handoff export` with `ctx-handoff send`. Replace "Export" section headings with "Send" where they refer to the command. Leave the `receive` command docs unchanged.

**Step 5: Verify it builds**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: 0 errors.

**Step 6: Verify tests still pass**

```bash
npm test
```

Expected: 36 tests pass.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename export command to send"
```

---

## Task 2: Sender-Side Topic-Aware Distillation

**Files:**
- Modify: `src/core/distiller.ts`
- Create: `src/core/distiller.test.ts`
- Modify: `src/core/formatter.ts`
- Modify: `src/core/formatter.test.ts`
- Modify: `src/core/handoff-builder.ts` (pass session titles into the transcript)

**Step 1: Write the failing test for topic-aware distillation**

Create `src/core/distiller.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

// We test the prompt construction and the parse path; the live fetch is mocked.
import { buildTranscript, parseSections } from "./distiller.js";

test("buildTranscript inserts session boundary markers", () => {
  const t = buildTranscript([
    { role: "user", content: "first topic" },
    { role: "assistant", content: "ok 1" },
  ], [{ id: "s1", title: "Refactor distiller", mtime: 1, messageCount: 2 }]);

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
});

test("parseSections reads topics array when present", () => {
  const sections = parseSections(JSON.stringify({
    topics: ["A", "B"],
    objective: "Two workstreams",
    currentState: "A: … B: …",
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
```

**Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/core/distiller.test.ts
```

Expected: failures on `buildTranscript` (not exported) and on the topic parsing.

**Step 3: Implement `buildTranscript` and update `parseSections`**

In `src/core/distiller.ts`:

- Export `buildTranscript(messages: SessionMessage[], sessions: SessionRef[]): string`. It walks the messages in order, attributing ranges to each session by message count. Insert a `### === SESSION i: <title> (N msgs) ===` header before each session's block.
- Extend `HandoffSections`-shaped parsing to include `topics: string[] | undefined`.
- Replace the `SYSTEM_PROMPT` const with the topic-aware version. Key additions: explain the `### === SESSION n: … ===` markers; instruct Gemini to detect distinct topics and emit a `topics: string[]` field; instruct that when `topics.length > 1` the 5 narrative fields carry `### <Topic>` sub-headers in their bullet lists and prose.
- Update `distillSession` to accept `(messages, sessions)` instead of just `messages`, and to call `buildTranscript(messages, sessions)`.

The new `HandoffSections` interface (in `formatter.ts` or `distiller.ts` — pick one and import from the other) becomes:

```typescript
export interface HandoffSections {
  objective: string;
  currentState: string;
  completedSteps: string;
  failedApproaches: string;
  nextSteps: string;
  topics?: string[];
}
```

**Step 4: Update `HandoffBuilderDeps` in `handoff-builder.ts`**

The `distillSession` field in `HandoffBuilderDeps` needs the new signature: `(messages: SessionMessage[], sessions: SessionRef[]) => Promise<HandoffSections>`. Update the call site in `buildHandoff` to pass the chosen `SessionRef[]` (already in scope from `chooseSessions`).

**Step 5: Update `formatter.ts`**

- Import `HandoffSections` from `distiller.ts` (or vice versa — whichever is canonical).
- When `sections.topics` is non-empty, render topic sub-headers in the 5 narrative sections. Implementation: when topics exist, each of the 5 narrative fields is expected to contain `### <Topic>` markers; pass them through to the markdown unchanged. Add a `## Topics` line at the top of the document listing the topics.

**Step 6: Update `formatter.test.ts`**

Add two tests:

```typescript
test("formatToHandoffSkill renders topic list when topics is present", () => {
  const out = formatToHandoffSkill({
    sourceAgent: "Pi",
    timestamp: "2026-06-22T00:00:00Z",
    appendix: [],
    allMessages: [{ role: "user", content: "First task" }],
    sections: {
      topics: ["Topic A", "Topic B"],
      objective: "Two workstreams",
      currentState: "A: …\n\nB: …",
      completedSteps: "### Topic A\n- x\n\n### Topic B\n- y",
      failedApproaches: "None.",
      nextSteps: "### Topic A\n- a\n\n### Topic B\n- b",
    },
  });
  assert.match(out, /## Topics\n- Topic A\n- Topic B/);
  assert.match(out, /### Topic A\n- x/);
});

test("formatToHandoffSkill omits Topics section when topics is absent", () => {
  const out = formatToHandoffSkill({
    sourceAgent: "Pi",
    timestamp: "2026-06-22T00:00:00Z",
    appendix: [],
    allMessages: [{ role: "user", content: "First task" }],
    sections: { objective: "Single thread" },
  });
  assert.doesNotMatch(out, /## Topics/);
});
```

**Step 7: Run all tests**

```bash
npm test
```

Expected: all previous 36 tests pass + new tests pass. Total ~40+ tests.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat(distiller): topic-aware multi-session distillation with topics schema field"
```

---

## Task 3: `core/receiver-prompts.ts` — HTML + Markdown Generation

**Files:**
- Create: `src/core/receiver-prompts.ts`
- Create: `src/core/receiver-prompts.test.ts`

**Step 1: Write the failing test**

Create `src/core/receiver-prompts.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECEIVER_SYSTEM_PROMPT, RECEIVER_HTML_SCAFFOLD, distillToHtmlAndMarkdown } from "./receiver-prompts.js";

test("RECEIVER_SYSTEM_PROMPT references both markdown and html", () => {
  assert.match(RECEIVER_SYSTEM_PROMPT, /markdown/);
  assert.match(RECEIVER_SYSTEM_PROMPT, /html/);
});

test("RECEIVER_HTML_SCAFFOLD includes Tailwind and Mermaid CDN", () => {
  assert.match(RECEIVER_HTML_SCAFFOLD, /cdn\.tailwindcss\.com/);
  assert.match(RECEIVER_HTML_SCAFFOLD, /mermaid/);
});

test("RECEIVER_HTML_SCAFFOLD has all placeholder slots", () => {
  for (const ph of [
    "{{title}}", "{{source_agent}}", "{{date}}", "{{topic_chips}}",
    "{{objective_body}}", "{{current_state_body}}", "{{completed_steps_body}}",
    "{{failed_approaches_body}}", "{{next_steps_body}}", "{{raw_appendix_body}}",
  ]) {
    assert.match(RECEIVER_HTML_SCAFFOLD, new RegExp(ph.replace(/[{}]/g, "\\$&")));
  }
});

test("distillToHtmlAndMarkdown parses Gemini JSON response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      markdown: "# Handoff\n\n## 1. Primary Objective\n- a",
      html: "<!doctype html><html><body>h</body></html>",
    }) } }],
  }), { status: 200 });

  try {
    const out = await distillToHtmlAndMarkdown("# Handoff\n…", "claude");
    assert.equal(out.markdown.startsWith("# Handoff"), true);
    assert.equal(out.html.startsWith("<!doctype html>"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("distillToHtmlAndMarkdown repairs malformed JSON via jsonrepair", async () => {
  const originalFetch = globalThis.fetch;
  // Trailing comma + missing closing brace — jsonrepair's bread and butter.
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{ "markdown": "x", "html": "y",' } }],
  }), { status: 200 });

  try {
    const out = await distillToHtmlAndMarkdown("# Handoff", "pi");
    assert.equal(out.markdown, "x");
    assert.equal(out.html, "y");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

**Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/core/receiver-prompts.test.ts
```

Expected: 5 failures (file not found).

**Step 3: Implement `src/core/receiver-prompts.ts`**

Top of file:

```typescript
import { jsonrepair } from "jsonrepair";
import { AgentId } from "../adapters/index.js";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const DEFAULT_MODEL = "gemini-2.5-flash";

export const RECEIVER_SYSTEM_PROMPT = `You are refining a handoff brief that another developer is about to receive. The input is a Markdown handoff document. Produce a JSON object with two fields: "markdown" (the file written to the receiver's coding-agent project folder) and "html" (a self-contained browser page for the receiver to review before launching their agent).

Preserve every fact from the input. Make the markdown slightly tighter and more action-oriented for the chosen agent. Make the HTML editorial and scannable using the supplied scaffold. The Raw Context Appendix must be present in the markdown but collapsed by default in the HTML (<details><summary>).

Respond with ONLY a JSON object.`;
```

The `RECEIVER_HTML_SCAFFOLD` const is a full `<!doctype html>` document. Tailwind via CDN, Mermaid via CDN ESM, `bg-stone-50 text-slate-900 font-sans`, `max-w-5xl mx-auto px-6 py-12 space-y-12`. Header shows project name, date, source agent, topic chips. Six `<section>` cards with Tailwind classes (`rounded-lg border border-slate-200 bg-white p-6`). Raw Appendix uses `<details><summary>`. Replace the placeholders with `{{title}}`, `{{source_agent}}`, `{{date}}`, `{{topic_chips}}`, `{{objective_body}}`, `{{current_state_body}}`, `{{completed_steps_body}}`, `{{failed_approaches_body}}`, `{{next_steps_body}}`, `{{raw_appendix_body}}`.

`distillToHtmlAndMarkdown`:

```typescript
export async function distillToHtmlAndMarkdown(
  decrypted: string,
  agentId: AgentId,
): Promise<{ markdown: string; html: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: RECEIVER_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Agent: ${agentId}\n\nHandoff document:\n\n${decrypted}\n\n` +
            `HTML scaffold to use as the structure for the "html" field ` +
            `(substitute the {{...}} placeholders; preserve CDN scripts and styling):\n\n` +
            RECEIVER_HTML_SCAFFOLD,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Gemini returned no content.");

  const obj = JSON.parse(jsonrepair(content)) as { markdown?: unknown; html?: unknown };
  if (typeof obj.markdown !== "string" || typeof obj.html !== "string") {
    throw new Error("Gemini response missing markdown or html field.");
  }
  return { markdown: obj.markdown, html: obj.html };
}

export function receiverGeminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}
```

**Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/core/receiver-prompts.test.ts
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(receiver): Gemini HTML+markdown generation prompts and scaffold"
```

---

## Task 4: `core/receiver-brief.ts` — Post-Decryption TUI Flow

**Files:**
- Create: `src/core/receiver-brief.ts`
- Create: `src/core/receiver-brief.test.ts`

**Step 1: Write the failing test**

Create `src/core/receiver-brief.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceiverBrief, ReceiverBriefDeps, CancelledError } from "./receiver-brief.js";
import type { AgentId } from "../adapters/index.js";
import type { SessionMessage } from "../adapters/types.js";

class FakePrompter {
  answers: Record<string, unknown> = {};
  notes: Array<{ msg: string; title?: string }> = [];
  warns: string[] = [];
  async confirm(o: { message: string; initialValue?: boolean }): Promise<boolean> {
    const k = `confirm:${o.message}`;
    if (k in this.answers) return this.answers[k] as boolean;
    return o.initialValue ?? true;
  }
  async select<T>(o: { message: string; options: Array<{ value: T }> }): Promise<T> {
    return this.answers[`select:${o.message}`] as T ?? o.options[0].value;
  }
  async text(o: { message: string }): Promise<string> {
    return this.answers[`text:${o.message}`] as string ?? "";
  }
  async password(o: { message: string }): Promise<string> {
    return this.answers[`password:${o.message}`] as string ?? "x";
  }
  note(msg: string, title?: string): void { this.notes.push({ msg, title }); }
  log = { warn: (m: string) => this.warns.push(m), info: () => {} };
  intro() {} outro() {} cancel() {}
  spinner() { return { start() {}, stop() {} }; }
}

function makeDeps(overrides: Partial<ReceiverBriefDeps> = {}): ReceiverBriefDeps {
  const p = new FakePrompter() as never;
  return {
    prompter: p,
    receiverGeminiAvailable: () => false,
    distillToHtmlAndMarkdown: async (md) => ({ markdown: md, html: "<!doctype html>" }),
    openInBrowser: async () => {},
    resolveCwd: () => process.cwd(),
    resolveTmpdir: () => tmpdir(),
    ...overrides,
  };
}

test("buildReceiverBrief writes markdown to .claude/ when claude is picked", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const p = new FakePrompter();
  p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  const deps = makeDeps({ prompter: p as never, resolveCwd: () => cwd });

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
  const p = new FakePrompter();
  p.answers["select:Which coding agent to hand off to?"] = "pi" as AgentId;
  const deps = makeDeps({ prompter: p as never, resolveCwd: () => cwd });

  await buildReceiverBrief({ decrypted: "x", userRequest: "y", deps });

  assert.equal(existsSync(join(cwd, ".pi")), true);
});

test("buildReceiverBrief without GEMINI key skips HTML step", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const p = new FakePrompter();
  p.answers["select:Which coding agent to hand off to?"] = "opencode" as AgentId;
  const calls = { distill: 0 };
  const deps = makeDeps({
    prompter: p as never,
    resolveCwd: () => cwd,
    receiverGeminiAvailable: () => false,
    distillToHtmlAndMarkdown: async (md) => { calls.distill++; return { markdown: md, html: "" }; },
  });

  await buildReceiverBrief({ decrypted: "verbatim", userRequest: "", deps });

  assert.equal(calls.distill, 0);
  assert.equal(readFileSync(join(cwd, ".opencode", "handoff.md"), "utf8"), "verbatim");
});

test("buildReceiverBrief with GEMINI key renders HTML and opens it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const p = new FakePrompter();
  p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  const opened: string[] = [];
  const deps = makeDeps({
    prompter: p as never,
    resolveCwd: () => cwd,
    receiverGeminiAvailable: () => true,
    distillToHtmlAndMarkdown: async (md) => ({ markdown: md + " (refined)", html: "<!doctype html>rendered" }),
    openInBrowser: async (path) => { opened.push(path); },
  });

  await buildReceiverBrief({ decrypted: "raw", userRequest: "", deps });

  assert.equal(readFileSync(join(cwd, ".claude", "handoff.md"), "utf8"), "raw (refined)");
  assert.equal(opened.length, 1);
  assert.match(opened[0], /handoff-\d+\.html$/);
});

test("buildReceiverBrief throws CancelledError when user cancels the agent picker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  const p = new FakePrompter();
  p.answers["select:Which coding agent to hand off to?"] = Symbol("clack:cancel") as never;
  const deps = makeDeps({ prompter: p as never, resolveCwd: () => cwd });

  await assert.rejects(
    () => buildReceiverBrief({ decrypted: "x", userRequest: "", deps }),
    CancelledError,
  );
});

test("buildReceiverBrief confirms overwrite when handoff.md exists (default no)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-test-"));
  writeFileSync(join(cwd, ".claude", "handoff.md"), "old content", { recursive: true });
  const p = new FakePrompter();
  p.answers["select:Which coding agent to hand off to?"] = "claude" as AgentId;
  p.answers["confirm:handoff.md already exists in .claude/. Overwrite?"] = false;
  const deps = makeDeps({ prompter: p as never, resolveCwd: () => cwd });

  await buildReceiverBrief({ decrypted: "new", userRequest: "", deps });

  assert.equal(readFileSync(join(cwd, ".claude", "handoff.md"), "utf8"), "old content");
});
```

**Step 2: Run tests to verify they fail**

```bash
npx tsx --test src/core/receiver-brief.test.ts
```

Expected: 6 failures (file not found).

**Step 3: Implement `src/core/receiver-brief.ts`**

Top of the file — types mirroring `handoff-builder.ts`:

```typescript
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentId } from "../adapters/index.js";

export class CancelledError extends Error {
  constructor() { super("Cancelled."); this.name = "CancelledError"; }
}

export interface Prompter {
  intro(msg: string): void;
  outro(msg: string): void;
  cancel(msg: string): void;
  note(msg: string, title?: string): void;
  log: { warn(msg: string): void; info(msg: string): void };
  spinner(): { start(msg: string): void; stop(msg: string): void };
  confirm(o: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<T>(o: { message: string; options: Array<{ value: T; label: string }> }): Promise<T>;
  text(o: { message: string }): Promise<string>;
  password(o: { message: string }): Promise<string>;
}

export interface ReceiverBriefDeps {
  prompter: Prompter;
  receiverGeminiAvailable: () => boolean;
  distillToHtmlAndMarkdown: (decrypted: string, agentId: AgentId) => Promise<{ markdown: string; html: string }>;
  openInBrowser: (path: string) => Promise<void>;
  resolveCwd: () => string;
  resolveTmpdir: () => string;
}

export interface BuildReceiverBriefArgs {
  decrypted: string;
  userRequest: string;
  deps: ReceiverBriefDeps;
}

export interface ReceiverBriefResult {
  targetAgent: AgentId;
  markdown: string;
  htmlPath?: string;
  spawnInjection: { bin: string; args: string[] } | null;
}
```

Main function:

```typescript
const AGENT_OPTIONS: Array<{ value: AgentId; label: string }> = [
  { value: "pi", label: "Pi" },
  { value: "claude", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
];

export async function buildReceiverBrief(args: BuildReceiverBriefArgs): Promise<ReceiverBriefResult> {
  const { decrypted, deps } = args;
  const p = deps.prompter;
  const cwd = deps.resolveCwd();
  const tmp = deps.resolveTmpdir();

  // 1. Pick the target agent.
  const choice = await p.select({
    message: "Which coding agent to hand off to?",
    options: AGENT_OPTIONS,
  });
  if (isCancelValue(choice)) throw new CancelledError();
  const targetAgent = choice as AgentId;

  // 2. Decide markdown source.
  let markdown = decrypted;
  let html: string | undefined;
  if (deps.receiverGeminiAvailable()) {
    const render = await p.confirm({
      message: "Render an HTML preview with Gemini?",
      initialValue: true,
    });
    if (isCancelValue(render)) throw new CancelledError();
    if (render) {
      const spin = p.spinner();
      spin.start("Rendering with Gemini");
      try {
        const out = await deps.distillToHtmlAndMarkdown(decrypted, targetAgent);
        markdown = out.markdown;
        html = out.html;
        spin.stop("Rendered.");
      } catch (err) {
        spin.stop("Gemini render failed — using decrypted markdown verbatim.");
        p.log.warn((err as Error).message);
      }
    }
  }

  // 3. Write the markdown to the agent folder.
  const agentDir = join(cwd, `.${targetAgent}`);
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  const targetPath = join(agentDir, "handoff.md");

  if (existsSync(targetPath)) {
    const overwrite = await p.confirm({
      message: `handoff.md already exists in .${targetAgent}/. Overwrite?`,
      initialValue: false,
    });
    if (isCancelValue(overwrite)) throw new CancelledError();
    if (!overwrite) {
      return { targetAgent, markdown, spawnInjection: null };
    }
  }

  writeFileSync(targetPath, markdown, "utf8");
  p.note(targetPath, "Wrote handoff");

  // 4. Optionally open the HTML.
  let htmlPath: string | undefined;
  if (html) {
    htmlPath = join(tmp, `handoff-${Date.now()}.html`);
    writeFileSync(htmlPath, html, "utf8");
    try {
      await deps.openInBrowser(htmlPath);
    } catch (err) {
      p.note(`Open this file in your browser to review:\n${htmlPath}`, "HTML preview");
    }
  }

  // 5. Confirm injection.
  const inject = await p.confirm({
    message: `Launch ${targetAgent} with this handoff injected?`,
    initialValue: true,
  });
  if (isCancelValue(inject)) throw new CancelledError();

  return {
    targetAgent,
    markdown,
    htmlPath,
    spawnInjection: inject
      ? { bin: targetAgent, args: [buildInjection(markdown, args.userRequest)] }
      : null,
  };
}

function buildInjection(markdown: string, userRequest: string): string {
  const preamble = `SYSTEM CONTEXT INJECTION:\nYou are resuming a task. You have been provided with an Context Handoff Document.\nRead it carefully. Do not repeat "Completed Steps". Avoid "Failed Approaches".\nAcknowledge the "Current State" and immediately begin working on the "Next Steps".`;
  const req = userRequest.trim() || "Continue the work described above.";
  return `${preamble}\n\n${markdown}\n\nUSER REQUEST:\n${req}`;
}

function isCancelValue(v: unknown): boolean {
  return typeof v === "string" && v === "clack:cancel";
}
```

**Step 4: Run tests to verify they pass**

```bash
npx tsx --test src/core/receiver-brief.test.ts
```

Expected: 6 tests pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(receiver): post-decryption brief flow — agent pick, file drop, optional HTML, injection confirm"
```

---

## Task 5: Refactor `commands/receive.ts` to a Thin Shell

**Files:**
- Modify: `src/commands/receive.ts`
- Create: `src/commands/receive-command.test.ts` (or fold into existing test patterns)

**Step 1: Write the failing integration test**

Create `src/commands/receive-command.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReceive } from "./receive.js";
import type { AgentId } from "../adapters/index.js";

test("runReceive end-to-end writes handoff.md and returns the spawn args", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctx-handoff-e2e-"));
  process.env.GEMINI_API_KEY = "";  // force verbatim path
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.includes("/dl/")) {
      return new Response(JSON.stringify({
        salt: "AA==", iv: "BB==", ciphertext: "CC==",
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  // Stub crypto.decrypt and decodeLink for this test by importing the real
  // module and replacing one function. For brevity here, the test should
  // monkey-patch via the receiver-brief's deps seam — but receive.ts still
  // hard-couples. The test exercises receive.ts's happy path against a
  // mock transport. Skip this test until the seam is added in step 3.
});
```

(For brevity, the test scaffold above demonstrates the shape. In Task 5 step 3, after `runReceive` is refactored to take optional `deps` for testability, write the test that actually exercises the seam.)

**Step 2: Run tests to verify the scaffold fails**

```bash
npx tsx --test src/commands/receive-command.test.ts
```

Expected: at least one failure pointing to the missing seam.

**Step 3: Refactor `src/commands/receive.ts`**

Replace the file contents with:

```typescript
import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { decodeLink } from "../core/link.js";
import { downloadPayload } from "../core/transport.js";
import { decrypt } from "../core/crypto.js";
import { buildReceiverBrief, CancelledError, ReceiverBriefDeps } from "../core/receiver-brief.js";
import { distillToHtmlAndMarkdown, receiverGeminiAvailable } from "../core/receiver-prompts.js";
import { AgentId } from "../adapters/index.js";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { spawn as spawnChild } from "node:child_process";

export interface RunReceiveDeps {
  downloadPayload: (workerHost: string, id: string) => Promise<unknown>;
  decrypt: (payload: unknown, password: string) => string;
  buildReceiverBrief: typeof buildReceiverBrief;
  distillToHtmlAndMarkdown: typeof distillToHtmlAndMarkdown;
  receiverGeminiAvailable: () => boolean;
  openInBrowser: (path: string) => Promise<void>;
  spawnAgent: (bin: string, args: string[]) => Promise<number>;
}

export const defaultReceiveDeps: RunReceiveDeps = {
  downloadPayload: (workerHost, id) => downloadPayload(workerHost, id),
  decrypt: (payload, password) => decrypt(payload as never, password),
  buildReceiverBrief,
  distillToHtmlAndMarkdown,
  receiverGeminiAvailable,
  openInBrowser: async (path) => {
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
    await new Promise<void>((resolve, reject) => {
      const child = spawnChild(cmd, [path], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("spawn", () => { child.unref(); resolve(); });
    });
  },
  spawnAgent: (bin, args) => new Promise<number>((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write(`\nAgent '${bin}' not found. Is it installed and in your PATH?\n`);
        process.exitCode = 127;
      } else {
        process.stderr.write(`\nFailed to launch '${bin}': ${err.message}\n`);
        process.exitCode = 1;
      }
      resolve(process.exitCode ?? 1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  }),
};

export async function runReceive(
  rawLink: string,
  agentArgv: string[],
  deps: RunReceiveDeps = defaultReceiveDeps,
): Promise<void> {
  p.intro("ctx-handoff receive");
  if (agentArgv[0] === "--") agentArgv = agentArgv.slice(1);

  let link;
  try {
    link = decodeLink(rawLink);
  } catch (err) {
    p.cancel(String((err as Error).message));
    process.exitCode = 1;
    return;
  }

  const spin = p.spinner();
  spin.start("Downloading handoff");
  let payload;
  try {
    payload = await deps.downloadPayload(link.workerHost, link.id);
  } catch (err) {
    spin.stop("Download failed.");
    const msg = (err as Error).message;
    p.cancel(msg === "LINK_EXPIRED" ? "Link expired or invalid." : msg);
    process.exitCode = 1;
    return;
  }
  spin.stop("Downloaded.");

  const password = await p.password({ message: "Password:" });
  if (p.isCancel(password)) {
    p.cancel("Cancelled.");
    process.exitCode = 130;
    return;
  }

  let markdown: string;
  try {
    markdown = deps.decrypt(payload, password);
  } catch (err) {
    const msg = (err as Error).message;
    p.cancel(msg === "INVALID_PASSWORD" ? "Invalid password." : msg);
    process.exitCode = 1;
    return;
  }

  // Pull the leading agent command (if user passed one) and treat the rest
  // as the user request for the eventual injection.
  let userRequest: string;
  let preAgent: string | undefined;
  if (agentArgv.length > 0) {
    preAgent = agentArgv[0];
    userRequest = agentArgv.slice(1).filter((a) => !a.startsWith("-")).join(" ")
      || "Continue the work described above.";
  } else {
    userRequest = "Continue the work described above.";
  }

  const briefDeps: ReceiverBriefDeps = {
    prompter: clackPrompter,
    receiverGeminiAvailable: deps.receiverGeminiAvailable,
    distillToHtmlAndMarkdown: deps.distillToHtmlAndMarkdown,
    openInBrowser: deps.openInBrowser,
    resolveCwd: () => process.cwd(),
    resolveTmpdir: () => tmpdir(),
  };

  let result;
  try {
    result = await deps.buildReceiverBrief({
      decrypted: markdown,
      userRequest,
      deps: briefDeps,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      process.exitCode = 130;
      return;
    }
    p.cancel((err as Error).message);
    process.exitCode = 1;
    return;
  }

  p.outro(
    preAgent
      ? `Wrote handoff to .${result.targetAgent}/handoff.md. To launch ${preAgent}, start it manually — it will read the file.`
      : `Done. Files written.`,
  );

  // If the user provided a leading agent on the CLI, spawn it with the injection
  // so the existing `ctx-handoff receive <link> -- pi "continue"` flow keeps working.
  if (preAgent) {
    await deps.spawnAgent(preAgent, [result.spawnInjection?.args[0] ?? markdown]);
  } else if (result.spawnInjection) {
    await deps.spawnAgent(result.spawnInjection.bin, result.spawnInjection.args);
  }
}

const clackPrompter: never = undefined as never;  // see below

// We need a real Prompter adapter for receiver-brief. Inline it here to avoid
// pulling in handoff-builder.ts's adapter (which has spinner/select casts that
// don't fit the new minimal Prompter interface).
```

**Important:** the `clackPrompter` cast above is a placeholder. The actual adapter must be implemented inline in this file by mapping `@clack/prompts` calls to the minimal `Prompter` interface from `receiver-brief.ts`. The `harness-builder.ts` adapter (`clackPrompter` in `commands/send.ts`) won't fit because it implements the wider `HandoffBuilderDeps.Prompter`.

Implement it as:

```typescript
const clackPrompter: Prompter = {
  intro: (m) => p.intro(m),
  outro: (m) => p.outro(m),
  cancel: (m) => p.cancel(m),
  note: (m, t) => p.note(m, t),
  log: { warn: p.log.warn, info: p.log.info },
  spinner: () => {
    const s = p.spinner();
    return { start: (m) => s.start(m), stop: (m) => s.stop(m) };
  },
  confirm: (o) => p.confirm(o) as Promise<boolean>,
  select: (o) => p.select(o as never) as Promise<never>,
  text: (o) => p.text(o) as Promise<string>,
  password: (o) => p.password(o) as Promise<string>,
};
```

**Step 4: Build and run the full test suite**

```bash
npx tsc -p tsconfig.json --noEmit
npm test
```

Expected: 0 type errors. All previous tests + new tests pass.

**Step 5: Smoke test the binary**

```bash
npx tsx src/index.ts send --help
npx tsx src/index.ts receive --help
```

Expected: both commands print help. Note: `export` is gone, `send` is present.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(receive): thin shell delegating to receiver-brief module"
```

---

## Task 6: Manual Smoke Test

**Step 1: Generate a real send link**

```bash
export GEMINI_API_KEY=...
export CTX_HANDOFF_WORKER=your-project.deno.net
npm run dev -- send
```

Expected: pick an agent, pick a session, watch Gemini distill, get a `ctx-handoff://` link.

**Step 2: Receive the link with a real agent**

```bash
cd /tmp/some-test-project
npm run dev -- receive 'ctx-handoff://...' -- claude "continue"
```

Expected: with `GEMINI_API_KEY` set, the HTML preview opens; with it unset, only the markdown is written. The file lands in `.claude/handoff.md`. The claude agent launches with the brief injected.

**Step 3: Verify the dropped file**

```bash
ls -la .claude/handoff.md
cat .claude/handoff.md
```

Expected: the brief is there, dense and well-structured.

**Step 4: Commit any final touches**

```bash
git status
git add -A  # only if there are real changes
git commit -m "chore: post-smoke cleanup" --allow-empty
```

---

## Out of Scope

- Persisting handoffs across reboots (HTML is intentionally ephemeral in `$TMPDIR`).
- Sharing handoff files via git (the receiver's `.claude/handoff.md` is theirs alone — let them add to `.gitignore` as they see fit).
- Auto-launching the picked agent on file drop (the explicit confirmation step is intentional).
- A `--no-html` CLI flag (the in-TUI confirm is enough; YAGNI).
- Renaming the bin (`ctx-handoff`) or the package.
