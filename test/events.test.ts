//==============================================================================
// events.test.ts — appendEvent(): exact 0001 columns, idempotency on
// idempotency_key (second call returns the stored row, inserted=false, even
// concurrently), append-only enforcement, and the /internal/events/fanout
// stub's auth + parsing (no DB needed for that part).
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenant, withTenantRead, type Sql } from "../src/db";
import { appendEvent, listEntityEvents, handleEventFanout } from "../src/events";
import { dbAvailable, testEnv, createScratchTenant, sharedSql } from "./_pg";

const up = await dbAvailable();

describe("POST /internal/events/fanout (stub, no database)", () => {
  const payload = {
    type: "INSERT",
    table: "events",
    schema: "public",
    record: { id: "0192b5a1-7c3e-7c3a-8f1a-1234567890ab", tenant_id: "t", entity: "work_order", event_type: "work_order.created" },
    old_record: null,
  };
  const post = (headers: Record<string, string>, body: unknown = payload) =>
    new Request("https://x/internal/events/fanout", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("is disabled (503) when INTERNAL_TOKEN is unset", async () => {
    const r = await handleEventFanout(post({ "X-Internal-Token": "x" }), testEnv({ INTERNAL_TOKEN: undefined }));
    expect(r.status).toBe(503);
  });

  it("rejects a missing or wrong token (401)", async () => {
    const env = testEnv({ INTERNAL_TOKEN: "s3cret" });
    expect((await handleEventFanout(post({}), env)).status).toBe(401);
    expect((await handleEventFanout(post({ "X-Internal-Token": "nope" }), env)).status).toBe(401);
  });

  it("rejects malformed bodies (400) and accepts a webhook payload (202)", async () => {
    const env = testEnv({ INTERNAL_TOKEN: "s3cret" });
    expect((await handleEventFanout(post({ "X-Internal-Token": "s3cret" }, "not json"), env)).status).toBe(400);
    expect((await handleEventFanout(post({ "X-Internal-Token": "s3cret" }, { hello: 1 }), env)).status).toBe(400);
    const ok = await handleEventFanout(post({ "X-Internal-Token": "s3cret" }), env);
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({
      ok: true,
      handled: false,
      accepted: { type: "INSERT", table: "events", entity: "work_order", eventType: "work_order.created" },
    });
  });
});

describe.skipIf(!up)("events.ts appendEvent against Postgres", () => {
  const env = testEnv();
  let sql: Sql;
  let tenant: string;

  beforeAll(async () => {
    sql = sharedSql(8);
    tenant = await createScratchTenant(env, sql, "events");
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("inserts with the 0001 column names and defaults", async () => {
    const entityId = crypto.randomUUID();
    const { event, inserted } = await withTenant(env, tenant, (tx) =>
      appendEvent(tx, {
        entity: "work_order",
        entityId,
        eventType: "work_order.created",
        payload: { number: "FHI-672-WO-2026-0001" },
        actor: "craig@fhiflorida.com",
      }), { sql });
    expect(inserted).toBe(true);
    expect(event).toMatchObject({
      tenant_id: tenant,
      entity: "work_order",
      entity_id: entityId,
      event_type: "work_order.created",
      payload: { number: "FHI-672-WO-2026-0001" },
      actor: "craig@fhiflorida.com",
      idempotency_key: null,
      schema_version: 1,
    });
    expect(event.occurred_at).toBeInstanceOf(Date);
    expect(event.created_at).toBeInstanceOf(Date);

    const listed = await withTenantRead(env, tenant, (tx) => listEntityEvents(tx, "work_order", entityId), { sql });
    expect(listed.map((e) => e.id)).toEqual([event.id]);
  });

  it("is idempotent on idempotency_key (returns the existing row)", async () => {
    const key = `webhook:${crypto.randomUUID()}`;
    const mk = (n: number) =>
      withTenant(env, tenant, (tx) =>
        appendEvent(tx, { entity: "visit", eventType: "visit.calendar_failed", payload: { attempt: n }, idempotencyKey: key }), { sql });
    const first = await mk(1);
    const second = await mk(2);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.payload).toEqual({ attempt: 1 });

    const rows = await withTenantRead(env, tenant, (tx) => tx`select id from public.events where idempotency_key = ${key}`, { sql });
    expect(rows.length).toBe(1);
  });

  it("stays idempotent under concurrent retries", async () => {
    const key = `retry:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withTenant(env, tenant, (tx) =>
          appendEvent(tx, { entity: "item", eventType: "item.requested", payload: { i }, idempotencyKey: key }), { sql })
      )
    );
    expect(results.filter((r) => r.inserted).length).toBe(1);
    expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
  });

  it("the same idempotency key is independent per tenant", async () => {
    const other = await createScratchTenant(env, sql, "events-2");
    const key = `shared:${crypto.randomUUID()}`;
    const a = await withTenant(env, tenant, (tx) => appendEvent(tx, { entity: "x", eventType: "x.y", idempotencyKey: key }), { sql });
    const b = await withTenant(env, other, (tx) => appendEvent(tx, { entity: "x", eventType: "x.y", idempotencyKey: key }), { sql });
    expect(a.inserted && b.inserted).toBe(true);
    expect(a.event.id).not.toBe(b.event.id);
  });

  it("events are append-only (UPDATE/DELETE rejected)", async () => {
    const { event } = await withTenant(env, tenant, (tx) => appendEvent(tx, { entity: "x", eventType: "x.immutable" }), { sql });
    await expect(
      withTenant(env, tenant, (tx) => tx`update public.events set actor = 'hacker' where id = ${event.id}`, { sql })
    ).rejects.toThrow(/append-only|permission denied/);
    await expect(
      withTenant(env, tenant, (tx) => tx`delete from public.events where id = ${event.id}`, { sql })
    ).rejects.toThrow(/append-only|permission denied/);
  });
});
