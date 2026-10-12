// row: K2 · run: run-2026-10-07-drawing-layer-15 · 2026-10-12 — seed loader: upsert ORG catalog rows from a JSON array or a CSV
//==============================================================================
// scripts/load-catalog.ts — load an organization's catalog by hand (contract §4.1, "by hand" side) without the dashboard.
//
//   DATABASE_URL=postgres://… npx tsx scripts/load-catalog.ts <org-id> <file.json|file.csv> [--dry-run]
//
// Input: a JSON array of items, or a CSV with a header row, each row {kind, key, name, …kind fields}. Besides the
// catalog.items columns a row may carry the key conveniences `legend_set_key`, `symbol_key`, `default_wire_key`
// (resolved against the base and the org's own rows). JSON columns (pair_layout, attributes) may be JSON strings in CSV.
// Writes ORG rows only (organization_id = <org-id>): INSERT … ON CONFLICT (organization_id, kind, key) DO UPDATE on
// name + every given field, revision + 1. Base rows are never written (RLS WITH CHECK refuses; the owner role is not
// needed). Prints counts. Never deletes; `status: hidden` is how a row leaves the palette. No pricing columns exist.
//
// Runs under one transaction with SET LOCAL app.org_id = <org-id> so it works with the genesis_api role (RLS) or the owner.
//==============================================================================

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { KEY_RE, isKind, validateItem, pickEditable, CatalogBodyError, type ItemKind } from "../src/catalog/shape";

const [orgId, file, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
const url = process.env.DATABASE_URL;
if (!orgId || !file || !url) {
  console.error("usage: DATABASE_URL=postgres://… npx tsx scripts/load-catalog.ts <org-id> <file.json|file.csv> [--dry-run]");
  process.exit(2);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
  console.error("org-id must be a UUID");
  process.exit(2);
}

type Row = Record<string, unknown>;

/** Minimal RFC-4180 CSV: quoted fields, doubled quotes, CRLF. Empty cells → undefined (not sent). */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; cur.push(field); rows.push(cur); cur = []; field = ""; }
    else field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  const header = rows.shift()?.map((h) => h.trim()) ?? [];
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => {
    const o: Row = {};
    header.forEach((h, i) => { const v = (r[i] ?? "").trim(); if (v !== "") o[h] = v; });
    return o;
  });
}

const JSON_COLS = ["pair_layout", "attributes"];
const INT_COLS = ["conductors", "ordinal"];

function normalise(raw: Row): Row {
  const o: Row = { ...raw };
  for (const c of JSON_COLS) if (typeof o[c] === "string") o[c] = JSON.parse(o[c] as string);
  for (const c of INT_COLS) if (typeof o[c] === "string") o[c] = Number(o[c]);
  return o;
}

async function main(): Promise<void> {
  const text = readFileSync(file, "utf8");
  const raw: Row[] = file.toLowerCase().endsWith(".csv") ? parseCsv(text) : (JSON.parse(text) as unknown as Row[]);
  if (!Array.isArray(raw)) throw new Error("JSON input must be an array of items");
  const sql = postgres(url!, { prepare: false, max: 1, fetch_types: false });
  const counts = { inserted: 0, updated: 0, skipped: 0 };
  const problems: string[] = [];
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', '', true), set_config('app.role', 'system', true)`;
      for (let i = 0; i < raw.length; i++) {
        const r = normalise(raw[i]);
        const where = `row ${i + 1} (${String(r.kind)}/${String(r.key)})`;
        try {
          if (!isKind(r.kind)) throw new CatalogBodyError("kind must be symbol | device | wire | accessory | legend_entry | bundle");
          if (typeof r.key !== "string" || !KEY_RE.test(r.key)) throw new CatalogBodyError("key is required (letters, digits, _ . -)");
          if (typeof r.name !== "string" || !r.name.trim()) throw new CatalogBodyError("name is required");
          if (r.source != null && r.source !== "manual") throw new CatalogBodyError("source must be manual (connector pulls go through the gateway)");
          const kind = r.kind as ItemKind;
          const patch = pickEditable(r);
          for (const [bodyKey, col, table, k] of [["legend_set_key", "legend_set_id", "legend_sets", null], ["symbol_key", "symbol_item_id", "items", "symbol"], ["default_wire_key", "default_wire_item_id", "items", "wire"]] as const) {
            if (typeof r[bodyKey] !== "string") continue;
            const hit = table === "legend_sets"
              ? await tx<{ id: string }[]>`select id from catalog.legend_sets where key = ${r[bodyKey] as string} and (organization_id = ${orgId} or organization_id is null) and deleted_at is null order by organization_id nulls last limit 1`
              : await tx<{ id: string }[]>`select id from catalog.items where key = ${r[bodyKey] as string} and kind = ${k as string} and (organization_id = ${orgId} or organization_id is null) and deleted_at is null order by organization_id nulls last limit 1`;
            if (!hit[0]) throw new CatalogBodyError(`${bodyKey} '${String(r[bodyKey])}' not found`);
            patch[col] = hit[0].id;
          }
          const merged: Row = { ...patch, name: r.name.trim(), status: patch.status ?? "active" };
          validateItem(kind, merged);
          if (dryRun) {
            const ex = await tx<{ id: string }[]>`select id from catalog.items where organization_id = ${orgId} and kind = ${kind} and key = ${r.key} limit 1`;
            if (ex[0]) counts.updated++; else counts.inserted++;
            continue;
          }
          const cols = Object.keys(merged);
          const values: Row = { organization_id: orgId, kind, key: r.key, source: "manual" };
          for (const c of cols) values[c] = JSON_COLS.includes(c) && merged[c] !== null && typeof merged[c] === "object" ? tx.json(merged[c] as never) : merged[c];
          const setClause = cols.map((c) => `"${c}" = excluded."${c}"`).join(", ");
          const out = await tx<{ inserted: boolean }[]>`
            insert into catalog.items ${tx(values as never)}
            on conflict (organization_id, kind, key) do update set ${tx.unsafe(setClause)}, revision = catalog.items.revision + 1, deleted_at = null
            returning (xmax = 0) as inserted`;
          if (out[0]?.inserted) counts.inserted++; else counts.updated++;
        } catch (e) {
          if (e instanceof CatalogBodyError || e instanceof SyntaxError) { counts.skipped++; problems.push(`${where}: ${e.message}`); continue; }
          throw e;
        }
      }
      if (problems.length && !dryRun) throw new Error(`refusing to commit with ${problems.length} bad row(s):\n  ${problems.join("\n  ")}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log(`${dryRun ? "[dry-run — would have] " : ""}org ${orgId}: inserted ${counts.inserted}, updated ${counts.updated}, skipped ${counts.skipped} (of ${raw.length})`);
  for (const p of problems) console.log(`  ! ${p}`);
}

main().catch((e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
