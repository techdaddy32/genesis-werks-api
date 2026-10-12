// row: K2 · run: run-2026-10-07-drawing-layer-15 · 2026-10-12 — office/admin catalog writes: org rows only, base rows become overrides, never a delete
//==============================================================================
// catalog/write.ts — the by-hand side of the Catalog dashboard (contract §4.1, §5; schema 058). office / admin only.
//
//   POST  /catalog/items                {kind, key, name, status?, …kind fields, legend_set_key? symbol_key? default_wire_key?}
//                                       → 201 {item} · 400 (validation; a connector `source`) · 409 duplicate org+kind+key
//   PATCH /catalog/items/:id            {…fields}  org row → 200 {item, overrode:false} (revision+1)
//                                       BASE row → the base is never touched (RLS WITH CHECK would refuse anyway): an override row
//                                       is minted for the org (override_of = base.id, base fields copied, patch applied, same key)
//                                       → 201 {item, overrode:true}; a second PATCH on the base id updates that override → 200
//                                       · key / kind / id are immutable (400) · 404 unknown / tombstoned
//   POST  /catalog/items/:id/hide       → status 'hidden' (override row when the target is base) → 200 / 201 as above
//   POST  /catalog/items/:id/glyph      (symbol only) presign a glyph SVG through the ordinary files flow (files.ts):
//                                       creates a shared.files row {kind 'glyph', content_type image/svg+xml, filename <key>.svg}
//                                       → 201 {file_id, put_url, storage_key, item_id, then}. The client PUTs the bytes to put_url
//                                       (that flips pending → uploaded; out-of-band uploads call POST /files/:id/uploaded), THEN
//                                       PATCHes /catalog/items/:id {glyph_file_id}. No new upload path — one R2 flow for everything.
//   PUT   /catalog/bundles/:id/lines    [{line_item_id | line_item_key, quantity, unit?}] replaces the ORG bundle's lines
//                                       (missing ones get deleted_at; matching ones are updated; order = array order)
//                                       → 200 {bundle, lines[]} · 409 when the bundle is a base row (PATCH it first → override)
//   DELETE (any catalog path)           405 — there is no delete (contract §5 rule 1: hide / tombstone only)
//
// SOURCE (contract §4): a write whose `source` is a connector value is refused (400) — connectors write through the gateway.
// A manual PATCH on an item whose source is a connector sets source = 'manual' and copies the previous values into
// `pulled_values` ({source, external_id, pulled_at, values:{…previous editable fields}}) so the pulled value stays beside the edit.
//
// EVENTS: one shared.events row per write — catalog.item.changed (ref_table catalog.items) /
// catalog.bundle.changed (ref_table catalog.items, the bundle) — via emitEvent (checkout.ts), idempotency key
// catalog.items:<id>:<revision>[:<op>]. project_id is NULL: the catalog is organization-wide.
//
// Every statement runs under withOrg (SET LOCAL app.org_id): RLS WITH CHECK (organization_id = app.org_id) is the backstop
// that makes a base-row write impossible even if this file drifted.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { emitEvent, type RouteResult } from "../sync/checkout";
import { isOfficeOrAdmin } from "../sync/drawings";
import { createFile } from "../sync/files";
import type { JsonRow } from "../sync/tables";
import { readItemRaw, readOverrideOf, readBundleLines } from "./read";
import { CatalogBodyError, EDITABLE, KEY_RE, isKind, pickEditable, validateItem, assertManualSource, resolveRefs, pgToCatalogError, type ItemKind } from "./shape";

const JSON_COLS = new Set<string>(["pair_layout", "attributes", "pulled_values"]);

function gate(ctx: OrganizationContext): RouteResult | null {
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may edit the catalog" } };
  return null;
}

function asBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Wrap jsonb values for the postgres.js object helper (an array would otherwise be inferred as a text[]). */
function pgValues(tx: Tx, row: JsonRow): JsonRow {
  const out: JsonRow = {};
  for (const [k, v] of Object.entries(row)) out[k] = JSON_COLS.has(k) && v !== null && typeof v === "object" ? tx.json(v as never) : v;
  return out;
}

async function catalogEvent(tx: Tx, ctx: OrganizationContext, item: JsonRow, op: string, extra: JsonRow = {}): Promise<void> {
  await emitEvent(tx, ctx, {
    projectId: null, refTable: "catalog.items", refId: String(item.id), type: op.startsWith("bundle") ? "catalog.bundle.changed" : "catalog.item.changed",
    payload: { op, kind: item.kind, key: item.key, revision: item.revision, override_of: item.override_of ?? null, status: item.status, ...extra },
    key: `catalog.items:${String(item.id)}:${String(item.revision)}:${op}`,
  });
}

//------------------------------------------------------------------------------
// POST /catalog/items
//------------------------------------------------------------------------------

export async function createItem(ctx: OrganizationContext, bodyIn: unknown): Promise<RouteResult> {
  const denied = gate(ctx);
  if (denied) return denied;
  const body = asBody(bodyIn);
  try {
    assertManualSource(body);
    if (!isKind(body.kind)) throw new CatalogBodyError("kind must be symbol | device | wire | accessory | legend_entry | bundle");
    if (typeof body.key !== "string" || !KEY_RE.test(body.key.trim())) throw new CatalogBodyError("key is required: 1–64 characters of letters, digits, _ . - (it is the stable id placements carry)");
    if (typeof body.name !== "string" || !body.name.trim()) throw new CatalogBodyError("name is required");
    if (body.id != null && !isUuid(body.id)) throw new CatalogBodyError("id must be a UUID when given");
  } catch (e) {
    if (e instanceof CatalogBodyError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
  const kind = body.kind as ItemKind;
  const key = (body.key as string).trim();
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    try {
      const patch = pickEditable(body);
      await resolveRefs(tx, org, body, patch);
      const row: JsonRow = { ...patch, kind, key, name: (body.name as string).trim(), status: patch.status ?? "active" };
      validateItem(kind, row);
      // pre-check the (org, kind, key) uniqueness: a failed statement would abort the transaction (postgres.js rethrows after the callback)
      const dup = await tx<{ id: string }[]>`select id from catalog.items where organization_id = ${org} and kind = ${kind} and key = ${key} limit 1`;
      if (dup[0]) throw new CatalogBodyError(`an item with kind '${kind}' and key '${key}' already exists in this organization (${dup[0].id})`, 409);
      const insert: JsonRow = { ...row, organization_id: org, source: "manual", created_by: ctx.actorId, ...(body.id ? { id: String(body.id).toLowerCase() } : {}) };
      const rows = await tx<JsonRow[]>`insert into catalog.items ${tx(pgValues(tx, insert) as never)} returning *`;
      const item = rows[0];
      await catalogEvent(tx, ctx, item, "created");
      return { status: 201, body: { item, overrode: false } };
    } catch (e) {
      const err = e instanceof CatalogBodyError ? e : pgToCatalogError(e);
      return { status: err.status, body: { error: err.message } };
    }
  });
}

//------------------------------------------------------------------------------
// PATCH /catalog/items/:id · POST /catalog/items/:id/hide
//------------------------------------------------------------------------------

/** The editable field values of a row — what an override copies from its base, and what pulled_values keeps. */
function editableValues(row: JsonRow): JsonRow {
  const out: JsonRow = {};
  for (const c of EDITABLE) out[c] = row[c] ?? null;
  return out;
}

async function applyPatch(ctx: OrganizationContext, id: string, body: Record<string, unknown>, op: "updated" | "hidden"): Promise<RouteResult> {
  const denied = gate(ctx);
  if (denied) return denied;
  if (!isUuid(id)) return { status: 400, body: { error: "item id must be a UUID" } };
  const org = ctx.organizationId;
  const itemId = id.toLowerCase();

  return withOrg(ctx, async (tx) => {
    try {
      assertManualSource(body);
      for (const immutable of ["id", "kind", "key", "revision", "created_by", "deleted_at"]) {
        if (body[immutable] != null) throw new CatalogBodyError(`${immutable} is immutable (${immutable === "key" ? "placements carry the key — add a new item instead" : "server-owned"})`);
      }
      const raw = await readItemRaw(tx, org, itemId);
      if (!raw || raw.deleted_at != null) return { status: 404, body: { error: "catalog item not found" } };
      const kind = raw.kind as ItemKind;
      const patch = pickEditable(body);
      await resolveRefs(tx, org, body, patch);
      if (op === "hidden") patch.status = "hidden";
      if (Object.keys(patch).length === 0) throw new CatalogBodyError("nothing to change");

      // ---- BASE row: never touched. Mint or update the org's override. --------------------------------
      if (raw.organization_id == null) {
        const existing = await readOverrideOf(tx, org, String(raw.id));
        if (existing && existing.deleted_at == null) {
          return await updateOrgRow(tx, ctx, existing, patch, op, { overrode: true, via_base: String(raw.id) }, 200);
        }
        const merged: JsonRow = { ...editableValues(raw), ...patch };
        validateItem(kind, merged);
        const insert: JsonRow = { ...merged, organization_id: org, kind, key: raw.key, override_of: String(raw.id), source: "manual", created_by: ctx.actorId };
        const rows = existing
          // a TOMBSTONED override (seed re-points, 091) is revived in place rather than colliding on (org, kind, key)
          ? await tx<JsonRow[]>`update catalog.items set ${tx(pgValues(tx, { ...insert, deleted_at: null, revision: Number(existing.revision) + 1 }) as never)} where id = ${String(existing.id)} and organization_id = ${org} returning *`
          : await tx<JsonRow[]>`insert into catalog.items ${tx(pgValues(tx, insert) as never)} returning *`;
        const item = rows[0];
        await catalogEvent(tx, ctx, item, op === "hidden" ? "hidden" : "overridden", { base_id: String(raw.id), changed: Object.keys(patch) });
        return { status: 201, body: { item, overrode: true, base_id: String(raw.id) } };
      }

      // ---- ORG row: plain update ---------------------------------------------------------------------
      return await updateOrgRow(tx, ctx, raw, patch, op, { overrode: false }, 200);
    } catch (e) {
      const err = e instanceof CatalogBodyError ? e : pgToCatalogError(e);
      return { status: err.status, body: { error: err.message } };
    }
  });
}

async function updateOrgRow(tx: Tx, ctx: OrganizationContext, cur: JsonRow, patch: JsonRow, op: "updated" | "hidden", meta: JsonRow, status: number): Promise<RouteResult> {
  const kind = cur.kind as ItemKind;
  const merged: JsonRow = { ...editableValues(cur), ...patch };
  validateItem(kind, merged);
  const set: JsonRow = { ...patch, revision: Number(cur.revision) + 1 };
  let sourceFlipped = false;
  if (cur.source !== "manual") {
    // contract §4: the hand edit wins; the connector's values stay beside it for reference
    sourceFlipped = true;
    set.source = "manual";
    set.pulled_values = { source: cur.source, external_id: cur.external_id ?? null, pulled_at: new Date().toISOString(), values: editableValues(cur) };
  }
  const rows = await tx<JsonRow[]>`update catalog.items set ${tx(pgValues(tx, set) as never)} where id = ${String(cur.id)} and organization_id = ${ctx.organizationId} returning *`;
  const item = rows[0];
  await catalogEvent(tx, ctx, item, op, { changed: Object.keys(patch), source_flipped: sourceFlipped, previous_source: sourceFlipped ? cur.source : null });
  return { status, body: { item, ...meta } };
}

export async function patchItem(ctx: OrganizationContext, id: string, body: unknown): Promise<RouteResult> {
  return applyPatch(ctx, id, asBody(body), "updated");
}

export async function hideItem(ctx: OrganizationContext, id: string): Promise<RouteResult> {
  return applyPatch(ctx, id, {}, "hidden");
}

//------------------------------------------------------------------------------
// POST /catalog/items/:id/glyph
//------------------------------------------------------------------------------

export async function presignGlyph(ctx: OrganizationContext, id: string, putUrl: (fileId: string) => string): Promise<RouteResult> {
  const denied = gate(ctx);
  if (denied) return denied;
  if (!isUuid(id)) return { status: 400, body: { error: "item id must be a UUID" } };
  const org = ctx.organizationId;
  const item = await withOrg(ctx, (tx) => readItemRaw(tx, org, id.toLowerCase()), { readOnly: true });
  if (!item || item.deleted_at != null) return { status: 404, body: { error: "catalog item not found" } };
  if (item.kind !== "symbol") return { status: 409, body: { error: `glyphs belong to symbols; this item is a ${String(item.kind)}` } };
  const r = await createFile(ctx, { kind: "glyph", filename: `${String(item.key)}.svg`, content_type: "image/svg+xml", custom: { catalog_item_id: String(item.id), catalog_key: item.key } }, putUrl);
  if (r.status !== 201 && r.status !== 200) return r;
  return {
    status: 201,
    body: {
      ...r.body, item_id: String(item.id),
      then: `PUT the SVG bytes to put_url (Content-Type image/svg+xml); then PATCH /catalog/items/${String(item.id)} {"glyph_file_id": "<file_id>"}${item.organization_id == null ? " — the item is a base row, so that PATCH mints your organization's override" : ""}`,
    },
  };
}

//------------------------------------------------------------------------------
// PUT /catalog/bundles/:id/lines
//------------------------------------------------------------------------------

const LINE_KINDS = new Set(["device", "wire", "accessory"]);

export async function putBundleLines(ctx: OrganizationContext, id: string, bodyIn: unknown): Promise<RouteResult> {
  const denied = gate(ctx);
  if (denied) return denied;
  if (!isUuid(id)) return { status: 400, body: { error: "bundle id must be a UUID" } };
  const linesIn = Array.isArray(bodyIn) ? bodyIn : Array.isArray((bodyIn as { lines?: unknown })?.lines) ? (bodyIn as { lines: unknown[] }).lines : null;
  if (!linesIn) return { status: 400, body: { error: "body must be an array of {line_item_id | line_item_key, quantity, unit?} (or {lines: [...]})" } };
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    try {
      const bundle = await readItemRaw(tx, org, id.toLowerCase());
      if (!bundle || bundle.deleted_at != null) return { status: 404, body: { error: "bundle not found" } };
      if (bundle.kind !== "bundle") return { status: 409, body: { error: `item is a ${String(bundle.kind)}, not a bundle` } };
      if (bundle.organization_id == null) {
        const ov = await readOverrideOf(tx, org, String(bundle.id));
        if (!ov || ov.deleted_at != null) return { status: 409, body: { error: "this bundle is a Horizon base row: PATCH /catalog/items/:id first to mint your organization's override, then PUT its lines on the override id" } };
        return await putBundleLines(ctx, String(ov.id), linesIn);
      }

      // validate + resolve lines
      const wanted: { lineId: string; quantity: number; unit: string | null; ordinal: number }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < linesIn.length; i++) {
        const l = asBody(linesIn[i]);
        let lineId: string | null = null;
        if (l.line_item_id != null) {
          if (!isUuid(l.line_item_id)) throw new CatalogBodyError(`lines[${i}].line_item_id must be a UUID`);
          lineId = String(l.line_item_id).toLowerCase();
        } else if (typeof l.line_item_key === "string" && l.line_item_key.trim()) {
          const rows = await tx<{ id: string }[]>`
            select id from catalog.items where key = ${l.line_item_key.trim()} and kind in ('device','wire','accessory')
               and (organization_id = ${org} or organization_id is null) and deleted_at is null
             order by organization_id nulls last limit 1`;
          if (!rows[0]) throw new CatalogBodyError(`lines[${i}].line_item_key '${l.line_item_key}' not found`, 422);
          lineId = rows[0].id;
        } else throw new CatalogBodyError(`lines[${i}] needs line_item_id or line_item_key`);
        const q = l.quantity == null ? 1 : Number(l.quantity);
        if (!Number.isFinite(q) || q <= 0) throw new CatalogBodyError(`lines[${i}].quantity must be > 0`);
        const unit = l.unit == null ? null : typeof l.unit === "string" ? l.unit.trim() || null : null;
        if (l.unit != null && typeof l.unit !== "string") throw new CatalogBodyError(`lines[${i}].unit must be a string`);
        if (seen.has(lineId)) throw new CatalogBodyError(`lines[${i}] repeats line item ${lineId}`);
        seen.add(lineId);
        const li = await readItemRaw(tx, org, lineId);
        if (!li || li.deleted_at != null) throw new CatalogBodyError(`lines[${i}] line item ${lineId} not found`, 422);
        if (!LINE_KINDS.has(String(li.kind))) throw new CatalogBodyError(`lines[${i}] line item is a ${String(li.kind)}; a bundle line is a device, wire or accessory`);
        if (lineId === String(bundle.id)) throw new CatalogBodyError(`lines[${i}] a bundle cannot contain itself`);
        wanted.push({ lineId, quantity: q, unit, ordinal: i + 1 });
      }

      // replace: upsert the wanted set, tombstone the rest
      for (const w of wanted) {
        await tx`
          insert into catalog.bundle_lines (organization_id, bundle_item_id, line_item_id, quantity, unit, ordinal)
          values (${org}, ${String(bundle.id)}, ${w.lineId}, ${w.quantity}, ${w.unit}, ${w.ordinal})
          on conflict (bundle_item_id, line_item_id) do update
             set quantity = excluded.quantity, unit = excluded.unit, ordinal = excluded.ordinal, deleted_at = null,
                 revision = catalog.bundle_lines.revision + 1`;
      }
      const keep = wanted.map((w) => w.lineId);
      const gone = await tx<{ id: string }[]>`
        update catalog.bundle_lines set deleted_at = now(), revision = revision + 1
         where bundle_item_id = ${String(bundle.id)} and organization_id = ${org} and deleted_at is null
           ${keep.length ? tx`and line_item_id not in ${tx(keep)}` : tx``}
         returning id`;
      const rows = await tx<JsonRow[]>`update catalog.items set revision = revision + 1 where id = ${String(bundle.id)} and organization_id = ${org} returning *`;
      const item = rows[0];
      const lines = await readBundleLines(tx, org, String(bundle.id));
      await catalogEvent(tx, ctx, item, "bundle.lines_replaced", { lines: lines.length, removed: gone.length });
      return { status: 200, body: { bundle: item, lines, removed: gone.length } };
    } catch (e) {
      const err = e instanceof CatalogBodyError ? e : pgToCatalogError(e);
      return { status: err.status, body: { error: err.message } };
    }
  });
}
