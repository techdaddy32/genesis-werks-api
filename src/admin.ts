//==============================================================================
// admin.ts — the PIN-gated admin config store (F3: tenant_settings).
//
// Was the KV key `admin:config`. The same AdminConfig object is now three
// tenant_settings rows (seeded by 0002_seed_fhi.sql, typed in settings.ts):
//   admin.report_access        string[]   ↔ reportAccess
//   admin.zoho_user_options    string[]   ↔ zohoUserOptions
//   admin.scheduling_confirmer string[]   ↔ schedulingConfirmer (wire: ONE string;
//                                           stored as a 1-element list — the seed
//                                           allows several names, the API exposes
//                                           the first)
// One invariant is enforced on EVERY read and write: craig@fhiflorida.com is
// always present in reportAccess and can never be removed. Every save appends
// an events row (admin.config_saved).
//==============================================================================

import type { Env, AdminConfig } from "./types";
import { withTenant, withTenantRead, type Tx } from "./db";
import { getAdminSettings, setKnownSetting } from "./settings";
import { appendEvent } from "./events";
import { API_ACTOR, tenantOf } from "./repo/_shared";

/** The email that is ALWAYS in reportAccess and can never be removed. */
export const ALWAYS_ADMIN = "craig@fhiflorida.com";

/**
 * Normalize: trim + lowercase + dedupe the reportAccess emails, guarantee ALWAYS_ADMIN
 * is present, trim/dedupe zohoUserOptions (no case-folding — they must match the Zoho
 * labels exactly). Returns a fresh, normalized AdminConfig.
 */
function normalize(cfg: Partial<AdminConfig> | null | undefined): AdminConfig {
  const raw = Array.isArray(cfg?.reportAccess) ? cfg!.reportAccess : [];
  const emails = raw
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const reportAccess = Array.from(new Set([ALWAYS_ADMIN, ...emails]));

  const rawOptions = Array.isArray(cfg?.zohoUserOptions) ? cfg!.zohoUserOptions : [];
  const zohoUserOptions = Array.from(
    new Set(
      rawOptions
        .filter((o): o is string => typeof o === "string")
        .map((o) => o.trim())
        .filter(Boolean)
    )
  );

  const out: AdminConfig = { ...(cfg ?? {}), reportAccess, zohoUserOptions };
  if (typeof cfg?.schedulingConfirmer === "string") out.schedulingConfirmer = cfg.schedulingConfirmer;
  else delete out.schedulingConfirmer;
  return out;
}

/** Read the three admin.* rows into the wire object (defaults when unset). */
export async function getAdminConfigTx(tx: Tx): Promise<AdminConfig> {
  const s = await getAdminSettings(tx);
  const confirmer = Array.isArray(s["admin.scheduling_confirmer"])
    ? s["admin.scheduling_confirmer"].find((n) => typeof n === "string" && n.trim())
    : typeof (s["admin.scheduling_confirmer"] as unknown) === "string"
      ? (s["admin.scheduling_confirmer"] as unknown as string)
      : undefined;
  return normalize({
    reportAccess: s["admin.report_access"] ?? [],
    zohoUserOptions: s["admin.zoho_user_options"] ?? [],
    ...(confirmer ? { schedulingConfirmer: confirmer } : {}),
  });
}

/** Normalize, write the three rows, append an event, return the saved config. */
export async function saveAdminConfigTx(tx: Tx, cfg: Partial<AdminConfig>, opts: { actor?: string; idempotencyKey?: string | null } = {}): Promise<AdminConfig> {
  const normalized = normalize(cfg);
  await setKnownSetting(tx, "admin.report_access", normalized.reportAccess);
  await setKnownSetting(tx, "admin.zoho_user_options", normalized.zohoUserOptions);
  const confirmer = (normalized.schedulingConfirmer ?? "").trim();
  await setKnownSetting(tx, "admin.scheduling_confirmer", confirmer ? [confirmer] : []);
  await appendEvent(tx, {
    entity: "tenant_settings",
    entityId: null,
    eventType: "admin.config_saved",
    payload: { reportAccess: normalized.reportAccess, zohoUserOptions: normalized.zohoUserOptions, schedulingConfirmer: confirmer || null },
    actor: opts.actor ?? API_ACTOR,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
  return normalized;
}

/** Read the admin config (default empty), normalized so craig is present. */
export async function getAdminConfig(env: Env): Promise<AdminConfig> {
  return withTenantRead(env, tenantOf(env), getAdminConfigTx);
}

/** Normalize, write, and return the saved (normalized) config. */
export async function saveAdminConfig(env: Env, cfg: Partial<AdminConfig>): Promise<AdminConfig> {
  return withTenant(env, tenantOf(env), (tx) => saveAdminConfigTx(tx, cfg));
}

/**
 * No-PIN boolean check: is `email` allowed to generate reports? Same trim+lowercase
 * normalization as the config (craig is always present). UI gate, not hard security.
 */
export async function canGenerateReports(env: Env, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const cfg = await getAdminConfig(env);
  return cfg.reportAccess.includes(normalized);
}
