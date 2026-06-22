import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AgentId } from "../adapters/index.js";
import { DistillResult } from "./receiver-prompts.js";

/**
 * Post-decryption TUI flow for the receiver. Mirrors the shape of
 * `handoff-builder.ts` — a single `buildReceiverBrief` function with a
 * `Prompter` interface and dependency-injected IO seams. The command shell
 * (`commands/receive.ts`) is responsible for downloading, decrypting, and
 * spawning the agent; this module owns "what to do with the decrypted brief."
 */

export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "CancelledError";
  }
}

export interface Spinner {
  start(msg: string): void;
  stop(msg: string): void;
}

export interface Prompter {
  intro(msg: string): void;
  outro(msg: string): void;
  cancel(msg: string): void;
  note(msg: string, title?: string): void;
  log: { warn(msg: string): void; info(msg: string): void };
  spinner(): Spinner;
  confirm(o: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<T>(o: { message: string; options: Array<{ value: T; label: string }> }): Promise<T>;
  text(o: { message: string }): Promise<string>;
  password(o: { message: string }): Promise<string>;
}

export interface ReceiverBriefDeps {
  prompter: Prompter;
  receiverGeminiAvailable: () => boolean;
  distillToHtmlAndMarkdown: (decrypted: string, agentId: AgentId) => Promise<DistillResult>;
  openInBrowser: (path: string) => Promise<void>;
  resolveCwd: () => string;
  resolveTmpdir: () => string;
  /** Injected so tests can pin the HTML filename deterministically. */
  now: () => number;
}

export interface BuildReceiverBriefArgs {
  decrypted: string;
  userRequest: string;
  /**
   * Pre-picked target agent. When set, the TUI agent picker is skipped and
   * the file lands in `.<presetAgent>/handoff.md`. Lets the existing
   * `ctx-handoff receive <link> -- <agent> "request"` CLI flow keep working.
   */
  presetAgent?: AgentId;
  deps: ReceiverBriefDeps;
}

export interface ReceiverBriefResult {
  targetAgent: AgentId;
  markdown: string;
  htmlPath?: string;
  /** When set, the caller should spawn `bin` with the single arg in `args[0]`. */
  spawnInjection: { bin: string; args: string[] } | null;
}

const AGENT_OPTIONS: Array<{ value: AgentId; label: string }> = [
  { value: "pi", label: "Pi" },
  { value: "claude", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
];

export async function buildReceiverBrief(
  args: BuildReceiverBriefArgs,
): Promise<ReceiverBriefResult> {
  const { decrypted, userRequest, presetAgent, deps } = args;
  const p = deps.prompter;
  const cwd = deps.resolveCwd();
  const tmp = deps.resolveTmpdir();

  // 1. Pick the target agent (or use the preset from the CLI).
  let targetAgent: AgentId;
  if (presetAgent) {
    targetAgent = presetAgent;
  } else {
    const choice = await p.select({
      message: "Which coding agent to hand off to?",
      options: AGENT_OPTIONS,
    });
    if (isCancelValue(choice)) throw new CancelledError();
    targetAgent = choice as AgentId;
  }

  // 2. Decide markdown source. Verbatim unless the user opts into Gemini
  // rendering (and a key is set). Failures degrade to verbatim.
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
      // User declined — return the result we have but don't spawn.
      return { targetAgent, markdown, spawnInjection: null };
    }
  }

  writeFileSync(targetPath, markdown, "utf8");
  p.note(targetPath, "Wrote handoff");

  // 4. Optionally write + open the HTML.
  let htmlPath: string | undefined;
  if (html) {
    htmlPath = join(tmp, `handoff-${deps.now()}.html`);
    writeFileSync(htmlPath, html, "utf8");
    try {
      await deps.openInBrowser(htmlPath);
    } catch {
      p.note(
        `Open this file in your browser to review:\n${htmlPath}`,
        "HTML preview",
      );
    }
  }

  // 5. Confirm injection.
  const inject = await p.confirm({
    message: `Launch ${targetAgent} with this handoff injected?`,
    initialValue: true,
  });
  if (isCancelValue(inject)) throw new CancelledError();

  if (!inject) {
    return { targetAgent, markdown, htmlPath, spawnInjection: null };
  }

  const injection = buildInjection(markdown, userRequest);
  return {
    targetAgent,
    markdown,
    htmlPath,
    spawnInjection: { bin: targetAgent, args: [injection] },
  };
}

function buildInjection(markdown: string, userRequest: string): string {
  const preamble =
    `SYSTEM CONTEXT INJECTION:\n` +
    `You are resuming a task. You have been provided with a Context Handoff Document ` +
    `written as a verbose Markdown brief — structure, headings, and section names are ` +
    `decided by the sender, not by a fixed schema. Read the brief carefully and ` +
    `continue the work.`;
  const req = userRequest.trim() || "Continue the work described above.";
  return `${preamble}\n\n${markdown}\n\nUSER REQUEST:\n${req}`;
}

function isCancelValue(v: unknown): boolean {
  return typeof v === "string" && v === "clack:cancel";
}
