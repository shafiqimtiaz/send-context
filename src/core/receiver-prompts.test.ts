import { test } from "node:test";
import assert from "node:assert/strict";
import { RECEIVER_SYSTEM_PROMPT, RECEIVER_HTML_SCAFFOLD, distillToHtmlAndMarkdown } from "./receiver-prompts.js";

test("RECEIVER_SYSTEM_PROMPT references both markdown and html", () => {
  assert.match(RECEIVER_SYSTEM_PROMPT, /markdown/);
  assert.match(RECEIVER_SYSTEM_PROMPT, /html/i);
});

test("RECEIVER_HTML_SCAFFOLD includes Tailwind and Mermaid CDN", () => {
  assert.match(RECEIVER_HTML_SCAFFOLD, /cdn\.tailwindcss\.com/);
  assert.match(RECEIVER_HTML_SCAFFOLD, /mermaid/);
});

test("RECEIVER_HTML_SCAFFOLD has all placeholder slots", () => {
  for (const ph of [
    "{{title}}", "{{source_agent}}", "{{date}}", "{{topic_chips}}",
    "{{objective_body}}", "{{current_state_body}}", "{{completed_steps_body}}",
    "{{failed_approaches_body}}", "{{next_steps_body}}", "{{raw_appendix_body}}",
  ]) {
    assert.match(RECEIVER_HTML_SCAFFOLD, new RegExp(ph.replace(/[{}]/g, "\\$&")));
  }
});

test("RECEIVER_HTML_SCAFFOLD is a complete HTML document", () => {
  assert.match(RECEIVER_HTML_SCAFFOLD, /<!doctype html>/i);
  assert.match(RECEIVER_HTML_SCAFFOLD, /<html/);
  assert.match(RECEIVER_HTML_SCAFFOLD, /<\/html>/);
});

test("distillToHtmlAndMarkdown parses a normal Gemini response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        markdown: "# Handoff\n\n## 1. Primary Objective\n- a",
        html: "<!doctype html><html><body>rendered</body></html>",
      }) } }],
    }), { status: 200 });

  try {
    const out = await distillToHtmlAndMarkdown("# input", "claude");
    assert.equal(out.markdown.startsWith("# Handoff"), true);
    assert.equal(out.html.startsWith("<!doctype html>"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("distillToHtmlAndMarkdown repairs malformed JSON via jsonrepair", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: '{ "markdown": "x", "html": "y",' } }],
    }), { status: 200 });

  try {
    const out = await distillToHtmlAndMarkdown("# input", "pi");
    assert.equal(out.markdown, "x");
    assert.equal(out.html, "y");
  } finally {
    globalThis.fetch = original;
  }
});

test("distillToHtmlAndMarkdown throws when response is missing fields", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ markdown: "x" }) } }],
    }), { status: 200 });

  try {
    await assert.rejects(
      () => distillToHtmlAndMarkdown("# input", "opencode"),
      /missing markdown or html/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("distillToHtmlAndMarkdown throws on non-OK HTTP", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });

  try {
    await assert.rejects(
      () => distillToHtmlAndMarkdown("# input", "pi"),
      /429/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
