// row: W3 · run: run-2026-10-07-drawing-layer-05 · 2026-10-07
// Layer governance (spec §2a Amendment 1, §5.3, §5.5): template instantiation, R-layer-write
// (REDIRECT, never reject), R-class-stamp (copied from the landing layer, immutable), R-lock
// (a boolean set by a person), layer CRUD, pull render order, tombstone guard on annotations.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dbAvailable, ownerSql, createTestOrg, setCheckout, syncEnv, syncRequest, callSync, syncSet,
  ownerRow, ownerCount, ownerEvents, type Sql, type TestOrg,
} from "./_db";
import type { PushResult } from "../../src/sync/push";
import type { PullResult } from "../../src/sync/pull";
import { pickLandingLayer, isWritable, type LayerRow } from "../../src/sync/layers";

const available = await dbAvailable();

const SEED = {
  org: "019a0000-0000-7000-8000-000000000001",
  designer: "019a0000-0000-7000-8000-000000000011",
  techA: "019a0000-0000-7000-8000-000000000012",
  plan: "019a0000-0000-7000-8000-000000000061",
  board: "019a0000-0000-7000-8000-000000000062",
  tpl: { design: "019a0000-0000-7000-8000-000000000051", fieldNotes: "019a0000-0000-7000-8000-000000000052", board: "019a0000-0000-7000-8000-000000000057" },
  layers: { design: "019a0000-0000-7000-8000-000000000091", fieldNotes: "019a0000-0000-7000-8000-000000000092", roughIn: "019a0000-0000-7000-8000-000000000093" },
  page1: "019a0000-0000-7000-8000-000000000081",
};

describe.skipIf(!available)("W3 layer governance", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();

  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[], org?: string) => {
    const r = await callSync(env, syncRequest("POST", "/sync/push", { actor, org: org ?? t.org, body: { device_id: "test-device", rows } }));
    expect(r.status).toBe(200);
    return r.body as PushResult;
  };
  const ann = (by: string, layer: string, over: Record<string, unknown> = {}) =>
    syncSet(t, by, { page_id: t.page1, layer_id: layer, kind: "pen", geometry: { points: [[1, 1], [2, 2]] }, z: 1, ...over });
  const rejections = (id: string) => ownerCount(owner, "places.sync_rejections", { ref_id: id });

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "layers");
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  // ---------------------------------------------------------------------------------------
  describe("template instantiation on drawing create", () => {
    it("device sends NO layers → the server mints the Organization's template layers in the same transaction (created_layers)", async () => {
      const quick = syncSet(t, t.techA, { kind: "plan", working_title: "Quick plan (no layers sent)" });
      const r = await push(t.techA, [{ table: "drawings.drawings", row: quick }]);
      expect(r.rejected).toEqual([]);
      expect(r.created_layers.map((l) => l.name)).toEqual(["Design", "Field Notes", "Rough-In", "Trim", "Service", "Scratch"]);
      expect(r.created_layers.every((l) => l.drawing_id === quick.id && !l.locked)).toBe(true);
      expect(await ownerCount(owner, "drawings.layers", { drawing_id: quick.id as string })).toBe(6);
      const scratch = await owner<{ export: boolean; class: string; write_policy: string }[]>`
        select export, class, write_policy from drawings.layers where drawing_id = ${quick.id as string} and name = 'Scratch'`;
      expect(scratch[0]).toEqual({ export: false, class: "capture", write_policy: "any_member" });
      // one layer.created event per minted layer
      for (const l of r.created_layers) expect(await ownerCount(owner, "shared.events", { ref_id: l.id, event_type: "layer.created" })).toBe(1);
      // a whiteboard gets Board
      const wb = syncSet(t, t.techA, { kind: "whiteboard", working_title: "Quick board" });
      const r2 = await push(t.techA, [{ table: "drawings.drawings", row: wb }]);
      expect(r2.created_layers.map((l) => l.name)).toEqual(["Board"]);
    });

    it("device pre-mints layers with template_id → validated against the template and accepted; the server fills only the missing ones", async () => {
      const d = syncSet(t, t.techA, { kind: "plan", working_title: "Pre-minted" });
      const mk = (tpl: string, name: string, ordinal: number, cls: string, pol: string, exp = true) =>
        syncSet(t, t.techA, { drawing_id: d.id, template_id: tpl, name, ordinal, class: cls, write_policy: pol, export: exp });
      const design = mk(t.templates.design, "Design", 1, "structure", "designer_checkout");
      const notes = mk(t.templates.fieldNotes, "Field Notes", 2, "capture", "any_member");
      const r = await push(t.techA, [{ table: "drawings.drawings", row: d }, { table: "drawings.layers", row: design }, { table: "drawings.layers", row: notes }]);
      expect(r.rejected).toEqual([]);
      expect(r.accepted.filter((a) => a.table === "drawings.layers").map((a) => a.op)).toEqual(["created", "created"]);
      expect(r.created_layers.map((l) => l.name)).toEqual(["Rough-In", "Trim", "Service", "Scratch"]);
      expect(await ownerCount(owner, "drawings.layers", { drawing_id: d.id as string })).toBe(6);
      expect((await ownerRow(owner, "drawings.layers", design.id as string))!.template_id).toBe(t.templates.design);
    });

    it("a device layer that contradicts its template → 'schema' (template_mismatch); a foreign template → unknown_parent; wrong kind → schema", async () => {
      const d = syncSet(t, t.techA, { kind: "plan", working_title: "Bad layers" });
      const wrongClass = syncSet(t, t.techA, { drawing_id: d.id, template_id: t.templates.design, name: "Design", ordinal: 1, class: "capture", write_policy: "any_member" });
      const ghostTpl = syncSet(t, t.techA, { drawing_id: d.id, template_id: crypto.randomUUID(), name: "X", ordinal: 9, class: "capture", write_policy: "any_member" });
      const boardOnPlan = syncSet(t, t.techA, { drawing_id: d.id, template_id: t.templates.board, name: "Board", ordinal: 1, class: "capture", write_policy: "any_member" });
      const r = await push(t.techA, [
        { table: "drawings.drawings", row: d }, { table: "drawings.layers", row: wrongClass },
        { table: "drawings.layers", row: ghostTpl }, { table: "drawings.layers", row: boardOnPlan },
      ]);
      expect(r.rejected.map((x) => x.reason)).toEqual(["schema", "unknown_parent", "schema"]);
      expect(r.rejected[0].detail).toContain("template_mismatch");
      expect(r.rejected[2].detail).toContain("template_mismatch");
      // the drawing still never exists without its template layers
      expect(r.created_layers.length).toBe(6);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("R-layer-write + R-class-stamp on /sync/push", () => {
    it("checkout holder on Design → structure row + ONE structure_changes('annotation') at working_revision, grouped by room", async () => {
      await setCheckout(owner, t, t.designer);
      const a = ann(t.designer, t.layerDesign, { kind: "rect", geometry: { x: 1, y: 1, w: 2, h: 2 }, room_id: t.rooms.kitchen });
      const r = await push(t.designer, [{ table: "drawings.annotations", row: a }]);
      expect(r.accepted[0]).toMatchObject({ id: a.id, op: "created" });
      expect(r.accepted[0].redirected).toBeUndefined();
      const row = (await ownerRow(owner, "drawings.annotations", a.id as string))!;
      expect(row.class).toBe("structure");
      expect(row.redirected_from_layer_id).toBeNull();
      const sc = await owner<{ change_kind: string; revision: number; room_id: string; drawing_id: string }[]>`
        select change_kind, revision, room_id, drawing_id from places.structure_changes where ref_id = ${a.id as string}`;
      expect(sc).toEqual([{ change_kind: "annotation", revision: 1, room_id: t.rooms.kitchen, drawing_id: t.drawing }]);
      // and it shows in the check-in review
      const review = await callSync(env, syncRequest("GET", `/projects/${t.project}/review`, { actor: t.designer, org: t.org }));
      const body = review.body as { groups: { room_id: string | null; changes: { ref_id: string; change_kind: string }[] }[] };
      expect(body.groups.flatMap((g) => g.changes).find((c) => c.ref_id === a.id)?.change_kind).toBe("annotation");
    });

    it("checkout holder on Field Notes → capture (layer only downgrades); NO structure_changes row", async () => {
      await setCheckout(owner, t, t.designer);
      const a = ann(t.designer, t.layerFieldNotes);
      const r = await push(t.designer, [{ table: "drawings.annotations", row: a }]);
      expect(r.accepted[0]).toMatchObject({ op: "created" });
      expect((await ownerRow(owner, "drawings.annotations", a.id as string))!.class).toBe("capture");
      expect(await ownerCount(owner, "places.structure_changes", { ref_id: a.id as string })).toBe(0);
    });

    it("technician aiming at Design → accepted, REDIRECTED to Field Notes (role default), class capture, redirected_from_layer_id set, ZERO sync_rejections", async () => {
      await setCheckout(owner, t, t.designer);
      const a = ann(t.techA, t.layerDesign, { class: "structure" }); // the device even claims structure — the stamp comes from the landing layer
      const r = await push(t.techA, [{ table: "drawings.annotations", row: a }]);
      expect(r.rejected).toEqual([]);
      expect(r.accepted[0]).toMatchObject({ id: a.id, op: "created", redirected: true, redirected_to_layer_id: t.layerFieldNotes, redirect_reason: "policy" });
      const row = (await ownerRow(owner, "drawings.annotations", a.id as string))!;
      expect(row.layer_id).toBe(t.layerFieldNotes);
      expect(row.redirected_from_layer_id).toBe(t.layerDesign);
      expect(row.class).toBe("capture");
      expect(await rejections(a.id as string)).toBe(0);
      expect(await ownerCount(owner, "places.structure_changes", { ref_id: a.id as string })).toBe(0);
      // a designer WITHOUT the checkout aiming at Design is redirected too (checkout is the only gate to structure)
      const b = ann(t.designerB, t.layerDesign);
      const r2 = await push(t.designerB, [{ table: "drawings.annotations", row: b }]);
      expect(r2.accepted[0]).toMatchObject({ redirected: true, redirected_to_layer_id: t.layerFieldNotes, redirect_reason: "policy" });
      expect((await ownerRow(owner, "drawings.annotations", b.id as string))!.class).toBe("capture");
    });

    it("office locks Field Notes → a technician's offline batch of 10 strokes all land on the next any_member layer (Rough-In) with redirect_reason 'locked', zero rejections; unlock restores", async () => {
      // add Rough-In to the base drawing (designer may add layers)
      const add = await callSync(env, syncRequest("POST", `/drawings/${t.drawing}/layers`, {
        actor: t.designer, org: t.org, body: { name: "Rough-In", class: "capture", write_policy: "any_member", ordinal: 3 },
      }));
      expect(add.status).toBe(201);
      const roughIn = (add.body as { layer: { id: string } }).layer.id;

      const lock = await callSync(env, syncRequest("PATCH", `/drawings/${t.drawing}/layers/${t.layerFieldNotes}`, { actor: t.office, org: t.org, body: { locked: true } }));
      expect(lock.status).toBe(200);
      expect((lock.body as { op: string }).op).toBe("locked");
      const locked = (await ownerRow(owner, "drawings.layers", t.layerFieldNotes))!;
      expect(locked.locked).toBe(true);
      expect(locked.locked_by).toBe(t.office);
      expect(locked.locked_at).not.toBeNull();
      expect((await ownerEvents(owner, { ref_id: t.layerFieldNotes, event_type: "layer.locked" })).length).toBe(1);

      const strokes = Array.from({ length: 10 }, (_, i) => ann(t.techA, t.layerFieldNotes, { z: i + 1 }));
      const r = await push(t.techA, strokes.map((row) => ({ table: "drawings.annotations", row })));
      expect(r.rejected).toEqual([]);
      expect(r.accepted.length).toBe(10);
      for (const a of r.accepted) expect(a).toMatchObject({ op: "created", redirected: true, redirected_to_layer_id: roughIn, redirect_reason: "locked" });
      for (const s of strokes) {
        const row = (await ownerRow(owner, "drawings.annotations", s.id as string))!;
        expect(row.layer_id).toBe(roughIn);
        expect(row.redirected_from_layer_id).toBe(t.layerFieldNotes);
        expect(row.class).toBe("capture");
        expect(await rejections(s.id as string)).toBe(0);
      }
      // a lock never touches existing rows: the tech may still edit a stroke that already sits on Field Notes
      // (none here yet — so unlock and verify writes land on Field Notes again)
      const unlock = await callSync(env, syncRequest("PATCH", `/drawings/${t.drawing}/layers/${t.layerFieldNotes}`, { actor: t.office, org: t.org, body: { locked: false } }));
      expect((unlock.body as { op: string }).op).toBe("unlocked");
      expect((await ownerRow(owner, "drawings.layers", t.layerFieldNotes))!.locked_by).toBeNull();
      expect((await ownerEvents(owner, { ref_id: t.layerFieldNotes, event_type: "layer.unlocked" })).length).toBe(1);
      const after = await push(t.techA, [{ table: "drawings.annotations", row: ann(t.techA, t.layerFieldNotes) }]);
      expect(after.accepted[0].redirected).toBeUndefined();
    });

    it("a lock affects FUTURE writes only: an existing own row on a now-locked layer can still be updated and tombstoned", async () => {
      const a = ann(t.techA, t.layerFieldNotes);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).accepted[0].op).toBe("created");
      await owner`update drawings.layers set locked = true, locked_by = ${t.office}, locked_at = now() where id = ${t.layerFieldNotes}`;
      try {
        const r = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 2, label: "edited under lock" } }]);
        expect(r.accepted[0]).toMatchObject({ op: "updated" });
        expect(r.accepted[0].redirected).toBeUndefined();
        const r2 = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 3, deleted_at: new Date().toISOString() } }]);
        expect(r2.accepted[0]).toMatchObject({ op: "tombstoned" });
      } finally {
        await owner`update drawings.layers set locked = false, locked_by = null, locked_at = null where id = ${t.layerFieldNotes}`;
      }
    });

    it("UPDATE changing class → 'immutable_class' (the one refusal); the stored row is untouched", async () => {
      const a = ann(t.techA, t.layerFieldNotes, { label: "v1" });
      expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
      const r = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 2, class: "structure", label: "v2" } }]);
      expect(r.rejected[0]).toMatchObject({ id: a.id, reason: "immutable_class" });
      const row = (await ownerRow(owner, "drawings.annotations", a.id as string))!;
      expect(row.class).toBe("capture");
      expect(row.label).toBe("v1");
      expect(row.revision).toBe(1);
      expect(await rejections(a.id as string)).toBe(1);
      // moving onto a STRUCTURE layer by plain update is a promotion → immutable_class here (W4 mints a new row via PATCH /annotations/:id)
      await setCheckout(owner, t, t.designer);
      const own = ann(t.designer, t.layerFieldNotes);
      expect((await push(t.designer, [{ table: "drawings.annotations", row: own }])).rejected).toEqual([]);
      const r2 = await push(t.designer, [{ table: "drawings.annotations", row: { ...own, revision: 2, layer_id: t.layerDesign } }]);
      expect(r2.rejected[0]).toMatchObject({ reason: "immutable_class" });
      expect(r2.rejected[0].detail).toContain("promotion");
    });

    it("same-class move (Field Notes → Rough-In) on an own row is a plain update; re-sending the originally requested layer is a sticky redirect, not a move", async () => {
      const roughIn = (await owner<{ id: string }[]>`select id from drawings.layers where drawing_id = ${t.drawing} and name = 'Rough-In'`)[0].id;
      const a = ann(t.techA, t.layerFieldNotes);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
      const r = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 2, layer_id: roughIn } }]);
      expect(r.accepted[0]).toMatchObject({ op: "updated" });
      expect(r.accepted[0].redirected).toBeUndefined();
      const row = (await ownerRow(owner, "drawings.annotations", a.id as string))!;
      expect(row.layer_id).toBe(roughIn);
      expect(row.class).toBe("capture");

      // a redirected row whose device still names Design on the next edit: no move, no refusal
      const aimed = ann(t.techA, t.layerDesign);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: aimed }])).accepted[0].redirected).toBe(true);
      const r2 = await push(t.techA, [{ table: "drawings.annotations", row: { ...aimed, revision: 2, label: "still says Design" } }]);
      expect(r2.rejected).toEqual([]);
      expect(r2.accepted[0]).toMatchObject({ op: "updated" });
      expect((await ownerRow(owner, "drawings.annotations", aimed.id as string))!.layer_id).toBe(t.layerFieldNotes);
    });

    it("non-owner edit of a capture annotation → not_row_owner; a structure annotation needs the live checkout (no_checkout), never a layer reason", async () => {
      const a = ann(t.techA, t.layerFieldNotes);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
      const r = await push(t.techB, [{ table: "drawings.annotations", row: { ...a, revision: 2, label: "hijack" } }]);
      expect(r.rejected[0]).toMatchObject({ id: a.id, reason: "not_row_owner" });

      await setCheckout(owner, t, t.designer);
      const s = ann(t.designer, t.layerDesign, { kind: "text", label: "wall", geometry: { x: 5, y: 5 } });
      expect((await push(t.designer, [{ table: "drawings.annotations", row: s }])).rejected).toEqual([]);
      await setCheckout(owner, t, null);
      const r2 = await push(t.designer, [{ table: "drawings.annotations", row: { ...s, revision: 2, label: "wall (moved)" } }]);
      expect(r2.rejected[0]).toMatchObject({ reason: "no_checkout" });
      const reasons = await owner<{ reason: string }[]>`select distinct reason from places.sync_rejections where organization_id = ${t.org}`;
      expect(reasons.some((x) => x.reason.startsWith("layer"))).toBe(false);
    });

    it("a layer of ANOTHER drawing → unknown_parent (not a layer condition: the parent is wrong)", async () => {
      const a = ann(t.techA, t.layerBoard); // Board belongs to the whiteboard, page1 to the plan
      const r = await push(t.techA, [{ table: "drawings.annotations", row: a }]);
      expect(r.rejected[0]).toMatchObject({ reason: "unknown_parent" });
    });

    it("whiteboard annotations land on Board (any role, no redirect)", async () => {
      const a = syncSet(t, t.techA, { page_id: t.boardPage, layer_id: t.layerBoard, kind: "pen", geometry: { points: [[0, 0], [9, 9]] }, z: 1 });
      const r = await push(t.techA, [{ table: "drawings.annotations", row: a }]);
      expect(r.accepted[0]).toMatchObject({ op: "created" });
      expect(r.accepted[0].redirected).toBeUndefined();
      expect((await ownerRow(owner, "drawings.annotations", a.id as string))!.class).toBe("capture");
      // a designer with the checkout on the board is still capture (there is no structure layer to land on)
      await setCheckout(owner, t, t.designer);
      const b = syncSet(t, t.designer, { page_id: t.boardPage, layer_id: t.layerBoard, kind: "note", label: "idea", geometry: { x: 1, y: 1 }, z: 2 });
      await push(t.designer, [{ table: "drawings.annotations", row: b }]);
      expect((await ownerRow(owner, "drawings.annotations", b.id as string))!.class).toBe("capture");
    });

    it("duplicate push of a redirected row → one events row per row-revision, identical state", async () => {
      const a = ann(t.techA, t.layerDesign);
      const first = await push(t.techA, [{ table: "drawings.annotations", row: a }]);
      expect(first.accepted[0]).toMatchObject({ op: "created", redirected: true });
      const before = await ownerRow(owner, "drawings.annotations", a.id as string);
      const second = await push(t.techA, [{ table: "drawings.annotations", row: a }]);
      expect(second.rejected).toEqual([]);
      expect(second.accepted[0]).toMatchObject({ op: "noop", redirected: true, redirected_to_layer_id: t.layerFieldNotes });
      const after = await ownerRow(owner, "drawings.annotations", a.id as string);
      expect({ ...after, updated_at: null, received_at: null }).toEqual({ ...before, updated_at: null, received_at: null });
      expect(await ownerCount(owner, "shared.events", { ref_id: a.id as string })).toBe(1);
      expect(await rejections(a.id as string)).toBe(0);
    });

    it("tombstone-resurrection guard applies to annotations: a newer edit cannot clear a tombstone (stale_tombstone)", async () => {
      const a = ann(t.techA, t.layerFieldNotes);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 2, deleted_at: new Date().toISOString() } }])).accepted[0].op).toBe("tombstoned");
      const r = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 3, label: "back from the dead" } }]);
      expect(r.rejected[0]).toMatchObject({ id: a.id, reason: "stale_tombstone" });
      expect((await ownerRow(owner, "drawings.annotations", a.id as string))!.deleted_at).not.toBeNull();
      // the device's own redo (tombstone cleared WITH a tombstone-aware push) is W-app territory; a stale lower revision is stale_revision
      const r2 = await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 1, label: "older" } }]);
      expect(r2.rejected[0]).toMatchObject({ reason: "stale_revision" });
    });

    it("the 090 seeded Sandbox plan …0061: technician on Design is redirected to Field Notes …0092 (seed templates drive the default)", async () => {
      const a = {
        id: crypto.randomUUID(), organization_id: SEED.org, revision: 1, occurred_at: new Date().toISOString(), device_id: "seed-device",
        created_by: SEED.techA, page_id: SEED.page1, layer_id: SEED.layers.design, kind: "pen", geometry: { points: [[1, 1], [3, 3]] }, z: 1,
      };
      const r = await callSync(env, syncRequest("POST", "/sync/push", { actor: SEED.techA, org: SEED.org, body: { device_id: "seed-device", rows: [{ table: "drawings.annotations", row: a }] } }));
      expect(r.status).toBe(200);
      const body = r.body as PushResult;
      expect(body.rejected).toEqual([]);
      expect(body.accepted[0]).toMatchObject({ redirected: true, redirected_to_layer_id: SEED.layers.fieldNotes, redirect_reason: "policy" });
      const row = (await ownerRow(owner, "drawings.annotations", a.id))!;
      expect(row.redirected_from_layer_id).toBe(SEED.layers.design);
      expect(row.class).toBe("capture");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("landing-layer policy (pure)", () => {
    const L = (over: Partial<LayerRow>): LayerRow => ({
      id: crypto.randomUUID(), organization_id: "o", drawing_id: "d", template_id: null, name: "L", ordinal: 1, class: "capture", write_policy: "any_member",
      locked: false, locked_by: null, locked_at: null, export: true, color_hint: null, revision: 1, deleted_at: null, default_for_role: null, ...over,
    });
    it("role default first, then capture/any_member by ordinal; locked ones skipped; nothing writable → still lands (never strands)", () => {
      const design = L({ name: "Design", ordinal: 1, class: "structure", write_policy: "designer_checkout" });
      const notes = L({ name: "Field Notes", ordinal: 2, default_for_role: "technician" });
      const rough = L({ name: "Rough-In", ordinal: 3 });
      const tech = { actorId: "t", role: "technician", isAdmin: false };
      expect(pickLandingLayer([rough, notes, design], tech, false, true)?.name).toBe("Field Notes");
      expect(pickLandingLayer([rough, { ...notes, locked: true }, design], tech, false, true)?.name).toBe("Rough-In");
      expect(pickLandingLayer([{ ...rough, locked: true }, { ...notes, locked: true }, design], tech, false, true)?.name).toBe("Field Notes");
      // structure under a project is reachable only with the live checkout, whatever the policy says
      expect(isWritable(L({ class: "structure", write_policy: "any_member" }), tech, false, true).writable).toBe(false);
      expect(isWritable(L({ class: "structure", write_policy: "designer_checkout" }), { actorId: "d", role: "designer", isAdmin: false }, true, true).writable).toBe(true);
      // unattached: designer_checkout behaves as 'designer'
      expect(isWritable(L({ class: "structure", write_policy: "designer_checkout" }), { actorId: "d", role: "designer", isAdmin: false }, false, false).writable).toBe(true);
      expect(isWritable(L({ class: "structure", write_policy: "designer_checkout" }), tech, false, false)).toEqual({ writable: false, reason: "policy" });
      expect(isWritable(L({ write_policy: "admin" }), { actorId: "o", role: "office", isAdmin: true }, false, true).writable).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("layer CRUD routes", () => {
    const call = (method: string, path: string, actor: string, body?: unknown) => callSync(env, syncRequest(method, path, { actor, org: t.org, body }));

    it("GET lists layers in render order; technician may not add (403); designer adds (201) with class/write_policy from the body", async () => {
      expect((await call("POST", `/drawings/${t.drawing}/layers`, t.techA, { name: "Mine", class: "capture", write_policy: "any_member" })).status).toBe(403);
      const r = await call("POST", `/drawings/${t.drawing}/layers`, t.designerB, { name: "Trim", class: "capture", write_policy: "any_member", export: true });
      expect(r.status).toBe(201);
      const layer = (r.body as { layer: Record<string, unknown> }).layer;
      expect(layer).toMatchObject({ name: "Trim", class: "capture", write_policy: "any_member", locked: false, export: true, template_id: null });
      expect(Number(layer.ordinal)).toBeGreaterThan(2);
      expect((await ownerEvents(owner, { ref_id: layer.id as string, event_type: "layer.created" })).length).toBe(1);
      const list = await call("GET", `/drawings/${t.drawing}/layers`, t.techA);
      expect(list.status).toBe(200);
      const names = (list.body as { layers: { name: string; ordinal: number }[] }).layers;
      expect(names.map((l) => l.ordinal)).toEqual([...names.map((l) => l.ordinal)].sort((a, b) => a - b));
      expect(names[0].name).toBe("Design");
    });

    it("validation: 400 on bad class / write_policy / missing name; 404 for a drawing of another org", async () => {
      expect((await call("POST", `/drawings/${t.drawing}/layers`, t.office, { name: "X", class: "ink", write_policy: "any_member" })).status).toBe(400);
      expect((await call("POST", `/drawings/${t.drawing}/layers`, t.office, { name: "X", class: "capture", write_policy: "anyone" })).status).toBe(400);
      expect((await call("POST", `/drawings/${t.drawing}/layers`, t.office, { class: "capture", write_policy: "any_member" })).status).toBe(400);
      expect((await call("POST", `/drawings/${SEED.plan}/layers`, t.office, { name: "X", class: "capture", write_policy: "any_member" })).status).toBe(404);
    });

    it("PATCH: designer renames/reorders; designer cannot lock (403) or change export (403); class / write_policy immutable (400); lock sets locked_by/at", async () => {
      const r = await call("POST", `/drawings/${t.drawing}/layers`, t.office, { name: "Service", class: "capture", write_policy: "any_member" });
      const id = (r.body as { layer: { id: string } }).layer.id;
      const ren = await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.designerB, { name: "Service (renamed)", ordinal: 50 });
      expect(ren.status).toBe(200);
      expect((ren.body as { layer: { name: string; ordinal: number; revision: number } }).layer).toMatchObject({ name: "Service (renamed)", ordinal: 50, revision: 2 });
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.designerB, { locked: true })).status).toBe(403);
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.designerB, { export: false })).status).toBe(403);
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.office, { class: "structure" })).status).toBe(400);
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.office, { write_policy: "admin" })).status).toBe(400);
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.techA, { name: "nope" })).status).toBe(403);
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.office, {})).status).toBe(400);
      const lock = await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.office, { locked: true, export: false });
      expect(lock.status).toBe(200);
      const l = (lock.body as { layer: Record<string, unknown> }).layer;
      expect(l).toMatchObject({ locked: true, locked_by: t.office, export: false });
      expect(l.locked_at).not.toBeNull();
      // locking again = noop, no second event
      expect(((await call("PATCH", `/drawings/${t.drawing}/layers/${id}`, t.office, { locked: true })).body as { op: string }).op).toBe("noop");
      expect((await ownerEvents(owner, { ref_id: id, event_type: "layer.locked" })).length).toBe(1);
      // the admin (designer with is_admin) may lock too
      const r2 = await call("POST", `/drawings/${t.drawing}/layers`, t.office, { name: "Admin-lockable", class: "capture", write_policy: "any_member" });
      const id2 = (r2.body as { layer: { id: string } }).layer.id;
      expect((await call("PATCH", `/drawings/${t.drawing}/layers/${id2}`, t.designer, { locked: true })).status).toBe(200);
    });

    it("DELETE tombstones (office/admin only); 409 while non-deleted annotations reference it; tombstoned layers leave the list", async () => {
      const r = await call("POST", `/drawings/${t.drawing}/layers`, t.office, { name: "Temp", class: "capture", write_policy: "any_member" });
      const id = (r.body as { layer: { id: string } }).layer.id;
      const a = ann(t.techA, id);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: a }])).rejected).toEqual([]);
      expect((await call("DELETE", `/drawings/${t.drawing}/layers/${id}`, t.designerB)).status).toBe(403);
      const blocked = await call("DELETE", `/drawings/${t.drawing}/layers/${id}`, t.office);
      expect(blocked.status).toBe(409);
      expect((blocked.body as { annotations: number }).annotations).toBe(1);
      expect((await push(t.techA, [{ table: "drawings.annotations", row: { ...a, revision: 2, deleted_at: new Date().toISOString() } }])).accepted[0].op).toBe("tombstoned");
      const gone = await call("DELETE", `/drawings/${t.drawing}/layers/${id}`, t.office);
      expect(gone.status).toBe(200);
      expect((gone.body as { op: string }).op).toBe("tombstoned");
      expect((await ownerRow(owner, "drawings.layers", id))!.deleted_at).not.toBeNull();
      expect((await ownerEvents(owner, { ref_id: id, event_type: "layer.tombstoned" })).length).toBe(1);
      const list = await call("GET", `/drawings/${t.drawing}/layers`, t.office);
      expect((list.body as { layers: { id: string }[] }).layers.some((l) => l.id === id)).toBe(false);
      // a new stroke aimed at the tombstoned layer is redirected, never rejected
      const late = await push(t.techA, [{ table: "drawings.annotations", row: ann(t.techA, id) }]);
      expect(late.rejected).toEqual([]);
      expect(late.accepted[0]).toMatchObject({ redirected: true, redirect_reason: "locked" });
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("/sync/pull render order", () => {
    it("layers carry ordinal/locked/export/class/write_policy; annotations carry z, layer_id, redirected_from_layer_id, layer_ordinal and come ordered (layer ordinal, z, received_at)", async () => {
      const t2 = await createTestOrg(owner, "pull-order");
      const pushAs = (actor: string, rows: { table: string; row: Record<string, unknown> }[]) => push(actor, rows, t2.org);
      const mk = (layer: string, z: number) => syncSet(t2, t2.techA, { page_id: t2.page1, layer_id: layer, kind: "pen", geometry: { points: [[z, z]] }, z });
      // Design (ordinal 1) rows come from the designer with the checkout; Field Notes (ordinal 2) rows from the tech, pushed FIRST
      const fn3 = mk(t2.layerFieldNotes, 3), fn1 = mk(t2.layerFieldNotes, 1), aimed = mk(t2.layerDesign, 2); // aimed → redirected to Field Notes z=2
      expect((await pushAs(t2.techA, [{ table: "drawings.annotations", row: fn3 }, { table: "drawings.annotations", row: fn1 }, { table: "drawings.annotations", row: aimed }])).rejected).toEqual([]);
      await setCheckout(owner, t2, t2.designer);
      const d2 = syncSet(t2, t2.designer, { page_id: t2.page1, layer_id: t2.layerDesign, kind: "rect", geometry: { x: 1, y: 1, w: 1, h: 1 }, z: 2 });
      const d1 = syncSet(t2, t2.designer, { page_id: t2.page1, layer_id: t2.layerDesign, kind: "rect", geometry: { x: 2, y: 2, w: 1, h: 1 }, z: 1 });
      expect((await pushAs(t2.designer, [{ table: "drawings.annotations", row: d2 }, { table: "drawings.annotations", row: d1 }])).rejected).toEqual([]);

      const r = await callSync(env, syncRequest("GET", `/sync/pull?project_id=${t2.project}`, { actor: t2.techA, org: t2.org }));
      expect(r.status).toBe(200);
      const body = r.body as PullResult;
      const layers = body.structure["drawings.layers"];
      for (const l of layers) for (const k of ["ordinal", "locked", "export", "class", "write_policy"]) expect(l, k).toHaveProperty(k);
      const anns = body.captures["drawings.annotations"];
      for (const a of anns) for (const k of ["z", "layer_id", "redirected_from_layer_id", "layer_ordinal"]) expect(a, k).toHaveProperty(k);
      expect(anns.map((a) => a.id)).toEqual([d1.id, d2.id, fn1.id, aimed.id, fn3.id]);
      expect(anns.find((a) => a.id === aimed.id)).toMatchObject({ layer_id: t2.layerFieldNotes, redirected_from_layer_id: t2.layerDesign, class: "capture" });
    });
  });
});

// row: A5-fix1 · 2026-10-09 — regression: a phone sending checked: null must not hit the NOT NULL
import { describe as describeFix, it as itFix, expect as expectFix, beforeAll as beforeAllFix, afterAll as afterAllFix } from "vitest";
import { dbAvailable as dbAvailFix, ownerSql as ownerSqlFix, createTestOrg as createOrgFix, syncEnv as syncEnvFix, syncRequest as syncRequestFix, callSync as callSyncFix, syncSet as syncSetFix, type Sql as SqlFix, type TestOrg as TestOrgFix } from "./_db";
import type { PushResult as PushResultFix } from "../../src/sync/push";
const availFix = await dbAvailFix();
describeFix.skipIf(!availFix)("annotations.checked null → false (A5-fix1)", () => {
  let owner: SqlFix; let t: TestOrgFix; const env = syncEnvFix();
  beforeAllFix(async () => { owner = ownerSqlFix(); t = await createOrgFix(owner, "chk"); });
  afterAllFix(async () => { await owner.end(); });
  itFix("accepts a capture mark pushed with checked: null and stores false", async () => {
    const layers = await owner`select id from drawings.layers where drawing_id = ${t.drawing} and name = 'Field Notes'`;
    const pages = await owner`select id from drawings.pages where drawing_id = ${t.drawing} order by ordinal limit 1`;
    const row = syncSetFix(t, t.techA, { page_id: pages[0].id, layer_id: layers[0].id, kind: "rect", geometry: { x: 1, y: 1, w: 2, h: 2 }, z: 1, checked: null, style: {}, label: null });
    const res = (await callSyncFix(env, syncRequestFix("POST", "/sync/push", { actor: t.techA, org: t.org, body: { device_id: "ios-chk", rows: [{ table: "drawings.annotations", row }] } }))).body as PushResultFix;
    expectFix(res.rejected).toEqual([]);
    expectFix(res.accepted.length).toBe(1);
    const stored = await owner`select checked from drawings.annotations where id = ${row.id as string}`;
    expectFix(stored[0].checked).toBe(false);
  });
});
