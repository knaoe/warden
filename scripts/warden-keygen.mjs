// Generate a software ed25519 key for a warden service account.
// Writes the private key (PEM) to warden-<id>.pem (keep secret, give to the agent),
// and prints the public key + the SQL to register it.
//   node scripts/warden-keygen.mjs <account-id>
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
  console.error("usage: node scripts/warden-keygen.mjs <account-id>   (lowercase, [a-z0-9_-])");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"); // 32 bytes
const pubB64 = rawPub.toString("base64");

const file = `warden-${id}.pem`;
writeFileSync(file, privPem, { mode: 0o600 });

console.error(`# wrote private key -> ${file}  (chmod 600; hand this to the '${id}' agent, never commit)`);
console.error(`# register: wrangler d1 execute warden --remote --command "INSERT INTO service_accounts (id,pubkey) VALUES ('${id}','${pubB64}');"`);
console.log(pubB64); // stdout = the public key value, for clean capture
