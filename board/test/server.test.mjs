import { test } from "node:test";
import assert from "node:assert/strict";

import * as server from "../server.mjs";

const { createBoardApp } = server;

test("startup config fails fast when WARDEN_URL is unset", () => {
  assert.throws(
    () => server.readBoardConfig({}),
    { message: "WARDEN_URL is required" },
  );
});

test("startup config uses the configured WARDEN_URL", () => {
  const config = server.readBoardConfig({ WARDEN_URL: "https://warden.example.test/base" });

  assert.equal(config.baseUrl, "https://warden.example.test/base");
  assert.equal(config.account, "board");
  assert.equal(config.keyFile, "board/warden-board.pem");
});

test("GET /api/board returns the current warden snapshot without caching", async () => {
  const app = createBoardApp({
    client: { listWork: async () => ({ items: [{ id: "w1", state: "running" }] }) },
  });

  const response = await app.request("/api/board");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.items[0].id, "w1");
  assert.match(body.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("GET /api/board reports an upstream failure as 502", async () => {
  const app = createBoardApp({
    client: { listWork: async () => { throw new Error("warden HTTP 401"); } },
  });

  const response = await app.request("/api/board");
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: "warden_unavailable" });
});

test("GET /api/events returns raw events without caching", async () => {
  const app = createBoardApp({
    client: { listEvents: async (limit) => ({ events: [{ id: 4, kind: "state", detail: `limit=${limit}` }] }) },
  });

  const response = await app.request("/api/events?limit=12");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.events[0].kind, "state");
  assert.equal(body.events[0].detail, "limit=12");
});

test("GET /api/events validates its limit", async () => {
  const app = createBoardApp({ client: { listEvents: async () => ({ events: [] }) } });
  assert.equal((await app.request("/api/events?limit=0")).status, 400);
  assert.equal((await app.request("/api/events?limit=101")).status, 400);
  assert.equal((await app.request("/api/events?limit=wat")).status, 400);
});

test("decision proxy translates approve and reject without gate_status", async () => {
  const calls = [];
  const app = createBoardApp({
    client: {
      updateWorkState: async (id, patch) => {
        calls.push({ id, patch });
        return { status: 200, body: { ok: true } };
      },
    },
  });

  const approve = await app.request("/api/work/item-1/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", epoch: 9 }),
  });
  const reject = await app.request("/api/work/item-2/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reject", epoch: 10 }),
  });

  assert.equal(approve.status, 200);
  assert.equal(reject.status, 200);
  assert.deepEqual(calls, [
    { id: "item-1", patch: { epoch: 9, state: "queued", needs_you: false, next_action: "Operator approved." } },
    { id: "item-2", patch: { epoch: 10, state: "blocked", needs_you: false, next_action: "Operator rejected." } },
  ]);
  assert.equal(calls.some(({ patch }) => "gate_status" in patch), false);
});

test("instruction proxy writes only the ledger next_action", async () => {
  let captured;
  const app = createBoardApp({
    client: {
      updateWorkState: async (id, patch) => {
        captured = { id, patch };
        return { status: 200, body: { ok: true } };
      },
    },
  });

  const response = await app.request("/api/work/item-3/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "instruction", epoch: 11, instruction: "Re-run the focused tests." }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(captured, { id: "item-3", patch: { epoch: 11, next_action: "Re-run the focused tests." } });
});

test("write proxy rejects unknown fields, invalid ids, and empty instructions", async () => {
  const app = createBoardApp({ client: { updateWorkState: async () => assert.fail("must not call upstream") } });
  const request = (path, body) => app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await request("/api/work/item/state", { action: "approve", epoch: 1, gate_status: "passing" })).status, 400);
  assert.equal((await request("/api/work/bad%2Fid/state", { action: "approve", epoch: 1 })).status, 400);
  assert.equal((await request("/api/work/item/state", { action: "instruction", epoch: 1, instruction: "   " })).status, 400);
});

test("write proxy preserves an upstream 409 status and safe JSON body", async () => {
  const app = createBoardApp({
    client: { updateWorkState: async () => ({ status: 409, body: { ok: false, reason: "stale_epoch" } }) },
  });

  const response = await app.request("/api/work/item/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", epoch: 2 }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, reason: "stale_epoch" });
});
