import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { decodeLink } from "../core/link.js";
import { downloadPayload } from "../core/transport.js";
import { decrypt } from "../core/crypto.js";
import {
  buildReceiverBrief,
  CancelledError,
  Prompter as BriefPrompter,
} from "../core/receiver-brief.js";
import {
  distillToHtmlAndMarkdown,
  receiverGeminiAvailable,
} from "../core/receiver-prompts.js";
import { AgentId } from "../adapters/index.js";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { spawn as spawnChild } from "node:child_process";

/**
 * Thin CLI shell for the receive command. Owns the IO concerns the
 * `core/receiver-brief` module deliberately avoids: process.env, process.exit,
 * @clack/prompts, and the agent spawn. Test seams are exposed via
 * `RunReceiveDeps` so the full flow can be exercised without a TTY.
 */
export interface RunReceiveDeps {
  downloadPayload: (workerHost: string, id: string) => Promise<unknown>;
  decrypt: (payload: unknown, password: string) => string;
  buildReceiverBrief: typeof buildReceiverBrief;
  distillToHtmlAndMarkdown: typeof distillToHtmlAndMarkdown;
  receiverGeminiAvailable: () => boolean;
  openInBrowser: (path: string) => Promise<void>;
  spawnAgent: (bin: string, args: string[]) => Promise<number>;
  resolveCwd: () => string;
  resolveTmpdir: () => string;
  now: () => number;
  stdinIsTty: boolean;
  stdoutWrite: (s: string) => void;
}

export const defaultReceiveDeps: RunReceiveDeps = {
  downloadPayload: (workerHost, id) => downloadPayload(workerHost, id),
  decrypt: (payload, password) => decrypt(payload as never, password),
  buildReceiverBrief,
  distillToHtmlAndMarkdown,
  receiverGeminiAvailable,
  openInBrowser: async (path) => {
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
    await new Promise<void>((resolve, reject) => {
      const child = spawnChild(cmd, [path], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },
  spawnAgent: (bin, args) => new Promise<number>((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        process.stderr.write(`\nAgent '${bin}' not found. Is it installed and in your PATH?\n`);
        process.exitCode = 127;
      } else {
        process.stderr.write(`\nFailed to launch '${bin}': ${err.message}\n`);
        process.exitCode = 1;
      }
      resolve(process.exitCode ?? 1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  }),
  resolveCwd: () => process.cwd(),
  resolveTmpdir: () => tmpdir(),
  now: () => Date.now(),
  stdinIsTty: Boolean(process.stdin.isTTY),
  stdoutWrite: (s) => process.stdout.write(s),
};

export async function runReceive(
  rawLink: string,
  agentArgv: string[],
  deps: RunReceiveDeps = defaultReceiveDeps,
): Promise<void> {
  p.intro("ctx-handoff receive");
  if (agentArgv[0] === "--") agentArgv = agentArgv.slice(1);

  let link;
  try {
    link = decodeLink(rawLink);
  } catch (err) {
    p.cancel(String((err as Error).message));
    process.exitCode = 1;
    return;
  }

  const spin = p.spinner();
  spin.start("Downloading handoff");
  let payload;
  try {
    payload = await deps.downloadPayload(link.workerHost, link.id);
  } catch (err) {
    spin.stop("Download failed.");
    const msg = (err as Error).message;
    p.cancel(msg === "LINK_EXPIRED" ? "Link expired or invalid." : msg);
    process.exitCode = 1;
    return;
  }
  spin.stop("Downloaded.");

  const password = await p.password({ message: "Password:" });
  if (p.isCancel(password)) {
    p.cancel("Cancelled.");
    process.exitCode = 130;
    return;
  }

  let markdown: string;
  try {
    markdown = deps.decrypt(payload, password);
  } catch (err) {
    const msg = (err as Error).message;
    p.cancel(msg === "INVALID_PASSWORD" ? "Invalid password." : msg);
    process.exitCode = 1;
    return;
  }

  // If the user passed a leading agent command (`receive <link> -- pi "x"`),
  // treat it as the pre-picked target so the TUI agent picker is skipped and
  // the existing CLI workflow keeps working. Anything after the leading
  // non-flag token is the user request.
  let presetAgent: AgentId | undefined;
  let userRequest: string;
  if (agentArgv.length > 0 && isAgentId(agentArgv[0])) {
    presetAgent = agentArgv[0];
    const rest = agentArgv.slice(1);
    userRequest = rest.filter((a) => !a.startsWith("-")).join(" ")
      || "Continue the work described above.";
  } else {
    userRequest = agentArgv.filter((a) => !a.startsWith("-")).join(" ")
      || "Continue the work described above.";
  }

  // Non-TTY: skip the TUI flow entirely. Just print the markdown.
  if (!deps.stdinIsTty) {
    p.outro("Decrypted handoff document:");
    deps.stdoutWrite(`\n${markdown}\n`);
    return;
  }

  const briefPrompter: BriefPrompter = {
    intro: (m) => p.intro(m),
    outro: (m) => p.outro(m),
    cancel: (m) => p.cancel(m),
    note: (m, t) => p.note(m, t),
    log: { warn: p.log.warn, info: p.log.info },
    spinner: () => {
      const s = p.spinner();
      return { start: (m) => s.start(m), stop: (m) => s.stop(m) };
    },
    confirm: (o) => p.confirm(o) as Promise<boolean>,
    select: (o) => p.select(o as never) as Promise<never>,
    text: (o) => p.text(o) as Promise<string>,
    password: (o) => p.password(o) as Promise<string>,
  };

  let result;
  try {
    result = await deps.buildReceiverBrief({
      decrypted: markdown,
      userRequest,
      presetAgent,
      deps: {
        prompter: briefPrompter,
        receiverGeminiAvailable: deps.receiverGeminiAvailable,
        distillToHtmlAndMarkdown: deps.distillToHtmlAndMarkdown,
        openInBrowser: deps.openInBrowser,
        resolveCwd: deps.resolveCwd,
        resolveTmpdir: deps.resolveTmpdir,
        now: deps.now,
      },
    });
  } catch (err) {
    if (err instanceof CancelledError) {
      // The brief module already called p.cancel.
      process.exitCode = 130;
      return;
    }
    p.cancel((err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (result.spawnInjection) {
    p.outro(`Launching ${result.spawnInjection.bin} with injected context…`);
    const code = await deps.spawnAgent(
      result.spawnInjection.bin,
      result.spawnInjection.args,
    );
    if (code !== 0) process.exitCode = code;
    return;
  }

  p.outro(`Wrote handoff to .${result.targetAgent}/handoff.md. Launch ${result.targetAgent} manually to read it.`);
}

function isAgentId(v: string): v is AgentId {
  return v === "pi" || v === "claude" || v === "opencode";
}
