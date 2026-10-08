// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08
// PATCH /annotations/:id {layer_id} — R-move (spec §2a Amendment 1 fix 2, §5.3, §6 check 3):
// same-class move = plain update; onto a structure layer = checkout-gated PROMOTION that mints
// exactly ONE new row + ONE structure_changes('annotation'), tombstoning the source with moved_to_id.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, setCheckout, syncEnv, syncRequest, callSync, syncSet, ownerEvents, ownerRow, ownerCount, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

describe.skipIf(!available)("PATCH /annotations/:id (R-move)", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[]) => {
    const r = await call("POST", actor, "/sync/push", { device_id: "pad-1", rows });
    expect(r.status).toBe(200);
    return r.body as PushResult;
  };
  const ann = (by: string, layer: string, over: Record<string, unknown> = {}) =>
    syncSet(t, by, { page_id: t.page1, layer_id: layer, kind: "callout", geometry: { x: 3, y: 4 }, z: 1, label: "box here", room_id: t.rooms.kitchen, ...over });
  const pageCount = () => ownerCount(owner, "drawings.annotations", { page_id: t.page1 });

  let roughIn: string;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "amove");
    const add = await call("POST", t.office, `/drawings/${t.drawing}/layers`, { name: "Rough-In", class: "capture", write_policy: "any_member", ordinal: 3 });
    expect(add.status).toBe(201);
    roughIn = (add.body as { layer: { id: string } }).layer.id;
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("400 without layer_id / with class; 404 unknown annotation; 404 layer of another drawing; same layer → noop", async () => {
    const a = ann(t.techA, t.layerFieldNotes);
    expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
    expect((await call("PATCH", t.techA, `/annotations/${a.id}`, {})).status).toBe(400);
    expect((await call("PATCH", t.techA, `/annotations/${a.id}`, { layer_id: roughIn, class: "structure" })).status).toBe(400);
    expect((await call("PATCH", t.techA, `/annotations/${crypto.randomUUID()}`, { layer_id: roughIn })).status).toBe(404);
    expect((await call("PATCH", t.techA, `/annotations/${a.id}`, { layer_id: t.layerBoard })).status).toBe(404);
    const same = await call("PATCH", t.techA, `/annotations/${a.id}`, { layer_id: t.layerFieldNotes });
    expect(same.status).toBe(200);
    expect((same.body as { op: string }).op).toBe("noop");
  });

  it("same-class move: another technician → 403; the owner → 200 plain update (revision + 1, class unchanged, event annotation.moved); office may move anyone's", async () => {
    const a = ann(t.techA, t.layerFieldNotes);
    expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
    expect((await call("PATCH", t.techB, `/annotations/${a.id}`, { layer_id: roughIn })).status).toBe(403);
    const before = await pageCount();
    const r = await call("PATCH", t.techA, `/annotations/${a.id}`, { layer_id: roughIn });
    expect(r.status).toBe(200);
    expect((r.body as { op: string; annotation: Record<string, unknown> }).op).toBe("moved");
    const row = (await ownerRow(owner, "drawings.annotations", a.id as string))!;
    expect(row.layer_id).toBe(roughIn);
    expect(row.class).toBe("capture");
    expect(row.revision).toBe(2);
    expect(row.deleted_at).toBeNull();
    expect(await pageCount()).toBe(before); // no new row on a same-class move
    expect((await ownerEvents(owner, { ref_id: a.id as string, event_type: "annotation.moved" })).length).toBe(1);
    expect(await ownerCount(owner, "places.structure_changes", { ref_id: a.id as string })).toBe(0);
    const back = await call("PATCH", t.office, `/annotations/${a.id}`, { layer_id: t.layerFieldNotes });
    expect(back.status).toBe(200);
    expect((await ownerRow(owner, "drawings.annotations", a.id as string))!.revision).toBe(3);
  });

  it("a locked target layer → 409 (an explicit PATCH is refused, not redirected)", async () => {
    const a = ann(t.techA, t.layerFieldNotes);
    expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
    await owner`update drawings.layers set locked = true, locked_by = ${t.office}, locked_at = now() where id = ${roughIn}`;
    try {
      const r = await call("PATCH", t.techA, `/annotations/${a.id}`, { layer_id: roughIn });
      expect(r.status).toBe(409);
      expect((await ownerRow(owner, "drawings.annotations", a.id as string))!.layer_id).toBe(t.layerFieldNotes);
    } finally {
      await owner`update drawings.layers set locked = false, locked_by = null, locked_at = null where id = ${roughIn}`;
    }
  });

  it("promotion (§6 check 3): office moves a tech's callout onto Design without a checkout → 409; with another holder → 403; the holder → 201: exactly ONE new structure row (rev 1), source tombstoned with moved_to_id, class never re-stamped, ONE structure_changes('annotation')", async () => {
    const a = ann(t.techA, t.layerFieldNotes, { label: "move me up" });
    expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
    await setCheckout(owner, t, null);
    const none = await call("PATCH", t.office, `/annotations/${a.id}`, { layer_id: t.layerDesign });
    expect(none.status).toBe(409);
    await setCheckout(owner, t, t.designerB);
    const notHolder = await call("PATCH", t.office, `/annotations/${a.id}`, { layer_id: t.layerDesign });
    expect(notHolder.status).toBe(403);
    expect((notHolder.body as { holder: string }).holder).toBe(t.designerB);
    expect((await ownerRow(owner, "drawings.annotations", a.id as string))!).toMatchObject({ layer_id: t.layerFieldNotes, class: "capture", deleted_at: null, moved_to_id: null });

    const before = await pageCount();
    const r = await call("PATCH", t.designerB, `/annotations/${a.id}`, { layer_id: t.layerDesign });
    expect(r.status).toBe(201);
    const b = r.body as { op: string; annotation: Record<string, unknown>; source: Record<string, unknown> };
    expect(b.op).toBe("promoted");
    expect(await pageCount()).toBe(before + 1); // exactly one new row
    const nu = (await ownerRow(owner, "drawings.annotations", b.annotation.id as string))!;
    expect(nu).toMatchObject({ layer_id: t.layerDesign, class: "structure", revision: 1, created_by: t.designerB, label: "move me up", room_id: t.rooms.kitchen, page_id: t.page1, deleted_at: null, moved_to_id: null, redirected_from_layer_id: null });
    expect(nu.geometry).toEqual({ x: 3, y: 4 });
    const src = (await ownerRow(owner, "drawings.annotations", a.id as string))!;
    expect(src.class).toBe("capture"); // never re-stamped
    expect(src.layer_id).toBe(t.layerFieldNotes); // never moved
    expect(src.deleted_at).not.toBeNull();
    expect(src.deleted_by).toBe(t.designerB);
    expect(src.moved_to_id).toBe(nu.id);
    expect(src.revision).toBe(2);
    expect(b.source.moved_to_id).toBe(nu.id);
    const sc = await owner<Record<string, unknown>[]>`select * from places.structure_changes where ref_table = 'drawings.annotations' and ref_id in (${nu.id as string}, ${a.id as string})`;
    expect(sc.length).toBe(1);
    expect(sc[0]).toMatchObject({ ref_id: nu.id, change_kind: "annotation", project_id: t.project, revision: 1, room_id: t.rooms.kitchen, drawing_id: t.drawing, review_outcome: null });
    expect((sc[0].diff as { op: string; source_annotation_id: string }).op).toBe("promoted");
    expect((sc[0].diff as { source_annotation_id: string }).source_annotation_id).toBe(a.id);
    expect((await ownerEvents(owner, { ref_id: nu.id as string, event_type: "annotation.promoted" })).length).toBe(1);
    expect((await ownerEvents(owner, { ref_id: a.id as string })).map((e) => (e.payload as { op: string }).op)).toContain("tombstoned");
    // the proposal sits in the designer's review
    const rv = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as { groups: { changes: { ref_id: string; change_kind: string }[] }[] };
    expect(rv.groups.flatMap((g) => g.changes).find((c) => c.ref_id === nu.id)?.change_kind).toBe("annotation");
    // the tombstoned source cannot be moved again; a stale device edit cannot resurrect it either
    expect((await call("PATCH", t.techA, `/annotations/${a.id}`, { layer_id: roughIn })).status).toBe(409);
    const late = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 5, label: "still here?" } }]);
    expect(late.rejected[0]).toMatchObject({ id: a.id, reason: "stale_tombstone" });
    // structure → capture is never a move (class is stamped once)
    expect((await call("PATCH", t.designerB, `/annotations/${nu.id}`, { layer_id: t.layerFieldNotes })).status).toBe(409);
    // a technician aiming the NEW structure row at another structure layer: not the holder → 403
    const design2 = await call("POST", t.designerB, `/drawings/${t.drawing}/layers`, { name: "Design B", class: "structure", write_policy: "designer_checkout" });
    expect(design2.status).toBe(201);
    const d2 = (design2.body as { layer: { id: string } }).layer.id;
    expect((await call("PATCH", t.office, `/annotations/${nu.id}`, { layer_id: d2 })).status).toBe(403);
    const mv = await call("PATCH", t.designerB, `/annotations/${nu.id}`, { layer_id: d2 });
    expect(mv.status).toBe(200);
    expect((await ownerRow(owner, "drawings.annotations", nu.id as string))!).toMatchObject({ layer_id: d2, class: "structure", revision: 2 });
  });

  it("promotion on an UNATTACHED drawing → 409 (no project, nothing to check out); on a whiteboard there is no structure layer to aim at", async () => {
    const quick = syncSet(t, t.techA, { kind: "plan", working_title: "Quick plan" });
    const r0 = await push(t.techA, [{ table: "drawings.drawings", row: quick }]);
    const design = r0.created_layers.find((l) => l.name === "Design")!.id;
    const notes = r0.created_layers.find((l) => l.name === "Field Notes")!.id;
    const page = syncSet(t, t.techA, { drawing_id: quick.id, ordinal: 1, name: "A" });
    const a = syncSet(t, t.techA, { page_id: page.id, layer_id: notes, kind: "pen", geometry: { points: [[1, 1], [2, 2]] }, z: 1 });
    expect((await push(t.techA, [{ table: "drawings.pages", row: page }, { table: "drawings.annotations", row: a }])).rejected).toEqual([]);
    await setCheckout(owner, t, t.designerB);
    const r = await call("PATCH", t.designerB, `/annotations/${a.id}`, { layer_id: design });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("not attached");
    expect((await ownerRow(owner, "drawings.annotations", a.id as string))!.deleted_at).toBeNull();
    expect(await ownerCount(owner, "drawings.annotations", { page_id: page.id as string })).toBe(1);
  });
});
