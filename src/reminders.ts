//==============================================================================
// reminders.ts — reminders on action items (Zoho Issues) that fire a Cliq post.
//
// Self-managed in KV (one reminder per action item, key `reminder:<issueId>`). The
// Worker cron (every 10 min) calls fireDueReminders(): any reminder whose remindAt has
// passed and hasn't fired yet posts to Cliq and is marked fired. Best-effort — a Cliq
// hiccup never throws.
//==============================================================================

import type { Env } from "./types";
import { postToCliq } from "./cliq";

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

const reminderKey = (issueId: string) => `reminder:${issueId}`;

/** Read the reminder set on an action item (or null). */
export async function getReminder(env: Env, issueId: string): Promise<Reminder | null> {
  const raw = await env.WO_KV.get(reminderKey(issueId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Reminder;
  } catch {
    return null;
  }
}

export interface SetReminderInput {
  projectId: string;
  projectName?: string | null;
  title?: string | null;
  assigneeName?: string | null;
  remindAt: string; // ISO 8601
  message?: string | null;
}

/** Create/replace the reminder on an action item (resets the fired flag). */
export async function setReminder(env: Env, issueId: string, input: SetReminderInput): Promise<Reminder> {
  const reminder: Reminder = {
    issueId,
    projectId: input.projectId,
    projectName: input.projectName ?? null,
    title: input.title ?? null,
    assigneeName: input.assigneeName ?? null,
    remindAt: input.remindAt,
    message: input.message ?? null,
    fired: false,
    createdAt: new Date().toISOString(),
  };
  await env.WO_KV.put(reminderKey(issueId), JSON.stringify(reminder));
  return reminder;
}

/** Remove the reminder from an action item. */
export async function clearReminder(env: Env, issueId: string): Promise<void> {
  await env.WO_KV.delete(reminderKey(issueId));
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
  const now = Date.now();
  let scanned = 0;
  let fired = 0;
  let cursor: string | undefined;
  const webhook = remindersWebhook(env);

  do {
    const list = await env.WO_KV.list({ prefix: "reminder:", cursor });
    for (const k of list.keys) {
      scanned++;
      const raw = await env.WO_KV.get(k.name);
      if (!raw) continue;
      let r: Reminder;
      try {
        r = JSON.parse(raw) as Reminder;
      } catch {
        continue;
      }
      if (r.fired) continue;
      const due = Date.parse(r.remindAt);
      if (!Number.isFinite(due) || due > now) continue;

      const who = r.assigneeName ? `@${r.assigneeName}\n` : "";
      const proj = r.projectName ? `${r.projectName} · ` : "";
      const msg =
        `⏰ Action item reminder\n${who}${proj}${r.title ?? "Action item"}` +
        (r.message ? `\n${r.message}` : "");
      await postToCliq(webhook, msg); // best-effort; never throws

      r.fired = true;
      await env.WO_KV.put(k.name, JSON.stringify(r));
      fired++;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return { scanned, fired };
}
