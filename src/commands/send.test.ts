import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkerHost, DEFAULT_WORKER_HOST } from "./send.js";

test("resolveWorkerHost: --worker flag wins over env and default", () => {
  assert.equal(
    resolveWorkerHost({ worker: "flag.example.com" }, { CTX_HANDOFF_WORKER: "env.example.com" }),
    "flag.example.com",
  );
});

test("resolveWorkerHost: env wins over default when --worker is absent", () => {
  assert.equal(resolveWorkerHost({}, { CTX_HANDOFF_WORKER: "env.example.com" }), "env.example.com");
});

test("resolveWorkerHost: falls back to DEFAULT_WORKER_HOST when neither --worker nor env is set", () => {
  assert.equal(resolveWorkerHost({}, {}), DEFAULT_WORKER_HOST);
});

test("resolveWorkerHost: empty-string env falls back to DEFAULT_WORKER_HOST", () => {
  // `export CTX_HANDOFF_WORKER=` produces an empty string in process.env,
  // distinct from unset. Treat it the same as unset.
  assert.equal(resolveWorkerHost({}, { CTX_HANDOFF_WORKER: "" }), DEFAULT_WORKER_HOST);
});

test("DEFAULT_WORKER_HOST: has no trailing slash (so URL construction is `host + '/upload'`, not `host + '//upload'`)", () => {
  assert.equal(DEFAULT_WORKER_HOST, "https://ctx-handoff.shafiqimtiaz.deno.net");
  assert.doesNotMatch(DEFAULT_WORKER_HOST, /\/$/, "must not end with a slash");
});
