/**
 * Handoff transport — Deno Deploy + Deno KV.
 *
 * Zero-knowledge: only ever stores already-encrypted {salt, iv, ciphertext}
 * blobs. Records auto-expire after 24h via Deno KV's native `expireIn`.
 *
 *   POST /upload         body: {salt, iv, ciphertext}  -> {id}
 *   GET  /download/:id                                 -> {salt, iv, ciphertext}
 *
 * Run locally:  deno run --unstable-kv --allow-net main.ts
 * Deploy:       deployctl deploy --prod main.ts   (or connect the GitHub repo)
 */

const kv = await Deno.openKv();

// Deno KV caps a single value at 64 KiB, so we keep the encrypted JSON under
// that. A curated handoff is far smaller; oversized ones are rejected clearly.
const MAX_BYTES = 60_000;
const TTL_MS = 1000 * 60 * 60 * 24; // 24h
const ID_BYTES = 16;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/upload") {
    return await handleUpload(req);
  }
  if (req.method === "GET" && url.pathname.startsWith("/download/")) {
    return await handleDownload(url.pathname.slice("/download/".length));
  }
  return json({ error: "Not found" }, 404);
});

async function handleUpload(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return json(
      { error: `Payload too large (limit ${MAX_BYTES} bytes — include fewer appendix messages).` },
      413,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!isPayload(body)) {
    return json({ error: "Expected {salt, iv, ciphertext}" }, 400);
  }

  const id = randomId();
  await kv.set(["handoff", id], body, { expireIn: TTL_MS });
  return json({ id }, 201);
}

async function handleDownload(id: string): Promise<Response> {
  if (!id) return json({ error: "Missing id" }, 400);
  const entry = await kv.get(["handoff", id]);
  if (entry.value === null) {
    return json({ error: "Not found or expired" }, 404);
  }
  return json(entry.value, 200);
}

function isPayload(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.salt === "string" &&
    typeof r.iv === "string" &&
    typeof r.ciphertext === "string"
  );
}

function randomId(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
