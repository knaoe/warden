# warden

A tiny, **authoritative coordination ledger** for multi-agent / multi-project work, running on Cloudflare Workers + D1 (SQLite at the edge).

`warden` is the relational source-of-truth for *work intent and coordination state* — what work exists, who owns it, what's blocked, what needs a human. It is deliberately small: a typed HTTP API over a single D1 database, with **epoch fencing** so a stale or duplicated agent can't overwrite a newer one (split-brain protection).

It is **not** a knowledge base, a chat front-end, or a task-queue runtime — it's the boring, exact ledger those things read from and write to.

## Why

Long-lived "orchestrator" / coordinator agents bloat and drift over time. The fix is to keep their state **out of the model context** and in an external, authoritative store, so the agent can be restarted (or rolled to a fresh process) at any time and reconcile from the ledger instead of from a growing conversation.

Coordination state must be **exact, not fuzzy**: "is item X blocked? who holds it? has it been claimed?" needs a deterministic answer. That is why this is a *relational* ledger (D1/SQLite), not a vector/semantic store. Semantic memory is great for *recall of lessons*; it is the wrong primitive for *current coordination truth*.

The fencing model is **stable logical identity, disposable process incarnation**: each owner carries a monotonically increasing `epoch`. A new incarnation claims with a higher epoch and takes over; an older incarnation that wakes up is rejected, so it cannot double-dispatch or overwrite the new owner's decisions.

## API

- `GET /portfolio` — attention-first briefing: counts by state, items that need a human, running items, recent changes.
- `POST /work` — create a work item: `{ project, title, priority?, next_action? }`.
- `GET /work` — list work items.
- `POST /work/:id/claim` — claim with a fencing token: `{ owner, epoch }`. Succeeds only if `epoch > stored owner_epoch` (newer incarnation wins; stale → `409`).
- `POST /work/:id/state` — update state: `{ state, epoch, blocked_reason?, next_action?, needs_you? }`, fenced (`epoch >= owner_epoch`; stale writer → `409`).

Routing is [Hono](https://hono.dev); request bodies are validated with [Zod](https://zod.dev) and rejected with `400` before any database access. All SQL uses D1 prepared statements with bound parameters (no user input is interpolated into SQL text).

## Auth

Every route except `GET /` (health) requires an **Ed25519 request signature**. Each caller is a *service account* with its own software key; warden stores only the public key (`service_accounts` table). No shared secret crosses the wire, and signing is local and unattended (no passkey / interactive step).

Headers: `X-Warden-Account`, `X-Warden-Timestamp` (unix seconds), `X-Warden-Signature` (base64 of the 64-byte ed25519 signature). The signed message is:

```
v1\n<METHOD>\n<path+query>\n<unix-timestamp>\n<sha256hex(body)>
```

Requests outside a ±300s clock window, from an unknown/disabled account, or with a bad signature get `401`.

Add a service account:

```sh
node scripts/warden-keygen.mjs pmo        # writes warden-pmo.pem (private, gitignored); prints the public key
wrangler d1 execute warden --remote --command \
  "INSERT INTO service_accounts (id,pubkey) VALUES ('pmo','<printed-pubkey>');"
```

Revoke with `UPDATE service_accounts SET disabled=1 WHERE id='pmo';`.

Sign + call (the helper emits headers one per line; pair with `curl -H @file`):

```sh
node scripts/warden-sign.mjs pmo warden-pmo.pem GET /portfolio > /tmp/h
curl -H @/tmp/h https://warden.<subdomain>.workers.dev/portfolio
```

Real callers sign in-process (Node `crypto.sign(null, msg, ed25519Key)`); `warden-sign.mjs` shows the canonical message.

## Data model

`work_items` (id, project, title, state, priority, owner, owner_epoch, lease_until, blocked_reason, next_action, needs_you, updated_at) plus an append-only `events` audit log. See [`schema.sql`](schema.sql).

States: `queued | running | blocked | needs_you | verifying | done`.

### Production migration warning

> [!WARNING]
> Production D1 database `e807bb63-9e01-4420-b384-f4fad3f97279` was manually
> altered on 2026-07-11 to add `assignee`, `external_url`, `gate_status`, and
> `gate_updated_at`. Its schema is ahead of its `d1_migrations` ledger.

Do **not** run either of these commands against production:

```sh
npm run migrate -- --remote
wrangler d1 migrations apply warden --remote
```

Do not execute `migrations/0001_add_coordination_columns.sql` directly against
production either. The four columns already exist, so replaying its `ALTER
TABLE` statements would fail without fixing the ledger mismatch.

Before any production migration, obtain separate production approval, verify
that all four columns exist, and reconcile the `d1_migrations` ledger so
`0001_add_coordination_columns.sql` is recorded as already applied **without
rerunning its SQL**. Only then may a later migration be considered.

Local migration testing remains allowed:

```sh
npm run migrate -- --local
npm run migrate -- --local --persist-to /tmp/warden-local
```

Use that path only for a local or greenfield database that still has the
pre-dashboard schema and does not already contain the four columns. A database
created from the current `schema.sql` already has them and must not replay
migration `0001`.

## Deploy

```sh
# 0. Install dependencies (Hono + Zod)
npm install

# 1. Create a D1 database (pick a location hint near you, e.g. apac / weur / enam)
wrangler d1 create warden --location apac
#    -> paste the returned database_id into wrangler.toml

# 2. Apply the schema
wrangler d1 execute warden --remote --file schema.sql

# 3. Deploy the Worker
wrangler deploy

# 4. (optional) exercise it end-to-end, including the fencing demo
WARDEN_URL="https://warden.<your-subdomain>.workers.dev" node demo.mjs
```

## Status / not yet

- Auth is **Ed25519 request signatures** (see [Auth](#auth)) — a private control plane. Clock-skew window is ±300s; add a nonce store if you need stricter replay protection.
- Warden authenticates the calling service account but does not yet enforce per-account route/method scope — any registered account can call any route. Least privilege is currently conventional, not server-enforced.
- Vigil (`board/`) has **no auth of its own**: `board/server.mjs` binds `0.0.0.0` by default and `GET /api/board` relays the full ledger snapshot to any caller who can reach it. Fine on a private tailnet/LAN; do not expose it publicly or bind it to a public interface.
- `commands` / `leases` / `attempts` are folded into `work_items` for now.
- No lease-expiry reclaim yet (correctness is guaranteed by epoch fencing, not by lease timeout).
- Clients should retry on transient D1 errors (treat writes as at-least-once + idempotent).

## License

MIT
