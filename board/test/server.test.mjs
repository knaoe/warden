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
