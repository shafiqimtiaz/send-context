import { jsonrepair } from "jsonrepair";
import { SessionMessage, SessionRef } from "../adapters/types.js";
import { HandoffSections } from "./formatter.js";

/**
 * Optional Gemini pass that distills a raw session into the structured
 * Context Handoff sections, so the sender ships a dense brief instead of
 * noisy chat logs. Uses Google's OpenAI-compatible Chat Completions endpoint,
 * so no SDK is needed — just Node's built-in fetch.
 */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const DEFAULT_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `You distill one or more AI coding-agent sessions into a dense handoff brief for another developer's agent. The input is a single transcript with one or more session blocks separated by '### === SESSION n: <title> (N msgs) ===' markers. Strip conversational noise; keep only what the receiving agent needs to continue. Be concrete and terse.

The merged sessions may cover a single coherent thread OR multiple distinct topics. Detect which it is. When the sessions cover 2+ distinct topics, populate "topics" with the topic names (in order of appearance) and structure the five narrative fields so each topic's content is grouped under a '### <Topic>' sub-header. When the sessions are a single coherent thread, omit "topics" and write the fields as a single thread.

Respond with ONLY a JSON object of this exact shape:
{
  "topics": ["topic name 1", "topic name 2"],
  "objective": "the primary goal, one or two sentences — composite when topics is present",
  "currentState": "where things stand right now and any blockers — composite when topics is present",
  "completedSteps": "what is already done — one '-' bullet per line, optionally grouped by '### <Topic>'",
  "failedApproaches": "approaches that were tried and did not work and must not be retried — '-' bullets, or 'None.'",
  "nextSteps": "the concrete next actions the receiving agent should take — '-' bullets, optionally grouped by '### <Topic>'"
}

Leave a field as an empty string only when the session genuinely lacks that information. Omit "topics" (or set it to []) when the sessions are a single coherent thread.`;

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
    const body = slice
      .map((m) => `### ${m.role.toUpperCase()}\n${m.content.trim()}`)
      .join("\n\n");
    blocks.push(body ? `${header}\n${body}` : header);
  });
  return blocks.join("\n\n");
}

export async function distillSession(
  messages: SessionMessage[],
  sessions: SessionRef[] = [],
): Promise<HandoffSections> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const transcript = sessions.length > 0
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

  return parseSections(content);
}

export function parseSections(content: string): HandoffSections {
  const obj = JSON.parse(extractJson(content)) as Partial<HandoffSections>;
  return {
    objective: str(obj.objective),
    currentState: str(obj.currentState),
    completedSteps: str(obj.completedSteps),
    failedApproaches: str(obj.failedApproaches),
    nextSteps: str(obj.nextSteps),
    topics: Array.isArray(obj.topics) ? obj.topics.map((t) => str(t)).filter((t) => t.length > 0) : undefined,
  };
}

// Exported for unit testing.
export const __test__ = { parseSections };

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : content;

  // Isolate the JSON from any surrounding prose, then let jsonrepair fix the
  // common ways models still mangle it: trailing commas, single quotes,
  // unquoted keys, truncation (missing closing brackets), and so on.
  const start = body.indexOf("{");
  const candidate =
    start === -1 ? body : (firstBalancedObject(body) ?? body.slice(start));
  return jsonrepair(candidate);
}

// Return the first brace-balanced JSON object, ignoring any prose or extra
// objects the model appends after it (thinking models often do). Tracks string
// literals and escapes so braces inside strings don't throw off the depth count.
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
