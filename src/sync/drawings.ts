// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08 — drawings attach / detach / move / copy (spec §5.2) + R-move promotion (spec §2a fix 2, §5.3)
//==============================================================================
// sync/drawings.ts — the Worker acts on a drawing's ANCHOR and the one promotion path.
//
//   POST /drawings/:id/attach {project_id | account_id}   (exactly one; office / admin)
//     ONE UPDATE on drawings.drawings (project_id | account_id, attached_at/by, received_at).
//     Project attach, in the same transaction:
//       • polygons / placements of the drawing: project_id := project where NULL, account_id likewise
//       • room_hint → room_id on polygons / placements / annotations where a LIVE room of the
//         project matches case-/space-insensitively (the walks' rule, reused verbatim — attach.ts)
//       • every DISTINCT unmatched hint → ONE structure_changes('room_hint_pending') at working_revision
//         (ref = the drawing, drawing_id set) for the designer's next review
//       • R-class-stamp consequence (spec §5.3): rows sitting on STRUCTURE layers were capture-until-
//         attach; they are re-evaluated ONCE and surface as structure_changes('annotation') PROPOSALS —
//         nothing is silently promoted, no row's class changes.
//     Account attach resolves nothing (no rooms at Account level): a pure filing act.
//     Re-attach to the SAME anchor → 200 noop; attached elsewhere → 409 (use /move).
//   POST /drawings/:id/detach                                (office / admin)
//     IN PLACE: project_id / account_id NULL, detached_at. For a project detach: every UNREVIEWED
//     structure_changes row this drawing raised → review_outcome 'withdrawn'; room_id on polygons /
//     placements / annotations rewritten back to room_hint (the room NAME is kept, so the drawing
//     stays self-describing); location_id on placements → location_hint likewise; project_id /
//     account_id on polygons / placements → NULL. Rows promoted INTO the project (places.rooms,
//     places.locations, reviewed structure_changes, the project's own rows) are never touched.
//     NOTHING IS DELETED — "attach → detach leaves zero deleted rows" is the probe.
//   POST /drawings/:id/move {project_id | account_id}      = detach + attach in ONE transaction.
//   POST /drawings/:id/copy {title?}                         (designer / office / admin) → 201
//     A NEW drawing (unattached) + its layers + versions + pages + annotations / polygons /
//     placements, every copied row stamped copied_from_id = the source row, revision 1, created_by
//     = actor. shared.files rows are REFERENCED (same source_file_id / preview_file_id / file_id),
//     never duplicated. Rule A1: sharing across Projects is a copy, never a second FK.
//
//   PATCH /annotations/:id {layer_id}   — R-move (Amendment 1 fix 2)
//     same class, own row (or office / admin) → plain UPDATE (revision + 1), event annotation.moved;
//       a locked / tombstoned target → 409 (a PATCH is an explicit act — unlike /sync/push, there is
//       no offline ink to protect, so it is refused rather than redirected).
//     onto a STRUCTURE layer → requires the drawing to be attached to a project (409) and the actor
//       to hold the LIVE checkout (409 none / 403 another holder): MINTS a NEW structure-class row
//       (revision 1) on the target layer, writes structure_changes('annotation') for it, and
//       tombstones the source with moved_to_id. The source row's class is NEVER re-stamped
//       (immutable_class is the push-side guard; this route is the only promotion path).
//     structure → capture layer → 409 (class is stamped once; it never downgrades by move).
//
// Every statement goes through withOrg (SET LOCAL app.org_id) and filters organization_id too.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { readStructureState, lockStructureState, isLive, emitEvent, type RouteResult } from "./checkout";
import { readLayer } from "./layers";
import type { JsonRow } from "./tables";

//------------------------------------------------------------------------------
// Shared bits
//------------------------------------------------------------------------------

export interface DrawingRow {
  id: string;
  organization_id: string;
  kind: "plan" | "whiteboard";
  project_id: string | null;
  account_id: string | null;
  working_title: string | null;
  address_hint: string | null;
  attached_at: Date | null;
  attached_by: string | null;
  detached_at: Date | null;
  revision: number;
  created_by: string;
  deleted_at: Date | null;
  device_id: string | null;
  custom: JsonRow;
}

export function isOfficeOrAdmin(ctx: OrganizationContext): boolean {
  return ctx.isAdmin || ctx.role === "office" || ctx.role === "admin";
}
function mayCopy(ctx: OrganizationContext): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer";
}

export async function lockDrawing(tx: Tx, drawingId: string, org: string): Promise<DrawingRow | null> {
  const rows = await tx<DrawingRow[]>`
    select id, organization_id, kind, project_id, account_id, working_title, address_hint, attached_at, attached_by, detached_at,
           revision, created_by, deleted_at, device_id, custom
      from drawings.drawings where id = ${drawingId} and organization_id = ${org} for update`;
  return rows[0] ?? null;
}

function drawingView(d: DrawingRow | JsonRow): Record<string, unknown> {
  const r = d as JsonRow;
  return {
    id: r.id, kind: r.kind, project_id: r.project_id ?? null, account_id: r.account_id ?? null, working_title: r.working_title ?? null,
    address_hint: r.address_hint ?? null, attached_at: r.attached_at ?? null, attached_by: r.attached_by ?? null,
    detached_at: r.detached_at ?? null, revision: r.revision, created_by: r.created_by,
  };
}

/** The walks' hint rule (attach.ts), verbatim: trimmed, whitespace-collapsed, case-insensitive. */
export function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

type Anchor = { kind: "project"; id: string } | { kind: "account"; id: string };

/** Exactly one of project_id / account_id, both UUIDs — else null (→ 400). */
function parseAnchor(body: unknown): Anchor | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const p = b.project_id, a = b.account_id;
  if (p != null && a != null) return null;
  if (p != null) return isUuid(p) ? { kind: "project", id: (p as string).toLowerCase() } : null;
  if (a != null) return isUuid(a) ? { kind: "account", id: (a as string).toLowerCase() } : null;
  return null;
}

//------------------------------------------------------------------------------
// Attach
//------------------------------------------------------------------------------

export interface AttachResolution {
  resolved: { room_hint: string; room_id: string; room_name: string; rows: number }[];
  pending: { room_hint: string; change_id: string; rows: Record<string, number> }[];
  rows_touched: Record<string, number>;
  /** structure_changes('annotation') ids raised for rows sitting on structure layers (spec §5.3 re-evaluation). */
  annotation_proposals: string[];
}

export async function attachDrawing(ctx: OrganizationContext, drawingId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may attach a drawing" } };
  const anchor = parseAnchor(body);
  if (!anchor) return { status: 400, body: { error: "exactly one of project_id | account_id (UUID) is required" } };
  const did = drawingId.toLowerCase();
  return withOrg(ctx, async (tx) => {
    const d = await lockDrawing(tx, did, ctx.organizationId);
    if (!d) return { status: 404, body: { error: "drawing not found in this organization" } };
    if (d.deleted_at) return { status: 409, body: { error: "drawing is tombstoned" } };
    return attachInTx(tx, ctx, d, anchor);
  });
}

async function attachInTx(tx: Tx, ctx: OrganizationContext, d: DrawingRow, anchor: Anchor): Promise<RouteResult> {
  const org = ctx.organizationId;
  const current: Anchor | null = d.project_id ? { kind: "project", id: d.project_id } : d.account_id ? { kind: "account", id: d.account_id } : null;
  if (current && current.kind === anchor.kind && current.id === anchor.id) {
    return { status: 200, body: { op: "noop", drawing: drawingView(d) } };
  }
  if (current) {
    return { status: 409, body: { error: `drawing is already attached to a ${current.kind}; detach or move it`, [`${current.kind}_id`]: current.id } };
  }
  const now = new Date();
  if (anchor.kind === "account") {
    const acct = await tx<{ id: string }[]>`select id from shared.accounts where id = ${anchor.id} and organization_id = ${org} and deleted_at is null`;
    if (!acct[0]) return { status: 404, body: { error: "account not found in this organization" } };
    const rows = await tx<DrawingRow[]>`
      update drawings.drawings set account_id = ${anchor.id}, attached_at = ${now}, attached_by = ${ctx.actorId}, received_at = now()
       where id = ${d.id} and organization_id = ${org} returning *`;
    await emitEvent(tx, ctx, {
      projectId: null, refTable: "drawings.drawings", refId: d.id, type: "drawing.attached",
      payload: { account_id: anchor.id, kind: d.kind, pure_filing: true },
      key: `drawings.drawings:${d.id}:attached:${now.getTime()}`, deviceId: d.device_id,
    });
    return { status: 200, body: { op: "attached", drawing: drawingView(rows[0]), resolved_rooms: [], room_hint_pending: [], rows_touched: {}, annotation_proposals: [] } };
  }

  const project = await tx<{ id: string; account_id: string | null }[]>`
    select id, account_id from shared.projects where id = ${anchor.id} and organization_id = ${org} and deleted_at is null`;
  if (!project[0]) return { status: 404, body: { error: "project not found in this organization" } };
  const state = await readStructureState(tx, anchor.id, org);
  if (!state) return { status: 409, body: { error: "project has no structure_state" } };

  const rows = await tx<DrawingRow[]>`
    update drawings.drawings set project_id = ${anchor.id}, attached_at = ${now}, attached_by = ${ctx.actorId}, received_at = now()
     where id = ${d.id} and organization_id = ${org} returning *`;
  const res = await resolveDrawingHints(tx, ctx, d.id, anchor.id, project[0].account_id, state.working_revision, now);
  res.annotation_proposals = await proposeStructureLayerRows(tx, ctx, d.id, anchor.id, state.working_revision, now);

  await emitEvent(tx, ctx, {
    projectId: anchor.id, refTable: "drawings.drawings", refId: d.id, type: "drawing.attached",
    payload: {
      project_id: anchor.id, kind: d.kind, resolved_rooms: res.resolved, pending_hints: res.pending.map((p) => p.room_hint),
      rows_touched: res.rows_touched, annotation_proposals: res.annotation_proposals.length,
    },
    key: `drawings.drawings:${d.id}:attached:${now.getTime()}`, deviceId: d.device_id,
  });
  return {
    status: 200,
    body: { op: "attached", drawing: drawingView(rows[0]), resolved_rooms: res.resolved, room_hint_pending: res.pending, rows_touched: res.rows_touched, annotation_proposals: res.annotation_proposals },
  };
}

/** Tables of a drawing that carry the room_hint / room_id pair. Polygons and placements also carry project_id / account_id. */
const HINT_TABLES = ["places.room_polygons", "places.location_placements", "drawings.annotations"] as const;
const ANCHORED_TABLES = ["places.room_polygons", "places.location_placements"] as const;

async function resolveDrawingHints(tx: Tx, ctx: OrganizationContext, drawingId: string, projectId: string, accountId: string | null, workingRevision: number, now: Date): Promise<AttachResolution> {
  const org = ctx.organizationId;
  const rooms = await tx<{ id: string; name: string }[]>`
    select id, name from places.rooms where organization_id = ${org} and project_id = ${projectId} and deleted_at is null`;
  const byName = new Map<string, { id: string; name: string }>();
  for (const r of rooms) byName.set(norm(r.name), r);

  const resolvedCount = new Map<string, { room: { id: string; name: string }; hint: string; rows: number }>();
  const pendingCount = new Map<string, { hint: string; rows: Record<string, number> }>();
  const rowsTouched: Record<string, number> = {};

  for (const table of ANCHORED_TABLES) {
    const anchored = await tx<{ id: string }[]>`
      update ${tx(table)} set project_id = coalesce(project_id, ${projectId}), account_id = coalesce(account_id, ${accountId}), received_at = now()
       where drawing_id = ${drawingId} and organization_id = ${org} and deleted_at is null returning id`;
    rowsTouched[table] = anchored.length;
  }
  for (const table of HINT_TABLES) {
    const hinted = table === "drawings.annotations"
      ? await tx<{ id: string; room_hint: string; page_id: string }[]>`
          select a.id, a.room_hint, a.page_id from drawings.annotations a join drawings.pages p on p.id = a.page_id
           where p.drawing_id = ${drawingId} and a.organization_id = ${org} and p.organization_id = ${org} and a.deleted_at is null
             and a.room_id is null and a.room_hint is not null and btrim(a.room_hint) <> ''`
      : await tx<{ id: string; room_hint: string; page_id: string }[]>`
          select id, room_hint, page_id from ${tx(table)}
           where drawing_id = ${drawingId} and organization_id = ${org} and deleted_at is null
             and room_id is null and room_hint is not null and btrim(room_hint) <> ''`;
    if (table === "drawings.annotations") rowsTouched[table] = hinted.length;
    for (const row of hinted) {
      const key = norm(row.room_hint);
      const room = byName.get(key);
      let done = false;
      if (room) {
        // room_polygons: one live polygon per (page, room) — a second match on the same page stays pending
        const upd = table === "places.room_polygons"
          ? await tx<{ id: string }[]>`
              update places.room_polygons p set room_id = ${room.id}, received_at = now()
               where p.id = ${row.id} and p.organization_id = ${org} and p.room_id is null
                 and not exists (select 1 from places.room_polygons q where q.page_id = p.page_id and q.room_id = ${room.id} and q.deleted_at is null and q.id <> p.id)
               returning id`
          : await tx<{ id: string }[]>`
              update ${tx(table)} set room_id = ${room.id}, received_at = now()
               where id = ${row.id} and organization_id = ${org} and room_id is null returning id`;
        done = upd.length === 1;
        if (done) {
          const r = resolvedCount.get(key) ?? { room, hint: row.room_hint.trim(), rows: 0 };
          r.rows += 1;
          resolvedCount.set(key, r);
        }
      }
      if (!done) {
        const p = pendingCount.get(key) ?? { hint: row.room_hint.trim(), rows: {} };
        p.rows[table] = (p.rows[table] ?? 0) + 1;
        pendingCount.set(key, p);
      }
    }
  }
  const pending: AttachResolution["pending"] = [];
  for (const p of pendingCount.values()) {
    const ins = await tx<{ id: string }[]>`
      insert into places.structure_changes (organization_id, project_id, revision, room_id, room_hint, drawing_id, ref_table, ref_id, change_kind, diff, actor, occurred_at)
      values (${org}, ${projectId}, ${workingRevision}, null, ${p.hint}, ${drawingId}, 'drawings.drawings', ${drawingId}, 'room_hint_pending',
              ${tx.json({ room_hint: p.hint, rows: p.rows, source: "drawing.attach" } as never)}, ${ctx.actorId}, ${now})
      returning id`;
    pending.push({ room_hint: p.hint, change_id: ins[0].id, rows: p.rows });
  }
  return {
    resolved: [...resolvedCount.values()].map((r) => ({ room_hint: r.hint, room_id: r.room.id, room_name: r.room.name, rows: r.rows })),
    pending, rows_touched: rowsTouched, annotation_proposals: [],
  };
}

/**
 * Spec §5.3 R-class-stamp: on an unattached drawing every row was capture until attach. At attach the rows
 * sitting on STRUCTURE layers are re-evaluated ONCE → one structure_changes('annotation') PROPOSAL each
 * (idempotent: a row that already has an unreviewed proposal at this revision gets no second one).
 * Nothing is promoted: class stays as stamped; the designer decides at check-in.
 */
async function proposeStructureLayerRows(tx: Tx, ctx: OrganizationContext, drawingId: string, projectId: string, workingRevision: number, now: Date): Promise<string[]> {
  const org = ctx.organizationId;
  const rows = await tx<{ id: string; class: string; layer_id: string; layer_name: string; room_id: string | null; room_hint: string | null; kind: string; occurred_at: Date; walk_id: string | null }[]>`
    select a.id, a.class, a.layer_id, l.name as layer_name, a.room_id, a.room_hint, a.kind, a.occurred_at, a.walk_id
      from drawings.annotations a
      join drawings.pages p on p.id = a.page_id and p.organization_id = a.organization_id
      join drawings.layers l on l.id = a.layer_id and l.organization_id = a.organization_id
     where p.drawing_id = ${drawingId} and a.organization_id = ${org} and a.deleted_at is null and l.class = 'structure'
       and not exists (select 1 from places.structure_changes c
                        where c.organization_id = a.organization_id and c.project_id = ${projectId} and c.revision = ${workingRevision}
                          and c.ref_table = 'drawings.annotations' and c.ref_id = a.id and c.review_outcome is null)
     order by a.received_at, a.id`;
  const out: string[] = [];
  for (const a of rows) {
    const ins = await tx<{ id: string }[]>`
      insert into places.structure_changes (organization_id, project_id, revision, room_id, room_hint, drawing_id, walk_id, ref_table, ref_id, change_kind, diff, actor, occurred_at)
      values (${org}, ${projectId}, ${workingRevision}, ${a.room_id}, ${a.room_hint}, ${drawingId}, ${a.walk_id}, 'drawings.annotations', ${a.id}, 'annotation',
              ${tx.json({ op: "proposed", source: "drawing.attach", class: a.class, layer_id: a.layer_id, layer_name: a.layer_name, kind: a.kind } as never)},
              ${ctx.actorId}, ${now})
      returning id`;
    out.push(ins[0].id);
  }
  return out;
}

//------------------------------------------------------------------------------
// Detach
//------------------------------------------------------------------------------

export async function detachDrawing(ctx: OrganizationContext, drawingId: string): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may detach a drawing" } };
  const did = drawingId.toLowerCase();
  return withOrg(ctx, async (tx) => {
    const d = await lockDrawing(tx, did, ctx.organizationId);
    if (!d) return { status: 404, body: { error: "drawing not found in this organization" } };
    if (d.deleted_at) return { status: 409, body: { error: "drawing is tombstoned" } };
    return detachInTx(tx, ctx, d);
  });
}

async function detachInTx(tx: Tx, ctx: OrganizationContext, d: DrawingRow): Promise<RouteResult> {
  const org = ctx.organizationId;
  if (!d.project_id && !d.account_id) return { status: 200, body: { op: "noop", drawing: drawingView(d) } };
  const now = new Date();
  const was = d.project_id ? { kind: "project", id: d.project_id } : { kind: "account", id: d.account_id! };
  const rows = await tx<DrawingRow[]>`
    update drawings.drawings set project_id = null, account_id = null, detached_at = ${now}, received_at = now()
     where id = ${d.id} and organization_id = ${org} returning *`;

  const summary: Record<string, unknown> = { withdrawn_changes: 0, rows_rewritten: {} };
  if (d.project_id) {
    const withdrawn = await tx<{ id: string }[]>`
      update places.structure_changes set review_outcome = 'withdrawn', reviewed_at = ${now}, reviewed_by = ${ctx.actorId}
       where organization_id = ${org} and project_id = ${d.project_id} and drawing_id = ${d.id} and review_outcome is null returning id`;
    summary.withdrawn_changes = withdrawn.length;
    const rewritten: Record<string, number> = {};
    // room_id → room_hint (name kept) on polygons / placements / annotations of this drawing; project/account anchors off
    const poly = await tx<{ id: string }[]>`
      update places.room_polygons p
         set room_hint = coalesce(p.room_hint, r.name), room_id = null, project_id = null, account_id = null, received_at = now()
        from places.rooms r
       where p.drawing_id = ${d.id} and p.organization_id = ${org} and p.deleted_at is null and r.id = p.room_id returning p.id`;
    const polyRest = await tx<{ id: string }[]>`
      update places.room_polygons set project_id = null, account_id = null, received_at = now()
       where drawing_id = ${d.id} and organization_id = ${org} and deleted_at is null and (project_id is not null or account_id is not null) returning id`;
    rewritten["places.room_polygons"] = poly.length + polyRest.length;
    const plRoom = await tx<{ id: string }[]>`
      update places.location_placements p
         set room_hint = coalesce(p.room_hint, r.name), room_id = null, received_at = now()
        from places.rooms r
       where p.drawing_id = ${d.id} and p.organization_id = ${org} and p.deleted_at is null and r.id = p.room_id returning p.id`;
    const plLoc = await tx<{ id: string }[]>`
      update places.location_placements p
         set location_hint = coalesce(p.location_hint, l.label), location_id = null, received_at = now()
        from places.locations l
       where p.drawing_id = ${d.id} and p.organization_id = ${org} and p.deleted_at is null and l.id = p.location_id returning p.id`;
    const plRest = await tx<{ id: string }[]>`
      update places.location_placements set project_id = null, account_id = null, received_at = now()
       where drawing_id = ${d.id} and organization_id = ${org} and deleted_at is null and (project_id is not null or account_id is not null) returning id`;
    rewritten["places.location_placements"] = new Set([...plRoom, ...plLoc, ...plRest].map((r) => r.id)).size;
    const ann = await tx<{ id: string }[]>`
      update drawings.annotations a
         set room_hint = coalesce(a.room_hint, r.name), room_id = null, received_at = now()
        from places.rooms r, drawings.pages p
       where p.id = a.page_id and p.drawing_id = ${d.id} and a.organization_id = ${org} and p.organization_id = ${org}
         and a.deleted_at is null and r.id = a.room_id returning a.id`;
    rewritten["drawings.annotations"] = ann.length;
    summary.rows_rewritten = rewritten;
  }
  await emitEvent(tx, ctx, {
    projectId: d.project_id, refTable: "drawings.drawings", refId: d.id, type: "drawing.detached",
    payload: { from: was, kind: d.kind, ...summary },
    key: `drawings.drawings:${d.id}:detached:${now.getTime()}`, deviceId: d.device_id,
  });
  return { status: 200, body: { op: "detached", drawing: drawingView(rows[0]), from: was, ...summary } };
}

//------------------------------------------------------------------------------
// Move = detach + attach, one transaction
//------------------------------------------------------------------------------

export async function moveDrawing(ctx: OrganizationContext, drawingId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office or admin may move a drawing" } };
  const anchor = parseAnchor(body);
  if (!anchor) return { status: 400, body: { error: "exactly one of project_id | account_id (UUID) is required" } };
  const did = drawingId.toLowerCase();
  return withOrg(ctx, async (tx) => {
    const d = await lockDrawing(tx, did, ctx.organizationId);
    if (!d) return { status: 404, body: { error: "drawing not found in this organization" } };
    if (d.deleted_at) return { status: 409, body: { error: "drawing is tombstoned" } };
    const current = d.project_id ? { kind: "project", id: d.project_id } : d.account_id ? { kind: "account", id: d.account_id } : null;
    if (current && current.kind === anchor.kind && current.id === anchor.id) return { status: 200, body: { op: "noop", drawing: drawingView(d) } };
    // validate the target BEFORE detaching so a bad target leaves the drawing where it was (the tx would roll back anyway)
    if (anchor.kind === "project") {
      const p = await tx<{ id: string }[]>`select id from shared.projects where id = ${anchor.id} and organization_id = ${ctx.organizationId} and deleted_at is null`;
      if (!p[0]) return { status: 404, body: { error: "project not found in this organization" } };
    } else {
      const a = await tx<{ id: string }[]>`select id from shared.accounts where id = ${anchor.id} and organization_id = ${ctx.organizationId} and deleted_at is null`;
      if (!a[0]) return { status: 404, body: { error: "account not found in this organization" } };
    }
    const detached = await detachInTx(tx, ctx, d);
    if (detached.status !== 200) return detached;
    const fresh = await lockDrawing(tx, did, ctx.organizationId);
    const attached = await attachInTx(tx, ctx, fresh!, anchor);
    if (attached.status !== 200) return attached;
    return { status: 200, body: { ...attached.body, op: "moved", from: current, detach: detached.body } };
  });
}

//------------------------------------------------------------------------------
// Copy
//------------------------------------------------------------------------------

export async function copyDrawing(ctx: OrganizationContext, drawingId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(drawingId)) return { status: 400, body: { error: "drawing id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayCopy(ctx)) return { status: 403, body: { error: "only designer, office or admin may copy a drawing" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.title != null && typeof b.title !== "string") return { status: 400, body: { error: "title must be a string" } };
  const did = drawingId.toLowerCase();
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    const src = await tx<DrawingRow[]>`
      select id, organization_id, kind, project_id, account_id, working_title, address_hint, attached_at, attached_by, detached_at,
             revision, created_by, deleted_at, device_id, custom
        from drawings.drawings where id = ${did} and organization_id = ${org}`;
    const d = src[0];
    if (!d) return { status: 404, body: { error: "drawing not found in this organization" } };
    if (d.deleted_at) return { status: 409, body: { error: "drawing is tombstoned" } };
    const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : `${d.working_title ?? "Drawing"} (copy)`;
    const now = new Date();

    const nd = await tx<{ id: string }[]>`
      insert into drawings.drawings (organization_id, kind, project_id, account_id, working_title, address_hint, occurred_at, created_by, custom)
      values (${org}, ${d.kind}, null, null, ${title}, ${d.address_hint}, ${now}, ${ctx.actorId}, ${tx.json({ ...d.custom, copied_from_drawing_id: d.id } as never)})
      returning id`;
    const newId = nd[0].id;

    // layers (live only; locks do not copy)
    const layerMap = new Map<string, string>();
    const layers = await tx<JsonRow[]>`
      select * from drawings.layers where drawing_id = ${d.id} and organization_id = ${org} and deleted_at is null order by ordinal, created_at, id`;
    for (const l of layers) {
      const r = await tx<{ id: string }[]>`
        insert into drawings.layers (organization_id, drawing_id, template_id, name, ordinal, class, write_policy, export, color_hint, occurred_at, created_by)
        values (${org}, ${newId}, ${l.template_id as string | null}, ${l.name as string}, ${l.ordinal as number}, ${l.class as string}, ${l.write_policy as string},
                ${l.export as boolean}, ${l.color_hint as string | null}, ${now}, ${ctx.actorId}) returning id`;
      layerMap.set(l.id as string, r[0].id);
    }
    // versions (same source file; lifecycle restarts at draft)
    const versionMap = new Map<string, string>();
    const versions = await tx<JsonRow[]>`
      select * from drawings.drawing_versions where drawing_id = ${d.id} and organization_id = ${org} and deleted_at is null order by version_no`;
    for (const v of versions) {
      const r = await tx<{ id: string }[]>`
        insert into drawings.drawing_versions (organization_id, drawing_id, version_no, label, source_file_id, page_count, raster_status, occurred_at, created_by, custom)
        values (${org}, ${newId}, ${v.version_no as number}, ${v.label as string | null}, ${v.source_file_id as string | null}, ${v.page_count as number | null},
                ${v.raster_status as string}, ${now}, ${ctx.actorId}, ${tx.json({ ...(v.custom as JsonRow), copied_from_version_id: v.id } as never)}) returning id`;
      versionMap.set(v.id as string, r[0].id);
    }
    // pages (room → hint: the copy is unattached)
    const pageMap = new Map<string, string>();
    const pages = await tx<JsonRow[]>`
      select p.*, r.name as room_name from drawings.pages p left join places.rooms r on r.id = p.room_id
       where p.drawing_id = ${d.id} and p.organization_id = ${org} and p.deleted_at is null order by p.ordinal, p.id`;
    for (const p of pages) {
      const r = await tx<{ id: string }[]>`
        insert into drawings.pages (organization_id, drawing_id, drawing_version_id, ordinal, name, orientation, preview_file_id, source_page_no, room_id, room_hint, occurred_at, created_by, custom)
        values (${org}, ${newId}, ${p.drawing_version_id ? versionMap.get(p.drawing_version_id as string) ?? null : null}, ${p.ordinal as number}, ${p.name as string | null},
                ${p.orientation as string}, ${p.preview_file_id as string | null}, ${p.source_page_no as number | null}, null,
                ${(p.room_hint as string | null) ?? (p.room_name as string | null)}, ${now}, ${ctx.actorId}, ${tx.json(p.custom as never)}) returning id`;
      pageMap.set(p.id as string, r[0].id);
    }
    const pageIds = [...pageMap.keys()];
    const counts = { layers: layers.length, versions: versions.length, pages: pages.length, annotations: 0, room_polygons: 0, location_placements: 0 };
    if (pageIds.length) {
      const anns = await tx<JsonRow[]>`
        select a.*, r.name as room_name from drawings.annotations a left join places.rooms r on r.id = a.room_id
         where a.page_id in ${tx(pageIds)} and a.organization_id = ${org} and a.deleted_at is null order by a.received_at, a.id`;
      for (const a of anns) {
        const layerId = layerMap.get(a.layer_id as string);
        if (!layerId) continue; // its layer was tombstoned — nothing to land on
        await tx`
          insert into drawings.annotations (organization_id, page_id, layer_id, redirected_from_layer_id, kind, class, geometry, style, label, z, room_id, room_hint, location_id,
                                            file_id, callout_no, checked, custom, copied_from_id, occurred_at, created_by)
          values (${org}, ${pageMap.get(a.page_id as string)!}, ${layerId}, ${a.redirected_from_layer_id ? layerMap.get(a.redirected_from_layer_id as string) ?? null : null},
                  ${a.kind as string}, ${a.class as string}, ${tx.json(a.geometry as never)}, ${a.style == null ? null : tx.json(a.style as never)}, ${a.label as string | null},
                  ${a.z as number}, null, ${(a.room_hint as string | null) ?? (a.room_name as string | null)}, null, ${a.file_id as string | null}, ${a.callout_no as number | null},
                  ${a.checked as boolean}, ${tx.json(a.custom as never)}, ${a.id as string}, ${now}, ${ctx.actorId})`;
        counts.annotations += 1;
      }
      const polys = await tx<JsonRow[]>`
        select p.*, r.name as room_name from places.room_polygons p left join places.rooms r on r.id = p.room_id
         where p.drawing_id = ${d.id} and p.organization_id = ${org} and p.deleted_at is null and p.page_id in ${tx(pageIds)} order by p.received_at, p.id`;
      for (const p of polys) {
        await tx`
          insert into places.room_polygons (organization_id, account_id, project_id, drawing_id, drawing_version_id, page_id, room_id, room_hint, polygon, metadata, copied_from_id, occurred_at, created_by)
          values (${org}, null, null, ${newId}, ${p.drawing_version_id ? versionMap.get(p.drawing_version_id as string) ?? null : null}, ${pageMap.get(p.page_id as string)!},
                  null, ${(p.room_hint as string | null) ?? (p.room_name as string | null)}, ${tx.json(p.polygon as never)}, ${tx.json(p.metadata as never)}, ${p.id as string}, ${now}, ${ctx.actorId})`;
        counts.room_polygons += 1;
      }
      const pins = await tx<JsonRow[]>`
        select p.*, r.name as room_name, l.label as location_label from places.location_placements p
          left join places.rooms r on r.id = p.room_id left join places.locations l on l.id = p.location_id
         where p.drawing_id = ${d.id} and p.organization_id = ${org} and p.deleted_at is null and p.page_id in ${tx(pageIds)} order by p.received_at, p.id`;
      for (const p of pins) {
        await tx`
          insert into places.location_placements (organization_id, account_id, project_id, drawing_id, drawing_version_id, page_id, location_id, location_hint, room_id, room_hint,
                                                  x, y, rotation, symbol_key, label_text, metadata, copied_from_id, occurred_at, created_by)
          values (${org}, null, null, ${newId}, ${p.drawing_version_id ? versionMap.get(p.drawing_version_id as string) ?? null : null}, ${pageMap.get(p.page_id as string)!},
                  null, ${(p.location_hint as string | null) ?? (p.location_label as string | null)}, null, ${(p.room_hint as string | null) ?? (p.room_name as string | null)},
                  ${p.x as string}, ${p.y as string}, ${p.rotation as string}, ${p.symbol_key as string | null}, ${p.label_text as string | null}, ${tx.json(p.metadata as never)},
                  ${p.id as string}, ${now}, ${ctx.actorId})`;
        counts.location_placements += 1;
      }
    }
    await emitEvent(tx, ctx, {
      projectId: null, refTable: "drawings.drawings", refId: newId, type: "drawing.copied",
      payload: { op: "created", class: "structure", revision: 1, copied_from_drawing_id: d.id, kind: d.kind, counts },
      key: `drawings.drawings:${newId}:1`,
    });
    const created = await tx<DrawingRow[]>`select * from drawings.drawings where id = ${newId} and organization_id = ${org}`;
    return {
      status: 201,
      body: {
        op: "copied", drawing: drawingView(created[0]), copied_from_drawing_id: d.id, counts,
        layers: Object.fromEntries(layerMap), versions: Object.fromEntries(versionMap), pages: Object.fromEntries(pageMap),
      },
    };
  });
}

//------------------------------------------------------------------------------
// PATCH /annotations/:id {layer_id} — R-move
//------------------------------------------------------------------------------

interface AnnotationRow extends JsonRow {
  id: string;
  page_id: string;
  layer_id: string;
  class: "structure" | "capture";
  created_by: string;
  revision: number;
  deleted_at: Date | null;
  moved_to_id: string | null;
  drawing_id: string;
  project_id: string | null;
  drawing_kind: string;
}

export async function moveAnnotation(ctx: OrganizationContext, annotationId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(annotationId)) return { status: 400, body: { error: "annotation id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.layer_id)) return { status: 400, body: { error: "layer_id (UUID) is required" } };
  if (b.class != null) return { status: 400, body: { error: "class is stamped once and never set by a client" } };
  const aid = annotationId.toLowerCase();
  const targetId = (b.layer_id as string).toLowerCase();
  const org = ctx.organizationId;

  return withOrg(ctx, async (tx) => {
    const rows = await tx<AnnotationRow[]>`
      select a.*, p.drawing_id, d.project_id, d.kind as drawing_kind
        from drawings.annotations a
        join drawings.pages p on p.id = a.page_id and p.organization_id = a.organization_id
        join drawings.drawings d on d.id = p.drawing_id and d.organization_id = a.organization_id
       where a.id = ${aid} and a.organization_id = ${org} for update of a`;
    const a = rows[0];
    if (!a) return { status: 404, body: { error: "annotation not found in this organization" } };
    if (a.deleted_at) return { status: 409, body: { error: "annotation is tombstoned", moved_to_id: a.moved_to_id } };
    const target = await readLayer(tx, targetId, org);
    if (!target || target.drawing_id !== a.drawing_id) return { status: 404, body: { error: "layer_id is not a layer of this annotation's drawing" } };
    if (target.id === a.layer_id) return { status: 200, body: { op: "noop", annotation: annView(a) } };
    if (target.deleted_at) return { status: 409, body: { error: "target layer is tombstoned" } };
    if (target.locked) return { status: 409, body: { error: "target layer is locked", locked_by: target.locked_by } };

    // ---- same class: a plain move ---------------------------------------------------------
    if (target.class === a.class) {
      const own = a.created_by === ctx.actorId;
      if (!own && !isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only the row's creator or office / admin may move it" } };
      if (a.class === "structure" && a.project_id) {
        // a structure row under a project is still structure: the live checkout is the only gate
        const state = await readStructureState(tx, a.project_id, org);
        if (!state || !isLive(state)) return { status: 409, body: { error: "no live structure checkout on the project" } };
        if (state.checkout_user_id !== ctx.actorId) return { status: 403, body: { error: "only the checkout holder may move a structure row", holder: state.checkout_user_id } };
      }
      const next = a.revision + 1;
      const upd = await tx<AnnotationRow[]>`
        update drawings.annotations set layer_id = ${target.id}, revision = ${next}, received_at = now()
         where id = ${a.id} and organization_id = ${org} returning *`;
      await emitEvent(tx, ctx, {
        projectId: a.project_id, refTable: "drawings.annotations", refId: a.id, type: "annotation.moved",
        payload: { op: "updated", class: a.class, revision: next, from_layer_id: a.layer_id, to_layer_id: target.id, drawing_id: a.drawing_id },
        key: `drawings.annotations:${a.id}:${next}`,
      });
      return { status: 200, body: { op: "moved", annotation: annView(upd[0]) } };
    }

    // ---- structure → capture: never (class is stamped once) ---------------------------------
    if (target.class === "capture") {
      return { status: 409, body: { error: "a structure row cannot move onto a capture layer: class is stamped once and never downgrades by move" } };
    }

    // ---- capture → structure: PROMOTION (checkout-gated, mints a NEW row) -------------------
    if (a.drawing_kind !== "plan") return { status: 409, body: { error: "whiteboards have no structure layers" } };
    if (!a.project_id) return { status: 409, body: { error: "the drawing is not attached to a project; there is no checkout to hold (attach first)" } };
    const state = await lockStructureState(tx, a.project_id, org);
    if (!state) return { status: 409, body: { error: "project has no structure_state" } };
    if (!state.checkout_user_id || !isLive(state)) return { status: 409, body: { error: "promotion requires the live structure checkout; take it first" } };
    if (state.checkout_user_id !== ctx.actorId) return { status: 403, body: { error: "only the checkout holder may promote a mark onto a structure layer", holder: state.checkout_user_id } };

    const now = new Date();
    const minted = await tx<AnnotationRow[]>`
      insert into drawings.annotations (organization_id, page_id, layer_id, redirected_from_layer_id, moved_to_id, kind, class, geometry, style, label, z,
                                        room_id, room_hint, location_id, file_id, callout_no, checked, custom, copied_from_id,
                                        revision, occurred_at, device_id, created_by, walk_id, captured_revision)
      values (${org}, ${a.page_id}, ${target.id}, null, null, ${a.kind as string}, 'structure', ${tx.json(a.geometry as never)},
              ${a.style == null ? null : tx.json(a.style as never)}, ${a.label as string | null}, ${a.z as number},
              ${a.room_id as string | null}, ${a.room_hint as string | null}, ${a.location_id as string | null}, ${a.file_id as string | null},
              ${a.callout_no as number | null}, ${a.checked as boolean}, ${tx.json(a.custom as never)}, null,
              1, ${now}, ${a.device_id as string | null}, ${ctx.actorId}, ${a.walk_id as string | null}, ${a.captured_revision as number | null})
      returning *`;
    const nu = minted[0];
    const next = a.revision + 1;
    const src = await tx<AnnotationRow[]>`
      update drawings.annotations set deleted_at = ${now}, deleted_by = ${ctx.actorId}, moved_to_id = ${nu.id}, revision = ${next}, received_at = now()
       where id = ${a.id} and organization_id = ${org} returning *`;
    await tx`
      insert into places.structure_changes (organization_id, project_id, revision, room_id, room_hint, drawing_id, walk_id, ref_table, ref_id, change_kind, diff, actor, occurred_at)
      values (${org}, ${a.project_id}, ${state.working_revision}, ${a.room_id as string | null}, ${a.room_hint as string | null}, ${a.drawing_id}, ${a.walk_id as string | null},
              'drawings.annotations', ${nu.id}, 'annotation',
              ${tx.json({ op: "promoted", source_annotation_id: a.id, from_layer_id: a.layer_id, to_layer_id: target.id, kind: a.kind, label: a.label ?? null } as never)},
              ${ctx.actorId}, ${now})`;
    await emitEvent(tx, ctx, {
      projectId: a.project_id, refTable: "drawings.annotations", refId: nu.id, type: "annotation.promoted",
      payload: { op: "created", class: "structure", revision: 1, source_annotation_id: a.id, from_layer_id: a.layer_id, to_layer_id: target.id, drawing_id: a.drawing_id },
      key: `drawings.annotations:${nu.id}:1`,
    });
    await emitEvent(tx, ctx, {
      projectId: a.project_id, refTable: "drawings.annotations", refId: a.id, type: "annotation.synced",
      payload: { op: "tombstoned", class: a.class, revision: next, moved_to_id: nu.id, drawing_id: a.drawing_id },
      key: `drawings.annotations:${a.id}:${next}`,
    });
    return { status: 201, body: { op: "promoted", annotation: annView(nu), source: annView(src[0]) } };
  });
}

function annView(a: JsonRow): Record<string, unknown> {
  return {
    id: a.id, page_id: a.page_id, layer_id: a.layer_id, redirected_from_layer_id: a.redirected_from_layer_id ?? null, moved_to_id: a.moved_to_id ?? null,
    kind: a.kind, class: a.class, geometry: a.geometry, style: a.style ?? null, label: a.label ?? null, z: a.z, room_id: a.room_id ?? null, room_hint: a.room_hint ?? null,
    location_id: a.location_id ?? null, file_id: a.file_id ?? null, callout_no: a.callout_no ?? null, checked: a.checked, copied_from_id: a.copied_from_id ?? null,
    revision: a.revision, created_by: a.created_by, deleted_at: a.deleted_at ?? null, deleted_by: a.deleted_by ?? null,
  };
}
