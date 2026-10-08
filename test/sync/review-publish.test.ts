// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08 — publish pin: unknown version 404 (was 422); client_rejected / superseded / foreign version 409
// Check-in review + publish (walk spec L7, §5.2 structure_changes, §5.6 publish_revision, §6 check 3).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, syncSet, ownerEvents, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

interface ReviewBody {
  working_revision: number;
  published_revision: number;
  pending_count: number;
  pending_room_hints: number;
  groups: { key: string; room_id: string | null; room_name: string | null; room_hint: string | null; changes: { id: string; change_kind: string; ref_table: string; ref_id: string }[] }[];
  action_items: { id: string; source_kind: string; source_ref_id: string }[];
  context: { notes: { id: string }[]; media: { id: string }[]; as_walked_placements: { id: string }[] };
}

describe.skipIf(!available)("review + publish", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[]) =>
    (await call("POST", actor, "/sync/push", { device_id: "test-device", rows })).body as PushResult;
  const state = async () => (await owner<Record<string, unknown>[]>`select * from places.structure_state where project_id = ${t.project}`)[0];

  let newRoom: Record<string, unknown>;
  let flagNote: Record<string, unknown>;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "review");
    expect((await call("POST", t.designerB, `/projects/${t.project}/checkout`)).status).toBe(200);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("review list: structure_changes grouped by room (named), flags as action_items, notes/photos as context only", async () => {
    newRoom = syncSet(t, t.designerB, { project_id: t.project, name: "Mud Room", room_type: "utility" });
    const locUpdate = syncSet(t, t.designerB, { id: t.locationTv, revision: 2, project_id: t.project, room_id: t.rooms.kitchen, label: "Kitchen TV (65in)" });
    const r1 = await push(t.designerB, [{ table: "places.rooms", row: newRoom }, { table: "places.locations", row: locUpdate }]);
    expect(r1.rejected).toEqual([]);
    const walk = syncSet(t, t.techA, { project_id: t.project, status: "attached", started_at: new Date().toISOString(), checked_out_revision: 0 });
    flagNote = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.kitchen, kind: "flag", body: "box too shallow" });
    const plainNote = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.foyer, kind: "note", body: "ok" });
    const file = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, kind: "photo", filename: "a.jpg", content_type: "image/jpeg" });
    const media = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.kitchen, file_id: file.id, caption: "panel" });
    const r2 = await push(t.techA, [
      { table: "places.walks", row: walk }, { table: "places.location_notes", row: flagNote }, { table: "places.location_notes", row: plainNote },
      { table: "shared.files", row: file }, { table: "places.location_media", row: media },
    ]);
    expect(r2.rejected).toEqual([]);

    const r = await call("GET", t.designerB, `/projects/${t.project}/review`);
    expect(r.status).toBe(200);
    const b = r.body as ReviewBody;
    expect(b.working_revision).toBe(1);
    expect(b.pending_count).toBe(2);
    const keys = b.groups.map((g) => g.key).sort();
    expect(keys).toEqual([`room:${newRoom.id}`, `room:${t.rooms.kitchen}`].sort());
    const kitchen = b.groups.find((g) => g.room_id === t.rooms.kitchen)!;
    expect(kitchen.room_name).toBe("Kitchen");
    expect(kitchen.changes.map((c) => [c.change_kind, c.ref_table])).toEqual([["updated", "places.locations"]]);
    const mud = b.groups.find((g) => g.room_id === newRoom.id)!;
    expect(mud.room_name).toBe("Mud Room");
    expect(mud.changes[0].change_kind).toBe("created");
    // the flag is an action item (rule chain), never a review row; notes/photos are context
    expect(b.action_items.map((a) => [a.source_kind, a.source_ref_id])).toEqual([["field_flag", flagNote.id]]);
    const allChangeRefs = b.groups.flatMap((g) => g.changes.map((c) => c.ref_id));
    expect(allChangeRefs).not.toContain(flagNote.id);
    expect(allChangeRefs).not.toContain(plainNote.id);
    expect(b.context.notes.map((n) => n.id).sort()).toEqual([flagNote.id, plainNote.id].sort());
    expect(b.context.media.map((m) => m.id)).toEqual([media.id]);
  });

  it("technician cannot review (403); PATCH accepts 036 outcomes and the accepted/dismissed aliases", async () => {
    const b = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as ReviewBody;
    const [c1, c2] = b.groups.flatMap((g) => g.changes);
    expect((await call("PATCH", t.techA, `/projects/${t.project}/review/${c1.id}`, { outcome: "approved" })).status).toBe(403);
    expect((await call("PATCH", t.designerB, `/projects/${t.project}/review/${c1.id}`, { outcome: "bogus" })).status).toBe(400);
    const p1 = await call("PATCH", t.designerB, `/projects/${t.project}/review/${c1.id}`, { outcome: "accepted" });
    expect(p1.status).toBe(200);
    expect((p1.body as { change: { review_outcome: string; reviewed_by: string } }).change.review_outcome).toBe("approved");
    expect((p1.body as { change: { reviewed_by: string } }).change.reviewed_by).toBe(t.designerB);
    const after = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as ReviewBody;
    expect(after.pending_count).toBe(1);
    expect(after.groups.flatMap((g) => g.changes).map((c) => c.id)).toEqual([c2.id]);
  });

  it("publish: 403 for a non-holder (admin included — no bypass), 409 while a change is unreviewed, 200 after review; flips revisions + pins the drawing version", async () => {
    expect((await call("POST", t.designer, `/projects/${t.project}/publish`)).status).toBe(403);
    const refused = await call("POST", t.designerB, `/projects/${t.project}/publish`);
    expect(refused.status).toBe(409);
    expect((refused.body as { pending_count: number }).pending_count).toBe(1);
    expect((await state()).published_revision).toBe(0);

    const b = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as ReviewBody;
    const last = b.groups.flatMap((g) => g.changes)[0];
    expect((await call("PATCH", t.designerB, `/projects/${t.project}/review/${last.id}`, { outcome: "validated" })).status).toBe(200);

    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: crypto.randomUUID() })).status).toBe(404); // W4: unknown version
    const ok = await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: t.version });
    expect(ok.status).toBe(200);
    const ss = (ok.body as { structure_state: Record<string, unknown> }).structure_state;
    expect(ss.published_revision).toBe(1);
    expect(ss.working_revision).toBe(2);
    expect(ss.published_drawing_version_id).toBe(t.version);
    expect(ss.published_by).toBe(t.designerB);
    expect(ss.checkout_user_id).toBeNull(); // publish_revision releases the checkout
    const ev = await ownerEvents(owner, { ref_id: t.project, event_type: "structure.published" });
    expect(ev.length).toBe(1); // the function emits it; the route does not double-emit
    // the review list for the new working revision is empty; the old rows stay as history
    const after = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as ReviewBody;
    expect(after.working_revision).toBe(2);
    expect(after.pending_count).toBe(0);
    expect(await owner`select count(*)::int as n from places.structure_changes where project_id = ${t.project} and revision = 1`.then((r) => r[0].n)).toBe(2);
  });

  it("publish with no checkout → 409; a PATCH on an already-published change → 409", async () => {
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`)).status).toBe(409);
    const old = (await owner<{ id: string }[]>`select id from places.structure_changes where project_id = ${t.project} and revision = 1 limit 1`)[0];
    expect((await call("PATCH", t.designerB, `/projects/${t.project}/review/${old.id}`, { outcome: "approved" })).status).toBe(409);
  });

  it("spec §6.3: a technician push landing after publish with captured_revision 0 is accepted and flagged stale_capture at the NEW working revision", async () => {
    const note = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, kind: "note", body: "late", captured_revision: 0 });
    const r = await push(t.techA, [{ table: "places.location_notes", row: note }]);
    expect(r.accepted.length).toBe(1);
    expect((await call("POST", t.designerB, `/projects/${t.project}/checkout`)).status).toBe(200);
    const b = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as ReviewBody;
    const stale = b.groups.flatMap((g) => g.changes).find((c) => c.ref_id === note.id);
    expect(stale?.change_kind).toBe("stale_capture");
    // and it blocks publish until reviewed
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`)).status).toBe(409);
  });

  it("W4 publish pin (spec §2b): a client_rejected or superseded version → 409; a version of a drawing not on this project → 409; the previous pin is kept when none is given", async () => {
    const b = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as ReviewBody;
    for (const c of b.groups.flatMap((g) => g.changes)) expect((await call("PATCH", t.designerB, `/projects/${t.project}/review/${c.id}`, { outcome: "validated" })).status).toBe(200);
    await owner`update drawings.drawing_versions set status = 'client_rejected' where id = ${t.version}`;
    const rej = await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: t.version });
    expect(rej.status).toBe(409);
    expect((rej.body as { status: string }).status).toBe("client_rejected");
    await owner`update drawings.drawing_versions set status = 'superseded' where id = ${t.version}`;
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: t.version })).status).toBe(409);
    const stray = crypto.randomUUID(), strayV = crypto.randomUUID();
    await owner`insert into drawings.drawings (id, organization_id, kind, account_id, working_title, occurred_at, created_by) values (${stray}, ${t.org}, 'plan', ${t.account}, 'account-filed plan', now(), ${t.designer})`;
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, occurred_at, created_by) values (${strayV}, ${t.org}, ${stray}, 1, now(), ${t.designer})`;
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: strayV })).status).toBe(409);
    expect((await state()).published_revision).toBe(1); // nothing published by the refusals
    // no pin given → publish goes through and keeps the previously pinned version (even though it is now superseded: the pin is a fact of the earlier publish)
    const ok = await call("POST", t.designerB, `/projects/${t.project}/publish`);
    expect(ok.status).toBe(200);
    const ss = (ok.body as { structure_state: Record<string, unknown> }).structure_state;
    expect(ss.published_revision).toBe(2);
    expect(ss.published_drawing_version_id).toBe(t.version);
  });
});
