/**
 * A single message in a coding-agent session.
 *
 * `content` is the rendered text after adapter-side processing. By contract
 * tool calls (and any equivalent in the agent's native format) are NOT
 * represented in `content` — adapters must drop them before returning. This
 * keeps noise out of the distillation pipeline and out of the wire payload.
 */
export interface SessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** A selectable session in the agent's store, used to build the picker. */
export interface SessionRef {
  /** Stable id used to extract this session (jsonl filename stem or ses_… id). */
  id: string;
  /** Short preview of the first user message, for display. */
  title: string;
  /** Sort key — real mtime (ms) where available, else a descending index. */
  mtime: number;
  /** Message count, when known without a full extraction. */
  messageCount?: number;
}

export interface AgentAdapter {
  /** Human-readable agent name, e.g. "Pi" or "Claude Code". */
  getName(): string;
  /** List this project's sessions, newest first. */
  listSessions(): Promise<SessionRef[]>;
  /**
   * Extract a session as an ordered message list. With no id, extracts the
   * most-recent session (back-compat). Throws AgentNotFoundError if the
   * underlying binary is missing.
   */
  extractSession(id?: string): Promise<SessionMessage[]>;
}

export class AgentNotFoundError extends Error {
  constructor(public readonly binary: string) {
    super(
      `Agent '${binary}' not found. Is it installed and in your PATH?`,
    );
    this.name = "AgentNotFoundError";
  }
}
