import { AgentAdapter, SessionMessage, SessionRef } from "./types.js";
import { run, commandExists } from "../core/exec.js";

/**
 * OpenCode adapter.
 *
 * OpenCode exposes a real session export CLI, so this adapter follows the
 * "use the native CLI" rule strictly:
 *   1. `opencode session list`   -> newest session id for this project
 *   2. `opencode export <id>`    -> full session as JSON
 */
export class OpenCodeAdapter implements AgentAdapter {
  private static readonly BIN = "opencode";

  getName(): string {
    return "OpenCode";
  }

  static isPresent(): boolean {
    return commandExists(OpenCodeAdapter.BIN);
  }

  async listSessions(): Promise<SessionRef[]> {
    const rows = await this.sessionRows();
    // Rows are newest-first; use a descending index as the sort key since the
    // CLI does not expose per-session timestamps here.
    return rows.map((row, i) => ({ id: row.id, title: row.title, mtime: -i }));
  }

  async extractSession(id?: string): Promise<SessionMessage[]> {
    const sessionId = id ?? this.firstId(await this.sessionRows());
    if (!sessionId) {
      throw new Error("No OpenCode session found for this project.");
    }

    const { stdout, code, stderr } = await run(
      OpenCodeAdapter.BIN,
      ["export", sessionId],
      { timeoutMs: 120_000 },
    );
    if (code !== 0) {
      throw new Error(`opencode export failed: ${stderr.trim() || `exit ${code}`}`);
    }

    let parsed: OpenCodeExport;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("Could not parse `opencode export` output as JSON.");
    }

    const messages: SessionMessage[] = [];
    for (const msg of parsed.messages ?? []) {
      const role = msg.info?.role === "assistant" ? "assistant" : "user";
      const text = renderParts(msg.parts ?? []);
      if (text) messages.push({ role, content: text });
    }
    return messages;
  }

  private firstId(rows: SessionRow[]): string | null {
    return rows[0]?.id ?? null;
  }

  /** Parse `opencode session list` rows (newest-first) into id + title. */
  private async sessionRows(): Promise<SessionRow[]> {
    const { stdout, code, stderr } = await run(
      OpenCodeAdapter.BIN,
      ["session", "list"],
      { timeoutMs: 60_000 },
    );
    if (code !== 0) {
      throw new Error(`opencode session list failed: ${stderr.trim() || `exit ${code}`}`);
    }
    const rows: SessionRow[] = [];
    for (const line of stdout.split("\n")) {
      const match = /\bses_\S+/.exec(line);
      if (!match) continue;
      const id = match[0];
      const title = line.replace(id, "").trim() || id;
      rows.push({ id, title });
    }
    return rows;
  }
}

interface SessionRow {
  id: string;
  title: string;
}

interface OpenCodeExport {
  info?: { directory?: string };
  messages?: Array<{
    info?: { role?: string };
    parts?: OpenCodePart[];
  }>;
}

export interface OpenCodePart {
  type: string;
  text?: string;
  tool?: string;
  state?: { input?: unknown; output?: unknown };
}

/**
 * Render an OpenCode message's parts to text. Tool parts and reasoning
 * parts are filtered out at the adapter level — they are noise for the
 * receiving agent. Exported for unit testing.
 */
export function renderParts(parts: OpenCodePart[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      out.push(part.text);
    }
    // tool, reasoning, step-start, step-finish parts are filtered out.
  }
  return out.join("\n").trim();
}
