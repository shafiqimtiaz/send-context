#!/usr/bin/env node
import { Command } from "commander";
import { runSend, SendOptions } from "./commands/send.js";
import { runReceive } from "./commands/receive.js";
import { AgentId } from "./adapters/index.js";

const program = new Command();

// Single source of truth: read the version release-it bumps in package.json.
const { version } = require("../package.json") as { version: string };

program
  .name("ctx-handoff")
  .description("Relay AI coding-agent session context between developers via an encrypted, ephemeral link.")
  .version(version)
  .enablePositionalOptions();

program
  .command("send")
  .description("Extract the current agent session, format it, encrypt it, and produce a share link.")
  .option("-a, --agent <agent>", "force agent: pi | claude | opencode")
  .option("-w, --worker <host>", "Cloudflare Worker host (or set CTX_HANDOFF_WORKER)")
  .action((opts: { agent?: string; worker?: string }) =>
    runSend({ agent: opts.agent as AgentId | undefined, worker: opts.worker } as SendOptions),
  );

program
  .command("receive")
  .description("Download and decrypt a context handoff, then launch an agent with the context injected.")
  .argument("<link>", "ctx-handoff:// link")
  .argument("[agent...]", "agent command to launch after --, e.g. -- pi \"continue\"")
  .allowUnknownOption()
  .passThroughOptions()
  .action((link: string, agent: string[]) => runReceive(link, agent ?? []));

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
