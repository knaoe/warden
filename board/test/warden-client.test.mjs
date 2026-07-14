import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWardenClient } from "../warden-client.mjs";

test("listWork signs the complete GET path and query", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vigil-client-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "board.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ items: [{ id: "w1", title: "real work" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createWardenClient({
    baseUrl: "https://warden.example.test/",
    account: "board",
    keyFile,
    fetchImpl,
  });

  const result = await client.listWork("?state=running");

  assert.equal(captured.url, "https://warden.example.test/work?state=running");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers["X-Warden-Account"], "board");
  const timestamp = captured.init.headers["X-Warden-Timestamp"];
  const bodyHash = createHash("sha256").update("", "utf8").digest("hex");
  const canonical = ["v1", "GET", "/work?state=running", timestamp, bodyHash].join("\n");
  assert.equal(
    verify(null, Buffer.from(canonical), publicKey, Buffer.from(captured.init.headers["X-Warden-Signature"], "base64")),
    true,
  );
  assert.equal(result.items[0].id, "w1");
});

test("listWork rejects a non-success warden response without exposing key material", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vigil-client-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "board.pem");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(keyFile, pem, { mode: 0o600 });
  const client = createWardenClient({
    baseUrl: "https://warden.example.test",
    account: "board",
    keyFile,
    fetchImpl: async () => new Response("denied", { status: 401 }),
  });

  await assert.rejects(client.listWork(), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(pem), false);
    return true;
  });
});

test("listEvents signs the bounded events query", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-client-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "board.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  let captured;
  const client = createWardenClient({
    baseUrl: "https://warden.example.test/",
    account: "board",
    keyFile,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return Response.json({ events: [{ id: 7, kind: "state", detail: "raw" }] });
    },
  });

  const result = await client.listEvents(17);

  assert.equal(captured.url, "https://warden.example.test/events?limit=17");
  const timestamp = captured.init.headers["X-Warden-Timestamp"];
  const bodyHash = createHash("sha256").update("", "utf8").digest("hex");
  const canonical = ["v1", "GET", "/events?limit=17", timestamp, bodyHash].join("\n");
  assert.equal(verify(null, Buffer.from(canonical), publicKey, Buffer.from(captured.init.headers["X-Warden-Signature"], "base64")), true);
  assert.equal(result.events[0].kind, "state");
});

test("updateWorkState signs JSON and preserves an upstream 409 body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-client-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "board.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  let captured;
  const client = createWardenClient({
    baseUrl: "https://warden.example.test/",
    account: "board",
    keyFile,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return Response.json({ ok: false, reason: "stale_epoch" }, { status: 409 });
    },
  });
  const patch = { epoch: 8, state: "queued", needs_you: false, next_action: "Operator approved." };

  const result = await client.updateWorkState("work-1", patch);

  assert.equal(captured.url, "https://warden.example.test/work/work-1/state");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(captured.init.body), patch);
  assert.equal("gate_status" in JSON.parse(captured.init.body), false);
  const timestamp = captured.init.headers["X-Warden-Timestamp"];
  const bodyHash = createHash("sha256").update(captured.init.body, "utf8").digest("hex");
  const canonical = ["v1", "POST", "/work/work-1/state", timestamp, bodyHash].join("\n");
  assert.equal(verify(null, Buffer.from(canonical), publicKey, Buffer.from(captured.init.headers["X-Warden-Signature"], "base64")), true);
  assert.deepEqual(result, { status: 409, body: { ok: false, reason: "stale_epoch" } });
});
