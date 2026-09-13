//==============================================================================
// scripts/reset-sandbox.ts — wipe the Genesis Sandbox tenant and reseed it (SB1).
//
//   DATABASE_URL=postgres://postgres:...@host:5432/postgres npx tsx scripts/reset-sandbox.ts
//   npx tsx scripts/reset-sandbox.ts --counts       # per-table row counts for the sandbox, no changes
//   npx tsx scripts/reset-sandbox.ts --wipe-only    # delete every sandbox row, do not reseed
//   npx tsx scripts/reset-sandbox.ts --i-know       # required when the database NAME contains "prod"
//
// What it touches: ONLY rows whose tenant_id is the sandbox uuid (plus the
// sandbox `tenants` row). It never reads or writes another tenant. The wipe
// deletes in FK-safe order inside one transaction, then re-runs
// supabase/migrations/0003_seed_sandbox.sql verbatim.
//
// Role: `events` is append-only (trigger + revoked DELETE), so the wipe
// temporarily disables `trg_events_immutable` — that needs the table OWNER
// (postgres / the Supabase dashboard role), not genesis_api. Run it with an
// owner URL; genesis_api fails on the first statement with a clear error.
//==============================================================================

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const SANDBOX_TENANT = "f4100000-0000-4000-8000-000000000002";
export const SANDBOX_SLUG = "sandbox";

/** Migration file re-run by the reseed (resolved relative to this script). */
export const SEED_SQL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../supabase/migrations/0003_seed_sandbox.sql");

/**
 * FK-safe delete order for every domain + system table that carries tenant_id.
 * Children before parents; `events` is handled separately (trigger).
 */
export const WIPE_ORDER: readonly string[] = [
  "reminders",
  "action_item_comments",
  "action_items",
  "forum_comments",
  "forums",
  "forum_categories",
  "daily_report_entries",
  "daily_reports",
  "files",
  "hours_entries",
  "materials",
  "items",
  "visit_attendees",
  "visits",
  "todos",
  "wo_tasks",
  "work_orders",
  "deals",
  "projects",
  "contacts",
  "accounts",
  "user_roles",
  "users",
  "calendars",
  "external_ids",
  "integration_credentials",
  "field_definitions",
  "sequences",
  "status_vocab",
  "tenant_settings",
];

type Sql = postgres.Sql<{}>;
type Tx = postgres.TransactionSql<{}>;

/** Every public table with a tenant_id column (catalog-driven, so a new table is never missed by --counts). */
export async function tenantTables(sql: Sql | Tx): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select c.table_name
    from information_schema.columns c
    join pg_class pc on pc.relname = c.table_name
    join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and pc.relkind = 'r'
    order by c.table_name`;
  return rows.map((r) => r.table_name);
}

/** Row counts per tenant-bearing table for the sandbox (+ the tenants row itself). Zero rows are included. */
export async function sandboxCounts(sql: Sql | Tx, tenantId = SANDBOX_TENANT): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const t = await sql<{ n: string }[]>`select count(*)::text as n from public.tenants where id = ${tenantId}`;
  out.tenants = Number(t[0].n);
  for (const table of await tenantTables(sql)) {
    const r = await sql<{ n: string }[]>`select count(*)::text as n from public.${sql(table)} where tenant_id = ${tenantId}`;
    out[table] = Number(r[0].n);
  }
  return out;
}

export interface WipeResult {
  deleted: Record<string, number>;
  total: number;
}

/**
 * Delete every sandbox row in one transaction. Fails (and rolls back) if a
 * tenant-bearing table is missing from WIPE_ORDER and still holds sandbox rows —
 * add it to the list rather than letting a reseed collide with leftovers.
 */
export async function wipeSandbox(sql: Sql, tenantId = SANDBOX_TENANT): Promise<WipeResult> {
  return sql.begin(async (tx) => {
    const deleted: Record<string, number> = {};
    let total = 0;

    // events: append-only by trigger — disable it for this transaction only (needs table owner).
    await tx`alter table public.events disable trigger trg_events_immutable`;
    try {
      const ev = await tx`delete from public.events where tenant_id = ${tenantId}`;
      deleted.events = ev.count;
      total += ev.count;
    } finally {
      await tx`alter table public.events enable trigger trg_events_immutable`;
    }

    for (const table of WIPE_ORDER) {
      const r = await tx`delete from public.${tx(table)} where tenant_id = ${tenantId}`;
      deleted[table] = r.count;
      total += r.count;
    }

    // anything not in WIPE_ORDER (a table added after SB1) must be empty for this tenant
    const known = new Set([...WIPE_ORDER, "events"]);
    const leftovers: string[] = [];
    for (const table of await tenantTables(tx)) {
      if (known.has(table)) continue;
      const r = await tx<{ n: string }[]>`select count(*)::text as n from public.${tx(table)} where tenant_id = ${tenantId}`;
      if (Number(r[0].n) > 0) leftovers.push(`${table} (${r[0].n})`);
    }
    if (leftovers.length) {
      throw new Error(`reset-sandbox: tables with sandbox rows not covered by WIPE_ORDER: ${leftovers.join(", ")} — add them to scripts/reset-sandbox.ts`);
    }

    const tr = await tx`delete from public.tenants where id = ${tenantId}`;
    deleted.tenants = tr.count;
    total += tr.count;
    return { deleted, total };
  });
}

/** Execute 0003_seed_sandbox.sql verbatim (multi-statement, simple protocol). */
export async function seedSandbox(sql: Sql, seedSql = readFileSync(SEED_SQL_PATH, "utf8")): Promise<void> {
  await sql.unsafe(seedSql);
}

/** Wipe, then reseed. Returns the counts after the reseed. */
export async function resetSandbox(sql: Sql, tenantId = SANDBOX_TENANT): Promise<{ wiped: WipeResult; counts: Record<string, number> }> {
  const wiped = await wipeSandbox(sql, tenantId);
  await seedSandbox(sql);
  return { wiped, counts: await sandboxCounts(sql, tenantId) };
}

/** The database name of a postgres:// URL ("" when unparsable). */
export function databaseNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

/** True when the URL looks like production (database name contains "prod"). */
export function looksLikeProd(url: string): boolean {
  return /prod/i.test(databaseNameOf(url));
}

//------------------------------------------------------------------------------
// CLI
//------------------------------------------------------------------------------

function printCounts(title: string, counts: Record<string, number>): void {
  const width = Math.max(...Object.keys(counts).map((k) => k.length));
  console.log(title);
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(width)}  ${String(v).padStart(6)}`);
  }
  console.log(`  ${"total".padEnd(width)}  ${String(Object.values(counts).reduce((a, b) => a + b, 0)).padStart(6)}`);
}

async function main(): Promise<void> {
  const has = (flag: string) => process.argv.includes(flag);
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    console.error("reset-sandbox: DATABASE_URL is not set (postgres:// URL as the table owner, e.g. postgres).");
    process.exit(2);
  }
  if (looksLikeProd(url) && !has("--i-know")) {
    console.error(`reset-sandbox: database "${databaseNameOf(url)}" looks like PRODUCTION. Re-run with --i-know to proceed (only the sandbox tenant is touched).`);
    process.exit(3);
  }

  const sql = postgres(url, { prepare: false, max: 1, fetch_types: false, onnotice: (n) => console.log(`  ${n.message}`) });
  try {
    if (has("--counts")) {
      printCounts(`Sandbox tenant ${SANDBOX_TENANT} — rows per table:`, await sandboxCounts(sql));
      return;
    }
    const wiped = await wipeSandbox(sql);
    console.log(`Wiped ${wiped.total} sandbox rows.`);
    if (has("--wipe-only")) return;
    await seedSandbox(sql);
    printCounts("Reseeded. Rows per table:", await sandboxCounts(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/reset-sandbox.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
