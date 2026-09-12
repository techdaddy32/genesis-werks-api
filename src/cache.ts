//==============================================================================
// cache.ts — tiny read-through cache: per-isolate memory + WO_KV (cross-isolate).
//
// Why: Zoho Projects throttles at ~100 requests per API endpoint per rolling 2 minutes
// (HTTP 400 URL_ROLLING_THROTTLES_LIMIT_EXCEEDED, live 2026-09-03). Several routes fan
// out to many Zoho calls per request (project detail back-fill, action-item aggregate),
// so repeated dashboard loads burn the budget on data that barely changes. Everything
// here is best-effort: a cache miss or KV error just falls through to the loader.
//
// Freshness: an entry is FRESH for `freshMs`; it is retained (stale) for `staleTtlS` so a
// caller can choose to serve it when the upstream is throttled (`allowStale`).
//==============================================================================

import type { Env } from "./types";
import { ZohoThrottleError } from "./zoho";

export interface CacheEntry<T> {
  at: number; // epoch ms when fetched
  value: T;
}

const mem = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/** Test seam. */
export function _clearCache(): void {
  mem.clear();
}

export async function cacheGet<T>(env: Env, key: string): Promise<CacheEntry<T> | null> {
  const m = mem.get(key);
  if (m) return m as CacheEntry<T>;
  try {
    const raw = await env.WO_KV?.get(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as CacheEntry<T>;
    mem.set(key, e);
    return e;
  } catch {
    return null;
  }
}

export async function cachePut<T>(env: Env, key: string, value: T, staleTtlS: number): Promise<CacheEntry<T>> {
  const e: CacheEntry<T> = { at: Date.now(), value };
  mem.set(key, e);
  try {
    await env.WO_KV?.put(key, JSON.stringify(e), { expirationTtl: Math.max(60, staleTtlS) });
  } catch {
    /* best-effort */
  }
  return e;
}

export async function cacheDelete(env: Env, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    mem.delete(k);
    try {
      await env.WO_KV?.delete(k);
    } catch {
      /* ignore */
    }
  }
}

/** Drop every in-memory entry whose key starts with `prefix` (KV copies age out on their own). */
export function cacheDropPrefix(prefix: string): void {
  for (const k of Array.from(mem.keys())) if (k.startsWith(prefix)) mem.delete(k);
}

export interface CachedResult<T> {
  value: T;
  cached: boolean; // served without calling the loader
  stale: boolean; // served past its fresh window (only when throttled + allowStale)
  fetchedAt: string;
  throttled?: boolean;
  retryAfterMin?: number;
}

/**
 * Read-through: fresh cache → return; else run loader and cache. If the loader throws a
 * Zoho throttle and a stale entry exists (and allowStale), serve the stale entry flagged.
 */
export async function cached<T>(
  env: Env,
  key: string,
  opts: { freshMs: number; staleTtlS: number; refresh?: boolean; allowStale?: boolean },
  loader: () => Promise<T>
): Promise<CachedResult<T>> {
  const hit = await cacheGet<T>(env, key);
  const now = Date.now();
  if (!opts.refresh && hit && now - hit.at < opts.freshMs) {
    return { value: hit.value, cached: true, stale: false, fetchedAt: new Date(hit.at).toISOString() };
  }
  try {
    // Single-flight: concurrent identical misses share one loader call instead of each hitting Zoho.
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = loader().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const value = await p;
    const e = await cachePut(env, key, value, opts.staleTtlS);
    return { value, cached: false, stale: false, fetchedAt: new Date(e.at).toISOString() };
  } catch (err) {
    if (err instanceof ZohoThrottleError && hit && opts.allowStale !== false) {
      return {
        value: hit.value,
        cached: true,
        stale: true,
        fetchedAt: new Date(hit.at).toISOString(),
        throttled: true,
        retryAfterMin: err.retryAfterMin,
      };
    }
    throw err;
  }
}
