// PMO coordination ledger — minimal typed API over D1 (relational, with epoch fencing).
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const db = env.DB;
    try {
      // Attention-first portfolio briefing (the "how is everything?" read model).
      if (m === "GET" && (p === "/portfolio" || p === "/")) {
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
        return json({ reconciled_at: new Date().toISOString(), counts, needs_you, running, recent_changes: recent });
      }

      // Create a typed work item.
      if (m === "POST" && p === "/work") {
        const b = await req.json();
        const id = crypto.randomUUID().slice(0, 8);
        await db.prepare(
          `INSERT INTO work_items (id, project, title, priority, next_action, state)
           VALUES (?, ?, ?, ?, ?, 'queued')`)
          .bind(id, b.project, b.title, b.priority ?? 100, b.next_action ?? null).run();
        await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, 'created', ?)`).bind(id, b.title).run();
        const item = (await db.prepare(`SELECT * FROM work_items WHERE id=?`).bind(id).all()).results[0];
        return json({ created: item });
      }

      if (m === "GET" && p === "/work") {
        const items = (await db.prepare(`SELECT * FROM work_items ORDER BY priority, updated_at DESC`).all()).results;
        return json({ items });
      }

      // Claim a work item with a fencing token. Succeeds ONLY if the caller's
      // epoch is strictly greater than the stored owner_epoch — so a new
      // incarnation takes over, and a stale/older incarnation is rejected.
      const claimM = p.match(/^\/work\/([^/]+)\/claim$/);
      if (m === "POST" && claimM) {
        const id = claimM[1];
        const b = await req.json();
        const epoch = b.epoch | 0;
        const owner = String(b.owner ?? "");
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
        return json({ claimed, reason: claimed ? null : "stale_epoch_or_not_found", item }, claimed ? 200 : 409);
      }

      // Update state — fenced: caller's epoch must be >= current owner_epoch,
      // so a superseded incarnation cannot overwrite the new owner's decisions.
      const stateM = p.match(/^\/work\/([^/]+)\/state$/);
      if (m === "POST" && stateM) {
        const id = stateM[1];
        const b = await req.json();
        const epoch = b.epoch | 0;
        const res = await db.prepare(
          `UPDATE work_items
              SET state=?1, blocked_reason=?2, next_action=?3, needs_you=?4,
                  updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
            WHERE id=?5 AND ?6 >= owner_epoch`)
          .bind(b.state, b.blocked_reason ?? null, b.next_action ?? null, b.needs_you ? 1 : 0, id, epoch).run();
        const ok = res.meta.changes > 0;
        await db.prepare(`INSERT INTO events (work_item_id, kind, detail) VALUES (?, ?, ?)`)
          .bind(id, ok ? "state" : "state_rejected", `${b.state} epoch=${epoch}`).run();
        const item = (await db.prepare(`SELECT id, state, owner_epoch, needs_you FROM work_items WHERE id=?`).bind(id).all()).results[0];
        return json({ ok, reason: ok ? null : "stale_epoch", item }, ok ? 200 : 409);
      }

      return json({ error: "not_found", path: p, hint: "GET /portfolio | POST /work | GET /work | POST /work/:id/claim | POST /work/:id/state" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};
