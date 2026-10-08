// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08 — tombstone-resurrection guard on the drawings tables (room_polygons / location_placements) + copied_from_id round-trip
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

  it("W4 tombstone-resurrection guard (spec §5.5) on room_polygons / location_placements: a later push with deleted_at NULL cannot clear a newer tombstone (stale_tombstone), replaying the tombstone is a noop", async () => {
    const poly = syncSet(t, t.designer, { project_id: t.project, drawing_id: t.drawing, page_id: t.page1, room_id: t.rooms.foyer, polygon: { points: [[0, 0], [1, 0], [1, 1]] } });
    const pin = syncSet(t, t.designer, { project_id: t.project, drawing_id: t.drawing, page_id: t.page1, location_id: t.locationTv, room_id: t.rooms.kitchen, x: 1, y: 2, copied_from_id: null });
    const body = (rows: { table: string; row: Record<string, unknown> }[]) => ({ device_id: "test-device", rows });
    const send = async (rows: { table: string; row: Record<string, unknown> }[]) =>
      (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.designer, org: t.org, body: body(rows) }))).body as PushResult;
    expect((await send([{ table: "places.room_polygons", row: poly }, { table: "places.location_placements", row: pin }])).rejected).toEqual([]);
    const gone = new Date().toISOString();
    const r2 = await send([
      { table: "places.room_polygons", row: { ...poly, revision: 3, deleted_at: gone } },
      { table: "places.location_placements", row: { ...pin, revision: 3, deleted_at: gone } },
    ]);
    expect(r2.accepted.map((a) => a.op)).toEqual(["tombstoned", "tombstoned"]);
    // device B, offline since rev 1, edits at rev 2 (stale_revision) and even at rev 4 with deleted_at NULL (stale_tombstone)
    const r3 = await send([
      { table: "places.room_polygons", row: { ...poly, revision: 2, polygon: { points: [[5, 5], [6, 5], [6, 6]] } } },
      { table: "places.location_placements", row: { ...pin, revision: 2, x: 9 } },
      { table: "places.room_polygons", row: { ...poly, revision: 4, deleted_at: null, polygon: { points: [[5, 5], [6, 5], [6, 6]] } } },
      { table: "places.location_placements", row: { ...pin, revision: 4, deleted_at: null, x: 9 } },
    ]);
    expect(r3.rejected.map((x) => [x.table, x.reason])).toEqual([
      ["places.room_polygons", "stale_revision"], ["places.location_placements", "stale_revision"],
      ["places.room_polygons", "stale_tombstone"], ["places.location_placements", "stale_tombstone"],
    ]);
    const p = (await owner<Record<string, unknown>[]>`select deleted_at, revision, polygon from places.room_polygons where id = ${poly.id as string}`)[0];
    expect(p.deleted_at).not.toBeNull();
    expect(p.revision).toBe(3);
    expect(p.polygon).toEqual({ points: [[0, 0], [1, 0], [1, 1]] });
    const l = (await owner<Record<string, unknown>[]>`select deleted_at, revision, x from places.location_placements where id = ${pin.id as string}`)[0];
    expect(l.deleted_at).not.toBeNull();
    expect(l.revision).toBe(3);
    expect(Number(l.x)).toBe(1);
    // a replay of the tombstone itself is an idempotent noop; a NEWER tombstone-aware push (deleted_at set) still wins
    const r4 = await send([{ table: "places.room_polygons", row: { ...poly, revision: 3, deleted_at: gone } }, { table: "places.room_polygons", row: { ...poly, revision: 5, deleted_at: gone, metadata: { reason: "re-drawn" } } }]);
    expect(r4.accepted.map((a) => a.op)).toEqual(["noop", "updated"]);
    expect(await owner`select count(*)::int as n from shared.events where ref_id = ${poly.id as string}`.then((r) => r[0].n)).toBe(3); // rev 1, 3, 5
  });

  it("W4 (055): copied_from_id / answered_at / internal / archived_at round-trip through push", async () => {
    const q = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, kind: "question", body: "which wall?" });
    const media = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, file_id: null, internal: true });
    const file = syncSet(t, t.techA, { project_id: t.project, kind: "photo", filename: "b.jpg", content_type: "image/jpeg" });
    media.file_id = file.id;
    const r = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: { device_id: "d", rows: [
      { table: "places.location_notes", row: q }, { table: "shared.files", row: file }, { table: "places.location_media", row: media },
    ] } }))).body as PushResult;
    expect(r.rejected).toEqual([]);
    const answered = new Date().toISOString();
    const r2 = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: { device_id: "d", rows: [
      { table: "places.location_notes", row: { ...q, revision: 2, answered_at: answered, answered_by: t.office } },
      { table: "places.location_media", row: { ...media, revision: 2, archived_at: answered } },
    ] } }))).body as PushResult;
    expect(r2.rejected).toEqual([]);
    const n = (await owner<Record<string, unknown>[]>`select kind, answered_at, answered_by from places.location_notes where id = ${q.id as string}`)[0];
    expect(n.kind).toBe("question");
    expect(n.answered_by).toBe(t.office);
    expect(n.answered_at).toBeInstanceOf(Date);
    const m = (await owner<Record<string, unknown>[]>`select internal, archived_at from places.location_media where id = ${media.id as string}`)[0];
    expect(m.internal).toBe(true);
    expect(m.archived_at).toBeInstanceOf(Date);
    // an annotation of kind 'bracket' with copied_from_id pointing at a real row is accepted; a ghost copied_from_id → unknown_parent (FK)
    const a = syncSet(t, t.techA, { page_id: t.page1, layer_id: t.layerFieldNotes, kind: "bracket", geometry: { x: 1, y: 1, w: 5, h: 1 }, z: 1 });
    const b = syncSet(t, t.techA, { page_id: t.page1, layer_id: t.layerFieldNotes, kind: "polygon", geometry: { points: [[1, 1], [2, 2], [3, 1]] }, z: 2, copied_from_id: a.id });
    const ghost = syncSet(t, t.techA, { page_id: t.page1, layer_id: t.layerFieldNotes, kind: "pen", geometry: { points: [[1, 1]] }, z: 3, copied_from_id: crypto.randomUUID() });
    const r3 = (await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: { device_id: "d", rows: [
      { table: "drawings.annotations", row: a }, { table: "drawings.annotations", row: b }, { table: "drawings.annotations", row: ghost },
    ] } }))).body as PushResult;
    expect(r3.accepted.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(r3.rejected[0]).toMatchObject({ id: ghost.id, reason: "unknown_parent" });
    expect((await owner<{ copied_from_id: string }[]>`select copied_from_id from drawings.annotations where id = ${b.id as string}`)[0].copied_from_id).toBe(a.id);
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
