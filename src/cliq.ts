//==============================================================================
// cliq.ts — a tiny, reusable Zoho Cliq poster.
//
// Zoho Cliq's channel-message webhook accepts a JSON body of the form
// `{ "text": "..." }`. Posting is deliberately BEST-EFFORT: a missing webhook is a
// no-op, and any failure is swallowed with a console.warn so a Cliq hiccup can
// never fail the request that triggered it. This function NEVER throws.
//==============================================================================

/**
 * Post a plain-text message to a Zoho Cliq webhook URL.
 *  - `webhookUrl` falsy  -> no-op (return immediately).
 *  - success/failure     -> best-effort; failures warn, never throw.
 *
 * The URL is always supplied by the caller (from an env secret) — never hardcoded.
 */
import type { Env } from "./types";

/**
 * Resolve the Cliq webhook for action-item notifications. Prefers the dedicated Action Items
 * channel; falls back to the reminders channel, then the scheduling channel, so notifications
 * still land somewhere until CLIQ_ACTIONITEMS_WEBHOOK is set.
 */
export function actionItemsWebhook(env: Env): string | undefined {
  return env.CLIQ_ACTIONITEMS_WEBHOOK || env.CLIQ_REMINDERS_WEBHOOK || env.CLIQ_SCHEDULING_WEBHOOK;
}

/**
 * Post an "action item assigned to @name" notification to the Action Items channel. Best-effort
 * (never throws — postToCliq swallows failures). Always names the assignee (S8 requirement).
 */
export async function notifyActionItemAssigned(
  env: Env,
  opts: { assigneeName: string; title: string; projectName?: string | null }
): Promise<void> {
  const proj = opts.projectName ? ` (${opts.projectName})` : "";
  // Clickable link to the Action Items page (the FE deep-links ?tab=todos). APP_ORIGIN may be a
  // comma-separated allowlist — use the first. Omitted if unset. Raw URL is auto-linked in Cliq.
  const origin = (env.APP_ORIGIN || "").split(",")[0].trim();
  const link = origin ? `\n👉 Open Action Items: ${origin}/work-orders?tab=todos` : "";
  await postToCliq(
    actionItemsWebhook(env),
    `🧰 Action item assigned to @${opts.assigneeName}: ${opts.title}${proj}${link}`
  );
}

export async function postToCliq(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) return; // not configured — silently skip
  try {
    // TODO(craig): confirm Cliq accepts { text } for your incoming webhook; some
    // setups expect a different envelope (e.g. { "broadcast": ... } vs { "text": ... }).
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      // Best-effort: log and move on (do NOT throw).
      console.warn(`postToCliq: webhook returned ${res.status}`);
    }
  } catch (e) {
    console.warn("postToCliq failed (non-fatal):", e);
  }
}
