// Sign a warden request and print the curl auth headers.
//   node scripts/warden-sign.mjs <account-id> <key.pem> <METHOD> <path+query> [bodyFile|-]
// Example:
//   curl $(node scripts/warden-sign.mjs pmo warden-pmo.pem GET /portfolio) https://warden.example.workers.dev/portfolio
import { createPrivateKey, sign, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [account, keyfile, method, path, bodyArg] = process.argv.slice(2);
if (!account || !keyfile || !method || !path) {
  console.error("usage: node scripts/warden-sign.mjs <account-id> <key.pem> <METHOD> <path+query> [bodyFile|-]");
  process.exit(1);
}

let body = "";
if (bodyArg === "-") body = readFileSync(0, "utf8");
else if (bodyArg) body = readFileSync(bodyArg, "utf8");

const ts = Math.floor(Date.now() / 1000).toString();
const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
const message = ["v1", method, path, ts, bodyHash].join("\n");
const key = createPrivateKey(readFileSync(keyfile));
const sigB64 = sign(null, Buffer.from(message), key).toString("base64");

// Emit headers one per line (shell-agnostic). Pair with `curl -H @file`:
//   node scripts/warden-sign.mjs pmo warden-pmo.pem GET /portfolio > /tmp/h
//   curl -H @/tmp/h https://warden.<subdomain>.workers.dev/portfolio
process.stdout.write(
  `X-Warden-Account: ${account}\nX-Warden-Timestamp: ${ts}\nX-Warden-Signature: ${sigB64}\n`
);
