// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
//==============================================================================
// test/sync/_db.ts — helpers for the walk-tool sync suite (NOT a test file).
//
// Targets the NEW schema (work/migrations 001→090) on a LOCAL throwaway Postgres —
// never Hyperdrive, never the real sandbox. Two URLs:
//   TEST_DATABASE_URL        — the `genesis_api` role (NOBYPASSRLS): what the Worker uses,
//                              so RLS is real in every test.
//   TEST_OWNER_DATABASE_URL  — the migrator/owner role: fixtures only (creating a fresh
//                              Organization needs INSERT on shared.organizations, which
//                              genesis_api deliberately lacks).
// Every suite builds its OWN fictitious Organization (fresh uuids) so re-runs are
// deterministic and suites never see each other's rows. Nothing here is FHI-real.
//==============================================================================

import postgres from "postgres";
import type { Env } from "../../src/types";
import { handleSyncRoute, type SyncResponse } from "../../src/sync/routes";
import type { FileSink } from "../../src/sync/files";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://genesis_api:test@127.0.0.1:54329/gw_sandbox";
export const TEST_OWNER_DATABASE_URL = process.env.TEST_OWNER_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/gw_sandbox";

export type Sql = postgres.Sql<{}>;

export function apiSql(max = 4): Sql {
  return postgres(TEST_DATABASE_URL, { prepare: false, max, fetch_types: false, connect_timeout: 5 });
}
export function ownerSql(max = 2): Sql {
  return postgres(TEST_OWNER_DATABASE_URL, { prepare: false, max, fetch_types: false, connect_timeout: 5 });
}

/** True when both URLs answer `select 1`. Never throws. */
export async function dbAvailable(): Promise<boolean> {
  for (const url of [TEST_DATABASE_URL, TEST_OWNER_DATABASE_URL]) {
    let sql: Sql | null = null;
    try {
      sql = postgres(url, { prepare: false, max: 1, fetch_types: false, connect_timeout: 3 });
      await sql`select 1 as one`;
    } catch {
      return false;
    } finally {
      if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
    }
  }
  return true;
}

/** In-memory stand-in for the R2 binding (only the `put` the upload path uses). */
export class MemorySink implements FileSink {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return { key };
  }
}

/** Worker Env for the sync routes: genesis_api URL, sandbox auth stub, in-memory FILES. */
export function syncEnv(overrides: Partial<Env> = {}, sink: FileSink = new MemorySink()): Env {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    SYNC_ROUTES: "on",
    SYNC_AUTH_MODE: "actor_header",
    FILES: sink as unknown as R2Bucket,
    ...overrides,
  } as unknown as Env;
}

export interface TestOrg {
  org: string;
  designer: string; // admin
  techA: string;
  techB: string;
  office: string;
  revoked: string; // technician, active = false
  account: string;
  project: string;
  drawing: string;
  whiteboard: string;
  version: string;
  page1: string;
  page2: string;
  boardPage: string;
  layerDesign: string; // structure
  layerFieldNotes: string; // capture
  layerBoard: string;
  rooms: { foyer: string; kitchen: string };
  locationTv: string;
}

const uuid = () => crypto.randomUUID();
const T0 = "2026-10-07T12:00:00Z";

/** Build a fresh fictitious Organization with the shapes the push/pull rules need. Owner connection. */
export async function createTestOrg(owner: Sql, label = "sync-test"): Promise<TestOrg> {
  const t: TestOrg = {
    org: uuid(), designer: uuid(), techA: uuid(), techB: uuid(), office: uuid(), revoked: uuid(),
    account: uuid(), project: uuid(), drawing: uuid(), whiteboard: uuid(), version: uuid(),
    page1: uuid(), page2: uuid(), boardPage: uuid(), layerDesign: uuid(), layerFieldNotes: uuid(), layerBoard: uuid(),
    rooms: { foyer: uuid(), kitchen: uuid() }, locationTv: uuid(),
  };
  const slug = `${label}-${t.org.slice(0, 8)}`;
  await owner.begin(async (tx) => {
    await tx`insert into shared.organizations (id, slug, display_name, custom) values (${t.org}, ${slug}, ${`Test Org ${slug}`}, '{"fictitious": true}')`;
    await tx`insert into shared.members (id, organization_id, email, display_name, role, is_admin, active) values
      (${t.designer}, ${t.org}, ${`designer@${slug}.example`}, 'Test Designer', 'designer', true, true),
      (${t.techA},    ${t.org}, ${`tech-a@${slug}.example`},   'Test Tech A',    'technician', false, true),
      (${t.techB},    ${t.org}, ${`tech-b@${slug}.example`},   'Test Tech B',    'technician', false, true),
      (${t.office},   ${t.org}, ${`office@${slug}.example`},   'Test Office',    'office', false, true),
      (${t.revoked},  ${t.org}, ${`revoked@${slug}.example`},  'Test Revoked',   'technician', false, false)`;
    await tx`insert into shared.accounts (id, organization_id, name) values (${t.account}, ${t.org}, 'Example Homeowner (test)')`;
    await tx`insert into shared.projects (id, organization_id, account_id, name, site_address, created_by)
             values (${t.project}, ${t.org}, ${t.account}, 'Test House — 1 Example Ct', '1 Example Ct, Exampleville FL', ${t.office})`;
    await tx`insert into places.structure_state (project_id, organization_id, working_revision, published_revision) values (${t.project}, ${t.org}, 1, 0)`;
    await tx`insert into drawings.drawings (id, organization_id, kind, project_id, working_title, attached_at, attached_by, occurred_at, created_by) values
      (${t.drawing},    ${t.org}, 'plan',       ${t.project}, 'Test plan set', ${T0}, ${t.office}, ${T0}, ${t.designer}),
      (${t.whiteboard}, ${t.org}, 'whiteboard', ${t.project}, 'Test board',    ${T0}, ${t.office}, ${T0}, ${t.designer})`;
    await tx`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, label, page_count, occurred_at, created_by)
             values (${t.version}, ${t.org}, ${t.drawing}, 1, 'v1', 2, ${T0}, ${t.designer})`;
    await tx`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, name, source_page_no, occurred_at, created_by) values
      (${t.page1},     ${t.org}, ${t.drawing},    ${t.version}, 1, 'Floor 1', 1, ${T0}, ${t.designer}),
      (${t.page2},     ${t.org}, ${t.drawing},    ${t.version}, 2, 'Floor 2', 2, ${T0}, ${t.designer}),
      (${t.boardPage}, ${t.org}, ${t.whiteboard}, null,         1, 'Board 1', null, ${T0}, ${t.designer})`;
    await tx`insert into drawings.layers (id, organization_id, drawing_id, name, ordinal, class, write_policy, export, occurred_at, created_by) values
      (${t.layerDesign},     ${t.org}, ${t.drawing},    'Design',      1, 'structure', 'designer_checkout', true, ${T0}, ${t.designer}),
      (${t.layerFieldNotes}, ${t.org}, ${t.drawing},    'Field Notes', 2, 'capture',   'any_member',        true, ${T0}, ${t.designer}),
      (${t.layerBoard},      ${t.org}, ${t.whiteboard}, 'Board',       1, 'capture',   'any_member',        true, ${T0}, ${t.designer})`;
    await tx`insert into places.rooms (id, organization_id, account_id, project_id, name, room_type, level, sort_order, occurred_at, created_by) values
      (${t.rooms.foyer},   ${t.org}, ${t.account}, ${t.project}, 'Foyer',   'entry',   '1', 1, ${T0}, ${t.designer}),
      (${t.rooms.kitchen}, ${t.org}, ${t.account}, ${t.project}, 'Kitchen', 'kitchen', '1', 2, ${T0}, ${t.designer})`;
    await tx`insert into places.locations (id, organization_id, account_id, project_id, room_id, label, occurred_at, created_by)
             values (${t.locationTv}, ${t.org}, ${t.account}, ${t.project}, ${t.rooms.kitchen}, 'Kitchen TV', ${T0}, ${t.designer})`;
  });
  return t;
}

/** Give `member` the live structure checkout (owner connection; the checkout routes are row W2). */
export async function setCheckout(owner: Sql, t: TestOrg, member: string | null, expiresInMs = 60 * 60 * 1000): Promise<void> {
  const expires = member ? new Date(Date.now() + expiresInMs) : null;
  await owner`update places.structure_state
                 set checkout_user_id = ${member}, checkout_device_id = ${member ? "test-device" : null},
                     checkout_at = ${member ? new Date() : null}, checkout_expires_at = ${expires}
               where project_id = ${t.project}`;
}

/** Owner-side publish (W2 owns the route): mirrors publish_revision's effect for test setup. */
export async function publishAsOwner(owner: Sql, t: TestOrg): Promise<{ published_revision: number; working_revision: number }> {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${t.org}, true)`;
    const rows = await tx<{ published_revision: number; working_revision: number }[]>`
      select published_revision, working_revision from places.publish_revision(${t.project}, ${t.designer}, null)`;
    return rows[0];
  }) as Promise<{ published_revision: number; working_revision: number }>;
}

export interface CallOptions {
  actor?: string | null;
  org?: string | null;
  bearer?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
}

/** Build a Request to the Worker's sync routes with the sandbox auth headers. */
export function syncRequest(method: string, path: string, o: CallOptions = {}): Request {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.actor) headers["X-Actor-Id"] = o.actor;
  if (o.org) headers["X-Organization-Id"] = o.org;
  if (o.bearer) headers["Authorization"] = `Bearer ${o.bearer}`;
  let body: BodyInit | undefined = o.rawBody;
  if (o.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  return new Request(`http://worker.test${path}`, { method, headers, body });
}

/** Call the sync router exactly the way index.ts does. */
export async function callSync(env: Env, request: Request): Promise<SyncResponse> {
  const url = new URL(request.url);
  const r = await handleSyncRoute(request, env, url.pathname, request.method.toUpperCase());
  if (!r) throw new Error(`not a sync path: ${url.pathname}`);
  return r;
}

/** The uniform sync set for a device-minted row (walk spec §5.1). */
export function syncSet(t: TestOrg, createdBy: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(),
    organization_id: t.org,
    revision: 1,
    occurred_at: new Date().toISOString(),
    device_id: "test-device",
    created_by: createdBy,
    walk_id: null,
    captured_revision: null,
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

/** Owner-side readers (bypass RLS) for assertions. */
export async function ownerRow(owner: Sql, table: string, id: string): Promise<Record<string, unknown> | null> {
  const rows = await owner<Record<string, unknown>[]>`select * from ${owner(table)} where id = ${id}`;
  return rows[0] ?? null;
}
export async function ownerCount(owner: Sql, table: string, where: Record<string, unknown>): Promise<number> {
  const keys = Object.keys(where);
  const conds = keys.map((k) => owner`${owner(k)} = ${where[k] as string}`);
  let clause = conds[0];
  for (let i = 1; i < conds.length; i++) clause = owner`${clause} and ${conds[i]}`;
  const rows = await owner<{ n: string }[]>`select count(*)::text as n from ${owner(table)} where ${clause}`;
  return Number(rows[0].n);
}
