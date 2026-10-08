// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08
// Drawing-version lifecycle (spec §2b Amendment 2): the transition graph, roles, required note /
// client name, audit rows + events, auto-supersede on client_approved, whiteboards 409,
// GET /drawings/:id/versions, the version compare, and the publish pin rule.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, ownerEvents, ownerRow, ownerCount, type Sql, type TestOrg } from "./_db";
import { isAllowedTransition, VERSION_STATUSES, type VersionStatus } from "../../src/sync/versions";

const available = await dbAvailable();

interface TransitionBody {
  op: string;
  from: string;
  to: string;
  version: Record<string, unknown>;
  transition: Record<string, unknown>;
  superseded: { id: string; version_no: number; from_status: string }[];
}
interface CompareBody {
  a: { id: string; version_no: number; status: string };
  b: { id: string; version_no: number; status: string };
  pages: { source_page_no: number; a_page_id: string | null; a_preview_file_id: string | null; b_page_id: string | null; b_preview_file_id: string | null }[];
  changes: { entity: string; key: string; change: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
  summary: Record<string, number>;
}

const T0 = "2026-10-08T09:00:00Z";

describe.skipIf(!available)("drawing-version lifecycle (Amendment 2)", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const go = async (actor: string, version: string, body: Record<string, unknown>) => call("POST", actor, `/drawing-versions/${version}/transition`, body);
  const status = async (id: string) => (await ownerRow(owner, "drawings.drawing_versions", id))!;

  let v2: string;
  let v2p1: string;
  let v2p2: string;
  let previewA: string;
  let previewB: string;
  // compare fixtures
  let annA1: string, annA2: string, annB1: string, annB2: string;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "versions");
    v2 = crypto.randomUUID(); v2p1 = crypto.randomUUID(); v2p2 = crypto.randomUUID();
    previewA = crypto.randomUUID(); previewB = crypto.randomUUID();
    await owner`insert into shared.files (id, organization_id, kind, filename, content_type, storage_key, upload_status, occurred_at, created_by) values
      (${previewA}, ${t.org}, 'plan_preview', 'v1-p1.jpg', 'image/jpeg', ${`${t.org}/${previewA}`}, 'verified', ${T0}, ${t.designer}),
      (${previewB}, ${t.org}, 'plan_preview', 'v2-p1.jpg', 'image/jpeg', ${`${t.org}/${previewB}`}, 'verified', ${T0}, ${t.designer})`;
    await owner`update drawings.pages set preview_file_id = ${previewA} where id = ${t.page1}`;
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, label, page_count, occurred_at, created_by)
                values (${v2}, ${t.org}, ${t.drawing}, 2, 'v2 — revised kitchen', 2, ${T0}, ${t.designer})`;
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, name, source_page_no, preview_file_id, occurred_at, created_by) values
      (${v2p1}, ${t.org}, ${t.drawing}, ${v2}, 1, 'Floor 1', 1, ${previewB}, ${T0}, ${t.designer}),
      (${v2p2}, ${t.org}, ${t.drawing}, ${v2}, 2, 'Floor 2', 2, null,        ${T0}, ${t.designer})`;
    // compare fixtures — v1 (page1/page2) vs v2 (v2p1/v2p2)
    const poly = (id: string, page: string, room: string | null, hint: string | null, pts: number[][], meta = {}) => owner`
      insert into places.room_polygons (id, organization_id, account_id, project_id, drawing_id, page_id, room_id, room_hint, polygon, metadata, occurred_at, created_by)
      values (${id}, ${t.org}, ${t.account}, ${t.project}, ${t.drawing}, ${page}, ${room}, ${hint}, ${owner.json({ points: pts } as never)}, ${owner.json(meta as never)}, ${T0}, ${t.designer})`;
    await poly(crypto.randomUUID(), t.page1, t.rooms.kitchen, null, [[0, 0], [10, 0], [10, 10]]);                    // kitchen: moved in v2
    await poly(crypto.randomUUID(), v2p1, t.rooms.kitchen, null, [[0, 0], [12, 0], [12, 10]]);
    await poly(crypto.randomUUID(), t.page1, t.rooms.foyer, null, [[20, 0], [30, 0], [30, 10]]);                     // foyer: removed in v2
    await poly(crypto.randomUUID(), v2p2, null, "Bonus Rm", [[40, 40], [50, 40], [50, 50]]);                         // hinted: added in v2
    const pin = (id: string, page: string, x: number, label: string | null) => owner`
      insert into places.location_placements (id, organization_id, account_id, project_id, drawing_id, page_id, location_id, room_id, x, y, rotation, symbol_key, label_text, occurred_at, created_by)
      values (${id}, ${t.org}, ${t.account}, ${t.project}, ${t.drawing}, ${page}, ${t.locationTv}, ${t.rooms.kitchen}, ${x}, 5, 0, 'tv', ${label}, ${T0}, ${t.designer})`;
    await pin(crypto.randomUUID(), t.page1, 5, "TV");                                                                // same spot, label edited
    await pin(crypto.randomUUID(), v2p1, 5, "TV 65in");
    annA1 = crypto.randomUUID(); annA2 = crypto.randomUUID(); annB1 = crypto.randomUUID(); annB2 = crypto.randomUUID();
    const ann = (id: string, page: string, geom: unknown, label: string, from: string | null) => owner`
      insert into drawings.annotations (id, organization_id, page_id, layer_id, kind, class, geometry, label, z, copied_from_id, occurred_at, created_by)
      values (${id}, ${t.org}, ${page}, ${t.layerFieldNotes}, 'callout', 'capture', ${owner.json(geom as never)}, ${label}, 1, ${from}, ${T0}, ${t.techA})`;
    await ann(annA1, t.page1, { x: 1, y: 1 }, "c1", null);          // carried forward, moved
    await ann(annB1, v2p1, { x: 2, y: 2 }, "c1", annA1);
    await ann(annA2, t.page1, { x: 9, y: 9 }, "c2", null);          // not carried → removed
    await ann(annB2, v2p1, { x: 7, y: 7 }, "fresh", null);          // no lineage → added
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("the §2b graph (pure)", () => {
    const ok: [VersionStatus, VersionStatus][] = [
      ["draft", "internal_review"], ["internal_review", "internal_approved"], ["internal_review", "draft"], ["internal_approved", "client_review"],
      ["client_review", "client_approved"], ["client_review", "client_rejected"], ["client_rejected", "draft"],
      ["draft", "superseded"], ["client_approved", "superseded"], ["client_rejected", "superseded"],
    ];
    for (const [f, to] of ok) expect(isAllowedTransition(f, to), `${f} → ${to}`).toBe(true);
    const bad: [VersionStatus, VersionStatus][] = [
      ["draft", "internal_approved"], ["draft", "client_review"], ["draft", "client_approved"], ["internal_approved", "draft"], ["internal_approved", "client_approved"],
      ["client_approved", "draft"], ["client_approved", "client_review"], ["client_rejected", "client_review"], ["superseded", "draft"], ["superseded", "superseded"],
    ];
    for (const [f, to] of bad) expect(isAllowedTransition(f, to), `${f} → ${to}`).toBe(false);
    for (const s of VERSION_STATUSES) expect(isAllowedTransition(s, s), `${s} → ${s}`).toBe(false); // no self-loops
  });

  it("GET /drawings/:id/versions: whiteboard → 409; plan → versions ordered by version_no, status draft, no transition yet", async () => {
    expect((await call("GET", t.techA, `/drawings/${t.whiteboard}/versions`)).status).toBe(409);
    expect((await call("GET", t.techA, `/drawings/${crypto.randomUUID()}/versions`)).status).toBe(404);
    const r = await call("GET", t.techA, `/drawings/${t.drawing}/versions`);
    expect(r.status).toBe(200);
    const b = r.body as { drawing_id: string; published_drawing_version_id: string | null; versions: Record<string, unknown>[] };
    expect(b.drawing_id).toBe(t.drawing);
    expect(b.published_drawing_version_id).toBeNull();
    expect(b.versions.map((v) => [v.version_no, v.status, v.latest_transition])).toEqual([[1, "draft", null], [2, "draft", null]]);
    expect(b.versions[0]).toHaveProperty("client_approved_name");
    expect(b.versions[0]).toHaveProperty("superseded_by_version_id");
  });

  it("transition: technician 403; bad `to` 400; invalid edge 409 (nothing written); draft → internal_review by a designer → 200 with a transitions row, status_by/at and ONE event", async () => {
    expect((await go(t.techA, t.version, { to: "internal_review" })).status).toBe(403);
    expect((await go(t.designerB, t.version, { to: "approved" })).status).toBe(400);
    expect((await go(t.designerB, t.version, {})).status).toBe(400);
    expect((await go(t.designerB, crypto.randomUUID(), { to: "internal_review" })).status).toBe(404);
    const edge = await go(t.designerB, t.version, { to: "internal_approved" }); // skipping internal_review
    expect(edge.status).toBe(409);
    expect((await go(t.designerB, t.version, { to: "client_review" })).status).toBe(403); // the role check comes first
    expect((edge.body as { allowed: string[] }).allowed).toEqual(["internal_review", "superseded"]);
    expect(await ownerCount(owner, "drawings.drawing_version_transitions", { drawing_version_id: t.version })).toBe(0);

    const r = await go(t.designerB, t.version, { to: "internal_review" });
    expect(r.status).toBe(200);
    const b = r.body as TransitionBody;
    expect(b).toMatchObject({ op: "transitioned", from: "draft", to: "internal_review" });
    expect(b.version).toMatchObject({ id: t.version, status: "internal_review", status_by: t.designerB, revision: 2 });
    expect(b.transition).toMatchObject({ drawing_version_id: t.version, from_status: "draft", to_status: "internal_review", by: t.designerB, note: null, actor_label: null });
    const row = await status(t.version);
    expect(row.status).toBe("internal_review");
    expect(row.status_at).toBeInstanceOf(Date);
    expect(await ownerCount(owner, "drawings.drawing_version_transitions", { drawing_version_id: t.version })).toBe(1);
    expect((await ownerEvents(owner, { ref_id: t.version, event_type: "drawing_version.transitioned" })).length).toBe(1);
    const list = (await call("GET", t.techA, `/drawings/${t.drawing}/versions`)).body as { versions: { version_no: number; latest_transition: { to_status: string } | null }[] };
    expect(list.versions[0].latest_transition?.to_status).toBe("internal_review");
  });

  it("send-back needs a note (400 → 200); internal_approved stamps internal_approved_by/at; client_review is office/admin only (designer 403)", async () => {
    expect((await go(t.designerB, t.version, { to: "draft" })).status).toBe(400);
    const back = await go(t.designerB, t.version, { to: "draft", note: "legend missing on sheet 2" });
    expect(back.status).toBe(200);
    expect((back.body as TransitionBody).transition.note).toBe("legend missing on sheet 2");
    expect((await go(t.designerB, t.version, { to: "internal_review" })).status).toBe(200);
    const ok = await go(t.designer, t.version, { to: "internal_approved" }); // the admin-designer
    expect(ok.status).toBe(200);
    const row = await status(t.version);
    expect(row).toMatchObject({ status: "internal_approved", internal_approved_by: t.designer });
    expect(row.internal_approved_at).toBeInstanceOf(Date);
    expect((await go(t.designerB, t.version, { to: "client_review" })).status).toBe(403);
    const cr = await go(t.office, t.version, { to: "client_review" });
    expect(cr.status).toBe(200);
    expect((await status(t.version)).internal_approved_by).toBe(t.designer); // kept across later statuses
  });

  it("client outcomes: client_approved needs client_name (400); client_rejected needs a note (400); client_rejected → draft reopens; the row keeps its audit trail", async () => {
    expect((await go(t.office, t.version, { to: "client_approved" })).status).toBe(400);
    expect((await go(t.office, t.version, { to: "client_rejected" })).status).toBe(400);
    expect((await go(t.office, t.version, { to: "client_approved", client_name: "Jane Doe", client_at: "not a date" })).status).toBe(400);
    const rej = await go(t.office, t.version, { to: "client_rejected", note: "client wants the island moved", client_name: "Jane Doe" });
    expect(rej.status).toBe(200);
    expect((rej.body as TransitionBody).transition).toMatchObject({ to_status: "client_rejected", actor_label: "Jane Doe", note: "client wants the island moved" });
    expect((await status(t.version)).client_approved_name).toBeNull();
    expect((await go(t.office, t.version, { to: "client_review" })).status).toBe(409);
    expect((await go(t.designerB, t.version, { to: "draft" })).status).toBe(200); // the fix lands as a NEW version; this only reopens
    expect(await ownerCount(owner, "drawings.drawing_version_transitions", { drawing_version_id: t.version })).toBe(7);
    const trail = await owner<{ from_status: string; to_status: string }[]>`
      select from_status, to_status from drawings.drawing_version_transitions where drawing_version_id = ${t.version} order by at, id`;
    expect(trail.map((x) => `${x.from_status}>${x.to_status}`)).toEqual([
      "draft>internal_review", "internal_review>draft", "draft>internal_review", "internal_review>internal_approved",
      "internal_approved>client_review", "client_review>client_rejected", "client_rejected>draft",
    ]);
  });

  it("v2 reaches client_approved (name + date recorded) → every other non-superseded version of the drawing is AUTO-superseded (superseded_by_version_id, its own transitions row + event); a superseded version is terminal (409)", async () => {
    for (const [actor, to] of [[t.designerB, "internal_review"], [t.designerB, "internal_approved"], [t.office, "client_review"]] as const) {
      expect((await go(actor, v2, { to })).status).toBe(200);
    }
    const r = await go(t.office, v2, { to: "client_approved", client_name: "Jane Doe", client_at: "2026-10-07T15:30:00Z" });
    expect(r.status).toBe(200);
    const b = r.body as TransitionBody;
    expect(b.version).toMatchObject({ status: "client_approved", client_approved_name: "Jane Doe" });
    expect(new Date(b.version.client_approved_at as string).toISOString()).toBe("2026-10-07T15:30:00.000Z");
    expect(b.transition).toMatchObject({ to_status: "client_approved", actor_label: "Jane Doe" });
    expect(b.superseded).toEqual([{ id: t.version, version_no: 1, from_status: "draft" }]);
    const v1 = await status(t.version);
    expect(v1).toMatchObject({ status: "superseded", superseded_by_version_id: v2, status_by: t.office });
    expect((await status(v2)).superseded_by_version_id).toBeNull();
    const last = await owner<{ from_status: string; to_status: string; note: string }[]>`
      select from_status, to_status, note from drawings.drawing_version_transitions where drawing_version_id = ${t.version} order by at desc, id desc limit 1`;
    expect(last[0]).toMatchObject({ from_status: "draft", to_status: "superseded" });
    expect(last[0].note).toContain("auto");
    expect((await ownerEvents(owner, { ref_id: t.version, event_type: "drawing_version.transitioned" })).length).toBe(8);
    // terminal
    expect((await go(t.office, t.version, { to: "draft" })).status).toBe(409);
    expect((await go(t.office, t.version, { to: "superseded" })).status).toBe(409);
    // client_approved → only superseded remains
    expect((await go(t.office, v2, { to: "draft" })).status).toBe(409);
    // the audit table is append-only for the API role
    const api = (await import("./_db")).apiSql(1);
    try {
      await expect(api.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${t.org}, true)`;
        await tx`update drawings.drawing_version_transitions set note = 'tampered' where drawing_version_id = ${t.version}`;
      })).rejects.toThrow(/permission denied/);
      await expect(api.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${t.org}, true)`;
        await tx`delete from drawings.drawing_version_transitions where drawing_version_id = ${t.version}`;
      })).rejects.toThrow(/permission denied/);
    } finally {
      await api.end({ timeout: 2 });
    }
  });

  it("explicit supersede from any live status (designer may); a version of a whiteboard → 409 on every version route", async () => {
    const v3 = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, occurred_at, created_by) values (${v3}, ${t.org}, ${t.drawing}, 3, ${T0}, ${t.designer})`;
    expect((await go(t.techA, v3, { to: "superseded" })).status).toBe(403);
    const r = await go(t.designerB, v3, { to: "superseded" });
    expect(r.status).toBe(200);
    expect((r.body as TransitionBody).superseded).toEqual([]);
    expect((await status(v3))).toMatchObject({ status: "superseded", superseded_by_version_id: null });
    const wbv = crypto.randomUUID();
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, occurred_at, created_by) values (${wbv}, ${t.org}, ${t.whiteboard}, 1, ${T0}, ${t.designer})`;
    expect((await go(t.office, wbv, { to: "internal_review" })).status).toBe(409);
    expect((await call("GET", t.office, `/drawing-versions/${wbv}/compare/${wbv}`)).status).toBe(409);
    expect((await call("GET", t.office, `/drawings/${t.whiteboard}/versions`)).status).toBe(409);
  });

  it("publish pin (spec §2b): 404 unknown version; 409 superseded; 409 client_rejected; 409 a version of a drawing not attached to this project; 200 pins a client_approved one", async () => {
    expect((await call("POST", t.designerB, `/projects/${t.project}/checkout`)).status).toBe(200);
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: crypto.randomUUID() })).status).toBe(404);
    const sup = await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: t.version });
    expect(sup.status).toBe(409);
    expect((sup.body as { status: string }).status).toBe("superseded");
    await owner`update drawings.drawing_versions set status = 'client_rejected' where id = ${v2}`;
    const rej = await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: v2 });
    expect(rej.status).toBe(409);
    expect((rej.body as { status: string }).status).toBe("client_rejected");
    await owner`update drawings.drawing_versions set status = 'client_approved' where id = ${v2}`;
    // a version of an UNATTACHED drawing (or another project's) is not this project's
    const stray = crypto.randomUUID(), strayV = crypto.randomUUID();
    await owner`insert into drawings.drawings (id, organization_id, kind, working_title, occurred_at, created_by) values (${stray}, ${t.org}, 'plan', 'stray', ${T0}, ${t.designer})`;
    await owner`insert into drawings.drawing_versions (id, organization_id, drawing_id, version_no, occurred_at, created_by) values (${strayV}, ${t.org}, ${stray}, 1, ${T0}, ${t.designer})`;
    expect((await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: strayV })).status).toBe(409);
    expect((await owner<{ published_revision: number }[]>`select published_revision from places.structure_state where project_id = ${t.project}`)[0].published_revision).toBe(0);
    const ok = await call("POST", t.designerB, `/projects/${t.project}/publish`, { drawing_version_id: v2 });
    expect(ok.status).toBe(200);
    expect((ok.body as { structure_state: { published_drawing_version_id: string } }).structure_state.published_drawing_version_id).toBe(v2);
    const list = (await call("GET", t.techA, `/drawings/${t.drawing}/versions`)).body as { published_drawing_version_id: string };
    expect(list.published_drawing_version_id).toBe(v2);
  });

  it("compare v1 → v2: pages paired by source_page_no with both preview ids; rooms by room_id (moved / removed / added), pins by location_id (edited), annotations by copied_from_id (moved / removed / added); 409 across drawings", async () => {
    expect((await call("GET", t.techA, `/drawing-versions/${t.version}/compare/${crypto.randomUUID()}`)).status).toBe(404);
    const stray = (await owner<{ id: string }[]>`select v.id from drawings.drawing_versions v join drawings.drawings d on d.id = v.drawing_id where d.working_title = 'stray' and d.organization_id = ${t.org}`)[0].id;
    expect((await call("GET", t.techA, `/drawing-versions/${t.version}/compare/${stray}`)).status).toBe(409);

    const r = await call("GET", t.techA, `/drawing-versions/${t.version}/compare/${v2}`);
    expect(r.status).toBe(200);
    const b = r.body as CompareBody;
    expect(b.a).toMatchObject({ id: t.version, version_no: 1, status: "superseded" });
    expect(b.b).toMatchObject({ id: v2, version_no: 2, status: "client_approved" });
    expect(b.pages).toEqual([
      { source_page_no: 1, a_page_id: t.page1, a_preview_file_id: previewA, b_page_id: v2p1, b_preview_file_id: previewB },
      { source_page_no: 2, a_page_id: t.page2, a_preview_file_id: null, b_page_id: v2p2, b_preview_file_id: null },
    ]);
    const by = (entity: string, change: string) => b.changes.filter((c) => c.entity === entity && c.change === change);
    expect(by("room", "moved").map((c) => c.key)).toEqual([`room:${t.rooms.kitchen}`]);
    expect(by("room", "moved")[0].before?.polygon).toEqual({ points: [[0, 0], [10, 0], [10, 10]] });
    expect(by("room", "moved")[0].after?.polygon).toEqual({ points: [[0, 0], [12, 0], [12, 10]] });
    expect(by("room", "removed").map((c) => c.key)).toEqual([`room:${t.rooms.foyer}`]);
    expect(by("room", "added").map((c) => c.key)).toEqual(["hint:bonus rm"]);
    expect(by("room", "added")[0].after?.page_no).toBe(2);
    expect(by("placement", "edited").map((c) => c.key)).toEqual([`location:${t.locationTv}`]);
    expect(by("placement", "edited")[0].before?.label_text).toBe("TV");
    expect(by("placement", "edited")[0].after?.label_text).toBe("TV 65in");
    expect(by("placement", "moved")).toEqual([]);
    expect(by("annotation", "moved").map((c) => [c.key, c.before?.id, c.after?.id])).toEqual([[`annotation:${annA1}`, annA1, annB1]]);
    expect(by("annotation", "removed").map((c) => c.before?.id)).toEqual([annA2]);
    expect(by("annotation", "added").map((c) => c.after?.id)).toEqual([annB2]);
    expect(b.summary).toEqual({ added: 2, removed: 2, moved: 2, edited: 1 });
    // identical versions compare clean; tombstoned rows never count
    await owner`update drawings.annotations set deleted_at = now(), deleted_by = ${t.techA} where id = ${annB2}`;
    const again = (await call("GET", t.techA, `/drawing-versions/${t.version}/compare/${v2}`)).body as CompareBody;
    expect(again.changes.some((c) => c.after?.id === annB2)).toBe(false);
    const self = (await call("GET", t.techA, `/drawing-versions/${v2}/compare/${v2}`)).body as CompareBody;
    expect(self.changes).toEqual([]);
    // a two-hop lineage (v3 copied from v2 copied from v1) still resolves to the v1 row
    const v3 = (await owner<{ id: string }[]>`select id from drawings.drawing_versions where drawing_id = ${t.drawing} and version_no = 3`)[0].id;
    const v3p1 = crypto.randomUUID(), annC1 = crypto.randomUUID();
    await owner`insert into drawings.pages (id, organization_id, drawing_id, drawing_version_id, ordinal, source_page_no, occurred_at, created_by) values (${v3p1}, ${t.org}, ${t.drawing}, ${v3}, 1, 1, ${T0}, ${t.designer})`;
    await owner`insert into drawings.annotations (id, organization_id, page_id, layer_id, kind, class, geometry, label, z, copied_from_id, occurred_at, created_by)
                values (${annC1}, ${t.org}, ${v3p1}, ${t.layerFieldNotes}, 'callout', 'capture', '{"x":2,"y":2}', 'c1 (edited)', 1, ${annB1}, ${T0}, ${t.techA})`;
    const hop = (await call("GET", t.techA, `/drawing-versions/${t.version}/compare/${v3}`)).body as CompareBody;
    const c1 = hop.changes.find((c) => c.entity === "annotation" && c.key === `annotation:${annA1}`);
    expect(c1?.change).toBe("moved"); // geometry differs from v1 → moved wins over the label edit
    expect(c1?.after?.id).toBe(annC1);
    const hop2 = (await call("GET", t.techA, `/drawing-versions/${v2}/compare/${v3}`)).body as CompareBody;
    expect(hop2.changes.find((c) => c.key === `annotation:${annB1}`)?.change).toBe("edited");
  });
});
