// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// org-context: the SET LOCAL binding fails CLOSED (walk spec §7 unpriced risk), and the
// requested-org / membership resolution denies anything it cannot prove.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, apiSql, createTestOrg, syncEnv, syncRequest, type Sql, type TestOrg } from "./_db";
import { resolveOrganizationContext, withOrg, withOrgRead, OrgContextError, ORG_HEADER } from "../../src/org-context";

const available = await dbAvailable();

describe.skipIf(!available)("org-context", () => {
  let owner: Sql;
  let api: Sql;
  let t: TestOrg;
  let other: TestOrg;
  const env = syncEnv();

  beforeAll(async () => {
    owner = ownerSql();
    api = apiSql();
    t = await createTestOrg(owner, "ctx-a");
    other = await createTestOrg(owner, "ctx-b");
  });
  afterAll(async () => {
    await api.end({ timeout: 2 });
    await owner.end({ timeout: 2 });
  });

  describe("RLS fails closed without the transaction binding (spec §7)", () => {
    it("a query path that FORGETS BEGIN / SET LOCAL sees zero rows as genesis_api", async () => {
      const rooms = await api`select id from places.rooms where project_id = ${t.project}`;
      expect(rooms.length).toBe(0);
      const members = await api`select id from shared.members where organization_id = ${t.org}`;
      expect(members.length).toBe(0);
    });

    it("a write without the binding is DENIED (RLS WITH CHECK → 42501), not silently accepted", async () => {
      await expect(
        api`insert into places.location_notes (id, organization_id, project_id, room_id, body, occurred_at, created_by)
             values (${crypto.randomUUID()}, ${t.org}, ${t.project}, ${t.rooms.foyer}, 'no context', now(), ${t.techA})`
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("SET LOCAL dies with its transaction: the next statement on the pool sees nothing again", async () => {
      const inside = await api.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${t.org}, true)`;
        return tx<{ n: string }[]>`select count(*)::text as n from places.rooms where project_id = ${t.project}`;
      });
      expect(Number(inside[0].n)).toBe(2);
      const after = await api`select id from places.rooms where project_id = ${t.project}`;
      expect(after.length).toBe(0);
    });
  });

  describe("resolveOrganizationContext", () => {
    it("401 with no credential", async () => {
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { org: t.org }), env, { sql: api }))
        .rejects.toMatchObject({ status: 401 });
    });

    it("400 when no organization context is requested and ORGANIZATION_ID is unset", async () => {
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techA }), env, { sql: api }))
        .rejects.toMatchObject({ status: 400 });
    });

    it("403 when the requested org is not one the actor belongs to (member of A asks for B)", async () => {
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techA, org: other.org }), env, { sql: api }))
        .rejects.toMatchObject({ status: 403 });
    });

    it("403 for an unknown member id, and for a soft-deleted member", async () => {
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: crypto.randomUUID(), org: t.org }), env, { sql: api }))
        .rejects.toMatchObject({ status: 403 });
      await owner`update shared.members set deleted_at = now() where id = ${t.office}`;
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.office, org: t.org }), env, { sql: api }))
        .rejects.toMatchObject({ status: 403 });
    });

    it("400 on a malformed header, 503 when no authenticator is configured", async () => {
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techA, headers: { [ORG_HEADER]: "not-a-uuid" } }), env, { sql: api }))
        .rejects.toMatchObject({ status: 400 });
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techA, org: t.org }), syncEnv({ SYNC_AUTH_MODE: undefined }), { sql: api }))
        .rejects.toBeInstanceOf(OrgContextError);
    });

    it("resolves role / is_admin / revoked server-side from shared.members (header or bearer)", async () => {
      const d = await resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.designer, org: t.org }), env, { sql: api });
      expect(d).toMatchObject({ organizationId: t.org, actorId: t.designer, role: "designer", isAdmin: true, revoked: false, orgSource: "header" });
      const r = await resolveOrganizationContext(syncRequest("GET", "/sync/pull", { bearer: t.revoked, org: t.org }), env, { sql: api });
      expect(r).toMatchObject({ actorId: t.revoked, role: "technician", isAdmin: false, revoked: true, authSource: "bearer_member_id" });
    });

    it("falls back to env.ORGANIZATION_ID as the REQUESTED org — still validated against membership", async () => {
      const envDefault = syncEnv({ ORGANIZATION_ID: t.org });
      const ok = await resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techB }), envDefault, { sql: api });
      expect(ok).toMatchObject({ organizationId: t.org, orgSource: "env" });
      await expect(resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: other.techA }), envDefault, { sql: api }))
        .rejects.toMatchObject({ status: 403 });
    });
  });

  describe("withOrg", () => {
    it("binds app.org_id / app.user_id / app.role for the transaction and the data becomes visible", async () => {
      const ctx = await resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techA, org: t.org }), env, { sql: api });
      const out = await withOrgRead(ctx, async (tx) => {
        const g = await tx<{ org: string; user: string; role: string }[]>`
          select current_setting('app.org_id', true) as org, current_setting('app.user_id', true) as "user", current_setting('app.role', true) as role`;
        const rooms = await tx<{ id: string }[]>`select id from places.rooms where project_id = ${t.project}`;
        return { g: g[0], rooms: rooms.length };
      }, { sql: api });
      expect(out.g).toEqual({ org: t.org, user: t.techA, role: "technician" });
      expect(out.rooms).toBe(2);
    });

    it("cannot see or write another Organization's rows even with a valid context of its own (acceptance §6.8)", async () => {
      const ctx = await resolveOrganizationContext(syncRequest("GET", "/sync/pull", { actor: t.techA, org: t.org }), env, { sql: api });
      const seen = await withOrgRead(ctx, (tx) => tx<{ id: string }[]>`select id from places.rooms where project_id = ${other.project}`, { sql: api });
      expect(seen.length).toBe(0);
      await expect(
        withOrg(ctx, (tx) => tx`insert into places.location_notes (id, organization_id, project_id, room_id, body, occurred_at, created_by)
                                 values (${crypto.randomUUID()}, ${other.org}, ${other.project}, ${other.rooms.foyer}, 'cross-org', now(), ${t.techA})`, { sql: api })
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
