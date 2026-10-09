// row: W5b · run: run-2026-10-07-drawing-layer-09 · 2026-10-09 — office list routes
//==============================================================================
// sync/office.ts — the read-mostly list routes the app's A2 row needs (office board,
// project picker, "by tech" names, the held-rows queue).
//
//   GET   /walks?status=&unattached=1&created_by=&since=&limit=   → 200 {walks[], next_since, truncated}
//   GET   /walks/:id                                              → 200 {walk: {…, rooms[]}} · 403 not yours · 404
//   GET   /sync/rejections?since=&resolved=0|1&walk_id=&limit=    → 200 {rejections[]} · 403 technician
//   PATCH /sync/rejections/:id {resolution, note?}                → 200 {rejection, applied} · 403 · 409 resolved / adoption refused
//   GET   /members                                                → 200 {members[]}
//   GET   /projects?since=&limit=                                 → 200 {projects[]}
//
// Visibility: a walk is visible to its creator; designer / office / admin see every walk in
// the Organization. Rejections are designer / office / admin to read, office / admin to
// resolve. Members and projects: any member of the Organization.
//
// Adoption (PATCH … {resolution:'adopted'}): only for the HELD reasons — not_row_owner /
// no_checkout / checkout_expired / actor_revoked. The stored `proposed` row is re-pushed
// through the REAL push path (push.ts pushBatchInTx) as the office actor, in the same
// transaction as the resolution: a NEW row is created_by the office actor (the original
// author stays on the rejection row and in the event payload); an EXISTING row keeps its
// created_by (push never re-authors) and the own-row rule is waived (PushOptions.adopt).
// Everything else still applies — in particular a structure row still needs the office
// actor to hold the live checkout. If the re-push rejects, NOTHING is written (the
// transaction rolls back) and the route answers 409 with the push's reason, so the
// rejection stays open and honest. Event: sync_rejection.resolved.
//
// `since` on every list is a received_at / updated_at cursor (strictly greater), carried as
// TEXT like history.ts so microsecond boundaries survive. Lists are newest first.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg, withOrgRead } from "../org-context";
import { isUuid } from "../db";
import { emitEvent, type RouteResult } from "./checkout";
import { isOfficeOrAdmin } from "./drawings";
import { pushBatchInTx, type PushResult, type RejectedRow } from "./push";
import { isSyncTable, type JsonRow } from "./tables";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const WALK_STATUSES = new Set(["draft", "attached", "closed"]);
const RESOLUTIONS = new Set(["adopted", "discarded", "superseded"]);
/** Reasons that mean "held, re-applicable": the row itself was fine, only the actor's standing was not. */
const ADOPTABLE_REASONS = new Set(["not_row_owner", "no_checkout", "checkout_expired", "actor_revoked"]);

//------------------------------------------------------------------------------
// Shared query-string parsing (history.ts shape)
//------------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseSince(params: URLSearchParams): Parsed<string | null> {
  const raw = (params.get("since") ?? "").trim();
  if (raw && Number.isNaN(Date.parse(raw))) return { ok: false, error: "since must be an ISO-8601 timestamp" };
  return { ok: true, value: raw || null };
}

function parseLimit(params: URLSearchParams): Parsed<number> {
  const raw = params.get("limit");
  const limit = raw == null || raw.trim() === "" ? DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, error: `limit must be an integer in [1, ${MAX_LIMIT}]` };
  return { ok: true, value: limit };
}

function bad(error: string): RouteResult {
  return { status: 400, body: { error } };
}

/** designer / office / admin: the roles that see the whole Organization's walks and the held queue. */
function seesAll(ctx: OrganizationContext): boolean {
  return isOfficeOrAdmin(ctx) || ctx.role === "designer";
}

//------------------------------------------------------------------------------
// GET /walks · GET /walks/:id
//------------------------------------------------------------------------------

export interface WalkListRow {
  id: string;
  label: string | null;
  address_hint: string | null;
  project_id: string | null;
  account_id: string | null;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  device_id: string | null;
  received_at: Date;
  checked_out_revision: number | null;
  counts: { notes: number; media: number; placements: number };
  pending_files: number;
}

const WALK_SELECT = (tx: Tx, org: string) => tx`
  select w.id, w.label, w.address_hint, w.project_id, w.account_id, w.status, w.started_at, w.ended_at,
         w.created_by, m.display_name as created_by_name, w.device_id, w.received_at, w.checked_out_revision,
         jsonb_build_object(
           'notes',      (select count(*)::int from places.location_notes n where n.walk_id = w.id and n.organization_id = ${org} and n.deleted_at is null),
           'media',      (select count(*)::int from places.location_media x where x.walk_id = w.id and x.organization_id = ${org} and x.deleted_at is null),
           'placements', (select count(*)::int from places.device_placements p where p.walk_id = w.id and p.organization_id = ${org} and p.deleted_at is null)
         ) as counts,
         (select count(*)::int from shared.files f where f.walk_id = w.id and f.organization_id = ${org} and f.deleted_at is null and f.upload_status = 'pending') as pending_files,
         to_char(w.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _cursor
    from places.walks w
    left join shared.members m on m.id = w.created_by and m.organization_id = w.organization_id`;

export async function listWalks(ctx: OrganizationContext, params: URLSearchParams): Promise<RouteResult> {
  const status = (params.get("status") ?? "").trim() || null;
  if (status && !WALK_STATUSES.has(status)) return bad("status must be one of draft | attached | closed");
  const unattached = ["1", "true"].includes((params.get("unattached") ?? "").trim().toLowerCase());
  const createdByRaw = (params.get("created_by") ?? "").trim() || null;
  if (createdByRaw && !isUuid(createdByRaw)) return bad("created_by must be a UUID");
  const since = parseSince(params);
  if (!since.ok) return bad(since.error);
  const limit = parseLimit(params);
  if (!limit.ok) return bad(limit.error);
  const org = ctx.organizationId;
  // A member without an office-side role sees only their own walks, whatever created_by says.
  const createdBy = seesAll(ctx) ? createdByRaw?.toLowerCase() ?? null : ctx.actorId;
  if (!seesAll(ctx) && createdByRaw && createdByRaw.toLowerCase() !== ctx.actorId) {
    return { status: 403, body: { error: "only a designer / office / admin may list another member's walks" } };
  }

  return withOrgRead(ctx, async (tx) => {
    const rows = await tx<(WalkListRow & { _cursor: string })[]>`
      ${WALK_SELECT(tx, org)}
       where w.organization_id = ${org} and w.deleted_at is null
         ${status ? tx`and w.status = ${status}` : tx``}
         ${unattached ? tx`and w.project_id is null` : tx``}
         ${createdBy ? tx`and w.created_by = ${createdBy}` : tx``}
         ${since.value ? tx`and w.received_at > ${since.value}::text::timestamptz` : tx``}
       order by w.received_at desc, w.started_at desc, w.id desc
       limit ${limit.value + 1}`;
    const truncated = rows.length > limit.value;
    const walks = truncated ? rows.slice(0, limit.value) : rows;
    const newest = walks[0]?._cursor ?? since.value;
    for (const w of walks) delete (w as Partial<typeof w>)._cursor;
    return { status: 200, body: { since: since.value, next_since: newest ?? null, limit: limit.value, truncated, walks } };
  });
}

export interface WalkRoomRow {
  room_id: string | null;
  room_name: string | null;
  room_hint: string | null;
  rows: number;
}

export async function getWalk(ctx: OrganizationContext, walkId: string): Promise<RouteResult> {
  if (!isUuid(walkId)) return bad("walk id must be a UUID");
  const wid = walkId.toLowerCase();
  const org = ctx.organizationId;
  return withOrgRead(ctx, async (tx) => {
    const rows = await tx<(WalkListRow & { _cursor: string })[]>`
      ${WALK_SELECT(tx, org)}
       where w.id = ${wid} and w.organization_id = ${org} and w.deleted_at is null`;
    const walk = rows[0];
    if (!walk) return { status: 404, body: { error: "walk not found in this organization" } };
    if (!seesAll(ctx) && walk.created_by !== ctx.actorId) return { status: 403, body: { error: "only the walk's creator or a designer / office / admin may read it" } };
    delete (walk as Partial<typeof walk>)._cursor;
    // rooms touched: distinct (room_id, room_hint) across the three capture tables, live rows only
    const rooms = await tx<WalkRoomRow[]>`
      with touched as (
        select room_id, nullif(btrim(room_hint), '') as room_hint from places.location_notes     where walk_id = ${wid} and organization_id = ${org} and deleted_at is null
        union all
        select room_id, nullif(btrim(room_hint), '') as room_hint from places.location_media     where walk_id = ${wid} and organization_id = ${org} and deleted_at is null
        union all
        select room_id, nullif(btrim(room_hint), '') as room_hint from places.device_placements  where walk_id = ${wid} and organization_id = ${org} and deleted_at is null
      )
      select t.room_id, r.name as room_name, t.room_hint, count(*)::int as rows
        from touched t
        left join places.rooms r on r.id = t.room_id and r.organization_id = ${org}
       where t.room_id is not null or t.room_hint is not null
       group by t.room_id, r.name, t.room_hint
       order by r.name nulls last, t.room_hint nulls last`;
    return { status: 200, body: { walk: { ...walk, rooms } } };
  });
}

//------------------------------------------------------------------------------
// GET /sync/rejections · PATCH /sync/rejections/:id
//------------------------------------------------------------------------------

export interface RejectionRow {
  id: string;
  walk_id: string | null;
  project_id: string | null;
  ref_table: string;
  ref_id: string;
  actor: string;
  actor_name: string | null;
  device_id: string | null;
  reason: string;
  detail: string | null;
  proposed: JsonRow;
  received_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: string | null;
}

const REJECTION_SELECT = (tx: Tx) => tx`
  select r.id, r.walk_id, r.project_id, r.ref_table, r.ref_id, r.actor, m.display_name as actor_name, r.device_id,
         r.reason, r.detail, r.proposed, r.received_at, r.resolved_at, r.resolved_by, r.resolution
    from places.sync_rejections r
    left join shared.members m on m.id = r.actor and m.organization_id = r.organization_id`;

export async function listRejections(ctx: OrganizationContext, params: URLSearchParams): Promise<RouteResult> {
  if (!seesAll(ctx)) return { status: 403, body: { error: "only a designer / office / admin may list sync rejections" } };
  const since = parseSince(params);
  if (!since.ok) return bad(since.error);
  const limit = parseLimit(params);
  if (!limit.ok) return bad(limit.error);
  const resolvedRaw = (params.get("resolved") ?? "").trim();
  if (resolvedRaw && resolvedRaw !== "0" && resolvedRaw !== "1") return bad("resolved must be 0 or 1");
  const resolved: boolean | null = resolvedRaw === "" ? null : resolvedRaw === "1";
  const walkRaw = (params.get("walk_id") ?? "").trim() || null;
  if (walkRaw && !isUuid(walkRaw)) return bad("walk_id must be a UUID");
  const walkId = walkRaw?.toLowerCase() ?? null;
  const org = ctx.organizationId;

  return withOrgRead(ctx, async (tx) => {
    const rows = await tx<RejectionRow[]>`
      ${REJECTION_SELECT(tx)}
       where r.organization_id = ${org}
         ${resolved === null ? tx`` : resolved ? tx`and r.resolved_at is not null` : tx`and r.resolved_at is null`}
         ${walkId ? tx`and r.walk_id = ${walkId}` : tx``}
         ${since.value ? tx`and r.received_at > ${since.value}::text::timestamptz` : tx``}
       order by r.received_at desc, r.id desc
       limit ${limit.value + 1}`;
    const truncated = rows.length > limit.value;
    const rejections = truncated ? rows.slice(0, limit.value) : rows;
    return { status: 200, body: { since: since.value, limit: limit.value, truncated, rejections } };
  });
}

/** Thrown inside the adoption transaction to roll everything back when the re-push does not land. */
class AdoptionRefused extends Error {
  constructor(public readonly rejected: RejectedRow) {
    super("adoption refused");
    this.name = "AdoptionRefused";
  }
}

export async function resolveRejection(ctx: OrganizationContext, rejectionId: string, body: unknown): Promise<RouteResult> {
  if (!isUuid(rejectionId)) return bad("rejection id must be a UUID");
  if (ctx.revoked) return { status: 403, body: { error: "member is inactive" } };
  if (!isOfficeOrAdmin(ctx)) return { status: 403, body: { error: "only office / admin may resolve sync rejections" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const resolution = typeof b.resolution === "string" ? b.resolution.trim() : "";
  if (!RESOLUTIONS.has(resolution)) return bad("resolution must be one of adopted | discarded | superseded");
  if (b.note != null && typeof b.note !== "string") return bad("note must be a string");
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  const rid = rejectionId.toLowerCase();
  const org = ctx.organizationId;

  try {
    return await withOrg(ctx, async (tx) => {
      const rows = await tx<RejectionRow[]>`
        select r.id, r.walk_id, r.project_id, r.ref_table, r.ref_id, r.actor, null::text as actor_name, r.device_id,
               r.reason, r.detail, r.proposed, r.received_at, r.resolved_at, r.resolved_by, r.resolution
          from places.sync_rejections r where r.id = ${rid} and r.organization_id = ${org} for update`;
      const rej = rows[0];
      if (!rej) return { status: 404, body: { error: "rejection not found in this organization" } };
      if (rej.resolved_at) {
        return { status: 409, body: { error: "rejection is already resolved", resolved_at: rej.resolved_at, resolved_by: rej.resolved_by, resolution: rej.resolution } };
      }

      let applied: { table: string; id: string; revision: number; op: string } | null = null;
      if (resolution === "adopted") {
        if (!ADOPTABLE_REASONS.has(rej.reason)) {
          return { status: 409, body: { error: `only a held rejection (${[...ADOPTABLE_REASONS].join(" / ")}) can be adopted; this one is '${rej.reason}' — discard or supersede it`, reason: rej.reason } };
        }
        if (!isSyncTable(rej.ref_table)) return { status: 409, body: { error: "rejection's ref_table is not a sync table", ref_table: rej.ref_table } };
        const result = await adoptProposed(tx, ctx, rej);
        const a = result.accepted[0];
        applied = { table: a.table, id: a.id, revision: a.revision, op: a.op };
      }

      const now = new Date();
      await tx`
        update places.sync_rejections
           set resolved_at = ${now}, resolved_by = ${ctx.actorId}, resolution = ${resolution}
         where id = ${rid} and organization_id = ${org}`;

      await emitEvent(tx, ctx, {
        projectId: rej.project_id, refTable: "places.sync_rejections", refId: rid, type: "sync_rejection.resolved",
        payload: {
          resolution, note, reason: rej.reason, ref_table: rej.ref_table, ref_id: rej.ref_id,
          original_actor: rej.actor, walk_id: rej.walk_id, applied,
        },
        key: `places.sync_rejections:${rid}:resolved`,
        deviceId: rej.device_id,
      });

      return {
        status: 200,
        body: {
          rejection: { ...rej, resolved_at: now, resolved_by: ctx.actorId, resolution },
          note,
          applied,
        },
      };
    });
  } catch (e) {
    if (e instanceof AdoptionRefused) {
      return { status: 409, body: { error: "adoption refused by the push rules; rejection left open", rejected: e.rejected } };
    }
    throw e;
  }
}

/**
 * Re-push the stored `proposed` row as the office actor. A row that does not exist yet is
 * created_by the office actor (push requires created_by = actor on new rows); an existing row
 * keeps its author. Throws AdoptionRefused (→ rollback) when the push path rejects it.
 */
async function adoptProposed(tx: Tx, ctx: OrganizationContext, rej: RejectionRow): Promise<PushResult> {
  const proposed: JsonRow = { ...(rej.proposed ?? {}), id: rej.ref_id, organization_id: ctx.organizationId };
  const exists = await tx<{ one: number }[]>`select 1 as one from ${tx(rej.ref_table)} where id = ${rej.ref_id} and organization_id = ${ctx.organizationId} limit 1`;
  if (!exists.length) proposed.created_by = ctx.actorId;
  const result = await pushBatchInTx(tx, ctx, {
    walk_id: rej.walk_id,
    device_id: rej.device_id ?? "office",
    rows: [{ table: rej.ref_table, row: proposed }],
    files: [],
  }, { putUrlFor: () => "", adopt: true });
  if (result.rejected.length || !result.accepted.length) throw new AdoptionRefused(result.rejected[0] ?? { table: rej.ref_table, id: rej.ref_id, reason: "schema", detail: "no outcome" });
  return result;
}

//------------------------------------------------------------------------------
// GET /members · GET /projects
//------------------------------------------------------------------------------

export interface MemberRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  is_admin: boolean;
  revoked: boolean;
}

export async function listMembers(ctx: OrganizationContext): Promise<RouteResult> {
  const org = ctx.organizationId;
  return withOrgRead(ctx, async (tx) => {
    const members = await tx<MemberRow[]>`
      select id, display_name as name, email, role, is_admin, (not active) as revoked
        from shared.members
       where organization_id = ${org} and deleted_at is null
       order by lower(display_name), id`;
    return { status: 200, body: { members } };
  });
}

export interface ProjectRow {
  id: string;
  name: string;
  account_id: string | null;
  account_name: string | null;
  site_address: string | null;
  status: string;
  published_revision: number | null;
  checkout: { user_id: string; user_name: string | null; expires_at: Date } | null;
  unsynced_walks: number;
  updated_at: Date;
}

export async function listProjects(ctx: OrganizationContext, params: URLSearchParams): Promise<RouteResult> {
  const since = parseSince(params);
  if (!since.ok) return bad(since.error);
  const limit = parseLimit(params);
  if (!limit.ok) return bad(limit.error);
  const org = ctx.organizationId;
  return withOrgRead(ctx, async (tx) => {
    const rows = await tx<(ProjectRow & { _cursor: string })[]>`
      select p.id, p.name, p.account_id, a.name as account_name, p.site_address, p.status, s.published_revision,
             case when s.checkout_user_id is not null and s.checkout_expires_at > now()
                  then jsonb_build_object('user_id', s.checkout_user_id, 'user_name', cm.display_name, 'expires_at', s.checkout_expires_at)
                  else null end as checkout,
             (select count(*)::int from places.walks w
               where w.project_id = p.id and w.organization_id = ${org} and w.deleted_at is null
                 and exists (select 1 from shared.files f where f.walk_id = w.id and f.organization_id = ${org} and f.deleted_at is null and f.upload_status = 'pending')) as unsynced_walks,
             p.updated_at,
             to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as _cursor
        from shared.projects p
        left join shared.accounts a on a.id = p.account_id and a.organization_id = p.organization_id
        left join places.structure_state s on s.project_id = p.id and s.organization_id = p.organization_id
        left join shared.members cm on cm.id = s.checkout_user_id and cm.organization_id = p.organization_id
       where p.organization_id = ${org} and p.deleted_at is null
         ${since.value ? tx`and p.updated_at > ${since.value}::text::timestamptz` : tx``}
       order by p.updated_at desc, p.id desc
       limit ${limit.value + 1}`;
    const truncated = rows.length > limit.value;
    const projects = truncated ? rows.slice(0, limit.value) : rows;
    const newest = projects[0]?._cursor ?? since.value;
    for (const p of projects) delete (p as Partial<typeof p>)._cursor;
    return { status: 200, body: { since: since.value, next_since: newest ?? null, limit: limit.value, truncated, projects } };
  });
}
