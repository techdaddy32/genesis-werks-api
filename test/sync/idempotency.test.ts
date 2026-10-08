// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// Walk spec §6 check 1/5 precursor: the same batch pushed twice yields identical row
// state and EXACTLY one shared.events row per (table, id, revision).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, setCheckout, syncEnv, syncRequest, callSync, syncSet, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

describe.skipIf(!available)("push idempotency", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "idem");
    await setCheckout(owner, t, t.designer);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  const snapshot = async (ids: string[]) => {
    const rows = await owner<Record<string, unknown>[]>`
      select 'places.walks' as t, to_jsonb(w) - 'updated_at' as j from places.walks w where id in ${owner(ids)}
      union all select 'places.location_notes', to_jsonb(n) - 'updated_at' from places.location_notes n where id in ${owner(ids)}
      union all select 'places.location_media', to_jsonb(m) - 'updated_at' from places.location_media m where id in ${owner(ids)}
      union all select 'shared.files', to_jsonb(f) - 'updated_at' from shared.files f where id in ${owner(ids)}
      union all select 'places.rooms', to_jsonb(r) - 'updated_at' from places.rooms r where id in ${owner(ids)}
      order by 1`;
    return rows;
  };

  it("same batch twice → identical state, one event per (table,id,revision), no duplicate review rows", async () => {
    const walk = syncSet(t, t.techA, { project_id: t.project, status: "attached", started_at: new Date().toISOString(), checked_out_revision: 0 });
    const file = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, kind: "photo", filename: "a.jpg", content_type: "image/jpeg" });
    const media = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.foyer, file_id: file.id, caption: "door" });
    const flag = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.foyer, kind: "flag", body: "cracked box" });
    const note = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.kitchen, kind: "note", body: "ok" });
    const batch = {
      device_id: "test-device",
      walk_id: walk.id,
      rows: [
        { table: "places.walks", row: walk }, { table: "shared.files", row: file }, { table: "places.location_media", row: media },
        { table: "places.location_notes", row: flag }, { table: "places.location_notes", row: note },
      ],
      files: [{ file_id: file.id }],
    };
    const ids = [walk.id, file.id, media.id, flag.id, note.id] as string[];

    const first = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: batch }))).body as PushResult;
    expect(first.rejected).toEqual([]);
    expect(first.accepted.map((a) => a.op)).toEqual(["created", "created", "created", "created", "created"]);
    const stateA = await snapshot(ids);
    const eventsA = await owner<{ idempotency_key: string; event_type: string }[]>`
      select idempotency_key, event_type from shared.events where ref_id in ${owner(ids)} order by idempotency_key`;
    expect(eventsA.length).toBe(5);
    expect(eventsA.find((e) => e.idempotency_key === `places.location_notes:${flag.id}:1`)?.event_type).toBe("capture.flagged");

    const second = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: batch }))).body as PushResult;
    expect(second.rejected).toEqual([]);
    expect(second.accepted.map((a) => a.op)).toEqual(["noop", "noop", "noop", "noop", "noop"]);
    expect(second.accepted.map((a) => ({ table: a.table, id: a.id, revision: a.revision }))).toEqual(first.accepted.map((a) => ({ table: a.table, id: a.id, revision: a.revision })));
    expect(second.files).toEqual(first.files);

    const stateB = await snapshot(ids);
    expect(stateB).toEqual(stateA); // received_at unchanged too: a no-op replay does not touch the row
    const eventsB = await owner<{ idempotency_key: string }[]>`select idempotency_key from shared.events where ref_id in ${owner(ids)} order by idempotency_key`;
    expect(eventsB.map((e) => e.idempotency_key)).toEqual(eventsA.map((e) => e.idempotency_key));
    const rejections = await owner<{ n: string }[]>`select count(*)::text as n from places.sync_rejections where ref_id in ${owner(ids)}`;
    expect(Number(rejections[0].n)).toBe(0);
  });

  it("a structure row replayed at the same revision writes no second structure_changes row; a new revision writes one", async () => {
    const room = syncSet(t, t.designer, { project_id: t.project, name: "Laundry" });
    const body = { device_id: "test-device", rows: [{ table: "places.rooms", row: room }] };
    for (let i = 0; i < 3; i++) {
      const r = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designer, org: t.org, body }))).body as PushResult;
      expect(r.rejected).toEqual([]);
    }
    const count = async () => Number((await owner<{ n: string }[]>`select count(*)::text as n from places.structure_changes where ref_id = ${room.id as string}`)[0].n);
    expect(await count()).toBe(1);
    const r2 = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designer, org: t.org, body: { ...body, rows: [{ table: "places.rooms", row: { ...room, revision: 2, name: "Laundry Room" } }] } }))).body as PushResult;
    expect(r2.accepted[0].op).toBe("updated");
    expect(await count()).toBe(2);
    const ev = await owner<{ n: string }[]>`select count(*)::text as n from shared.events where ref_id = ${room.id as string}`;
    expect(Number(ev[0].n)).toBe(2);
  });

  it("one bad row does not poison its neighbours in the same transaction (per-row savepoints)", async () => {
    const good = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, body: "fine" });
    const fkBad = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, kind: "measurement", body: "x", custom: { } , location_id: crypto.randomUUID() });
    const good2 = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, body: "also fine" });
    const r = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: { device_id: "d", rows: [
      { table: "places.location_notes", row: good }, { table: "places.location_notes", row: fkBad }, { table: "places.location_notes", row: good2 },
    ] } }))).body as PushResult;
    expect(r.accepted.map((a) => a.id)).toEqual([good.id, good2.id]);
    expect(r.rejected).toEqual([{ table: "places.location_notes", id: fkBad.id, reason: "unknown_parent", detail: expect.stringContaining("location_id") }]);
  });
});
