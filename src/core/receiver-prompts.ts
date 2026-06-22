import { AgentId } from "../adapters/index.js";

/**
 * Receiver-side Gemini generation. The receiver decrypts the sender's
 * verbose Markdown brief, then (when a key is set) calls Gemini to render
 * the brief as a self-contained HTML page for human review. When no key
 * is set, the receiver skips this step and writes the decrypted markdown
 * verbatim — graceful degrade.
 *
 * Same OpenAI-compatible endpoint as the sender side; no SDK.
 */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const DEFAULT_MODEL = "gemini-2.5-flash";

export const RECEIVER_SYSTEM_PROMPT = `You are rendering a verbose handoff brief as a self-contained HTML page for
human review. The input is a Markdown brief. Produce a single complete
\`<!doctype html>\` document by filling in the body of the provided minimal
scaffold. Do not modify the scaffold's \`<!doctype html>\`, \`<html>\`, \`<head>\`,
opening \`<body>\`, or closing \`</body></html>\` tags. Replace the
\`<!-- CONTENT -->\` marker with rendered HTML.

Preservation rules:
- Preserve every word from the input Markdown verbatim. Do not paraphrase,
  summarize, or "tighten" the brief.
- Preserve all code fences, file paths, commands, error messages, and
  identifiers exactly as written.
- Preserve all heading levels and bullet structure.

Styling:
- Apply the inline CSS reset from the scaffold.
- Choose a clean, readable layout: comfortable max-width on the body
  (max ~48rem), generous line-height (1.6+), readable font stack.
- Render Markdown headings, paragraphs, lists, code fences, and inline code
  directly. Do not invent editorial cards, sidebars, or navigation.
- The page should be scannable on a single screen for a short brief, and
  scrollable for a long one. No JavaScript required.

Output the complete HTML document, starting with \`<!doctype html>\`. No JSON
wrapper, no commentary.`;

/**
 * Minimal HTML scaffold used as the receiver's HTML preview base. Contains
 * a CSS reset, no external CSS deps, no Tailwind, no Mermaid, no fixed
 * section structure. The body of Gemini's output is injected at the
 * `<!-- CONTENT -->` marker.
 */
export const MINIMAL_HTML_SCAFFOLD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Handoff Brief</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    color: #1f2937;
    background: #fafaf9;
    padding: 2rem 1.5rem;
  }
  main { max-width: 48rem; margin: 0 auto; }
  h1, h2, h3, h4 { line-height: 1.25; margin-top: 2em; }
  h1 { font-size: 1.875rem; margin-top: 0; }
  h2 { font-size: 1.375rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .25em; }
  h3 { font-size: 1.125rem; }
  p { margin: 1em 0; }
  ul, ol { padding-left: 1.5em; }
  li { margin: .25em 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: .9em;
    background: #f3f4f6;
    padding: .1em .3em;
    border-radius: 3px;
  }
  pre {
    background: #1f2937;
    color: #f9fafb;
    padding: 1em 1.25em;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.5;
  }
  pre code { background: none; padding: 0; color: inherit; }
  blockquote {
    margin: 1em 0;
    padding: .5em 1em;
    border-left: 3px solid #d1d5db;
    color: #4b5563;
    background: #f3f4f6;
  }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
</style>
</head>
<body>
<main>
<!-- CONTENT -->
</main>
</body>
</html>
`;

export function receiverGeminiAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export interface DistillResult {
  /** The brief passed through verbatim — no Gemini transformation. */
  markdown: string;
  /** Complete HTML document with the brief's body injected into the minimal scaffold. */
  html: string;
}

/**
 * Extract the inner content of the outermost `<main>` (or `<body>` as a
 * fallback) from a complete HTML document. Returns null if neither tag is
 * present.
 */
export function extractMainContent(html: string): string | null {
  const mainMatch = matchOutermostTag(html, "main");
  if (mainMatch) return mainMatch;
  const bodyMatch = matchOutermostTag(html, "body");
  if (bodyMatch) return bodyMatch;
  return null;
}

function matchOutermostTag(html: string, tag: string): string | null {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const start = html.toLowerCase().indexOf(open.toLowerCase());
  if (start === -1) return null;
  // Find the end of the opening tag.
  const openEnd = html.indexOf(">", start);
  if (openEnd === -1) return null;
  // Find the matching close tag at the same depth.
  const searchFrom = openEnd + 1;
  let depth = 1;
  let cursor = searchFrom;
  const tagRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = cursor;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const isClose = m[0].startsWith(`</`);
    if (isClose) {
      depth--;
      if (depth === 0) {
        return html.slice(searchFrom, m.index);
      }
    } else {
      // Skip self-closing tags like <main /> (no body content).
      if (!m[0].endsWith("/>")) depth++;
    }
    cursor = m.index + m[0].length;
  }
  return null;
}

/**
 * Replace the `<!-- CONTENT -->` marker in the scaffold with the body HTML.
 */
export function injectIntoScaffold(scaffold: string, body: string): string {
  return scaffold.replace(/<!--\s*CONTENT\s*-->/, body);
}

/**
 * Render a verbose Markdown brief as a self-contained HTML page. Calls
 * Gemini, extracts the `<main>` body from its output, and injects that
 * body into the minimal scaffold so the page styling is always ours.
 *
 * On any Gemini-side failure, throws — the caller (receiver-brief) falls
 * back to the verbatim brief.
 */
export async function distillToHtmlAndMarkdown(
  brief: string,
  _agentId: AgentId,
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
            `Render the following Markdown brief as HTML using the minimal scaffold provided. ` +
            `Output the complete \`<!doctype html>\` document.\n\n` +
            `---\n\n` +
            `MINIMAL SCAFFOLD (use as the base; replace the <!-- CONTENT --> marker):\n\n` +
            MINIMAL_HTML_SCAFFOLD +
            `\n\n---\n\n` +
            `BRIEF:\n\n${brief}\n`,
        },
      ],
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

  const body = extractMainContent(content);
  const html = body !== null ? injectIntoScaffold(MINIMAL_HTML_SCAFFOLD, body) : content;

  return { markdown: brief, html };
}
