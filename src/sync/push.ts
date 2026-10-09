// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07 — rules engine wired after the event; walks.project_id immutable via push (attach route only)
// row: W3 · run: run-2026-10-07-drawing-layer-05 · 2026-10-07 — per-table hook moved BEFORE the class rules (annotations: class from the landing layer, redirect fields in the response); structure annotations → structure_changes('annotation'); template layers minted for drawings created in the batch (`created_layers`)
// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — after the batch, raster_status is refreshed for every drawing_version whose pages were pushed (spec §5.6: 'device' once every preview landed) → `raster_status[]`
// row: W5b · run: run-2026-10-07-drawing-layer-09 · 2026-10-09 — office list routes: pushBatchInTx (batch body on a caller-owned transaction) + PushOptions.adopt (own-row rule waived for office adoption of a held rejection)
//==============================================================================
// sync/push.ts — POST /sync/push: per-row idempotent upsert (walk spec §5.6–5.7).
//
// Body: { walk_id?, device_id, rows: [{table, row}], files: [{file_id, sha256?}] }
// ONE transaction per batch (withOrg → SET LOCAL app.org_id/user_id/role); ONE
// savepoint per row so a bad row never poisons its neighbours. Per row:
//
//   shape check (sync set present, organization_id = ctx org, created_by = actor for
//   new rows, occurred_at) → parent-exists (every FK column → unknown_parent) → draft-
//   walk rule (walk.project_id NULL ⇒ room_id/location_id/project_id NULL, hints only)
//   → per-table hook (sync/layers.ts: annotations redirect + class stamp; layers template
//   validation) → class (structure | capture; the hook's rowClass wins) → RULES (below) → UPSERT
//        INSERT … ON CONFLICT (id) DO UPDATE SET … , received_at = now()
//          WHERE EXCLUDED.revision > t.revision
//            AND (t.deleted_at IS NULL OR EXCLUDED.deleted_at IS NOT NULL)   -- tombstone-resurrection guard
//   → shared.events (idempotency_key '<table>:<id>:<revision>', ON CONFLICT DO NOTHING)
//   → places.structure_changes where applicable (created|updated|tombstoned|stale_capture).
//
// RULES (all in TypeScript — none in PL/pgSQL):
//   structure rows WITH a project  → actor must hold the LIVE checkout on structure_state
//                                     (checkout_user_id = actor AND checkout_expires_at > now())
//                                     else no_checkout / checkout_expired.
//   structure rows WITHOUT a project (unattached drawing/pages/layers/polygons/placements)
//                                   → nothing to check out: own-row rules apply (spec §5.3:
//                                     "all rows are capture until attach").
//   capture rows                   → insert from any member; update/tombstone only where
//                                     created_by = actor (admin may tombstone any) else not_row_owner.
//   stale capture                  → captured_revision < published_revision is ACCEPTED and one
//                                     structure_changes('stale_capture') row is written.
//   revoked actor (members.active = false) → every row HELD as sync_rejections('actor_revoked').
//   losing upsert                  → same revision already stored = idempotent replay (accepted,
//                                     no-op); lower revision = stale_revision; newer revision that
//                                     would clear a tombstone = stale_tombstone.
//
// Rejection reasons come ONLY from places.sync_rejections.reason CHECK (036). There is
// deliberately NO layer-based reason: layer governance REDIRECTS (row W3), never rejects.
// An org mismatch cannot be its own reason (not in the CHECK) → stored as 'schema' with
// detail 'org_mismatch'.
//
// Annotations (W3, sync/layers.ts): class is COPIED from the layer the row finally lands on
// and stamped once; a layer that is locked / not writable REDIRECTS the row to the actor's
// role-default layer (accepted, `redirected_to_layer_id` + `redirect_reason` in the response,
// redirected_from_layer_id on the row) — never a rejection. An UPDATE that would change class
// is 'immutable_class'. Structure-class annotations (checkout holder on a structure layer)
// write structure_changes(change_kind='annotation'); captures never do.
// Template instantiation: after the rows, every drawings.drawings row CREATED in this batch
// gets the Organization's layer_templates for its kind that the device did not pre-mint
// (server-minted, same transaction) → `created_layers` in the response.
//==============================================================================

import type { OrganizationContext, Tx } from "../org-context";
import { withOrg } from "../org-context";
import { isUuid } from "../db";
import { evaluateRules } from "../rules";
import { ensureTemplateLayers, type CreatedLayer } from "./layers"; // importing registers the W3 hooks on TABLE_SPECS
import { refreshRasterStatus, type RasterRefresh } from "./plan-import";
import {
  TABLE_SPECS,
  PARENT_TARGETS,
  SYNC_SET_COLUMNS,
  isSyncTable,
  type SyncTable,
  type JsonRow,
  type RejectionReason,
  type RowClass,
  type ChangeKind,
} from "./tables";

//------------------------------------------------------------------------------
// Wire types
//------------------------------------------------------------------------------

export interface PushRowInput {
  table: string;
  row: JsonRow;
}
export interface PushFileInput {
  file_id: string;
  sha256?: string | null;
}
export interface PushBody {
  walk_id?: string | null;
  device_id: string;
  rows: PushRowInput[];
  files?: PushFileInput[];
}

export type RowOp = "created" | "updated" | "tombstoned" | "noop";

export interface AcceptedRow {
  table: string;
  id: string;
  revision: number;
  /** created | updated | tombstoned | noop (idempotent replay of an already-stored revision). */
  op: RowOp;
  /** Set by the annotations hook when it redirected the row (W3). */
  redirected?: boolean;
  /** The layer the row actually landed on (redirects only). */
  redirected_to_layer_id?: string;
  /** Why: the requested layer was locked, or its write_policy was not met. */
  redirect_reason?: "locked" | "policy";
}
export interface RejectedRow {
  table: string;
  id: string | null;
  reason: RejectionReason;
  detail?: string;
}
export interface FileResult {
  file_id: string;
  upload_status: "pending" | "uploaded" | "verified" | "unknown";
  /** Present only while upload_status = 'pending'. */
  put_url?: string;
}
export interface PushResult {
  accepted: AcceptedRow[];
  rejected: RejectedRow[];
  files: FileResult[];
  /** Template layers the server minted for drawings created in this batch (W3). */
  created_layers: CreatedLayer[];
  /** W5: raster_status of every drawing_version whose pages were in this batch (after the refresh). */
  raster_status?: RasterRefresh[];
}

export class PushBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushBodyError";
  }
}

export interface PushOptions {
  /** Builds the PUT url for a file row still 'pending' (see sync/files.ts). */
  putUrlFor: (fileId: string) => string;
  /**
   * W5b: office adoption of a held sync_rejection (PATCH /sync/rejections/:id {resolution:'adopted'}).
   * The acting member is office/admin re-applying a row on another member's behalf, so the
   * own-row rule (update/tombstone only by created_by) is waived for this batch. NOTHING else
   * is: shape, parent-exists, draft-walk, class and checkout rules all still apply.
   */
  adopt?: boolean;
}

//------------------------------------------------------------------------------
// Entry
//------------------------------------------------------------------------------

const JSON_COLUMNS = new Set(["custom", "polygon", "metadata", "geometry", "style"]);
const MAX_ROWS = 500;

/** Validate the envelope (throws PushBodyError → 400). */
export function parsePushBody(input: unknown): PushBody {
  if (!input || typeof input !== "object") throw new PushBodyError("body must be a JSON object");
  const b = input as Record<string, unknown>;
  if (typeof b.device_id !== "string" || !b.device_id.trim()) throw new PushBodyError("device_id is required");
  if (b.walk_id != null && !isUuid(b.walk_id)) throw new PushBodyError("walk_id must be a UUID");
  if (!Array.isArray(b.rows)) throw new PushBodyError("rows must be an array");
  if (b.rows.length > MAX_ROWS) throw new PushBodyError(`rows: at most ${MAX_ROWS} per push`);
  for (const r of b.rows) {
    if (!r || typeof r !== "object" || typeof (r as PushRowInput).table !== "string" || !(r as PushRowInput).row || typeof (r as PushRowInput).row !== "object") {
      throw new PushBodyError("each rows[] entry must be {table: string, row: object}");
    }
  }
  const files: PushFileInput[] = [];
  if (b.files != null) {
    if (!Array.isArray(b.files)) throw new PushBodyError("files must be an array");
    for (const f of b.files) {
      if (!f || typeof f !== "object" || !isUuid((f as PushFileInput).file_id)) throw new PushBodyError("each files[] entry must be {file_id: uuid, sha256?}");
      files.push({ file_id: (f as PushFileInput).file_id.toLowerCase(), sha256: (f as PushFileInput).sha256 ?? null });
    }
  }
  return { walk_id: (b.walk_id as string | undefined)?.toLowerCase() ?? null, device_id: b.device_id.trim(), rows: b.rows as PushRowInput[], files };
}

/** Push one batch for the resolved Organization context. ONE transaction. */
export async function pushBatch(ctx: OrganizationContext, body: PushBody, opts: PushOptions): Promise<PushResult> {
  return withOrg(ctx, (tx) => pushBatchInTx(tx, ctx, body, opts));
}

/** W5b: the batch body on an already-open Organization transaction (office adoption runs it inside its own). */
export async function pushBatchInTx(tx: Tx, ctx: OrganizationContext, body: PushBody, opts: PushOptions): Promise<PushResult> {
  {
    const result: PushResult = { accepted: [], rejected: [], files: [], created_layers: [] };
    for (const entry of body.rows) {
      const outcome = await pushOneRow(tx, ctx, body, entry, !!opts.adopt);
      if (outcome.kind === "accepted") result.accepted.push(outcome.row);
      else result.rejected.push(outcome.row);
    }
    // W3: a drawing never exists without its template layers — mint what the device did not pre-mint.
    for (const a of result.accepted) {
      if (a.table === "drawings.drawings" && a.op === "created") {
        result.created_layers.push(...(await ensureTemplateLayers(tx, ctx, a.id, body.device_id)));
      }
    }
    // W5: pages pushed offline flip raster_status exactly like POST /pages does (spec §5.6).
    const versionIds = new Set<string>();
    for (const entry of body.rows) {
      if (entry.table === "drawings.pages" && isUuid(entry.row.drawing_version_id) && result.accepted.some((a) => a.table === "drawings.pages" && a.id === String(entry.row.id).toLowerCase())) {
        versionIds.add((entry.row.drawing_version_id as string).toLowerCase());
      }
    }
    if (versionIds.size) {
      result.raster_status = [];
      for (const vid of versionIds) result.raster_status.push(await refreshRasterStatus(tx, ctx, vid));
    }
    result.files = await answerFiles(tx, ctx, body.files ?? [], opts.putUrlFor);
    return result;
  }
}

//------------------------------------------------------------------------------
// One row
//------------------------------------------------------------------------------

type Outcome = { kind: "accepted"; row: AcceptedRow } | { kind: "rejected"; row: RejectedRow };

interface Decision {
  kind: "accepted" | "rejected";
  accepted?: AcceptedRow;
  reason?: RejectionReason;
  detail?: string;
  /** Verified-to-exist ids for the rejection row's FKs. */
  projectId?: string | null;
  walkId?: string | null;
}

async function pushOneRow(tx: Tx, ctx: OrganizationContext, body: PushBody, entry: PushRowInput, adopt = false): Promise<Outcome> {
  const table = entry.table;
  const rawId = entry.row.id;
  const id = isUuid(rawId) ? (rawId as string).toLowerCase() : null;

  const reject = async (reason: RejectionReason, detail?: string, projectId: string | null = null, walkId: string | null = null): Promise<Outcome> => {
    if (id) {
      await tx`
        insert into places.sync_rejections (organization_id, project_id, walk_id, ref_table, ref_id, device_id, actor, proposed, reason, detail)
        values (${ctx.organizationId}, ${projectId}, ${walkId}, ${table}, ${id}, ${body.device_id}, ${ctx.actorId},
                ${tx.json(entry.row as never)}, ${reason}, ${detail ?? null})`;
    }
    return { kind: "rejected", row: { table, id, reason, ...(detail ? { detail } : {}) } };
  };

  if (!isSyncTable(table)) return reject("schema", "table is not in the sync allow-list");
  if (!id) return reject("schema", "row.id must be a UUID");

  // Revoked member: TAKE the rows, hold them for admin adoption (Craig 2026-09-26). Never apply.
  if (ctx.revoked) return reject("actor_revoked", "member is inactive; held for admin adoption", null, body.walk_id ?? null);

  let decision: Decision;
  try {
    decision = await tx.savepoint((sp) => processRow(sp, ctx, body, table, { ...entry.row, id }, adopt));
  } catch (e) {
    const mapped = mapPgError(e);
    if (!mapped) throw e; // 42501 (RLS/privilege) and unknown errors fail the whole batch — fail closed
    return reject(mapped.reason, mapped.detail, null, null);
  }
  if (decision.kind === "accepted") return { kind: "accepted", row: decision.accepted! };
  return reject(decision.reason!, decision.detail, decision.projectId ?? null, decision.walkId ?? null);
}

interface StructureState {
  working_revision: number;
  published_revision: number;
  checkout_user_id: string | null;
  checkout_expires_at: Date | null;
}

async function processRow(sp: Tx, ctx: OrganizationContext, body: PushBody, table: SyncTable, incoming: JsonRow, adopt = false): Promise<Decision> {
  const spec = TABLE_SPECS[table];
  const id = incoming.id as string;
  const allowed = new Set<string>(["id", ...SYNC_SET_COLUMNS, ...spec.columns]);
  // Unknown keys are ignored (forward-compatible devices); server-owned columns can never be set from a payload.
  const row: JsonRow = {};
  for (const [k, v] of Object.entries(incoming)) if (allowed.has(k) && v !== undefined) row[k] = v;

  // --- shape: the sync set --------------------------------------------------------
  if (row.organization_id !== ctx.organizationId) {
    return { kind: "rejected", reason: "schema", detail: "org_mismatch: row.organization_id must equal the request organization" };
  }
  const revision = Number(row.revision);
  if (!Number.isInteger(revision) || revision < 1) return { kind: "rejected", reason: "schema", detail: "revision must be an integer >= 1" };
  row.revision = revision;
  if (!isTimestamp(row.occurred_at)) return { kind: "rejected", reason: "schema", detail: "occurred_at is required (ISO-8601)" };
  if (row.deleted_at != null && !isTimestamp(row.deleted_at)) return { kind: "rejected", reason: "schema", detail: "deleted_at must be ISO-8601" };
  if (row.created_by != null && !isUuid(row.created_by)) return { kind: "rejected", reason: "schema", detail: "created_by must be a UUID" };
  if (row.captured_revision != null && !Number.isInteger(Number(row.captured_revision))) {
    return { kind: "rejected", reason: "schema", detail: "captured_revision must be an integer" };
  }
  row.device_id = row.device_id ?? body.device_id;
  if (row.walk_id == null && body.walk_id && table !== "places.walks") row.walk_id = body.walk_id;

  // --- existing row (RLS-scoped; organization filter explicit too) ----------------
  const existing = await readExisting(sp, table, id, ctx.organizationId);
  if (!existing) {
    if (row.created_by == null) return { kind: "rejected", reason: "schema", detail: "created_by is required" };
    if ((row.created_by as string).toLowerCase() !== ctx.actorId) {
      return { kind: "rejected", reason: "not_row_owner", detail: "created_by must be the acting member for a new row" };
    }
  } else {
    row.created_by = existing.created_by; // a device can never re-author a row
    // W2: a walk's project anchor is set ONCE — by the device on first push (attached from the
    // start) or by POST /walks/:id/attach (room_hint resolution + room_hint_pending rows). A push
    // may never attach, re-attach or detach an existing walk. 'schema' is the closest 036 reason.
    if (table === "places.walks" && Object.prototype.hasOwnProperty.call(row, "project_id")) {
      const incomingProject = isUuid(row.project_id) ? (row.project_id as string).toLowerCase() : null;
      if (incomingProject !== ((existing.project_id as string | null) ?? null)) {
        return {
          kind: "rejected", reason: "schema",
          detail: existing.project_id == null
            ? "walks.project_id cannot be set by push; use POST /walks/:id/attach"
            : "walks.project_id is immutable once attached (pull the attached walk; detach is not a push)",
          projectId: (existing.project_id as string | null) ?? null,
        };
      }
    }
  }

  // --- parent-exists -----------------------------------------------------------------
  const verified = new Map<string, boolean>();
  for (const [col, target] of Object.entries(PARENT_TARGETS)) {
    if (!allowed.has(col) || row[col] == null) continue;
    if (!isUuid(row[col])) return { kind: "rejected", reason: "schema", detail: `${col} must be a UUID` };
    const ok = await parentExists(sp, target, row[col] as string, ctx.organizationId);
    verified.set(col, ok);
    if (!ok) return { kind: "rejected", reason: "unknown_parent", detail: `${col} → ${target} not found in this organization`, ...safeRefs(row, verified) };
  }

  // --- draft-walk rule (walk spec §5.6): under an unattached walk, hints only --------
  if (table !== "places.walks" && row.walk_id != null) {
    const walk = await sp<{ project_id: string | null }[]>`
      select project_id from places.walks where id = ${row.walk_id as string} and organization_id = ${ctx.organizationId}`;
    if (walk[0] && walk[0].project_id === null) {
      const bound = ["room_id", "location_id", "project_id"].filter((c) => allowed.has(c) && row[c] != null);
      if (bound.length) {
        return { kind: "rejected", reason: "schema", detail: `draft walk: ${bound.join(", ")} must be NULL (use room_hint / location_hint)`, ...safeRefs(row, verified) };
      }
    }
  }

  // --- project (the spine) --------------------------------------------------------------
  const merged: JsonRow = { ...(existing ?? {}), ...row };
  const projectId = await resolveProjectId(sp, table, merged, ctx.organizationId);
  const tombstoning = row.deleted_at != null && (!existing || existing.deleted_at == null);
  const state = projectId ? await readStructureState(sp, projectId, ctx.organizationId) : null;

  // --- per-table hook (W3: sync/layers.ts) — may redirect / amend the row and decide its class -----
  let finalRow = row;
  let hookExtra: JsonRow = {};
  let hookClass: RowClass | undefined;
  let hookDrawingId: string | null | undefined;
  let redirected = false;
  let redirectedTo: string | undefined;
  let redirectReason: "locked" | "policy" | undefined;
  if (spec.rules) {
    const hooked = await spec.rules({ tx: sp, table, row, existing, actorId: ctx.actorId, role: ctx.role, isAdmin: ctx.isAdmin, projectId });
    if (hooked.kind === "reject") return { kind: "rejected", reason: hooked.reason, detail: hooked.detail, projectId, walkId: walkRef(row, verified) };
    finalRow = hooked.row;
    hookExtra = hooked.extra ?? {};
    hookClass = hooked.rowClass;
    hookDrawingId = hooked.drawingId;
    redirected = !!hooked.redirected;
    redirectedTo = hooked.redirectedTo;
    redirectReason = hooked.redirectReason;
  }

  // --- class ---------------------------------------------------------------------------
  const rowClass: RowClass = hookClass ?? spec.classify({ ...merged, ...finalRow });

  // --- rules ---------------------------------------------------------------------------
  if (rowClass === "structure" && projectId) {
    if (!state) return { kind: "rejected", reason: "no_checkout", detail: "project has no structure_state", projectId, walkId: walkRef(row, verified) };
    if (state.checkout_user_id !== ctx.actorId) {
      return { kind: "rejected", reason: "no_checkout", detail: "actor does not hold the structure checkout", projectId, walkId: walkRef(row, verified) };
    }
    if (!state.checkout_expires_at || state.checkout_expires_at.getTime() <= Date.now()) {
      return { kind: "rejected", reason: "checkout_expired", detail: "structure checkout has expired", projectId, walkId: walkRef(row, verified) };
    }
  } else if (existing) {
    // capture rows, and unattached structure rows: own-row update/tombstone only (admin may tombstone any;
    // W5b: an office adoption of a held rejection re-applies on the creator's behalf — the only waiver)
    const own = existing.created_by === ctx.actorId;
    if (!own && !(tombstoning && ctx.isAdmin) && !adopt) {
      return { kind: "rejected", reason: "not_row_owner", detail: "only the row's creator may update or tombstone it", projectId, walkId: walkRef(row, verified) };
    }
  }

  // --- server stamps + table specifics ------------------------------------------------
  if (row.deleted_at != null) row.deleted_by = isUuid(row.deleted_by) ? (row.deleted_by as string).toLowerCase() : ctx.actorId;
  else delete row.deleted_by;
  const extra: JsonRow = {}; // server-owned columns written alongside the device's
  if (table === "shared.files") {
    extra.storage_key = `${ctx.organizationId}/${id}`;
    extra.upload_status = existing ? existing.upload_status : "pending";
  }
  if (table === "places.walks" && merged.project_id != null) {
    if (row.status == null && !existing) row.status = "attached";
    if (!existing || existing.project_id == null) { extra.attached_at = new Date(); extra.attached_by = ctx.actorId; }
  }
  if (table === "drawings.drawings" && (merged.project_id != null || merged.account_id != null)) {
    if (!existing || (existing.project_id == null && existing.account_id == null)) { extra.attached_at = new Date(); extra.attached_by = ctx.actorId; }
  }
  // deleted_by / server stamps apply to the hook's row too (the hook never touches the sync set)
  if (finalRow !== row) {
    if (row.deleted_by !== undefined) finalRow.deleted_by = row.deleted_by; else delete finalRow.deleted_by;
    if (row.status !== undefined) finalRow.status = row.status;
  }

  // --- upsert ---------------------------------------------------------------------------
  const changed = await upsert(sp, table, { ...finalRow, ...hookExtra, ...extra });
  if (!changed) {
    const after = await readExisting(sp, table, id, ctx.organizationId);
    if (!after) {
      // The id exists but RLS hides it: it belongs to another Organization. Never touch it.
      return { kind: "rejected", reason: "schema", detail: "id collides with a row outside this organization", projectId, walkId: walkRef(row, verified) };
    }
    if (after.revision === revision) {
      // Idempotent replay: identical revision already stored. Heal a missing event, write nothing else.
      await appendSyncEvent(sp, ctx, table, finalRow, projectId, "noop", rowClass);
      await runRules(sp, ctx, table, { ...after, ...finalRow }, projectId, "updated", rowClass);
      return { kind: "accepted", accepted: { table, id, revision, op: "noop", ...redirectFields(redirected, redirectedTo, redirectReason) } };
    }
    if (after.deleted_at != null && finalRow.deleted_at == null && revision > Number(after.revision)) {
      return { kind: "rejected", reason: "stale_tombstone", detail: `row is tombstoned at revision ${after.revision}`, projectId, walkId: walkRef(row, verified) };
    }
    return { kind: "rejected", reason: "stale_revision", detail: `stored revision ${after.revision} >= pushed ${revision}`, projectId, walkId: walkRef(row, verified) };
  }

  const op: RowOp = !existing ? "created" : tombstoning ? "tombstoned" : "updated";
  await appendSyncEvent(sp, ctx, table, finalRow, projectId, op, rowClass);
  // W2: Hybrid H field_rules — same transaction as the event (capture.flagged → field_flag, placement.as_walked → verify_placement).
  await runRules(sp, ctx, table, { ...merged, ...finalRow }, projectId, op, rowClass);

  // --- structure_changes (Gate A: materialized review rows) ---------------------------
  if (projectId && state) {
    const roomId = spec.room === "self" ? id : spec.room === "room_id" ? ((merged.room_id as string | null) ?? null) : null;
    const roomHint = (merged.room_hint as string | null) ?? null;
    const drawingId = hookDrawingId !== undefined ? hookDrawingId : isUuid(merged.drawing_id) ? (merged.drawing_id as string) : null;
    const walkId = walkRef(finalRow, verified);
    if (rowClass === "structure") {
      // W3: a structure-class annotation is its own review kind (spec §5.3 R-structure); the op rides in diff.
      const changeKind: ChangeKind = table === "drawings.annotations" ? "annotation" : (op as ChangeKind);
      await insertStructureChange(sp, ctx, {
        projectId, revision: state.working_revision, roomId, roomHint, drawingId, walkId, table, id,
        changeKind, diff: { op, before: existing ? pick(existing, spec.columns) : null, after: pick(finalRow, spec.columns) },
        occurredAt: finalRow.occurred_at as string,
      });
    } else if (merged.captured_revision != null && Number(merged.captured_revision) < state.published_revision) {
      await insertStructureChange(sp, ctx, {
        projectId, revision: state.working_revision, roomId, roomHint, drawingId, walkId, table, id,
        changeKind: "stale_capture",
        diff: { captured_revision: Number(merged.captured_revision), published_revision: state.published_revision, op, summary: pick(finalRow, spec.columns) },
        occurredAt: finalRow.occurred_at as string,
      });
    }
  }

  return { kind: "accepted", accepted: { table, id, revision, op, ...redirectFields(redirected, redirectedTo, redirectReason) } };
}

function redirectFields(redirected: boolean, to: string | undefined, reason: "locked" | "policy" | undefined): Partial<AcceptedRow> {
  if (!redirected) return {};
  return { redirected: true, ...(to ? { redirected_to_layer_id: to } : {}), ...(reason ? { redirect_reason: reason } : {}) };
}

//------------------------------------------------------------------------------
// DB helpers (every statement filters organization_id explicitly; RLS is the backstop)
//------------------------------------------------------------------------------

async function readExisting(sp: Tx, table: SyncTable, id: string, org: string): Promise<JsonRow | null> {
  const rows = await sp<JsonRow[]>`select * from ${sp(table)} where id = ${id} and organization_id = ${org} limit 1`;
  return rows[0] ?? null;
}

async function parentExists(sp: Tx, target: string, id: string, org: string): Promise<boolean> {
  const rows = await sp<{ one: number }[]>`select 1 as one from ${sp(target)} where id = ${id} and organization_id = ${org} limit 1`;
  return rows.length === 1;
}

async function readStructureState(sp: Tx, projectId: string, org: string): Promise<StructureState | null> {
  const rows = await sp<StructureState[]>`
    select working_revision, published_revision, checkout_user_id, checkout_expires_at
      from places.structure_state where project_id = ${projectId} and organization_id = ${org}`;
  return rows[0] ?? null;
}

async function resolveProjectId(sp: Tx, table: SyncTable, merged: JsonRow, org: string): Promise<string | null> {
  const spec = TABLE_SPECS[table];
  if (spec.project === "column") return isUuid(merged.project_id) ? (merged.project_id as string).toLowerCase() : null;
  if (spec.project === "via_drawing" && isUuid(merged.drawing_id)) {
    const r = await sp<{ project_id: string | null }[]>`select project_id from drawings.drawings where id = ${merged.drawing_id as string} and organization_id = ${org}`;
    return r[0]?.project_id ?? null;
  }
  if (spec.project === "via_page" && isUuid(merged.page_id)) {
    const r = await sp<{ project_id: string | null }[]>`
      select d.project_id from drawings.pages p join drawings.drawings d on d.id = p.drawing_id
       where p.id = ${merged.page_id as string} and p.organization_id = ${org}`;
    return r[0]?.project_id ?? null;
  }
  return null;
}

/** INSERT … ON CONFLICT (id) DO UPDATE … WHERE revision wins AND the tombstone guard holds. True when a row was written. */
async function upsert(sp: Tx, table: SyncTable, row: JsonRow): Promise<boolean> {
  const cols = Object.keys(row);
  const values: JsonRow = {};
  for (const c of cols) values[c] = JSON_COLUMNS.has(c) && row[c] !== null && typeof row[c] === "object" ? sp.json(row[c] as never) : row[c];
  const setCols = cols.filter((c) => c !== "id" && c !== "created_by");
  // Column names come from the allow-list in tables.ts (never from the payload), so the fragment is safe.
  const setClause = setCols.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(", ");
  const rows = await sp<{ id: string }[]>`
    insert into ${sp(table)} ${sp(values)}
    on conflict (id) do update set ${sp.unsafe(setClause)}, received_at = now()
    where excluded.revision > ${sp(table)}.revision
      and (${sp(table)}.deleted_at is null or excluded.deleted_at is not null)
    returning id`;
  return rows.length === 1;
}

function quoteIdent(c: string): string {
  return '"' + c.replace(/"/g, '""') + '"';
}

async function appendSyncEvent(sp: Tx, ctx: OrganizationContext, table: SyncTable, row: JsonRow, projectId: string | null, op: RowOp, rowClass: RowClass): Promise<void> {
  const spec = TABLE_SPECS[table];
  const eventType = op === "noop" ? spec.eventType(row, "updated") : spec.eventType(row, op);
  const key = `${table}:${row.id as string}:${row.revision as number}`;
  await sp`
    insert into shared.events (organization_id, project_id, ref_table, ref_id, event_type, payload, actor, actor_type, device_id, idempotency_key, occurred_at)
    values (${ctx.organizationId}, ${projectId}, ${table}, ${row.id as string}, ${eventType},
            ${sp.json({ op: op === "noop" ? "updated" : op, class: rowClass, revision: row.revision, walk_id: row.walk_id ?? null } as never)},
            ${ctx.actorId}, 'member', ${(row.device_id as string | null) ?? null}, ${key}, ${row.occurred_at as string})
    on conflict (organization_id, idempotency_key) do nothing`;
}

/** Evaluate shared.field_rules for the event this row just produced. Idempotent (partial UNIQUE on action_items). */
async function runRules(sp: Tx, ctx: OrganizationContext, table: SyncTable, row: JsonRow, projectId: string | null, op: RowOp, _rowClass: RowClass): Promise<void> {
  const spec = TABLE_SPECS[table];
  const eventType = spec.eventType(row, op === "noop" ? "updated" : op);
  await evaluateRules(sp, {
    organizationId: ctx.organizationId,
    actorId: ctx.actorId,
    eventType,
    refTable: table,
    refId: row.id as string,
    row,
    projectId,
  });
}

interface StructureChangeInput {
  projectId: string;
  revision: number;
  roomId: string | null;
  roomHint: string | null;
  drawingId: string | null;
  walkId: string | null;
  table: SyncTable;
  id: string;
  changeKind: ChangeKind;
  diff: JsonRow;
  occurredAt: string;
}

async function insertStructureChange(sp: Tx, ctx: OrganizationContext, c: StructureChangeInput): Promise<void> {
  await sp`
    insert into places.structure_changes (organization_id, project_id, revision, room_id, room_hint, drawing_id, walk_id, ref_table, ref_id, change_kind, diff, actor, occurred_at)
    values (${ctx.organizationId}, ${c.projectId}, ${c.revision}, ${c.roomId}, ${c.roomHint}, ${c.drawingId}, ${c.walkId},
            ${c.table}, ${c.id}, ${c.changeKind}, ${sp.json(c.diff as never)}, ${ctx.actorId}, ${c.occurredAt})`;
}

async function answerFiles(tx: Tx, ctx: OrganizationContext, files: PushFileInput[], putUrlFor: (id: string) => string): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const f of files) {
    const rows = await tx<{ id: string; upload_status: FileResult["upload_status"]; sha256: string | null }[]>`
      select id, upload_status, sha256 from shared.files where id = ${f.file_id} and organization_id = ${ctx.organizationId} and deleted_at is null`;
    const row = rows[0];
    if (!row) { out.push({ file_id: f.file_id, upload_status: "unknown" }); continue; }
    if (f.sha256 && !row.sha256 && /^[0-9a-f]{64}$/i.test(f.sha256)) {
      await tx`update shared.files set sha256 = ${f.sha256.toLowerCase()} where id = ${f.file_id} and organization_id = ${ctx.organizationId} and sha256 is null`;
    }
    out.push(row.upload_status === "pending" ? { file_id: row.id, upload_status: "pending", put_url: putUrlFor(row.id) } : { file_id: row.id, upload_status: row.upload_status });
  }
  return out;
}

//------------------------------------------------------------------------------
// Small utilities
//------------------------------------------------------------------------------

function isTimestamp(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return typeof v === "string" && v.trim() !== "" && !Number.isNaN(Date.parse(v));
}

function pick(row: JsonRow, cols: readonly string[]): JsonRow {
  const out: JsonRow = {};
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

/** Only ids we have VERIFIED exist may be written into sync_rejections' FK columns. */
function safeRefs(row: JsonRow, verified: Map<string, boolean>): { projectId: string | null; walkId: string | null } {
  return {
    projectId: verified.get("project_id") ? (row.project_id as string) : null,
    walkId: walkRef(row, verified),
  };
}
function walkRef(row: JsonRow, verified: Map<string, boolean>): string | null {
  return verified.get("walk_id") ? (row.walk_id as string) : null;
}

/** Map a Postgres error raised inside a row's savepoint to a rejection; null = rethrow (fails the batch). */
function mapPgError(e: unknown): { reason: RejectionReason; detail: string } | null {
  const code = (e as { code?: string })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  const constraint = (e as { constraint_name?: string })?.constraint_name;
  switch (code) {
    case "23503": return { reason: "unknown_parent", detail: constraint ? `fk ${constraint}` : msg };
    case "23505": return { reason: "schema", detail: constraint ? `unique ${constraint}` : msg };
    case "23514": return { reason: "schema", detail: constraint ? `check ${constraint}` : msg };
    case "23502": return { reason: "schema", detail: msg };
    case "22P02": case "22007": case "22008": case "22003": case "42703": case "22023":
      return { reason: "schema", detail: msg };
    default: return null; // 42501 insufficient_privilege (RLS / missing context) and anything unexpected fail CLOSED
  }
}
