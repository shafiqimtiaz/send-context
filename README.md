# send-context

> Relay an AI coding-agent session from one developer to another through an encrypted, ephemeral link.

[![npm version](https://img.shields.io/npm/v/send-context.svg)](https://www.npmjs.com/package/send-context)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`send-context` is an agent-agnostic CLI for passing live context between AI coding agents — across machines, across people, across tools. A developer in one timezone exports their session; a teammate in another runs one command to pick up exactly where they left off, with the context injected straight into *their* agent.

The session is distilled into a structured **Context Handoff Skill** document, encrypted on your machine, and stored behind a short-lived link. The transport layer only ever sees ciphertext.

```
   pi · Claude Code · OpenCode                        pi · Claude Code · OpenCode
              │                                                   ▲
              │ extract + format                    inject prompt │
              ▼                                                   │
   ┌───────────────────────┐  encrypt                  decrypt  ┌────────────────────────┐
   │  send-context export   │ ────────►  edge KV (24h) ───────► │  send-context receive   │
   └───────────────────────┘         (ciphertext only)         └────────────────────────┘
```

## Features

- **Agent-agnostic** — works with pi, [Claude Code](https://claude.com/claude-code), and [OpenCode](https://opencode.ai), via a small adapter per agent.
- **The Context Handoff Skill Standard** — sessions become a dense, 6-section Markdown brief (objective, state, completed, failed approaches, next steps, raw appendix) instead of noisy chat logs.
- **Zero-knowledge transport** — AES-256-GCM encryption happens client-side; the server stores only encrypted blobs that expire after 24 hours.
- **Wrapper injection** — `send-context receive <link> -- <agent> "prompt"` launches the receiver's own agent with the context pre-loaded.
- **No native dependencies** — pure TypeScript on Node's built-in `crypto`; installs cleanly on any OS.
- **Serverless backend** — a ~90-line Deno Deploy worker backed by Deno KV. No credit card, no infrastructure to babysit.

## How it works

1. **Export** detects the active agent, extracts its session, and lets you curate what to send. You add a short written brief and pick which raw messages to attach.
2. The brief is rendered into the Context Handoff Skill template, encrypted with a password you choose, and uploaded. You get a `send-context://` link.
3. **Receive** downloads the blob, decrypts it locally, wraps it in an injection prompt, and spawns the receiving agent with that prompt as its opening message.

> [!NOTE]
> The password travels in the link fragment (`#…`), which is only ever processed client-side. Share the link over a channel you trust, or omit the fragment and share the password separately — `receive` will prompt for it.

## Getting started

### Prerequisites

- Node.js 20+
- One of: `pi`, `claude`, or `opencode` with at least one session in the project directory
- [Deno](https://deno.com) — only if you want to deploy or run the transport worker yourself

### Install

```bash
npm install -g send-context
send-context --help
```

Or run it without installing:

```bash
npx send-context --help
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/shafiqimtiaz/context-handoff.git
cd context-handoff
npm install && npm run build
node dist/index.js --help
```
</details>

## Deploy the transport

The transport runs on **Deno Deploy + Deno KV** (`worker/main.ts`). It stores only encrypted payloads, each with a native 24-hour TTL.

**From GitHub (no local Deno needed):** push the repo, then create a project at [console.deno.com](https://console.deno.com) linked to it.

> [!IMPORTANT]
> Set **App Directory** to `worker` and **Entrypoint** to `main.ts`. If the app directory is left at the repository root, the build auto-detects the Node CLI in `src/` and fails. Leave install/build commands blank.

**From the CLI:**

```bash
deno install -gArf jsr:@deno/deployctl   # one-time
cd worker
deno task dev        # local test at http://localhost:8000
deno task deploy     # deploys --prod, prints your *.deno.net host
```

> [!WARNING]
> Deno KV caps each value at 64 KiB, so payloads are limited to ~60 KB. A curated context handoff is far smaller; if you hit the limit, attach fewer appendix messages.

## Usage

### Send a context handoff

```bash
SEND_CONTEXT_WORKER=your-project.deno.net send-context export
# or pass the host and agent explicitly:
send-context export --worker your-project.deno.net --agent pi
```

You'll be guided through picking the agent, writing the brief, curating the appendix, and setting a password. The command prints a link:

```
send-context://your-project.deno.net/<id>#<password>
```

### Receive a context handoff

```bash
# Launch an agent with the context injected:
send-context receive 'send-context://…/<id>#<password>' -- pi "continue"
send-context receive 'send-context://…/<id>#<password>' -- claude "continue"
send-context receive 'send-context://…/<id>#<password>' -- opencode run "continue"

# Or just print the decrypted context handoff document:
send-context receive 'send-context://…/<id>#<password>'
```

## Supported agents

| Agent | Extraction | Notes |
| --- | --- | --- |
| **OpenCode** | `opencode session list` + `opencode export <id>` | Uses the native session-export CLI. |
| **pi** | reads `~/.pi/agent/sessions/<project>/*.jsonl` | No stdout JSON dump exists; reads the documented session transcript. |
| **Claude Code** | reads `~/.claude/projects/<project>/*.jsonl` | Same — reads the documented JSONL transcript. |

> [!TIP]
> Adding a new agent is a single file implementing the `AgentAdapter` interface (`getName()` + `extractSession()`). Register it in `src/adapters/index.ts`.

## The Context Handoff Skill Standard

Every export is formatted into a fixed Markdown structure so the receiving model gets actionable context immediately:

1. **Primary Objective**
2. **Current State & Blockers**
3. **Completed Steps** — don't repeat these
4. **Failed Approaches** — don't retry these
5. **Next Steps** — start here
6. **Raw Context Appendix** — curated messages for deep context

## Project structure

```
src/
  index.ts            CLI entry (commander)
  core/
    crypto.ts         AES-256-GCM + scrypt
    link.ts           send-context:// codec
    transport.ts      upload/download client
    formatter.ts      Context Handoff Skill renderer
    session-store.ts  JSONL helpers
    paths.ts exec.ts
  adapters/           pi, claude, opencode + registry
  commands/           export, receive
worker/
  main.ts             Deno Deploy + Deno KV worker
  deno.json
```

## Tech stack

- **CLI:** TypeScript, [commander](https://github.com/tj/commander.js), [@clack/prompts](https://github.com/bombshell-dev/clack)
- **Crypto:** Node.js built-in `crypto` (AES-256-GCM, scrypt)
- **Transport:** Deno Deploy + Deno KV
