import { AgentAdapter, SessionMessage, SessionRef } from "../adapters/types.js";
import { AgentId } from "../adapters/index.js";
import { EncryptedPayload } from "./crypto.js";
import { encodeLink, HandoffLink } from "./link.js";
import { encodePayload } from "./wire.js";

/**
 * The handoff-construction pipeline, extracted from commands/send.ts so it
 * can be exercised without a TTY, with a scripted Prompter, or by another
 * caller (e.g. a future `ctx-handoff doctor`).
 *
 * The module knows nothing about process.env, @clack/prompts, or process.exit.
 * The CLI shell is responsible for those concerns.
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
  select<T>(opts: { message: string; options: Array<{ value: T; label: string }> }): Promise<T>;
  multiselect<T>(opts: {
    message: string;
    options: Array<{ value: T; label: string }>;
    initialValues?: T[];
    required?: boolean;
    maxItems?: number;
  }): Promise<T[]>;
  text(opts: { message: string; placeholder?: string }): Promise<string>;
  password(opts: {
    message: string;
    validate?: (v: string) => string | undefined;
  }): Promise<string>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
}

export interface HandoffBuilderDeps {
  prompter: Prompter;
  detectAgents: (cwd: string) => AgentId[];
  createAdapter: (id: AgentId, cwd?: string) => AgentAdapter;
  encrypt: (plaintext: string, password: string) => EncryptedPayload;
  uploadPayload: (workerHost: string, payload: EncryptedPayload) => Promise<string>;
  encodeLink: (link: HandoffLink) => string;
  geminiAvailable: () => boolean;
  /**
   * Distill the merged messages into a verbose Markdown handoff brief.
   * Returns the raw markdown string. There is no fixed schema; the model
   * decides the structure.
   */
  distillSession: (messages: SessionMessage[], sessions: SessionRef[]) => Promise<string>;
  formatToHandoffSkill: (input: {
    sourceAgent: string;
    timestamp: string;
    appendix: SessionMessage[];
    allMessages: SessionMessage[];
    markdown: string;
  }) => string;
  isStdoutTty: boolean;
}

export interface BuildHandoffArgs {
  workerHost: string;
  /** Optional. If omitted, the builder prompts for one (interactively). */
  password?: string;
  presetAgent?: AgentId;
  cwd: string;
  deps: HandoffBuilderDeps;
}

export interface BuildHandoffResult {
  link: string;
  /** Which branch produced the brief. Useful for tests and CLI summary. */
  source: "distilled" | "manual";
}

const APPENDIX_DEFAULT_RECENT = 10;

// Cap on visible rows in scrollable pickers. Without it, clack renders every
// option at once; a list taller than the terminal corrupts the in-place
// redraw and spams scrollback. maxItems windows the list into a fixed viewport.
const PICKER_MAX_ITEMS = 12;

export async function buildHandoff(args: BuildHandoffArgs): Promise<BuildHandoffResult> {
  const { workerHost, presetAgent, cwd, deps } = args;
  const p = deps.prompter;
  p.intro("ctx-handoff send");

  // 1. Pick the agent.
  const agentId = await resolveAgent(presetAgent, cwd, deps);
  const adapter = deps.createAdapter(agentId, cwd);

  // 2. Pick the session(s).
  const spin = p.spinner();
  spin.start(`Listing sessions from ${adapter.getName()}`);
  let sessions: SessionRef[];
  try {
    sessions = await adapter.listSessions();
  } catch (err) {
    spin.stop("Listing failed.");
    throw new Error((err as Error).message);
  }
  spin.stop(`Found ${sessions.length} session(s).`);

  if (sessions.length === 0) {
    p.cancel("No sessions found to hand off.");
    throw new Error("No sessions found to hand off.");
  }

  const chosen = await chooseSessions(sessions, p, deps.isStdoutTty);

  // 3. Extract messages.
  spin.start(`Extracting ${chosen.length} session(s)`);
  let messages: SessionMessage[];
  try {
    messages = await extractMerged(adapter, chosen);
  } catch (err) {
    spin.stop("Extraction failed.");
    throw new Error((err as Error).message);
  }
  spin.stop(`Extracted ${messages.length} messages from ${chosen.length} session(s).`);

  if (messages.length === 0) {
    p.cancel("Selected session(s) have no messages to hand off.");
    throw new Error("Selected session(s) have no messages to hand off.");
  }

  // 4. Build the brief: distill if available, otherwise manual curation.
  let markdown: string;
  let appendix: SessionMessage[];
  let source: BuildHandoffResult["source"];

  if (deps.geminiAvailable()) {
    spin.start("Distilling session with Gemini");
    try {
      markdown = await deps.distillSession(messages, chosen);
      // Auto-attach the most recent messages so the receiver can drill into
      // the literal back-and-forth that the distilled prose summarizes. The
      // distill path stays prompt-free; the manual path curates interactively.
      appendix = messages.slice(-APPENDIX_DEFAULT_RECENT);
      source = "distilled";
      spin.stop("Distilled into a handoff brief.");
    } catch (err) {
      spin.stop("Distillation failed — falling back to manual.");
      p.log.warn((err as Error).message);
      ({ markdown, appendix } = await runManual(messages, p));
      source = "manual";
    }
  } else {
    ({ markdown, appendix } = await runManual(messages, p));
    source = "manual";
  }

  // 5. Render and encrypt.
  const rendered = deps.formatToHandoffSkill({
    sourceAgent: adapter.getName(),
    timestamp: new Date().toISOString(),
    allMessages: messages,
    appendix,
    markdown,
  });

  // 5b. Wrap in the v2 wire-format envelope. The payload that goes onto the
  // wire is a JSON object with version + source metadata + the rendered
  // Markdown. Older v1 payloads (bare Markdown) are no longer accepted.
  const capturedAt = new Date().toISOString();
  const envelope = encodePayload({
    sourceAgent: adapter.getName(),
    timestamp: capturedAt,
    markdown: rendered,
    ...(appendix.length > 0 ? { appendix } : {}),
  });

  const password = await resolvePassword(args.password, p);
  const payload = deps.encrypt(envelope, password);

  // 6. Upload and emit link.
  spin.start("Uploading encrypted handoff");
  let id: string;
  try {
    id = await deps.uploadPayload(workerHost, payload);
  } catch (err) {
    spin.stop("Upload failed.");
    throw new Error((err as Error).message);
  }
  spin.stop("Uploaded.");

  const link = deps.encodeLink({ workerHost, id });
  p.note(link, "Share this link (expires in 24h)");
  p.log.info("Share the password separately — the receiver is prompted for it.");
  p.outro("Done.");
  return { link, source };
}

// ----- helpers -------------------------------------------------------------

async function resolveAgent(
  preset: AgentId | undefined,
  cwd: string,
  deps: HandoffBuilderDeps,
): Promise<AgentId> {
  if (preset) return preset;

  const detected = deps.detectAgents(cwd);
  if (detected.length === 0) {
    deps.prompter.cancel("No agent session detected here. Use --agent <pi|claude|opencode>.");
    throw new Error("No agent session detected.");
  }
  if (detected.length === 1) return detected[0];

  const choice = await deps.prompter.select({
    message: "Which agent session to hand off?",
    options: detected.map((id) => ({ value: id, label: id })),
  });
  if (isCancelValue(choice)) throw new CancelledError();
  return choice as AgentId;
}

async function chooseSessions(
  sessions: SessionRef[],
  p: Prompter,
  isStdoutTty: boolean,
): Promise<SessionRef[]> {
  // Single session, or non-interactive → newest only.
  if (sessions.length === 1 || !isStdoutTty) {
    return [sessions[0]];
  }

  const selected = await p.multiselect({
    message: "Select sessions to hand off (newest pre-checked):",
    options: sessions.map((s) => ({
      value: s.id,
      label: s.messageCount != null ? `${s.title} (${s.messageCount} msgs)` : s.title,
    })),
    initialValues: [sessions[0].id],
    required: true,
    maxItems: PICKER_MAX_ITEMS,
  });
  if (isCancelValue(selected)) throw new CancelledError();
  const ids = new Set(selected as string[]);
  return sessions.filter((s) => ids.has(s.id));
}

async function extractMerged(
  adapter: AgentAdapter,
  chosen: SessionRef[],
): Promise<SessionMessage[]> {
  const ordered = [...chosen].sort((a, b) => a.mtime - b.mtime);
  const messages: SessionMessage[] = [];
  for (const ref of ordered) {
    messages.push(...(await adapter.extractSession(ref.id)));
  }
  return messages;
}

interface ManualSections {
  objective?: string;
  currentState?: string;
  completedSteps?: string;
  failedApproaches?: string;
  nextSteps?: string;
}

async function runManual(
  messages: SessionMessage[],
  p: Prompter,
): Promise<{ markdown: string; appendix: SessionMessage[] }> {
  const sections = await promptSections(p);
  const appendix = await curateAppendix(messages, p);
  // The manual flow is the legacy 5-field fallback for when Gemini is
  // unavailable. Render those fields into a fixed-schema Markdown body so
  // the formatter has something to wrap the preamble + appendix around.
  const markdown = renderLegacySections(sections);
  return { markdown, appendix };
}

async function promptSections(p: Prompter): Promise<ManualSections> {
  const wants = await p.confirm({
    message: "Add a written summary (objective, blockers, next steps)? Recommended.",
    initialValue: true,
  });
  if (isCancelValue(wants)) throw new CancelledError();
  if (!wants) return {};

  const fields: Array<[keyof ManualSections, string]> = [
    ["objective", "Primary objective"],
    ["currentState", "Current state & blockers"],
    ["completedSteps", "Completed steps (one per line)"],
    ["failedApproaches", "Failed approaches — do not retry"],
    ["nextSteps", "Next steps for the receiver"],
  ];

  const sections: ManualSections = {};
  for (const [key, label] of fields) {
    const value = await p.text({ message: label, placeholder: "(optional, Enter to skip)" });
    if (isCancelValue(value)) throw new CancelledError();
    if (value.trim()) sections[key] = value.trim();
  }
  return sections;
}

function renderLegacySections(sections: ManualSections): string {
  const NOT_SPECIFIED = "_Not specified by sender._";
  const out: string[] = [];
  const objective = sections.objective?.trim() || NOT_SPECIFIED;
  const currentState = sections.currentState?.trim() || NOT_SPECIFIED;
  const completedSteps = sections.completedSteps?.trim() || NOT_SPECIFIED;
  const failedApproaches = sections.failedApproaches?.trim() || NOT_SPECIFIED;
  const nextSteps = sections.nextSteps?.trim() || NOT_SPECIFIED;
  out.push(
    `## 1. Primary Objective`,
    objective,
    ``,
    `## 2. Current State & Blockers`,
    currentState,
    ``,
    `## 3. Completed Steps`,
    completedSteps,
    ``,
    `## 4. Failed Approaches (Do Not Retry)`,
    failedApproaches,
    ``,
    `## 5. Next Steps`,
    nextSteps,
    ``,
  );
  return out.join("\n");
}

async function curateAppendix(messages: SessionMessage[], p: Prompter): Promise<SessionMessage[]> {
  const recentFrom = Math.max(0, messages.length - APPENDIX_DEFAULT_RECENT);
  const options = messages.map((m, i) => ({
    value: i,
    label: `[${m.role}] ${preview(m.content)}`,
  }));

  const selected = await p.multiselect({
    message: "Select messages for the Raw Context Appendix (space to toggle):",
    options,
    initialValues: options.slice(recentFrom).map((o) => o.value),
    required: false,
    maxItems: PICKER_MAX_ITEMS,
  });
  if (isCancelValue(selected)) throw new CancelledError();
  return (selected as number[]).map((i) => messages[i]);
}

async function resolvePassword(preset: string | undefined, p: Prompter): Promise<string> {
  if (preset !== undefined) {
    if (preset.length < 4) {
      p.cancel("Password must be at least 4 characters.");
      throw new Error("Password must be at least 4 characters.");
    }
    return preset;
  }
  const password = await p.password({
    message: "Set a password (the receiver needs it to decrypt):",
    validate: (v) => (v.length < 4 ? "Use at least 4 characters." : undefined),
  });
  if (isCancelValue(password)) throw new CancelledError();
  return password;
}

function preview(content: string): string {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function isCancelValue(v: unknown): boolean {
  return typeof v === "string" && v === "clack:cancel";
}
