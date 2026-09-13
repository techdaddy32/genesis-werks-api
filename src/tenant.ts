//==============================================================================
// tenant.ts — tenant resolution for a request (F2).
//
// Single-tenant TODAY: every request is served for env.TENANT_ID (FHI). The
// function is shaped so the source can change without touching callers:
//   1. JWT claim (P5: Supabase auth `tenant_id` claim)   — not wired yet
//   2. X-Tenant-Id header — ONLY when env.ALLOW_TENANT_HEADER === "true"
//      (dev/test). A header is NEVER trusted by default in production.
//   3. env.TENANT_ID — the default and the only production path for now.
//
// The resolved id is what withTenant() binds via SET LOCAL app.tenant_id.
//==============================================================================

import type { Env } from "./types";
import { isUuid } from "./db";

export type TenantSource = "env" | "header" | "jwt";

export interface ResolvedTenant {
  tenantId: string;
  source: TenantSource;
}

export class TenantError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = "TenantError";
  }
}

/** Header a dev/test client may send when ALLOW_TENANT_HEADER=true. */
export const TENANT_HEADER = "X-Tenant-Id";

/**
 * Resolve the tenant for this request. Throws TenantError(500) when no tenant
 * is configured, TenantError(400) when an allowed header carries a non-UUID.
 */
export async function resolveTenant(request: Request, env: Env): Promise<ResolvedTenant> {
  // 1. JWT claim — placeholder for P5 (Supabase auth). Intentionally not parsed yet:
  //    an unverified bearer token must never select a tenant.
  //    TODO(P5): verify the Supabase JWT (SUPABASE_JWT_SECRET) and read its tenant_id claim.

  // 2. Explicit header, opt-in only.
  if (env.ALLOW_TENANT_HEADER === "true") {
    const raw = request.headers.get(TENANT_HEADER);
    if (raw && raw.trim()) {
      const id = raw.trim().toLowerCase();
      if (!isUuid(id)) throw new TenantError(`${TENANT_HEADER} is not a UUID`, 400);
      return { tenantId: id, source: "header" };
    }
  }

  // 3. Deployment default.
  const id = (env.TENANT_ID ?? "").trim().toLowerCase();
  if (!id) throw new TenantError("TENANT_ID is not configured (wrangler.toml [vars] / .dev.vars)", 500);
  if (!isUuid(id)) throw new TenantError("TENANT_ID is not a UUID", 500);
  return { tenantId: id, source: "env" };
}

/**
 * The tenant a DB call is scoped to when no request is at hand (service modules,
 * cron, repos). index.ts copies resolveTenant()'s answer into env.TENANT_ID for
 * the request so header/JWT overrides flow through unchanged (F3).
 */
export function tenantOf(env: Env): string {
  const id = (env.TENANT_ID ?? "").trim().toLowerCase();
  if (!isUuid(id)) throw new TenantError("TENANT_ID is not configured (wrangler.toml [vars] / .dev.vars)", 500);
  return id;
}
