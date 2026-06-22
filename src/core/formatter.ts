import { SessionMessage } from "../adapters/types.js";

/**
 * A dynamic, free-form Markdown brief produced by the sender's Gemini
 * distillation. There is no fixed schema — Gemini decides the structure,
 * subject to the distiller's system prompt. The brief is passed through
 * the formatter verbatim (preamble and appendix are added around it).
 */
export interface HandoffMarkdown {
  markdown: string;
}

export interface HandoffInput {
  sourceAgent: string;
  timestamp: string;
  /**
   * The sender's verbose Markdown brief (Gemini output). Passed through
   * the formatter verbatim. May be empty, in which case the preamble and
   * appendix still render around nothing.
   */
  markdown: string;
  /** Messages the sender curated for the Raw Context Appendix. */
  appendix: SessionMessage[];
  /**
   * Full message list, used only to derive the original-task line in the
   * preamble (the first non-empty user message, truncated to 200 chars).
   */
  allMessages: SessionMessage[];
}

const NOT_SPECIFIED = "_Not specified by sender._";

export function formatToHandoffSkill(input: HandoffInput): string {
  const { sourceAgent, timestamp, appendix, allMessages, markdown } = input;

  const firstUser = allMessages.find((m) => m.role === "user")?.content ?? "";
  const originalTask = firstLine(firstUser) || NOT_SPECIFIED;

  const out: string[] = [
    `# Context Handoff`,
    `**Source Agent:** ${sourceAgent}`,
    `**Timestamp:** ${timestamp}`,
    `**Original Task:** ${originalTask}`,
    ``,
  ];

  // The sender's dynamic brief — verbatim. No fixed section structure.
  if (markdown) {
    out.push(markdown.trim(), ``);
  }

  out.push(`## Raw Context Appendix`, renderAppendix(appendix), ``);

  return out.join("\n");
}

function renderAppendix(messages: SessionMessage[]): string {
  if (messages.length === 0) return "_No raw context included._";
  return messages
    .map((m) => {
      const label = m.role.toUpperCase();
      return `### ${label}\n\n${m.content.trim()}`;
    })
    .join("\n\n---\n\n");
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
