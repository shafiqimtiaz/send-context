<div align="center">

# ctx-handoff

**Hand off an AI coding-agent session to another developer through an encrypted, ephemeral link.**

[![npm version](https://img.shields.io/npm/v/ctx-handoff.svg)](https://www.npmjs.com/package/ctx-handoff)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/ctx-handoff.svg)](https://nodejs.org)
[![CI](https://github.com/shafiqimtiaz/ctx-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/shafiqimtiaz/ctx-handoff/actions/workflows/ci.yml)

</div>

`ctx-handoff` moves live context between AI coding agents — across machines, across people, across tools. One developer sends their session; a teammate runs a single command to pick up exactly where they left off, with the context injected straight into _their_ agent.

The session is distilled into a structured **Context Handoff** document, encrypted on your machine, and stored behind a short-lived link. The transport layer only ever sees ciphertext.

> **In one terminal, send:** `CTX_HANDOFF_WORKER=your-project.deno.net ctx-handoff send` — share the link out of band, share the password separately.
>
> **In another terminal, receive:** `ctx-handoff receive 'ctx-handoff://your-project.deno.net/<id>' -- pi "continue"` — your agent boots with the full context pre-loaded.
>
> The full walkthrough is in [Quickstart](#quickstart).

## Contents

- [Why](#why)
- [Features](#features)
- [Security model](#security-model)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Getting started](#getting-started)
- [Usage](#usage)
  - [Send a context handoff](#send-a-context-handoff)
  - [Receive a context handoff](#receive-a-context-handoff)
  - [Manual flow (no Gemini)](#manual-flow-no-gemini)
- [Distill with Gemini](#distill-with-gemini)
- [Troubleshooting](#troubleshooting)
- [Deploy the transport](#deploy-the-transport)
  - [Transport API](#transport-api)
- [Supported agents](#supported-agents)
- [The Context Handoff document](#the-context-handoff-document)
- [Development](#development)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)

## Why

Handing off work between agents usually means pasting a wall of chat history and hoping the next agent figures out what matters. That is noisy, leaks whatever was in the log, and lands the receiver in the same dead ends you already hit.

`ctx-handoff` extracts the session, distills it to what the next agent actually needs, encrypts it client-side, and gives you one link to share. The receiver decrypts locally and launches their own agent with the context already loaded.

## Features

- **Agent-agnostic** — works with pi, [Claude Code](https://claude.com/claude-code), and [OpenCode](https://opencode.ai) through a small adapter per agent.
- **Structured handoff** — sessions become a dense, six-section brief (objective, state, completed work, failed approaches, next steps, raw appendix) instead of raw chat logs.
- **Optional Gemini distillation** — point a `GEMINI_API_KEY` at it and the session is summarized automatically; without one, an interactive flow walks you through the brief.
- **Zero-knowledge transport** — AES-256-GCM encryption happens client-side; the server stores only encrypted blobs that expire after 24 hours.
- **Wrapper injection** — `receive <link> -- <agent> "prompt"` launches the receiver's own agent with the context pre-loaded.
- **No native dependencies** — pure TypeScript on Node's built-in `crypto`; installs cleanly on any OS.
- **Serverless backend** — a small Deno Deploy worker backed by Deno KV. No infrastructure to babysit.

## Security model

`ctx-handoff` is designed so that possession of the link alone is not enough to read the payload.

| What the server sees | What stays on your machine | What the receiver gets |
| --- | --- | --- |
| `{salt, iv, ciphertext}` base64 JSON | Password, plaintext session, Gemini API key | The decrypted Markdown handoff, after typing the password |

- **Cipher.** AES-256-GCM. The 32-byte key is derived from the password with scrypt over a per-payload random salt; the 16-byte GCM auth tag is appended to the ciphertext and validated on decrypt, so a wrong password or tampered blob fails loudly (see [Troubleshooting](#troubleshooting)).
- **Password.** Never part of the link, never sent over the wire, never stored. Minimum 4 characters (enforced by the send prompt). Sender and receiver share it out of band.
- **Server.** Holds `{salt, iv, ciphertext}` for 24 hours via Deno KV's native TTL, then the entry is gone. There is no plaintext, no password, no metadata beyond the random 16-byte record id.
- **Payload size.** Hard-capped at ~60 KB by the worker (Deno KV's per-value limit is 64 KiB). If you exceed it, drop appendix messages — see [Troubleshooting](#troubleshooting).
- **Receiver trust.** Anyone who has both the link and the password can read the handoff. Treat the link as semi-public and the password as the actual secret.

## How it works

1. **Export** detects the active agent and lets you pick one or more of its sessions (newest pre-selected), which are merged chronologically. With a `GEMINI_API_KEY` set, it distills the session into the handoff brief automatically; otherwise it guides you through writing the brief and choosing which raw messages to attach.
2. The brief is rendered into the Context Handoff template, encrypted with a password you choose, and uploaded. You get a `ctx-handoff://` link.
3. **Receive** downloads the blob, decrypts it locally, wraps it in an injection prompt, and spawns the receiving agent with that prompt as its opening message.

The wrapper the receiving agent sees looks roughly like this:

```
SYSTEM CONTEXT INJECTION:
You are resuming a task. You have been provided with an Context Handoff Document.
Read it carefully. Do not repeat "Completed Steps". Avoid "Failed Approaches".
Acknowledge the "Current State" and immediately begin working on the "Next Steps".

<handoff document here>

USER REQUEST:
<your trailing prompt>
```

> [!NOTE]
> The password is never part of the link. Share it with the receiver separately — `receive` always prompts for it before decrypting.

## Quickstart

The shortest end-to-end walkthrough. Both terminals must be in a project directory that has at least one session with the chosen agent.

**Sender (terminal A):**

```bash
# 1. Install (once)
npm i -g ctx-handoff

# 2. Optional but recommended: enable Gemini distillation
export GEMINI_API_KEY=...
export GEMINI_MODEL=gemini-2.5-flash   # default; override only if you need to

# 3. Export — prints a ctx-handoff:// link and prompts for a password
export CTX_HANDOFF_WORKER=your-project.deno.net
ctx-handoff send
```

Without `GEMINI_API_KEY`, you'll be walked through the interactive prompts — five optional summary fields, an appendix multiselect (last 10 messages pre-checked), and a password prompt. See [Manual flow](#manual-flow-no-gemini) for the exact steps.

**Sender prints something like:**

```
ctx-handoff://your-project.deno.net/<id>
```

Share the link through one channel (Slack, email, PR comment) and the password through another (DM, voice, password manager). The link is useless without the password.

**Receiver (terminal B):**

```bash
# Interactive: launches your agent with the context pre-loaded.
ctx-handoff receive 'ctx-handoff://your-project.deno.net/<id>' -- pi "continue"

# Non-interactive (e.g. CI, scripts): just decrypt and print the document.
ctx-handoff receive 'ctx-handoff://your-project.deno.net/<id>'
```

`receive` downloads the blob, prompts for the password, decrypts locally, and either launches the agent you named or prints the handoff Markdown to stdout.

## Getting started

### Prerequisites

- Node.js 20 or newer
- One of `pi`, `claude`, or `opencode`, with at least one session in the project directory
- A Google Gemini API key (optional) to auto-distill sessions — see [Distill with Gemini](#distill-with-gemini)
- [Deno](https://deno.com) (optional) only if you want to deploy or run the transport worker yourself

### Install

```bash
npm i -g ctx-handoff --registry=https://registry.npmjs.org/
ctx-handoff --help
```

> [!NOTE]
> The explicit `--registry` flag bypasses any private or proxy registry in your `~/.npmrc` that may not mirror the latest version. On a default npm setup, plain `npm i -g ctx-handoff` works too.

Or run it without installing:

```bash
npx ctx-handoff --help
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/shafiqimtiaz/ctx-handoff.git
cd ctx-handoff
npm install && npm run build
node dist/index.js --help
```

</details>

## Usage

### Send a context handoff

```bash
CTX_HANDOFF_WORKER=your-project.deno.net ctx-handoff send
# or pass the host and agent explicitly:
ctx-handoff send --worker your-project.deno.net --agent pi
```

Without a Gemini key, you are guided through choosing the agent, writing the brief, curating the appendix, and setting a password. The command prints a link:

```
ctx-handoff://your-project.deno.net/<id>
```

#### Non-interactive mode

When `stdin` is not a TTY (CI, scripts, piped input) or when `--agent` is supplied, `export` skips the agent picker, picks the most recently modified session automatically, and refuses to prompt for the password — set `CTX_HANDOFF_PASSWORD` if you want a fully scripted run:

```bash
GEMINI_API_KEY=… CTX_HANDOFF_PASSWORD=… \
  CTX_HANDOFF_WORKER=your-project.deno.net \
  ctx-handoff send --agent pi
```

### Receive a context handoff

```bash
# Launch an agent with the context injected (you'll be prompted for the password):
ctx-handoff receive 'ctx-handoff://…/<id>' -- pi "continue"
ctx-handoff receive 'ctx-handoff://…/<id>' -- claude "continue"
ctx-handoff receive 'ctx-handoff://…/<id>' -- opencode run "continue"

# Or just print the decrypted handoff document:
ctx-handoff receive 'ctx-handoff://…/<id>'
```

Everything after `--` is forwarded to the agent. Flags (`-y`, `--resume`, etc.) pass through unchanged; the trailing free text is treated as the user's request and merged into the injection prompt — see [How it works](#how-it-works). If you omit the agent command entirely, `receive` only decrypts and prints the Markdown handoff to stdout.

### Manual flow (no Gemini)

Without `GEMINI_API_KEY`, `send` walks you through these prompts:

1. **Agent** — auto-detected, with a picker only if more than one agent has a session in the current directory. Skip this entirely with `--agent`.
2. **Sessions** — if the agent has multiple sessions, multiselect with the newest pre-checked. Single-session and non-TTY runs auto-pick the newest.
3. **Written summary** — confirm once, then five optional text fields (primary objective, current state & blockers, completed steps, failed approaches, next steps). Press <kbd>Enter</kbd> on any field to skip it.
4. **Appendix** — multiselect over every message in the extracted session; the **last 10 messages are pre-checked**. Anything not selected drops out.
5. **Password** — prompt with a 4-character minimum; choose something the receiver can pass along safely.

If Gemini is set but the call fails, `send` logs the error and falls back to the manual flow — see [Troubleshooting](#troubleshooting).

## Distill with Gemini

Raw sessions are noisy. Set `GEMINI_API_KEY` and `send` runs the session through Gemini first, distilling it into the **five core sections** of the brief (objective, state, completed work, failed approaches, next steps) and dropping the raw appendix. The result is still wrapped in the six-section Context Handoff Document template, with the appendix slot marked as empty. The manual summary and appendix prompts are skipped.

```bash
GEMINI_API_KEY=… CTX_HANDOFF_WORKER=your-project.deno.net ctx-handoff send
# optional: override the model (default gemini-2.5-flash)
GEMINI_MODEL=gemini-2.5-pro GEMINI_API_KEY=… ctx-handoff send
```

If the key is absent or the call fails, `send` falls back to the manual flow — Gemini is an enhancement, not a hard dependency. The key never leaves your machine; only the encrypted, distilled brief is uploaded, and it uses Google's OpenAI-compatible endpoint, so no extra SDK is installed.

Set `CTX_HANDOFF_PASSWORD` to skip the password prompt as well. With distillation on and a single detected agent, that makes `send` fully non-interactive — no TTY required:

```bash
GEMINI_API_KEY=… CTX_HANDOFF_PASSWORD=… \
  CTX_HANDOFF_WORKER=your-project.deno.net ctx-handoff send --agent pi
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `CTX_HANDOFF_WORKER` | yes (or `--worker`) | Transport worker host, e.g. `your-project.deno.net` |
| `GEMINI_API_KEY` | no | Enables automatic distillation |
| `GEMINI_MODEL` | no | Override the model (default `gemini-2.5-flash`) |
| `CTX_HANDOFF_PASSWORD` | no | Skip the interactive password prompt |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No worker host.` | Neither `--worker` nor `CTX_HANDOFF_WORKER` is set. | `export CTX_HANDOFF_WORKER=your-project.deno.net` or pass `--worker`. |
| `No agent session detected here.` | No adapter found a session in the current directory. | `cd` to the project the agent ran in, or pass `--agent pi\|claude\|opencode` explicitly. |
| `No sessions found to hand off.` | The agent is installed but has never run in this project. | Run the agent once in the project, then retry. |
| `Link expired or invalid.` | The 24-hour TTL elapsed, the id is wrong, or the worker host is unreachable. | Re-send from the sender. |
| `Invalid password.` | The password is wrong, or the blob was tampered with. | Verify with the sender out of band. |
| `Payload too large (limit 60000 bytes — include fewer appendix messages).` | The encrypted JSON exceeds Deno KV's per-value cap. | In the appendix multiselect, attach fewer messages; the brief alone is usually well under the limit. |
| `Gemini request failed (NNN): …` | Gemini call errored (rate limit, bad key, network). | Distillation auto-falls-back to manual — re-run `send`; the manual flow is unaffected. |
| `Agent '<bin>' not found.` | The receiver's agent CLI is not on `PATH`. | Install it (`npm i -g …`) or pass the absolute path. |
| `Could not parse 'opencode export' output as JSON.` | `opencode` CLI is older than the one this adapter was built against. | Update OpenCode and retry. |
| `Paste the link as ctx-handoff://…` never matches `decodeLink`. | Link is malformed (missing `ctx-handoff://`, trailing slash, extra path). | Re-copy from the sender's output; the format is `ctx-handoff://<host>/<id>`. |

## Deploy the transport

The transport runs on **Deno Deploy + Deno KV** (`worker/main.ts`). It stores only encrypted payloads, each with a native 24-hour TTL.

**From GitHub (no local Deno needed):** push the repo, then create a project at [console.deno.com](https://console.deno.com) linked to it.

> [!IMPORTANT]
> Set **App Directory** to `worker` and **Entrypoint** to `main.ts`. If the app directory is left at the repository root, the build auto-detects the Node CLI in `src/` and fails. Leave install and build commands blank.

**From the CLI:**

```bash
deno install -gArf jsr:@deno/deployctl   # one-time
cd worker
deno task dev        # local test at http://localhost:8000
deno task deploy     # deploys --prod, prints your *.deno.net host
```

> [!WARNING]
> Deno KV caps each value at 64 KiB, so payloads are limited to about 60 KB. A curated handoff is far smaller; if you hit the limit, attach fewer appendix messages.

### Transport API

The worker is a tiny HTTP surface. Useful both for self-hosting and for plugging in alternate clients.

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/upload` | `{ "salt": string, "iv": string, "ciphertext": string }` (base64) | `201 { "id": string }` | Hard-rejects bodies > 60 000 bytes with `413`. |
| `GET` | `/download/:id` | — | `200 { "salt", "iv", "ciphertext" }` or `404 { "error" }` | 24-hour native TTL via Deno KV. |

The `id` is a 16-byte random hex string. Combine with `workerHost` to form the link:

```
ctx-handoff://<workerHost>/<id>
```

There is no `DELETE` and no `LIST` — when the TTL elapses, Deno KV drops the entry on its own.

## Supported agents

| Agent | Extraction | Session store |
| --- | --- | --- |
| **OpenCode** | `opencode session list` + `opencode export <id>` | Owned by the OpenCode CLI; no on-disk path to inspect manually. |
| **pi** | reads `~/.pi/agent/sessions/<slug>/*.jsonl` | `<slug>` is `-<absolute-cwd-with-slashes-as-dashes>--` |
| **Claude Code** | reads `~/.claude/projects/<slug>/*.jsonl` | `<slug>` is the absolute cwd with every non-alphanumeric character replaced by `-` |

`pi` and Claude Code are detected by checking whether the corresponding project folder exists; if both are present, you'll be asked which one to send from. OpenCode is detected by the `opencode` binary being on `PATH`.

> [!TIP]
> Adding a new agent is a single file implementing the `AgentAdapter` interface (`getName()` + `listSessions()` + `extractSession()`). Register it in `src/adapters/index.ts` and add a `isPresent(cwd)` static.

## The Context Handoff document

Every handoff is formatted into a fixed Markdown structure, so the receiving model gets actionable context immediately:

1. **Primary Objective**
2. **Current State & Blockers**
3. **Completed Steps** — don't repeat these
4. **Failed Approaches** — don't retry these
5. **Next Steps** — start here
6. **Raw Context Appendix** — curated messages for deep context

## Project structure

```
src/
  index.ts                CLI entry (commander)
  core/
    crypto.ts             AES-256-GCM + scrypt
    distiller.ts          optional Gemini distillation
    link.ts               ctx-handoff:// codec
    transport.ts          upload/download client
    formatter.ts          Context Handoff renderer
    session-store.ts      JSONL helpers (pi + Claude)
    paths.ts              agent session-store paths
    exec.ts               child_process runner
    handoff-builder.ts    pipeline driver (extracted for testability)
  adapters/               pi, claude, opencode + registry
  commands/               send (CLI shell), receive
worker/
  main.ts                 Deno Deploy + Deno KV worker
  deno.json
```

## Development

```bash
git clone https://github.com/shafiqimtiaz/ctx-handoff.git
cd ctx-handoff
npm install
npm run dev          # tsx watch — fast iteration on src/
npm run typecheck    # tsc --noEmit
npm test             # node --test src/**/*.test.ts
npm run build        # tsc → dist/ (this is what npm publishes)
```

Tests run the pipeline (`buildHandoff`, `crypto`, `link`, `formatter`) with a scripted prompter so the I/O layer is exercised without a TTY. CI runs `typecheck`, `test`, and `build` against Node 20 and 22 on every push and PR — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Tech stack

- **CLI:** TypeScript, [commander](https://github.com/tj/commander.js), [@clack/prompts](https://github.com/bombshell-dev/clack)
- **Crypto:** Node.js built-in `crypto` (AES-256-GCM, scrypt)
- **Distillation (optional):** Google Gemini via its OpenAI-compatible Chat Completions endpoint, with [jsonrepair](https://github.com/josdejong/jsonrepair) for resilient parsing of model output
- **Transport:** Deno Deploy + Deno KV
