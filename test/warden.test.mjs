// Integration tests against a local D1 emulation (wrangler's getPlatformProxy,
// backed by the real workerd/Miniflare D1 implementation — not a hand-rolled mock).
// Covers: create, claim + epoch fencing, stale-epoch 409, partial /state update,
// GET /work, GET /events, GET /portfolio.
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
function authHeaders(method, path, body, account = ACCOUNT, key = privateKey) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const message = ["v1", method, path, ts, bodyHash].join("\n");
  const sigB64 = sign(null, Buffer.from(message), key).toString("base64");
  return { "X-Warden-Account": account, "X-Warden-Timestamp": ts, "X-Warden-Signature": sigB64 };
}

async function req(method, path, body, account, key) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const headers = { "content-type": "application/json", ...authHeaders(method, path, bodyStr, account, key) };
  const res = await app.request(path, { method, headers, body: body !== undefined ? bodyStr : undefined }, env);
  return { status: res.status, body: await res.json() };
}

// Registers a new service account with an optional allowed_projects
// restriction and returns { account, key } for use with req(..., account, key).
async function registerAccount(id, allowedProjects) {
  const { publicKey, privateKey: key } = generateKeyPairSync("ed25519");
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  await env.DB.prepare(`INSERT INTO service_accounts (id, pubkey, allowed_projects) VALUES (?, ?, ?)`)
    .bind(id, pubB64, allowedProjects ?? null).run();
  return { account: id, key };
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

test("GET /events returns newest raw ledger events with a bounded limit", async () => {
  const created = await req("POST", "/work", { project: "events", title: "event source" });
  const id = created.body.created.id;
  await req("POST", `/work/${id}/state`, { epoch: 0, next_action: "inspect raw detail" });

  const response = await req("GET", "/events?limit=2");

  assert.equal(response.status, 200);
  assert.equal(response.body.events.length, 2);
  assert.deepEqual(
    Object.keys(response.body.events[0]).sort(),
    ["at", "detail", "id", "kind", "work_item_id"],
  );
  assert.equal(response.body.events[0].kind, "state");
  assert.match(response.body.events[0].detail, /next_action=inspect raw detail/);
  assert.ok(response.body.events[0].id > response.body.events[1].id);
});

test("GET /events rejects invalid limits and caps the accepted range", async () => {
  for (const path of ["/events?limit=0", "/events?limit=101", "/events?limit=oops"]) {
    const response = await req("GET", path);
    assert.equal(response.status, 400, path);
  }

  const response = await req("GET", "/events");
  assert.equal(response.status, 200);
  assert.ok(response.body.events.length <= 30);
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

test("GET /work?project= filters to the requested project", async () => {
  const a = await req("POST", "/work", { project: "proj-a", title: "a item" });
  const b = await req("POST", "/work", { project: "proj-b", title: "b item" });

  const r = await req("GET", "/work?project=proj-a");
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((i) => i.id === a.body.created.id));
  assert.ok(!r.body.items.some((i) => i.id === b.body.created.id));
});

test("GET /work excludes done items by default and ?state=all / ?include_done=true opt back in", async () => {
  const created = await req("POST", "/work", { project: "done-proj", title: "finish-me" });
  const id = created.body.created.id;
  await req("POST", `/work/${id}/state`, { epoch: 0, state: "done" });

  const defaultList = await req("GET", "/work?project=done-proj");
  assert.ok(!defaultList.body.items.some((i) => i.id === id));

  const withAll = await req("GET", "/work?project=done-proj&state=all");
  assert.ok(withAll.body.items.some((i) => i.id === id));

  const withIncludeDone = await req("GET", "/work?project=done-proj&include_done=true");
  assert.ok(withIncludeDone.body.items.some((i) => i.id === id));
});

test("GET /work?state= filters to a comma-separated state list", async () => {
  const created = await req("POST", "/work", { project: "state-filter", title: "block-me" });
  const id = created.body.created.id;
  await req("POST", `/work/${id}/state`, { epoch: 0, state: "blocked", blocked_reason: "waiting" });

  const r = await req("GET", "/work?project=state-filter&state=blocked,queued");
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((i) => i.id === id));

  const invalid = await req("GET", "/work?state=not-a-real-state");
  assert.equal(invalid.status, 400);
});

test("GET /portfolio?project= scopes every query to the requested project", async () => {
  const scoped = await req("POST", "/work", { project: "portfolio-scope", title: "scoped-needs-you" });
  await req("POST", `/work/${scoped.body.created.id}/state`, { epoch: 0, state: "needs_you", needs_you: true });
  const other = await req("POST", "/work", { project: "other-project", title: "other-needs-you" });
  await req("POST", `/work/${other.body.created.id}/state`, { epoch: 0, state: "needs_you", needs_you: true });

  const r = await req("GET", "/portfolio?project=portfolio-scope");
  assert.equal(r.status, 200);
  assert.ok(r.body.needs_you.some((i) => i.id === scoped.body.created.id));
  assert.ok(!r.body.needs_you.some((i) => i.id === other.body.created.id));
  assert.ok(r.body.recent_changes.every((i) => i.project === "portfolio-scope"));
});

test("POST /work with a client-supplied id is idempotent — a retried call is a safe no-op", async () => {
  const first = await req("POST", "/work", { id: "idem-1", project: "p", title: "idempotent item" });
  assert.equal(first.status, 200);
  assert.equal(first.body.created.id, "idem-1");

  const retry = await req("POST", "/work", { id: "idem-1", project: "p", title: "idempotent item" });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created.id, "idem-1");

  const list = await req("GET", "/work?project=p&state=all");
  assert.equal(list.body.items.filter((i) => i.id === "idem-1").length, 1);
});

test("POST /work rejects an invalid client-supplied id shape", async () => {
  const r = await req("POST", "/work", { id: "../bad id", project: "p", title: "bad id" });
  assert.equal(r.status, 400);
});

test("allowed_projects restricts a service account to its own projects", async () => {
  const restricted = await registerAccount("restricted-acct", "allowed-proj");

  const ok = await req("POST", "/work", { project: "allowed-proj", title: "in scope" }, restricted.account, restricted.key);
  assert.equal(ok.status, 200);

  const forbidden = await req("POST", "/work", { project: "other-proj", title: "out of scope" }, restricted.account, restricted.key);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, "forbidden_project");
});

test("allowed_projects is enforced on claim and state routes using the target item's own project", async () => {
  const restricted = await registerAccount("restricted-acct-2", "in-scope-proj");
  const outOfScope = await req("POST", "/work", { project: "not-in-scope-proj", title: "not mine" });
  const id = outOfScope.body.created.id;

  const claim = await req("POST", `/work/${id}/claim`, { owner: "pm:x", epoch: 1 }, restricted.account, restricted.key);
  assert.equal(claim.status, 403);
  assert.equal(claim.body.error, "forbidden_project");

  const state = await req("POST", `/work/${id}/state`, { epoch: 0, state: "blocked" }, restricted.account, restricted.key);
  assert.equal(state.status, 403);
  assert.equal(state.body.error, "forbidden_project");
});

test("NULL allowed_projects remains unrestricted (back-compat for existing accounts)", async () => {
  const unrestricted = await registerAccount("unrestricted-acct");

  const r = await req("POST", "/work", { project: "any-project-at-all", title: "unrestricted" }, unrestricted.account, unrestricted.key);
  assert.equal(r.status, 200);
});
