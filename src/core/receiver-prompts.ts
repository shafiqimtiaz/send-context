import { AgentId } from "../adapters/index.js";

/**
 * Receiver-side Gemini generation. The receiver decrypts the sender's
 * verbose Markdown brief, then (when a key is set) calls Gemini to render
 * the brief as a semantic HTML body fragment, which is injected into our
 * own scaffold for human review. When no key is set, the receiver skips
 * this step and writes the decrypted markdown verbatim — graceful degrade.
 *
 * Same OpenAI-compatible endpoint as the sender side; no SDK.
 */
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const DEFAULT_MODEL = "gemini-3.1-flash-lite";

export const RECEIVER_SYSTEM_PROMPT = `You are rendering a verbose Markdown handoff brief as semantic HTML for human review. The brief is inserted into a pre-styled page, so output ONLY a body fragment: no \`<!doctype html>\`, no \`<html>\`/\`<head>\`/\`<body>\`/\`<main>\` wrapper, and no page masthead or repo-link chrome (the page already shows the product title). Begin directly with the brief's first element.

Preservation rules:
- Preserve every word from the input Markdown verbatim. Do not paraphrase, summarize, or "tighten" the brief.
- Preserve all code fences, file paths, commands, error messages, and identifiers exactly as written.
- Preserve all heading levels and bullet structure.

Styling rules:
- The page owns ALL visual styling (the Claude/Anthropic warm-editorial system). Do not describe, replicate, or add any styling: no inline styles, no CSS classes, no \`id\` attributes, no \`<style>\` blocks. Your only job is to emit clean, well-structured semantic HTML; the page makes it beautiful.
- Use semantic HTML only: \`<h1>\`, \`<h2>\`, \`<h3>\`, \`<p>\`, \`<ul>\`, \`<ol>\`, \`<li>\`, \`<dl>\`, \`<dt>\`, \`<dd>\`, \`<pre>\`, \`<code>\`, \`<blockquote>\`, \`<table>\`, \`<thead>\`, \`<tbody>\`, \`<tr>\`, \`<th>\`, \`<td>\`, \`<hr>\`, \`<strong>\`, \`<em>\`, \`<a>\`, \`<details>\`, \`<summary>\`.
- The first \`<h1>\` in the brief is the page title — leave it as the only \`<h1>\`.
- METADATA: the bold lines immediately after the \`<h1>\` (e.g. \`**Source Agent:** …\`, \`**Timestamp:** …\`, \`**Original Task:** …\`) must be converted into ONE \`<dl>\` block — one \`<dt>\`/\`<dd>\` pair per line, where \`<dt>\` is the bold label (without the trailing colon or asterisks) and \`<dd>\` is the value. Preserve all words and any inline \`<code>\` in the value. Emit nothing else between the \`<h1>\` and the first \`<h2>\`.
- \`<h2>\` elements are top-level section headings — leave their text as-is; the page renders them as serif section heads separated by a hairline rule. Do not number them yourself.
- \`<h3>\` elements are subsection headings within a section.
- Keep the original list type from the Markdown — ORDERED (\`<ol>\`) for sequenced steps, UNORDERED (\`<ul>\`) otherwise; the page styles each appropriately.
- The "Raw Context Appendix" section is long and noisy. Wrap its body content (the \`<h3>\` message labels and the \`<hr>\` separators) in \`<details><summary>Raw context (N messages)</summary>…</details>\` so it stays collapsed by default. Keep the \`<h2>\` "## Raw Context Appendix" itself outside the \`<details>\`.
- Inside the \`<details>\`, join consecutive messages with a single \`<hr>\` separator (do not add a leading or trailing \`<hr>\`).

Output only the HTML fragment — no \`<!doctype html>\`, no wrapper tags, no JSON wrapper, no commentary.`;

/**
 * Warm-editorial HTML scaffold for the receiver's HTML preview, following
 * the Claude/Anthropic design language: a tinted cream canvas, warm-ink
 * text, a slab-serif display face for headings, a humanist sans for body,
 * JetBrains Mono on dark-navy code surfaces, and a single coral accent.
 *
 * The design tokens below mirror docs/DESIGN.md — the source-of-truth for
 * this palette, typography, spacing, and component language. Keep them in
 * sync: edit docs/DESIGN.md first, then reflect the change here.
 *
 * Single-file: all CSS is inline. Display/body/mono fonts load via an
 * \`@import\` inside the \`<style>\` block (Cormorant Garamond, Inter,
 * JetBrains Mono — the documented open substitutes for the licensed
 * Copernicus / StyreneB) and degrade gracefully to system stacks offline.
 * There is no external \`<link rel="stylesheet">\`, no Tailwind, no Mermaid,
 * and no fixed-section placeholders. Gemini emits the body and the scaffold
 * injects it at the \`<!-- CONTENT -->\` marker; the CSS targets the bare
 * semantic elements Gemini produces (h1, h2, h3, p, ul, ol, li, dl, dt, dd,
 * pre, code, blockquote, table, hr, strong, em, a, details, summary).
 */
export const MINIMAL_HTML_SCAFFOLD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Handoff Brief</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

  /* ----------------------------------------------------------------------
     Claude / Anthropic warm-editorial system.
     Canvas: tinted cream. Accent: coral, used scarcely. Code: dark navy.
     Type: Cormorant Garamond serif display / Inter body / JetBrains Mono.
     Tokens mirror the DESIGN.md palette so tweaks happen in one place.
     ---------------------------------------------------------------------- */

  :root {
    color-scheme: light;
    /* surface */
    --canvas: #faf9f5;               /* tinted cream — page floor */
    --surface-soft: #f5f0e8;         /* soft band / blockquote wash */
    --surface-card: #efe9de;         /* cream cards — dl, table head, details */
    --surface-cream-strong: #e8e0d2; /* strongest cream — emphasis */
    --surface-dark: #181715;         /* dark navy — code blocks */
    --surface-dark-soft: #1f1e1b;    /* inner code surface */
    --surface-dark-elevated: #252320;/* elevated dark */
    /* ink + text */
    --ink: #141413;                  /* headlines, primary */
    --body-strong: #252523;          /* emphasized text */
    --body: #3d3d3a;                 /* running text */
    --muted: #6c6a64;                /* labels, captions */
    --muted-soft: #8e8b82;           /* fine print, markers */
    --on-dark: #faf9f5;              /* text on dark surfaces */
    --on-dark-soft: #a09d96;         /* secondary on dark */
    /* line */
    --hairline: #e6dfd8;             /* 1px borders on cream */
    --hairline-soft: #ebe6df;        /* faint in-band divider */
    /* brand + accent */
    --coral: #cc785c;                /* signature accent — links, emphasis */
    --coral-active: #a9583e;         /* darker press/hover */
    --coral-soft: rgba(204, 120, 92, 0.12);
    --accent-teal: #5db8a6;
    --accent-amber: #e8a55a;
    /* semantic */
    --success: #5db872;
    --warning: #d4a017;
    --error: #c64545;
    /* shadow (rare, low alpha) */
    --shadow-sm: 0 1px 3px rgba(20, 20, 19, 0.06);
    --shadow-md: 0 18px 40px -24px rgba(20, 20, 19, 0.45);
    /* type */
    --font-display: "Cormorant Garamond", "Tiempos Headline", "EB Garamond", Garamond, "Iowan Old Style", Georgia, "Times New Roman", serif;
    --font-body: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }

  body {
    margin: 0;
    background: var(--canvas);
    color: var(--body);
    font-family: var(--font-body);
    font-size: 16px;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }

  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 4.5rem 1.5rem 6rem;
  }

  /* ---- Masthead: branded title + repo link (scaffold chrome) -------- */
  main > header {
    margin: 0 0 2.5rem;
    padding: 0 0 1.5rem;
    border-bottom: 1px solid var(--hairline);
  }
  main > header h1 {
    font-family: var(--font-display);
    font-size: clamp(2.75rem, 6vw, 4rem);
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.025em;
    margin: 0;
    padding: 0;
    border: none;
  }
  main > header h1 a {
    color: var(--ink);
    border-bottom: none;
  }
  main > header h1 a:hover { color: var(--coral); }
  main > header p {
    margin: 0.65rem 0 0;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--muted);
  }
  main > header p a {
    color: var(--muted);
    border-bottom: none;
  }
  main > header p a:hover { color: var(--coral); }
  /* The brief carries its own <h1> title ("Context Handoff"); the masthead
     replaces it, so hide the injected content title to avoid duplication. */
  main > header ~ h1 { display: none; }

  /* ---- H1: serif editorial title (content fallback) ----------------- */
  h1 {
    font-family: var(--font-display);
    font-size: clamp(2.75rem, 6vw, 4rem);
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.025em;
    color: var(--ink);
    margin: 0 0 1.75rem;
    padding: 0 0 1.5rem;
    border-bottom: 1px solid var(--hairline);
  }

  /* ---- Metadata card (the bold lines → <dl>) ------------------------ */
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0 1.75rem;
    margin: 0 0 3rem;
    padding: 0.5rem 1.5rem 1.1rem;
    background: var(--surface-card);
    border-radius: 12px;
    font-size: 0.95rem;
  }
  dt {
    font-size: 0.72rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    padding-top: 1.05rem;
    white-space: nowrap;
  }
  dd {
    margin: 0;
    padding-top: 0.95rem;
    color: var(--body-strong);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* ---- H2: serif section head, hairline above ---------------------- */
  h2 {
    font-family: var(--font-display);
    font-size: clamp(1.85rem, 3.5vw, 2.35rem);
    font-weight: 600;
    line-height: 1.12;
    letter-spacing: -0.015em;
    color: var(--ink);
    margin: 3.75rem 0 1.35rem;
    padding-top: 2.5rem;
    border-top: 1px solid var(--hairline);
  }

  /* ---- H3: serif subsection ---------------------------------------- */
  h3 {
    font-family: var(--font-display);
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 2.25rem 0 0.6rem;
    line-height: 1.25;
  }

  p { margin: 0 0 1.15rem; color: var(--body); }

  /* ---- Ordered lists: coral serif numerals -------------------------- */
  ol {
    list-style: none;
    counter-reset: item;
    margin: 0 0 1.3rem;
    padding: 0;
  }
  ol > li {
    counter-increment: item;
    position: relative;
    padding-left: 2.4rem;
    margin: 0.6rem 0;
  }
  ol > li::before {
    content: counter(item) ".";
    position: absolute;
    left: 0;
    top: 0;
    width: 1.8rem;
    text-align: right;
    font-family: var(--font-display);
    font-size: 1.15rem;
    font-weight: 600;
    line-height: 1.5;
    color: var(--coral);
  }

  /* ---- Unordered lists: coral marker -------------------------------- */
  ul {
    list-style: none;
    margin: 0 0 1.3rem;
    padding-left: 1.5rem;
  }
  ul > li {
    position: relative;
    padding-left: 0.85rem;
    margin: 0.45rem 0;
  }
  ul > li::before {
    content: "";
    position: absolute;
    left: -0.35rem;
    top: 0.68em;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: var(--coral);
  }
  li ul, li ol { margin: 0.4rem 0 0.55rem; }
  ol > li ol > li::before { color: var(--muted); }
  ul > li ul > li::before { background: var(--muted-soft); }

  /* ---- Inline code -------------------------------------------------- */
  code {
    font-family: var(--font-mono);
    font-size: 0.82em;
    color: var(--body-strong);
    background: var(--surface-card);
    padding: 0.14em 0.42em;
    border-radius: 6px;
  }

  /* ---- Code blocks — dark navy product surface ---------------------- */
  pre {
    background: var(--surface-dark);
    color: var(--on-dark);
    padding: 1.3rem 1.5rem;
    border-radius: 12px;
    overflow-x: auto;
    line-height: 1.6;
    margin: 0 0 1.5rem;
    font-size: 0.86rem;
    box-shadow: var(--shadow-md);
  }
  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
    color: inherit;
  }

  /* ---- Blockquote — coral-accented cream callout -------------------- */
  blockquote {
    margin: 1.5rem 0;
    padding: 1rem 1.5rem;
    border-left: 3px solid var(--coral);
    background: var(--surface-soft);
    border-radius: 0 10px 10px 0;
    color: var(--body-strong);
  }
  blockquote p { margin: 0.4rem 0; color: inherit; }
  blockquote p:last-child { margin-bottom: 0; }

  /* ---- Horizontal rule ---------------------------------------------- */
  hr {
    border: none;
    border-top: 1px solid var(--hairline);
    margin: 2rem 0;
  }

  /* ---- Tables — cream card ------------------------------------------ */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 1.5rem;
    font-size: 0.92rem;
    background: var(--canvas);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    overflow: hidden;
  }
  th, td {
    text-align: left;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--hairline);
    color: var(--body);
  }
  th {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    background: var(--surface-card);
  }
  tr:last-child td { border-bottom: none; }

  /* ---- Details/summary — collapsed raw appendix --------------------- */
  details {
    margin: 0 0 1.5rem;
    border: 1px solid var(--hairline);
    border-radius: 12px;
    background: var(--surface-card);
    overflow: hidden;
  }
  details summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.95rem 1.25rem;
    font-size: 0.72rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    list-style: none;
    user-select: none;
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::before {
    content: "+";
    font-family: var(--font-mono);
    color: var(--coral);
    font-size: 0.95rem;
    line-height: 1;
    transition: transform 0.2s ease;
  }
  details[open] summary::before { content: "\\2013"; }
  details[open] summary { border-bottom: 1px solid var(--hairline); }
  details > *:not(summary) { padding-left: 1.25rem; padding-right: 1.25rem; background: var(--canvas); }
  details > *:not(summary):first-of-type { padding-top: 1rem; }
  details > *:not(summary):last-child { padding-bottom: 1rem; }
  details h3:first-of-type { margin-top: 0.6rem; }

  /* ---- Links — the coral inline accent ------------------------------ */
  a {
    color: var(--coral);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  a:hover { color: var(--coral-active); border-bottom-color: currentColor; }

  strong { font-weight: 600; color: var(--body-strong); }
  em { color: var(--body); }

  ::selection { background: var(--coral-soft); color: var(--ink); }

  /* ---- Print -------------------------------------------------------- */
  @media print {
    body { background: #fff; color: #000; }
    main { max-width: none; padding: 0; }
    pre { box-shadow: none; }
    h2, h3 { break-after: avoid; }
    pre, blockquote, details, table { break-inside: avoid; }
    details[open] { break-inside: avoid; }
  }
</style>
</head>
<body>
<main>
<header>
<h1><a href="https://www.npmjs.com/package/ctx-handoff">Ctx Handoff</a></h1>
<p><a href="https://github.com/shafiqimtiaz/ctx-handoff">github.com/shafiqimtiaz/ctx-handoff</a></p>
</header>
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
 * Gemini for a bare body fragment, then injects that fragment into the
 * minimal scaffold so the page chrome and styling are always ours — the
 * model never sees or reproduces the scaffold, so the masthead cannot be
 * duplicated. If the model ignores the contract and returns a full
 * document, the `<main>`/`<body>` inner is unwrapped before injection.
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
            `Render the following Markdown brief as an HTML body fragment for insertion ` +
            `into a pre-styled page. Output only the fragment — no document wrapper, no masthead.\n\n` +
            `---\n\n` +
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

  // Gemini is asked for a bare body fragment. Defensively unwrap a full
  // document down to its <main>/<body> inner if it ignored that; otherwise
  // use the fragment as-is. Either way the page is always our scaffold, so
  // the masthead can never be duplicated.
  const fragment = extractMainContent(content) ?? content;
  const html = injectIntoScaffold(MINIMAL_HTML_SCAFFOLD, fragment.trim());

  return { markdown: brief, html };
}
