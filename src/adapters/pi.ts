import { join } from "node:path";
import { existsSync } from "node:fs";
import { AgentAdapter, SessionMessage, SessionRef } from "./types.js";
import { PI_SESSIONS_ROOT, piSlug } from "../core/paths.js";
import {
  listJsonl,
  readJsonl,
  sessionTitle,
} from "../core/session-store.js";

/**
 * Pi adapter.
 *
 * Pi has no command that dumps a session as JSON to stdout (`--mode json`
 * starts a *new* model turn). The session itself is a documented JSONL file
 * at ~/.pi/agent/sessions/<slug>/<id>.jsonl, so we read the latest one for the
 * current project directory.
 */
export class PiAdapter implements AgentAdapter {
  constructor(private readonly cwd: string = process.cwd()) {}

  getName(): string {
    return "Pi";
  }

  static isPresent(cwd: string = process.cwd()): boolean {
    return existsSync(join(PI_SESSIONS_ROOT, piSlug(cwd)));
  }

  async listSessions(): Promise<SessionRef[]> {
    const dir = join(PI_SESSIONS_ROOT, piSlug(this.cwd));
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
    const dir = join(PI_SESSIONS_ROOT, piSlug(this.cwd));
    const file = id ? join(dir, `${id}.jsonl`) : listJsonl(dir)[0]?.path;
    if (!file || !existsSync(file)) {
      throw new Error(`No Pi session found for this project (${dir}).`);
    }
    return this.parse(file);
  }

  private parse(file: string): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (const line of readJsonl(file)) {
      const entry = line as PiLine;
      if (entry.type !== "message" || !entry.message) continue;
      const { role, content } = entry.message;
      const text = renderParts(content);
      if (!text) continue;
      messages.push({ role: normalizeRole(role), content: text });
    }
    return messages;
  }
}

interface PiLine {
  type: string;
  message?: { role: string; content: PiPart[] };
}

export interface PiPart {
  type: string;
  text?: string;
  name?: string;
  toolName?: string;
  args?: unknown;
  input?: unknown;
}

function normalizeRole(role: string): SessionMessage["role"] {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "system"; // toolResult and anything else
}

/**
 * Render a Pi message's content array to text. Tool calls and thinking
 * parts are intentionally dropped — they are noise for the receiving agent.
 * Exported for unit testing.
 */
export function renderParts(content: PiPart[]): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      out.push(part.text);
    }
    // toolCall and thinking parts are filtered out at the adapter level.
  }
  return out.join("\n").trim();
}
