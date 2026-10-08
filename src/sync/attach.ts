// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
//==============================================================================
// sync/attach.ts — POST /walks/:id/attach {project_id} (walk spec §5.2 walks, §6 check 4).
//
// IN PLACE, NO REKEY: one UPDATE on places.walks (project_id, status='attached',
// attached_at/by, received_at = now() so devices pull the anchored walk). Then, for every
// capture row under the walk (location_notes, location_media, device_placements, files):
//   • project_id := the project where it was NULL (draft captures)
//   • room_id    := places.rooms.id where lower(trim(room_hint)) = lower(trim(rooms.name))
//                   in the SAME project (live rooms only) and room_id was NULL
//   • received_at := now() on every touched row (pull cursor)
// For each DISTINCT room_hint still unmatched → ONE structure_changes(change_kind =
// 'room_hint_pending') at working_revision (ref = the walk; diff = hint + per-table counts).
// The designer resolves those at check-in. Event: walk.attached (key places.walks:<id>:attached).
//
// Who: the walk's creator, or designer / office / admin. Re-attach to the SAME project is an
// idempotent 200 (no second pass of writes); to a DIFFERENT project → 409 — detach is not a
// walk operation in v1. /sync/push refuses to change walks.project_id (push.ts), so this route
// is the only attach path. The drawings attach/detach of the drawing-layer spec §5.2 is row
// W4's; it reuses the hint-resolution rule below verbatim but is NOT built here.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { readStructureState, emitEvent, type RouteResult } from "./checkout";

interface WalkRow {
  id: string;
  project_id: string | null;
  account_id: string | null;
  status: string;
  created_by: string;
  attached_at: Date | null;
  attached_by: string | null;
  deleted_at: Date | null;
  device_id: string | null;
}

/** Capture tables that hang off a walk and carry the room_hint / room_id pair. */
const HINT_TABLES = ["places.location_notes", "places.location_media", "places.device_placements"] as const;

export function mayAttach(ctx: OrganizationContext, walk: WalkRow): boolean {
  return ctx.isAdmin || ctx.role === "designer" || ctx.role === "office" || ctx.role === "admin" || walk.created_by === ctx.actorId;
}

export async function attachWalk(ctx: OrganizationContext, walkId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(walkId)) return { status: 400, body: { error: "walk id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isUuid(b.project_id)) return { status: 400, body: { error: "project_id (UUID) is required" } };
  const pid = (b.project_id as string).toLowerCase();
  const wid = walkId.toLowerCase();

  return withOrg(ctx, async (tx) => {
    const walks = await tx<WalkRow[]>`
      select id, project_id, account_id, status, created_by, attached_at, attached_by, deleted_at, device_id
        from places.walks where id = ${wid} and organization_id = ${ctx.organizationId} for update`;
    const walk = walks[0];
    if (!walk) return { status: 404, body: { error: "walk not found in this organization" } };
    if (walk.deleted_at) return { status: 409, body: { error: "walk is tombstoned" } };
    if (!mayAttach(ctx, walk)) return { status: 403, body: { error: "only the walk's creator or a designer / office / admin may attach it" } };
    if (walk.project_id && walk.project_id !== pid) {
      return { status: 409, body: { error: "walk is already attached to a different project", project_id: walk.project_id } };
    }
    const project = await tx<{ id: string; account_id: string | null }[]>`
      select id, account_id from shared.projects where id = ${pid} and organization_id = ${ctx.organizationId} and deleted_at is null`;
    if (!project[0]) return { status: 404, body: { error: "project not found in this organization" } };
    const state = await readStructureState(tx, pid, ctx.organizationId);
    if (!state) return { status: 409, body: { error: "project has no structure_state" } };

    if (walk.project_id === pid) {
      return { status: 200, body: { op: "noop", walk_id: wid, project_id: pid, attached_at: walk.attached_at, attached_by: walk.attached_by } };
    }

    const now = new Date();
    await tx`
      update places.walks
         set project_id = ${pid}, account_id = coalesce(account_id, ${project[0].account_id}), status = 'attached',
             attached_at = ${now}, attached_by = ${ctx.actorId}, received_at = now()
       where id = ${wid} and organization_id = ${ctx.organizationId}`;

    const resolution = await resolveHints(tx, ctx.organizationId, wid, pid, project[0].account_id, state.working_revision, ctx.actorId, now);

    await emitEvent(tx, ctx, {
      projectId: pid, refTable: "places.walks", refId: wid, type: "walk.attached",
      payload: { project_id: pid, resolved_rooms: resolution.resolved, pending_hints: resolution.pending.map((p) => p.room_hint), rows_touched: resolution.rowsTouched },
      key: `places.walks:${wid}:attached`,
      deviceId: walk.device_id,
    });

    return {
      status: 200,
      body: {
        op: "attached", walk_id: wid, project_id: pid, attached_at: now, attached_by: ctx.actorId,
        resolved_rooms: resolution.resolved, room_hint_pending: resolution.pending, rows_touched: resolution.rowsTouched,
      },
    };
  });
}

interface Resolution {
  resolved: { room_hint: string; room_id: string; room_name: string; rows: number }[];
  pending: { room_hint: string; change_id: string; rows: Record<string, number> }[];
  rowsTouched: Record<string, number>;
}

/**
 * The hint-resolution rule (shared with W4's drawings attach by contract, not by code yet):
 * case-insensitive, trimmed name match against live rooms of the SAME project.
 */
async function resolveHints(tx: Tx, org: string, walkId: string, projectId: string, accountId: string | null, workingRevision: number, actor: string, now: Date): Promise<Resolution> {
  const rooms = await tx<{ id: string; name: string }[]>`
    select id, name from places.rooms where organization_id = ${org} and project_id = ${projectId} and deleted_at is null`;
  const byName = new Map<string, { id: string; name: string }>();
  for (const r of rooms) byName.set(norm(r.name), r);

  const resolvedCount = new Map<string, { room: { id: string; name: string }; hint: string; rows: number }>();
  const pendingCount = new Map<string, { hint: string; rows: Record<string, number> }>();
  const rowsTouched: Record<string, number> = {};

  for (const table of HINT_TABLES) {
    // anchor: project_id where NULL; touch received_at on every live row of the walk
    const anchored = await tx<{ id: string }[]>`
      update ${tx(table)} set project_id = coalesce(project_id, ${projectId}), account_id = coalesce(account_id, ${accountId}), received_at = now()
       where walk_id = ${walkId} and organization_id = ${org} and deleted_at is null returning id`;
    rowsTouched[table] = anchored.length;

    const hinted = await tx<{ id: string; room_hint: string }[]>`
      select id, room_hint from ${tx(table)}
       where walk_id = ${walkId} and organization_id = ${org} and deleted_at is null and room_id is null and room_hint is not null and btrim(room_hint) <> ''`;
    for (const row of hinted) {
      const key = norm(row.room_hint);
      const room = byName.get(key);
      if (room) {
        await tx`update ${tx(table)} set room_id = ${room.id} where id = ${row.id} and organization_id = ${org} and room_id is null`;
        const r = resolvedCount.get(key) ?? { room, hint: row.room_hint.trim(), rows: 0 };
        r.rows += 1;
        resolvedCount.set(key, r);
      } else {
        const p = pendingCount.get(key) ?? { hint: row.room_hint.trim(), rows: {} };
        p.rows[table] = (p.rows[table] ?? 0) + 1;
        pendingCount.set(key, p);
      }
    }
  }
  // files under the walk: anchor only (no room on a file)
  const files = await tx<{ id: string }[]>`
    update shared.files set project_id = coalesce(project_id, ${projectId}), account_id = coalesce(account_id, ${accountId}), received_at = now()
     where walk_id = ${walkId} and organization_id = ${org} and deleted_at is null returning id`;
  rowsTouched["shared.files"] = files.length;

  const pending: Resolution["pending"] = [];
  for (const p of pendingCount.values()) {
    const ins = await tx<{ id: string }[]>`
      insert into places.structure_changes (organization_id, project_id, revision, room_id, room_hint, walk_id, ref_table, ref_id, change_kind, diff, actor, occurred_at)
      values (${org}, ${projectId}, ${workingRevision}, null, ${p.hint}, ${walkId}, 'places.walks', ${walkId}, 'room_hint_pending',
              ${tx.json({ room_hint: p.hint, rows: p.rows, source: "walk.attach" } as never)}, ${actor}, ${now})
      returning id`;
    pending.push({ room_hint: p.hint, change_id: ins[0].id, rows: p.rows });
  }
  return {
    resolved: [...resolvedCount.values()].map((r) => ({ room_hint: r.hint, room_id: r.room.id, room_name: r.room.name, rows: r.rows })),
    pending,
    rowsTouched,
  };
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}
