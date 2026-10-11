// row: OPS2 · 2026-10-11 — lessons-as-checks (a): export the Worker's sync contract (columns per table from
// tables.ts + NOT NULL columns parsed from the migrations) so the app can test its insert shapes against it.
//
//   npx tsx scripts/export-sync-tables.ts <path-to-work/migrations> [out.json]
//
// Output (committed as test/fixtures/sync-tables.json in BOTH repos):
//   { generated_at, tables: { "<schema.table>": { columns: [...], not_null: [...], not_null_all: [...], defaults: {col: "sql default"} } } }
// `columns` = sync-set columns + the table's own columns (what a device may send). `not_null` = columns the
// migrations declare NOT NULL and that have NO default — the ones a device MUST send. `not_null_all` = every NOT NULL
// column (default or not): a device may omit a defaulted one but must NEVER send it as an explicit null (the
// A5-fix1 `checked` lesson — an explicit null bypasses the default).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SYNC_SET_COLUMNS, SYNC_TABLES, TABLE_SPECS } from "../src/sync/tables";

const migDir = process.argv[2];
const out = process.argv[3] ?? "test/fixtures/sync-tables.json";
if (!migDir) {
  console.error("usage: export-sync-tables.ts <migrations dir> [out.json]");
  process.exit(2);
}

const sql = readdirSync(migDir)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(migDir, f), "utf8"))
  .join("\n");

/** CREATE TABLE schema.table ( ... ); → the column lines (first definition wins; ALTERs handled below). */
function tableBody(name: string): string[] {
  const re = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${name.replace(".", "\\.")}\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
  const m = re.exec(sql);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/--.*$/, "").trim()).filter(Boolean);
}

function altersFor(name: string): string[] {
  const re = new RegExp(`alter\\s+table\\s+${name.replace(".", "\\.")}\\s+add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?([a-z_]+\\s[^;]*);`, "gi");
  const outL: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) outL.push(m[1].trim());
  return outL;
}

const tables: Record<string, { columns: string[]; not_null: string[]; not_null_all: string[]; defaults: Record<string, string> }> = {};
for (const t of SYNC_TABLES) {
  const lines = [...tableBody(t), ...altersFor(t)];
  const notNull: string[] = [];
  const notNullAll: string[] = [];
  const defaults: Record<string, string> = {};
  for (const line of lines) {
    const mm = /^([a-z_]+)\s+[a-z_\[\]\(\),0-9 ]+/i.exec(line);
    if (!mm) continue;
    const col = mm[1].toLowerCase();
    if (["primary", "constraint", "unique", "check", "foreign"].includes(col)) continue;
    const hasDefault = /\bdefault\b/i.test(line);
    if (hasDefault) defaults[col] = (/\bdefault\s+([^,]+)/i.exec(line)?.[1] ?? "").trim();
    if (/\bnot\s+null\b/i.test(line) && !/\bgenerated\b/i.test(line)) {
      notNullAll.push(col);
      if (!hasDefault) notNull.push(col);
    }
  }
  const serverOnly = new Set(["id", "received_at", "updated_at", "created_at"]);
  tables[t] = {
    columns: ["id", ...SYNC_SET_COLUMNS, ...TABLE_SPECS[t].columns],
    not_null: notNull.filter((c) => !serverOnly.has(c)),
    not_null_all: notNullAll.filter((c) => !serverOnly.has(c)),
    defaults,
  };
}

writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), source: "scripts/export-sync-tables.ts", tables }, null, 2) + "\n");
console.log(`wrote ${out}: ${Object.keys(tables).length} tables`);
for (const [t, v] of Object.entries(tables)) console.log(`  ${t}: ${v.columns.length} cols, must-send ${v.not_null.join(",") || "-"}`);
