// warden — coordination ledger API on Cloudflare Workers + D1.
// Routing: Hono. Input validation: Zod. Auth: Ed25519 request signatures (auth.js).
// SQL: D1 prepared statements with .bind() everywhere (no user input is ever
// interpolated into SQL text).
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authenticate } from "./auth.js";

const STATES = ["queued", "running", "blocked", "needs_you", "verifying", "done"];
const GATE_STATUSES = ["unknown", "pending", "passing", "failing", "review", "merged", "none"];
const httpUrl = z.string().max(2048).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, { message: "external_url must use http or https" });

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
// Partial update: only fields present in the request are written. Omitted
// fields keep their current values; an explicit null clears a text field.
const stateSchema = z
  .object({
    epoch: z.number().int().nonnegative(),
    state: z.enum(STATES).optional(),
    blocked_reason: z.string().max(500).nullable().optional(),
    next_action: z.string().max(500).nullable().optional(),
    needs_you: z.boolean().optional(),
    assignee: z.string().max(120).nullable().optional(),
    external_url: httpUrl.nullable().optional(),
    gate_status: z.enum(GATE_STATUSES).nullable().optional(),
  })
  .refine(
    (b) => b.state !== undefined || b.blocked_reason !== undefined || b.next_action !== undefined || b.needs_you !== undefined
      || b.assignee !== undefined || b.external_url !== undefined || b.gate_status !== undefined,
    { message: "no fields to update" },
  );

const app = new Hono();

// Auth: every route except the public health root requires a valid Ed25519 signature.
app.use("*", async (c, next) => {
  if (c.req.method === "GET" && c.req.path === "/") return next();
  const r = await authenticate(c);
  if (!r.ok) return c.json({ error: "unauthorized", reason: r.reason }, r.status);
  c.set("identity", r.identity);
  await next();
});

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "warden",
    endpoints: ["GET /portfolio", "POST /work", "GET /work", "POST /work/:id/claim", "POST /work/:id/state"],
    auth: "Ed25519 request signature: X-Warden-Account / X-Warden-Timestamp / X-Warden-Signature",
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
  await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, 'created', ?)`)
    .bind(id, `${b.title} by=${c.get("identity")}`).run();
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
    .bind(id, claimed ? "claimed" : "claim_rejected", `${owner} epoch=${epoch} by=${c.get("identity")}`).run();
  const item = (await db.prepare(`SELECT id, owner, owner_epoch, state, lease_until FROM work_items WHERE id=?`).bind(id).all()).results[0];
  return c.json({ claimed, reason: claimed ? null : "stale_epoch_or_not_found", item }, claimed ? 200 : 409);
});

// Fenced partial state update: caller's epoch must be >= current owner_epoch,
// so a superseded incarnation cannot overwrite the current owner's decisions.
// Only the fields present in the request are written (see stateSchema).
app.post("/work/:id/state", zValidator("json", stateSchema), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const b = c.req.valid("json");
  const sets = [];
  const binds = [];
  for (const [col, val] of Object.entries({
    state: b.state,
    blocked_reason: b.blocked_reason,
    next_action: b.next_action,
    assignee: b.assignee,
    external_url: b.external_url,
    gate_status: b.gate_status,
  })) {
    if (val !== undefined) { sets.push(`${col}=?`); binds.push(val); }
  }
  if (b.needs_you !== undefined) { sets.push(`needs_you=?`); binds.push(b.needs_you ? 1 : 0); }
  if (b.gate_status !== undefined) sets.push(`gate_updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  const res = await db.prepare(
    `UPDATE work_items SET ${sets.join(", ")} WHERE id=? AND ? >= owner_epoch`)
    .bind(...binds, id, b.epoch).run();
  const ok = res.meta.changes > 0;
  const changed = Object.entries(b).filter(([k, v]) => k !== "epoch" && v !== undefined)
    .map(([k, v]) => `${k}=${v}`).join(" ");
  await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, ?, ?)`)
    .bind(id, ok ? "state" : "state_rejected", `${changed} epoch=${b.epoch} by=${c.get("identity")}`).run();
  const item = (await db.prepare(
    `SELECT id, state, owner_epoch, needs_you, assignee, external_url, gate_status, gate_updated_at
       FROM work_items WHERE id=?`,
  ).bind(id).all()).results[0];
  return c.json({ ok, reason: ok ? null : "stale_epoch", item }, ok ? 200 : 409);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => c.json({ error: String(err?.message || err) }, 500));

export default app;
