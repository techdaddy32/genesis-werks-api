// row: W4 · run: run-2026-10-07-drawing-layer-06 · 2026-10-08
// row: W4-fix · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — designers may file
// Drawings attach / detach / move / copy (spec §5.2, §5.3 re-evaluation at attach, §6 check 2):
// in place, no rekey; room_hint → room_id; room_hint_pending; structure-layer rows surface as
// proposals; detach rewrites room_id back to the hint and withdraws pending rows; zero deletes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, syncEnv, syncRequest, callSync, syncSet, ownerEvents, ownerRow, ownerCount, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";

const available = await dbAvailable();

interface AttachBody {
  op: string;
  drawing: Record<string, unknown>;
  resolved_rooms: { room_hint: string; room_id: string; room_name: string; rows: number }[];
  room_hint_pending: { room_hint: string; change_id: string; rows: Record<string, number> }[];
  rows_touched: Record<string, number>;
  annotation_proposals: string[];
}

describe.skipIf(!available)("drawings attach / detach / move / copy", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const call = (method: string, actor: string, path: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, ...(body !== undefined ? { body } : {}) }));
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[]) => {
    const r = await call("POST", actor, "/sync/push", { device_id: "pad-1", rows });
    expect(r.status).toBe(200);
    return r.body as PushResult;
  };

  let drawing: Record<string, unknown>;
  let page: Record<string, unknown>;
  let polyKitchen: Record<string, unknown>;
  let polyFlex: Record<string, unknown>;
  let pinKitchen: Record<string, unknown>;
  let annKitchen: Record<string, unknown>;
  let annDesign: Record<string, unknown>;
  let layerDesign: string;
  let layerFieldNotes: string;

  /** Every live + tombstoned row the drawing owns, for the "zero deletes" probe. */
  const rowInventory = async () => {
    const did = drawing.id as string;
    const q = async (sql: Promise<{ n: number; d: number }[]>) => (await sql)[0];
    return {
      pages: await q(owner`select count(*)::int as n, count(deleted_at)::int as d from drawings.pages where drawing_id = ${did}`),
      layers: await q(owner`select count(*)::int as n, count(deleted_at)::int as d from drawings.layers where drawing_id = ${did}`),
      annotations: await q(owner`select count(*)::int as n, count(a.deleted_at)::int as d from drawings.annotations a join drawings.pages p on p.id = a.page_id where p.drawing_id = ${did}`),
      polygons: await q(owner`select count(*)::int as n, count(deleted_at)::int as d from places.room_polygons where drawing_id = ${did}`),
      placements: await q(owner`select count(*)::int as n, count(deleted_at)::int as d from places.location_placements where drawing_id = ${did}`),
      rooms: await q(owner`select count(*)::int as n, count(deleted_at)::int as d from places.rooms where project_id = ${t.project}`),
    };
  };

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "dattach");
    // an UNATTACHED plan drawn in the field: hints, no project (spec §6 check 1 → 2)
    drawing = syncSet(t, t.techA, { kind: "plan", working_title: "Unfiled markup", address_hint: "1 Example Ct" });
    const r0 = await push(t.techA, [{ table: "drawings.drawings", row: drawing }]);
    expect(r0.rejected).toEqual([]);
    layerDesign = r0.created_layers.find((l) => l.name === "Design")!.id;
    layerFieldNotes = r0.created_layers.find((l) => l.name === "Field Notes")!.id;
    page = syncSet(t, t.techA, { drawing_id: drawing.id, ordinal: 1, name: "Sheet A", source_page_no: 1 });
    polyKitchen = syncSet(t, t.techA, { drawing_id: drawing.id, page_id: page.id, room_hint: "  kitchen ", polygon: { points: [[0, 0], [10, 0], [10, 10]] } });
    polyFlex = syncSet(t, t.techA, { drawing_id: drawing.id, page_id: page.id, room_hint: "Flex Rm", polygon: { points: [[20, 0], [30, 0], [30, 10]] } });
    pinKitchen = syncSet(t, t.techA, { drawing_id: drawing.id, page_id: page.id, room_hint: "KITCHEN", location_hint: "Behind TV", x: 5, y: 5, symbol_key: "tv" });
    annKitchen = syncSet(t, t.techA, { page_id: page.id, layer_id: layerFieldNotes, kind: "callout", geometry: { x: 1, y: 1 }, z: 1, room_hint: "Kitchen", label: "outlet here" });
    const r1 = await push(t.techA, [
      { table: "drawings.pages", row: page }, { table: "places.room_polygons", row: polyKitchen }, { table: "places.room_polygons", row: polyFlex },
      { table: "places.location_placements", row: pinKitchen }, { table: "drawings.annotations", row: annKitchen },
    ]);
    expect(r1.rejected).toEqual([]);
    // a designer inks on Design while UNATTACHED: designer_checkout behaves as 'designer' → lands on the structure layer
    annDesign = syncSet(t, t.designerB, { page_id: page.id, layer_id: layerDesign, kind: "rect", geometry: { x: 2, y: 2, w: 3, h: 3 }, z: 1, room_hint: "Flex Rm" });
    const r2 = await push(t.designerB, [{ table: "drawings.annotations", row: annDesign }]);
    expect(r2.rejected).toEqual([]);
    expect(r2.accepted[0].redirected).toBeUndefined();
    expect((await ownerRow(owner, "drawings.annotations", annDesign.id as string))!.layer_id).toBe(layerDesign);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("attach: technician 403; designer allowed (Craig 2026-10-09); 400 unless exactly one of project_id | account_id; 404 unknown drawing / project / account", async () => {
    expect((await call("POST", t.techA, `/drawings/${drawing.id}/attach`, { project_id: t.project })).status).toBe(403);
    // designers may file (Craig 2026-10-09): a bad body still 400s for them, proving the role gate passed
    expect((await call("POST", t.designerB, `/drawings/${drawing.id}/attach`, {})).status).toBe(400);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/attach`, {})).status).toBe(400);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/attach`, { project_id: t.project, account_id: t.account })).status).toBe(400);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/attach`, { project_id: "nope" })).status).toBe(400);
    expect((await call("POST", t.office, `/drawings/${crypto.randomUUID()}/attach`, { project_id: t.project })).status).toBe(404);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/attach`, { project_id: crypto.randomUUID() })).status).toBe(404);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/attach`, { account_id: crypto.randomUUID() })).status).toBe(404);
    expect((await ownerRow(owner, "drawings.drawings", drawing.id as string))!.project_id).toBeNull();
  });

  let inventoryBefore: Awaited<ReturnType<typeof rowInventory>>;

  it("attach to the project: same id; Kitchen resolves on polygon + pin + annotation; Flex Rm → ONE room_hint_pending; the Design-layer row surfaces as ONE annotation proposal; event drawing.attached", async () => {
    inventoryBefore = await rowInventory();
    const r = await call("POST", t.office, `/drawings/${drawing.id}/attach`, { project_id: t.project });
    expect(r.status).toBe(200);
    const b = r.body as AttachBody;
    expect(b.op).toBe("attached");
    expect(b.drawing.id).toBe(drawing.id);
    expect(b.drawing.project_id).toBe(t.project);
    expect(b.drawing.attached_by).toBe(t.office);
    expect(b.resolved_rooms).toEqual([{ room_hint: "kitchen", room_id: t.rooms.kitchen, room_name: "Kitchen", rows: 3 }]);
    expect(b.room_hint_pending.length).toBe(1);
    expect(b.room_hint_pending[0].room_hint).toBe("Flex Rm");
    expect(b.room_hint_pending[0].rows).toEqual({ "places.room_polygons": 1, "drawings.annotations": 1 });
    expect(b.annotation_proposals.length).toBe(1);

    const d = (await ownerRow(owner, "drawings.drawings", drawing.id as string))!;
    expect(d.project_id).toBe(t.project);
    expect(d.account_id).toBeNull(); // one anchor
    expect(d.revision).toBe(1); // no rekey, no server revision bump
    expect(d.attached_at).toBeInstanceOf(Date);
    const poly = (await ownerRow(owner, "places.room_polygons", polyKitchen.id as string))!;
    expect(poly.room_id).toBe(t.rooms.kitchen);
    expect(poly.project_id).toBe(t.project);
    expect(poly.account_id).toBe(t.account);
    expect(poly.room_hint).toBe("  kitchen "); // the hint text is never rewritten on attach
    const flex = (await ownerRow(owner, "places.room_polygons", polyFlex.id as string))!;
    expect(flex.room_id).toBeNull();
    expect(flex.project_id).toBe(t.project);
    const pin = (await ownerRow(owner, "places.location_placements", pinKitchen.id as string))!;
    expect(pin.room_id).toBe(t.rooms.kitchen);
    expect(pin.location_id).toBeNull(); // location hints are not resolved by attach (rooms only — the walks' rule)
    expect((await ownerRow(owner, "drawings.annotations", annKitchen.id as string))!.room_id).toBe(t.rooms.kitchen);

    const pend = await owner<Record<string, unknown>[]>`select * from places.structure_changes where drawing_id = ${drawing.id} and change_kind = 'room_hint_pending'`;
    expect(pend.length).toBe(1);
    expect(pend[0]).toMatchObject({ room_hint: "Flex Rm", revision: 1, ref_table: "drawings.drawings", ref_id: drawing.id, project_id: t.project, review_outcome: null });
    const prop = await owner<Record<string, unknown>[]>`select * from places.structure_changes where drawing_id = ${drawing.id} and change_kind = 'annotation'`;
    expect(prop.length).toBe(1);
    expect(prop[0]).toMatchObject({ ref_table: "drawings.annotations", ref_id: annDesign.id, room_hint: "Flex Rm", review_outcome: null });
    expect((prop[0].diff as { op: string; source: string }).op).toBe("proposed");
    // nothing was silently promoted: the row's class is still what the landing layer stamped
    expect((await ownerRow(owner, "drawings.annotations", annDesign.id as string))!.class).toBe("structure");
    expect((await ownerEvents(owner, { ref_id: drawing.id as string, event_type: "drawing.attached" })).length).toBe(1);
    // and the hint shows in the designer's review
    const rv = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as { pending_room_hints: number; pending_count: number };
    expect(rv.pending_room_hints).toBe(1);
    expect(rv.pending_count).toBe(2);
  });

  it("re-attach to the same project → noop (no second pass); attach to an account while attached → 409; push cannot re-anchor it", async () => {
    const again = await call("POST", t.office, `/drawings/${drawing.id}/attach`, { project_id: t.project });
    expect(again.status).toBe(200);
    expect((again.body as AttachBody).op).toBe("noop");
    expect(await ownerCount(owner, "places.structure_changes", { drawing_id: drawing.id as string })).toBe(2);
    const other = await call("POST", t.office, `/drawings/${drawing.id}/attach`, { account_id: t.account });
    expect(other.status).toBe(409);
    expect((other.body as { project_id: string }).project_id).toBe(t.project);
    expect((await ownerEvents(owner, { ref_id: drawing.id as string, event_type: "drawing.attached" })).length).toBe(1);
  });

  it("detach: technician 403; office → in place (project_id NULL, detached_at), pending rows withdrawn, room_id rewritten back to room_hint keeping the NAME, zero rows deleted; event drawing.detached", async () => {
    expect((await call("POST", t.techA, `/drawings/${drawing.id}/detach`)).status).toBe(403);
    const r = await call("POST", t.office, `/drawings/${drawing.id}/detach`);
    expect(r.status).toBe(200);
    const b = r.body as { op: string; from: { kind: string; id: string }; withdrawn_changes: number; rows_rewritten: Record<string, number>; drawing: Record<string, unknown> };
    expect(b.op).toBe("detached");
    expect(b.from).toEqual({ kind: "project", id: t.project });
    expect(b.withdrawn_changes).toBe(2);
    expect(b.rows_rewritten).toEqual({ "places.room_polygons": 2, "places.location_placements": 1, "drawings.annotations": 1 });
    const d = (await ownerRow(owner, "drawings.drawings", drawing.id as string))!;
    expect(d.project_id).toBeNull();
    expect(d.account_id).toBeNull();
    expect(d.detached_at).toBeInstanceOf(Date);
    expect(d.deleted_at).toBeNull();
    const poly = (await ownerRow(owner, "places.room_polygons", polyKitchen.id as string))!;
    expect(poly.room_id).toBeNull();
    expect(poly.room_hint).toBe("  kitchen "); // the device's own hint survives untouched
    expect(poly.project_id).toBeNull();
    expect(poly.account_id).toBeNull();
    const pin = (await ownerRow(owner, "places.location_placements", pinKitchen.id as string))!;
    expect(pin.room_id).toBeNull();
    expect(pin.room_hint).toBe("KITCHEN");
    expect((await ownerRow(owner, "drawings.annotations", annKitchen.id as string))!.room_id).toBeNull();
    // withdrawn, not deleted — they stay as history
    const changes = await owner<{ review_outcome: string | null; reviewed_by: string | null }[]>`select review_outcome, reviewed_by from places.structure_changes where drawing_id = ${drawing.id}`;
    expect(changes.length).toBe(2);
    expect(changes.every((c) => c.review_outcome === "withdrawn" && c.reviewed_by === t.office)).toBe(true);
    // ZERO deletes: the probe
    const after = await rowInventory();
    expect(after).toEqual(inventoryBefore);
    expect(Object.values(after).every((x) => x.d === 0)).toBe(true);
    expect((await ownerEvents(owner, { ref_id: drawing.id as string, event_type: "drawing.detached" })).length).toBe(1);
    // the project's own truth is untouched; the review list is clean again
    expect(await ownerCount(owner, "places.rooms", { project_id: t.project })).toBe(2);
    const rv = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as { pending_count: number };
    expect(rv.pending_count).toBe(0);
    // detach again → noop
    expect(((await call("POST", t.office, `/drawings/${drawing.id}/detach`)).body as { op: string }).op).toBe("noop");
  });

  it("a room resolved from a hint whose NAME came from a real room (room_hint was NULL) gets the name written back on detach", async () => {
    // a polygon pushed WITH room_id (no hint) by the checkout holder, then detach → room_hint = 'Foyer'
    await call("POST", t.designerB, `/projects/${t.project}/checkout`);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/attach`, { project_id: t.project })).status).toBe(200);
    const polyFoyer = syncSet(t, t.designerB, { drawing_id: drawing.id, page_id: page.id, project_id: t.project, room_id: t.rooms.foyer, polygon: { points: [[50, 50], [60, 50], [60, 60]] } });
    expect((await push(t.designerB, [{ table: "places.room_polygons", row: polyFoyer }])).rejected).toEqual([]);
    // review everything so the project stays publishable, then detach
    const rv = (await call("GET", t.designerB, `/projects/${t.project}/review`)).body as { groups: { changes: { id: string }[] }[] };
    for (const c of rv.groups.flatMap((g) => g.changes)) expect((await call("PATCH", t.designerB, `/projects/${t.project}/review/${c.id}`, { outcome: "validated" })).status).toBe(200);
    const r = await call("POST", t.office, `/drawings/${drawing.id}/detach`);
    expect(r.status).toBe(200);
    expect((r.body as { withdrawn_changes: number }).withdrawn_changes).toBe(0); // reviewed rows are project truth: never withdrawn
    const row = (await ownerRow(owner, "places.room_polygons", polyFoyer.id as string))!;
    expect(row.room_id).toBeNull();
    expect(row.room_hint).toBe("Foyer");
    expect(row.deleted_at).toBeNull();
    await call("POST", t.designerB, `/projects/${t.project}/checkout/release`);
  });

  it("attach to an account is a pure filing act (no structure rows, no resolution); move account → project = detach + attach in one call; move to the same anchor → noop", async () => {
    const before = await ownerCount(owner, "places.structure_changes", { drawing_id: drawing.id as string });
    const r = await call("POST", t.office, `/drawings/${drawing.id}/attach`, { account_id: t.account });
    expect(r.status).toBe(200);
    expect((r.body as AttachBody).resolved_rooms).toEqual([]);
    expect((r.body as AttachBody).room_hint_pending).toEqual([]);
    expect((await ownerRow(owner, "drawings.drawings", drawing.id as string))!.account_id).toBe(t.account);
    expect(await ownerCount(owner, "places.structure_changes", { drawing_id: drawing.id as string })).toBe(before);
    expect((await ownerRow(owner, "places.room_polygons", polyKitchen.id as string))!.room_id).toBeNull();

    expect((await call("POST", t.techA, `/drawings/${drawing.id}/move`, { project_id: t.project })).status).toBe(403);
    expect((await call("POST", t.office, `/drawings/${drawing.id}/move`, { project_id: crypto.randomUUID() })).status).toBe(404);
    expect((await ownerRow(owner, "drawings.drawings", drawing.id as string))!.account_id).toBe(t.account); // a failed move leaves it where it was
    const mv = await call("POST", t.office, `/drawings/${drawing.id}/move`, { project_id: t.project });
    expect(mv.status).toBe(200);
    const mb = mv.body as AttachBody & { from: { kind: string; id: string }; detach: { op: string } };
    expect(mb.op).toBe("moved");
    expect(mb.from).toEqual({ kind: "account", id: t.account });
    expect(mb.detach.op).toBe("detached");
    expect(mb.resolved_rooms.map((x) => x.room_hint).sort()).toEqual(["Foyer", "kitchen"]); // the Foyer polygon's written-back name resolves again
    expect(mb.room_hint_pending.map((x) => x.room_hint)).toEqual(["Flex Rm"]);
    const d = (await ownerRow(owner, "drawings.drawings", drawing.id as string))!;
    expect(d.project_id).toBe(t.project);
    expect(d.account_id).toBeNull();
    expect((await ownerRow(owner, "places.room_polygons", polyKitchen.id as string))!.room_id).toBe(t.rooms.kitchen);
    expect(((await call("POST", t.office, `/drawings/${drawing.id}/move`, { project_id: t.project })).body as { op: string }).op).toBe("noop");
    // attached & detached events: one each per act
    expect((await ownerEvents(owner, { ref_id: drawing.id as string, event_type: "drawing.detached" })).length).toBe(3);
    expect((await ownerEvents(owner, { ref_id: drawing.id as string, event_type: "drawing.attached" })).length).toBe(4);
  });

  it("copy: technician 403; designer → 201 new UNATTACHED drawing with layers / pages / annotations / polygons / pins stamped copied_from_id, same shared.files referenced, room ids rewritten to names; the source is untouched", async () => {
    expect((await call("POST", t.techA, `/drawings/${drawing.id}/copy`, {})).status).toBe(403);
    expect((await call("POST", t.designerB, `/drawings/${crypto.randomUUID()}/copy`, {})).status).toBe(404);
    const src = await rowInventory();
    const r = await call("POST", t.designerB, `/drawings/${drawing.id}/copy`, { title: "Markup for the other house" });
    expect(r.status).toBe(201);
    const b = r.body as { op: string; drawing: Record<string, unknown>; copied_from_drawing_id: string; counts: Record<string, number>; pages: Record<string, string>; layers: Record<string, string> };
    expect(b.op).toBe("copied");
    expect(b.copied_from_drawing_id).toBe(drawing.id);
    expect(b.drawing.project_id).toBeNull();
    expect(b.drawing.account_id).toBeNull();
    expect(b.drawing.working_title).toBe("Markup for the other house");
    expect(b.drawing.created_by).toBe(t.designerB);
    expect(b.counts).toEqual({ layers: src.layers.n, versions: 0, pages: 1, annotations: 2, room_polygons: 3, location_placements: 1 });
    const nid = b.drawing.id as string;
    expect(await ownerCount(owner, "drawings.layers", { drawing_id: nid })).toBe(src.layers.n);
    const newPage = b.pages[page.id as string];
    const anns = await owner<Record<string, unknown>[]>`select * from drawings.annotations where page_id = ${newPage} order by z, received_at`;
    expect(anns.length).toBe(2);
    expect(anns.map((a) => a.copied_from_id).sort()).toEqual([annKitchen.id, annDesign.id].sort());
    expect(anns.every((a) => a.revision === 1 && a.created_by === t.designerB && a.room_id === null && a.deleted_at === null)).toBe(true);
    expect(anns.find((a) => a.copied_from_id === annKitchen.id)!).toMatchObject({ layer_id: b.layers[layerFieldNotes], class: "capture", label: "outlet here", room_hint: "Kitchen" });
    expect(anns.find((a) => a.copied_from_id === annDesign.id)!).toMatchObject({ layer_id: b.layers[layerDesign], class: "structure" });
    const polys = await owner<Record<string, unknown>[]>`select * from places.room_polygons where drawing_id = ${nid}`;
    expect(polys.length).toBe(3);
    expect(polys.every((p) => p.project_id === null && p.account_id === null && p.room_id === null && p.page_id === newPage)).toBe(true);
    expect(polys.find((p) => p.copied_from_id === polyKitchen.id)!.room_hint).toBe("  kitchen ");
    expect(polys.map((p) => p.room_hint).sort()).toEqual(["  kitchen ", "Flex Rm", "Foyer"].sort()); // a room with no hint gets its NAME
    const pins = await owner<Record<string, unknown>[]>`select * from places.location_placements where drawing_id = ${nid}`;
    expect(pins.length).toBe(1);
    expect(pins[0]).toMatchObject({ copied_from_id: pinKitchen.id, location_hint: "Behind TV", room_hint: "KITCHEN", symbol_key: "tv", location_id: null });
    // the source is exactly as it was
    expect(await rowInventory()).toEqual(src);
    expect((await ownerRow(owner, "drawings.drawings", drawing.id as string))!.project_id).toBe(t.project);
    expect((await ownerEvents(owner, { ref_id: nid, event_type: "drawing.copied" })).length).toBe(1);
    // a copy is a real drawing: it can be attached to a DIFFERENT project (Rule A1: a copy, never a second FK)
    const other = crypto.randomUUID();
    await owner`insert into shared.projects (id, organization_id, account_id, name, created_by) values (${other}, ${t.org}, ${t.account}, 'Other house (test)', ${t.office})`;
    await owner`insert into places.structure_state (project_id, organization_id) values (${other}, ${t.org})`;
    const at = await call("POST", t.office, `/drawings/${nid}/attach`, { project_id: other });
    expect(at.status).toBe(200);
    expect((at.body as AttachBody).room_hint_pending.map((p) => p.room_hint).sort()).toEqual(["  kitchen ".trim(), "Flex Rm", "Foyer"].sort()); // no rooms in the other house yet
  });

  it("copy of a drawing with a version + preview files references the SAME shared.files rows", async () => {
    const t2 = await createTestOrg(owner, "dcopy");
    const file = crypto.randomUUID();
    await owner`insert into shared.files (id, organization_id, kind, filename, content_type, storage_key, upload_status, occurred_at, created_by)
                values (${file}, ${t2.org}, 'plan_preview', 'p1.jpg', 'image/jpeg', ${`${t2.org}/${file}`}, 'verified', now(), ${t2.designer})`;
    await owner`update drawings.pages set preview_file_id = ${file} where id = ${t2.page1}`;
    const r = await callSync(env, syncRequest("POST", `/drawings/${t2.drawing}/copy`, { actor: t2.office, org: t2.org, body: {} }));
    expect(r.status).toBe(201);
    const b = r.body as { drawing: { id: string; working_title: string }; counts: Record<string, number>; versions: Record<string, string>; pages: Record<string, string> };
    expect(b.drawing.working_title).toBe("Test plan set (copy)");
    expect(b.counts.versions).toBe(1);
    expect(b.counts.pages).toBe(2);
    const nv = b.versions[t2.version];
    const v = (await ownerRow(owner, "drawings.drawing_versions", nv))!;
    expect(v).toMatchObject({ drawing_id: b.drawing.id, version_no: 1, status: "draft", label: "v1" });
    const p = (await ownerRow(owner, "drawings.pages", b.pages[t2.page1]))!;
    expect(p.preview_file_id).toBe(file);
    expect(p.drawing_version_id).toBe(nv);
    expect(await ownerCount(owner, "shared.files", { organization_id: t2.org })).toBe(1); // never duplicated
  });
});
