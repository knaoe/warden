import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { pathToFileURL } from "node:url";

import { createWardenClient } from "./warden-client.mjs";

export function createBoardApp({ client }) {
  const app = new Hono();

  app.get("/api/board", async (c) => {
    try {
      const snapshot = await client.listWork();
      c.header("Cache-Control", "no-store");
      return c.json({ items: snapshot.items ?? [], fetched_at: new Date().toISOString() });
    } catch (error) {
      console.error(`[vigil] warden request failed: ${error.message}`);
      c.header("Cache-Control", "no-store");
      return c.json({ error: "warden_unavailable" }, 502);
    }
  });

  app.use("/*", serveStatic({ root: "./board/public" }));
  app.get("*", serveStatic({ path: "./board/public/index.html" }));
  return app;
}

function start() {
  const port = Number.parseInt(process.env.PORT || "8090", 10);
  const hostname = process.env.HOST || "0.0.0.0";
  const client = createWardenClient({
    baseUrl: process.env.WARDEN_URL || "https://warden.amber-tokyo.workers.dev",
    account: process.env.WARDEN_BOARD_ACCOUNT || "board",
    keyFile: process.env.WARDEN_BOARD_KEY_FILE || "board/warden-board.pem",
  });
  serve({ fetch: createBoardApp({ client }).fetch, port, hostname }, (info) => {
    console.log(`[vigil] listening on http://${hostname}:${info.port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
