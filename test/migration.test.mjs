import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(root, "node_modules", ".bin", "wrangler");
const preDashboardSchema = join(root, "test", "fixtures", "pre-dashboard-schema.sql");

function runWrangler(args) {
  return execFileSync(wrangler, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_LOG_PATH: join(tmpdir(), "warden-migration-test.log") },
  });
}

function queryJson(persistTo, sql) {
  return JSON.parse(runWrangler([
    "d1", "execute", "warden", "--local", "--persist-to", persistTo,
    "--command", sql, "--json",
  ]));
}

test("checked-in D1 migration upgrades the pre-dashboard schema exactly once", () => {
  const persistTo = mkdtempSync(join(tmpdir(), "warden-migration-"));
  runWrangler([
    "d1", "execute", "warden", "--local", "--persist-to", persistTo,
    "--file", preDashboardSchema,
  ]);

  runWrangler(["d1", "migrations", "apply", "warden", "--local", "--persist-to", persistTo]);
  const secondApply = runWrangler(["d1", "migrations", "apply", "warden", "--local", "--persist-to", persistTo]);

  const columns = queryJson(
    persistTo,
    "SELECT name, type FROM pragma_table_info('work_items') WHERE name IN ('assignee','external_url','gate_status','gate_updated_at') ORDER BY name",
  )[0].results;
  const accountColumns = queryJson(
    persistTo,
    "SELECT name, type FROM pragma_table_info('service_accounts') WHERE name = 'allowed_projects'",
  )[0].results;
  const applied = queryJson(persistTo, "SELECT name FROM d1_migrations ORDER BY id")[0].results;

  assert.deepEqual(columns, [
    { name: "assignee", type: "TEXT" },
    { name: "external_url", type: "TEXT" },
    { name: "gate_status", type: "TEXT" },
    { name: "gate_updated_at", type: "TEXT" },
  ]);
  assert.deepEqual(accountColumns, [{ name: "allowed_projects", type: "TEXT" }]);
  assert.deepEqual(applied, [
    { name: "0001_add_coordination_columns.sql" },
    { name: "0002_add_allowed_projects.sql" },
  ]);
  assert.match(secondApply, /No migrations to apply/);
});
