//==============================================================================
// _sandbox.ts — shared helpers for the P2 Postgres-path suites (not a test file).
//
// The pg-*.test.ts suites run the REAL router / service layer against the
// Genesis Sandbox tenant (SB1: f4100000-0000-4000-8000-000000000002), which has
// `backend.mode = postgres` and NO Zoho / Google. Each suite resets the sandbox
// first (scripts/reset-sandbox.ts — needs the OWNER connection, default
// TEST_ADMIN_DATABASE_URL=postgres://postgres:test@localhost:5432/gw_test) so the
// seeded counts (25 WOs, 8 projects, 20 items, …) are exact on every run; the
// suites skip when either connection is down. vitest runs files sequentially
// (vitest.config.ts fileParallelism:false) so two suites never reset at once.
//==============================================================================

import postgres from "postgres";
import type { Env } from "../src/types";
import type { Sql } from "../src/db";
import { dbAvailable, testEnv } from "./_pg";
import { SANDBOX_TENANT, resetSandbox } from "../scripts/reset-sandbox";
import { _clearBackendModeCache } from "../src/backend-mode";
import { _clearCache } from "../src/cache";

export { SANDBOX_TENANT };

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:test@localhost:5432/gw_test";

/** An Env bound to the sandbox tenant (DATABASE_URL fallback, no Zoho vars, no calendar). */
export function sandboxEnv(overrides: Partial<Env> = {}): Env {
  return testEnv({
    TENANT_ID: SANDBOX_TENANT,
    APP_ORIGIN: "https://genesis-sandbox.pages.dev",
    PUBLIC_WORKER_URL: "https://api.sandbox.test",
    ...overrides,
  });
}

/** True when the owner URL connects and owns `events` (the reset disables its trigger). */
export async function adminAvailable(): Promise<boolean> {
  let sql: Sql | null = null;
  try {
    sql = postgres(ADMIN_URL, { prepare: false, max: 1, fetch_types: false, connect_timeout: 3 });
    const rows = await sql<{ owner: string }[]>`select pg_get_userbyid(relowner) as owner from pg_class where relname = 'events' and relnamespace = 'public'::regnamespace`;
    const me = await sql<{ u: string }[]>`select current_user as u`;
    return rows.length === 1 && rows[0].owner === me[0].u;
  } catch {
    return false;
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/** Both connections up → the sandbox suites run. */
export async function sandboxAvailable(): Promise<boolean> {
  return (await dbAvailable()) && (await adminAvailable());
}

/** Wipe + reseed the sandbox (0003) and drop the per-isolate caches. */
export async function resetSandboxForTests(): Promise<void> {
  const sql = postgres(ADMIN_URL, { prepare: false, max: 1, fetch_types: false });
  try {
    await resetSandbox(sql);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
  _clearBackendModeCache();
  _clearCache();
}

/** Count sandbox events (optionally one event_type) through the owner connection. */
export async function countSandboxEvents(eventType?: string): Promise<number> {
  const sql = postgres(ADMIN_URL, { prepare: false, max: 1, fetch_types: false });
  try {
    const rows = eventType
      ? await sql<{ n: string }[]>`select count(*)::text as n from public.events where tenant_id = ${SANDBOX_TENANT} and event_type = ${eventType}`
      : await sql<{ n: string }[]>`select count(*)::text as n from public.events where tenant_id = ${SANDBOX_TENANT}`;
    return Number(rows[0].n);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/** Run one query as the owner (for assertions on raw rows). */
export async function adminQuery<T extends Record<string, unknown>>(fn: (sql: Sql) => Promise<T[]>): Promise<T[]> {
  const sql = postgres(ADMIN_URL, { prepare: false, max: 1, fetch_types: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

export const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** Call the real router. */
export async function callApi(
  worker: { fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> },
  env: Env,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any; res: Response }> {
  const res = await worker.fetch(
    new Request(`https://api.sandbox.test${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: "https://genesis-sandbox.pages.dev" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  const ct = res.headers.get("Content-Type") ?? "";
  const json = ct.includes("application/json") ? await res.clone().json() : null;
  return { status: res.status, json, res };
}
