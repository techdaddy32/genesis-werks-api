//==============================================================================
// repo/visits.ts — scheduled visits on Postgres (P2).
//
//   POST   /work-orders/:id/visits                   → addVisit()
//   PATCH  /work-orders/:id/visits/:visitId          → updateVisit()
//   DELETE /work-orders/:id/visits/:visitId          → removeVisit()   (soft delete)
//   POST   /work-orders/:id/visits/:visitId/confirm  → confirmVisit()
//   (+ the first visit of POST /work-orders and the `schedule` patch of PATCH /work-orders/:id)
//
// A visit is a row; Google Calendar is a SIDE EFFECT gated by the tenant's
// calendar settings (wo-read.ts calendarContextTx: `calendar.default_address`
// set and `calendar.enabled` not false). With no calendar configured — the
// sandbox — visits are plain rows: eventId / htmlLink stay null and nothing
// leaves the database. When the calendar IS configured the Google event is
// created / patched / deleted exactly as the Zoho path did; a failed insert on
// WO create is reported as `scheduleError` (+ a visit.calendar_failed event).
// The Google event id lives in external_ids (system google_calendar_event).
//==============================================================================

import type { AccessCodes, AddVisitInput, Env, UpdateVisitInput, Visit, WorkOrder } from "../types";
import { isUuid, withTenant, type Tx } from "../db";
import { appendEvent } from "../events";
import * as cal from "../calendar";
import { postToCliq } from "../cliq";
import { getAppSettings, getAdminSettings } from "../settings";
import { formatDateTimeET } from "../time";
import { DEFAULT_TODO_STATUS } from "../config";
import { API_ACTOR, linkExternalId, tenantOf } from "./_shared";
import { calendarContextTx, loadWorkOrderTx, resolveWorkOrderId, type CalendarContext } from "./wo-read";
import { createTodoTx, updateTodoTx } from "./todos";

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/** Short WO number ("WO-2026-0028") off the composite ref; falls back to the whole string. */
function shortWo(full: string): string {
  return (String(full || "").match(/WO-\d{4}-\d+/i) || [full || ""])[0];
}

function formatAccessCodes(c: AccessCodes): string | null {
  const parts: string[] = [];
  if (c.gate_code) parts.push(`Gate: ${c.gate_code}`);
  if (c.community_gate) parts.push(`Community: ${c.community_gate}`);
  if (c.door_code) parts.push(`Door: ${c.door_code}`);
  return parts.length ? parts.join(" / ") : null;
}

/** The "open this WO" deep link: tenant_settings app.wo_url_template → env APP_WO_URL_TEMPLATE → <origin>/work-orders/{id}. */
async function woDetailLinkTx(tx: Tx, env: Env, id: string, woNumber: string): Promise<string> {
  const app = await getAppSettings(tx);
  const origin = String(app["app.origin"] ?? "").trim() || (env.APP_ORIGIN || "").split(",")[0].trim();
  const tmpl =
    String(app["app.wo_url_template"] ?? "").trim() ||
    (env.APP_WO_URL_TEMPLATE && env.APP_WO_URL_TEMPLATE.trim()) ||
    `${origin}/work-orders/{id}`;
  return tmpl.replace(/\{id\}/g, encodeURIComponent(id)).replace(/\{wo\}/g, encodeURIComponent(woNumber));
}

/** The configured scheduling confirmer (Cliq tag + confirm to-do assignee); default "Angie Hartman". */
async function schedulingConfirmerTx(tx: Tx): Promise<string> {
  const s = await getAdminSettings(tx);
  const raw = s["admin.scheduling_confirmer"] as unknown;
  const first = Array.isArray(raw) ? raw.find((n) => typeof n === "string" && n.trim()) : typeof raw === "string" ? raw : "";
  return (first ?? "").trim() || "Angie Hartman";
}

/** calendars.id for a wire calendar id (Google address) — the default when none/unknown; null when no calendar rows. */
async function calendarRowIdTx(tx: Tx, ctx: CalendarContext, requested: string | undefined): Promise<string | null> {
  const address = (requested ?? "").trim();
  if (address && address !== ctx.defaultCalendarId) {
    const rows = await tx<{ entity_id: string }[]>`
      select entity_id from public.external_ids
      where tenant_id = public.app_tenant_id() and entity = 'calendar' and system = 'google_calendar_calendar' and external_id = ${address}
      limit 1`;
    if (rows.length) return rows[0].entity_id;
  }
  if (ctx.defaultCalendarRowId && isUuid(ctx.defaultCalendarRowId)) return ctx.defaultCalendarRowId;
  const def = await tx<{ id: string }[]>`
    select id from public.calendars where tenant_id = public.app_tenant_id() and is_default and deleted_at is null limit 1`;
  return def.length ? def[0].id : null;
}

async function replaceAttendeesTx(tx: Tx, visitId: string, emails: string[]): Promise<void> {
  await tx`delete from public.visit_attendees where tenant_id = public.app_tenant_id() and visit_id = ${visitId}`;
  let position = 0;
  for (const email of emails) {
    const e = String(email ?? "").trim();
    if (!e) continue;
    await tx`
      insert into public.visit_attendees (tenant_id, visit_id, email, technician_id, position)
      values (public.app_tenant_id(), ${visitId}, ${e},
              (select u.id from public.users u where u.tenant_id = public.app_tenant_id() and lower(u.email) = lower(${e}) and u.deleted_at is null limit 1),
              ${position++})`;
  }
}

async function eventBodyTx(
  tx: Tx,
  env: Env,
  wo: WorkOrder,
  v: { start: string; end: string; attendees: string[] },
  tentative: boolean
): Promise<Record<string, unknown>> {
  return cal.buildEventBody({
    fullWoNumber: wo.workOrderNumber,
    client: wo.client,
    subject: wo.subject,
    siteAddress: wo.siteAddress,
    notes: wo.notes,
    accessCodesText: formatAccessCodes(wo.accessCodes),
    woLink: await woDetailLinkTx(tx, env, wo.id, wo.workOrderNumber),
    start: v.start,
    end: v.end,
    attendees: v.attendees,
    tentative,
  });
}

//------------------------------------------------------------------------------
// Transaction-level primitives
//------------------------------------------------------------------------------

export interface AddVisitResult {
  visitId: string;
  /** Set when the calendar insert failed and `tolerateCalendarFailure` was on (WO create). */
  calendarError: string | null;
}

/**
 * Insert a visit for an already-loaded WO. Calendar event first (when configured),
 * then the row; tentative + notifyConfirmer → Cliq ping + confirm to-do (best-effort).
 */
export async function addVisitTx(
  tx: Tx,
  env: Env,
  wo: WorkOrder,
  input: AddVisitInput,
  opts: { actor?: string; tolerateCalendarFailure?: boolean } = {}
): Promise<AddVisitResult> {
  const ctx = await calendarContextTx(tx, env);
  const pending = input.pending === true;
  const remote = input.remote === true;
  const attendees = (input.attendees ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  const calendarId = (input.calendarId ?? "").trim() || ctx.defaultCalendarId;

  let eventId: string | null = null;
  let htmlLink: string | null = null;
  let calendarError: string | null = null;
  if (ctx.enabled) {
    try {
      const ev = await cal.insertEvent(env, calendarId, await eventBodyTx(tx, env, wo, { start: input.start, end: input.end, attendees }, pending));
      eventId = ev.id;
      htmlLink = ev.htmlLink ?? null;
    } catch (e) {
      if (!opts.tolerateCalendarFailure) throw e;
      calendarError = e instanceof Error ? e.message : String(e);
    }
  }

  const calendarRowId = ctx.enabled ? await calendarRowIdTx(tx, ctx, input.calendarId) : null;
  const rows = await tx<{ id: string }[]>`
    insert into public.visits (tenant_id, work_order_id, starts_at, ends_at, label, calendar_id, html_link, confirmed, remote)
    values (public.app_tenant_id(), ${wo.id}, ${input.start}::timestamptz, ${input.end}::timestamptz, ${input.label ?? null},
            ${calendarRowId}, ${htmlLink}, ${!pending}, ${remote})
    returning id`;
  const visitId = rows[0].id;
  await replaceAttendeesTx(tx, visitId, attendees);
  if (eventId) await linkExternalId(tx, "visit", visitId, "google_calendar_event", eventId);

  // TENTATIVE + notifyConfirmer: Cliq ping + a "confirm this appointment" to-do (both best-effort).
  let confirmTodoId: string | null = null;
  if (pending && input.notifyConfirmer === true) {
    const confirmer = await schedulingConfirmerTx(tx);
    const whenLabel = input.start ? formatDateTimeET(input.start) : "unscheduled";
    const sw = shortWo(wo.workOrderNumber);
    await postToCliq(
      env.CLIQ_SCHEDULING_WEBHOOK,
      `TENTATIVE appointment needs confirmation\n@${confirmer}\n${wo.client} · ${sw} — ${wo.subject}\nWhen: ${whenLabel} (ET)\nConfirm it in the app to post it officially.`
    );
    const todo = await createTodoTx(tx, wo.id, {
      title: `Confirm appointment — ${whenLabel}`,
      status: DEFAULT_TODO_STATUS,
      priority: "high",
      assignee: confirmer,
      notes: `Tentative visit for ${wo.client} (${sw}). Confirm in the app to remove the TENTATIVE marker and post it officially.`,
    }, opts);
    confirmTodoId = todo.id;
    await tx`update public.visits set confirm_todo_id = ${confirmTodoId} where tenant_id = public.app_tenant_id() and id = ${visitId}`;
  }

  await appendEvent(tx, {
    entity: "visit",
    entityId: visitId,
    eventType: "visit.created",
    payload: { workOrderId: wo.id, start: input.start, end: input.end, attendees, label: input.label ?? null, calendarId, eventId, confirmed: !pending, remote, confirmTodoId },
    actor: opts.actor ?? API_ACTOR,
  });
  if (calendarError) {
    await appendEvent(tx, {
      entity: "visit",
      entityId: visitId,
      eventType: "visit.calendar_failed",
      payload: { workOrderId: wo.id, calendarId, error: calendarError },
      actor: opts.actor ?? API_ACTOR,
    });
  }
  return { visitId, calendarError };
}

/** Patch a visit (times / attendees / label / calendar / remote) + its Google event when configured. Null when unknown. */
export async function updateVisitTx(
  tx: Tx,
  env: Env,
  wo: WorkOrder,
  visitId: string,
  patch: UpdateVisitInput,
  opts: { actor?: string } = {}
): Promise<boolean> {
  const current = wo.visits.find((v) => v.id === visitId);
  if (!current) return false;
  const ctx = await calendarContextTx(tx, env);
  const start = patch.start ?? current.start;
  const end = patch.end ?? current.end;
  const attendees = (patch.attendees ?? current.attendees).map((s) => String(s ?? "").trim()).filter(Boolean);
  const label = patch.label !== undefined ? patch.label : current.label;
  const calendarId = (patch.calendarId ?? "").trim() || current.calendarId || ctx.defaultCalendarId;
  const remote = patch.remote !== undefined ? patch.remote === true : current.remote === true;

  let eventId = current.eventId;
  let htmlLink = current.htmlLink;
  if (ctx.enabled) {
    if (eventId) {
      const eventPatch: Record<string, unknown> = {};
      if (patch.start !== undefined) eventPatch.start = { dateTime: patch.start };
      if (patch.end !== undefined) eventPatch.end = { dateTime: patch.end };
      if (patch.attendees !== undefined) eventPatch.attendees = attendees.map((e) => ({ email: e }));
      if (Object.keys(eventPatch).length) {
        const ev = await cal.patchEvent(env, calendarId, eventId, eventPatch);
        htmlLink = ev.htmlLink ?? htmlLink;
      }
    } else if (start && end) {
      const ev = await cal.insertEvent(env, calendarId, await eventBodyTx(tx, env, wo, { start, end, attendees }, current.confirmed === false));
      eventId = ev.id;
      htmlLink = ev.htmlLink ?? null;
      await linkExternalId(tx, "visit", visitId, "google_calendar_event", eventId);
    }
  }
  const calendarRowId = ctx.enabled ? await calendarRowIdTx(tx, ctx, calendarId) : null;
  await tx`
    update public.visits set
      starts_at   = ${start}::timestamptz,
      ends_at     = ${end}::timestamptz,
      label       = ${label ?? null},
      calendar_id = coalesce(${calendarRowId}::uuid, calendar_id),
      html_link   = ${htmlLink ?? null},
      remote      = ${remote}
    where tenant_id = public.app_tenant_id() and id = ${visitId}`;
  if (patch.attendees !== undefined) await replaceAttendeesTx(tx, visitId, attendees);
  await appendEvent(tx, {
    entity: "visit",
    entityId: visitId,
    eventType: "visit.updated",
    payload: { workOrderId: wo.id, patch, eventId },
    actor: opts.actor ?? API_ACTOR,
  });
  return true;
}

/** Soft-delete a visit (+ delete its Google event when configured). False when the visit is unknown. */
export async function removeVisitTx(tx: Tx, env: Env, wo: WorkOrder, visitId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const target = wo.visits.find((v) => v.id === visitId);
  if (!target) return false;
  const ctx = await calendarContextTx(tx, env);
  if (ctx.enabled && target.eventId) await cal.deleteEvent(env, target.calendarId, target.eventId);
  await tx`update public.visits set deleted_at = now() where tenant_id = public.app_tenant_id() and id = ${visitId}`;
  await appendEvent(tx, {
    entity: "visit",
    entityId: visitId,
    eventType: "visit.deleted",
    payload: { workOrderId: wo.id, visit: target },
    actor: opts.actor ?? API_ACTOR,
  });
  return true;
}

/** Promote a TENTATIVE visit to confirmed; resolve its confirm to-do; strip the marker from the Google event. */
export async function confirmVisitTx(tx: Tx, env: Env, wo: WorkOrder, visitId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const current = wo.visits.find((v) => v.id === visitId);
  if (!current) return false;
  const ctx = await calendarContextTx(tx, env);
  if (ctx.enabled && current.eventId && current.start && current.end) {
    try {
      const b = (await eventBodyTx(tx, env, wo, { start: current.start, end: current.end, attendees: current.attendees }, false)) as {
        summary?: string;
        description?: string;
      };
      await cal.patchEvent(env, current.calendarId, current.eventId, { summary: b.summary, description: b.description ?? "" });
    } catch (e) {
      console.warn("confirmVisit: event summary/description patch failed (non-fatal):", e);
    }
  }
  if (current.confirmTodoId) {
    await updateTodoTx(tx, wo.id, current.confirmTodoId, { status: "Completed" }, opts);
  }
  await tx`update public.visits set confirmed = true where tenant_id = public.app_tenant_id() and id = ${visitId}`;
  await appendEvent(tx, {
    entity: "visit",
    entityId: visitId,
    eventType: "visit.confirmed",
    payload: { workOrderId: wo.id, confirmTodoId: current.confirmTodoId ?? null },
    actor: opts.actor ?? API_ACTOR,
  });
  return true;
}

/** Delete every Google event of a WO's visits (best-effort; used by DELETE /work-orders/:id). */
export async function deleteCalendarEventsTx(tx: Tx, env: Env, visits: Visit[]): Promise<void> {
  const ctx = await calendarContextTx(tx, env);
  if (!ctx.enabled) return;
  for (const v of visits) {
    if (!v.eventId) continue;
    try {
      await cal.deleteEvent(env, v.calendarId, v.eventId);
    } catch (e) {
      console.warn(`deleteWorkOrder: calendar event ${v.eventId} not removed:`, e);
    }
  }
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts. Each returns the refreshed WorkOrder
// (null when the WO / visit is unknown), like the Zoho handlers.
//------------------------------------------------------------------------------

async function withWo<T>(env: Env, woWireId: string, fn: (tx: Tx, wo: WorkOrder) => Promise<T | null>): Promise<T | null> {
  return withTenant(env, tenantOf(env), async (tx) => {
    const id = await resolveWorkOrderId(tx, woWireId);
    const wo = id ? await loadWorkOrderTx(tx, env, id) : null;
    if (!wo) return null;
    return fn(tx, wo);
  });
}

export async function addVisit(env: Env, woWireId: string, input: AddVisitInput): Promise<WorkOrder | null> {
  return withWo(env, woWireId, async (tx, wo) => {
    await addVisitTx(tx, env, wo, input);
    return loadWorkOrderTx(tx, env, wo.id);
  });
}

export async function updateVisit(env: Env, woWireId: string, visitId: string, patch: UpdateVisitInput): Promise<WorkOrder | null> {
  return withWo(env, woWireId, async (tx, wo) => {
    if (!(await updateVisitTx(tx, env, wo, visitId, patch))) return null;
    return loadWorkOrderTx(tx, env, wo.id);
  });
}

export async function removeVisit(env: Env, woWireId: string, visitId: string): Promise<WorkOrder | null> {
  return withWo(env, woWireId, async (tx, wo) => {
    if (!(await removeVisitTx(tx, env, wo, visitId))) return null;
    return loadWorkOrderTx(tx, env, wo.id);
  });
}

export async function confirmVisit(env: Env, woWireId: string, visitId: string): Promise<WorkOrder | null> {
  return withWo(env, woWireId, async (tx, wo) => {
    if (!(await confirmVisitTx(tx, env, wo, visitId))) return null;
    return loadWorkOrderTx(tx, env, wo.id);
  });
}
