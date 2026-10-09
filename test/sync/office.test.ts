// row: W5b · run: run-2026-10-07-drawing-layer-09 · 2026-10-09 — office list routes
// GET /walks · GET /walks/:id · GET+PATCH /sync/rejections · GET /members · GET /projects (sync/office.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, setCheckout, syncEnv, syncRequest, callSync, syncSet, ownerEvents, ownerRow, ownerCount, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

interface WalkOut {
  id: string; label: string | null; project_id: string | null; status: string; created_by: string; created_by_name: string | null;
  counts: { notes: number; media: number; placements: number }; pending_files: number; received_at: string;
  rooms?: { room_id: string | null; room_name: string | null; room_hint: string | null; rows: number }[];
}
interface RejectionOut {
  id: string; walk_id: string | null; project_id: string | null; ref_table: string; ref_id: string; actor: string; actor_name: string | null;
  reason: string; proposed: Record<string, unknown>; resolved_at: string | null; resolution: string | null;
}

describe.skipIf(!available)("office list routes (W5b)", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[], walkId?: string) =>
    (await call("POST", actor, "/sync/push", { device_id: "phone-a", walk_id: walkId, rows })).body as PushResult;

  // techA: a DRAFT walk (hinted captures + a pending file); techB: an ATTACHED walk on the project
  let draftWalk: Record<string, unknown>;
  let attachedWalk: Record<string, unknown>;
  let noteA: Record<string, unknown>;
  let fileA: Record<string, unknown>;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "office");
    draftWalk = syncSet(t, t.techA, { project_id: null, status: "draft", label: "draft walk", address_hint: "12 Example Way", started_at: new Date().toISOString() });
    fileA = syncSet(t, t.techA, { walk_id: draftWalk.id, kind: "photo", filename: "a.jpg", content_type: "image/jpeg" });
    noteA = syncSet(t, t.techA, { walk_id: draftWalk.id, room_hint: "Kitchen", kind: "note", body: "island outlets" });
    const mediaA = syncSet(t, t.techA, { walk_id: draftWalk.id, room_hint: "kitchen", file_id: fileA.id, caption: "range wall" });
    const noteA2 = syncSet(t, t.techA, { walk_id: draftWalk.id, room_hint: "Flex Rm", kind: "flag", body: "no power" });
    const r1 = await push(t.techA, [
      { table: "places.walks", row: draftWalk }, { table: "shared.files", row: fileA },
      { table: "places.location_notes", row: noteA }, { table: "places.location_media", row: mediaA }, { table: "places.location_notes", row: noteA2 },
    ], draftWalk.id as string);
    expect(r1.rejected).toEqual([]);

    attachedWalk = syncSet(t, t.techB, { project_id: t.project, account_id: t.account, status: "attached", label: "attached walk", started_at: new Date().toISOString() });
    const noteB = syncSet(t, t.techB, { walk_id: attachedWalk.id, project_id: t.project, room_id: t.rooms.foyer, kind: "note", body: "foyer keypad" });
    const r2 = await push(t.techB, [{ table: "places.walks", row: attachedWalk }, { table: "places.location_notes", row: noteB }], attachedWalk.id as string);
    expect(r2.rejected).toEqual([]);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  //--------------------------------------------------------------------------------
  // GET /walks
  //--------------------------------------------------------------------------------

  it("GET /walks: a technician sees only their own walks; office sees all, with names, counts and pending_files", async () => {
    const mine = await call("GET", t.techA, "/walks");
    expect(mine.status).toBe(200);
    const mineWalks = (mine.body as { walks: WalkOut[] }).walks;
    expect(mineWalks.map((w) => w.id)).toEqual([draftWalk.id]);
    expect(mineWalks[0]).toMatchObject({ label: "draft walk", status: "draft", project_id: null, created_by: t.techA, created_by_name: "Test Tech A", counts: { notes: 2, media: 1, placements: 0 }, pending_files: 1 });

    const all = await call("GET", t.office, "/walks");
    expect(all.status).toBe(200);
    const ids = (all.body as { walks: WalkOut[] }).walks.map((w) => w.id);
    expect(ids).toContain(draftWalk.id);
    expect(ids).toContain(attachedWalk.id);
    expect(ids.length).toBe(2);
    // newest first (received_at desc): techB's walk was pushed last
    expect(ids[0]).toBe(attachedWalk.id);

    // a technician asking for someone else's walks by created_by → 403
    const other = await call("GET", t.techA, `/walks?created_by=${t.techB}`);
    expect(other.status).toBe(403);
  });

  it("GET /walks filters: status, unattached=1, created_by, since/limit (truncated + next_since)", async () => {
    const drafts = (await call("GET", t.designerB, "/walks?status=draft")).body as { walks: WalkOut[] };
    expect(drafts.walks.map((w) => w.id)).toEqual([draftWalk.id]);
    const unattached = (await call("GET", t.office, "/walks?unattached=1")).body as { walks: WalkOut[] };
    expect(unattached.walks.map((w) => w.id)).toEqual([draftWalk.id]);
    const byB = (await call("GET", t.office, `/walks?created_by=${t.techB}`)).body as { walks: WalkOut[] };
    expect(byB.walks.map((w) => w.id)).toEqual([attachedWalk.id]);

    const page = await call("GET", t.office, "/walks?limit=1");
    const pb = page.body as { walks: WalkOut[]; truncated: boolean; next_since: string };
    expect(pb.truncated).toBe(true);
    expect(pb.walks.length).toBe(1);
    // since = the newest cursor → nothing newer
    const after = (await call("GET", t.office, `/walks?since=${encodeURIComponent(pb.next_since)}`)).body as { walks: WalkOut[] };
    expect(after.walks).toEqual([]);

    expect((await call("GET", t.office, "/walks?status=bogus")).status).toBe(400);
    expect((await call("GET", t.office, "/walks?limit=0")).status).toBe(400);
    expect((await call("GET", t.office, "/walks?since=notadate")).status).toBe(400);
  });

  it("GET /walks/:id: same shape + rooms touched (distinct room_id / room_hint); 403 for another technician; 404 unknown", async () => {
    const r = await call("GET", t.techA, `/walks/${draftWalk.id}`);
    expect(r.status).toBe(200);
    const w = (r.body as { walk: WalkOut }).walk;
    expect(w).toMatchObject({ id: draftWalk.id, counts: { notes: 2, media: 1, placements: 0 }, pending_files: 1 });
    // "Kitchen" + "kitchen" are distinct hints as stored (resolution is attach's job); Flex Rm once
    expect(w.rooms!.map((x) => x.room_hint).sort()).toEqual(["Flex Rm", "Kitchen", "kitchen"]);
    expect(w.rooms!.find((x) => x.room_hint === "Kitchen")!.rows).toBe(1);

    const rb = await call("GET", t.office, `/walks/${attachedWalk.id}`);
    expect(rb.status).toBe(200);
    const wb = (rb.body as { walk: WalkOut }).walk;
    expect(wb.rooms).toEqual([{ room_id: t.rooms.foyer, room_name: "Foyer", room_hint: null, rows: 1 }]);

    expect((await call("GET", t.techA, `/walks/${attachedWalk.id}`)).status).toBe(403);
    expect((await call("GET", t.office, `/walks/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", t.office, "/walks/not-a-uuid")).status).toBe(400);
  });

  //--------------------------------------------------------------------------------
  // GET /sync/rejections · PATCH /sync/rejections/:id
  //--------------------------------------------------------------------------------

  async function rejectionFor(refId: string): Promise<RejectionOut> {
    const rows = await owner<RejectionOut[]>`select id, reason, resolved_at, resolution from places.sync_rejections where ref_id = ${refId} order by received_at desc limit 1`;
    return rows[0];
  }

  it("GET /sync/rejections: 403 technician; designer/office see the held rows newest first with actor_name; resolved / walk_id filters", async () => {
    // techB edits techA's note → not_row_owner (held)
    const r = await push(t.techB, [{ table: "places.location_notes", row: { ...noteA, revision: 2, body: "island outlets — 4 of them" } }], draftWalk.id as string);
    expect(r.rejected[0]).toMatchObject({ id: noteA.id, reason: "not_row_owner" });

    expect((await call("GET", t.techA, "/sync/rejections")).status).toBe(403);
    const list = await call("GET", t.designerB, "/sync/rejections");
    expect(list.status).toBe(200);
    const rejections = (list.body as { rejections: RejectionOut[] }).rejections;
    expect(rejections.length).toBe(1);
    expect(rejections[0]).toMatchObject({ ref_table: "places.location_notes", ref_id: noteA.id, actor: t.techB, actor_name: "Test Tech B", reason: "not_row_owner", resolved_at: null, resolution: null });
    expect(rejections[0].proposed.body).toBe("island outlets — 4 of them");

    const open = (await call("GET", t.office, "/sync/rejections?resolved=0")).body as { rejections: RejectionOut[] };
    expect(open.rejections.length).toBe(1);
    const done = (await call("GET", t.office, "/sync/rejections?resolved=1")).body as { rejections: RejectionOut[] };
    expect(done.rejections).toEqual([]);
    const otherWalk = (await call("GET", t.office, `/sync/rejections?walk_id=${attachedWalk.id}`)).body as { rejections: RejectionOut[] };
    expect(otherWalk.rejections).toEqual([]);
    expect((await call("GET", t.office, "/sync/rejections?resolved=2")).status).toBe(400);
  });

  it("PATCH adopted (not_row_owner): office re-applies the proposed row through the push path; author kept; event; 409 on a second resolve", async () => {
    const rej = await rejectionFor(noteA.id as string);
    expect((await call("PATCH", t.techB, `/sync/rejections/${rej.id}`, { resolution: "adopted" })).status).toBe(403);
    expect((await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "nope" })).status).toBe(400);

    const r = await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "adopted", note: "tech B was on site with A" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: { table: "places.location_notes", id: noteA.id, revision: 2, op: "updated" }, note: "tech B was on site with A" });
    const row = (await ownerRow(owner, "places.location_notes", noteA.id as string))!;
    expect(row.body).toBe("island outlets — 4 of them");
    expect(row.revision).toBe(2);
    expect(row.created_by).toBe(t.techA); // push never re-authors an existing row
    const after = await rejectionFor(noteA.id as string);
    expect(after.resolution).toBe("adopted");
    expect(after.resolved_at).not.toBeNull();
    const ev = await ownerEvents(owner, { ref_id: rej.id, event_type: "sync_rejection.resolved" });
    expect(ev.length).toBe(1);
    expect(ev[0].actor).toBe(t.office);
    expect((ev[0].payload as Record<string, unknown>).applied).toMatchObject({ revision: 2 });
    expect((ev[0].payload as Record<string, unknown>).original_actor).toBe(t.techB);

    const again = await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "discarded" });
    expect(again.status).toBe(409);
    const done = (await call("GET", t.office, "/sync/rejections?resolved=1")).body as { rejections: RejectionOut[] };
    expect(done.rejections.map((x) => x.id)).toEqual([rej.id]);
  });

  it("PATCH adopted (actor_revoked, new row): created as the office actor; the held row's author stays on the rejection", async () => {
    const held = syncSet(t, t.revoked, { walk_id: draftWalk.id, room_hint: "Garage", kind: "note", body: "from a revoked phone" });
    const r = await push(t.revoked, [{ table: "places.location_notes", row: held }], draftWalk.id as string);
    expect(r.rejected[0]).toMatchObject({ id: held.id, reason: "actor_revoked" });
    const rej = await rejectionFor(held.id as string);

    const a = await call("PATCH", t.designer, `/sync/rejections/${rej.id}`, { resolution: "adopted" }); // designer is admin here
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ applied: { id: held.id, op: "created", revision: 1 } });
    const row = (await ownerRow(owner, "places.location_notes", held.id as string))!;
    expect(row.created_by).toBe(t.designer);
    expect(row.body).toBe("from a revoked phone");
    expect(row.walk_id).toBe(draftWalk.id);
    expect((await rejectionFor(held.id as string)).resolution).toBe("adopted");
    // the walk's note count now reflects the adopted row
    const w = (await call("GET", t.office, `/walks/${draftWalk.id}`)).body as { walk: WalkOut };
    expect(w.walk.counts.notes).toBe(3);
  });

  it("PATCH adopted (no_checkout): refused and rolled back while office lacks the checkout; lands once office holds it", async () => {
    const room = syncSet(t, t.techA, { project_id: t.project, account_id: t.account, name: "Pantry", room_type: "pantry", level: "1", sort_order: 9 });
    const r = await push(t.techA, [{ table: "places.rooms", row: room }]);
    expect(r.rejected[0]).toMatchObject({ id: room.id, reason: "no_checkout" });
    const rej = await rejectionFor(room.id as string);

    await setCheckout(owner, t, t.designerB); // someone else holds it
    const refused = await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "adopted" });
    expect(refused.status).toBe(409);
    expect((refused.body as { rejected: { reason: string } }).rejected.reason).toBe("no_checkout");
    expect(await ownerRow(owner, "places.rooms", room.id as string)).toBeNull();
    expect((await rejectionFor(room.id as string)).resolved_at).toBeNull();
    expect(await ownerCount(owner, "places.sync_rejections", { ref_id: room.id as string })).toBe(1); // the refused retry wrote nothing
    expect((await ownerEvents(owner, { ref_id: rej.id })).length).toBe(0);

    await setCheckout(owner, t, t.office);
    const ok = await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "adopted" });
    expect(ok.status).toBe(200);
    const row = (await ownerRow(owner, "places.rooms", room.id as string))!;
    expect(row.name).toBe("Pantry");
    expect(row.created_by).toBe(t.office);
    expect(await ownerCount(owner, "places.structure_changes", { ref_id: room.id as string, change_kind: "created" })).toBe(1);
    await setCheckout(owner, t, null);
  });

  it("PATCH discarded / superseded; 'adopted' on a non-held reason (schema) → 409; unknown id → 404", async () => {
    const bad = syncSet(t, t.techA, { walk_id: draftWalk.id, kind: "note", body: "no occurred_at", occurred_at: undefined });
    const r = await push(t.techA, [{ table: "places.location_notes", row: bad }], draftWalk.id as string);
    expect(r.rejected[0]).toMatchObject({ id: bad.id, reason: "schema" });
    const rej = await rejectionFor(bad.id as string);
    const no = await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "adopted" });
    expect(no.status).toBe(409);
    expect((await rejectionFor(bad.id as string)).resolved_at).toBeNull();

    const d = await call("PATCH", t.office, `/sync/rejections/${rej.id}`, { resolution: "discarded", note: "malformed" });
    expect(d.status).toBe(200);
    expect((await rejectionFor(bad.id as string)).resolution).toBe("discarded");
    expect(await ownerRow(owner, "places.location_notes", bad.id as string)).toBeNull();
    const ev = await ownerEvents(owner, { ref_id: rej.id, event_type: "sync_rejection.resolved" });
    expect((ev[0].payload as Record<string, unknown>).resolution).toBe("discarded");

    // superseded: techB's stale edit of its own note
    const stale = syncSet(t, t.techB, { walk_id: attachedWalk.id, project_id: t.project, room_id: t.rooms.foyer, kind: "note", body: "v1" });
    expect((await push(t.techB, [{ table: "places.location_notes", row: stale }], attachedWalk.id as string)).rejected).toEqual([]);
    expect((await push(t.techB, [{ table: "places.location_notes", row: { ...stale, revision: 3, body: "v3" } }], attachedWalk.id as string)).rejected).toEqual([]);
    const s = await push(t.techB, [{ table: "places.location_notes", row: { ...stale, revision: 2, body: "v2" } }], attachedWalk.id as string);
    expect(s.rejected[0].reason).toBe("stale_revision");
    const srej = await rejectionFor(stale.id as string);
    expect((await call("PATCH", t.office, `/sync/rejections/${srej.id}`, { resolution: "superseded" })).status).toBe(200);
    expect((await rejectionFor(stale.id as string)).resolution).toBe("superseded");

    expect((await call("PATCH", t.office, `/sync/rejections/${crypto.randomUUID()}`, { resolution: "discarded" })).status).toBe(404);
  });

  //--------------------------------------------------------------------------------
  // GET /members · GET /projects
  //--------------------------------------------------------------------------------

  it("GET /members: every live member of the org with name / email / role / is_admin / revoked", async () => {
    const r = await call("GET", t.techA, "/members");
    expect(r.status).toBe(200);
    const members = (r.body as { members: { id: string; name: string; email: string | null; role: string; is_admin: boolean; revoked: boolean }[] }).members;
    expect(members.length).toBe(6);
    expect(members.find((m) => m.id === t.designer)).toMatchObject({ name: "Test Designer", role: "designer", is_admin: true, revoked: false });
    expect(members.find((m) => m.id === t.revoked)).toMatchObject({ name: "Test Revoked", role: "technician", is_admin: false, revoked: true });
    expect(members.find((m) => m.id === t.office)!.email).toMatch(/^office@/);
    // sorted by name
    expect(members.map((m) => m.name)).toEqual([...members.map((m) => m.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it("GET /projects: account_name, published_revision, live checkout (with name) or null, unsynced_walks = walks with pending files", async () => {
    const r = await call("GET", t.techB, "/projects");
    expect(r.status).toBe(200);
    const projects = (r.body as { projects: Record<string, unknown>[] }).projects;
    expect(projects.length).toBe(1);
    expect(projects[0]).toMatchObject({ id: t.project, name: "Test House — 1 Example Ct", account_id: t.account, account_name: "Example Homeowner (test)", published_revision: 0, checkout: null, unsynced_walks: 0 });

    // attach techA's draft walk (carries a pending file) → the project now has one unsynced walk
    expect((await call("POST", t.techA, `/walks/${draftWalk.id}/attach`, { project_id: t.project })).status).toBe(200);
    await setCheckout(owner, t, t.designerB);
    const r2 = (await call("GET", t.techB, "/projects")).body as { projects: Record<string, unknown>[] };
    expect(r2.projects[0]).toMatchObject({ unsynced_walks: 1, checkout: { user_id: t.designerB, user_name: "Test Designer B" } });
    expect((r2.projects[0].checkout as { expires_at: string }).expires_at).toBeTruthy();

    // an expired checkout reads as null
    await setCheckout(owner, t, t.designerB, -1000);
    const r3 = (await call("GET", t.techB, "/projects")).body as { projects: Record<string, unknown>[] };
    expect(r3.projects[0].checkout).toBeNull();
    await setCheckout(owner, t, null);

    expect((await call("GET", t.techB, "/projects?since=bad")).status).toBe(400);
    const none = (await call("GET", t.techB, `/projects?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).body as { projects: unknown[] };
    expect(none.projects).toEqual([]);
  });

  it("routes: wrong method → 405; another organization's member cannot see these walks / rejections", async () => {
    expect((await call("POST", t.office, "/walks")).status).toBe(405);
    expect((await call("DELETE", t.office, "/members")).status).toBe(405);
    expect((await call("GET", t.office, `/sync/rejections/${crypto.randomUUID()}`)).status).toBe(405);
    const other = await createTestOrg(owner, "office-other");
    const w = await callSync(env, syncRequest("GET", "/walks", { actor: other.office, org: other.org }));
    expect((w.body as { walks: unknown[] }).walks).toEqual([]);
    const x = await callSync(env, syncRequest("GET", `/walks/${draftWalk.id}`, { actor: other.office, org: other.org }));
    expect(x.status).toBe(404);
    const rj = await callSync(env, syncRequest("GET", "/sync/rejections", { actor: other.office, org: other.org }));
    expect((rj.body as { rejections: unknown[] }).rejections).toEqual([]);
  });
});
