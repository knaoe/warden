// Ed25519 request-signature auth for warden.
// Callers sign a canonical message with their software ed25519 private key; the
// public key lives in the service_accounts table. No shared secret crosses the
// wire, no interactive/passkey step — agents sign locally and unattended.
//
// Canonical signed message:
//   "v1\n<METHOD>\n<path+query>\n<unix-ts>\n<sha256hex(body)>"
// Headers: X-Warden-Account, X-Warden-Timestamp (unix seconds), X-Warden-Signature (base64 of the 64-byte sig).
const enc = new TextEncoder();
const SKEW_SECONDS = 300;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyEd25519(pubB64, sigB64, message) {
  try {
    const key = await crypto.subtle.importKey("raw", b64ToBytes(pubB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(sigB64), enc.encode(message));
  } catch {
    return false;
  }
}

// Returns { ok: true, identity } or { ok: false, status, reason }.
export async function authenticate(c) {
  const account = c.req.header("X-Warden-Account");
  const ts = c.req.header("X-Warden-Timestamp");
  const sig = c.req.header("X-Warden-Signature");
  if (!account || !ts || !sig) return { ok: false, status: 401, reason: "missing_auth_headers" };

  const now = Math.floor(Date.now() / 1000);
  const t = Number.parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(now - t) > SKEW_SECONDS)
    return { ok: false, status: 401, reason: "timestamp_out_of_window" };

  const row = await c.env.DB
    .prepare("SELECT id, pubkey, allowed_projects FROM service_accounts WHERE id = ? AND disabled = 0")
    .bind(account).first();
  if (!row) return { ok: false, status: 401, reason: "unknown_or_disabled_account" };

  const body = await c.req.text(); // Hono caches the body so downstream validators can re-read it
  const url = new URL(c.req.url);
  const message = ["v1", c.req.method, url.pathname + url.search, ts, await sha256hex(body || "")].join("\n");

  if (!(await verifyEd25519(row.pubkey, sig, message)))
    return { ok: false, status: 401, reason: "bad_signature" };
  return { ok: true, identity: account, allowedProjects: row.allowed_projects };
}
