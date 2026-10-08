// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08 — drawing-version lifecycle (spec §2b Amendment 2): list, transition, compare
//==============================================================================
// sync/versions.ts — Amendment 2: two gates (internal + client) on ONE status column, audit as
// rows, and the version compare. kind='plan' only — a whiteboard has no versions (409 everywhere).
//
//   GET  /drawings/:id/versions
//        → {drawing_id, versions: [{…drawing_versions cols, latest_transition}]} ordered by version_no.
//   POST /drawing-versions/:id/transition {to, note?, client_name?, client_at?}
//        The §2b graph (enforced HERE, never by the DB):
//          draft            → internal_review
//          internal_review  → internal_approved | draft (send back — note REQUIRED)
//          internal_approved→ client_review
//          client_review    → client_approved (client_name REQUIRED; client_at optional, default now)
//                           | client_rejected (note REQUIRED)
//          client_rejected  → draft  (the fix lands as a NEW version; this only reopens the row)
//          <any non-superseded> → superseded (explicit)
//        Roles: internal steps (internal_review / internal_approved / draft) = designer / office / admin;
//        client_review + the two client outcomes = office / admin; superseded = designer / office / admin;
//        technician → 403 always. Invalid edge → 409. Missing note / name → 400.
//        Each call: ONE drawing_version_transitions row + status/status_by/status_at (+ the approval
//        columns) + ONE event drawing_version.transitioned. client_approved AUTO-SUPERSEDES every
//        other non-superseded version of the same drawing (superseded_by_version_id = this one; a
//        transitions row + event for each of them too).
//   GET  /drawing-versions/:a/compare/:b   (same drawing, else 409)
//        → {a, b, pages: [{source_page_no, a_page_id, a_preview_file_id, b_page_id, b_preview_file_id}],
//           changes: [{entity: room|placement|annotation, key, change: added|removed|moved|edited, before, after}]}
//        rooms keyed by room_id (polygons), placements by location_id (Locations are lifetime records),
//        annotations by the copied_from_id chain (b … → a). moved = geometry / points differ; edited = any
//        other attribute differs. Live rows only (deleted_at IS NULL). No snapshot table: computed.
//
// Every statement goes through withOrg / withOrgRead (SET LOCAL app.org_id) and filters organization_id.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg, withOrgRead } from "../org-context";
import { isUuid } from "../db";
import { emitEvent, type RouteResult } from "./checkout";
import type { JsonRow } from "./tables";

export const VERSION_STATUSES = ["draft", "internal_review", "internal_approved", "client_review", "client_approved", "client_rejected", "superseded"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** The §2b graph: from → allowed to. 'superseded' is reachable from every non-superseded status (added below). */
const EDGES: Record<VersionStatus, VersionStatus[]> = {
  draft: ["internal_review"],
  internal_review: ["internal_approved", "draft"],
  internal_approved: ["client_review"],
  client_review: ["client_approved", "client_rejected"],
  client_rejected: ["draft"],
  client_approved: [],
  superseded: [],
};

export function isAllowedTransition(from: VersionStatus, to: VersionStatus): boolean {
  if (from === "superseded") return false;
  if (to === "superseded") return true;
  return EDGES[from].includes(to);
}

const CLIENT_STEPS = new Set<VersionStatus>(["client_review", "client_approved", "client_rejected"]);

/** Who may perform a step: client steps office/admin; everything else designer/office/admin; technician never. */
export function mayTransition(ctx: OrganizationContext, to: VersionStatus): boolean {
  if (ctx.isAdmin || ctx.role === "admin" || ctx.role === "office") return true;
  if (ctx.role === "designer") return !CLIENT_STEPS.has(to);
  return false;
}

interface VersionRow extends JsonRow {
  id: string;
  drawing_id: string;
  version_no: number;
  status: VersionStatus;
  revision: number;
  deleted_at: Date | null;
  drawing_kind: string;
  project_id: string | null;
  drawing_deleted_at: Date | null;
}

const VERSION_COLS = (tx: Tx) => tx`
  v.id, v.organization_id, v.drawing_id, v.version_no, v.label, v.source_file_id, v.page_count, v.raster_status,
  v.status, v.status_by, v.status_at, v.internal_approved_by, v.internal_approved_at, v.client_approved_name, v.client_approved_at,
  v.client_contact_id, v.superseded_by_version_id, v.revision, v.occurred_at, v.received_at, v.created_by, v.deleted_at, v.custom,
  v.created_at, v.updated_at`;

function versionView(v: JsonRow): Record<string, unknown> {
  const { organization_id: _o, drawing_kind: _k, project_id: _p, drawing_deleted_at: _d, ...rest } = v;
  return rest;
}

async function readVersion(tx: Tx, id: string, org: string, lock = false): Promise<VersionRow | null> {
  const rows = lock
    ? await tx<VersionRow[]>`
        select ${VERSION_COLS(tx)}, d.kind as drawing_kind, d.project_id, d.deleted_at as drawing_deleted_at
          from drawings.drawing_versions v join drawings.drawings d on d.id = v.drawing_id and d.organization_id = v.organization_id
         where v.id = ${id} and v.organization_id = ${org} for update of v`
    : await tx<VersionRow[]>`
        select ${VERSION_COLS(tx)}, d.kind as drawing_kind, d.project_id, d.deleted_at as drawing_deleted_at
          from drawings.drawing_versions v join drawings.drawings d on d.id = v.drawing_id and d.organization_id = v.organization_id
         where v.id = ${id} and v.organization_id = ${org}`;
  return rows[0] ?? null;
}

//------------------------------------------------------------------------------
// GET /drawings/:id/versions
//------------------------------------------------------------------------------

export async function listVersions(ctx: OrganizationContext, drawingId: string): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  const did = drawingId.toLowerCase();
  return withOrgRead(ctx, async (tx) => {
    const d = await tx<{ id: string; kind: string; deleted_at: Date | null; project_id: string | null }[]>`
      select id, kind, deleted_at, project_id from drawings.drawings where id = ${did} and organization_id = ${ctx.organizationId}`;
    if (!d[0] || d[0].deleted_at) return { status: 404, body: { error: "drawing not found in this organization" } };
    if (d[0].kind !== "plan") return { status: 409, body: { error: "whiteboards have no versions" } };
    const rows = await tx<JsonRow[]>`
      select ${VERSION_COLS(tx)},
             (select to_jsonb(t) from drawings.drawing_version_transitions t
               where t.drawing_version_id = v.id and t.organization_id = v.organization_id
               order by t.at desc, t.id desc limit 1) as latest_transition
        from drawings.drawing_versions v
       where v.drawing_id = ${did} and v.organization_id = ${ctx.organizationId} and v.deleted_at is null
       order by v.version_no`;
    const published = d[0].project_id
      ? (await tx<{ v: string | null }[]>`select published_drawing_version_id as v from places.structure_state where project_id = ${d[0].project_id} and organization_id = ${ctx.organizationId}`)[0]?.v ?? null
      : null;
    return { status: 200, body: { drawing_id: did, published_drawing_version_id: published, versions: rows.map(versionView) } };
  });
}

//------------------------------------------------------------------------------
// POST /drawing-versions/:id/transition
//------------------------------------------------------------------------------

export async function transitionVersion(ctx: OrganizationContext, versionId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(versionId)) return { status: 400, body: { error: "drawing version id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const to = typeof b.to === "string" ? (b.to.trim().toLowerCase() as VersionStatus) : null;
  if (!to || !(VERSION_STATUSES as readonly string[]).includes(to)) return { status: 400, body: { error: `to must be one of ${VERSION_STATUSES.join(" | ")}` } };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  const clientName = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim() : null;
  let clientAt: Date | null = null;
  if (b.client_at != null) {
    if (typeof b.client_at !== "string" || Number.isNaN(Date.parse(b.client_at))) return { status: 400, body: { error: "client_at must be ISO-8601" } };
    clientAt = new Date(b.client_at);
  }
  if (!mayTransition(ctx, to)) {
    return { status: 403, body: { error: CLIENT_STEPS.has(to) ? "client review and client outcomes are recorded by office or admin" : "only designer, office or admin may transition a version" } };
  }
  const vid = versionId.toLowerCase();
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    const v = await readVersion(tx, vid, org, true);
    if (!v) return { status: 404, body: { error: "drawing version not found in this organization" } };
    if (v.drawing_kind !== "plan") return { status: 409, body: { error: "whiteboards have no versions" } };
    if (v.deleted_at || v.drawing_deleted_at) return { status: 409, body: { error: "version (or its drawing) is tombstoned" } };
    const from = v.status;
    if (!isAllowedTransition(from, to)) {
      return { status: 409, body: { error: `transition ${from} → ${to} is not allowed`, status: from, allowed: from === "superseded" ? [] : [...EDGES[from], "superseded"] } };
    }
    const sendBack = from === "internal_review" && to === "draft";
    if ((sendBack || to === "client_rejected") && !note) return { status: 400, body: { error: `${sendBack ? "send-back" : "client_rejected"} requires a note` } };
    if (to === "client_approved" && !clientName) return { status: 400, body: { error: "client_approved requires client_name (the client as recorded by the office)" } };

    const now = new Date();
    const approvedAt = to === "client_approved" ? clientAt ?? now : null;
    const next = v.revision + 1;
    const updated = await tx<JsonRow[]>`
      update drawings.drawing_versions v
         set status = ${to}, status_by = ${ctx.actorId}, status_at = ${now},
             internal_approved_by = ${to === "internal_approved" ? ctx.actorId : (v.internal_approved_by as string | null) ?? null},
             internal_approved_at = ${to === "internal_approved" ? now : (v.internal_approved_at as Date | null) ?? null},
             client_approved_name = ${to === "client_approved" ? clientName : (v.client_approved_name as string | null) ?? null},
             client_approved_at   = ${to === "client_approved" ? approvedAt : (v.client_approved_at as Date | null) ?? null},
             superseded_by_version_id = ${to === "superseded" ? (v.superseded_by_version_id as string | null) ?? null : null},
             revision = ${next}, received_at = now()
       where v.id = ${vid} and v.organization_id = ${org}
       returning ${VERSION_COLS(tx)}`;
    const actorLabel = CLIENT_STEPS.has(to) && to !== "client_review" ? clientName : null;
    const tr = await tx<JsonRow[]>`
      insert into drawings.drawing_version_transitions (organization_id, drawing_version_id, from_status, to_status, by, actor_label, note, at)
      values (${org}, ${vid}, ${from}, ${to}, ${ctx.actorId}, ${actorLabel}, ${note}, ${now}) returning *`;
    await emitEvent(tx, ctx, {
      projectId: v.project_id, refTable: "drawings.drawing_versions", refId: vid, type: "drawing_version.transitioned",
      payload: { from, to, drawing_id: v.drawing_id, version_no: v.version_no, note, client_name: to === "client_approved" || to === "client_rejected" ? clientName : null, client_at: approvedAt, transition_id: tr[0].id },
      key: `drawings.drawing_versions:${vid}:transition:${tr[0].id as string}`,
    });

    // client_approved → every OTHER non-superseded version of this drawing is superseded by this one
    const superseded: { id: string; version_no: number; from_status: string }[] = [];
    if (to === "client_approved") {
      const others = await tx<{ id: string; version_no: number; status: string; project_id: string | null }[]>`
        select v.id, v.version_no, v.status, d.project_id from drawings.drawing_versions v join drawings.drawings d on d.id = v.drawing_id
         where v.drawing_id = ${v.drawing_id} and v.organization_id = ${org} and v.id <> ${vid} and v.deleted_at is null and v.status <> 'superseded'
         order by v.version_no for update of v`;
      for (const o of others) {
        await tx`
          update drawings.drawing_versions set status = 'superseded', status_by = ${ctx.actorId}, status_at = ${now}, superseded_by_version_id = ${vid},
                 revision = revision + 1, received_at = now()
           where id = ${o.id} and organization_id = ${org}`;
        const otr = await tx<{ id: string }[]>`
          insert into drawings.drawing_version_transitions (organization_id, drawing_version_id, from_status, to_status, by, actor_label, note, at)
          values (${org}, ${o.id}, ${o.status}, 'superseded', ${ctx.actorId}, null, ${`auto: version ${v.version_no} client_approved`}, ${now}) returning id`;
        await emitEvent(tx, ctx, {
          projectId: o.project_id, refTable: "drawings.drawing_versions", refId: o.id, type: "drawing_version.transitioned",
          payload: { from: o.status, to: "superseded", drawing_id: v.drawing_id, version_no: o.version_no, superseded_by_version_id: vid, auto: true, transition_id: otr[0].id },
          key: `drawings.drawing_versions:${o.id}:transition:${otr[0].id}`,
        });
        superseded.push({ id: o.id, version_no: o.version_no, from_status: o.status });
      }
    }
    return { status: 200, body: { op: "transitioned", from, to, version: versionView(updated[0]), transition: tr[0], superseded } };
  });
}

//------------------------------------------------------------------------------
// GET /drawing-versions/:a/compare/:b
//------------------------------------------------------------------------------

export type ChangeKind = "added" | "removed" | "moved" | "edited";
export interface CompareChange {
  entity: "room" | "placement" | "annotation";
  key: string;
  change: ChangeKind;
  before: JsonRow | null;
  after: JsonRow | null;
}

export async function compareVersions(ctx: OrganizationContext, aId: string, bId: string): Promise<RouteResult> {
  if (!isUuid(aId) || !isUuid(bId)) return { status: 400, body: { error: "version ids must be UUIDs" } };
  const a0 = aId.toLowerCase(), b0 = bId.toLowerCase();
  const org = ctx.organizationId;
  return withOrgRead(ctx, async (tx) => {
    const a = await readVersion(tx, a0, org);
    const b = await readVersion(tx, b0, org);
    if (!a || !b || a.deleted_at || b.deleted_at) return { status: 404, body: { error: "drawing version not found in this organization" } };
    if (a.drawing_kind !== "plan") return { status: 409, body: { error: "whiteboards have no versions" } };
    if (a.drawing_id !== b.drawing_id) return { status: 409, body: { error: "versions belong to different drawings", a_drawing_id: a.drawing_id, b_drawing_id: b.drawing_id } };

    const pagesOf = (vid: string) => tx<{ id: string; source_page_no: number | null; preview_file_id: string | null; ordinal: number }[]>`
      select id, source_page_no, preview_file_id, ordinal from drawings.pages
       where drawing_version_id = ${vid} and organization_id = ${org} and deleted_at is null order by ordinal, id`;
    const pa = await pagesOf(a0), pb = await pagesOf(b0);
    const pageKey = (p: { source_page_no: number | null; ordinal: number }) => (p.source_page_no ?? p.ordinal);
    const pageKeys = [...new Set([...pa.map(pageKey), ...pb.map(pageKey)])].sort((x, y) => x - y);
    const pages = pageKeys.map((k) => {
      const x = pa.find((p) => pageKey(p) === k), y = pb.find((p) => pageKey(p) === k);
      return { source_page_no: k, a_page_id: x?.id ?? null, a_preview_file_id: x?.preview_file_id ?? null, b_page_id: y?.id ?? null, b_preview_file_id: y?.preview_file_id ?? null };
    });
    const pageNo = new Map<string, number>();
    for (const p of [...pa, ...pb]) pageNo.set(p.id, pageKey(p));
    const aPages = pa.map((p) => p.id), bPages = pb.map((p) => p.id);

    const changes: CompareChange[] = [];

    // ---- rooms: polygons keyed by room_id (else the hint) ---------------------------------
    const polys = async (ids: string[]) => ids.length
      ? tx<JsonRow[]>`select id, page_id, room_id, room_hint, polygon, metadata, copied_from_id from places.room_polygons
                       where page_id in ${tx(ids)} and organization_id = ${org} and deleted_at is null order by received_at, id`
      : Promise.resolve([] as JsonRow[]);
    const roomKey = (r: JsonRow) => (r.room_id ? `room:${r.room_id as string}` : r.room_hint ? `hint:${String(r.room_hint).trim().toLowerCase()}` : `polygon:${r.id as string}`);
    diffKeyed("room", await polys(aPages), await polys(bPages), roomKey,
      (r) => ({ page: pageNo.get(r.page_id as string) ?? null, polygon: r.polygon }),
      (r) => ({ metadata: r.metadata }),
      (r) => ({ id: r.id, page_id: r.page_id, page_no: pageNo.get(r.page_id as string) ?? null, room_id: r.room_id, room_hint: r.room_hint, polygon: r.polygon, metadata: r.metadata, copied_from_id: r.copied_from_id }),
      changes);

    // ---- placements: keyed by location_id (else the hint) ----------------------------------
    const pins = async (ids: string[]) => ids.length
      ? tx<JsonRow[]>`select id, page_id, location_id, location_hint, room_id, room_hint, x, y, rotation, symbol_key, label_text, metadata, copied_from_id
                        from places.location_placements where page_id in ${tx(ids)} and organization_id = ${org} and deleted_at is null order by received_at, id`
      : Promise.resolve([] as JsonRow[]);
    const pinKey = (r: JsonRow) => (r.location_id ? `location:${r.location_id as string}` : r.location_hint ? `hint:${String(r.location_hint).trim().toLowerCase()}` : `placement:${r.id as string}`);
    diffKeyed("placement", await pins(aPages), await pins(bPages), pinKey,
      (r) => ({ page: pageNo.get(r.page_id as string) ?? null, x: String(r.x), y: String(r.y), rotation: String(r.rotation) }),
      (r) => ({ room_id: r.room_id, room_hint: r.room_hint, symbol_key: r.symbol_key, label_text: r.label_text, metadata: r.metadata }),
      (r) => ({ id: r.id, page_id: r.page_id, page_no: pageNo.get(r.page_id as string) ?? null, location_id: r.location_id, location_hint: r.location_hint, room_id: r.room_id, room_hint: r.room_hint,
                x: r.x, y: r.y, rotation: r.rotation, symbol_key: r.symbol_key, label_text: r.label_text, metadata: r.metadata, copied_from_id: r.copied_from_id }),
      changes);

    // ---- annotations: keyed by the copied_from_id chain (b … → a) ---------------------------
    const anns = async (ids: string[]) => ids.length
      ? tx<JsonRow[]>`select a.id, a.page_id, a.layer_id, l.name as layer_name, a.kind, a.class, a.geometry, a.style, a.label, a.z, a.room_id, a.room_hint, a.location_id,
                             a.file_id, a.callout_no, a.checked, a.custom, a.copied_from_id, a.created_by
                        from drawings.annotations a join drawings.layers l on l.id = a.layer_id and l.organization_id = a.organization_id
                       where a.page_id in ${tx(ids)} and a.organization_id = ${org} and a.deleted_at is null order by a.received_at, a.id`
      : Promise.resolve([] as JsonRow[]);
    const aa = await anns(aPages), ab = await anns(bPages);
    const aIds = new Set(aa.map((r) => r.id as string));
    // resolve each b row's lineage to the a row it descends from (direct link, or a few hops through intermediate versions)
    const lineage = new Map<string, string>();
    if (ab.length && aIds.size) {
      const chain = await tx<{ b_id: string; a_id: string }[]>`
        with recursive chain as (
          select b.id as b_id, b.copied_from_id as cur, 0 as depth
            from drawings.annotations b where b.id in ${tx(ab.map((r) => r.id as string))} and b.organization_id = ${org} and b.copied_from_id is not null
          union all
          select c.b_id, x.copied_from_id, c.depth + 1
            from chain c join drawings.annotations x on x.id = c.cur and x.organization_id = ${org}
           where c.depth < 8 and x.copied_from_id is not null and c.cur not in ${tx([...aIds])}
        )
        select b_id, cur as a_id from chain where cur in ${tx([...aIds])}`;
      for (const c of chain) if (!lineage.has(c.b_id)) lineage.set(c.b_id, c.a_id);
    }
    const annKey = (r: JsonRow) => (lineage.get(r.id as string) ?? r.id) as string;
    diffKeyed("annotation", aa, ab, (r) => `annotation:${annKey(r)}`,
      (r) => ({ page: pageNo.get(r.page_id as string) ?? null, geometry: r.geometry }),
      (r) => ({ layer_name: r.layer_name, kind: r.kind, class: r.class, style: r.style, label: r.label, z: r.z, room_id: r.room_id, room_hint: r.room_hint, location_id: r.location_id, file_id: r.file_id, callout_no: r.callout_no, checked: r.checked, custom: r.custom }),
      (r) => ({ id: r.id, page_id: r.page_id, page_no: pageNo.get(r.page_id as string) ?? null, layer_id: r.layer_id, layer_name: r.layer_name, kind: r.kind, class: r.class, geometry: r.geometry, style: r.style, label: r.label, z: r.z,
                room_id: r.room_id, room_hint: r.room_hint, location_id: r.location_id, file_id: r.file_id, callout_no: r.callout_no, checked: r.checked, custom: r.custom, copied_from_id: r.copied_from_id }),
      changes);

    return {
      status: 200,
      body: {
        a: { id: a.id, version_no: a.version_no, status: a.status, label: a.label ?? null },
        b: { id: b.id, version_no: b.version_no, status: b.status, label: b.label ?? null },
        drawing_id: a.drawing_id,
        pages,
        changes,
        summary: { added: changes.filter((c) => c.change === "added").length, removed: changes.filter((c) => c.change === "removed").length, moved: changes.filter((c) => c.change === "moved").length, edited: changes.filter((c) => c.change === "edited").length },
      },
    };
  });
}

/** Generic keyed diff: added / removed / moved (geometry differs) / edited (other attrs differ); unchanged rows are silent. */
function diffKeyed(
  entity: CompareChange["entity"], aRows: JsonRow[], bRows: JsonRow[], keyOf: (r: JsonRow) => string,
  geometryOf: (r: JsonRow) => unknown, attrsOf: (r: JsonRow) => unknown, view: (r: JsonRow) => JsonRow, out: CompareChange[],
): void {
  const am = new Map<string, JsonRow>(), bm = new Map<string, JsonRow>();
  for (const r of aRows) if (!am.has(keyOf(r))) am.set(keyOf(r), r);
  for (const r of bRows) if (!bm.has(keyOf(r))) bm.set(keyOf(r), r);
  for (const [k, ra] of am) {
    const rb = bm.get(k);
    if (!rb) { out.push({ entity, key: k, change: "removed", before: view(ra), after: null }); continue; }
    if (stable(geometryOf(ra)) !== stable(geometryOf(rb))) out.push({ entity, key: k, change: "moved", before: view(ra), after: view(rb) });
    else if (stable(attrsOf(ra)) !== stable(attrsOf(rb))) out.push({ entity, key: k, change: "edited", before: view(ra), after: view(rb) });
  }
  for (const [k, rb] of bm) if (!am.has(k)) out.push({ entity, key: k, change: "added", before: null, after: view(rb) });
}

/** JSON with sorted object keys so attribute order never counts as a change. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}
