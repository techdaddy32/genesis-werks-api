// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
// Checkout lease routes (walk spec L6, §5.6, §6 checks 2 + 7) + the lease-warning cron.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, syncSet, ownerEvents,
  type Sql, type TestOrg,
} from "./_db";
import type { PushResult } from "../../src/sync/push";
import { parseDurationMs, sweepLeaseWarnings } from "../../src/sync/checkout";
import { systemContext } from "../../src/org-context";
import { runSyncCron } from "../../src/sync/cron";

const available = await dbAvailable();

describe.skipIf(!available)("checkout routes", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();

  const post = (actor: string, path: string, body?: unknown) => callSync(env, syncRequest("POST", path, { actor, org: t.org, body: body ?? {} }));
  const state = async () => (await owner<Record<string, unknown>[]>`select * from places.structure_state where project_id = ${t.project}`)[0];

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "checkout");
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("parseDurationMs understands numbers (seconds), unit strings, HH:MM:SS and rejects junk", () => {
    expect(parseDurationMs(3600)).toBe(3_600_000);
    expect(parseDurationMs("24h")).toBe(86_400_000);
    expect(parseDurationMs("90 minutes")).toBe(5_400_000);
    expect(parseDurationMs("1 day")).toBe(86_400_000);
    expect(parseDurationMs("00:30:00")).toBe(1_800_000);
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs(null)).toBeNull();
  });

  it("technician cannot take the checkout (403); designer takes it with the 24h default lease; event checkout.taken", async () => {
    expect((await post(t.techA, `/projects/${t.project}/checkout`)).status).toBe(403);
    const r = await post(t.designerB, `/projects/${t.project}/checkout`, { device_id: "designer-b-laptop" });
    expect(r.status).toBe(200);
    const body = r.body as { op: string; structure_state: Record<string, unknown> };
    expect(body.op).toBe("taken");
    expect(body.structure_state.checkout_user_id).toBe(t.designerB);
    expect(body.structure_state.lease_source).toBe("default");
    const s = await state();
    expect(s.checkout_user_id).toBe(t.designerB);
    expect(s.checkout_device_id).toBe("designer-b-laptop");
    const ms = (s.checkout_expires_at as Date).getTime() - (s.checkout_at as Date).getTime();
    expect(ms).toBeGreaterThan(23.9 * 3_600_000);
    expect(ms).toBeLessThanOrEqual(24 * 3_600_000);
    const ev = await ownerEvents(owner, { ref_id: t.project, event_type: "checkout.taken" });
    expect(ev.length).toBe(1);
    expect(ev[0].actor).toBe(t.designerB);
  });

  it("a second designer gets 409 while the lease is live (even an admin designer — no bypass on take)", async () => {
    const r = await post(t.designer, `/projects/${t.project}/checkout`);
    expect(r.status).toBe(409);
    expect((r.body as { holder: string }).holder).toBe(t.designerB);
    expect((await state()).checkout_user_id).toBe(t.designerB);
  });

  it("the holder's structure push is accepted; the other designer's is rejected no_checkout (spec §6.2)", async () => {
    const roomOk = syncSet(t, t.designerB, { project_id: t.project, name: "Pantry", room_type: "pantry" });
    const a = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designerB, org: t.org, body: { device_id: "d", rows: [{ table: "places.rooms", row: roomOk }] } }))).body as PushResult;
    expect(a.accepted.length).toBe(1);
    const roomNo = syncSet(t, t.designer, { project_id: t.project, name: "Garage" });
    const b = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designer, org: t.org, body: { device_id: "d", rows: [{ table: "places.rooms", row: roomNo }] } }))).body as PushResult;
    expect(b.rejected[0]?.reason).toBe("no_checkout");
  });

  it("renew: holder extends (event checkout.renewed); non-holder 403", async () => {
    const before = (await state()).checkout_expires_at as Date;
    await new Promise((r) => setTimeout(r, 20));
    const r = await post(t.designerB, `/projects/${t.project}/checkout/renew`);
    expect(r.status).toBe(200);
    expect(((await state()).checkout_expires_at as Date).getTime()).toBeGreaterThan(before.getTime());
    expect((await post(t.designer, `/projects/${t.project}/checkout/renew`)).status).toBe(403);
    expect((await ownerEvents(owner, { ref_id: t.project, event_type: "checkout.renewed" })).length).toBe(1);
  });

  it("override: designer (non-admin) 403; admin takes the lease, override_by/at written, event checkout.overridden", async () => {
    expect((await post(t.designerB, `/projects/${t.project}/checkout/override`)).status).toBe(403);
    expect((await post(t.techA, `/projects/${t.project}/checkout/override`)).status).toBe(403);
    const r = await post(t.designer, `/projects/${t.project}/checkout/override`, { device_id: "admin-desk" });
    expect(r.status).toBe(200);
    expect((r.body as { previous_holder: string }).previous_holder).toBe(t.designerB);
    const s = await state();
    expect(s.checkout_user_id).toBe(t.designer);
    expect(s.checkout_override_by).toBe(t.designer);
    expect(s.checkout_override_at).toBeInstanceOf(Date);
    const ev = await ownerEvents(owner, { ref_id: t.project, event_type: "checkout.overridden" });
    expect(ev.length).toBe(1);
    expect((ev[0].payload as { previous_holder: string }).previous_holder).toBe(t.designerB);
    // the displaced designer's structure push now rejects no_checkout — override is the ONLY admin path
    const room = syncSet(t, t.designerB, { project_id: t.project, name: "Loft" });
    const p = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designerB, org: t.org, body: { device_id: "d", rows: [{ table: "places.rooms", row: room }] } }))).body as PushResult;
    expect(p.rejected[0]?.reason).toBe("no_checkout");
  });

  it("release: non-holder non-admin 403; holder releases → all checkout columns NULL; event checkout.released", async () => {
    expect((await post(t.designerB, `/projects/${t.project}/checkout/release`)).status).toBe(403);
    const r = await post(t.designer, `/projects/${t.project}/checkout/release`);
    expect(r.status).toBe(200);
    const s = await state();
    expect(s.checkout_user_id).toBeNull();
    expect(s.checkout_expires_at).toBeNull();
    expect((await ownerEvents(owner, { ref_id: t.project, event_type: "checkout.released" })).length).toBe(1);
    // and a release with nothing held is a 200 noop
    expect(((await post(t.designer, `/projects/${t.project}/checkout/release`)).body as { op: string }).op).toBe("noop");
  });

  it("expired lease: a new checkout succeeds; the old holder's structure edit is checkout_expired (spec §6.7)", async () => {
    await post(t.designerB, `/projects/${t.project}/checkout`);
    await owner`update places.structure_state set checkout_expires_at = now() - interval '1 minute' where project_id = ${t.project}`;
    const room = syncSet(t, t.designerB, { project_id: t.project, name: "Den" });
    const p = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designerB, org: t.org, body: { device_id: "d", rows: [{ table: "places.rooms", row: room }] } }))).body as PushResult;
    expect(p.rejected[0]?.reason).toBe("checkout_expired");
    expect((await post(t.designerB, `/projects/${t.project}/checkout/renew`)).status).toBe(409);
    const r = await post(t.designer, `/projects/${t.project}/checkout`);
    expect(r.status).toBe(200);
    expect((await state()).checkout_user_id).toBe(t.designer);
  });

  it("org_settings designer_lease is honoured (string with unit)", async () => {
    await owner`insert into shared.org_settings (organization_id, key, value) values (${t.org}, 'designer_lease', '"2h"'::jsonb), (${t.org}, 'designer_lease_warn', '"30m"'::jsonb)
                on conflict (organization_id, key) do update set value = excluded.value`;
    const r = await post(t.designer, `/projects/${t.project}/checkout/renew`);
    expect(r.status).toBe(200);
    const b = r.body as { structure_state: { lease_ms: number; warn_ms: number; lease_source: string } };
    expect(b.structure_state.lease_ms).toBe(7_200_000);
    expect(b.structure_state.warn_ms).toBe(1_800_000);
    expect(b.structure_state.lease_source).toBe("org_settings");
  });

  it("cron: checkout.expiring fires once per lease inside the warn window, to the holder, as system", async () => {
    const ctx = systemContext(env, t.org);
    // outside the window (2h lease, 30m warn) → nothing
    let r = await sweepLeaseWarnings(ctx);
    expect(r.live).toBe(1);
    expect(r.warned).toEqual([]);
    // move expiry to 10 minutes out → warn
    await owner`update places.structure_state set checkout_expires_at = now() + interval '10 minutes' where project_id = ${t.project}`;
    r = await sweepLeaseWarnings(ctx);
    expect(r.warned).toEqual([t.project]);
    r = await sweepLeaseWarnings(ctx);
    expect(r.warned).toEqual([]); // once per lease
    const ev = await ownerEvents(owner, { ref_id: t.project, event_type: "checkout.expiring" });
    expect(ev.length).toBe(1);
    expect(ev[0].actor).toBeNull();
    expect(ev[0].actor_type).toBe("system");
    expect((ev[0].payload as { recipient: string }).recipient).toBe(t.designer);
    // a renew moves expires_at → a fresh warning is possible later (new key) — prove the key changes
    await post(t.designer, `/projects/${t.project}/checkout/renew`);
    await owner`update places.structure_state set checkout_expires_at = now() + interval '5 minutes' where project_id = ${t.project}`;
    r = await sweepLeaseWarnings(ctx);
    expect(r.warned).toEqual([t.project]);
    expect((await ownerEvents(owner, { ref_id: t.project, event_type: "checkout.expiring" })).length).toBe(2);
  });

  it("runSyncCron sweeps the org named by ORGANIZATION_ID / SYNC_CRON_ORGANIZATION_IDS and reports per step", async () => {
    const r = await runSyncCron(syncEnv({ SYNC_CRON_ORGANIZATION_IDS: `${t.org}, ${t.org}` }));
    expect(r.organizations).toEqual([t.org]);
    expect(r.errors).toEqual([]);
    expect(r.leases.length).toBe(1);
    expect(r.files.length).toBe(1);
    expect(r.orphans.length).toBe(1);
  });

  it("404 for a project outside the organization (RLS), 400 for a non-UUID", async () => {
    expect((await post(t.designer, `/projects/${crypto.randomUUID()}/checkout`)).status).toBe(404);
    expect((await post(t.designer, `/projects/not-a-uuid/checkout`)).status).toBe(400);
  });
});
