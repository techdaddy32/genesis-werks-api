// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07 — systemContext() for the cron (no actor; app.role = system)
//==============================================================================
// org-context.ts — Organization context for the walk-tool / drawing-layer routes.
//
// Replaces the tenant-era pair (tenant.ts + db.ts withTenant) for the NEW schema
// (work/migrations 001→090): every RLS policy keys on
//   organization_id = nullif(current_setting('app.org_id', true), '')::uuid
// so a transaction that never ran set_config('app.org_id', …, true) sees ZERO
// rows and every write fails WITH CHECK (fails CLOSED — walk spec §7).
//
// Flow per request:
//   1. authenticate  → a Principal (who is calling). Sandbox: `X-Actor-Id` header or
//      `Authorization: Bearer <members.id>` carrying a shared.members.id. This is a
//      SEAM — see `Authenticator` below for how a real JWT replaces it.
//   2. requested org → `X-Organization-Id` header, else env.ORGANIZATION_ID. This is
//      only a REQUESTED context: it is validated against membership in step 3.
//   3. membership    → shared.members WHERE organization_id = requested AND deleted_at IS NULL
//      AND (id = principal | auth_user_id = principal). Not found → 403.
//      active = false → the context resolves with `revoked: true` (the push route
//      HOLDS such rows as sync_rejections('actor_revoked') — Craig 2026-09-26: take them).
//   4. withOrg(ctx, fn) → ONE transaction:
//        BEGIN;
//        select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true),
//               set_config('app.role', $3, true);
//        …fn(tx)…
//        COMMIT  (ROLLBACK on throw)
//      set_config(..., true) IS `SET LOCAL`: scoped to the transaction, so a pooled
//      (Hyperdrive) connection cannot leak one Organization into the next request.
//
// RULES (do not drift): the Worker is the ONLY DB client · SET LOCAL per transaction ·
// no module-global client · no business rules here (transport + context binding only).
//
// Swapping in a real JWT (Supabase auth) later:
//   - write `jwtAuthenticator(env)` that verifies the token (SUPABASE_JWT_SECRET / JWKS)
//     and returns { kind: "auth_user", authUserId: <sub>, orgId: <custom claim, if any> };
//   - set env.SYNC_AUTH_MODE = "jwt" and have `authenticatorFor()` return it;
//   - nothing else changes: membership is still resolved server-side here
//     (members.auth_user_id), the requested org is still validated, withOrg is unchanged.
//==============================================================================

import postgres from "postgres";
import type { Env } from "./types";
import { isUuid, DbError } from "./db";

/** A root client (outside any transaction). Same driver options as db.ts (Hyperdrive-safe). */
export type Sql = postgres.Sql<{}>;
/** A transaction handle bound to one Organization. */
export type Tx = postgres.TransactionSql<{}>;

export type MemberRole = "designer" | "technician" | "office" | "admin";
/** The cron's binding: not a member. Only systemContext() produces it. */
export type ContextRole = MemberRole | "system";

export interface OrganizationContext {
  organizationId: string;
  /** shared.members.id of the acting member — what created_by / actor columns hold. */
  actorId: string;
  role: ContextRole;
  isAdmin: boolean;
  /** members.active = false: still authenticated and a member, but pushes are HELD (actor_revoked). */
  revoked: boolean;
  /** Where the requested org came from (diagnostics only). */
  orgSource: "header" | "env" | "principal";
  /** Which authenticator answered (diagnostics only). */
  authSource: string;
  /** The Env the DB client is built from (HYPERDRIVE in prod, DATABASE_URL in tests). */
  env: Env;
}

export class OrgContextError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "OrgContextError";
  }
}

//------------------------------------------------------------------------------
// 1. Authentication seam
//------------------------------------------------------------------------------

/** Who is calling. `member` = a shared.members.id directly (sandbox); `auth_user` = an auth provider's subject. */
export type Principal =
  | { kind: "member"; memberId: string; source: string }
  | { kind: "auth_user"; authUserId: string; orgId?: string; source: string };

/** Returns null when the request carries no credential this authenticator understands. */
export type Authenticator = (request: Request, env: Env) => Promise<Principal | null>;

export const ACTOR_HEADER = "X-Actor-Id";
export const ORG_HEADER = "X-Organization-Id";

/**
 * SANDBOX ONLY — trusts a shared.members.id carried in `X-Actor-Id` or
 * `Authorization: Bearer <uuid>`. Enabled by env.SYNC_AUTH_MODE === "actor_header"
 * ([env.sandbox] in wrangler.toml). Never enable in production: it is identity by
 * assertion. Membership (org, role, active, deleted_at) is still resolved server-side.
 */
export const actorHeaderAuthenticator: Authenticator = async (request) => {
  const header = request.headers.get(ACTOR_HEADER)?.trim();
  if (header) {
    if (!isUuid(header)) throw new OrgContextError(`${ACTOR_HEADER} is not a UUID`, 400);
    return { kind: "member", memberId: header.toLowerCase(), source: "actor_header" };
  }
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) {
    const token = m[1].trim();
    if (!isUuid(token)) throw new OrgContextError("Bearer token is not a sandbox member id", 401);
    return { kind: "member", memberId: token.toLowerCase(), source: "bearer_member_id" };
  }
  return null;
};

/** Pick the authenticator for this deployment. Fails CLOSED when no mode is configured. */
export function authenticatorFor(env: Env): Authenticator {
  const mode = (env.SYNC_AUTH_MODE ?? "").trim().toLowerCase();
  if (mode === "actor_header") return actorHeaderAuthenticator;
  // "jwt" lands with the Supabase-auth row; until then an unconfigured mode denies everything.
  return async () => {
    throw new OrgContextError("no authenticator configured (SYNC_AUTH_MODE)", 503);
  };
}

//------------------------------------------------------------------------------
// 2 + 3. Requested org → membership
//------------------------------------------------------------------------------

export interface ResolveOptions {
  /** Override the authenticator (tests, or the JWT implementation). */
  authenticate?: Authenticator;
  /** Reuse a client for the membership lookup (tests). */
  sql?: Sql;
}

interface MemberRow {
  id: string;
  organization_id: string;
  role: MemberRole;
  is_admin: boolean;
  active: boolean;
}

/**
 * Authenticate the actor, validate the requested Organization against membership,
 * and return the context every DB call is bound to. Throws OrgContextError
 * (401 no credential · 400 malformed · 403 not a member of the requested org).
 */
export async function resolveOrganizationContext(
  request: Request,
  env: Env,
  opts: ResolveOptions = {}
): Promise<OrganizationContext> {
  const authenticate = opts.authenticate ?? authenticatorFor(env);
  const principal = await authenticate(request, env);
  if (!principal) throw new OrgContextError("authentication required", 401);

  // The REQUESTED organization — never trusted on its own.
  let requestedOrg: string | null = null;
  let orgSource: OrganizationContext["orgSource"] = "env";
  const headerOrg = request.headers.get(ORG_HEADER)?.trim();
  if (headerOrg) {
    if (!isUuid(headerOrg)) throw new OrgContextError(`${ORG_HEADER} is not a UUID`, 400);
    requestedOrg = headerOrg.toLowerCase();
    orgSource = "header";
  } else if (principal.kind === "auth_user" && principal.orgId) {
    if (!isUuid(principal.orgId)) throw new OrgContextError("token org claim is not a UUID", 401);
    requestedOrg = principal.orgId.toLowerCase();
    orgSource = "principal";
  } else {
    const envOrg = (env.ORGANIZATION_ID ?? "").trim().toLowerCase();
    if (envOrg) {
      if (!isUuid(envOrg)) throw new OrgContextError("ORGANIZATION_ID is not a UUID", 500);
      requestedOrg = envOrg;
    }
  }
  if (!requestedOrg) throw new OrgContextError(`organization context required (${ORG_HEADER})`, 400);

  // Membership lookup runs INSIDE an org-bound transaction (members is RLS-gated like
  // everything else), so a member of Org B asking for Org A simply finds no row → 403.
  const member = await runOrgTx(
    env,
    { organizationId: requestedOrg, actorId: "", role: "" },
    async (tx) => {
      const rows =
        principal.kind === "member"
          ? await tx<MemberRow[]>`
              select id, organization_id, role, is_admin, active
                from shared.members
               where organization_id = ${requestedOrg} and deleted_at is null and id = ${principal.memberId}
               limit 1`
          : await tx<MemberRow[]>`
              select id, organization_id, role, is_admin, active
                from shared.members
               where organization_id = ${requestedOrg} and deleted_at is null and auth_user_id = ${principal.authUserId}
               limit 1`;
      return rows[0] ?? null;
    },
    { sql: opts.sql, readOnly: true }
  );
  if (!member) throw new OrgContextError("not a member of the requested organization", 403);

  return {
    organizationId: member.organization_id,
    actorId: member.id,
    role: member.role,
    isAdmin: member.is_admin,
    revoked: !member.active,
    orgSource,
    authSource: principal.source,
    env,
  };
}

/**
 * W2 — the scheduled() handler's context for ONE Organization: no member, no admin powers,
 * app.user_id = '' and app.role = 'system'. Events it writes carry actor NULL / actor_type
 * 'system'. Still goes through withOrg (SET LOCAL app.org_id) — the cron is not a bypass.
 */
export function systemContext(env: Env, organizationId: string): OrganizationContext {
  if (!isUuid(organizationId)) throw new DbError(`systemContext: organizationId is not a UUID (${String(organizationId)})`);
  return {
    organizationId: organizationId.toLowerCase(),
    actorId: "",
    role: "system",
    isAdmin: false,
    revoked: false,
    orgSource: "env",
    authSource: "system",
    env,
  };
}

//------------------------------------------------------------------------------
// 4. withOrg — the ONLY way a sync route touches the database
//------------------------------------------------------------------------------

export interface OrgTxOptions {
  /** Reuse an existing client (caller owns its lifecycle); otherwise one is built and ended here. */
  sql?: Sql;
  /** BEGIN READ ONLY (any write raises 25006). */
  readOnly?: boolean;
}

/** Per-request client. Same options as db.ts: prepare:false (pooler-safe), fetch_types:false. */
export function getOrgSql(env: Env): Sql {
  const hd = env.HYPERDRIVE?.connectionString;
  const url = hd || env.DATABASE_URL;
  if (!url) throw new DbError("No database configured: bind HYPERDRIVE (prod) or set DATABASE_URL (test/dev only).");
  return postgres(url, { prepare: false, max: 5, fetch_types: false, idle_timeout: 20, connect_timeout: 10 });
}

/**
 * Run `fn` in ONE transaction bound to ctx's Organization:
 *   BEGIN; select set_config('app.org_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true); …; COMMIT
 */
export async function withOrg<T>(ctx: OrganizationContext, fn: (tx: Tx) => Promise<T>, opts: OrgTxOptions = {}): Promise<T> {
  return runOrgTx(ctx.env, { organizationId: ctx.organizationId, actorId: ctx.actorId, role: ctx.role }, fn, opts);
}

/** Same as withOrg() but READ ONLY. */
export async function withOrgRead<T>(ctx: OrganizationContext, fn: (tx: Tx) => Promise<T>, opts: OrgTxOptions = {}): Promise<T> {
  return runOrgTx(ctx.env, { organizationId: ctx.organizationId, actorId: ctx.actorId, role: ctx.role }, fn, { ...opts, readOnly: true });
}

interface Binding {
  organizationId: string;
  actorId: string;
  role: string;
}

async function runOrgTx<T>(env: Env, b: Binding, fn: (tx: Tx) => Promise<T>, opts: OrgTxOptions): Promise<T> {
  if (!isUuid(b.organizationId)) throw new DbError(`withOrg: organizationId is not a UUID (${String(b.organizationId)})`);
  if (b.actorId && !isUuid(b.actorId)) throw new DbError(`withOrg: actorId is not a UUID (${String(b.actorId)})`);
  const owned = !opts.sql;
  const sql = opts.sql ?? getOrgSql(env);
  try {
    const body = async (tx: Tx): Promise<T> => {
      // SET LOCAL ×3 — parameterised, transaction-scoped, dies with COMMIT/ROLLBACK.
      await tx`select set_config('app.org_id', ${b.organizationId}, true),
                      set_config('app.user_id', ${b.actorId}, true),
                      set_config('app.role', ${b.role}, true)`;
      return fn(tx);
    };
    const out = opts.readOnly ? await sql.begin("read only", body) : await sql.begin(body);
    return out as T;
  } finally {
    if (owned) await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
