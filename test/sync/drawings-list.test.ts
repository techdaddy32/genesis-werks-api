// row: W5c · run: run-2026-10-07-drawing-layer-11 · 2026-10-09 — drawings list + bundle
// GET /drawings · GET /drawings/:id (sync/drawings-list.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, syncSet, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

interface DrawingOut {
  id: string; kind: string; working_title: string | null; address_hint: string | null;
  project_id: string | null; project_name: string | null; account_id: string | null; account_name: string | null;
  created_by: string; created_by_name: string | null; created_at: string; received_at: string; attached_at: string | null; detached_at: string | null;
  page_count: number; annotation_count: number; first_page_id: string | null; first_preview_file_id: string | null; walk_id: string | null;
}
interface ListOut { drawings: DrawingOut[]; since: string | null; next_since: string | null; limit: number; truncated: boolean }
interface BundleOut {
  drawing: DrawingOut;
  pages: { id: string; ordinal: number; drawing_version_id: string | null; version_no: number | null; preview_file_id: string | null }[];
  layers: { id: string; name: string; ordinal: number; class: string; deleted_at: string | null }[];
  annotations: { id: string; page_id: string; layer_id: string; kind: string; deleted_at?: unknown }[];
  versions: { id: string; version_no: number; label: string | null; status: string; latest_transition: unknown }[];
}

describe.skipIf(!available)("drawings list + bundle (W5c)", () => {
  let owner: Sql;
  let t: TestOrg;
  let t2: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, org?: string, body?: unknown) =>
    callSync(env, syncRequest(method, path, { actor, org: org ?? t.org, ...(body !== undefined ? { body } : {}) }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[], walkId?: string) =>
    (await call("POST", actor, "/sync/push", undefined, { device_id: "phone-a", walk_id: walkId, rows })).body as PushResult;
  const list = async (actor: string, qs = "", org?: string) => {
    const r = await call("GET", actor, `/drawings${qs}`, org);
    expect(r.status).toBe(200);
    return r.body as ListOut;
  };
  const ids = (b: ListOut) => b.drawings.map((d) => d.id);

  // techA: an UNATTACHED plan (one page with a preview, one live + one tombstoned annotation); no walk anywhere
  let unfiledA: Record<string, unknown>;
  let pageA: Record<string, unknown>;
  let fileA: Record<string, unknown>;
  let annLive: Record<string, unknown>;
  let annGone: Record<string, unknown>;
  let layersA: { id: string; name: string }[];
  // techB: an UNATTACHED whiteboard + an attached walk on the fixture project
  let boardB: Record<string, unknown>;
  let boardPageB: Record<string, unknown>;
  let walkB: Record<string, unknown>;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "dlist");
    t2 = await createTestOrg(owner, "dlist-other");

    unfiledA = syncSet(t, t.techA, { kind: "plan", working_title: "Unfiled markup", address_hint: "1 Example Ct" });
    const r0 = await push(t.techA, [{ table: "drawings.drawings", row: unfiledA }]);
    expect(r0.rejected).toEqual([]);
    layersA = r0.created_layers.map((l) => ({ id: l.id, name: l.name }));
    const fieldNotes = layersA.find((l) => l.name === "Field Notes")!.id;
    fileA = syncSet(t, t.techA, { kind: "preview", filename: "sheet-a.png", content_type: "image/png" });
    expect((await push(t.techA, [{ table: "shared.files", row: fileA }])).rejected).toEqual([]);
    pageA = syncSet(t, t.techA, { drawing_id: unfiledA.id, ordinal: 1, name: "Sheet A", source_page_no: 1, preview_file_id: fileA.id });
    annLive = syncSet(t, t.techA, { page_id: pageA.id, layer_id: fieldNotes, kind: "callout", geometry: { x: 1, y: 1 }, z: 2, label: "keep me" });
    annGone = syncSet(t, t.techA, { page_id: pageA.id, layer_id: fieldNotes, kind: "rect", geometry: { x: 5, y: 5, w: 1, h: 1 }, z: 1, label: "gone" });
    const r1 = await push(t.techA, [{ table: "drawings.pages", row: pageA }, { table: "drawings.annotations", row: annLive }, { table: "drawings.annotations", row: annGone }]);
    expect(r1.rejected).toEqual([]);
    const r2 = await push(t.techA, [{ table: "drawings.annotations", row: { ...annGone, revision: 2, deleted_at: new Date().toISOString() } }]);
    expect(r2.accepted.map((a) => a.op)).toEqual(["tombstoned"]);

    boardB = syncSet(t, t.techB, { kind: "whiteboard", working_title: "Quick board", address_hint: null });
    const r3 = await push(t.techB, [{ table: "drawings.drawings", row: boardB }]);
    expect(r3.rejected).toEqual([]);
    boardPageB = syncSet(t, t.techB, { drawing_id: boardB.id, ordinal: 1, name: "Board 1" });
    expect((await push(t.techB, [{ table: "drawings.pages", row: boardPageB }])).rejected).toEqual([]);
    walkB = syncSet(t, t.techB, { project_id: t.project, account_id: t.account, status: "attached", label: "walk on the test house", started_at: new Date().toISOString() });
    expect((await push(t.techB, [{ table: "places.walks", row: walkB }], walkB.id as string)).rejected).toEqual([]);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  //--------------------------------------------------------------------------------
  // GET /drawings
  //--------------------------------------------------------------------------------

  it("GET /drawings: office sees every live drawing newest first; unattached=1 / project_id / account_id / kind filters; the three anchors are mutually exclusive", async () => {
    const all = await list(t.office);
    expect(ids(all).sort()).toEqual([unfiledA.id, boardB.id, t.drawing, t.whiteboard].sort());
    // newest received_at first: boardB was pushed after unfiledA, both after the fixtures
    expect(ids(all).slice(0, 2)).toEqual([boardB.id, unfiledA.id]);
    for (let i = 1; i < all.drawings.length; i++) expect(Date.parse(all.drawings[i - 1].received_at)).toBeGreaterThanOrEqual(Date.parse(all.drawings[i].received_at));

    expect(ids(await list(t.office, "?unattached=1"))).toEqual([boardB.id, unfiledA.id]);
    expect(ids(await list(t.office, `?project_id=${t.project}`)).sort()).toEqual([t.drawing, t.whiteboard].sort());
    expect(ids(await list(t.office, `?account_id=${t.account}`))).toEqual([]); // the fixtures are project-anchored, not account-anchored
    expect(ids(await list(t.office, "?kind=plan")).sort()).toEqual([unfiledA.id, t.drawing].sort());
    expect(ids(await list(t.office, "?kind=whiteboard&unattached=1"))).toEqual([boardB.id]);

    expect((await call("GET", t.office, `/drawings?unattached=1&project_id=${t.project}`)).status).toBe(400);
    expect((await call("GET", t.office, `/drawings?project_id=${t.project}&account_id=${t.account}`)).status).toBe(400);
    expect((await call("GET", t.office, "/drawings?kind=sketch")).status).toBe(400);
    expect((await call("GET", t.office, "/drawings?project_id=nope")).status).toBe(400);
    expect((await call("GET", t.office, "/drawings?limit=0")).status).toBe(400);
    expect((await call("GET", t.office, "/drawings?since=notadate")).status).toBe(400);
    expect((await call("POST", t.office, "/drawings")).status).toBe(405);
  });

  it("GET /drawings rows: names, live counts (tombstoned annotation excluded), first page + preview, project/account names through the anchor", async () => {
    const all = await list(t.office);
    const a = all.drawings.find((d) => d.id === unfiledA.id)!;
    expect(a).toMatchObject({
      kind: "plan", working_title: "Unfiled markup", address_hint: "1 Example Ct",
      project_id: null, project_name: null, account_id: null, account_name: null,
      created_by: t.techA, created_by_name: "Test Tech A", attached_at: null, detached_at: null,
      page_count: 1, annotation_count: 1, first_page_id: pageA.id, first_preview_file_id: fileA.id, walk_id: null,
    });
    expect(a.received_at).toBeTruthy();
    expect(a.created_at).toBeTruthy();

    const fixture = all.drawings.find((d) => d.id === t.drawing)!;
    expect(fixture).toMatchObject({
      kind: "plan", project_id: t.project, project_name: "Test House — 1 Example Ct", account_id: null, account_name: "Example Homeowner (test)",
      created_by: t.designer, created_by_name: "Test Designer", page_count: 2, annotation_count: 0, first_page_id: t.page1, first_preview_file_id: null,
    });
    expect(fixture.attached_at).toBeTruthy();

    const b = all.drawings.find((d) => d.id === boardB.id)!;
    expect(b).toMatchObject({ kind: "whiteboard", page_count: 1, annotation_count: 0, first_page_id: boardPageB.id, first_preview_file_id: null, created_by_name: "Test Tech B" });
  });

  it("GET /drawings visibility: a technician sees their own drawings + attached drawings of projects they walked; designer sees all", async () => {
    // techA: no walks → only the drawing they made
    expect(ids(await list(t.techA))).toEqual([unfiledA.id]);
    expect(ids(await list(t.techA, "?unattached=1"))).toEqual([unfiledA.id]);
    expect(ids(await list(t.techA, `?project_id=${t.project}`))).toEqual([]);
    // techB: own board + the two fixtures attached to the project they have a walk on — never techA's unfiled plan
    expect(ids(await list(t.techB)).sort()).toEqual([boardB.id, t.drawing, t.whiteboard].sort());
    expect(ids(await list(t.techB, "?unattached=1"))).toEqual([boardB.id]);
    // designerB (non-admin designer) sees everything
    expect(ids(await list(t.designerB)).length).toBe(4);
  });

  it("GET /drawings cursor: limit → truncated + next_since; since=next_since → nothing newer; since below the newest → only newer rows", async () => {
    const page = await list(t.office, "?limit=1");
    expect(page.truncated).toBe(true);
    expect(page.limit).toBe(1);
    expect(page.drawings.length).toBe(1);
    expect(page.drawings[0].id).toBe(boardB.id);
    expect(page.next_since).toBeTruthy();
    const after = await list(t.office, `?since=${encodeURIComponent(page.next_since!)}`);
    expect(after.drawings).toEqual([]);
    expect(after.since).toBe(page.next_since);
    expect(after.next_since).toBe(page.next_since); // no rows → the cursor the caller sent comes back
    expect(after.truncated).toBe(false);

    // the second page's cursor (unfiledA's received_at, microsecond text) → strictly newer = boardB only
    const two = await list(t.office, "?limit=2");
    expect(ids(two)).toEqual([boardB.id, unfiledA.id]);
    const older = await list(t.office, "?limit=1&since=" + encodeURIComponent(unfiledA.occurred_at as string));
    expect(ids(older)).toEqual([boardB.id]);
    expect(older.truncated).toBe(true); // unfiledA itself was received after its occurred_at, so it is still "newer" → 2 match, limit 1
  });

  //--------------------------------------------------------------------------------
  // GET /drawings/:id
  //--------------------------------------------------------------------------------

  it("GET /drawings/:id bundle (unattached plan, creator): drawing + pages + layers in render order + live annotations only + versions []", async () => {
    const r = await call("GET", t.techA, `/drawings/${unfiledA.id}`);
    expect(r.status).toBe(200);
    const b = r.body as BundleOut;
    expect(b.drawing).toMatchObject({ id: unfiledA.id, kind: "plan", working_title: "Unfiled markup", page_count: 1, annotation_count: 1, first_page_id: pageA.id, first_preview_file_id: fileA.id, created_by_name: "Test Tech A" });
    expect((b.drawing as unknown as Record<string, unknown>)._cursor).toBeUndefined();

    expect(b.pages.map((p) => p.id)).toEqual([pageA.id]);
    expect(b.pages[0]).toMatchObject({ ordinal: 1, drawing_version_id: null, version_no: null, preview_file_id: fileA.id });

    // every plan template minted on create, in ordinal order (Design 1 … Scratch 6), no tombstones
    expect(b.layers.map((l) => l.name)).toEqual(["Design", "Field Notes", "Rough-In", "Trim", "Service", "Scratch"]);
    for (let i = 1; i < b.layers.length; i++) expect(b.layers[i - 1].ordinal).toBeLessThanOrEqual(b.layers[i].ordinal);
    expect(new Set(b.layers.map((l) => l.id))).toEqual(new Set(layersA.map((l) => l.id)));
    expect(b.layers.every((l) => l.deleted_at === null)).toBe(true);

    // the tombstoned rect is gone; the live callout is there with its layer
    expect(b.annotations.map((a) => a.id)).toEqual([annLive.id]);
    expect(b.annotations[0]).toMatchObject({ page_id: pageA.id, kind: "callout", layer_id: layersA.find((l) => l.name === "Field Notes")!.id });

    expect(b.versions).toEqual([]); // a field-made plan has no uploaded version yet
  });

  it("GET /drawings/:id bundle (attached plan with a version): versions[] carries the versions view; whiteboard → versions []; layers tombstoned are excluded", async () => {
    const r = await call("GET", t.office, `/drawings/${t.drawing}`);
    expect(r.status).toBe(200);
    const b = r.body as BundleOut;
    expect(b.drawing).toMatchObject({ id: t.drawing, project_id: t.project, project_name: "Test House — 1 Example Ct", page_count: 2 });
    expect(b.pages.map((p) => p.id)).toEqual([t.page1, t.page2]);
    expect(b.pages[0]).toMatchObject({ drawing_version_id: t.version, version_no: 1 });
    expect(b.versions.length).toBe(1);
    expect(b.versions[0]).toMatchObject({ id: t.version, version_no: 1, label: "v1", status: "draft", latest_transition: null });
    expect((b.versions[0] as unknown as Record<string, unknown>).organization_id).toBeUndefined(); // versionView strips it
    expect(b.layers.map((l) => l.name)).toEqual(["Design", "Field Notes"]);

    // tombstone a layer owner-side: the bundle no longer lists it
    const extra = crypto.randomUUID();
    await owner`insert into drawings.layers (id, organization_id, drawing_id, name, ordinal, class, write_policy, occurred_at, created_by, deleted_at, deleted_by)
                values (${extra}, ${t.org}, ${t.drawing}, 'Dead layer', 0, 'capture', 'any_member', now(), ${t.designer}, now(), ${t.designer})`;
    const again = (await call("GET", t.office, `/drawings/${t.drawing}`)).body as BundleOut;
    expect(again.layers.map((l) => l.id)).not.toContain(extra);

    const w = await call("GET", t.techB, `/drawings/${t.whiteboard}`); // techB walked the project → may open the attached board
    expect(w.status).toBe(200);
    const wb = w.body as BundleOut;
    expect(wb.drawing.kind).toBe("whiteboard");
    expect(wb.versions).toEqual([]);
    expect(wb.pages.map((p) => p.id)).toEqual([t.boardPage]);
    expect(wb.layers.map((l) => l.name)).toEqual(["Board"]);
  });

  it("GET /drawings/:id: 403 for a technician outside the visibility rule; 404 unknown / tombstoned; 400 not a UUID; the sibling /drawings/:id/layers route is not shadowed", async () => {
    expect((await call("GET", t.techA, `/drawings/${boardB.id}`)).status).toBe(403); // techB's board, techA has no walk anywhere
    expect((await call("GET", t.techA, `/drawings/${t.drawing}`)).status).toBe(403); // attached, but techA never walked the project
    expect((await call("GET", t.techB, `/drawings/${unfiledA.id}`)).status).toBe(403);
    expect((await call("GET", t.office, `/drawings/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", t.office, "/drawings/not-a-uuid")).status).toBe(400);
    expect((await call("DELETE", t.office, `/drawings/${unfiledA.id}`)).status).toBe(405);

    // a tombstoned drawing is neither listed nor openable
    const dead = syncSet(t, t.techA, { kind: "whiteboard", working_title: "dead board" });
    expect((await push(t.techA, [{ table: "drawings.drawings", row: dead }])).rejected).toEqual([]);
    expect(ids(await list(t.techA))).toContain(dead.id);
    await owner`update drawings.drawings set deleted_at = now(), deleted_by = ${t.techA} where id = ${dead.id}`;
    expect(ids(await list(t.techA))).not.toContain(dead.id);
    expect((await call("GET", t.office, `/drawings/${dead.id}`)).status).toBe(404);

    // the one-segment regex leaves the layer / version routes to their own handlers
    const layers = await call("GET", t.office, `/drawings/${unfiledA.id}/layers`);
    expect(layers.status).toBe(200);
    expect((layers.body as { layers: unknown[] }).layers.length).toBe(6);
    expect((await call("GET", t.office, `/drawings/${t.drawing}/versions`)).status).toBe(200);
  });

  it("cross-org isolation: another Organization's office neither lists nor opens these drawings", async () => {
    const other = await list(t2.office, "", t2.org);
    expect(ids(other).sort()).toEqual([t2.drawing, t2.whiteboard].sort());
    expect(ids(other)).not.toContain(unfiledA.id);
    expect((await call("GET", t2.office, `/drawings/${unfiledA.id}`, t2.org)).status).toBe(404);
    expect((await call("GET", t2.office, `/drawings/${t.drawing}`, t2.org)).status).toBe(404);
    // and a project filter for the other org's project yields nothing here
    expect(ids(await list(t2.office, `?project_id=${t.project}`, t2.org))).toEqual([]);
  });
});
