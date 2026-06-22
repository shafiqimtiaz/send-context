import { jsonrepair } from "jsonrepair";
import { AgentId } from "../adapters/index.js";

/**
 * Receiver-side Gemini generation. The receiver decrypts the sender's brief,
 * then (when a key is set) calls Gemini to produce a slightly refined markdown
 * for the picked coding agent AND a self-contained HTML preview for human
 * review. When no key is set, the receiver skips this step and writes the
 * decrypted markdown verbatim — graceful degrade.
 *
 * Same OpenAI-compatible endpoint as the sender side; no SDK.
 */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const DEFAULT_MODEL = "gemini-2.5-flash";

export const RECEIVER_SYSTEM_PROMPT = `You are refining a handoff brief that another developer is about to receive. The input is a Markdown handoff document. Produce a JSON object with exactly two fields:

- "markdown" — the file that will be written to the receiver's coding-agent project folder (e.g. .claude/handoff.md, .pi/handoff.md, .opencode/handoff.md). Tighten the language; favor action-oriented bullets in Completed Steps, Failed Approaches, and Next Steps. Adapt verbosity to the agent: claude prefers concise, opencode prefers terse, pi prefers dense.
- "html" — a self-contained browser page for the receiver to review before launching their agent. Render the brief into the supplied HTML scaffold by substituting the {{...}} placeholders. Keep the visual style: Tailwind via CDN, stone/slate palette, generous whitespace, Mermaid CDN. The Raw Context Appendix must be collapsed by default using <details><summary>.

Preserve every fact from the input. Do not invent file paths, line numbers, or next steps that the input does not support. Respond with ONLY a JSON object.`;

export const RECEIVER_HTML_SCAFFOLD = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{{title}} — handoff</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      body { font-feature-settings: "ss01", "cv11"; }
      .handoff-section h2 { font-family: ui-serif, Georgia, serif; }
      .appendix pre { white-space: pre-wrap; }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header class="space-y-3 border-b border-slate-200 pb-8">
        <p class="text-xs uppercase tracking-wider text-slate-500">Context Handoff</p>
        <h1 class="text-3xl font-serif text-slate-900">{{title}}</h1>
        <dl class="flex flex-wrap gap-x-8 gap-y-2 text-sm text-slate-600">
          <div><dt class="inline text-slate-400">From </dt><dd class="inline font-medium text-slate-700">{{source_agent}}</dd></div>
          <div><dt class="inline text-slate-400">Received </dt><dd class="inline font-medium text-slate-700">{{date}}</dd></div>
        </dl>
        <div class="flex flex-wrap gap-2 pt-1">{{topic_chips}}</div>
      </header>

      <section class="handoff-section rounded-lg border border-slate-200 bg-white p-6 space-y-3">
        <h2 class="text-lg font-semibold text-slate-900">1. Primary Objective</h2>
        <div class="prose prose-slate max-w-none text-slate-700">{{objective_body}}</div>
      </section>

      <section class="handoff-section rounded-lg border border-slate-200 bg-white p-6 space-y-3">
        <h2 class="text-lg font-semibold text-slate-900">2. Current State &amp; Blockers</h2>
        <div class="prose prose-slate max-w-none text-slate-700">{{current_state_body}}</div>
      </section>

      <section class="handoff-section rounded-lg border border-slate-200 bg-white p-6 space-y-3">
        <h2 class="text-lg font-semibold text-slate-900">3. Completed Steps</h2>
        <div class="prose prose-slate max-w-none text-slate-700">{{completed_steps_body}}</div>
      </section>

      <section class="handoff-section rounded-lg border border-slate-200 bg-white p-6 space-y-3">
        <h2 class="text-lg font-semibold text-slate-900">4. Failed Approaches (Do Not Retry)</h2>
        <div class="prose prose-slate max-w-none text-slate-700">{{failed_approaches_body}}</div>
      </section>

      <section class="handoff-section rounded-lg border border-slate-200 bg-white p-6 space-y-3">
        <h2 class="text-lg font-semibold text-slate-900">5. Next Steps</h2>
        <div class="prose prose-slate max-w-none text-slate-700">{{next_steps_body}}</div>
      </section>

      <section class="handoff-section rounded-lg border border-slate-200 bg-white p-6 space-y-3">
        <h2 class="text-lg font-semibold text-slate-900">6. Raw Context Appendix</h2>
        <details class="appendix">
          <summary class="cursor-pointer text-sm text-slate-500 hover:text-slate-700">Show raw messages</summary>
          <div class="prose prose-slate max-w-none text-slate-700 mt-3">{{raw_appendix_body}}</div>
        </details>
      </section>

      <footer class="text-xs text-slate-400 pt-4 border-t border-slate-200">
        Generated by <span class="font-mono">ctx-handoff receive</span>. Encrypted blob discarded after decryption; this preview is local.
      </footer>
    </main>
  </body>
</html>
`;

export function receiverGeminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export interface DistillResult {
  markdown: string;
  html: string;
}

export async function distillToHtmlAndMarkdown(
  decrypted: string,
  agentId: AgentId,
): Promise<DistillResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;

  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: RECEIVER_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Agent: ${agentId}\n\n` +
            `Handoff document:\n\n${decrypted}\n\n` +
            `HTML scaffold to use as the structure for the "html" field ` +
            `(substitute the {{...}} placeholders; preserve CDN scripts and styling):\n\n` +
            RECEIVER_HTML_SCAFFOLD,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Gemini returned no content.");

  const obj = JSON.parse(jsonrepair(content)) as {
    markdown?: unknown;
    html?: unknown;
  };
  if (typeof obj.markdown !== "string" || typeof obj.html !== "string") {
    throw new Error("Gemini response missing markdown or html field.");
  }
  return { markdown: obj.markdown, html: obj.html };
}
