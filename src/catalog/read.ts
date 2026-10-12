// row: K2 · run: run-2026-10-07-drawing-layer-15 · 2026-10-12 — the merged catalog view (base ∪ org, override resolution, ETag / 304, since-delta)
//==============================================================================
// catalog/read.ts — what a palette / dashboard loads (contract: work/catalog-contract-v1.md; schema: 058).
//
//   GET /catalog?kind=&legend_set=&since=&include_hidden=0|1        (any member role)
//       → 200 {legend_sets[], items[], bundle_lines[], tombstones[], etag, generated_at, since}
//         · ETag header; `If-None-Match` matching → 304 with no body
//   GET /catalog/items/:id          → 200 {item} (resolved: a base id answers with the org's override when one exists) · 404
//   GET /catalog/bundles/:id/lines  → 200 {bundle, lines[]} (live lines, ordinal order, each with the line item's key/kind/name/unit) · 404 · 409 not a bundle
//
// MERGE RULE (contract §3 / §5 rule 1): the visible set is the Horizon base (organization_id NULL) ∪ this
// organization's rows. An org row with override_of = <base id> REPLACES that base row in the output (the
// override carries `override_of` so a client can show "overridden" and map a placement's key either way —
// the key is the same on both). Hidden (status 'hidden') and tombstoned (deleted_at) rows are omitted unless
// include_hidden=1 — so an org that hides a base symbol via an override drops it from its palette. TBD rows
// (status 'tbd') are ALWAYS included (§5 rule 3: visible with an "undefined" badge, not placeable).
//
// DELTA (since=): items / legend_sets / bundle_lines with updated_at > since, plus `tombstones[]` = ids the
// client must drop: rows hidden or deleted since, AND the base ids newly shadowed by an override since (the
// override arrives in items[] with override_of, so the client swaps). A full load has tombstones: [].
//
// ETag = sha-256 hex of `${org}:${max(updated_at)}:${count}` over EVERY candidate row of the three tables
// (base ∪ org, hidden and deleted included — a hide changes updated_at, so the tag moves), with the
// normalised filters appended when any is given (`:kind=…:legend_set=…:include_hidden=…`) so two filtered
// views never share a tag. since= responses carry an ETag too (same formula) but a client should not 304 on them.
//
// Every statement runs under withOrgRead (SET LOCAL app.org_id): RLS lets the base rows through
// (organization_id IS NULL policy) and nothing of another organization.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrgRead } from "../org-context";
import { isUuid } from "../db";
import type { RouteResult } from "../sync/checkout";
import type { JsonRow } from "../sync/tables";
import { isKind } from "./shape";

export interface CatalogReadResult extends RouteResult {
  headers?: Record<string, string>;
}

function bad(error: string): RouteResult {
  return { status: 400, body: { error } };
}

//------------------------------------------------------------------------------
// Shared selects
//------------------------------------------------------------------------------

/** `i.<col>` for every item column + the key conveniences (legend_set_key / symbol_key / default_wire_key). */
export const ITEM_SELECT = (tx: Tx) => tx`
  select i.id, i.organization_id, i.kind, i.key, i.name, i.legend_set_id,
         i.default_label, i.class, i.color_hint, i.pair_layout, i.glyph_file_id, i.glyph_key,
         i.symbol_item_id, i.manufacturer, i.model, i.category, i.part_number, i.default_wire_item_id,
         i.wire_type, i.gauge, i.conductors, i.jacket, i.color,
         i.attaches_to, i.unit,
         i.description, i.ordinal,
         i.status, i.source, i.external_id, i.pulled_values, i.override_of, i.attributes,
         i.revision, i.created_by, i.created_at, i.updated_at, i.deleted_at,
         ls.key as legend_set_key, sy.key as symbol_key, wi.key as default_wire_key
    from catalog.items i
    left join catalog.legend_sets ls on ls.id = i.legend_set_id
    left join catalog.items sy on sy.id = i.symbol_item_id
    left join catalog.items wi on wi.id = i.default_wire_item_id`;

const LEGEND_SET_SELECT = (tx: Tx) => tx`
  select s.id, s.organization_id, s.key, s.name, s.ordinal, s.status, s.override_of, s.revision, s.created_at, s.updated_at, s.deleted_at
    from catalog.legend_sets s`;

const BUNDLE_LINE_SELECT = (tx: Tx) => tx`
  select bl.id, bl.organization_id, bl.bundle_item_id, bl.line_item_id, bl.quantity, bl.unit, bl.ordinal, bl.revision,
         bl.created_at, bl.updated_at, bl.deleted_at,
         li.key as line_item_key, li.kind as line_item_kind, li.name as line_item_name, coalesce(bl.unit, li.unit) as unit_resolved
    from catalog.bundle_lines bl
    join catalog.items li on li.id = bl.line_item_id`;

/** Every candidate row of ONE table (base ∪ org), newest-first is not needed; ordinal order for display. */
async function readItems(tx: Tx, org: string, kind: string | null): Promise<JsonRow[]> {
  return tx<JsonRow[]>`
    ${ITEM_SELECT(tx)}
     where (i.organization_id = ${org} or i.organization_id is null)
       ${kind ? tx`and i.kind = ${kind}` : tx``}
     order by i.kind, i.ordinal, i.key, i.organization_id nulls first`;
}

/** Hidden = status 'hidden' or tombstoned. */
export function isHidden(r: JsonRow): boolean {
  return r.status === "hidden" || r.deleted_at != null;
}

/**
 * The merge: org rows with override_of replace their base row. Returns the resolved list (display order kept)
 * plus the base ids that were shadowed. Hidden rows are dropped unless `includeHidden`.
 */
export function resolveOverrides(rows: JsonRow[], org: string, includeHidden: boolean): { resolved: JsonRow[]; shadowed: Map<string, JsonRow> } {
  const overrides = new Map<string, JsonRow>(); // base id → org override
  for (const r of rows) if (r.organization_id === org && r.override_of != null) overrides.set(String(r.override_of), r);
  const resolved: JsonRow[] = [];
  for (const r of rows) {
    if (r.organization_id == null) {
      const o = overrides.get(String(r.id));
      const pick = o ?? r;
      if (!includeHidden && isHidden(pick)) continue;
      resolved.push(pick);
    } else if (r.override_of != null) {
      continue; // emitted in the base row's slot above (or the base was filtered by kind: emit below)
    } else {
      if (!includeHidden && isHidden(r)) continue;
      resolved.push(r);
    }
  }
  // An override whose base is not in `rows` (should not happen: same kind/table) still surfaces.
  const emitted = new Set(resolved.map((r) => String(r.id)));
  for (const [, o] of overrides) if (!emitted.has(String(o.id)) && !rows.some((r) => String(r.id) === String(o.override_of))) {
    if (includeHidden || !isHidden(o)) resolved.push(o);
  }
  return { resolved, shadowed: overrides };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `${org}:${max(updated_at)}:${count}` over the three catalog tables (base ∪ org, hidden + deleted included). */
export async function computeEtag(tx: Tx, org: string, filterSuffix = ""): Promise<string> {
  const rows = await tx<{ mx: Date | null; n: string }[]>`
    select max(u) as mx, count(*)::text as n from (
      select updated_at as u from catalog.items        where organization_id = ${org} or organization_id is null
      union all
      select updated_at from catalog.legend_sets       where organization_id = ${org} or organization_id is null
      union all
      select updated_at from catalog.bundle_lines      where organization_id = ${org} or organization_id is null
    ) t`;
  const mx = rows[0]?.mx ? new Date(rows[0].mx).toISOString() : "none";
  return sha256Hex(`${org}:${mx}:${rows[0]?.n ?? "0"}${filterSuffix}`);
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").map((s) => s.trim().replace(/^W\//i, "").replace(/^"|"$/g, "")).some((s) => s === "*" || s === etag);
}

//------------------------------------------------------------------------------
// GET /catalog
//------------------------------------------------------------------------------

export async function getCatalog(ctx: OrganizationContext, params: URLSearchParams, ifNoneMatch: string | null): Promise<CatalogReadResult> {
  const kind = (params.get("kind") ?? "").trim().toLowerCase() || null;
  if (kind && !isKind(kind)) return bad("kind must be symbol | device | wire | accessory | legend_entry | bundle");
  const legendSet = (params.get("legend_set") ?? "").trim() || null;
  const sinceRaw = (params.get("since") ?? "").trim();
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) return bad("since must be an ISO-8601 timestamp");
  const since = sinceRaw || null;
  const includeHidden = ["1", "true"].includes((params.get("include_hidden") ?? "").trim().toLowerCase());
  const org = ctx.organizationId;
  const filterSuffix = kind || legendSet || includeHidden ? `:kind=${kind ?? ""}:legend_set=${legendSet ?? ""}:include_hidden=${includeHidden ? 1 : 0}` : "";

  return withOrgRead(ctx, async (tx) => {
    const etag = await computeEtag(tx, org, filterSuffix);
    if (!since && etagMatches(ifNoneMatch, etag)) return { status: 304, body: {}, headers: { ETag: `"${etag}"` } };

    // legend sets — same merge rule
    const setRows = await tx<JsonRow[]>`${LEGEND_SET_SELECT(tx)} where (s.organization_id = ${org} or s.organization_id is null) order by s.ordinal, s.key, s.organization_id nulls first`;
    const sets = resolveOverrides(setRows, org, includeHidden);
    let setIds: Set<string> | null = null;
    if (legendSet) {
      // the filter names a set KEY; match the resolved set and its base/override twin so items pointing at either are kept
      const ids = new Set<string>();
      for (const s of setRows) if (s.key === legendSet) { ids.add(String(s.id)); if (s.override_of) ids.add(String(s.override_of)); }
      if (!ids.size) return bad(`legend_set '${legendSet}' not found`);
      setIds = ids;
    }

    // items
    const itemRows = await readItems(tx, org, kind);
    const items = resolveOverrides(itemRows, org, includeHidden);
    let visible = items.resolved;
    if (setIds) visible = visible.filter((r) => r.legend_set_id != null && setIds!.has(String(r.legend_set_id)));

    // bundle lines for the bundles in view (base ∪ org lines; the bundle id is the resolved row's id)
    const bundleIds = visible.filter((r) => r.kind === "bundle").map((r) => String(r.id));
    const lineRows = bundleIds.length
      ? await tx<JsonRow[]>`${BUNDLE_LINE_SELECT(tx)} where (bl.organization_id = ${org} or bl.organization_id is null) and bl.bundle_item_id in ${tx(bundleIds)} order by bl.bundle_item_id, bl.ordinal, bl.id`
      : [];
    const lines = includeHidden ? lineRows : lineRows.filter((l) => l.deleted_at == null);

    // delta
    const tombstones: string[] = [];
    let outSets = sets.resolved;
    let outItems = visible;
    let outLines = lines;
    if (since) {
      const after = (r: JsonRow) => new Date(r.updated_at as Date).getTime() > Date.parse(since);
      outSets = sets.resolved.filter(after);
      outItems = visible.filter(after);
      outLines = lines.filter(after);
      const seen = new Set<string>();
      const tomb = (id: unknown) => { const s = String(id); if (!seen.has(s)) { seen.add(s); tombstones.push(s); } };
      for (const r of [...itemRows, ...setRows]) {
        if (!after(r)) continue;
        if (isHidden(r)) tomb(r.id);
        if (r.organization_id === org && r.override_of != null) tomb(r.override_of); // the base id this override now shadows
      }
      for (const l of lineRows) if (after(l) && l.deleted_at != null) tomb(l.id);
      // never tombstone something we are also sending as live
      const live = new Set([...outItems, ...outSets, ...outLines].map((r) => String(r.id)));
      for (let i = tombstones.length - 1; i >= 0; i--) if (live.has(tombstones[i])) tombstones.splice(i, 1);
    }

    return {
      status: 200,
      headers: { ETag: `"${etag}"` },
      body: {
        organization_id: org,
        since,
        include_hidden: includeHidden,
        kind,
        legend_set: legendSet,
        etag,
        generated_at: new Date().toISOString(),
        legend_sets: outSets,
        items: outItems,
        bundle_lines: outLines,
        tombstones,
      },
    };
  });
}

//------------------------------------------------------------------------------
// GET /catalog/items/:id
//------------------------------------------------------------------------------

/** One item by id, visible to this org (base or own). NOT resolved — write.ts needs the raw row. */
export async function readItemRaw(tx: Tx, org: string, id: string): Promise<JsonRow | null> {
  const rows = await tx<JsonRow[]>`${ITEM_SELECT(tx)} where i.id = ${id} and (i.organization_id = ${org} or i.organization_id is null) limit 1`;
  return rows[0] ?? null;
}

/** The org's override of a base row, if any (live or hidden — a hidden override still shadows). */
export async function readOverrideOf(tx: Tx, org: string, baseId: string): Promise<JsonRow | null> {
  const rows = await tx<JsonRow[]>`${ITEM_SELECT(tx)} where i.override_of = ${baseId} and i.organization_id = ${org} order by i.deleted_at nulls first, i.updated_at desc limit 1`;
  return rows[0] ?? null;
}

/** Resolved: a base id answers with the org's override when one exists. */
export async function readItemResolved(tx: Tx, org: string, id: string): Promise<JsonRow | null> {
  const raw = await readItemRaw(tx, org, id);
  if (!raw) return null;
  if (raw.organization_id == null) return (await readOverrideOf(tx, org, String(raw.id))) ?? raw;
  return raw;
}

export async function getItem(ctx: OrganizationContext, id: string): Promise<RouteResult> {
  if (!isUuid(id)) return bad("item id must be a UUID");
  return withOrgRead(ctx, async (tx) => {
    const item = await readItemResolved(tx, ctx.organizationId, id.toLowerCase());
    if (!item || item.deleted_at != null) return { status: 404, body: { error: "catalog item not found" } };
    return { status: 200, body: { item, resolved_from: String(item.id) === id.toLowerCase() ? null : id.toLowerCase() } };
  });
}

//------------------------------------------------------------------------------
// GET /catalog/bundles/:id/lines
//------------------------------------------------------------------------------

export async function readBundleLines(tx: Tx, org: string, bundleId: string, includeDeleted = false): Promise<JsonRow[]> {
  return tx<JsonRow[]>`
    ${BUNDLE_LINE_SELECT(tx)}
     where (bl.organization_id = ${org} or bl.organization_id is null) and bl.bundle_item_id = ${bundleId}
       ${includeDeleted ? tx`` : tx`and bl.deleted_at is null`}
     order by bl.ordinal, bl.id`;
}

export async function getBundleLines(ctx: OrganizationContext, id: string): Promise<RouteResult> {
  if (!isUuid(id)) return bad("bundle id must be a UUID");
  return withOrgRead(ctx, async (tx) => {
    const bundle = await readItemResolved(tx, ctx.organizationId, id.toLowerCase());
    if (!bundle || bundle.deleted_at != null) return { status: 404, body: { error: "bundle not found" } };
    if (bundle.kind !== "bundle") return { status: 409, body: { error: `item is a ${String(bundle.kind)}, not a bundle` } };
    const lines = await readBundleLines(tx, ctx.organizationId, String(bundle.id));
    return { status: 200, body: { bundle, lines } };
  });
}
