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

const workIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const createSchema = z.object({
  id: workIdSchema.optional(),
  project: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(1000).optional(),
  next_action: z.string().max(500).optional(),
});
const claimSchema = z.object({
  owner: z.string().min(1).max(120),
  epoch: z.number().int().nonnegative(),
});
const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const stateListSchema = z.string().refine(
  (v) => v === "all" || v.split(",").map((s) => s.trim()).every((s) => STATES.includes(s)),
  { message: `state must be "all" or a comma-separated list of: ${STATES.join(", ")}` },
);
const workQuerySchema = z.object({
  project: z.string().min(1).max(80).optional(),
  state: stateListSchema.optional(),
  include_done: z.coerce.boolean().optional(),
});
const portfolioQuerySchema = z.object({
  project: z.string().min(1).max(80).optional(),
});

// NULL/absent allowed_projects means the account is unrestricted (back-compat
// for existing accounts like `board`/`demo`).
function projectAllowed(allowedProjects, project) {
  if (!allowedProjects) return true;
  return allowedProjects.split(",").map((p) => p.trim()).filter(Boolean).includes(project);
}
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
  c.set("allowedProjects", r.allowedProjects);
  await next();
});

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "warden",
    endpoints: ["GET /portfolio", "POST /work", "GET /work", "GET /events", "POST /work/:id/claim", "POST /work/:id/state"],
    auth: "Ed25519 request signature: X-Warden-Account / X-Warden-Timestamp / X-Warden-Signature",
  }));

// Attention-first portfolio briefing ("how is everything?"). Unscoped (no
// ?project=) is a genuinely useful cross-team overview; scoped keeps one
// busy project's items from crowding out every other project's top-3.
app.get("/portfolio", zValidator("query", portfolioQuerySchema), async (c) => {
  const { project } = c.req.valid("query");
  const db = c.env.DB;
  const projectFilter = project ? "WHERE project = ?" : "";
  const projectAndFilter = project ? "AND project = ?" : "";
  const binds = project ? [project] : [];

  const counts = (await db.prepare(`SELECT state, COUNT(*) AS n FROM work_items ${projectFilter} GROUP BY state`).bind(...binds).all()).results;
  const needs_you = (await db.prepare(
    `SELECT id, project, title, next_action FROM work_items
      WHERE (state='needs_you' OR needs_you=1) ${projectAndFilter} ORDER BY priority LIMIT 3`).bind(...binds).all()).results;
  const running = (await db.prepare(
    `SELECT id, project, title, owner, owner_epoch FROM work_items
      WHERE state='running' ${projectAndFilter} ORDER BY priority`).bind(...binds).all()).results;
  const recent = (await db.prepare(
    `SELECT id, project, title, state, updated_at FROM work_items
      ${projectFilter} ORDER BY updated_at DESC LIMIT 5`).bind(...binds).all()).results;
  return c.json({ reconciled_at: new Date().toISOString(), counts, needs_you, running, recent_changes: recent });
});

// Create a typed work item. A client-supplied `id` makes this idempotent:
// retrying after an ambiguous response (the README documents at-least-once
// writes) is a safe no-op that returns the already-created row instead of
// erroring on the duplicate key.
app.post("/work", zValidator("json", createSchema), async (c) => {
  const db = c.env.DB;
  const b = c.req.valid("json");
  if (!projectAllowed(c.get("allowedProjects"), b.project))
    return c.json({ error: "forbidden_project" }, 403);

  const id = b.id ?? crypto.randomUUID().slice(0, 8);
  if (b.id) {
    const existing = (await db.prepare(`SELECT * FROM work_items WHERE id=?`).bind(id).all()).results[0];
    if (existing) return c.json({ created: existing });
  }
  try {
    await db.prepare(
      `INSERT INTO work_items (id, project, title, priority, next_action, state)
       VALUES (?, ?, ?, ?, ?, 'queued')`)
      .bind(id, b.project, b.title, b.priority ?? 100, b.next_action ?? null).run();
  } catch (err) {
    if (b.id && /unique/i.test(String(err?.message))) {
      const existing = (await db.prepare(`SELECT * FROM work_items WHERE id=?`).bind(id).all()).results[0];
      if (existing) return c.json({ created: existing });
    }
    throw err;
  }
  await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, 'created', ?)`)
    .bind(id, `${b.title} by=${c.get("identity")}`).run();
  const item = (await db.prepare(`SELECT * FROM work_items WHERE id=?`).bind(id).all()).results[0];
  return c.json({ created: item });
});

// Defaults to excluding `done` items so board payloads don't grow unbounded;
// `?state=all` or `?include_done=true` opts back into the full ledger (e.g. audit views).
app.get("/work", zValidator("query", workQuerySchema), async (c) => {
  const { project, state, include_done } = c.req.valid("query");
  const conditions = [];
  const binds = [];
  if (project) { conditions.push("project = ?"); binds.push(project); }
  if (state && state !== "all") {
    const states = state.split(",").map((s) => s.trim());
    conditions.push(`state IN (${states.map(() => "?").join(", ")})`);
    binds.push(...states);
  } else if (!state && !include_done) {
    conditions.push("state != ?");
    binds.push("done");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const items = (await c.env.DB.prepare(
    `SELECT * FROM work_items ${where} ORDER BY priority, updated_at DESC`,
  ).bind(...binds).all()).results;
  return c.json({ items });
});

app.get("/events", zValidator("query", eventsQuerySchema), async (c) => {
  const { limit } = c.req.valid("query");
  const events = (await c.env.DB.prepare(
    `SELECT id, work_item_id, kind, detail, at FROM events ORDER BY id DESC LIMIT ?`,
  ).bind(limit).all()).results;
  return c.json({ events });
});

// Claim with a fencing token: succeeds only if epoch > stored owner_epoch
// (newer incarnation wins; a stale/older incarnation is rejected with 409).
app.post("/work/:id/claim", zValidator("json", claimSchema), async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const { owner, epoch } = c.req.valid("json");
  const target = (await db.prepare(`SELECT project FROM work_items WHERE id=?`).bind(id).all()).results[0];
  if (target && !projectAllowed(c.get("allowedProjects"), target.project))
    return c.json({ error: "forbidden_project" }, 403);
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
  const target = (await db.prepare(`SELECT project FROM work_items WHERE id=?`).bind(id).all()).results[0];
  if (target && !projectAllowed(c.get("allowedProjects"), target.project))
    return c.json({ error: "forbidden_project" }, 403);
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
