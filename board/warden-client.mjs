import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

export function createWardenClient({ baseUrl, account, keyFile, fetchImpl = fetch }) {
  const endpoint = new URL(baseUrl);
  const privateKey = createPrivateKey(readFileSync(keyFile));

  function signedHeaders(method, pathAndQuery, body = "") {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const message = ["v1", method, pathAndQuery, timestamp, bodyHash].join("\n");
    return {
      "X-Warden-Account": account,
      "X-Warden-Timestamp": timestamp,
      "X-Warden-Signature": sign(null, Buffer.from(message), privateKey).toString("base64"),
    };
  }

  async function get(pathAndQuery) {
    const url = new URL(pathAndQuery, endpoint);
    const path = url.pathname + url.search;
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: signedHeaders("GET", path),
    });
    if (!response.ok) throw new Error(`warden HTTP ${response.status}`);
    return response.json();
  }

  return {
    listWork(query = "") {
      return get(`/work${query}`);
    },
  };
}
