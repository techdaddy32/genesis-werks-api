// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
//==============================================================================
// sync/cron.ts — the walk-tool share of the Worker's scheduled() handler (every 10 min,
// wrangler.toml [triggers]). Gated like the routes: env.SYNC_ROUTES === "on".
//
// Per Organization (systemContext → withOrg → SET LOCAL app.org_id; the cron is NOT a bypass):
//   1. sweepLeaseWarnings   — checkout.expiring once per lease inside the warn window (§6 check 7)
//   2. verifyUploadedFiles  — 'uploaded' rows whose sha256 matches R2 → 'verified' (§6 check 6)
//   3. orphanSweep          — report-only files.orphan_report (pending > 7d, R2 keys without rows)
//
// WHICH ORGANIZATIONS: RLS on shared.organizations keys on app.org_id, so genesis_api cannot
// enumerate tenants. The cron takes the list from env.SYNC_CRON_ORGANIZATION_IDS (comma-
// separated) falling back to env.ORGANIZATION_ID — the sandbox is one Organization. Multi-
// tenant enumeration needs a definer function or a cron role later (needs-judgment in W2's report).
//==============================================================================

import type { Env } from "../types";
import { systemContext, type OrganizationContext } from "../org-context";
import { sweepLeaseWarnings, type LeaseSweepResult } from "./checkout";
import { verifyUploadedFiles, orphanSweep, type FileStore, type VerifyResult, type OrphanReport } from "./files";

export interface SyncCronResult {
  organizations: string[];
  leases: LeaseSweepResult[];
  files: VerifyResult[];
  orphans: OrphanReport[];
  errors: { organization_id: string; step: string; error: string }[];
}

export function cronOrganizationIds(env: Env): string[] {
  const raw = (env.SYNC_CRON_ORGANIZATION_IDS ?? env.ORGANIZATION_ID ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(raw)];
}

export interface SyncCronOptions {
  now?: Date;
  store?: FileStore;
  contextFor?: (env: Env, orgId: string) => OrganizationContext;
}

export async function runSyncCron(env: Env, opts: SyncCronOptions = {}): Promise<SyncCronResult> {
  const out: SyncCronResult = { organizations: cronOrganizationIds(env), leases: [], files: [], orphans: [], errors: [] };
  const store = opts.store ?? (env.FILES as unknown as FileStore | undefined);
  for (const orgId of out.organizations) {
    const ctx = (opts.contextFor ?? systemContext)(env, orgId);
    try {
      out.leases.push(await sweepLeaseWarnings(ctx, opts.now));
    } catch (e) {
      out.errors.push({ organization_id: orgId, step: "leases", error: String((e as Error)?.message ?? e) });
    }
    if (!store) {
      out.errors.push({ organization_id: orgId, step: "files", error: "FILES binding is not configured" });
      continue;
    }
    try {
      out.files.push(await verifyUploadedFiles(ctx, store));
    } catch (e) {
      out.errors.push({ organization_id: orgId, step: "verify", error: String((e as Error)?.message ?? e) });
    }
    try {
      out.orphans.push(await orphanSweep(ctx, store, { now: opts.now }));
    } catch (e) {
      out.errors.push({ organization_id: orgId, step: "orphans", error: String((e as Error)?.message ?? e) });
    }
  }
  return out;
}
