//==============================================================================
// admin.ts — the PIN-gated admin config store.
//
// A small, extensible config object kept in KV under `admin:config`. For now it
// only holds the list of users allowed to generate reports (reportAccess), but
// it's shaped as an object so more fields can be added later without a rewrite.
//
// Follows the same KV-first read/write pattern as creds.ts. One invariant is
// enforced on EVERY read and write: craig@fhiflorida.com is always present in
// reportAccess and can never be removed.
//==============================================================================

import type { Env, AdminConfig } from "./types";

const KV_KEY = "admin:config";

/** The email that is ALWAYS in reportAccess and can never be removed. */
export const ALWAYS_ADMIN = "craig@fhiflorida.com";

/**
 * Normalize a config in place-safe fashion: trim + lowercase + dedupe the
 * reportAccess emails, and guarantee ALWAYS_ADMIN is present. Any future fields
 * are carried through untouched. Returns a fresh, normalized AdminConfig.
 */
function normalize(cfg: Partial<AdminConfig> | null | undefined): AdminConfig {
  const raw = Array.isArray(cfg?.reportAccess) ? cfg!.reportAccess : [];
  const emails = raw
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // Force-include craig, then dedupe (preserves first-seen order).
  const reportAccess = Array.from(new Set([ALWAYS_ADMIN, ...emails]));

  // App-maintained Zoho-user option values: trimmed, non-empty, de-duped (order
  // preserved). Reference-only mirror of the Zoho pick-list — no case-folding, so
  // the stored values match the Zoho labels exactly. Defaults to [].
  const rawOptions = Array.isArray(cfg?.zohoUserOptions) ? cfg!.zohoUserOptions : [];
  const zohoUserOptions = Array.from(
    new Set(
      rawOptions
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim())
        .filter(Boolean)
    )
  );

  return { ...(cfg ?? {}), reportAccess, zohoUserOptions };
}

/** Read the admin config from KV (default empty), normalized so craig is present. */
export async function getAdminConfig(env: Env): Promise<AdminConfig> {
  const raw = await env.WO_KV.get(KV_KEY);
  if (raw) {
    try {
      return normalize(JSON.parse(raw) as Partial<AdminConfig>);
    } catch {
      /* fall through to default */
    }
  }
  return normalize({ reportAccess: [] });
}

/** Normalize, write to KV, and return the saved (normalized) config. */
export async function saveAdminConfig(env: Env, cfg: Partial<AdminConfig>): Promise<AdminConfig> {
  const normalized = normalize(cfg);
  await env.WO_KV.put(KV_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * No-PIN boolean check: is `email` allowed to generate reports? Uses the same
 * trim+lowercase normalization as the config (and craig is always present, since
 * getAdminConfig normalizes reportAccess to include ALWAYS_ADMIN). This is a UI
 * gate, not hard security — see GET /admin/report-access/check.
 */
export async function canGenerateReports(env: Env, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const cfg = await getAdminConfig(env);
  return cfg.reportAccess.includes(normalized);
}
