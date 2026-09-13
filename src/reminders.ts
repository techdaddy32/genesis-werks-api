//==============================================================================
// reminders.ts — reminders on action items (Zoho Issues) that fire a Cliq post.
//
// F3: moved from KV (`reminder:<issueId>`) to the `reminders` table (one per
// action item; fired = fired_at IS NOT NULL). Action items themselves are still
// Zoho Issues in this row, so each reminder hangs off a SHADOW action_items row
// keyed by the Zoho issue id in external_ids (repo/_shared.ts). The wire
// Reminder shape is unchanged; projectId / projectName / title / assigneeName are
// the request-time snapshot kept in reminders.custom.legacy_snapshot until P3a
// imports real action items and joins them instead (data-model §2.21).
//
// The Worker cron (every 10 min) calls fireDueReminders(): any reminder whose
// remindAt has passed and hasn't fired posts to Cliq, is marked fired, and logs
// an events row (reminder.fired). Best-effort — a Cliq hiccup never throws.
//==============================================================================

import type { Env } from "./types";
import { postToCliq } from "./cliq";
import { withTenant, withTenantRead, type Tx } from "./db";
import { appendEvent } from "./events";
import { API_ACTOR, ensureActionItemRef, findActionItemRef, iso, tenantOf } from "./repo/_shared";
import { ZOHO_SYSTEMS } from "./backend";

export interface Reminder {
  issueId: string;
  projectId: string;
  projectName: string | null;
  title: string | null;        // action-item title (for the Cliq message)
  assigneeName: string | null;  // who to @mention (best-effort, by name)
  remindAt: string;            // ISO 8601 (UTC)
  message: string | null;      // optional extra note
  fired: boolean;
  createdAt: string;
}

export interface SetReminderInput {
  projectId: string;
  projectName?: string | null;
  title?: string | null;
  assigneeName?: string | null;
  remindAt: string; // ISO 8601
  message?: string | null;
}

interface Snapshot {
  projectId?: string;
  projectName?: string | null;
  title?: string | null;
  assigneeName?: string | null;
}

interface ReminderRow {
  id: string;
  action_item_id: string;
  remind_at: Date;
  message: string | null;
  fired_at: Date | null;
  created_at: Date;
  custom: { legacy_snapshot?: Snapshot } | null;
  title: string;
  issue_id: string | null;
}

const ROW_SQL = (tx: Tx) => tx`
  select r.id, r.action_item_id, r.remind_at, r.message, r.fired_at, r.created_at, r.custom,
         a.title,
         (select x.external_id from public.external_ids x
           where x.tenant_id = public.app_tenant_id() and x.entity = 'action_item'
             and x.entity_id = a.id and x.system = ${ZOHO_SYSTEMS.action_item} limit 1) as issue_id
  from public.reminders r
  join public.action_items a on a.id = r.action_item_id
  where r.tenant_id = public.app_tenant_id() and r.deleted_at is null`;

function toReminder(r: ReminderRow): Reminder {
  const s = r.custom?.legacy_snapshot ?? {};
  return {
    issueId: r.issue_id ?? r.action_item_id,
    projectId: s.projectId ?? "",
    projectName: s.projectName ?? null,
    title: s.title ?? r.title ?? null,
    assigneeName: s.assigneeName ?? null,
    remindAt: iso(r.remind_at) ?? "",
    message: r.message ?? null,
    fired: r.fired_at !== null,
    createdAt: iso(r.created_at) ?? "",
  };
}

//------------------------------------------------------------------------------
// Transaction-level primitives (shared with scripts/import-kv.ts)
//------------------------------------------------------------------------------

export async function getReminderTx(tx: Tx, issueId: string): Promise<Reminder | null> {
  const aiId = await findActionItemRef(tx, issueId);
  if (!aiId) return null;
  const rows = await tx<ReminderRow[]>`${ROW_SQL(tx)} and r.action_item_id = ${aiId} limit 1`;
  return rows.length ? toReminder(rows[0]) : null;
}

/** Create/replace the reminder on an action item (resets the fired flag). */
export async function setReminderTx(
  tx: Tx,
  issueId: string,
  input: SetReminderInput,
  opts: { actor?: string; idempotencyKey?: string | null; createdAt?: string | null; fired?: boolean } = {}
): Promise<Reminder> {
  const aiId = await ensureActionItemRef(tx, { issueId, title: input.title ?? null });
  const snapshot: Snapshot = {
    projectId: input.projectId,
    projectName: input.projectName ?? null,
    title: input.title ?? null,
    assigneeName: input.assigneeName ?? null,
  };
  const custom = { legacy_snapshot: snapshot };
  const createdAt = opts.createdAt && Number.isFinite(Date.parse(opts.createdAt)) ? new Date(opts.createdAt).toISOString() : null;
  const firedAt = opts.fired ? new Date().toISOString() : null;
  const existing = await tx<{ id: string }[]>`
    select id from public.reminders
    where tenant_id = public.app_tenant_id() and action_item_id = ${aiId} and deleted_at is null limit 1`;
  if (existing.length) {
    await tx`
      update public.reminders
      set remind_at = ${input.remindAt}::timestamptz, message = ${input.message ?? null},
          fired_at = ${firedAt}::timestamptz, custom = ${tx.json(custom as never)}
      where tenant_id = public.app_tenant_id() and id = ${existing[0].id}`;
  } else {
    await tx`
      insert into public.reminders (tenant_id, action_item_id, remind_at, message, fired_at, custom, created_at)
      values (public.app_tenant_id(), ${aiId}, ${input.remindAt}::timestamptz, ${input.message ?? null},
              ${firedAt}::timestamptz, ${tx.json(custom as never)}, coalesce(${createdAt}::timestamptz, now()))`;
  }
  await appendEvent(tx, {
    entity: "reminder",
    entityId: aiId,
    eventType: existing.length ? "reminder.replaced" : "reminder.set",
    payload: { issueId, ...snapshot, remindAt: input.remindAt, message: input.message ?? null },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return (await getReminderTx(tx, issueId))!;
}

export async function clearReminderTx(tx: Tx, issueId: string, opts: { actor?: string } = {}): Promise<void> {
  const aiId = await findActionItemRef(tx, issueId);
  if (!aiId) return;
  const rows = await tx<{ id: string }[]>`
    update public.reminders set deleted_at = now()
    where tenant_id = public.app_tenant_id() and action_item_id = ${aiId} and deleted_at is null
    returning id`;
  if (rows.length) {
    await appendEvent(tx, { entity: "reminder", entityId: aiId, eventType: "reminder.cleared", payload: { issueId }, actor: opts.actor ?? API_ACTOR });
  }
}

//------------------------------------------------------------------------------
// Public API — same signatures as before
//------------------------------------------------------------------------------

/** Read the reminder set on an action item (or null). */
export async function getReminder(env: Env, issueId: string): Promise<Reminder | null> {
  return withTenantRead(env, tenantOf(env), (tx) => getReminderTx(tx, issueId));
}

/** Create/replace the reminder on an action item (resets the fired flag). */
export async function setReminder(env: Env, issueId: string, input: SetReminderInput): Promise<Reminder> {
  return withTenant(env, tenantOf(env), (tx) => setReminderTx(tx, issueId, input));
}

/** Remove the reminder from an action item. */
export async function clearReminder(env: Env, issueId: string): Promise<void> {
  return withTenant(env, tenantOf(env), (tx) => clearReminderTx(tx, issueId));
}

/** The Cliq webhook reminders post to (dedicated, else the scheduling channel). */
function remindersWebhook(env: Env): string | undefined {
  return env.CLIQ_REMINDERS_WEBHOOK || env.CLIQ_SCHEDULING_WEBHOOK;
}

/**
 * Fire all due, unfired reminders (called by the cron). Posts to Cliq and marks each
 * fired. Returns a small summary. Never throws (best-effort per reminder).
 */
export async function fireDueReminders(env: Env): Promise<{ scanned: number; fired: number }> {
  const webhook = remindersWebhook(env);
  const due = await withTenantRead(env, tenantOf(env), (tx) =>
    tx<ReminderRow[]>`${ROW_SQL(tx)} and r.fired_at is null and r.remind_at <= now() order by r.remind_at asc`
  );
  let fired = 0;
  for (const row of due) {
    const r = toReminder(row);
    const who = r.assigneeName ? `@${r.assigneeName}\n` : "";
    const proj = r.projectName ? `${r.projectName} · ` : "";
    const msg =
      `⏰ Action item reminder\n${who}${proj}${r.title ?? "Action item"}` +
      (r.message ? `\n${r.message}` : "");
    await postToCliq(webhook, msg); // best-effort; never throws
    try {
      await withTenant(env, tenantOf(env), async (tx) => {
        await tx`update public.reminders set fired_at = now() where tenant_id = public.app_tenant_id() and id = ${row.id}`;
        await appendEvent(tx, {
          entity: "reminder",
          entityId: row.action_item_id,
          eventType: "reminder.fired",
          payload: { issueId: r.issueId, title: r.title, assigneeName: r.assigneeName, remindAt: r.remindAt },
          actor: "system:cron",
        });
      });
      fired++;
    } catch (e) {
      console.error("fireDueReminders: mark-fired failed:", e);
    }
  }
  return { scanned: due.length, fired };
}
