// warden — coordination ledger API on Cloudflare Workers + D1.
// Routing: Hono. Input validation: Zod. SQL: D1 prepared statements with
// .bind() everywhere (no user input is ever interpolated into SQL text).
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const STATES = ["queued", "running", "blocked", "needs_you", "verifying", "done"];

const createSchema = z.object({
  project: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(1000).optional(),
  next_action: z.string().max(500).optional(),
});
const claimSchema = z.object({
  owner: z.string().min(1).max(120),
  epoch: z.number().int().nonnegative(),
});
const stateSchema = z.object({
  state: z.enum(STATES),
  epoch: z.number().int().nonnegative(),
  blocked_reason: z.string().max(500).optional(),
  next_action: z.string().max(500).optional(),
  needs_you: z.boolean().optional(),
});

const app = new Hono();

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "warden",
    endpoints: ["GET /portfolio", "POST /work", "GET /work", "POST /work/:id/claim", "POST /work/:id/state"],
  }));

// Attention-first portfolio briefing ("how is everything?").
app.get("/portfolio", async (c) => {
  const db = c.env.DB;
  const counts = (await db.prepare(`SELECT state, COUNT(*) AS n FROM work_items GROUP BY state`).all()).results;
  const needs_you = (await db.prepare(
    `SELECT id, project, title, next_action FROM work_items
      WHERE state='needs_you' OR needs_you=1 ORDER BY priority LIMIT 3`).all()).results;
  const running = (await db.prepare(
    `SELECT id, project, title, owner, owner_epoch FROM work_items
      WHERE state='running' ORDER BY priority`).all()).results;
  const recent = (await db.prepare(
    `SELECT id, project, title, state, updated_at FROM work_items
      ORDER BY updated_at DESC LIMIT 5`).all()).results;
  return c.json({ reconciled_at: new Date().toISOString(), counts, needs_you, running, recent_changes: recent });
});

// Create a typed work item.
app.post("/work", zValidator("json", createSchema), async (c) => {
  const db = c.env.DB;
  const b = c.req.valid("json");
  const id = crypto.randomUUID().slice(0, 8);
  await db.prepare(
    `INSERT INTO work_items (id, project, title, priority, next_action, state)
     VALUES (?, ?, ?, ?, ?, 'queued')`)
    .bind(id, b.project, b.title, b.priority ?? 100, b.next_action ?? null).run();
  await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, 'created', ?)`).bind(id, b.title).run();
  const item = (await db.prepare(`SELECT * FROM work_items WHERE id=?`).bind(id).all()).results[0];
  return c.json({ created: item });
});

app.get("/work", async (c) => {
  const items = (await c.env.DB.prepare(`SELECT * FROM work_items ORDER BY priority, updated_at DESC`).all()).results;
  return c.json({ items });
});

// Claim with a fencing token: succeeds only if epoch > stored owner_epoch
// (newer incarnation wins; a stale/older incarnation is rejected with 409).
app.post("/work/:id/claim", zValidator("json", claimSchema), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const { owner, epoch } = c.req.valid("json");
  const leaseUntil = new Date(Date.now() + 120000).toISOString();
  const res = await db.prepare(
    `UPDATE work_items
        SET owner=?1, owner_epoch=?2, lease_until=?3, state='running',
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id=?4 AND ?2 > owner_epoch`)
    .bind(owner, epoch, leaseUntil, id).run();
  const claimed = res.meta.changes > 0;
  await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, ?, ?)`)
    .bind(id, claimed ? "claimed" : "claim_rejected", `${owner} epoch=${epoch}`).run();
  const item = (await db.prepare(`SELECT id, owner, owner_epoch, state, lease_until FROM work_items WHERE id=?`).bind(id).all()).results[0];
  return c.json({ claimed, reason: claimed ? null : "stale_epoch_or_not_found", item }, claimed ? 200 : 409);
});

// Fenced state update: caller's epoch must be >= current owner_epoch, so a
// superseded incarnation cannot overwrite the current owner's decisions.
app.post("/work/:id/state", zValidator("json", stateSchema), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const b = c.req.valid("json");
  const res = await db.prepare(
    `UPDATE work_items
        SET state=?1, blocked_reason=?2, next_action=?3, needs_you=?4,
            updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id=?5 AND ?6 >= owner_epoch`)
    .bind(b.state, b.blocked_reason ?? null, b.next_action ?? null, b.needs_you ? 1 : 0, id, b.epoch).run();
  const ok = res.meta.changes > 0;
  await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, ?, ?)`)
    .bind(id, ok ? "state" : "state_rejected", `${b.state} epoch=${b.epoch}`).run();
  const item = (await db.prepare(`SELECT id, state, owner_epoch, needs_you FROM work_items WHERE id=?`).bind(id).all()).results[0];
  return c.json({ ok, reason: ok ? null : "stale_epoch", item }, ok ? 200 : 409);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => c.json({ error: String(err?.message || err) }, 500));

export default app;
