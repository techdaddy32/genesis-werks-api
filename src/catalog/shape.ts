// row: K2 · run: run-2026-10-07-drawing-layer-15 · 2026-10-12 — catalog shape: kinds, columns, per-kind minimum fields, key/label rules, resolvers
//==============================================================================
// catalog/shape.ts — what read.ts and write.ts agree on (contract: work/catalog-contract-v1.md, schema: 058).
//
//   KINDS            the six contract §1 kinds (a new kind = a CHECK value in 058 + a line here, never a table)
//   ITEM_COLUMNS     every catalog.items column the API reads back / a write may set
//   EDITABLE         the subset a POST / PATCH may carry (ids, lifecycle, provenance are server-owned)
//   validateItem()   contract §1 minimum fields per kind (TBD rows exempt), default_label ≤3 (§5 rule 7),
//                    key spelling (stable id carried by placements — never changed after creation)
//   resolveRef()     `*_key` conveniences → ids: the API accepts legend_set_key / symbol_key / default_wire_key
//                    (base or org row) so a dashboard never has to know base uuids
//
// Nothing here touches the database except resolveRef (read-only lookups inside the caller's tx).
//==============================================================================

import type { Tx } from "../org-context";
import type { JsonRow } from "../sync/tables";

export const KINDS = ["symbol", "device", "wire", "accessory", "legend_entry", "bundle"] as const;
export type ItemKind = (typeof KINDS)[number];
export function isKind(k: unknown): k is ItemKind {
  return typeof k === "string" && (KINDS as readonly string[]).includes(k);
}

export const STATUSES = ["active", "tbd", "hidden"] as const;
export type ItemStatus = (typeof STATUSES)[number];

/** Every column of catalog.items, in the order the API returns them. */
export const ITEM_COLUMNS = [
  "id", "organization_id", "kind", "key", "name", "legend_set_id",
  "default_label", "class", "color_hint", "pair_layout", "glyph_file_id", "glyph_key",
  "symbol_item_id", "manufacturer", "model", "category", "part_number", "default_wire_item_id",
  "wire_type", "gauge", "conductors", "jacket", "color",
  "attaches_to", "unit",
  "description", "ordinal",
  "status", "source", "external_id", "pulled_values", "override_of", "attributes",
  "revision", "created_by", "created_at", "updated_at", "deleted_at",
] as const;

/** Columns a POST / PATCH body may set directly (everything else is server-owned or resolved from a *_key). */
export const EDITABLE = [
  "name", "legend_set_id", "default_label", "class", "color_hint", "pair_layout", "glyph_file_id", "glyph_key",
  "symbol_item_id", "manufacturer", "model", "category", "part_number", "default_wire_item_id",
  "wire_type", "gauge", "conductors", "jacket", "color", "attaches_to", "unit", "description", "ordinal",
  "status", "attributes",
] as const;
export type EditableColumn = (typeof EDITABLE)[number];

/** Body keys that are conveniences resolved to ids by resolveRefs(). */
export const REF_KEYS: Record<string, { column: EditableColumn; table: "legend_sets" | "items"; kind?: ItemKind | ItemKind[] }> = {
  legend_set_key: { column: "legend_set_id", table: "legend_sets" },
  symbol_key: { column: "symbol_item_id", table: "items", kind: "symbol" },
  default_wire_key: { column: "default_wire_item_id", table: "items", kind: "wire" },
};

const TEXT_COLS = new Set<string>(["name", "default_label", "class", "color_hint", "glyph_key", "manufacturer", "model", "category", "part_number", "wire_type", "gauge", "jacket", "color", "attaches_to", "unit", "description"]);
const UUID_COLS = new Set<string>(["legend_set_id", "glyph_file_id", "symbol_item_id", "default_wire_item_id"]);
const INT_COLS = new Set<string>(["conductors", "ordinal"]);
const JSON_COLS = new Set<string>(["pair_layout", "attributes"]);

export const KEY_RE = /^[a-z0-9][a-z0-9_.\-]{0,63}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CatalogBodyError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "CatalogBodyError";
  }
}

/** Keep only EDITABLE columns, coerce types, reject junk. Unknown keys are ignored (forward-compatible), *_key keys are left for resolveRefs. */
export function pickEditable(body: Record<string, unknown>): JsonRow {
  const out: JsonRow = {};
  for (const col of EDITABLE) {
    if (!(col in body)) continue;
    const v = body[col];
    if (v === undefined) continue;
    if (v === null) { out[col] = null; continue; }
    if (TEXT_COLS.has(col)) {
      if (typeof v !== "string") throw new CatalogBodyError(`${col} must be a string`);
      out[col] = v.trim() || null;
    } else if (UUID_COLS.has(col)) {
      if (typeof v !== "string" || !UUID_RE.test(v)) throw new CatalogBodyError(`${col} must be a UUID`);
      out[col] = v.toLowerCase();
    } else if (INT_COLS.has(col)) {
      if (!Number.isInteger(Number(v))) throw new CatalogBodyError(`${col} must be an integer`);
      out[col] = Number(v);
    } else if (JSON_COLS.has(col)) {
      if (typeof v !== "object") throw new CatalogBodyError(`${col} must be JSON (object or array)`);
      if (col === "attributes" && Array.isArray(v)) throw new CatalogBodyError("attributes must be an object");
      out[col] = v;
    } else if (col === "status") {
      if (!(STATUSES as readonly string[]).includes(v as string)) throw new CatalogBodyError("status must be active | tbd | hidden");
      out[col] = v;
    }
  }
  if (out.ordinal == null && "ordinal" in out) out.ordinal = 0;
  return out;
}

/** The merged row (existing ∪ patch) must satisfy the contract's per-kind minimum unless it is TBD. Mirrors 058's CHECKs so the error is readable. */
export function validateItem(kind: ItemKind, row: JsonRow): void {
  if (row.default_label != null) {
    const s = String(row.default_label);
    if ([...s].length < 1 || [...s].length > 3) throw new CatalogBodyError("default_label must be 1 to 3 characters (contract §5 rule 7)");
  }
  if (row.attaches_to != null && !["device", "symbol", "any"].includes(String(row.attaches_to))) throw new CatalogBodyError("attaches_to must be device | symbol | any");
  if (row.status === "tbd") return;
  const need = (cols: string[]): void => {
    const missing = cols.filter((c) => row[c] == null);
    if (missing.length) throw new CatalogBodyError(`a ${kind} needs ${cols.join(", ")} (missing: ${missing.join(", ")}) unless status is 'tbd'`);
  };
  switch (kind) {
    case "symbol": need(["default_label", "class", "legend_set_id"]); break;
    case "device": need(["category", "symbol_item_id"]); break;
    case "wire": need(["wire_type", "gauge", "unit"]); break;
    case "accessory": need(["category", "attaches_to", "unit"]); break;
    case "legend_entry": need(["symbol_item_id", "description", "legend_set_id"]); break;
    case "bundle": need(["part_number", "symbol_item_id"]); break;
  }
}

/** A connector value in `source` is refused on every write: connectors write through the gateway (GW run-list), never this API. */
export function assertManualSource(body: Record<string, unknown>): void {
  if (body.source != null && body.source !== "manual") throw new CatalogBodyError("source may only be 'manual' here: connector values are written through the gateway, not this API");
  if (body.external_id != null) throw new CatalogBodyError("external_id is set by the connector pull, not by hand");
  if (body.pulled_values != null) throw new CatalogBodyError("pulled_values is server-owned");
  if (body.override_of != null) throw new CatalogBodyError("override_of is minted by PATCHing a base row, never set by hand");
  if (body.organization_id != null) throw new CatalogBodyError("organization_id comes from the request context");
}

/** Resolve the *_key conveniences in `body` into id columns on `patch` (base OR this org's row; org wins). 422 when unknown. */
export async function resolveRefs(tx: Tx, org: string, body: Record<string, unknown>, patch: JsonRow): Promise<void> {
  for (const [bodyKey, ref] of Object.entries(REF_KEYS)) {
    if (!(bodyKey in body)) continue;
    const v = body[bodyKey];
    if (v === null) { patch[ref.column] = null; continue; }
    if (typeof v !== "string" || !v.trim()) throw new CatalogBodyError(`${bodyKey} must be a key string`);
    const key = v.trim();
    const rows = ref.table === "legend_sets"
      ? await tx<{ id: string }[]>`
          select id from catalog.legend_sets where key = ${key} and (organization_id = ${org} or organization_id is null) and deleted_at is null
           order by organization_id nulls last limit 1`
      : await tx<{ id: string }[]>`
          select id from catalog.items where key = ${key} and kind = ${ref.kind as string} and (organization_id = ${org} or organization_id is null) and deleted_at is null
           order by organization_id nulls last limit 1`;
    if (!rows[0]) throw new CatalogBodyError(`${bodyKey} '${key}' not found (base or this organization)`, 422);
    patch[ref.column] = rows[0].id;
  }
}

/** Translate a Postgres error on catalog.items into a readable 4xx; rethrow anything else. */
export function pgToCatalogError(e: unknown): CatalogBodyError {
  const err = e as { code?: string; constraint_name?: string; message?: string };
  if (err?.code === "23505") return new CatalogBodyError("an item with this kind + key already exists in this organization", 409);
  if (err?.code === "23514") {
    const c = err.constraint_name ?? "";
    if (c === "items_label_len") return new CatalogBodyError("default_label must be 1 to 3 characters (contract §5 rule 7)");
    return new CatalogBodyError(`row fails the catalog rule ${c || "(check constraint)"}`);
  }
  if (err?.code === "23503") return new CatalogBodyError("a referenced id does not exist (legend set, symbol, wire or glyph file)", 422);
  if (err?.code === "42501") return new CatalogBodyError("base rows are immutable through the API (contract §5 rule 1)", 403);
  throw e;
}
