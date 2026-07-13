// Integration tests against a local D1 emulation (wrangler's getPlatformProxy,
// backed by the real workerd/Miniflare D1 implementation — not a hand-rolled mock).
// Covers: create, claim + epoch fencing, stale-epoch 409, partial /state update,
// GET /work, GET /portfolio.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import app from "../src/index.js";

const ACCOUNT = "test-account";
let proxy, env, privateKey;

before(async () => {
  proxy = await getPlatformProxy({ configPath: "wrangler.toml", persist: false });
  env = proxy.env;

  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  // Strip line comments before splitting on ';' — a comment containing a
  // literal semicolon (see schema.sql) would otherwise break a statement
  // into a comment-only fragment that D1 rejects.
  const schemaNoComments = schema.replace(/--[^\n]*/g, "");
  for (const stmt of schemaNoComments.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }

  const { publicKey, privateKey: priv } = generateKeyPairSync("ed25519");
  privateKey = priv;
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  await env.DB.prepare(`INSERT INTO service_accounts (id, pubkey) VALUES (?, ?)`).bind(ACCOUNT, pubB64).run();
});

after(async () => {
  await proxy.dispose();
});

// Signs per src/auth.js's canonical message: "v1\n<METHOD>\n<path+query>\n<unix-ts>\n<sha256hex(body)>"
function authHeaders(method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const message = ["v1", method, path, ts, bodyHash].join("\n");
  const sigB64 = sign(null, Buffer.from(message), privateKey).toString("base64");
  return { "X-Warden-Account": ACCOUNT, "X-Warden-Timestamp": ts, "X-Warden-Signature": sigB64 };
}

async function req(method, path, body) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const headers = { "content-type": "application/json", ...authHeaders(method, path, bodyStr) };
  const res = await app.request(path, { method, headers, body: body !== undefined ? bodyStr : undefined }, env);
  return { status: res.status, body: await res.json() };
}

test("unauthenticated request is rejected 401", async () => {
  const res = await app.request("/work", { method: "GET" }, env);
  assert.equal(res.status, 401);
});

test("create work item", async () => {
  const r = await req("POST", "/work", { project: "p", title: "wire up backend", priority: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.body.created.state, "queued");
  assert.equal(r.body.created.project, "p");
});

test("claim succeeds with a fresh epoch", async () => {
  const c = await req("POST", "/work", { project: "p", title: "claim-me" });
  const id = c.body.created.id;

  const claim = await req("POST", `/work/${id}/claim`, { owner: "pm:x", epoch: 1 });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.claimed, true);
  assert.equal(claim.body.item.state, "running");
  assert.equal(claim.body.item.owner_epoch, 1);
});

test("stale-epoch claim is rejected 409", async () => {
  const c = await req("POST", "/work", { project: "p", title: "stale-claim" });
  const id = c.body.created.id;

  await req("POST", `/work/${id}/claim`, { owner: "pm:x", epoch: 2 });
  const stale = await req("POST", `/work/${id}/claim`, { owner: "pm:y", epoch: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.claimed, false);
  assert.equal(stale.body.reason, "stale_epoch_or_not_found");
  // owner must remain the fresh incarnation, not overwritten by the stale claim
  assert.equal(stale.body.item.owner_epoch, 2);
});

test("partial /state update writes only present fields", async () => {
  const c = await req("POST", "/work", { project: "p", title: "state-test", next_action: "keep me" });
  const id = c.body.created.id;
  await req("POST", `/work/${id}/claim`, { owner: "pm:x", epoch: 1 });

  const r = await req("POST", `/work/${id}/state`, { epoch: 1, state: "blocked", blocked_reason: "waiting on review" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.item.state, "blocked");

  const list = await req("GET", "/work");
  const item = list.body.items.find((i) => i.id === id);
  assert.equal(item.next_action, "keep me"); // untouched by the partial update
});

test("/state accepts an assignee-only update", async () => {
  const c = await req("POST", "/work", { project: "p", title: "assign-me" });
  const id = c.body.created.id;

  const r = await req("POST", `/work/${id}/state`, { epoch: 0, assignee: "dashboard-p1" });

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const list = await req("GET", "/work");
  assert.equal(list.body.items.find((item) => item.id === id).assignee, "dashboard-p1");
});

test("/state accepts only http(s) external URLs of bounded length", async () => {
  const c = await req("POST", "/work", { project: "p", title: "link-me" });
  const id = c.body.created.id;

  const unsafe = await req("POST", `/work/${id}/state`, { epoch: 0, external_url: "javascript:alert(1)" });
  const tooLong = await req("POST", `/work/${id}/state`, { epoch: 0, external_url: `https://example.com/${"a".repeat(2050)}` });
  const safe = await req("POST", `/work/${id}/state`, { epoch: 0, external_url: "https://example.com/work/1" });

  assert.equal(unsafe.status, 400);
  assert.equal(tooLong.status, 400);
  assert.equal(safe.status, 200);
  const list = await req("GET", "/work");
  assert.equal(list.body.items.find((item) => item.id === id).external_url, "https://example.com/work/1");
});

test("/state validates gate status and timestamps accepted gate updates on the server", async () => {
  const c = await req("POST", "/work", { project: "p", title: "gate-me" });
  const id = c.body.created.id;

  const invalid = await req("POST", `/work/${id}/state`, { epoch: 0, gate_status: "surprise" });
  const valid = await req("POST", `/work/${id}/state`, { epoch: 0, gate_status: "pending" });

  assert.equal(invalid.status, 400);
  assert.equal(valid.status, 200);
  const list = await req("GET", "/work");
  const item = list.body.items.find((candidate) => candidate.id === id);
  assert.equal(item.gate_status, "pending");
  assert.match(item.gate_updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("stale-epoch state write is rejected 409", async () => {
  const c = await req("POST", "/work", { project: "p", title: "stale-state" });
  const id = c.body.created.id;
  await req("POST", `/work/${id}/claim`, { owner: "pm:x", epoch: 2 });

  const r = await req("POST", `/work/${id}/state`, { epoch: 1, state: "done" });
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, "stale_epoch");
});

test("GET /work lists items", async () => {
  const r = await req("GET", "/work");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  assert.ok(r.body.items.length > 0);
});

test("GET /portfolio returns attention-first briefing", async () => {
  await req("POST", "/work", { project: "p", title: "needs-you-item" });
  const created = await req("POST", "/work", { project: "p", title: "needs-you-item-2" });
  await req("POST", `/work/${created.body.created.id}/state`, { epoch: 0, state: "needs_you", needs_you: true });

  const r = await req("GET", "/portfolio");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.counts));
  assert.ok(Array.isArray(r.body.needs_you));
  assert.ok(r.body.needs_you.some((i) => i.id === created.body.created.id));
});
