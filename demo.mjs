// Exercises the warden API end-to-end, including the epoch-fencing guard.
// Requests are signed with an Ed25519 service-account key (see src/auth.js);
// unsigned requests are rejected 401 by every route except GET /.
//
// Usage:
//   WARDEN_URL="https://warden.<your-subdomain>.workers.dev" node demo.mjs
//
// First run: if the account's key doesn't exist yet, this generates one
// (warden-<account>.pem, gitignored) and prints the SQL to register its
// public key in service_accounts, then exits so you can register + rerun.
import { createPrivateKey, generateKeyPairSync, sign, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.WARDEN_URL || "https://warden.example.workers.dev";
const ACCOUNT = process.env.WARDEN_ACCOUNT || "demo";
const KEYFILE = process.env.WARDEN_KEY_FILE || `warden-${ACCOUNT}.pem`;

function loadOrCreateKey() {
  if (existsSync(KEYFILE)) return createPrivateKey(readFileSync(KEYFILE));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(KEYFILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  console.error(`# wrote private key -> ${KEYFILE} (chmod 600, gitignored)`);
  console.error(`# register this account before rerunning:`);
  console.error(`#   wrangler d1 execute warden --remote --command "INSERT INTO service_accounts (id,pubkey) VALUES ('${ACCOUNT}','${pubB64}');"`);
  process.exit(1);
}
const privateKey = loadOrCreateKey();

// Canonical message per src/auth.js: "v1\n<METHOD>\n<path+query>\n<unix-ts>\n<sha256hex(body)>"
function signHeaders(method, pathAndQuery, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const message = ["v1", method, pathAndQuery, ts, bodyHash].join("\n");
  const sigB64 = sign(null, Buffer.from(message), privateKey).toString("base64");
  return { "X-Warden-Account": ACCOUNT, "X-Warden-Timestamp": ts, "X-Warden-Signature": sigB64 };
}

const post = (p, body) => {
  const bodyStr = JSON.stringify(body);
  const headers = { "content-type": "application/json", ...signHeaders("POST", p, bodyStr) };
  return fetch(BASE + p, { method: "POST", headers, body: bodyStr }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const get = (p) => {
  const headers = signHeaders("GET", p, "");
  return fetch(BASE + p, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const show = (label, r) => console.log(`\n## ${label}  [HTTP ${r.status}]\n` + JSON.stringify(r.body, null, 2));

const a = await post("/work", { project: "alpha", title: "wire up backend", priority: 10, next_action: "implement endpoint" });
const b = await post("/work", { project: "beta", title: "draft announcement", priority: 50 });
const c = await post("/work", { project: "gamma", title: "pick retry policy", priority: 5, next_action: "decide" });
const idA = a.body.created.id, idC = c.body.created.id;
show("create A (alpha)", a); show("create B (beta)", b); show("create C (gamma)", c);

show("C -> needs_you", await post(`/work/${idC}/state`, { state: "needs_you", epoch: 0, needs_you: true, next_action: "make a decision" }));
show("PORTFOLIO (initial)", await get("/portfolio"));

console.log("\n==================== FENCING DEMO on item " + idA + " ====================");
show("claim A epoch=1 (incarnation #1)", await post(`/work/${idA}/claim`, { owner: "pm:alpha", epoch: 1 }));
show("claim A epoch=2 (fresh incarnation #2 takes over)", await post(`/work/${idA}/claim`, { owner: "pm:alpha", epoch: 2 }));
show("claim A epoch=1 AGAIN (stale incarnation -> REJECTED)", await post(`/work/${idA}/claim`, { owner: "pm:alpha-stale", epoch: 1 }));
show("state write epoch=1 (stale writer -> REJECTED)", await post(`/work/${idA}/state`, { state: "done", epoch: 1 }));
show("state write epoch=2 (current owner -> OK)", await post(`/work/${idA}/state`, { state: "verifying", epoch: 2, next_action: "run tests" }));

show("PORTFOLIO (after)", await get("/portfolio"));
