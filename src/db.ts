//==============================================================================
// db.ts — Postgres client for the Worker (F2).
//
// Transport: the `postgres` (porsager) driver over the HYPERDRIVE binding's
// connection string. Hyperdrive terminates TLS and pools connections near the
// database; the Worker opens a short-lived client per request.
//
// RULES (ratified design — do not drift):
//   - ONE write path: every DB write goes through this Worker, inside a
//     transaction opened by withTenant().
//   - `SET LOCAL app.tenant_id` (via set_config(..., true)) is issued INSIDE
//     EVERY transaction. Hyperdrive pools connections, so a session-level SET
//     would leak one tenant's id into another tenant's request. SET LOCAL dies
//     with the transaction.
//   - RLS policy `tenant_isolation` (0001 §7) keys on app_tenant_id(). It only
//     bites for NOBYPASSRLS roles (genesis_api). Superuser/service_role bypass
//     RLS, so modules ALSO filter with tenant_id = app_tenant_id() explicitly.
//   - No module-global client: a Worker isolate may serve many requests and
//     the driver keeps sockets; build the client per request and end it.
//   - No business rules here — this file is transport + tenant binding only.
//
// Driver options (Workers): prepare:false (Hyperdrive/pgbouncer-safe — no named
// prepared statements across pooled connections), fetch_types:false (skips the
// pg_type catalog round-trip that Hyperdrive dislikes), max:5.
//
// TEST/DEV: when env.HYPERDRIVE is absent, env.DATABASE_URL (a plain
// postgres:// URL) is used instead. Never set DATABASE_URL in production.
//==============================================================================

import postgres from "postgres";
import type { Env } from "./types";

/** A root client (outside any transaction). */
export type Sql = postgres.Sql<{}>;
/** A transaction handle — what every domain module takes as its first argument. */
export type Tx = postgres.TransactionSql<{}>;

/** Columns every 0001 domain table carries (tenants: no tenant_id — it IS the tenant). */
export interface BaseRow {
  id: string;
  tenant_id: string;
  created_at: Date;
  updated_at: Date;
}
/** A domain row = its own columns on top of the baseline columns. */
export type Row<T extends object> = T & BaseRow;

/** First row or null — for `... LIMIT 1` style queries. */
export function firstRow<T>(rows: readonly T[]): T | null {
  return rows.length > 0 ? rows[0] : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `s` is a well-formed RFC 4122/9562 UUID (v1–v8). */
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

export class DbError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DbError";
  }
}

/** Resolve the connection string: Hyperdrive in prod, DATABASE_URL for tests/dev. */
function connectionString(env: Env): string {
  const hd = env.HYPERDRIVE?.connectionString;
  if (hd) return hd;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  throw new DbError("No database configured: bind HYPERDRIVE (prod) or set DATABASE_URL (test/dev only).");
}

/**
 * Build a PER-REQUEST client. Never cache the result in module scope — Workers
 * isolates are reused across requests and the driver holds sockets. Callers
 * that use getSql() directly must `await sql.end()` when done (withTenant()
 * does this for you when it owns the client).
 */
export function getSql(env: Env): Sql {
  return postgres(connectionString(env), {
    prepare: false,
    max: 5,
    fetch_types: false,
    idle_timeout: 20,
    connect_timeout: 10,
    // Keep timestamptz as Date (driver default) and jsonb parsed (driver default).
  });
}

export interface TxOptions {
  /** Reuse an existing client (the caller owns its lifecycle). Otherwise one is built and ended here. */
  sql?: Sql;
}

/**
 * Run `fn` inside ONE transaction bound to `tenantId`:
 *   BEGIN; select set_config('app.tenant_id', $1, true); ...fn...; COMMIT
 * ROLLBACK on any throw (the driver rolls back when the callback rejects).
 * `set_config(..., is_local => true)` is exactly `SET LOCAL` and is parameterised,
 * so no SQL is built from the tenant id — it is still regex-validated first.
 */
export async function withTenant<T>(
  env: Env,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {}
): Promise<T> {
  return runTx(env, tenantId, fn, "", opts);
}

/** Same as withTenant() but the transaction is READ ONLY (any write raises 25006). */
export async function withTenantRead<T>(
  env: Env,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {}
): Promise<T> {
  return runTx(env, tenantId, fn, "read only", opts);
}

async function runTx<T>(
  env: Env,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  beginOptions: string,
  opts: TxOptions
): Promise<T> {
  if (!isUuid(tenantId)) throw new DbError(`withTenant: tenantId is not a UUID (${String(tenantId)})`);
  const owned = !opts.sql;
  const sql = opts.sql ?? getSql(env);
  try {
    const body = async (tx: Tx): Promise<T> => {
      // SET LOCAL — scoped to this transaction only (Hyperdrive pools connections).
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    };
    // The driver types begin() as UnwrapPromiseArray<T> (it unwraps arrays of
    // promises); our callback returns a single awaited T, so the cast is exact.
    const out = beginOptions ? await sql.begin(beginOptions, body) : await sql.begin(body);
    return out as T;
  } finally {
    if (owned) await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  /** Which transport answered: "hyperdrive" | "database_url" | "none". */
  via: "hyperdrive" | "database_url" | "none";
  error?: string;
}

/** `select 1` round-trip. Never throws — /health reports the failure instead. */
export async function dbHealth(env: Env): Promise<DbHealth> {
  const via: DbHealth["via"] = env.HYPERDRIVE?.connectionString
    ? "hyperdrive"
    : env.DATABASE_URL
      ? "database_url"
      : "none";
  const started = Date.now();
  if (via === "none") return { ok: false, latencyMs: 0, via, error: "no database configured" };
  let sql: Sql | null = null;
  try {
    sql = getSql(env);
    const rows = await sql`select 1 as one`;
    const ok = rows.length === 1 && Number(rows[0].one) === 1;
    return { ok, latencyMs: Date.now() - started, via };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, via, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
