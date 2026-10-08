// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08 — publish pin: 404 unknown version · 409 version of another project / client_rejected / superseded (spec §2b publish rule)
//==============================================================================
// sync/review.ts — check-in review + publish (walk spec L7, §5.2 structure_changes,
// §5.5 action_items, §5.6 publish_revision; Gate A: the review list is MATERIALIZED).
//
//   GET   /projects/:id/review
//         → structure_changes WHERE project_id = ? AND revision = working_revision AND
//           review_outcome IS NULL, grouped by room (room_id → room name; else room_hint;
//           else "unassigned"); plus OPEN action_items for the project with source_kind IN
//           (field_flag, verify_placement, room_hint); plus CONTEXT arrays (notes, media,
//           as-walked placements received since the last publish) — context is never a
//           review row (anti-rubber-stamp).
//   PATCH /projects/:id/review/:changeId  {outcome}
//         → reviewed_at/by/outcome. Outcomes are the 036 CHECK values
//           validated | modified | approved | withdrawn; the W2 prompt's vocabulary maps
//           accepted → approved, dismissed → withdrawn. Designer / office / admin.
//   POST  /projects/:id/publish  {drawing_version_id?}
//         → the ONLY publish path: places.publish_revision(p_project_id, p_actor,
//           p_drawing_version_id) (SECURITY DEFINER, row-locked, emits structure.published
//           itself — this module does NOT emit a second one). Worker rules before the call:
//           only the LIVE checkout holder may publish (no admin bypass — an admin overrides
//           first, explicitly) and NO unreviewed structure_changes may remain for the
//           working revision (409 with the pending count). W4 (spec §2b publish rule): a pinned
//           drawing_version_id must exist (404), belong to a drawing of THIS project (409) and be in
//           any status except client_rejected / superseded (409) — technicians load the pinned
//           version; the status chip tells them whether it is client-approved.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg, withOrgRead } from "../org-context";
import { isUuid } from "../db";
import { lockStructureState, readStructureState, isLive, stateView, type RouteResult, type StructureStateRow } from "./checkout";

/** places.structure_changes.review_outcome CHECK (036) — verbatim. */
export const REVIEW_OUTCOMES = ["validated", "modified", "approved", "withdrawn"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
/** The W2 prompt's words → the 036 values. */
const OUTCOME_ALIASES: Record<string, ReviewOutcome> = { accepted: "approved", accept: "approved", dismissed: "withdrawn", dismiss: "withdrawn" };

export function normalizeOutcome(v: unknown): ReviewOutcome | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if ((REVIEW_OUTCOMES as readonly string[]).includes(s)) return s as ReviewOutcome;
  return OUTCOME_ALIASES[s] ?? null;
}

const REVIEW_SOURCE_KINDS = ["field_flag", "verify_placement", "room_hint"] as const;
const CONTEXT_LIMIT = 500;

interface ChangeRow {
  id: string;
  revision: number;
  room_id: string | null;
  room_hint: string | null;
  room_name: string | null;
  drawing_id: string | null;
  walk_id: string | null;
  ref_table: string;
  ref_id: string;
  change_kind: string;
  diff: unknown;
  actor: string;
  occurred_at: Date;
  received_at: Date;
}

export interface ReviewGroup {
  key: string;
  room_id: string | null;
  room_name: string | null;
  room_hint: string | null;
  changes: ChangeRow[];
}

//------------------------------------------------------------------------------
// GET /projects/:id/review
//------------------------------------------------------------------------------

export async function getReview(ctx: OrganizationContext, projectId: string): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  const pid = projectId.toLowerCase();
  return withOrgRead(ctx, async (tx) => {
    const state = await readStructureState(tx, pid, ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };

    const changes = await tx<ChangeRow[]>`
      select c.id, c.revision, c.room_id, c.room_hint, r.name as room_name, c.drawing_id, c.walk_id,
             c.ref_table, c.ref_id, c.change_kind, c.diff, c.actor, c.occurred_at, c.received_at
        from places.structure_changes c
        left join places.rooms r on r.id = c.room_id and r.organization_id = c.organization_id
       where c.organization_id = ${ctx.organizationId} and c.project_id = ${pid}
         and c.revision = ${state.working_revision} and c.review_outcome is null
       order by coalesce(r.sort_order, 2147483647), r.name nulls last, c.room_hint nulls last, c.received_at`;

    const groups = new Map<string, ReviewGroup>();
    for (const c of changes) {
      const key = c.room_id ? `room:${c.room_id}` : c.room_hint ? `hint:${c.room_hint.trim().toLowerCase()}` : "unassigned";
      let g = groups.get(key);
      if (!g) {
        g = { key, room_id: c.room_id, room_name: c.room_name, room_hint: c.room_id ? null : c.room_hint, changes: [] };
        groups.set(key, g);
      }
      g.changes.push(c);
    }

    const actionItems = await tx<Record<string, unknown>[]>`
      select id, title, description, status, source_kind, source_ref_table, source_ref_id, rule_id, created_by, custom, created_at
        from shared.action_items
       where organization_id = ${ctx.organizationId} and project_id = ${pid} and deleted_at is null
         and status = 'open' and source_kind in ${tx(REVIEW_SOURCE_KINDS as unknown as string[])}
       order by created_at`;

    const since = state.published_at ?? new Date(0);
    const notes = await tx<Record<string, unknown>[]>`
      select id, room_id, room_hint, location_id, location_hint, kind, phase, body, walk_id, captured_revision, created_by, occurred_at, received_at
        from places.location_notes
       where organization_id = ${ctx.organizationId} and project_id = ${pid} and deleted_at is null and received_at > ${since}
       order by received_at desc limit ${CONTEXT_LIMIT}`;
    const media = await tx<Record<string, unknown>[]>`
      select m.id, m.room_id, m.room_hint, m.location_id, m.location_hint, m.file_id, m.phase, m.caption, m.walk_id, m.captured_revision,
             m.created_by, m.occurred_at, m.received_at, f.upload_status, f.storage_key
        from places.location_media m
        left join shared.files f on f.id = m.file_id and f.organization_id = m.organization_id
       where m.organization_id = ${ctx.organizationId} and m.project_id = ${pid} and m.deleted_at is null and m.received_at > ${since}
       order by m.received_at desc limit ${CONTEXT_LIMIT}`;
    const asWalked = await tx<Record<string, unknown>[]>`
      select id, room_id, room_hint, location_id, location_hint, product_name, placement_status, phase, walk_id, captured_revision, created_by, occurred_at, received_at
        from places.device_placements
       where organization_id = ${ctx.organizationId} and project_id = ${pid} and deleted_at is null and capture_kind = 'as_walked' and received_at > ${since}
       order by received_at desc limit ${CONTEXT_LIMIT}`;

    const pendingHints = changes.filter((c) => c.change_kind === "room_hint_pending").length;
    return {
      status: 200,
      body: {
        project_id: pid,
        working_revision: state.working_revision,
        published_revision: state.published_revision,
        structure_state: stateView(state),
        pending_count: changes.length,
        pending_room_hints: pendingHints,
        groups: [...groups.values()],
        action_items: actionItems,
        context: { notes, media, as_walked_placements: asWalked, since: since.toISOString() },
      },
    };
  });
}

//------------------------------------------------------------------------------
// PATCH /projects/:id/review/:changeId
//------------------------------------------------------------------------------

export function mayReview(ctx: OrganizationContext): boolean {
  return ctx.isAdmin || ctx.role === "designer" || ctx.role === "office" || ctx.role === "admin";
}

export async function patchReview(ctx: OrganizationContext, projectId: string, changeId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  if (!isUuid(changeId)) return { status: 400, body: { error: "change id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!mayReview(ctx)) return { status: 403, body: { error: "only a designer / office / admin may review" } };
  const outcome = normalizeOutcome((body as Record<string, unknown> | null)?.outcome);
  if (!outcome) return { status: 400, body: { error: `outcome must be one of ${REVIEW_OUTCOMES.join(" | ")} (aliases: accepted → approved, dismissed → withdrawn)` } };
  const pid = projectId.toLowerCase();
  const cid = changeId.toLowerCase();

  return withOrg(ctx, async (tx) => {
    const state = await readStructureState(tx, pid, ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };
    const rows = await tx<{ id: string; revision: number; review_outcome: string | null; reviewed_by: string | null; reviewed_at: Date | null }[]>`
      select id, revision, review_outcome, reviewed_by, reviewed_at from places.structure_changes
       where id = ${cid} and project_id = ${pid} and organization_id = ${ctx.organizationId} for update`;
    const change = rows[0];
    if (!change) return { status: 404, body: { error: "change not found for this project" } };
    if (change.revision !== state.working_revision) {
      return { status: 409, body: { error: "change belongs to an already-published revision", revision: change.revision, working_revision: state.working_revision } };
    }
    const updated = await tx<Record<string, unknown>[]>`
      update places.structure_changes
         set reviewed_at = now(), reviewed_by = ${ctx.actorId}, review_outcome = ${outcome}
       where id = ${cid} and organization_id = ${ctx.organizationId}
       returning id, revision, change_kind, ref_table, ref_id, room_id, room_hint, reviewed_at, reviewed_by, review_outcome`;
    await tx`
      insert into shared.events (organization_id, project_id, ref_table, ref_id, event_type, payload, actor, actor_type, idempotency_key)
      values (${ctx.organizationId}, ${pid}, 'places.structure_changes', ${cid}, 'structure.reviewed',
              ${tx.json({ outcome, previous_outcome: change.review_outcome, revision: change.revision } as never)},
              ${ctx.actorId}, 'member', ${`places.structure_changes:${cid}:${outcome}:${Date.now()}`})
      on conflict (organization_id, idempotency_key) do nothing`;
    return { status: 200, body: { change: updated[0], previous_outcome: change.review_outcome } };
  });
}

//------------------------------------------------------------------------------
// POST /projects/:id/publish
//------------------------------------------------------------------------------

export async function publishProject(ctx: OrganizationContext, projectId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(projectId)) return { status: 400, body: { error: "project id must be a UUID" } };
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const dv = b.drawing_version_id;
  if (dv != null && !isUuid(dv)) return { status: 400, body: { error: "drawing_version_id must be a UUID" } };
  const pid = projectId.toLowerCase();

  return withOrg(ctx, async (tx) => {
    const state = await lockStructureState(tx, pid, ctx.organizationId);
    if (!state) return { status: 404, body: { error: "project not found in this organization (no structure_state)" } };
    // Worker rule: the LIVE checkout holder publishes. No admin bypass — override first (explicit, evented).
    if (!state.checkout_user_id) return { status: 409, body: { error: "no checkout; take the structure checkout before publishing", structure_state: stateView(state) } };
    if (state.checkout_user_id !== ctx.actorId) return { status: 403, body: { error: "only the checkout holder may publish", holder: state.checkout_user_id } };
    if (!isLive(state)) return { status: 409, body: { error: "checkout has expired; renew or take it again before publishing", structure_state: stateView(state) } };
    // Worker rule: nothing unreviewed at the working revision.
    const pending = await tx<{ n: string; hints: string }[]>`
      select count(*)::text as n, count(*) filter (where change_kind = 'room_hint_pending')::text as hints
        from places.structure_changes
       where organization_id = ${ctx.organizationId} and project_id = ${pid} and revision = ${state.working_revision} and review_outcome is null`;
    const pendingCount = Number(pending[0]?.n ?? 0);
    if (pendingCount > 0) {
      return { status: 409, body: { error: "unreviewed structure changes remain for the working revision", pending_count: pendingCount, pending_room_hints: Number(pending[0].hints), working_revision: state.working_revision } };
    }
    // W4: the publish pin rule (spec §2b) — checked here, in TypeScript, before the DB publish path.
    const pin = dv != null ? (dv as string).toLowerCase() : null;
    if (pin) {
      const v = await tx<{ id: string; status: string; project_id: string | null; kind: string; deleted_at: Date | null }[]>`
        select v.id, v.status, d.project_id, d.kind, v.deleted_at from drawings.drawing_versions v
          join drawings.drawings d on d.id = v.drawing_id and d.organization_id = v.organization_id
         where v.id = ${pin} and v.organization_id = ${ctx.organizationId}`;
      if (!v[0] || v[0].deleted_at) return { status: 404, body: { error: "drawing_version_id not found in this organization" } };
      if (v[0].project_id !== pid) return { status: 409, body: { error: "drawing_version_id belongs to a drawing that is not attached to this project", drawing_project_id: v[0].project_id } };
      if (v[0].status === "client_rejected" || v[0].status === "superseded") {
        return { status: 409, body: { error: `a ${v[0].status} version cannot be pinned as the published drawing version`, status: v[0].status } };
      }
    }
    let published: StructureStateRow;
    try {
      // savepoint: a refused publish (bad drawing version) must not abort the surrounding transaction
      published = await tx.savepoint(async (sp) => {
        const rows = await sp<StructureStateRow[]>`
          select * from places.publish_revision(${pid}, ${ctx.actorId}, ${pin})`;
        return rows[0];
      });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "P0002") return { status: 404, body: { error: "project not found in this organization" } };
      if (code === "23503") return { status: 422, body: { error: "drawing_version_id does not belong to this project" } };
      throw e;
    }
    return { status: 200, body: { op: "published", structure_state: stateView(published) } };
  });
}

/** Exported for the test harness / other modules: the pending count at the working revision. */
export async function pendingReviewCount(tx: Tx, organizationId: string, projectId: string, workingRevision: number): Promise<number> {
  const r = await tx<{ n: string }[]>`
    select count(*)::text as n from places.structure_changes
     where organization_id = ${organizationId} and project_id = ${projectId} and revision = ${workingRevision} and review_outcome is null`;
  return Number(r[0]?.n ?? 0);
}
