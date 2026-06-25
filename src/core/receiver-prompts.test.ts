import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MINIMAL_HTML_SCAFFOLD,
  RECEIVER_SYSTEM_PROMPT,
  distillToHtmlAndMarkdown,
  extractMainContent,
  injectIntoScaffold,
} from "./receiver-prompts.js";

// ----- MINIMAL_HTML_SCAFFOLD shape ---------------------------------------

test("MINIMAL_HTML_SCAFFOLD: starts with <!doctype html>", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /^<!doctype html>/i);
});

test("MINIMAL_HTML_SCAFFOLD: contains inline <style> block (no external CSS deps)", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /<style>/);
  // No <link rel="stylesheet" href="..."> to external CSS.
  assert.doesNotMatch(MINIMAL_HTML_SCAFFOLD, /<link[^>]+rel=["']stylesheet["']/);
});

test("MINIMAL_HTML_SCAFFOLD: contains no Tailwind CDN", () => {
  assert.doesNotMatch(MINIMAL_HTML_SCAFFOLD, /cdn\.tailwindcss\.com/i);
});

test("MINIMAL_HTML_SCAFFOLD: contains no Mermaid CDN", () => {
  assert.doesNotMatch(MINIMAL_HTML_SCAFFOLD, /mermaid/i);
});

test("MINIMAL_HTML_SCAFFOLD: contains no fixed-section placeholders", () => {
  // Old scaffold had {{objective_body}}, {{current_state_body}}, etc.
  for (const placeholder of [
    "objective_body",
    "current_state_body",
    "completed_steps_body",
    "failed_approaches_body",
    "next_steps_body",
    "raw_appendix_body",
    "topic_chips",
  ]) {
    assert.doesNotMatch(
      MINIMAL_HTML_SCAFFOLD,
      new RegExp(`\\{\\{${placeholder}\\}\\}`),
      `scaffold should not contain {{${placeholder}}}`,
    );
  }
});

test("MINIMAL_HTML_SCAFFOLD: contains a <!-- CONTENT --> marker for body injection", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /<!--\s*CONTENT\s*-->/);
});

test("MINIMAL_HTML_SCAFFOLD: defines a comfortable max-width for the main column", () => {
  // The max-width is set in the <style> block, not as an inline attribute.
  assert.match(MINIMAL_HTML_SCAFFOLD, /max-width:\s*48rem/);
});

// ----- MINIMAL_HTML_SCAFFOLD design palette -------------------------------

test("MINIMAL_HTML_SCAFFOLD: declares the Claude warm-editorial palette as CSS custom properties", () => {
  // The palette is a set of named tokens mirroring DESIGN.md, not raw hex
  // scattered through selectors — that way future tweaks happen in one place.
  for (const token of [
    "--canvas",
    "--surface-soft",
    "--surface-card",
    "--surface-dark",
    "--ink",
    "--body-strong",
    "--body",
    "--muted",
    "--muted-soft",
    "--hairline",
    "--coral",
    "--coral-active",
    "--on-dark",
  ]) {
    assert.match(
      MINIMAL_HTML_SCAFFOLD,
      new RegExp(`${token}\\s*:`),
      `scaffold should declare the ${token} design token`,
    );
  }
});

test("MINIMAL_HTML_SCAFFOLD: cream canvas + coral accent are the brand colors", () => {
  // Canvas is the tinted cream floor; coral is the signature accent on links.
  assert.match(MINIMAL_HTML_SCAFFOLD, /--canvas\s*:\s*#faf9f5/i);
  assert.match(MINIMAL_HTML_SCAFFOLD, /--coral\s*:\s*#cc785c/i);
  assert.match(MINIMAL_HTML_SCAFFOLD, /a\s*\{[^}]*color:\s*var\(--coral\)/);
});

test("MINIMAL_HTML_SCAFFOLD: loads the editorial font families via @import (no external <link>)", () => {
  // Cormorant Garamond / Inter / JetBrains Mono load inside the <style>
  // block, so the document stays a single file with no stylesheet link.
  assert.match(MINIMAL_HTML_SCAFFOLD, /@import\s+url\(['"]https:\/\/fonts\.googleapis\.com/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /Cormorant\+Garamond/);
});

test("MINIMAL_HTML_SCAFFOLD: h1 and h2 use the serif display font token", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /h1\s*\{[^}]*font-family:\s*var\(--font-display\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /h2\s*\{[^}]*font-family:\s*var\(--font-display\)/);
  // The display token resolves to a serif stack.
  assert.match(MINIMAL_HTML_SCAFFOLD, /--font-display:[^;}]*serif/i);
});

test("MINIMAL_HTML_SCAFFOLD: h2 is a serif section head separated by a hairline rule", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /h2\s*\{[^}]*border-top:[^;}]*var\(--hairline\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /h2\s*\{[^}]*color:\s*var\(--ink\)/);
});

test("MINIMAL_HTML_SCAFFOLD: metadata <dl> renders as a cream card and ordered lists use coral numerals", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /dl\s*\{[^}]*background:\s*var\(--surface-card\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /ol\s*>\s*li::before\s*\{[^}]*counter\(item\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /ol\s*>\s*li::before\s*\{[^}]*color:\s*var\(--coral\)/);
});

test("MINIMAL_HTML_SCAFFOLD: code blocks sit on the dark navy product surface", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /pre\s*\{[^}]*background:\s*var\(--surface-dark\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /pre\s*\{[^}]*color:\s*var\(--on-dark\)/);
});

test("MINIMAL_HTML_SCAFFOLD: blockquote is a coral-accented cream callout", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /blockquote\s*\{[^}]*border-left:[^;}]*var\(--coral\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /blockquote\s*\{[^}]*background:\s*var\(--surface-soft\)/);
});

test("MINIMAL_HTML_SCAFFOLD: details/summary are styled for the collapsed raw appendix", () => {
  // The details panel has rounded corners and a cream-card surface with a
  // hairline border and an uppercase eyebrow summary.
  assert.match(MINIMAL_HTML_SCAFFOLD, /details\s*\{[^}]*border:\s*1px\s+solid\s+var\(--hairline\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /details\s*\{[^}]*background:\s*var\(--surface-card\)/);
  assert.match(MINIMAL_HTML_SCAFFOLD, /details summary[^}]*text-transform:\s*uppercase/);
});

test("MINIMAL_HTML_SCAFFOLD: declares color-scheme: light to prevent browser auto-inversion in dark mode", () => {
  // Without a color-scheme declaration, Chrome/Firefox auto-invert light
  // pages when the system is in dark mode, turning cream→dark and dark
  // text→white. The meta tag and/or CSS :root rule prevents this.
  assert.match(
    MINIMAL_HTML_SCAFFOLD,
    /<meta[^>]*color-scheme[^>]*light/i,
    "should have a color-scheme meta tag",
  );
  assert.match(
    MINIMAL_HTML_SCAFFOLD,
    /color-scheme:\s*light/i,
    "should declare color-scheme: light in the CSS",
  );
});

test("MINIMAL_HTML_SCAFFOLD: applies a print stylesheet so the brief prints cleanly", () => {
  assert.match(MINIMAL_HTML_SCAFFOLD, /@media\s+print/);
});

// ----- RECEIVER_SYSTEM_PROMPT contract -----------------------------------

test("RECEIVER_SYSTEM_PROMPT: does not request JSON output", () => {
  assert.doesNotMatch(RECEIVER_SYSTEM_PROMPT, /response_format/);
  assert.doesNotMatch(RECEIVER_SYSTEM_PROMPT, /json_object/);
  assert.doesNotMatch(RECEIVER_SYSTEM_PROMPT, /JSON object/i);
});

test("RECEIVER_SYSTEM_PROMPT: instructs the model to emit a body fragment, not a full document", () => {
  // The page owns all chrome; Gemini emits only the body fragment.
  assert.match(RECEIVER_SYSTEM_PROMPT, /body fragment/i);
  // It must forbid the document wrapper, not request one.
  assert.match(RECEIVER_SYSTEM_PROMPT, /no\s+`?<!doctype html>`?/i);
  assert.doesNotMatch(RECEIVER_SYSTEM_PROMPT, /complete\s+html\s+document/i);
});

test("RECEIVER_SYSTEM_PROMPT: requires verbatim preservation of the input markdown", () => {
  assert.match(RECEIVER_SYSTEM_PROMPT, /preserve\s+every\s+word/i);
  assert.match(RECEIVER_SYSTEM_PROMPT, /verbatim/i);
});

test("RECEIVER_SYSTEM_PROMPT: tells the model to use semantic HTML and let the scaffold style it", () => {
  // The prompt is design-aware: it points at the scaffold's styling and
  // forbids inline styles / extra <style> blocks / extra CSS classes.
  assert.match(RECEIVER_SYSTEM_PROMPT, /semantic html/i);
  assert.match(RECEIVER_SYSTEM_PROMPT, /no inline styles/i);
  assert.match(RECEIVER_SYSTEM_PROMPT, /<style>/);
});

test("RECEIVER_SYSTEM_PROMPT: tells the model to collapse the raw appendix in <details>", () => {
  // The appendix is long; the brief is more scannable with it collapsed.
  assert.match(RECEIVER_SYSTEM_PROMPT, /<details>/i);
  assert.match(RECEIVER_SYSTEM_PROMPT, /raw context appendix/i);
});

// ----- extractMainContent ------------------------------------------------

test("extractMainContent: returns inner content of <main> when present", () => {
  const html = "<!doctype html><html><body><main><h1>hi</h1></main></body></html>";
  assert.equal(extractMainContent(html), "<h1>hi</h1>");
});

test("extractMainContent: returns body inner content when no <main>", () => {
  const html = "<!doctype html><html><body><h1>hi</h1></body></html>";
  assert.equal(extractMainContent(html), "<h1>hi</h1>");
});

test("extractMainContent: returns null when neither <main> nor <body> is present", () => {
  assert.equal(extractMainContent("just a fragment"), null);
});

test("extractMainContent: handles nested <main> correctly (inner of outermost)", () => {
  const html = "<main>outer<main>inner</main>tail</main>";
  assert.equal(extractMainContent(html), "outer<main>inner</main>tail");
});

// ----- injectIntoScaffold -----------------------------------------------

test("injectIntoScaffold: replaces <!-- CONTENT --> marker with body", () => {
  const result = injectIntoScaffold("before<!-- CONTENT -->after", "PAYLOAD");
  assert.equal(result, "beforePAYLOADafter");
});

test("injectIntoScaffold: preserves scaffold structure around the injection", () => {
  const scaffold = "<!doctype html><body><main><!-- CONTENT --></main></body>";
  const result = injectIntoScaffold(scaffold, "<h1>brief</h1>");
  assert.match(result, /<!doctype html>/);
  assert.match(result, /<h1>brief<\/h1>/);
  assert.match(result, /<main><h1>brief<\/h1><\/main>/);
});

// ----- distillToHtmlAndMarkdown -----------------------------------------

test("distillToHtmlAndMarkdown: throws when GEMINI_API_KEY is missing", async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(() => distillToHtmlAndMarkdown("# Brief", "pi"), /GEMINI_API_KEY/);
});

test("distillToHtmlAndMarkdown: returns the input brief verbatim as markdown", async () => {
  const originalFetch = globalThis.fetch;
  const brief = "# Handoff Brief: foo\n\n## Current State\n\n`src/core/distiller.ts` line 42.\n";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "<!doctype html><body><main><h1>Handoff Brief: foo</h1></main></body>",
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const out = await distillToHtmlAndMarkdown(brief, "pi");
    assert.equal(out.markdown, brief, "markdown is the verbatim input brief");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillToHtmlAndMarkdown: extracts <main> body from Gemini's HTML and injects into scaffold", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "<!doctype html><html><body><main><h1>Brief</h1><p>body</p></main></body></html>",
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const out = await distillToHtmlAndMarkdown("# Brief", "pi");
    // The Gemini <main> body is injected into the scaffold's <!-- CONTENT --> marker.
    assert.match(out.html, /<h1>Brief<\/h1><p>body<\/p>/);
    // The scaffold's styling is preserved (no Tailwind CDN).
    assert.doesNotMatch(out.html, /cdn\.tailwindcss\.com/i);
    assert.match(out.html, /^<!doctype html>/i);
    // The original <!-- CONTENT --> marker is gone.
    assert.doesNotMatch(out.html, /<!--\s*CONTENT\s*-->/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillToHtmlAndMarkdown: injects a bare fragment straight into the scaffold (single masthead)", async () => {
  const originalFetch = globalThis.fetch;
  // The new contract: Gemini emits only a body fragment, no document wrapper.
  const fragment = "<h1>Context Handoff</h1><p>body</p>";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: fragment } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const out = await distillToHtmlAndMarkdown("# Brief", "pi");
    // The page is always the scaffold — exactly one masthead header.
    assert.match(out.html, /^<!doctype html>/i);
    assert.equal((out.html.match(/<header>/gi) || []).length, 1, "only the scaffold masthead");
    // The fragment is injected verbatim.
    assert.match(out.html, /<h1>Context Handoff<\/h1><p>body<\/p>/);
    assert.doesNotMatch(out.html, /<!--\s*CONTENT\s*-->/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillToHtmlAndMarkdown: throws on non-OK response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    await assert.rejects(
      () => distillToHtmlAndMarkdown("# Brief", "pi"),
      /Gemini request failed \(429\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

test("distillToHtmlAndMarkdown: does NOT use response_format: json_object", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    capturedBody = JSON.parse((init as RequestInit).body as string);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "<!doctype html><body><main>x</main></body>" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    await distillToHtmlAndMarkdown("# Brief", "pi");
    assert.equal(capturedBody?.response_format, undefined, "no JSON response_format");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});
