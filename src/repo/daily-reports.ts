//==============================================================================
// repo/daily-reports.ts — daily-report days / entries / sent state / PDFs on
// Postgres (F3).
//
// Replaces four KV key families:
//   dailyreport:<id>:<date>        {entries:[{tech,text,at}]}  → daily_report_entries
//   dailyreport-days:<id>          {days:[...]}                → daily_reports rows
//   dailyreport-sent:<id>:<date>   {sent,at,pdfUrl,woNumber}   → daily_reports.sent_at
//   dailyreport-pdf:<id>:<date>    base64 PDF                  → files (bytes) + pdf_file_id
// `<date>` is YYYY-MM-DD (ET) or the literal "cumulative" (= the report_date NULL row).
//
// Wire shapes are unchanged: DailyReportDay {date, entries, sent, pdfUrl},
// DailyReportEntry {tech, text, at}, days list [{date, entries:<count>, sent, pdfUrl}].
// pdfUrl is DERIVED (env.PUBLIC_WORKER_URL + the /:date/pdf route) instead of
// being frozen into the sent marker — same value whenever the var is set.
//
// Entries are addressed by index → gap-free `position` per day (re-packed on delete).
//==============================================================================

import type { DailyReportDay, DailyReportEntry, Env } from "../types";
import { withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { todayET } from "../time";
import { API_ACTOR, ensureWorkOrderRef, findWorkOrderRef, iso, tenantOf, workOrderPublicKey, type WoRef } from "./_shared";

export const CUMULATIVE = "cumulative";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Bad `date` input (not YYYY-MM-DD / "cumulative"). Mapped to 400 by the router. */
export class DailyReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyReportError";
  }
}

export interface DayEntries {
  date: string;
  entries: DailyReportEntry[];
}

export interface DayListItem {
  date: string;
  entries: number;
  sent: boolean;
  pdfUrl: string | null;
}

function assertDateKey(date: string): void {
  if (date !== CUMULATIVE && !DATE_RE.test(date)) throw new DailyReportError(`date must be YYYY-MM-DD (got '${date}')`);
}

/** The Worker-served PDF link for a sent day (null until PUBLIC_WORKER_URL is set). */
export function pdfUrlFor(env: Pick<Env, "PUBLIC_WORKER_URL">, actionTaskId: string, dateKey: string): string | null {
  const base = (env.PUBLIC_WORKER_URL || "").trim();
  return base ? `${base}/work-orders/${encodeURIComponent(actionTaskId)}/daily-report/${dateKey}/pdf` : null;
}

interface EntryRow {
  id: string;
  position: number;
  tech: string | null;
  text: string;
  noted_at: Date;
}
interface ReportRow {
  id: string;
  date_key: string;
  entry_count: number;
  sent: boolean;
  pdf_file_id: string | null;
}

function toEntry(r: EntryRow): DailyReportEntry {
  return { tech: r.tech ?? null, text: r.text, at: iso(r.noted_at) ?? "" };
}

//------------------------------------------------------------------------------
// Row access
//------------------------------------------------------------------------------

async function reportRow(tx: Tx, workOrderId: string, dateKey: string): Promise<ReportRow | null> {
  const rows =
    dateKey === CUMULATIVE
      ? await tx<ReportRow[]>`
          select daily_report_id as id, date_key, entry_count, sent, pdf_file_id from public.v_daily_report_days
          where tenant_id = public.app_tenant_id() and work_order_id = ${workOrderId} and report_date is null limit 1`
      : await tx<ReportRow[]>`
          select daily_report_id as id, date_key, entry_count, sent, pdf_file_id from public.v_daily_report_days
          where tenant_id = public.app_tenant_id() and work_order_id = ${workOrderId} and report_date = ${dateKey}::date limit 1`;
  return rows.length ? rows[0] : null;
}

async function ensureReportRow(tx: Tx, workOrderId: string, dateKey: string): Promise<string> {
  const found = await reportRow(tx, workOrderId, dateKey);
  if (found) return found.id;
  const rows = await tx<{ id: string }[]>`
    insert into public.daily_reports (tenant_id, work_order_id, report_date)
    values (public.app_tenant_id(), ${workOrderId}, ${dateKey === CUMULATIVE ? null : dateKey}::date)
    returning id`;
  return rows[0].id;
}

async function entryRows(tx: Tx, reportId: string): Promise<EntryRow[]> {
  return tx<EntryRow[]>`
    select id, position, tech, text, noted_at from public.daily_report_entries
    where tenant_id = public.app_tenant_id() and daily_report_id = ${reportId} and deleted_at is null
    order by position asc`;
}

//------------------------------------------------------------------------------
// Transaction-level primitives (shared with scripts/import-kv.ts)
//------------------------------------------------------------------------------

/** A day's entries (empty when the WO / day is unknown). */
export async function readEntriesTx(tx: Tx, actionTaskId: string, dateKey: string): Promise<DailyReportEntry[]> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return [];
  const rep = await reportRow(tx, woId, dateKey);
  if (!rep) return [];
  return (await entryRows(tx, rep.id)).map(toEntry);
}

export async function getDailyReportTx(tx: Tx, env: Pick<Env, "PUBLIC_WORKER_URL">, actionTaskId: string, dateKey: string): Promise<DailyReportDay> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  const rep = woId ? await reportRow(tx, woId, dateKey) : null;
  const entries = rep ? (await entryRows(tx, rep.id)).map(toEntry) : [];
  const sent = !!rep?.sent;
  return { date: dateKey, entries, sent, pdfUrl: sent ? pdfUrlFor(env, actionTaskId, dateKey) : null };
}

/** Dated days (never the cumulative pseudo-day), ascending — the old days index. */
export async function listDaysTx(tx: Tx, actionTaskId: string): Promise<string[]> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return [];
  const rows = await tx<{ date_key: string }[]>`
    select date_key from public.v_daily_report_days
    where tenant_id = public.app_tenant_id() and work_order_id = ${woId} and report_date is not null
    order by report_date asc`;
  return rows.map((r) => r.date_key);
}

/** GET …/daily-report/days rows in ONE query. */
export async function listDaysEnrichedTx(tx: Tx, env: Pick<Env, "PUBLIC_WORKER_URL">, actionTaskId: string): Promise<DayListItem[]> {
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return [];
  const rows = await tx<ReportRow[]>`
    select daily_report_id as id, date_key, entry_count, sent, pdf_file_id from public.v_daily_report_days
    where tenant_id = public.app_tenant_id() and work_order_id = ${woId} and report_date is not null
    order by report_date asc`;
  return rows.map((r) => ({
    date: r.date_key,
    entries: Number(r.entry_count),
    sent: !!r.sent,
    pdfUrl: r.sent ? pdfUrlFor(env, actionTaskId, r.date_key) : null,
  }));
}

/** Every dated day that has at least one entry, ascending, with its entries (cumulative report / invoice notes). */
export async function entriesByDayTx(tx: Tx, actionTaskId: string): Promise<DayEntries[]> {
  const days = await listDaysTx(tx, actionTaskId);
  const out: DayEntries[] = [];
  for (const d of days) {
    const entries = await readEntriesTx(tx, actionTaskId, d);
    if (entries.length) out.push({ date: d, entries });
  }
  return out;
}

/** Importer primitive: make sure the (WO, day) row exists (a day may have zero entries). */
export async function ensureDayTx(tx: Tx, ref: WoRef, dateKey: string): Promise<{ id: string; created: boolean }> {
  assertDateKey(dateKey);
  const woId = await ensureWorkOrderRef(tx, ref);
  const found = await reportRow(tx, woId, dateKey);
  if (found) return { id: found.id, created: false };
  return { id: await ensureReportRow(tx, woId, dateKey), created: true };
}

export async function addEntryTx(
  tx: Tx,
  ref: WoRef,
  input: { text: string; tech?: string | null; date?: string; at?: string | null },
  opts: { actor?: string; idempotencyKey?: string | null } = {}
): Promise<DayEntries> {
  const dateKey = input.date || todayET();
  assertDateKey(dateKey);
  const woId = await ensureWorkOrderRef(tx, ref);
  const repId = await ensureReportRow(tx, woId, dateKey);
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  const rows = await tx<{ id: string; position: number }[]>`
    insert into public.daily_report_entries (tenant_id, daily_report_id, position, tech, text, noted_at)
    values (public.app_tenant_id(), ${repId},
      coalesce((select max(position) + 1 from public.daily_report_entries
                where daily_report_id = ${repId} and deleted_at is null), 0),
      ${input.tech ?? null}, ${input.text}, ${at}::timestamptz)
    returning id, position`;
  await appendEvent(tx, {
    entity: "daily_report",
    entityId: repId,
    eventType: "daily_report.entry_added",
    payload: { workOrderId: woId, actionTaskId: ref.actionTaskId, date: dateKey, entryId: rows[0].id, position: rows[0].position, tech: input.tech ?? null, text: input.text, at },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return { date: dateKey, entries: (await entryRows(tx, repId)).map(toEntry) };
}

/** Importer primitive: entry at an exact position (upsert by (day, position)). */
export async function upsertEntryAtTx(
  tx: Tx,
  ref: WoRef,
  dateKey: string,
  position: number,
  input: { text: string; tech?: string | null; at?: string | null },
  opts: { actor?: string; idempotencyKey?: string | null } = {}
): Promise<{ id: string; created: boolean }> {
  assertDateKey(dateKey);
  const woId = await ensureWorkOrderRef(tx, ref);
  const repId = await ensureReportRow(tx, woId, dateKey);
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  const existing = await tx<{ id: string }[]>`
    select id from public.daily_report_entries
    where tenant_id = public.app_tenant_id() and daily_report_id = ${repId} and position = ${position} and deleted_at is null
    limit 1`;
  let id: string;
  let created = false;
  if (existing.length) {
    id = existing[0].id;
    await tx`update public.daily_report_entries set tech = ${input.tech ?? null}, text = ${input.text}, noted_at = ${at}::timestamptz
             where tenant_id = public.app_tenant_id() and id = ${id}`;
  } else {
    const rows = await tx<{ id: string }[]>`
      insert into public.daily_report_entries (tenant_id, daily_report_id, position, tech, text, noted_at)
      values (public.app_tenant_id(), ${repId}, ${position}, ${input.tech ?? null}, ${input.text}, ${at}::timestamptz)
      returning id`;
    id = rows[0].id;
    created = true;
  }
  await appendEvent(tx, {
    entity: "daily_report",
    entityId: repId,
    eventType: created ? "daily_report.entry_imported" : "daily_report.entry_import_updated",
    payload: { workOrderId: woId, actionTaskId: ref.actionTaskId, date: dateKey, entryId: id, position, tech: input.tech ?? null, text: input.text, at },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return { id, created };
}

export async function editEntryTx(
  tx: Tx,
  actionTaskId: string,
  index: number,
  text: string,
  date?: string,
  opts: { actor?: string } = {}
): Promise<DayEntries | null> {
  const dateKey = date || todayET();
  assertDateKey(dateKey);
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return null;
  const rep = await reportRow(tx, woId, dateKey);
  if (!rep) return null;
  const rows = await entryRows(tx, rep.id);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
  await tx`update public.daily_report_entries set text = ${text}
           where tenant_id = public.app_tenant_id() and id = ${rows[index].id}`;
  await appendEvent(tx, {
    entity: "daily_report",
    entityId: rep.id,
    eventType: "daily_report.entry_updated",
    payload: { workOrderId: woId, actionTaskId, date: dateKey, index, entryId: rows[index].id, text },
    actor: opts.actor ?? API_ACTOR,
  });
  return { date: dateKey, entries: (await entryRows(tx, rep.id)).map(toEntry) };
}

export async function deleteEntryTx(
  tx: Tx,
  actionTaskId: string,
  index: number,
  date?: string,
  opts: { actor?: string } = {}
): Promise<DayEntries | null> {
  const dateKey = date || todayET();
  assertDateKey(dateKey);
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return null;
  const rep = await reportRow(tx, woId, dateKey);
  if (!rep) return null;
  const rows = await entryRows(tx, rep.id);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null;
  const e = rows[index];
  await tx`delete from public.daily_report_entries where tenant_id = public.app_tenant_id() and id = ${e.id}`;
  await tx`update public.daily_report_entries set position = position - 1
           where tenant_id = public.app_tenant_id() and daily_report_id = ${rep.id} and deleted_at is null and position > ${e.position}`;
  await appendEvent(tx, {
    entity: "daily_report",
    entityId: rep.id,
    eventType: "daily_report.entry_deleted",
    payload: { workOrderId: woId, actionTaskId, date: dateKey, index, entry: toEntry(e) },
    actor: opts.actor ?? API_ACTOR,
  });
  return { date: dateKey, entries: (await entryRows(tx, rep.id)).map(toEntry) };
}

/** The stored PDF for a day (+ the WO number for the download filename). */
export async function getPdfTx(tx: Tx, actionTaskId: string, dateKey: string): Promise<{ bytes: Uint8Array; woNumber: string | null } | null> {
  if (dateKey !== CUMULATIVE && !DATE_RE.test(dateKey)) return null;
  const woId = await findWorkOrderRef(tx, actionTaskId);
  if (!woId) return null;
  const rep = await reportRow(tx, woId, dateKey);
  if (!rep?.pdf_file_id) return null;
  const files = await tx<{ bytes: Uint8Array | null }[]>`
    select bytes from public.files
    where tenant_id = public.app_tenant_id() and id = ${rep.pdf_file_id} and deleted_at is null
    limit 1`;
  if (!files.length || !files[0].bytes) return null;
  return { bytes: new Uint8Array(files[0].bytes), woNumber: await workOrderPublicKey(tx, woId) };
}

/**
 * Store the compiled PDF and mark the day sent (re-sending overwrites both; a prior
 * sent marker never blocks). `sentAt` lets the importer keep the legacy timestamp.
 */
export async function markSentTx(
  tx: Tx,
  ref: WoRef,
  dateKey: string,
  pdf: Uint8Array | null,
  opts: { sentAt?: string | null; pdfUrl?: string | null; actor?: string; idempotencyKey?: string | null } = {}
): Promise<void> {
  assertDateKey(dateKey);
  const woId = await ensureWorkOrderRef(tx, ref);
  const repId = await ensureReportRow(tx, woId, dateKey);
  const rep = await reportRow(tx, woId, dateKey);
  const sentAt = opts.sentAt && Number.isFinite(Date.parse(opts.sentAt)) ? new Date(opts.sentAt).toISOString() : new Date().toISOString();
  const label = ref.workOrderNumber || ref.actionTaskId;
  const filename = dateKey === CUMULATIVE ? `work-order-summary-${label}.pdf` : `daily-report-${label}-${dateKey}.pdf`;
  const kind = dateKey === CUMULATIVE ? "cumulative_pdf" : "daily_report_pdf";

  let fileId = rep?.pdf_file_id ?? null;
  if (pdf) {
    if (fileId) {
      await tx`update public.files set bytes = ${pdf}, byte_size = ${pdf.byteLength}, filename = ${filename}
               where tenant_id = public.app_tenant_id() and id = ${fileId}`;
    } else {
      const rows = await tx<{ id: string }[]>`
        insert into public.files (tenant_id, entity, entity_id, kind, filename, content_type, byte_size, bytes)
        values (public.app_tenant_id(), 'daily_report', ${repId}, ${kind}, ${filename}, 'application/pdf', ${pdf.byteLength}, ${pdf})
        returning id`;
      fileId = rows[0].id;
    }
  }
  await tx`update public.daily_reports set sent_at = ${sentAt}::timestamptz, pdf_file_id = ${fileId}
           where tenant_id = public.app_tenant_id() and id = ${repId}`;
  await appendEvent(tx, {
    entity: "daily_report",
    entityId: repId,
    eventType: "daily_report.sent",
    payload: { workOrderId: woId, actionTaskId: ref.actionTaskId, date: dateKey, sentAt, pdfUrl: opts.pdfUrl ?? null, fileId, bytes: pdf?.byteLength ?? null },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts / index.ts
//------------------------------------------------------------------------------

export async function getDailyReport(env: Env, actionTaskId: string, date?: string): Promise<DailyReportDay> {
  const dateKey = date || todayET();
  if (dateKey !== CUMULATIVE && !DATE_RE.test(dateKey)) return { date: dateKey, entries: [], sent: false, pdfUrl: null };
  return withTenantRead(env, tenantOf(env), (tx) => getDailyReportTx(tx, env, actionTaskId, dateKey));
}

export async function listDailyReportDays(env: Env, actionTaskId: string): Promise<{ days: string[] }> {
  const days = await withTenantRead(env, tenantOf(env), (tx) => listDaysTx(tx, actionTaskId));
  return { days };
}

export async function listDailyReportDaysEnriched(env: Env, actionTaskId: string): Promise<DayListItem[]> {
  return withTenantRead(env, tenantOf(env), (tx) => listDaysEnrichedTx(tx, env, actionTaskId));
}

export async function entriesByDay(env: Env, actionTaskId: string): Promise<DayEntries[]> {
  return withTenantRead(env, tenantOf(env), (tx) => entriesByDayTx(tx, actionTaskId));
}

export async function addEntry(env: Env, ref: WoRef, input: { text: string; tech?: string | null; date?: string }): Promise<DayEntries> {
  return withTenant(env, tenantOf(env), (tx) => addEntryTx(tx, ref, input));
}

export async function editEntry(env: Env, actionTaskId: string, index: number, text: string, date?: string): Promise<DayEntries | null> {
  return withTenant(env, tenantOf(env), (tx) => editEntryTx(tx, actionTaskId, index, text, date));
}

export async function deleteEntry(env: Env, actionTaskId: string, index: number, date?: string): Promise<DayEntries | null> {
  return withTenant(env, tenantOf(env), (tx) => deleteEntryTx(tx, actionTaskId, index, date));
}

export async function getPdf(env: Env, actionTaskId: string, date: string): Promise<{ bytes: Uint8Array; woNumber: string | null } | null> {
  return withTenantRead(env, tenantOf(env), (tx) => getPdfTx(tx, actionTaskId, date));
}

export async function markSent(env: Env, ref: WoRef, dateKey: string, pdf: Uint8Array, pdfUrl: string | null): Promise<void> {
  return withTenant(env, tenantOf(env), (tx) => markSentTx(tx, ref, dateKey, pdf, { pdfUrl }));
}
