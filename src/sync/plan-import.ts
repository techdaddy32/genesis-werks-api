// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — plan import, device-first rasters (spec §5.6): POST /drawing-versions · POST /pages · raster_status
//==============================================================================
// sync/plan-import.ts — the ONLINE half of plan import (spec §5.6, Decision 6: device-first).
//
//   device: POST /files (plan_source) → PUT bytes → POST /drawing-versions → renders each page
//           ≤1600px → POST /files (page_preview) × N → PUT bytes × N → POST /pages (batch)
//
//   POST /drawing-versions {drawing_id, source_file_id, page_count, label?, device_id?}
//        designer / office / admin. drawing must be kind='plan' (409 whiteboard) and live;
//        source file must exist in the org and have its bytes LANDED — upload_status
//        'uploaded' | 'verified' (409 while 'pending'; the cron verifies later, ink never waits).
//        version_no = max(live version_no) + 1 for the drawing (drawing row locked, so two
//        concurrent imports cannot mint the same number); status 'draft' (055 default);
//        raster_status 'pending'. ONE event drawing_version.created. → 201 {version}.
//   POST /pages {drawing_version_id, pages: [{ordinal, name?, orientation?, preview_file_id, source_page_no}], device_id?}
//        batch, idempotent by (drawing_version_id, source_page_no): an existing live page with
//        that source_page_no is UPDATED (preview / name / orientation / ordinal; revision + 1),
//        otherwise INSERTED. Every preview_file_id must exist in the org (422). After the batch
//        raster_status is recomputed: when every page 1..page_count has a landed preview →
//        'device' (monotone: never back to 'pending'; 'verified' — the reserved rasterizer —
//        is never downgraded). → 200 {version_id, pages[], raster_status}.
//   refreshRasterStatus(tx, ctx, versionId) is also called by /sync/push after a batch that
//        touched drawings.pages, so a device that syncs pages offline gets the same flip.
//
// Judgement (W5): plan import is a FILING act — no checkout is required and no
// structure_changes rows are written for an attached drawing (the pages are the ground, not a
// structure edit); the §5.2 review covers the marks on them. Events only.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { emitEvent, type RouteResult } from "./checkout";
import { lockDrawing, isOfficeOrAdmin } from "./drawings";
import { VERSION_COLS, versionView, readVersion } from "./versions";
import type { JsonRow } from "./tables";

/** Files whose bytes have landed in R2 (the cron may not have verified them yet). */
export const LANDED_STATUSES = ["uploaded", "verified"] as const;
export type RasterStatus = "pending" | "device" | "verified";

function mayImport(ctx: OrganizationContext): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer";
}

//------------------------------------------------------------------------------
// POST /drawing-versions
//------------------------------------------------------------------------------

export async function createDrawingVersion(ctx: OrganizationContext, body: unknown): Promise<RouteResult> {
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayImport(ctx)) return { status: 403, body: { error: "only designer, office or admin may import a plan version" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.drawing_id)) return { status: 400, body: { error: "drawing_id (UUID) is required" } };
  if (!isUuid(b.source_file_id)) return { status: 400, body: { error: "source_file_id (UUID) is required" } };
  const pageCount = Number(b.page_count);
  if (!Number.isInteger(pageCount) || pageCount < 1) return { status: 400, body: { error: "page_count must be an integer >= 1" } };
  if (b.label != null && typeof b.label !== "string") return { status: 400, body: { error: "label must be a string" } };
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : null;
  const deviceId = typeof b.device_id === "string" && b.device_id.trim() ? b.device_id.trim() : null;
  const did = (b.drawing_id as string).toLowerCase();
  const fid = (b.source_file_id as string).toLowerCase();
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    const d = await lockDrawing(tx, did, org);
    if (!d) return { status: 404, body: { error: "drawing not found in this organization" } };
    if (d.deleted_at) return { status: 409, body: { error: "drawing is tombstoned" } };
    if (d.kind !== "plan") return { status: 409, body: { error: "whiteboards have no versions" } };
    const f = await tx<{ id: string; upload_status: string; kind: string; deleted_at: Date | null }[]>`
      select id, upload_status, kind, deleted_at from shared.files where id = ${fid} and organization_id = ${org}`;
    if (!f[0] || f[0].deleted_at) return { status: 404, body: { error: "source_file_id not found in this organization" } };
    if (!(LANDED_STATUSES as readonly string[]).includes(f[0].upload_status)) {
      return { status: 409, body: { error: `source file bytes have not landed (upload_status ${f[0].upload_status}); PUT the bytes first`, upload_status: f[0].upload_status } };
    }
    const mx = await tx<{ n: number | null }[]>`
      select max(version_no)::int as n from drawings.drawing_versions where drawing_id = ${did} and organization_id = ${org} and deleted_at is null`;
    const versionNo = (mx[0]?.n ?? 0) + 1;
    const now = new Date();
    const rows = await tx<JsonRow[]>`
      insert into drawings.drawing_versions as v (organization_id, drawing_id, version_no, label, source_file_id, page_count, raster_status, status,
                                               revision, occurred_at, device_id, created_by, custom)
      values (${org}, ${did}, ${versionNo}, ${label}, ${fid}, ${pageCount}, 'pending', 'draft', 1, ${now}, ${deviceId}, ${ctx.actorId}, '{}'::jsonb)
      returning ${VERSION_COLS(tx)}`;
    const v = rows[0];
    await emitEvent(tx, ctx, {
      projectId: d.project_id, refTable: "drawings.drawing_versions", refId: v.id as string, type: "drawing_version.created",
      payload: { op: "created", drawing_id: did, version_no: versionNo, source_file_id: fid, page_count: pageCount, raster_status: "pending", status: "draft", via: "POST /drawing-versions" },
      key: `drawings.drawing_versions:${v.id as string}:1`, deviceId,
    });
    return { status: 201, body: { op: "created", version: versionView(v) } };
  });
}

//------------------------------------------------------------------------------
// POST /pages
//------------------------------------------------------------------------------

interface PageInput {
  ordinal: number;
  name: string | null;
  orientation: "landscape" | "portrait";
  preview_file_id: string;
  source_page_no: number;
}

function parsePages(raw: unknown): PageInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "pages must be a non-empty array";
  if (raw.length > 500) return "pages: at most 500 per call";
  const out: PageInput[] = [];
  const seen = new Set<number>();
  for (const [i, p] of raw.entries()) {
    const r = (p ?? {}) as Record<string, unknown>;
    const spn = Number(r.source_page_no);
    if (!Number.isInteger(spn) || spn < 1) return `pages[${i}].source_page_no must be an integer >= 1`;
    if (seen.has(spn)) return `pages[${i}].source_page_no ${spn} repeats within the batch`;
    seen.add(spn);
    if (!isUuid(r.preview_file_id)) return `pages[${i}].preview_file_id (UUID) is required`;
    const ordinal = r.ordinal == null ? spn : Number(r.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 0) return `pages[${i}].ordinal must be a non-negative integer`;
    const orientation = r.orientation == null ? "landscape" : String(r.orientation).trim().toLowerCase();
    if (orientation !== "landscape" && orientation !== "portrait") return `pages[${i}].orientation must be landscape | portrait`;
    if (r.name != null && typeof r.name !== "string") return `pages[${i}].name must be a string`;
    out.push({ ordinal, name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : null, orientation, preview_file_id: (r.preview_file_id as string).toLowerCase(), source_page_no: spn });
  }
  return out;
}

export async function recordPages(ctx: OrganizationContext, body: unknown): Promise<RouteResult> {
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayImport(ctx)) return { status: 403, body: { error: "only designer, office or admin may record plan pages" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.drawing_version_id)) return { status: 400, body: { error: "drawing_version_id (UUID) is required" } };
  const parsed = parsePages(b.pages);
  if (typeof parsed === "string") return { status: 400, body: { error: parsed } };
  const deviceId = typeof b.device_id === "string" && b.device_id.trim() ? b.device_id.trim() : null;
  const vid = (b.drawing_version_id as string).toLowerCase();
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    const v = await readVersion(tx, vid, org, true);
    if (!v) return { status: 404, body: { error: "drawing version not found in this organization" } };
    if (v.deleted_at || v.drawing_deleted_at) return { status: 409, body: { error: "version (or its drawing) is tombstoned" } };
    if (v.drawing_kind !== "plan") return { status: 409, body: { error: "whiteboards have no versions" } };
    if (v.page_count != null) {
      const over = parsed.find((p) => p.source_page_no > Number(v.page_count));
      if (over) return { status: 400, body: { error: `source_page_no ${over.source_page_no} exceeds the version's page_count ${v.page_count as number}` } };
    }
    // every preview must exist (the bytes may still be in flight — raster_status waits for them)
    const previewIds = [...new Set(parsed.map((p) => p.preview_file_id))];
    const files = await tx<{ id: string; upload_status: string }[]>`
      select id, upload_status from shared.files where id in ${tx(previewIds)} and organization_id = ${org} and deleted_at is null`;
    const known = new Map(files.map((f) => [f.id, f.upload_status]));
    const missing = previewIds.filter((id) => !known.has(id));
    if (missing.length) return { status: 422, body: { error: "preview_file_id not found in this organization", missing } };

    const existing = await tx<{ id: string; source_page_no: number | null; revision: number }[]>`
      select id, source_page_no, revision from drawings.pages
       where drawing_version_id = ${vid} and organization_id = ${org} and deleted_at is null and source_page_no is not null`;
    const bySpn = new Map(existing.map((p) => [Number(p.source_page_no), p]));
    const now = new Date();
    const pages: JsonRow[] = [];
    for (const p of parsed) {
      const cur = bySpn.get(p.source_page_no);
      let row: JsonRow;
      let op: "created" | "updated";
      if (cur) {
        const next = cur.revision + 1;
        const r = await tx<JsonRow[]>`
          update drawings.pages set preview_file_id = ${p.preview_file_id}, name = coalesce(${p.name}, name), orientation = ${p.orientation}, ordinal = ${p.ordinal},
                 revision = ${next}, received_at = now()
           where id = ${cur.id} and organization_id = ${org} returning *`;
        row = r[0]; op = "updated";
      } else {
        const r = await tx<JsonRow[]>`
          insert into drawings.pages (organization_id, drawing_id, drawing_version_id, ordinal, name, orientation, preview_file_id, source_page_no,
                                      revision, occurred_at, device_id, created_by)
          values (${org}, ${v.drawing_id}, ${vid}, ${p.ordinal}, ${p.name}, ${p.orientation}, ${p.preview_file_id}, ${p.source_page_no}, 1, ${now}, ${deviceId}, ${ctx.actorId})
          returning *`;
        row = r[0]; op = "created";
      }
      await emitEvent(tx, ctx, {
        projectId: v.project_id, refTable: "drawings.pages", refId: row.id as string, type: "drawing_page.recorded",
        payload: { op, drawing_id: v.drawing_id, drawing_version_id: vid, source_page_no: p.source_page_no, preview_file_id: p.preview_file_id, preview_status: known.get(p.preview_file_id), revision: row.revision },
        key: `drawings.pages:${row.id as string}:${row.revision as number}`, deviceId,
      });
      pages.push(pageView(row, known.get(p.preview_file_id) ?? null, op));
    }
    const raster = await refreshRasterStatus(tx, ctx, vid);
    return { status: 200, body: { version_id: vid, pages, raster_status: raster.raster_status, previews_landed: raster.landed, page_count: raster.page_count } };
  });
}

function pageView(p: JsonRow, previewStatus: string | null, op: "created" | "updated"): JsonRow {
  return {
    id: p.id, drawing_id: p.drawing_id, drawing_version_id: p.drawing_version_id, ordinal: p.ordinal, name: p.name ?? null, orientation: p.orientation,
    preview_file_id: p.preview_file_id ?? null, preview_upload_status: previewStatus, source_page_no: p.source_page_no, revision: p.revision, op,
  };
}

//------------------------------------------------------------------------------
// raster_status — recomputed after any pages write (route or push)
//------------------------------------------------------------------------------

export interface RasterRefresh {
  version_id: string;
  raster_status: RasterStatus;
  page_count: number | null;
  landed: number;
  changed: boolean;
}

/**
 * pending → device when every page 1..page_count of the version has a live page whose preview's
 * bytes have landed. Monotone: never back to pending; 'verified' is never downgraded. One event
 * drawing_version.rasterized on the flip.
 */
export async function refreshRasterStatus(tx: Tx, ctx: OrganizationContext, versionId: string): Promise<RasterRefresh> {
  const org = ctx.organizationId;
  const v = await tx<{ id: string; page_count: number | null; raster_status: RasterStatus; drawing_id: string; project_id: string | null }[]>`
    select v.id, v.page_count, v.raster_status, v.drawing_id, d.project_id
      from drawings.drawing_versions v join drawings.drawings d on d.id = v.drawing_id and d.organization_id = v.organization_id
     where v.id = ${versionId} and v.organization_id = ${org} and v.deleted_at is null`;
  if (!v[0]) return { version_id: versionId, raster_status: "pending", page_count: null, landed: 0, changed: false };
  const landedRows = await tx<{ n: string }[]>`
    select count(distinct p.source_page_no)::text as n
      from drawings.pages p join shared.files f on f.id = p.preview_file_id and f.organization_id = p.organization_id
     where p.drawing_version_id = ${versionId} and p.organization_id = ${org} and p.deleted_at is null and f.deleted_at is null
       and p.source_page_no is not null and f.upload_status in ${tx(LANDED_STATUSES as unknown as string[])}`;
  const landed = Number(landedRows[0]?.n ?? 0);
  const pageCount = v[0].page_count == null ? null : Number(v[0].page_count);
  const complete = pageCount != null && pageCount >= 1 && landed >= pageCount;
  if (v[0].raster_status === "pending" && complete) {
    await tx`update drawings.drawing_versions set raster_status = 'device', received_at = now() where id = ${versionId} and organization_id = ${org} and raster_status = 'pending'`;
    await emitEvent(tx, ctx, {
      projectId: v[0].project_id, refTable: "drawings.drawing_versions", refId: versionId, type: "drawing_version.rasterized",
      payload: { raster_status: "device", page_count: pageCount, previews_landed: landed, drawing_id: v[0].drawing_id },
      key: `drawings.drawing_versions:${versionId}:raster:device`,
    });
    return { version_id: versionId, raster_status: "device", page_count: pageCount, landed, changed: true };
  }
  return { version_id: versionId, raster_status: v[0].raster_status, page_count: pageCount, landed, changed: false };
}
