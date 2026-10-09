// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — carry-forward between versions (spec §2b Amendment 2): POST /drawing-versions/:id/carry-forward
//==============================================================================
// sync/carry-forward.ts — "bring my marks forward" (spec §2b carry-forward paragraph).
//
//   POST /drawing-versions/:id/carry-forward {from_version_id, layer_ids?, include?}
//        include ⊆ ['annotations','polygons','placements'] (default all); layer_ids filters
//        annotations only (layers are per DRAWING, so they carry across versions as-is).
//        designer / office / admin. Same drawing only (409); target must have live pages (409).
//        Pages pair by source_page_no, falling back to ordinal; a source page with no partner
//        on the target → its rows are SKIPPED (no_target_page) — coordinates may have shifted
//        after a re-plan, which is exactly why the spec does not do this automatically.
//        Every copied row: NEW id, copied_from_id = the source row, revision 1, created_by =
//        actor, same layer_id / class / geometry / attributes; walk_id / captured_revision
//        NULL (a carried mark is not a walk capture). Files are REFERENCED, never duplicated.
//        Re-running is a no-op: a source row that already has a LIVE descendant on the target
//        (copied_from_id = source.id) is skipped (already_copied).
//
//   STRUCTURE rows (structure-class annotations, room_polygons, location_placements):
//        drawing attached to a project → the actor must hold the LIVE checkout (409 none /
//        expired, 403 another holder) and each copied row lands as a structure_changes
//        PROPOSAL at the working revision — change_kind 'annotation' for annotations (W3/W4
//        vocabulary) and 'created' for polygons / placements (what /sync/push writes for them;
//        036 CHECK has no polygon / placement kind). Unattached drawing → copied freely, no
//        proposals (spec §5.3: everything is capture until attach). Capture-class annotations
//        never need the checkout.
//
//   ONE event drawing_version.carried_forward on the target version (counts in the payload).
//
// Every statement goes through withOrg (SET LOCAL app.org_id) and filters organization_id too.
//==============================================================================

import type { OrganizationContext } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { emitEvent, lockStructureState, isLive, type RouteResult } from "./checkout";
import { isOfficeOrAdmin } from "./drawings";
import { readVersion } from "./versions";
import type { JsonRow } from "./tables";

export const CARRY_KINDS = ["annotations", "polygons", "placements"] as const;
export type CarryKind = (typeof CARRY_KINDS)[number];

function mayCarry(ctx: OrganizationContext): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer";
}

interface PageRef { id: string; source_page_no: number | null; ordinal: number }

/** source page id → target page id: by source_page_no first, then by ordinal. Exported for tests. */
export function pairPages(source: PageRef[], target: PageRef[]): Map<string, string> {
  const out = new Map<string, string>();
  const bySpn = new Map<number, PageRef>();
  const byOrd = new Map<number, PageRef>();
  for (const p of target) {
    if (p.source_page_no != null && !bySpn.has(Number(p.source_page_no))) bySpn.set(Number(p.source_page_no), p);
    if (!byOrd.has(Number(p.ordinal))) byOrd.set(Number(p.ordinal), p);
  }
  for (const s of source) {
    const t = (s.source_page_no != null ? bySpn.get(Number(s.source_page_no)) : undefined) ?? byOrd.get(Number(s.ordinal));
    if (t) out.set(s.id, t.id);
  }
  return out;
}

export interface CarrySkipped { total: number; already_copied: number; no_target_page: number; layer_missing: number }

export async function carryForward(ctx: OrganizationContext, targetId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(targetId)) return { status: 400, body: { error: "drawing version id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayCarry(ctx)) return { status: 403, body: { error: "only designer, office or admin may carry marks forward" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.from_version_id)) return { status: 400, body: { error: "from_version_id (UUID) is required" } };
  let include: CarryKind[] = [...CARRY_KINDS];
  if (b.include != null) {
    if (!Array.isArray(b.include) || b.include.length === 0 || b.include.some((k) => !(CARRY_KINDS as readonly unknown[]).includes(k))) {
      return { status: 400, body: { error: `include must be a non-empty subset of ${CARRY_KINDS.join(" | ")}` } };
    }
    include = [...new Set(b.include as CarryKind[])];
  }
  let layerIds: string[] | null = null;
  if (b.layer_ids != null) {
    if (!Array.isArray(b.layer_ids) || b.layer_ids.some((l) => !isUuid(l))) return { status: 400, body: { error: "layer_ids must be an array of UUIDs" } };
    layerIds = [...new Set((b.layer_ids as string[]).map((l) => l.toLowerCase()))];
  }
  const to = targetId.toLowerCase();
  const from = (b.from_version_id as string).toLowerCase();
  if (to === from) return { status: 409, body: { error: "from_version_id is the target version" } };
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    const tgt = await readVersion(tx, to, org, true);
    if (!tgt) return { status: 404, body: { error: "drawing version not found in this organization" } };
    if (tgt.drawing_kind !== "plan") return { status: 409, body: { error: "whiteboards have no versions" } };
    if (tgt.deleted_at || tgt.drawing_deleted_at) return { status: 409, body: { error: "target version (or its drawing) is tombstoned" } };
    const src = await readVersion(tx, from, org);
    if (!src || src.deleted_at) return { status: 404, body: { error: "from_version_id not found in this organization" } };
    if (src.drawing_id !== tgt.drawing_id) return { status: 409, body: { error: "versions belong to different drawings", from_drawing_id: src.drawing_id, to_drawing_id: tgt.drawing_id } };
    const drawingId = tgt.drawing_id;
    const projectId = tgt.project_id;

    const pagesOf = (vid: string) => tx<PageRef[]>`
      select id, source_page_no, ordinal from drawings.pages where drawing_version_id = ${vid} and organization_id = ${org} and deleted_at is null order by ordinal, id`;
    const srcPages = await pagesOf(from);
    const tgtPages = await pagesOf(to);
    if (!tgtPages.length) return { status: 409, body: { error: "target version has no pages yet; POST /pages first" } };
    const pageMap = pairPages(srcPages, tgtPages);
    const srcPageIds = srcPages.map((p) => p.id);
    const tgtPageIds = tgtPages.map((p) => p.id);

    if (layerIds) {
      const ok = await tx<{ id: string }[]>`select id from drawings.layers where id in ${tx(layerIds)} and drawing_id = ${drawingId} and organization_id = ${org}`;
      const found = new Set(ok.map((l) => l.id));
      const bad = layerIds.filter((l) => !found.has(l));
      if (bad.length) return { status: 404, body: { error: "layer_ids must be layers of this drawing", unknown: bad } };
    }

    // live layers of the drawing (a tombstoned layer has nothing to land on)
    const liveLayers = new Set((await tx<{ id: string }[]>`select id from drawings.layers where drawing_id = ${drawingId} and organization_id = ${org} and deleted_at is null`).map((l) => l.id));

    // already-carried lineage on the target (idempotency)
    const carried = async (table: "drawings.annotations" | "places.room_polygons" | "places.location_placements") =>
      new Set((await tx<{ copied_from_id: string }[]>`
        select copied_from_id from ${tx(table)} where page_id in ${tx(tgtPageIds)} and organization_id = ${org} and deleted_at is null and copied_from_id is not null`).map((r) => r.copied_from_id));

    const skipped: CarrySkipped = { total: 0, already_copied: 0, no_target_page: 0, layer_missing: 0 };
    const skip = (why: keyof Omit<CarrySkipped, "total">) => { skipped[why] += 1; skipped.total += 1; };

    // ---- candidates ----------------------------------------------------------------------
    let anns: JsonRow[] = [];
    if (include.includes("annotations") && srcPageIds.length) {
      const done = await carried("drawings.annotations");
      const rows = await tx<JsonRow[]>`
        select * from drawings.annotations where page_id in ${tx(srcPageIds)} and organization_id = ${org} and deleted_at is null
          ${layerIds ? tx`and layer_id in ${tx(layerIds)}` : tx``} order by received_at, id`;
      for (const a of rows) {
        if (done.has(a.id as string)) { skip("already_copied"); continue; }
        if (!pageMap.has(a.page_id as string)) { skip("no_target_page"); continue; }
        if (!liveLayers.has(a.layer_id as string)) { skip("layer_missing"); continue; }
        anns.push(a);
      }
    }
    let polys: JsonRow[] = [];
    if (include.includes("polygons") && srcPageIds.length) {
      const done = await carried("places.room_polygons");
      const rows = await tx<JsonRow[]>`
        select * from places.room_polygons where page_id in ${tx(srcPageIds)} and organization_id = ${org} and deleted_at is null order by received_at, id`;
      for (const p of rows) {
        if (done.has(p.id as string)) { skip("already_copied"); continue; }
        if (!pageMap.has(p.page_id as string)) { skip("no_target_page"); continue; }
        polys.push(p);
      }
    }
    let pins: JsonRow[] = [];
    if (include.includes("placements") && srcPageIds.length) {
      const done = await carried("places.location_placements");
      const rows = await tx<JsonRow[]>`
        select * from places.location_placements where page_id in ${tx(srcPageIds)} and organization_id = ${org} and deleted_at is null order by received_at, id`;
      for (const p of rows) {
        if (done.has(p.id as string)) { skip("already_copied"); continue; }
        if (!pageMap.has(p.page_id as string)) { skip("no_target_page"); continue; }
        pins.push(p);
      }
    }

    // ---- the checkout gate for structure rows under a project ------------------------------
    const structureAnns = anns.filter((a) => a.class === "structure");
    const needsCheckout = !!projectId && (structureAnns.length > 0 || polys.length > 0 || pins.length > 0);
    let workingRevision: number | null = null;
    if (needsCheckout) {
      const state = await lockStructureState(tx, projectId!, org);
      if (!state) return { status: 409, body: { error: "project has no structure_state" } };
      if (!state.checkout_user_id || !isLive(state)) {
        return { status: 409, body: { error: "carrying structure rows forward on an attached drawing requires the live structure checkout; take it first", structure_rows: structureAnns.length + polys.length + pins.length } };
      }
      if (state.checkout_user_id !== ctx.actorId) return { status: 403, body: { error: "only the checkout holder may carry structure rows forward", holder: state.checkout_user_id } };
      workingRevision = state.working_revision;
    }

    // ---- copy ---------------------------------------------------------------------------------
    const now = new Date();
    const proposals: string[] = [];
    const idMap: Record<string, string> = {};
    const propose = async (refTable: string, refId: string, changeKind: "annotation" | "created", roomId: string | null, roomHint: string | null, diff: JsonRow) => {
      if (!projectId || workingRevision == null) return;
      const ins = await tx<{ id: string }[]>`
        insert into places.structure_changes (organization_id, project_id, revision, room_id, room_hint, drawing_id, walk_id, ref_table, ref_id, change_kind, diff, actor, occurred_at)
        values (${org}, ${projectId}, ${workingRevision}, ${roomId}, ${roomHint}, ${drawingId}, null, ${refTable}, ${refId}, ${changeKind},
                ${tx.json({ op: "proposed", source: "carry_forward", from_version_id: from, to_version_id: to, ...diff } as never)}, ${ctx.actorId}, ${now})
        returning id`;
      proposals.push(ins[0].id);
    };

    for (const a of anns) {
      const r = await tx<{ id: string }[]>`
        insert into drawings.annotations (organization_id, page_id, layer_id, kind, class, geometry, style, label, z, room_id, room_hint, location_id, file_id, callout_no, checked, custom,
                                          copied_from_id, revision, occurred_at, device_id, created_by)
        values (${org}, ${pageMap.get(a.page_id as string)!}, ${a.layer_id as string}, ${a.kind as string}, ${a.class as string}, ${tx.json(a.geometry as never)},
                ${a.style == null ? null : tx.json(a.style as never)}, ${a.label as string | null}, ${a.z as number}, ${a.room_id as string | null}, ${a.room_hint as string | null},
                ${a.location_id as string | null}, ${a.file_id as string | null}, ${a.callout_no as number | null}, ${a.checked as boolean}, ${tx.json(a.custom as never)},
                ${a.id as string}, 1, ${now}, ${a.device_id as string | null}, ${ctx.actorId}) returning id`;
      idMap[a.id as string] = r[0].id;
      if (a.class === "structure") {
        await propose("drawings.annotations", r[0].id, "annotation", (a.room_id as string | null) ?? null, (a.room_hint as string | null) ?? null,
          { class: "structure", layer_id: a.layer_id, kind: a.kind, label: a.label ?? null, copied_from_id: a.id });
      }
    }
    for (const p of polys) {
      const r = await tx<{ id: string }[]>`
        insert into places.room_polygons (organization_id, account_id, project_id, drawing_id, drawing_version_id, page_id, room_id, room_hint, polygon, metadata,
                                          copied_from_id, revision, occurred_at, device_id, created_by)
        values (${org}, ${p.account_id as string | null}, ${p.project_id as string | null}, ${drawingId}, ${to}, ${pageMap.get(p.page_id as string)!},
                ${p.room_id as string | null}, ${p.room_hint as string | null}, ${tx.json(p.polygon as never)}, ${tx.json(p.metadata as never)},
                ${p.id as string}, 1, ${now}, ${p.device_id as string | null}, ${ctx.actorId}) returning id`;
      idMap[p.id as string] = r[0].id;
      await propose("places.room_polygons", r[0].id, "created", (p.room_id as string | null) ?? null, (p.room_hint as string | null) ?? null,
        { copied_from_id: p.id, after: { room_id: p.room_id ?? null, room_hint: p.room_hint ?? null, polygon: p.polygon, page_id: pageMap.get(p.page_id as string) } });
    }
    for (const p of pins) {
      const r = await tx<{ id: string }[]>`
        insert into places.location_placements (organization_id, account_id, project_id, drawing_id, drawing_version_id, page_id, location_id, location_hint, room_id, room_hint,
                                                x, y, rotation, symbol_key, label_text, metadata, copied_from_id, revision, occurred_at, device_id, created_by)
        values (${org}, ${p.account_id as string | null}, ${p.project_id as string | null}, ${drawingId}, ${to}, ${pageMap.get(p.page_id as string)!},
                ${p.location_id as string | null}, ${p.location_hint as string | null}, ${p.room_id as string | null}, ${p.room_hint as string | null},
                ${p.x as string}, ${p.y as string}, ${p.rotation as string}, ${p.symbol_key as string | null}, ${p.label_text as string | null}, ${tx.json(p.metadata as never)},
                ${p.id as string}, 1, ${now}, ${p.device_id as string | null}, ${ctx.actorId}) returning id`;
      idMap[p.id as string] = r[0].id;
      await propose("places.location_placements", r[0].id, "created", (p.room_id as string | null) ?? null, (p.room_hint as string | null) ?? null,
        { copied_from_id: p.id, after: { location_id: p.location_id ?? null, location_hint: p.location_hint ?? null, x: p.x, y: p.y, label_text: p.label_text ?? null, page_id: pageMap.get(p.page_id as string) } });
    }

    const copied = { annotations: anns.length, polygons: polys.length, placements: pins.length };
    await emitEvent(tx, ctx, {
      projectId, refTable: "drawings.drawing_versions", refId: to, type: "drawing_version.carried_forward",
      payload: { from_version_id: from, drawing_id: drawingId, include, layer_ids: layerIds, copied, skipped, proposals: proposals.length, pages_paired: pageMap.size, pages_source: srcPages.length },
      key: `drawings.drawing_versions:${to}:carry_forward:${from}:${now.getTime()}`,
    });
    return {
      status: 200,
      body: {
        op: "carried_forward", from_version_id: from, to_version_id: to, drawing_id: drawingId, copied, skipped, proposals: proposals.length, proposal_ids: proposals,
        pages: Object.fromEntries(pageMap), ids: idMap,
      },
    };
  });
}
