import { test } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt } from "./crypto.js";

test("crypto: roundtrip with correct password", () => {
  const plaintext = "hello, context handoff";
  const payload = encrypt(plaintext, "correct-horse-battery-staple");
  assert.equal(decrypt(payload, "correct-horse-battery-staple"), plaintext);
});

test("crypto: each call produces a fresh salt and iv", () => {
  const a = encrypt("same", "pw");
  const b = encrypt("same", "pw");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("crypto: wrong password throws INVALID_PASSWORD", () => {
  const payload = encrypt("secret", "right");
  assert.throws(() => decrypt(payload, "wrong"), /INVALID_PASSWORD/);
});

test("crypto: tampered ciphertext throws INVALID_PASSWORD", () => {
  const payload = encrypt("secret", "pw");
  // Flip a bit in the middle of the ciphertext (well before the GCM tag).
  const buf = Buffer.from(payload.ciphertext, "base64");
  buf[0] ^= 0x01;
  const tampered = { ...payload, ciphertext: buf.toString("base64") };
  assert.throws(() => decrypt(tampered, "pw"), /INVALID_PASSWORD/);
});

test("crypto: tampered auth tag throws INVALID_PASSWORD", () => {
  const payload = encrypt("secret", "pw");
  const buf = Buffer.from(payload.ciphertext, "base64");
  // Flip a byte in the trailing 16-byte GCM tag.
  buf[buf.length - 1] ^= 0xff;
  const tampered = { ...payload, ciphertext: buf.toString("base64") };
  assert.throws(() => decrypt(tampered, "pw"), /INVALID_PASSWORD/);
});

test("crypto: ciphertext too short throws a clear error", () => {
  const tiny = { salt: "AAAA", iv: "AAAA", ciphertext: Buffer.alloc(8).toString("base64") };
  assert.throws(() => decrypt(tiny, "pw"), /corrupt/i);
});

test("crypto: handles unicode plaintext", () => {
  const text = "日本語 — emoji 🦊 — accents é à";
  const payload = encrypt(text, "pw");
  assert.equal(decrypt(payload, "pw"), text);
});

test("crypto: payload shape is base64 strings", () => {
  const payload = encrypt("x", "pw");
  // base64 chars only, no padding equality on purpose — just structural.
  for (const field of ["salt", "iv", "ciphertext"] as const) {
    assert.match(payload[field], /^[A-Za-z0-9+/]+=*$/);
  }
});