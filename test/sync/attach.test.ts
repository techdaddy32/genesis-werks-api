// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
// POST /walks/:id/attach — in place, no rekey; room_hint → room_id; room_hint_pending rows (walk spec §5.2, §6 check 4).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, syncSet, ownerEvents, ownerRow, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

interface AttachBody {
  op: string;
  walk_id: string;
  project_id: string;
  resolved_rooms: { room_hint: string; room_id: string; room_name: string; rows: number }[];
  room_hint_pending: { room_hint: string; change_id: string; rows: Record<string, number> }[];
  rows_touched: Record<string, number>;
}

describe.skipIf(!available)("POST /walks/:id/attach", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[], walkId?: string) =>
    (await call("POST", actor, "/sync/push", { device_id: "phone-a", walk_id: walkId, rows })).body as PushResult;

  let walk: Record<string, unknown>;
  let kitchenNote: Record<string, unknown>;
  let kitchenMedia: Record<string, unknown>;
  let flexNote1: Record<string, unknown>;
  let flexNote2: Record<string, unknown>;
  let noHintNote: Record<string, unknown>;
  let file: Record<string, unknown>;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "attach");
    // a DRAFT walk pushed unattached with hinted captures (project_id / room_id NULL — the W1 draft rule)
    walk = syncSet(t, t.techA, { project_id: null, status: "draft", label: "quick walk", started_at: new Date().toISOString() });
    file = syncSet(t, t.techA, { walk_id: walk.id, kind: "photo", filename: "k.jpg", content_type: "image/jpeg" });
    kitchenNote = syncSet(t, t.techA, { walk_id: walk.id, room_hint: "  kitchen ", kind: "note", body: "island outlets" });
    kitchenMedia = syncSet(t, t.techA, { walk_id: walk.id, room_hint: "KITCHEN", file_id: file.id, caption: "range wall" });
    flexNote1 = syncSet(t, t.techA, { walk_id: walk.id, room_hint: "Flex Rm", kind: "note", body: "ceiling speakers?" });
    flexNote2 = syncSet(t, t.techA, { walk_id: walk.id, room_hint: "flex rm", kind: "flag", body: "no power here" });
    noHintNote = syncSet(t, t.techA, { walk_id: walk.id, kind: "note", body: "general" });
    const r = await push(t.techA, [
      { table: "places.walks", row: walk }, { table: "shared.files", row: file }, { table: "places.location_notes", row: kitchenNote },
      { table: "places.location_media", row: kitchenMedia }, { table: "places.location_notes", row: flexNote1 },
      { table: "places.location_notes", row: flexNote2 }, { table: "places.location_notes", row: noHintNote },
    ], walk.id as string);
    expect(r.rejected).toEqual([]);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("push cannot attach an existing draft walk (schema rejection names the attach route)", async () => {
    const r = await push(t.techA, [{ table: "places.walks", row: { ...walk, revision: 2, project_id: t.project, status: "attached" } }]);
    expect(r.rejected.length).toBe(1);
    expect(r.rejected[0].reason).toBe("schema");
    expect(r.rejected[0].detail).toContain("/walks/:id/attach");
    expect((await ownerRow(owner, "places.walks", walk.id as string))!.project_id).toBeNull();
  });

  it("400 without project_id; 404 unknown walk / project; a stranger technician gets 403", async () => {
    expect((await call("POST", t.techA, `/walks/${walk.id}/attach`, {})).status).toBe(400);
    expect((await call("POST", t.techA, `/walks/${crypto.randomUUID()}/attach`, { project_id: t.project })).status).toBe(404);
    expect((await call("POST", t.techA, `/walks/${walk.id}/attach`, { project_id: crypto.randomUUID() })).status).toBe(404);
    expect((await call("POST", t.techB, `/walks/${walk.id}/attach`, { project_id: t.project })).status).toBe(403);
  });

  it("attach: same id, Kitchen resolves (case/space-insensitive), Flex Rm → ONE room_hint_pending; event walk.attached", async () => {
    const r = await call("POST", t.techA, `/walks/${walk.id}/attach`, { project_id: t.project });
    expect(r.status).toBe(200);
    const b = r.body as AttachBody;
    expect(b.op).toBe("attached");
    expect(b.walk_id).toBe(walk.id);
    expect(b.resolved_rooms).toEqual([{ room_hint: "kitchen", room_id: t.rooms.kitchen, room_name: "Kitchen", rows: 2 }]);
    expect(b.room_hint_pending.length).toBe(1);
    expect(b.room_hint_pending[0].room_hint).toBe("Flex Rm");
    expect(b.room_hint_pending[0].rows).toEqual({ "places.location_notes": 2 });

    const w = (await ownerRow(owner, "places.walks", walk.id as string))!;
    expect(w.project_id).toBe(t.project);
    expect(w.status).toBe("attached");
    expect(w.attached_by).toBe(t.techA);
    expect(w.attached_at).toBeInstanceOf(Date);
    expect(w.revision).toBe(1); // no rekey, no server revision bump

    for (const id of [kitchenNote.id, kitchenMedia.id] as string[]) {
      const row = (await owner<Record<string, unknown>[]>`select project_id, room_id from places.location_notes where id = ${id}
                                                           union all select project_id, room_id from places.location_media where id = ${id}`)[0];
      expect(row.project_id).toBe(t.project);
      expect(row.room_id).toBe(t.rooms.kitchen);
    }
    for (const id of [flexNote1.id, flexNote2.id, noHintNote.id] as string[]) {
      const row = (await ownerRow(owner, "places.location_notes", id))!;
      expect(row.project_id).toBe(t.project);
      expect(row.room_id).toBeNull();
    }
    expect((await ownerRow(owner, "shared.files", file.id as string))!.project_id).toBe(t.project);

    const pend = await owner<Record<string, unknown>[]>`select * from places.structure_changes where walk_id = ${walk.id} and change_kind = 'room_hint_pending'`;
    expect(pend.length).toBe(1);
    expect(pend[0].room_hint).toBe("Flex Rm");
    expect(pend[0].revision).toBe(1);
    expect(pend[0].ref_table).toBe("places.walks");
    expect(pend[0].ref_id).toBe(walk.id);
    const ev = await ownerEvents(owner, { ref_id: walk.id as string, event_type: "walk.attached" });
    expect(ev.length).toBe(1);
  });

  it("re-attach to the same project is a noop 200; to another project 409; nothing re-written", async () => {
    const again = await call("POST", t.techA, `/walks/${walk.id}/attach`, { project_id: t.project });
    expect(again.status).toBe(200);
    expect((again.body as AttachBody).op).toBe("noop");
    expect((await owner`select count(*)::int as n from places.structure_changes where walk_id = ${walk.id}`)[0].n).toBe(1);
    const other = crypto.randomUUID();
    await owner`insert into shared.projects (id, organization_id, account_id, name, created_by) values (${other}, ${t.org}, ${t.account}, 'Other house (test)', ${t.office})`;
    await owner`insert into places.structure_state (project_id, organization_id) values (${other}, ${t.org})`;
    expect((await call("POST", t.techA, `/walks/${walk.id}/attach`, { project_id: other })).status).toBe(409);
  });

  it("the pending hint shows in the designer's review and blocks publish until resolved", async () => {
    expect((await call("POST", t.designerB, `/projects/${t.project}/checkout`)).status).toBe(200);
    const rv = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as { pending_room_hints: number; groups: { key: string; room_hint: string | null }[] };
    expect(rv.pending_room_hints).toBe(1);
    expect(rv.groups.find((g) => g.key === "hint:flex rm")?.room_hint).toBe("Flex Rm");
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`)).status).toBe(409);
  });

  it("push cannot detach or re-point an attached walk either", async () => {
    const r1 = await push(t.techA, [{ table: "places.walks", row: { ...walk, revision: 3, project_id: null, status: "draft" } }]);
    expect(r1.rejected[0]?.reason).toBe("schema");
    const r2 = await push(t.techA, [{ table: "places.walks", row: { ...walk, revision: 3, project_id: crypto.randomUUID(), status: "attached" } }]);
    expect(r2.rejected[0]?.reason).toBe("schema");
    // but an edit that keeps project_id is fine
    const r3 = await push(t.techA, [{ table: "places.walks", row: { ...walk, revision: 3, project_id: t.project, status: "attached", label: "quick walk (renamed)" } }]);
    expect(r3.accepted[0]?.op).toBe("updated");
  });
});
