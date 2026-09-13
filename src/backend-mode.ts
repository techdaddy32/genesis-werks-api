//==============================================================================
// backend-mode.ts — which store serves the domain routes for a tenant (P2).
//
//   tenant_settings `backend.mode` = "postgres" | "zoho"   (0004_backend_mode.sql)
//     FHI     → "zoho"      until the P3a import + cutover
//     sandbox → "postgres"  (it has no Zoho at all)
//
// service.ts dispatches at the HANDLER level:
//   if (await isPostgresBackend(env)) return pg.<handler>(env, …);   // src/repo/*
//   …existing Zoho code, byte-for-byte unchanged…
//
// Resolution rules (deliberately conservative — the Zoho path is the default):
//   - no database configured (no HYPERDRIVE / DATABASE_URL) → "zoho"
//     (the Zoho-mocked unit suites run without a DB and must keep doing so);
//   - no usable TENANT_ID → "zoho";
//   - the key is absent or holds anything but "postgres" → "zoho".
// The answer is cached per tenant for a short window (cutover flips it once;
// a request makes several handler calls) — _clearBackendModeCache() for tests.
//==============================================================================

import type { Env } from "./types";
import { isUuid, withTenantRead, type Tx } from "./db";
import { getSetting } from "./settings";

export type BackendMode = "postgres" | "zoho";

export const BACKEND_MODE_KEY = "backend.mode";

const CACHE_MS = 30_000;
const cache = new Map<string, { mode: BackendMode; at: number }>();

/** Parse a raw setting value into a mode ("zoho" for anything unrecognised). */
export function parseBackendMode(raw: unknown): BackendMode {
  return typeof raw === "string" && raw.trim().toLowerCase() === "postgres" ? "postgres" : "zoho";
}

/** The mode for the transaction's tenant (no cache — reads the row). */
export async function backendModeTx(tx: Tx): Promise<BackendMode> {
  return parseBackendMode(await getSetting(tx, BACKEND_MODE_KEY));
}

/** The mode for env's tenant (cached CACHE_MS per tenant). Never throws — falls back to "zoho". */
export async function backendMode(env: Env, tx?: Tx): Promise<BackendMode> {
  if (tx) return backendModeTx(tx);
  const hasDb = !!(env.HYPERDRIVE?.connectionString || env.DATABASE_URL);
  const tenant = (env.TENANT_ID ?? "").trim().toLowerCase();
  if (!hasDb || !isUuid(tenant)) return "zoho";
  const hit = cache.get(tenant);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.mode;
  let mode: BackendMode = "zoho";
  try {
    mode = await withTenantRead(env, tenant, backendModeTx);
  } catch (e) {
    console.warn("backendMode: settings read failed — defaulting to zoho:", e instanceof Error ? e.message : e);
  }
  cache.set(tenant, { mode, at: now });
  return mode;
}

export async function isPostgresBackend(env: Env): Promise<boolean> {
  return (await backendMode(env)) === "postgres";
}

/** Tests: forget every cached answer (e.g. after flipping the setting). */
export function _clearBackendModeCache(): void {
  cache.clear();
}
