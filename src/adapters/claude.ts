import { join } from "node:path";
import { existsSync } from "node:fs";
import { AgentAdapter, SessionMessage, SessionRef } from "./types.js";
import { CLAUDE_PROJECTS_ROOT, claudeSlug } from "../core/paths.js";
import {
  listJsonl,
  readJsonl,
  sessionTitle,
} from "../core/session-store.js";

/**
 * Claude Code adapter.
 *
 * Claude Code has no stdout JSON session dump either; sessions live as
 * documented JSONL files at ~/.claude/projects/<slug>/<id>.jsonl. We read the
 * latest one for the current project directory.
 */
export class ClaudeAdapter implements AgentAdapter {
  constructor(private readonly cwd: string = process.cwd()) {}

  getName(): string {
    return "Claude Code";
  }

  static isPresent(cwd: string = process.cwd()): boolean {
    return existsSync(join(CLAUDE_PROJECTS_ROOT, claudeSlug(cwd)));
  }

  async listSessions(): Promise<SessionRef[]> {
    const dir = join(CLAUDE_PROJECTS_ROOT, claudeSlug(this.cwd));
    return listJsonl(dir).map((f) => {
      const messages = this.parse(f.path);
      return {
        id: f.id,
        title: sessionTitle(messages),
        mtime: f.mtime,
        messageCount: messages.length,
      };
    });
  }

  async extractSession(id?: string): Promise<SessionMessage[]> {
    const dir = join(CLAUDE_PROJECTS_ROOT, claudeSlug(this.cwd));
    const file = id ? join(dir, `${id}.jsonl`) : listJsonl(dir)[0]?.path;
    if (!file || !existsSync(file)) {
      throw new Error(`No Claude Code session found for this project (${dir}).`);
    }
    return this.parse(file);
  }

  private parse(file: string): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (const line of readJsonl(file)) {
      const entry = line as ClaudeLine;
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (!entry.message) continue;
      const text = renderContent(entry.message.content);
      if (!text) continue;
      messages.push({ role: entry.type, content: text });
    }
    return messages;
  }
}

interface ClaudeLine {
  type: string;
  message?: { role: string; content: string | ClaudePart[] };
}

export interface ClaudePart {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

/**
 * Render Claude's message content to text. Tool calls and tool results are
 * filtered out at the adapter level — they are noise for the receiving
 * agent. Exported for unit testing.
 */
export function renderContent(content: string | ClaudePart[]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      out.push(part.text);
    }
    // tool_use and tool_result parts are filtered out at the adapter level.
  }
  return out.join("\n").trim();
}
