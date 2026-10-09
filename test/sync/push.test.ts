// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: A2-fix · run: run-2026-10-07-drawing-layer-09 · 2026-10-09 — self-referencing walks.walk_id regression
// POST /sync/push — the §5.6 rule table as implemented in src/sync/push.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dbAvailable, ownerSql, createTestOrg, setCheckout, publishAsOwner, syncEnv, syncRequest, callSync, syncSet,
  ownerRow, ownerCount, MemorySink, type Sql, type TestOrg,
} from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

describe.skipIf(!available)("POST /sync/push", () => {
  let owner: Sql;
  let t: TestOrg;
  const sink = new MemorySink();
  const env = syncEnv({}, sink);

  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[], extra: Record<string, unknown> = {}) => {
    const r = await callSync(env, syncRequest("POST", "/sync/push", { actor, org: t.org, body: { device_id: "test-device", rows, ...extra } }));
    expect(r.status).toBe(200);
    return r.body as PushResult;
  };

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "push");
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  describe("envelope", () => {
    it("400 on a malformed body; 405 on GET", async () => {
      expect((await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, rawBody: "not json" }))).status).toBe(400);
      expect((await callSync(env, syncRequest("POST", "/sync/push", { actor: t.techA, org: t.org, body: { rows: [] } }))).status).toBe(400);
      expect((await callSync(env, syncRequest("GET", "/sync/push", { actor: t.techA, org: t.org }))).status).toBe(405);
    });
    it("401 without an actor, 403 for a non-member", async () => {
      expect((await callSync(env, syncRequest("POST", "/sync/push", { org: t.org, body: { device_id: "d", rows: [] } }))).status).toBe(401);
      expect((await callSync(env, syncRequest("POST", "/sync/push", { actor: crypto.randomUUID(), org: t.org, body: { device_id: "d", rows: [] } }))).status).toBe(403);
    });
    it("a table outside the allow-list is rejected 'schema' (no row written for a non-uuid id)", async () => {
      const r = await push(t.techA, [{ table: "shared.members", row: { id: "x" } }, { table: "public.anything", row: syncSet(t, t.techA) }]);
      expect(r.rejected.map((x) => x.reason)).toEqual(["schema", "schema"]);
      expect(r.rejected[0].id).toBeNull();
      expect(await ownerCount(owner, "places.sync_rejections", { ref_id: r.rejected[1].id as string })).toBe(1);
    });
  });

  describe("sync-set shape", () => {
    it("organization_id ≠ request org → 'schema' with detail org_mismatch (not in the CHECK as its own reason)", async () => {
      const row = syncSet(t, t.techA, { organization_id: crypto.randomUUID(), project_id: t.project, room_id: t.rooms.foyer, body: "x" });
      const r = await push(t.techA, [{ table: "places.location_notes", row }]);
      expect(r.rejected[0]).toMatchObject({ reason: "schema" });
      expect(r.rejected[0].detail).toContain("org_mismatch");
      expect(await ownerRow(owner, "places.location_notes", row.id as string)).toBeNull();
    });
    it("occurred_at missing → schema; created_by ≠ actor on a NEW row → not_row_owner", async () => {
      const a = syncSet(t, t.techA, { occurred_at: null, project_id: t.project, body: "x" });
      const b = syncSet(t, t.techB, { project_id: t.project, body: "x" }); // pushed by A, authored "by B"
      const r = await push(t.techA, [{ table: "places.location_notes", row: a }, { table: "places.location_notes", row: b }]);
      expect(r.rejected.map((x) => x.reason)).toEqual(["schema", "not_row_owner"]);
    });
    it("unknown parent → unknown_parent, rejection row carries only verified refs", async () => {
      const row = syncSet(t, t.techA, { project_id: t.project, room_id: crypto.randomUUID(), body: "ghost room" });
      const r = await push(t.techA, [{ table: "places.location_notes", row }]);
      expect(r.rejected[0]).toMatchObject({ reason: "unknown_parent" });
      const rej = await owner<{ project_id: string | null; reason: string }[]>`select project_id, reason from places.sync_rejections where ref_id = ${row.id as string}`;
      expect(rej[0]).toEqual({ project_id: t.project, reason: "unknown_parent" });
    });
  });

  describe("capture rows (technician append-only, own-row tombstones)", () => {
    it("any member inserts; another member may not update or tombstone; the creator may", async () => {
      const note = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, kind: "note", body: "first" });
      let r = await push(t.techA, [{ table: "places.location_notes", row: note }]);
      expect(r.accepted[0]).toMatchObject({ id: note.id, revision: 1, op: "created" });

      r = await push(t.techB, [{ table: "places.location_notes", row: { ...note, revision: 2, body: "hijack" } }]);
      expect(r.rejected[0]).toMatchObject({ id: note.id, reason: "not_row_owner" });
      r = await push(t.techB, [{ table: "places.location_notes", row: { ...note, revision: 2, deleted_at: new Date().toISOString() } }]);
      expect(r.rejected[0]).toMatchObject({ reason: "not_row_owner" });
      expect((await ownerRow(owner, "places.location_notes", note.id as string))!.body).toBe("first");

      r = await push(t.techA, [{ table: "places.location_notes", row: { ...note, revision: 2, body: "edited" } }]);
      expect(r.accepted[0]).toMatchObject({ revision: 2, op: "updated" });
      r = await push(t.techA, [{ table: "places.location_notes", row: { ...note, revision: 3, deleted_at: new Date().toISOString() } }]);
      expect(r.accepted[0]).toMatchObject({ revision: 3, op: "tombstoned" });
      const stored = (await ownerRow(owner, "places.location_notes", note.id as string))!;
      expect(stored.deleted_at).not.toBeNull();
      expect(stored.deleted_by).toBe(t.techA);
      expect(stored.created_by).toBe(t.techA);
    });

    it("an admin may tombstone another member's capture row", async () => {
      const note = syncSet(t, t.techB, { project_id: t.project, room_id: t.rooms.foyer, body: "b's note" });
      await push(t.techB, [{ table: "places.location_notes", row: note }]);
      const r = await push(t.designer, [{ table: "places.location_notes", row: { ...note, revision: 2, deleted_at: new Date().toISOString() } }]);
      expect(r.accepted[0]).toMatchObject({ op: "tombstoned" });
      expect((await ownerRow(owner, "places.location_notes", note.id as string))!.deleted_by).toBe(t.designer);
    });

    it("stale revision loses; a stale edit cannot clear a newer tombstone (stale_tombstone)", async () => {
      const note = syncSet(t, t.techA, { project_id: t.project, body: "v1" });
      await push(t.techA, [{ table: "places.location_notes", row: { ...note, revision: 3 } }]);
      let r = await push(t.techA, [{ table: "places.location_notes", row: { ...note, revision: 2, body: "old" } }]);
      expect(r.rejected[0]).toMatchObject({ reason: "stale_revision" });
      await push(t.techA, [{ table: "places.location_notes", row: { ...note, revision: 4, deleted_at: new Date().toISOString() } }]);
      r = await push(t.techA, [{ table: "places.location_notes", row: { ...note, revision: 5, body: "resurrect", deleted_at: null } }]);
      expect(r.rejected[0]).toMatchObject({ reason: "stale_tombstone" });
      expect((await ownerRow(owner, "places.location_notes", note.id as string))!.deleted_at).not.toBeNull();
      expect(await ownerCount(owner, "places.sync_rejections", { ref_id: note.id as string })).toBe(2);
    });

    it("a walk whose walk_id is its own id (036 convention, what the phone sends) is accepted, and its captures with it (A2-fix 2026-10-09)", async () => {
      const walk = syncSet(t, t.techA, { project_id: null, status: "draft", label: "phone quick walk", started_at: new Date().toISOString() });
      walk.walk_id = walk.id;
      const note = syncSet(t, t.techA, { walk_id: walk.id, room_hint: "Garage", body: "from the phone" });
      const r = await push(t.techA, [{ table: "places.walks", row: walk }, { table: "places.location_notes", row: note }], { walk_id: walk.id as string });
      expect(r.rejected).toEqual([]);
      expect(r.accepted.map((a) => a.table)).toEqual(["places.walks", "places.location_notes"]);
      expect((await ownerRow(owner, "places.walks", walk.id as string))!.walk_id).toBe(walk.id);
      // a walk_id pointing at some OTHER (missing) walk is still unknown_parent
      const ghost = syncSet(t, t.techA, { project_id: null, status: "draft", label: "ghost", started_at: new Date().toISOString(), walk_id: crypto.randomUUID() });
      expect((await push(t.techA, [{ table: "places.walks", row: ghost }])).rejected[0]).toMatchObject({ reason: "unknown_parent" });
    });

    it("a capture under a DRAFT walk must carry hints, not room_id/project_id", async () => {
      const walk = syncSet(t, t.techA, { project_id: null, status: "draft", label: "quick notes", started_at: new Date().toISOString() });
      const bad = syncSet(t, t.techA, { walk_id: walk.id, room_id: t.rooms.foyer, body: "bound" });
      const good = syncSet(t, t.techA, { walk_id: walk.id, room_hint: "Pantry", body: "hinted" });
      const r = await push(t.techA, [{ table: "places.walks", row: walk }, { table: "places.location_notes", row: bad }, { table: "places.location_notes", row: good }], { walk_id: walk.id });
      expect(r.accepted.map((a) => a.id)).toEqual([walk.id, good.id]);
      expect(r.rejected[0]).toMatchObject({ id: bad.id, reason: "schema" });
      expect(r.rejected[0].detail).toContain("draft walk");
      const rej = await owner<{ walk_id: string | null }[]>`select walk_id from places.sync_rejections where ref_id = ${bad.id as string}`;
      expect(rej[0].walk_id).toBe(walk.id); // the walk landed earlier in the same batch → verified ref
      expect(await ownerCount(owner, "shared.events", { ref_id: walk.id as string, event_type: "walk.started" })).toBe(1);
    });

    it("a stale capture (captured_revision < published_revision) is ACCEPTED and flagged stale_capture", async () => {
      await setCheckout(owner, t, t.designer);
      const pub = await publishAsOwner(owner, t); // published_revision 1, working 2
      expect(pub.published_revision).toBe(1);
      const walk = syncSet(t, t.techA, { project_id: t.project, status: "attached", started_at: new Date().toISOString(), checked_out_revision: 0 });
      const note = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.kitchen, kind: "flag", body: "outlet missing", captured_revision: 0 });
      const r = await push(t.techA, [{ table: "places.walks", row: walk }, { table: "places.location_notes", row: note }]);
      expect(r.accepted.length).toBe(2);
      const sc = await owner<{ change_kind: string; revision: number; room_id: string; walk_id: string }[]>`
        select change_kind, revision, room_id, walk_id from places.structure_changes where ref_id = ${note.id as string}`;
      expect(sc).toEqual([{ change_kind: "stale_capture", revision: pub.working_revision, room_id: t.rooms.kitchen, walk_id: walk.id }]);
      expect(await ownerCount(owner, "shared.events", { ref_id: note.id as string, event_type: "capture.flagged" })).toBe(1);
      const w = (await ownerRow(owner, "places.walks", walk.id as string))!;
      expect(w.attached_by).toBe(t.techA);
      expect(w.attached_at).not.toBeNull();
    });

    it("as_walked device placements are captures (event placement.as_walked); annotations are captures in W1", async () => {
      const dp = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "as_walked", product_name: "Keypad (as walked)" });
      const ann = syncSet(t, t.techA, { page_id: t.page1, layer_id: t.layerFieldNotes, kind: "pen", geometry: { points: [[1, 1], [2, 2]] }, room_id: t.rooms.kitchen });
      const r = await push(t.techA, [{ table: "places.device_placements", row: dp }, { table: "drawings.annotations", row: ann }]);
      expect(r.accepted.length).toBe(2);
      expect(await ownerCount(owner, "shared.events", { ref_id: dp.id as string, event_type: "placement.as_walked" })).toBe(1);
      const a = (await ownerRow(owner, "drawings.annotations", ann.id as string))!;
      expect(a.class).toBe("capture"); // copied from the landing layer when the device sent none
      expect(await ownerCount(owner, "places.structure_changes", { ref_id: ann.id as string })).toBe(0);
      // a technician's annotation aimed at the structure layer: W1 has NO layer rule → plain capture-row insert, never a layer rejection
      const aimed = syncSet(t, t.techB, { page_id: t.page1, layer_id: t.layerDesign, kind: "text", label: "hi", geometry: { x: 1, y: 2 } });
      const r2 = await push(t.techB, [{ table: "drawings.annotations", row: aimed }]);
      expect(r2.rejected).toEqual([]);
    });
  });

  describe("structure rows (designer checkout)", () => {
    it("without the live checkout → no_checkout, visible in sync_rejections; captures during it still land", async () => {
      await setCheckout(owner, t, null);
      const room = syncSet(t, t.designer, { project_id: t.project, name: "Pantry" });
      let r = await push(t.designer, [{ table: "places.rooms", row: room }]);
      expect(r.rejected[0]).toMatchObject({ id: room.id, reason: "no_checkout" });
      expect(await ownerRow(owner, "places.rooms", room.id as string)).toBeNull();
      expect(await ownerCount(owner, "places.sync_rejections", { ref_id: room.id as string, reason: "no_checkout" })).toBe(1);

      await setCheckout(owner, t, t.techB); // someone else holds it
      r = await push(t.designer, [{ table: "places.rooms", row: room }]);
      expect(r.rejected[0]).toMatchObject({ reason: "no_checkout" });
      const note = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, body: "during checkout" });
      r = await push(t.techA, [{ table: "places.location_notes", row: note }]);
      expect(r.accepted.length).toBe(1);
    });

    it("an expired checkout → checkout_expired", async () => {
      await setCheckout(owner, t, t.designer, -1000);
      const room = syncSet(t, t.designer, { project_id: t.project, name: "Pantry" });
      const r = await push(t.designer, [{ table: "places.rooms", row: room }]);
      expect(r.rejected[0]).toMatchObject({ reason: "checkout_expired" });
    });

    it("with the live checkout → accepted, structure_changes created/updated/tombstoned at working_revision, one event per revision", async () => {
      await setCheckout(owner, t, t.designer);
      const st = (await owner<{ working_revision: number }[]>`select working_revision from places.structure_state where project_id = ${t.project}`)[0];
      const room = syncSet(t, t.designer, { project_id: t.project, name: "Pantry", room_type: "storage" });
      const loc = syncSet(t, t.designer, { project_id: t.project, room_id: room.id, label: "Pantry shelf" });
      const poly = syncSet(t, t.designer, { project_id: t.project, drawing_id: t.drawing, drawing_version_id: t.version, page_id: t.page1, room_id: room.id, polygon: { points: [[0, 0], [1, 0], [1, 1]] } });
      const run = syncSet(t, t.designer, { project_id: t.project, from_schema: "places", from_table: "locations", from_id: loc.id, cable_type: "cat6" });
      let r = await push(t.designer, [
        { table: "places.rooms", row: room }, { table: "places.locations", row: loc },
        { table: "places.room_polygons", row: poly }, { table: "places.wire_runs", row: run },
      ]);
      expect(r.rejected).toEqual([]);
      expect(r.accepted.map((a) => a.op)).toEqual(["created", "created", "created", "created"]);
      const sc = await owner<{ ref_table: string; change_kind: string; revision: number; room_id: string | null }[]>`
        select ref_table, change_kind, revision, room_id from places.structure_changes
         where ref_id in ${owner([room.id, loc.id, poly.id, run.id] as string[])} order by ref_table`;
      expect(sc).toEqual([
        { ref_table: "places.locations", change_kind: "created", revision: st.working_revision, room_id: room.id },
        { ref_table: "places.room_polygons", change_kind: "created", revision: st.working_revision, room_id: room.id },
        { ref_table: "places.rooms", change_kind: "created", revision: st.working_revision, room_id: room.id },
        { ref_table: "places.wire_runs", change_kind: "created", revision: st.working_revision, room_id: null },
      ]);

      r = await push(t.designer, [{ table: "places.rooms", row: { ...room, revision: 2, name: "Pantry / Mud" } }]);
      expect(r.accepted[0]).toMatchObject({ op: "updated", revision: 2 });
      r = await push(t.designer, [{ table: "places.locations", row: { ...loc, revision: 2, deleted_at: new Date().toISOString() } }]);
      expect(r.accepted[0]).toMatchObject({ op: "tombstoned" });
      const kinds = await owner<{ change_kind: string; diff: { before: { name?: string } | null; after: { name?: string } } }[]>`
        select change_kind, diff from places.structure_changes where ref_id = ${room.id as string} order by created_at`;
      expect(kinds.map((k) => k.change_kind)).toEqual(["created", "updated"]);
      expect(kinds[1].diff.before?.name).toBe("Pantry");
      expect(kinds[1].diff.after.name).toBe("Pantry / Mud");
      expect(await ownerCount(owner, "places.structure_changes", { ref_id: loc.id as string, change_kind: "tombstoned" })).toBe(1);
      const ev = await owner<{ idempotency_key: string }[]>`select idempotency_key from shared.events where ref_id = ${room.id as string} order by idempotency_key`;
      expect(ev.map((e) => e.idempotency_key)).toEqual([`places.rooms:${room.id}:1`, `places.rooms:${room.id}:2`]);
    });

    it("a technician holding no checkout cannot push a 'plan' placement; a DB CHECK violation surfaces as 'schema'", async () => {
      const plan = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "plan", product_name: "TV" });
      const r = await push(t.techA, [{ table: "places.device_placements", row: plan }]);
      expect(r.rejected[0]).toMatchObject({ reason: "no_checkout" });
      // designer with checkout but kind outside the CHECK list
      const bad = syncSet(t, t.designer, { project_id: t.project, room_id: t.rooms.kitchen, body: "x", kind: "poem" });
      const r2 = await push(t.designer, [{ table: "places.location_notes", row: bad }]);
      expect(r2.rejected[0]).toMatchObject({ reason: "schema" });
      expect(r2.rejected[0].detail).toContain("location_notes_kind_check");
    });

    it("pages/layers resolve their project through the drawing; an UNATTACHED drawing's rows follow own-row rules (no checkout to hold)", async () => {
      await setCheckout(owner, t, null);
      const quick = syncSet(t, t.techA, { kind: "plan", working_title: "Quick drawing", address_hint: "somewhere" });
      const page = syncSet(t, t.techA, { drawing_id: quick.id, ordinal: 1, name: "Sheet", room_hint: "Garage" });
      const layer = syncSet(t, t.techA, { drawing_id: quick.id, name: "Field Notes", ordinal: 1, class: "capture", write_policy: "any_member" });
      const r = await push(t.techA, [{ table: "drawings.drawings", row: quick }, { table: "drawings.pages", row: page }, { table: "drawings.layers", row: layer }]);
      expect(r.rejected).toEqual([]);
      expect(await ownerCount(owner, "places.structure_changes", { ref_id: page.id as string })).toBe(0); // no project → no review row
      // but a page under the PROJECT's plan is structure and needs the checkout
      const projPage = syncSet(t, t.techA, { drawing_id: t.drawing, drawing_version_id: t.version, ordinal: 3, name: "Floor 3" });
      const r2 = await push(t.techA, [{ table: "drawings.pages", row: projPage }]);
      expect(r2.rejected[0]).toMatchObject({ reason: "no_checkout" });
    });
  });

  describe("revoked member", () => {
    it("every row is HELD as actor_revoked (taken, never applied, never dropped)", async () => {
      const note = syncSet(t, t.revoked, { project_id: t.project, body: "after revocation" });
      const r = await push(t.revoked, [{ table: "places.location_notes", row: note }]);
      expect(r.rejected[0]).toMatchObject({ id: note.id, reason: "actor_revoked" });
      expect(await ownerRow(owner, "places.location_notes", note.id as string)).toBeNull();
      const held = await owner<{ proposed: { body: string }; actor: string }[]>`select proposed, actor from places.sync_rejections where ref_id = ${note.id as string}`;
      expect(held[0].actor).toBe(t.revoked);
      expect(held[0].proposed.body).toBe("after revocation");
    });
  });

  describe("files", () => {
    it("a pending file row gets a put_url; storage_key is server-set; media may reference it in the same batch", async () => {
      const file = syncSet(t, t.techA, { project_id: t.project, kind: "photo", filename: "IMG_0001.jpg", content_type: "image/jpeg", byte_size: 3 });
      const media = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, file_id: file.id, caption: "entry" });
      const r = await push(t.techA, [{ table: "shared.files", row: { ...file, storage_key: "evil/override", upload_status: "verified" } }, { table: "places.location_media", row: media }], {
        files: [{ file_id: file.id }, { file_id: crypto.randomUUID() }],
      });
      expect(r.rejected).toEqual([]);
      const stored = (await ownerRow(owner, "shared.files", file.id as string))!;
      expect(stored.storage_key).toBe(`${t.org}/${file.id}`);
      expect(stored.upload_status).toBe("pending");
      expect(r.files[0]).toEqual({ file_id: file.id, upload_status: "pending", put_url: `http://worker.test/sync/files/${file.id}` });
      expect(r.files[1].upload_status).toBe("unknown");

      // PUT the bytes through the Worker → uploaded, sha256 recorded, R2 key = storage_key
      const put = await callSync(env, syncRequest("PUT", `/sync/files/${file.id}`, { actor: t.techA, org: t.org, rawBody: "abc", headers: { "Content-Type": "image/jpeg" } }));
      expect(put.status).toBe(200);
      expect((put.body as { sha256: string }).sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      expect(sink.objects.has(`${t.org}/${file.id}`)).toBe(true);
      const after = (await ownerRow(owner, "shared.files", file.id as string))!;
      expect(after.upload_status).toBe("uploaded");
      // monotone: a second PUT is refused; another member cannot upload someone else's file
      expect((await callSync(env, syncRequest("PUT", `/sync/files/${file.id}`, { actor: t.techA, org: t.org, rawBody: "abc" }))).status).toBe(409);
      const other = syncSet(t, t.techA, { kind: "photo", filename: "IMG_0002.jpg", content_type: "image/jpeg" });
      await push(t.techA, [{ table: "shared.files", row: other }]);
      expect((await callSync(env, syncRequest("PUT", `/sync/files/${other.id}`, { actor: t.techB, org: t.org, rawBody: "abc" }))).status).toBe(403);
      const r2 = await push(t.techA, [], { files: [{ file_id: file.id }] });
      expect(r2.files[0]).toEqual({ file_id: file.id, upload_status: "uploaded" });
    });

    it("a declared sha256 that does not match the bytes → 422 and the row stays pending", async () => {
      const file = syncSet(t, t.techA, { kind: "photo", filename: "IMG_0003.jpg", content_type: "image/jpeg", sha256: "0".repeat(64) });
      await push(t.techA, [{ table: "shared.files", row: file }]);
      const put = await callSync(env, syncRequest("PUT", `/sync/files/${file.id}`, { actor: t.techA, org: t.org, rawBody: "abc" }));
      expect(put.status).toBe(422);
      expect((await ownerRow(owner, "shared.files", file.id as string))!.upload_status).toBe("pending");
    });
  });
});
