// row: W5c · run: run-2026-10-07-drawing-layer-11 · 2026-10-09 — drawings list + bundle
//==============================================================================
// sync/drawings-list.ts — the two READ routes the app's A5 row needs: the drawings board
// (unfiled queue / per-project / per-account) and the bundle an office phone opens an
// UNATTACHED drawing from (sync/pull is project-scoped and never carries one).
//
//   GET /drawings?unattached=1 | project_id= | account_id= | kind=plan|whiteboard & since= & limit=
//       → 200 {drawings[{id, kind, working_title, address_hint, project_id, project_name, account_id,
//                        account_name, created_by, created_by_name, created_at, received_at, attached_at,
//                        detached_at, page_count, annotation_count, first_page_id, first_preview_file_id,
//                        walk_id}], since, next_since, limit, truncated}
//       newest received_at first, live rows only. `since` = received_at > since, carried as TEXT
//       (history.ts / office.ts shape). unattached / project_id / account_id are mutually exclusive (400).
//   GET /drawings/:id
//       → 200 {drawing (same shape as a list row), pages[], layers[] (render order), annotations[] (live,
//              every live page), versions[] (plans; whiteboards → [])} · 400 not a UUID · 403 not visible · 404 unknown
//
// Visibility (both routes): designer / office / admin see every drawing in the Organization; a
// technician sees their OWN drawings (created_by) plus every drawing attached to a project they
// have a live walk on. A technician's list is filtered silently; the bundle answers 403 (the
// drawing exists, they may not open it) — 404 only when the row is unknown / another org's.
//
// page_count counts every live page across every version (a plan re-upload is NEW pages);
// first_page_id / first_preview_file_id come from the NEWEST version's lowest ordinal (whiteboard:
// its lowest ordinal page) — the thumbnail the board shows. Layers come from layers.ts
// (readDrawingLayers, ordinal order); versions reuse versions.ts (VERSION_COLS / versionView).
//
// Every statement goes through withOrgRead (SET LOCAL app.org_id) and filters organization_id.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrgRead } from "../org-context";
import { isUuid } from "../db";
import type { RouteResult } from "./checkout";
import { isOfficeOrAdmin } from "./drawings";
import { readDrawingLayers, layerView } from "./layers";
import { VERSION_COLS, versionView } from "./versions";
import type { JsonRow } from "./tables";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const KINDS = new Set(["plan", "whiteboard"]);

function bad(error: string): RouteResult {
  return { status: 400, body: { error } };
}

/** designer / office / admin: every drawing in the Organization. */
function seesAll(ctx: OrganizationContext): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer";
}

//------------------------------------------------------------------------------
// Shared shape
//------------------------------------------------------------------------------

export interface DrawingListRow {
  id: string;
  kind: string;
  working_title: string | null;
  address_hint: string | null;
  project_id: string | null;
  project_name: string | null;
  account_id: string | null;
  account_name: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  received_at: Date;
  attached_at: Date | null;
  detached_at: Date | null;
  page_count: number;
  annotation_count: number;
  first_page_id: string | null;
  first_preview_file_id: string | null;
  walk_id: string | null;
}

const DRAWING_SELECT = (tx: Tx, org: string) => tx`
  select d.id, d.kind, d.working_title, d.address_hint, d.project_id, p.name as project_name,
         d.account_id, coalesce(a.name, pa.name) as account_name,
         d.created_by, m.display_name as created_by_name, d.created_at, d.received_at, d.attached_at, d.detached_at,
         (select count(*)::int from drawings.pages pg where pg.drawing_id = d.id and pg.organization_id = ${org} and pg.deleted_at is null) as page_count,
         (select count(*)::int from drawings.annotations an join drawings.pages pg on pg.id = an.page_id and pg.organization_id = an.organization_id
           where pg.drawing_id = d.id and an.organization_id = ${org} and an.deleted_at is null and pg.deleted_at is null) as annotation_count,
         fp.id as first_page_id, fp.preview_file_id as first_preview_file_id,
         d.walk_id,
         to_char(d.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _cursor
    from drawings.drawings d
    left join shared.projects p on p.id = d.project_id and p.organization_id = d.organization_id
    left join shared.accounts a on a.id = d.account_id and a.organization_id = d.organization_id
    left join shared.accounts pa on pa.id = p.account_id and pa.organization_id = d.organization_id
    left join shared.members m on m.id = d.created_by and m.organization_id = d.organization_id
    left join lateral (
      select pg.id, pg.preview_file_id
        from drawings.pages pg
        left join drawings.drawing_versions v on v.id = pg.drawing_version_id and v.organization_id = pg.organization_id
       where pg.drawing_id = d.id and pg.organization_id = ${org} and pg.deleted_at is null
       order by v.version_no desc nulls last, pg.ordinal, pg.created_at, pg.id
       limit 1
    ) fp on true`;

/** The visibility predicate for a member without an office-side role: own rows + attached drawings of projects they walked. */
const TECH_VISIBLE = (tx: Tx, org: string, actor: string) => tx`
  and (d.created_by = ${actor}
       or (d.project_id is not null and exists (
             select 1 from places.walks w
              where w.project_id = d.project_id and w.organization_id = ${org} and w.created_by = ${actor} and w.deleted_at is null)))`;

//------------------------------------------------------------------------------
// GET /drawings
//------------------------------------------------------------------------------

export async function listDrawings(ctx: OrganizationContext, params: URLSearchParams): Promise<RouteResult> {
  const unattached = ["1", "true"].includes((params.get("unattached") ?? "").trim().toLowerCase());
  const projectRaw = (params.get("project_id") ?? "").trim() || null;
  if (projectRaw && !isUuid(projectRaw)) return bad("project_id must be a UUID");
  const accountRaw = (params.get("account_id") ?? "").trim() || null;
  if (accountRaw && !isUuid(accountRaw)) return bad("account_id must be a UUID");
  if ([unattached, !!projectRaw, !!accountRaw].filter(Boolean).length > 1) return bad("unattached, project_id and account_id are mutually exclusive");
  const kind = (params.get("kind") ?? "").trim().toLowerCase() || null;
  if (kind && !KINDS.has(kind)) return bad("kind must be plan | whiteboard");
  const sinceRaw = (params.get("since") ?? "").trim();
  if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) return bad("since must be an ISO-8601 timestamp");
  const since = sinceRaw || null;
  const limitRaw = params.get("limit");
  const limit = limitRaw == null || limitRaw.trim() === "" ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return bad(`limit must be an integer in [1, ${MAX_LIMIT}]`);
  const org = ctx.organizationId;
  const projectId = projectRaw?.toLowerCase() ?? null;
  const accountId = accountRaw?.toLowerCase() ?? null;
  const all = seesAll(ctx);

  return withOrgRead(ctx, async (tx) => {
    const rows = await tx<(DrawingListRow & { _cursor: string })[]>`
      ${DRAWING_SELECT(tx, org)}
       where d.organization_id = ${org} and d.deleted_at is null
         ${unattached ? tx`and d.project_id is null and d.account_id is null` : tx``}
         ${projectId ? tx`and d.project_id = ${projectId}` : tx``}
         ${accountId ? tx`and d.account_id = ${accountId}` : tx``}
         ${kind ? tx`and d.kind = ${kind}` : tx``}
         ${since ? tx`and d.received_at > ${since}::text::timestamptz` : tx``}
         ${all ? tx`` : TECH_VISIBLE(tx, org, ctx.actorId)}
       order by d.received_at desc, d.created_at desc, d.id desc
       limit ${limit + 1}`;
    const truncated = rows.length > limit;
    const drawings = truncated ? rows.slice(0, limit) : rows;
    const newest = drawings[0]?._cursor ?? since;
    for (const d of drawings) delete (d as Partial<typeof d>)._cursor;
    return { status: 200, body: { since, next_since: newest ?? null, limit, truncated, drawings } };
  });
}

//------------------------------------------------------------------------------
// GET /drawings/:id — the bundle
//------------------------------------------------------------------------------

export interface PageRow extends JsonRow {
  id: string;
  drawing_version_id: string | null;
  version_no: number | null;
  ordinal: number;
}

export async function getDrawingBundle(ctx: OrganizationContext, drawingId: string): Promise<RouteResult> {
  if (!isUuid(drawingId)) return bad("drawing id must be a UUID");
  const did = drawingId.toLowerCase();
  const org = ctx.organizationId;
  return withOrgRead(ctx, async (tx) => {
    const rows = await tx<(DrawingListRow & { _cursor: string })[]>`
      ${DRAWING_SELECT(tx, org)}
       where d.id = ${did} and d.organization_id = ${org} and d.deleted_at is null`;
    const drawing = rows[0];
    if (!drawing) return { status: 404, body: { error: "drawing not found in this organization" } };
    delete (drawing as Partial<typeof drawing>)._cursor;
    if (!seesAll(ctx)) {
      const vis = await tx<{ one: number }[]>`
        select 1 as one from drawings.drawings d
         where d.id = ${did} and d.organization_id = ${org} ${TECH_VISIBLE(tx, org, ctx.actorId)}`;
      if (!vis.length) return { status: 403, body: { error: "only the drawing's creator, a technician with a walk on its project, or a designer / office / admin may open it" } };
    }

    // pages: every live page, newest version first (whiteboard pages have no version), ordinal within
    const pages = await tx<PageRow[]>`
      select pg.id, pg.drawing_id, pg.drawing_version_id, v.version_no, pg.ordinal, pg.name, pg.orientation, pg.preview_file_id, pg.source_page_no,
             pg.room_id, pg.room_hint, pg.revision, pg.occurred_at, pg.received_at, pg.device_id, pg.created_by, pg.walk_id, pg.captured_revision,
             pg.custom, pg.created_at, pg.updated_at
        from drawings.pages pg
        left join drawings.drawing_versions v on v.id = pg.drawing_version_id and v.organization_id = pg.organization_id
       where pg.drawing_id = ${did} and pg.organization_id = ${org} and pg.deleted_at is null
       order by v.version_no desc nulls last, pg.ordinal, pg.created_at, pg.id`;

    // layers: render order (ordinal), live only — the same view GET /drawings/:id/layers gives
    const layers = (await readDrawingLayers(tx, did, org)).map(layerView);

    // annotations: live rows on live pages, in render order (layer ordinal → z → received_at)
    const annotations = await tx<JsonRow[]>`
      select an.id, an.page_id, an.layer_id, an.redirected_from_layer_id, an.kind, an.class, an.geometry, an.style, an.label, an.z,
             an.room_id, an.room_hint, an.location_id, an.file_id, an.callout_no, an.checked, an.custom, an.copied_from_id,
             an.revision, an.occurred_at, an.received_at, an.device_id, an.created_by, an.walk_id, an.captured_revision,
             an.created_at, an.updated_at
        from drawings.annotations an
        join drawings.pages pg on pg.id = an.page_id and pg.organization_id = an.organization_id
        join drawings.layers l on l.id = an.layer_id and l.organization_id = an.organization_id
       where pg.drawing_id = ${did} and an.organization_id = ${org} and an.deleted_at is null and pg.deleted_at is null
       order by pg.ordinal, l.ordinal, an.z, an.received_at, an.id`;

    // versions: plans only (a whiteboard has none — [] here, where GET /drawings/:id/versions says 409)
    const versions = drawing.kind === "plan"
      ? (await tx<JsonRow[]>`
          select ${VERSION_COLS(tx)},
                 (select to_jsonb(t) from drawings.drawing_version_transitions t
                   where t.drawing_version_id = v.id and t.organization_id = v.organization_id
                   order by t.at desc, t.id desc limit 1) as latest_transition
            from drawings.drawing_versions v
           where v.drawing_id = ${did} and v.organization_id = ${org} and v.deleted_at is null
           order by v.version_no`).map(versionView)
      : [];

    return { status: 200, body: { drawing, pages, layers, annotations, versions } };
  });
}
