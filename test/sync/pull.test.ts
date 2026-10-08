// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// GET /sync/pull — per-row incremental feed for one project; never a whole-project replace.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, setCheckout, publishAsOwner, syncEnv, syncRequest, callSync, syncSet, type Sql, type TestOrg } from "./_db";
import type { PullResult } from "../../src/sync/pull";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

describe.skipIf(!available)("GET /sync/pull", () => {
  let owner: Sql;
  let t: TestOrg;
  let other: TestOrg;
  const env = syncEnv();

  const pull = async (actor: string, qs: string) => callSync(env, syncRequest("GET", `/sync/pull?${qs}`, { actor, org: t.org }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[]) =>
    (await callSync(env, syncRequest("POST", "/sync/push", { actor, org: t.org, body: { device_id: "test-device", rows } }))).body as PushResult;
  const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id as string).sort();

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "pull");
    other = await createTestOrg(owner, "pull-other");
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("400 without project_id or with a bad since; 404 for a project outside the org; 405 on POST", async () => {
    expect((await pull(t.techA, "")).status).toBe(400);
    expect((await pull(t.techA, `project_id=${t.project}&since=yesterday`)).status).toBe(400);
    expect((await pull(t.techA, `project_id=${other.project}`)).status).toBe(404); // RLS: Org B's project is invisible
    expect((await callSync(env, syncRequest("POST", "/sync/pull", { actor: t.techA, org: t.org, body: {} }))).status).toBe(405);
  });

  it("initial pull (no since) = the checkout snapshot: structure_state + current structure rows, row by row", async () => {
    const r = await pull(t.techA, `project_id=${t.project}`);
    expect(r.status).toBe(200);
    const b = r.body as PullResult;
    expect(b.structure_state).toMatchObject({ working_revision: 1, published_revision: 0, published_drawing_version_id: null });
    expect(ids(b.structure["places.rooms"])).toEqual([t.rooms.foyer, t.rooms.kitchen].sort());
    expect(ids(b.structure["places.locations"])).toEqual([t.locationTv]);
    expect(ids(b.structure["drawings.drawings"])).toEqual([t.drawing, t.whiteboard].sort());
    expect(ids(b.structure["drawings.pages"])).toEqual([t.page1, t.page2, t.boardPage].sort());
    expect(ids(b.structure["drawings.layers"])).toEqual([t.layerDesign, t.layerFieldNotes, t.layerBoard].sort());
    expect(b.captures["places.location_notes"]).toEqual([]);
    expect(b.truncated).toEqual([]);
    expect(b.next_since).not.toBeNull();
    // nothing from the other Organization leaks in
    for (const rows of [...Object.values(b.structure), ...Object.values(b.captures)]) {
      for (const row of rows) expect(row.organization_id).toBe(t.org);
    }
  });

  it("since = incremental: only rows received after it, tombstones included; next_since advances", async () => {
    const r0 = (await pull(t.techA, `project_id=${t.project}`)).body as PullResult;
    const since0 = r0.next_since as string;
    const empty = (await pull(t.techA, `project_id=${t.project}&since=${encodeURIComponent(since0)}`)).body as PullResult;
    expect(Object.values(empty.structure).every((rows) => rows.length === 0)).toBe(true);
    expect(Object.values(empty.captures).every((rows) => rows.length === 0)).toBe(true);
    expect(empty.next_since).toBe(since0);

    // tech B captures; tech A pulls → sees B's rows once received (not before: they did not exist on the server)
    const note = syncSet(t, t.techB, { project_id: t.project, room_id: t.rooms.kitchen, body: "from B" });
    const walk = syncSet(t, t.techB, { project_id: t.project, status: "attached", started_at: new Date().toISOString() });
    expect((await push(t.techB, [{ table: "places.walks", row: walk }, { table: "places.location_notes", row: note }])).rejected).toEqual([]);
    const r1 = (await pull(t.techA, `project_id=${t.project}&since=${encodeURIComponent(since0)}`)).body as PullResult;
    expect(ids(r1.captures["places.location_notes"])).toEqual([note.id]);
    expect(ids(r1.captures["places.walks"])).toEqual([walk.id]);
    expect(r1.structure["places.rooms"]).toEqual([]);
    const since1 = r1.next_since as string;
    expect(new Date(since1).getTime()).toBeGreaterThan(new Date(since0).getTime());

    // B tombstones the note → the tombstone is pulled, not a hole
    expect((await push(t.techB, [{ table: "places.location_notes", row: { ...note, revision: 2, deleted_at: new Date().toISOString() } }])).rejected).toEqual([]);
    const r2 = (await pull(t.techA, `project_id=${t.project}&since=${encodeURIComponent(since1)}`)).body as PullResult;
    expect(r2.captures["places.location_notes"].length).toBe(1);
    expect(r2.captures["places.location_notes"][0].deleted_at).not.toBeNull();
    expect(r2.captures["places.walks"]).toEqual([]);
  });

  it("device_placements split by capture_kind: plan = structure, as_walked = capture", async () => {
    await setCheckout(owner, t, t.designer);
    const plan = syncSet(t, t.designer, { project_id: t.project, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "plan", product_name: "TV 65" });
    const walked = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "as_walked", product_name: "TV 65 (as walked)" });
    expect((await push(t.designer, [{ table: "places.device_placements", row: plan }])).rejected).toEqual([]);
    expect((await push(t.techA, [{ table: "places.device_placements", row: walked }])).rejected).toEqual([]);
    const b = (await pull(t.techB, `project_id=${t.project}`)).body as PullResult;
    expect(ids(b.structure["places.device_placements"])).toEqual([plan.id]);
    expect(ids(b.captures["places.device_placements"])).toEqual([walked.id]);
  });

  it("draft-walk captures (no project) are NOT in any project pull; annotations come via page → drawing → project", async () => {
    const draft = syncSet(t, t.techA, { project_id: null, status: "draft", label: "walk-in", started_at: new Date().toISOString() });
    const hinted = syncSet(t, t.techA, { walk_id: draft.id, room_hint: "Pantry", body: "draft note" });
    const ann = syncSet(t, t.techA, { page_id: t.page1, layer_id: t.layerFieldNotes, kind: "rect", geometry: { x: 1, y: 1, w: 2, h: 2 } });
    expect((await push(t.techA, [{ table: "places.walks", row: draft }, { table: "places.location_notes", row: hinted }, { table: "drawings.annotations", row: ann }])).rejected).toEqual([]);
    const b = (await pull(t.techB, `project_id=${t.project}`)).body as PullResult;
    expect(ids(b.captures["places.walks"])).not.toContain(draft.id);
    expect(ids(b.captures["places.location_notes"])).not.toContain(hinted.id);
    expect(ids(b.captures["drawings.annotations"])).toContain(ann.id);
  });

  it("after publish the pull reports the new published_revision and the pinned drawing version", async () => {
    await setCheckout(owner, t, t.designer);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${t.org}, true)`;
      await tx`select places.publish_revision(${t.project}, ${t.designer}, ${t.version})`;
    });
    const b = (await pull(t.techA, `project_id=${t.project}`)).body as PullResult;
    expect(b.structure_state).toMatchObject({ published_revision: 1, working_revision: 2, published_drawing_version_id: t.version, checkout_user_id: null });
    expect(b.structure_state?.published_at).not.toBeNull();
    void publishAsOwner;
  });
});
