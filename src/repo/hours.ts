//==============================================================================
// repo/hours.ts — the per-WO hours log on Postgres (F3).
//
// Replaces the `hours:<actionTaskId>` KV blob ({entries:[{tech,hours,at,note}],
// total}). Wire shape is unchanged: WorkOrder.hours = { total, entries[] } with
// entries ordered by position and `total` from v_work_order_hours
// (round(sum(hours), 2)).
//
// Routes address entries BY INDEX; `position` is kept gap-free per WO (0-based,
// re-packed after a delete) so index semantics survive (data-model §2.12).
//
// The WO itself still lives in Zoho in this row, so writes take a WoRef (what
// service.ts already has after getWorkOrder) and ensureWorkOrderRef() creates
// the shadow work_orders row on first write. Reads for a WO that has no row
// return { total: 0, entries: [] } exactly like a KV miss.
//==============================================================================

import type { Env, WorkOrder } from "../types";
import { withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { normalizeEntryDateToIso } from "../time";
import { API_ACTOR, ensureWorkOrderRef, findWorkOrderRef, iso, tenantOf, type WoRef } from "./_shared";

export type Hours = WorkOrder["hours"];
export type HoursEntry = Hours["entries"][number];

export interface HoursEntryInput {
  tech?: string | null;
  hours: number;
  /** ISO instant or YYYY-MM-DD (normalized to midnight ET); default now(). */
  at?: string | null;
  note?: string | null;
}

interface EntryRow {
  id: string;
  position: number;
  tech: string | null;
  hours: string | number;
  logged_at: Date;
  note: string | null;
}

const EMPTY: Hours = { total: 0, entries: [] };

function toEntry(r: EntryRow): HoursEntry {
  return { tech: r.tech ?? null, hours: Number(r.hours), at: iso(r.logged_at) ?? "", note: r.note ?? null };
}

//------------------------------------------------------------------------------
// Transaction-level primitives (shared with scripts/import-kv.ts)
//------------------------------------------------------------------------------

async function entryRows(tx: Tx, workOrderId: string): Promise<EntryRow[]> {
  return tx<EntryRow[]>`
    select id, position, tech, hours, logged_at, note
    from public.hours_entries
    where tenant_id = public.app_tenant_id() and work_order_id = ${workOrderId} and deleted_at is null
    order by position asc`;
}

/** { total, entries } for a work_orders row id. */
export async function hoursForWorkOrderTx(tx: Tx, workOrderId: string): Promise<Hours> {
  const [rows, totals] = await Promise.all([
    entryRows(tx, workOrderId),
    tx<{ total: string | number | null }[]>`
      select total from public.v_work_order_hours where work_order_id = ${workOrderId}`,
  ]);
  const total = totals.length && totals[0].total !== null ? Number(totals[0].total) : 0;
  return { total, entries: rows.map(toEntry) };
}

/** { total, entries } for a Zoho Action task id (empty when no row exists yet). */
export async function getHoursTx(tx: Tx, actionTaskId: string): Promise<Hours> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  return woId ? hoursForWorkOrderTx(tx, woId) : { ...EMPTY, entries: [] };
}

/** Append one entry at the next position. Returns the refreshed { total, entries }. */
export async function appendHoursEntryTx(
  tx: Tx,
  ref: WoRef,
  input: HoursEntryInput,
  opts: { actor?: string; idempotencyKey?: string | null } = {}
): Promise<Hours> {
  const woId = await ensureWorkOrderRef(tx, ref);
  const at = normalizeEntryDateToIso(input.at) ?? new Date().toISOString();
  const rows = await tx<{ id: string; position: number }[]>`
    insert into public.hours_entries (tenant_id, work_order_id, position, tech, hours, logged_at, note)
    values (public.app_tenant_id(), ${woId},
      coalesce((select max(position) + 1 from public.hours_entries
                where work_order_id = ${woId} and deleted_at is null), 0),
      ${input.tech ?? null}, ${input.hours}, ${at}::timestamptz, ${input.note ?? null})
    returning id, position`;
  await appendEvent(tx, {
    entity: "hours_entry",
    entityId: rows[0].id,
    eventType: "hours_entry.logged",
    payload: { workOrderId: woId, actionTaskId: ref.actionTaskId, position: rows[0].position, tech: input.tech ?? null, hours: input.hours, at, note: input.note ?? null },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return hoursForWorkOrderTx(tx, woId);
}

/**
 * Importer primitive: put an entry at an EXACT position (upsert by (wo, position)) so a
 * re-run updates in place instead of appending twice.
 */
export async function upsertHoursEntryAtTx(
  tx: Tx,
  ref: WoRef,
  position: number,
  input: HoursEntryInput,
  opts: { actor?: string; idempotencyKey?: string | null } = {}
): Promise<{ id: string; created: boolean }> {
  const woId = await ensureWorkOrderRef(tx, ref);
  const at = normalizeEntryDateToIso(input.at) ?? new Date().toISOString();
  const existing = await tx<{ id: string }[]>`
    select id from public.hours_entries
    where tenant_id = public.app_tenant_id() and work_order_id = ${woId} and position = ${position} and deleted_at is null
    limit 1`;
  let id: string;
  let created = false;
  if (existing.length) {
    id = existing[0].id;
    await tx`
      update public.hours_entries
      set tech = ${input.tech ?? null}, hours = ${input.hours}, logged_at = ${at}::timestamptz, note = ${input.note ?? null}
      where tenant_id = public.app_tenant_id() and id = ${id}`;
  } else {
    const rows = await tx<{ id: string }[]>`
      insert into public.hours_entries (tenant_id, work_order_id, position, tech, hours, logged_at, note)
      values (public.app_tenant_id(), ${woId}, ${position}, ${input.tech ?? null}, ${input.hours}, ${at}::timestamptz, ${input.note ?? null})
      returning id`;
    id = rows[0].id;
    created = true;
  }
  await appendEvent(tx, {
    entity: "hours_entry",
    entityId: id,
    eventType: created ? "hours_entry.imported" : "hours_entry.import_updated",
    payload: { workOrderId: woId, actionTaskId: ref.actionTaskId, position, tech: input.tech ?? null, hours: input.hours, at, note: input.note ?? null },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return { id, created };
}

/** Edit the entry at `index` (hours / note / tech). Null when the WO has no rows or the index is out of range. */
export async function editHoursEntryTx(
  tx: Tx,
  actionTaskId: string,
  index: number,
  patch: { hours?: number; note?: string | null; tech?: string | null },
  opts: { actor?: string } = {}
): Promise<Hours | null> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return null;
  const rows = await entryRows(tx, woId);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
  const e = rows[index];
  const next = {
    hours: patch.hours !== undefined ? patch.hours : Number(e.hours),
    note: patch.note !== undefined ? patch.note : e.note,
    tech: patch.tech !== undefined ? patch.tech : e.tech,
  };
  await tx`
    update public.hours_entries
    set hours = ${next.hours}, note = ${next.note ?? null}, tech = ${next.tech ?? null}
    where tenant_id = public.app_tenant_id() and id = ${e.id}`;
  await appendEvent(tx, {
    entity: "hours_entry",
    entityId: e.id,
    eventType: "hours_entry.updated",
    payload: { workOrderId: woId, actionTaskId, index, patch },
    actor: opts.actor ?? API_ACTOR,
  });
  return hoursForWorkOrderTx(tx, woId);
}

/**
 * Delete the entry at `index` and re-pack positions (gap-free). The row is removed
 * (its content is preserved on the events row) so positions stay dense.
 */
export async function deleteHoursEntryTx(
  tx: Tx,
  actionTaskId: string,
  index: number,
  opts: { actor?: string } = {}
): Promise<Hours | null> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return null;
  const rows = await entryRows(tx, woId);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
  const e = rows[index];
  await tx`delete from public.hours_entries where tenant_id = public.app_tenant_id() and id = ${e.id}`;
  // Re-pack: everything after the removed row shifts down one (unique index is DEFERRABLE).
  await tx`
    update public.hours_entries set position = position - 1
    where tenant_id = public.app_tenant_id() and work_order_id = ${woId} and deleted_at is null and position > ${e.position}`;
  await appendEvent(tx, {
    entity: "hours_entry",
    entityId: e.id,
    eventType: "hours_entry.deleted",
    payload: { workOrderId: woId, actionTaskId, index, entry: toEntry(e) },
    actor: opts.actor ?? API_ACTOR,
  });
  return hoursForWorkOrderTx(tx, woId);
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts
//------------------------------------------------------------------------------

/** Hours for a WO (empty when none logged). */
export async function getHours(env: Env, actionTaskId: string): Promise<Hours> {
  return withTenantRead(env, tenantOf(env), (tx) => getHoursTx(tx, actionTaskId));
}

export async function appendHoursEntry(env: Env, ref: WoRef, input: HoursEntryInput): Promise<Hours> {
  return withTenant(env, tenantOf(env), (tx) => appendHoursEntryTx(tx, ref, input));
}

export async function editHoursEntry(
  env: Env,
  actionTaskId: string,
  index: number,
  patch: { hours?: number; note?: string | null; tech?: string | null }
): Promise<Hours | null> {
  return withTenant(env, tenantOf(env), (tx) => editHoursEntryTx(tx, actionTaskId, index, patch));
}

export async function deleteHoursEntry(env: Env, actionTaskId: string, index: number): Promise<Hours | null> {
  return withTenant(env, tenantOf(env), (tx) => deleteHoursEntryTx(tx, actionTaskId, index));
}
