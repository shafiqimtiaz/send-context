import * as p from "@clack/prompts";
import { AgentId, createAdapter, detectAgents } from "../adapters/index.js";
import { AgentNotFoundError } from "../adapters/types.js";
import { formatToHandoffSkill } from "../core/formatter.js";
import { distillSession, geminiAvailable } from "../core/distiller.js";
import { encrypt } from "../core/crypto.js";
import { uploadPayload } from "../core/transport.js";
import { encodeLink } from "../core/link.js";
import {
  buildHandoff,
  CancelledError,
  HandoffBuilderDeps,
  Prompter,
  Spinner,
} from "../core/handoff-builder.js";

export interface SendOptions {
  agent?: AgentId;
  worker?: string;
}

/**
 * Default hosted worker for users who don't pass --worker or set
 * CTX_HANDOFF_WORKER. Authored by the package maintainer; advanced users
 * self-host by setting their own. No trailing slash — transport.ts
 * constructs `${host}/upload` and `${host}/download/${id}`.
 */
export const DEFAULT_WORKER_HOST = "https://ctx-handoff.shafiqimtiaz.deno.net";

/**
 * Precedence: --worker flag > CTX_HANDOFF_WORKER env > DEFAULT_WORKER_HOST.
 * Extracted from runSend so it can be unit-tested without process.exit /
 * @clack/prompts side effects.
 */
export function resolveWorkerHost(
  opts: { worker?: string },
  env: { CTX_HANDOFF_WORKER?: string },
): string {
  return opts.worker ?? (env.CTX_HANDOFF_WORKER || DEFAULT_WORKER_HOST);
}

/**
 * Thin CLI shell around buildHandoff. This module owns the I/O concerns the
 * builder deliberately avoids: process.env, process.exit, @clack/prompts.
 */
export async function runSend(opts: SendOptions): Promise<void> {
  const workerHost = resolveWorkerHost(opts, process.env);

  const deps: HandoffBuilderDeps = {
    prompter: clackPrompter,
    detectAgents,
    createAdapter,
    encrypt,
    uploadPayload,
    encodeLink,
    geminiAvailable,
    distillSession,
    formatToHandoffSkill,
    isStdoutTty: Boolean(process.stdin.isTTY),
  };

  try {
    await buildHandoff({
      workerHost,
      password: process.env.CTX_HANDOFF_PASSWORD,
      presetAgent: opts.agent,
      cwd: process.cwd(),
      deps,
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      // buildHandoff already called p.cancel.
      process.exitCode = 130;
      return;
    }
    if (err instanceof AgentNotFoundError) {
      p.cancel(err.message);
      process.exitCode = 1;
      return;
    }
    p.cancel((err as Error).message);
    process.exitCode = 1;
  }
}

// ----- @clack/prompts adapter ---------------------------------------------

const clackPrompter: Prompter = {
  intro: (msg) => p.intro(msg),
  outro: (msg) => p.outro(msg),
  cancel: (msg) => p.cancel(msg),
  note: (msg, title) => p.note(msg, title),
  log: p.log,
  spinner: () => new ClackSpinner(),
  // Casts at the seam: clack's generics are stricter than the Prompter
  // interface needs. The cast is localized to this one adapter.
  select: (opts) => p.select(opts as never) as Promise<never>,
  multiselect: (opts) => p.multiselect(opts as never) as Promise<never[]>,
  text: (opts) => p.text(opts) as Promise<string>,
  password: (opts) => p.password(opts) as Promise<string>,
  confirm: (opts) => p.confirm(opts) as Promise<boolean>,
};

class ClackSpinner implements Spinner {
  private inner = p.spinner();
  start(msg: string) {
    this.inner.start(msg);
  }
  stop(msg: string) {
    this.inner.stop(msg);
  }
}
