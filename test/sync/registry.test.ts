// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// The allow-list in src/sync/tables.ts must describe the APPLIED schema (001→090), and the
// rejection-reason / change-kind vocabularies must be exactly the 036 CHECK lists.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, type Sql } from "./_db";
import { TABLE_SPECS, SYNC_TABLES, SYNC_SET_COLUMNS, PARENT_TARGETS, REJECTION_REASONS } from "../../src/sync/tables";

const available = await dbAvailable();

describe.skipIf(!available)("sync registry matches the applied schema", () => {
  let owner: Sql;
  beforeAll(() => { owner = ownerSql(); });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("every allow-listed table exists with RLS enabled and every listed column exists", async () => {
    for (const table of SYNC_TABLES) {
      const [schema, name] = table.split(".");
      const rls = await owner<{ relrowsecurity: boolean }[]>`
        select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = ${schema} and c.relname = ${name}`;
      expect(rls.length, `${table} exists`).toBe(1);
      expect(rls[0].relrowsecurity, `${table} has RLS`).toBe(true);
      const cols = await owner<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_schema = ${schema} and table_name = ${name}`;
      const have = new Set(cols.map((c) => c.column_name));
      for (const c of ["id", "received_at", ...SYNC_SET_COLUMNS, ...TABLE_SPECS[table].columns]) {
        expect(have.has(c), `${table}.${c}`).toBe(true);
      }
    }
  });

  it("every parent target table exists", async () => {
    for (const target of new Set(Object.values(PARENT_TARGETS))) {
      const [schema, name] = target.split(".");
      const r = await owner<{ one: number }[]>`select 1 as one from information_schema.tables where table_schema = ${schema} and table_name = ${name}`;
      expect(r.length, target).toBe(1);
    }
  });

  it("REJECTION_REASONS is exactly the sync_rejections.reason CHECK — and carries no layer-based reason", async () => {
    const def = await owner<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'sync_rejections_reason_check'`;
    expect(def.length).toBe(1);
    const inDb = [...def[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect([...REJECTION_REASONS].sort()).toEqual(inDb);
    expect(inDb.some((r) => r.startsWith("layer"))).toBe(false);
  });

  it("the Worker never emits a layer-based rejection reason (source scan)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../src/sync");
    for (const f of await fs.readdir(dir)) {
      const src = await fs.readFile(path.join(dir, f), "utf8");
      expect(src.includes("'layer_locked'") || src.includes('"layer_locked"'), f).toBe(false);
      expect(src.includes("'layer_policy'") || src.includes('"layer_policy"'), f).toBe(false);
    }
  });

  it("no rule hook is registered in W1 (the per-table seam is empty)", () => {
    for (const table of SYNC_TABLES) expect(TABLE_SPECS[table].rules, table).toBeUndefined();
  });
});
