import { SessionMessage, SessionRef } from "../adapters/types.js";

/**
 * Optional Gemini pass that distills a raw session into a verbose Markdown
 * handoff brief, so the sender ships a dense document instead of noisy chat
 * logs. Uses Google's OpenAI-compatible Chat Completions endpoint, so no SDK
 * is needed — just Node's built-in fetch.
 *
 * The output is free-form Markdown with no fixed schema. Gemini decides the
 * structure; the model is told to preserve paths, commands, errors, and
 * identifiers verbatim.
 */
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const DEFAULT_MODEL = "gemini-2.5-flash";

export const SYSTEM_PROMPT = `You are writing a verbose handoff brief for another developer's AI coding agent. The
input is a full session transcript (one or more merged sessions, separated by
\`### === SESSION n: <title> (N msgs) ===\` markers). Tool calls, thinking, and chat
mechanics are already filtered out — what you see is the substance.

Write a long-form Markdown brief. Begin directly with the brief itself — do not
wrap in JSON, do not add a preamble.

Goal: the receiving agent should finish reading with the same mental model the
sender had — not just WHAT exists, but WHY it is the way it is, what was already
ruled out, and what is still open. Reconstruct the sender's reasoning from the
transcript; do not flatten the session into a list of facts.

Structure:
- Open with a short paragraph in the user's own words describing the original
  task or goal. Quote the first user message verbatim when it is concise.
- Then write detailed sections, in whatever order fits the work: what was tried,
  what worked, what errored (with exact error messages in code fences), the
  current state with file paths and exact identifiers, a concrete list of next
  steps.
- Reconstruct the DECISIONS and their rationale: for each meaningful choice,
  state what was chosen and WHY, and which alternatives were considered. Capture
  how the approach evolved across the back-and-forth — course-corrections, user
  feedback that changed direction, and assumptions that were revised.
- Call out DEAD ENDS explicitly: approaches that were tried and abandoned, and
  the reason they failed, so the receiver does not repeat them. Make current
  BLOCKERS and open questions unmistakable.
- Use \`##\` for major sections and \`###\` for sub-topics when the session covers
  multiple distinct threads. When the session is a single coherent thread, omit
  the sub-headers.
- Use code fences (triple backticks) for paths, commands, error messages, file
  contents, and any verbatim technical detail. Use inline backticks for
  identifiers, function names, and short snippets.

Preservation rules:
- Preserve file paths verbatim. Do not paraphrase \`src/core/foo.ts\` into "the
  foo module".
- Preserve command invocations verbatim, including flags and arguments. Do not
  paraphrase \`npm run dev -- send --agent claude\` into "we ran the send
  command".
- Preserve error messages verbatim. Do not paraphrase "ENOENT: no such file or
  directory" into "a missing-file error".
- Preserve identifiers verbatim. Do not paraphrase function or variable names.
- Preserve ticket numbers, PR numbers, commit hashes, and URLs verbatim.

Length:
- Be verbose. The receiving agent needs enough detail to continue without
  re-reading the source session. A short task may produce a 300-word brief; a
  complex multi-session task may produce 2000 words or more.

What to exclude:
- Do not summarize tool calls or thinking.
- Do not include pleasantries, "I will now…", "Let me…", or other chat
  mechanics.
- Do not add meta-commentary like "The user asked…". Quote the user directly.

Output ONLY the brief. No JSON, no commentary, no preamble.`;

export function geminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Build the user-prompt transcript from the merged messages and the sessions
 * they came from. Inserts `### === SESSION n: <title> (N msgs) ===` markers
 * before each session's block so Gemini can detect topic boundaries.
 */
export function buildTranscript(messages: SessionMessage[], sessions: SessionRef[]): string {
  if (messages.length === 0 || sessions.length === 0) return "";
  // Walk sessions in mtime order, attributing ranges by message count.
  const ordered = [...sessions].sort((a, b) => a.mtime - b.mtime);
  const blocks: string[] = [];
  let cursor = 0;
  ordered.forEach((s, i) => {
    const count = s.messageCount ?? 0;
    const slice = messages.slice(cursor, cursor + count);
    cursor += count;
    const header = `### === SESSION ${i + 1}: ${s.title} (${count} msgs) ===`;
    const body = slice.map((m) => `### ${m.role.toUpperCase()}\n${m.content.trim()}`).join("\n\n");
    blocks.push(body ? `${header}\n${body}` : header);
  });
  return blocks.join("\n\n");
}

/**
 * Distill a raw session into a verbose Markdown handoff brief via Gemini.
 * Returns the raw markdown string; no JSON parsing, no schema validation.
 */
export async function distillSession(
  messages: SessionMessage[],
  sessions: SessionRef[] = [],
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const transcript =
    sessions.length > 0
      ? buildTranscript(messages, sessions)
      : messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content.trim()}`).join("\n\n");

  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Distill this session:\n\n${transcript}` },
      ],
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

  return content;
}
