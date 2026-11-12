import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { readJson } from "../shared/http.js";

const request = (chunks: Buffer[]) => ({ async *[Symbol.asyncIterator]() { yield* chunks; } }) as IncomingMessage;

test("JSON body decoding preserves UTF-8 across every possible chunk boundary", async () => {
  const value = { note: "café — 支払い 💸" };
  const bytes = Buffer.from(JSON.stringify(value));
  for (let i = 1; i < bytes.length; i++)
    assert.deepEqual(await readJson(request([bytes.subarray(0, i), bytes.subarray(i)])), value);
});

test("JSON body limit counts bytes, including multibyte characters", async () => {
  const bytes = Buffer.from(JSON.stringify({ note: "é".repeat(9_000) }));
  await assert.rejects(readJson(request([bytes])), /too large/);
  assert.deepEqual(await readJson(request([Buffer.from('{"note":"ok"}')])), { note: "ok" });
});

test("JSON arrays and primitives are not object bodies", async () => {
  for (const text of ['[]', 'null', '1', '"string"'])
    assert.deepEqual(await readJson(request([Buffer.from(text)])), {});
});
