import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { createWardenClient } from "./warden-client.mjs";

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const workIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), epoch: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("reject"), epoch: z.number().int().nonnegative() }).strict(),
  z.object({
    action: z.literal("instruction"),
    epoch: z.number().int().nonnegative(),
    instruction: z.string().trim().min(1).max(500),
  }).strict(),
]);

function noStore(c) {
  c.header("Cache-Control", "no-store");
}

function actionPatch(action) {
  if (action.action === "approve") {
    return { epoch: action.epoch, state: "queued", needs_you: false, next_action: "Operator approved." };
  }
  if (action.action === "reject") {
    return { epoch: action.epoch, state: "blocked", needs_you: false, next_action: "Operator rejected." };
  }
  return { epoch: action.epoch, next_action: action.instruction };
}

export function createBoardApp({ client }) {
  const app = new Hono();

  app.get("/api/board", async (c) => {
    try {
      const snapshot = await client.listWork();
      noStore(c);
      return c.json({ items: snapshot.items ?? [], fetched_at: new Date().toISOString() });
    } catch (error) {
      console.error(`[vigil] warden request failed: ${error.message}`);
      noStore(c);
      return c.json({ error: "warden_unavailable" }, 502);
    }
  });

  app.get("/api/events", async (c) => {
    const parsed = eventQuerySchema.safeParse(c.req.query());
    noStore(c);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      const snapshot = await client.listEvents(parsed.data.limit);
      return c.json({ events: snapshot.events ?? [], fetched_at: new Date().toISOString() });
    } catch (error) {
      console.error(`[vigil] warden events request failed: ${error.message}`);
      return c.json({ error: "warden_unavailable" }, 502);
    }
  });

  app.post("/api/work/:id/state", async (c) => {
    noStore(c);
    const id = c.req.param("id");
    if (!workIdSchema.safeParse(id).success) return c.json({ error: "invalid_request" }, 400);
    let json;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = actionSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    try {
      const upstream = await client.updateWorkState(id, actionPatch(parsed.data));
      const status = Number.isInteger(upstream.status) && upstream.status >= 200 && upstream.status <= 599
        ? upstream.status
        : 502;
      const body = upstream.body && typeof upstream.body === "object" && !Array.isArray(upstream.body)
        ? upstream.body
        : { error: "warden_error" };
      return c.json(body, status);
    } catch (error) {
      console.error(`[vigil] warden state request failed: ${error.message}`);
      return c.json({ error: "warden_unavailable" }, 502);
    }
  });

  app.use("/*", serveStatic({ root: "./board/public" }));
  app.get("*", serveStatic({ path: "./board/public/index.html" }));
  return app;
}

export function readBoardConfig(env) {
  const baseUrl = env.WARDEN_URL?.trim();
  if (!baseUrl) throw new Error("WARDEN_URL is required");
  return {
    baseUrl,
    account: env.WARDEN_BOARD_ACCOUNT || "board",
    keyFile: env.WARDEN_BOARD_KEY_FILE || "board/warden-board.pem",
  };
}

function start() {
  const port = Number.parseInt(process.env.PORT || "8090", 10);
  const hostname = process.env.HOST || "0.0.0.0";
  const client = createWardenClient(readBoardConfig(process.env));
  serve({ fetch: createBoardApp({ client }).fetch, port, hostname }, (info) => {
    console.log(`[vigil] listening on http://${hostname}:${info.port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
