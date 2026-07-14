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

  async function request(method, pathAndQuery, payload) {
    const url = new URL(pathAndQuery, endpoint);
    const path = url.pathname + url.search;
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const response = await fetchImpl(url.toString(), {
      method,
      headers: {
        ...signedHeaders(method, path, body),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body }),
    });
    const responseText = await response.text();
    let responseBody;
    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      responseBody = { error: "warden_error" };
    }
    return { status: response.status, ok: response.ok, body: responseBody };
  }

  async function get(pathAndQuery) {
    const response = await request("GET", pathAndQuery);
    if (!response.ok) throw new Error(`warden HTTP ${response.status}`);
    return response.body;
  }

  return {
    listWork(query = "") {
      return get(`/work${query}`);
    },
    listEvents(limit = 30) {
      return get(`/events?limit=${encodeURIComponent(limit)}`);
    },
    async updateWorkState(id, patch) {
      const response = await request("POST", `/work/${encodeURIComponent(id)}/state`, patch);
      return { status: response.status, body: response.body };
    },
  };
}
