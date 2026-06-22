// Exercises the warden API end-to-end, including the epoch-fencing guard.
// Usage: WARDEN_URL="https://warden.<your-subdomain>.workers.dev" node demo.mjs
const BASE = process.env.WARDEN_URL || "https://warden.example.workers.dev";
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(BASE + p).then(async r => ({ status: r.status, body: await r.json() }));
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
