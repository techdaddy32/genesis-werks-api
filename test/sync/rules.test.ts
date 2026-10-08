// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07
// Flag chain (walk spec §5.5, §6 check 5): capture.flagged → field_rules → action_items(field_flag);
// placement.as_walked → verify_placement. Idempotent across a duplicate push. Rules run in TypeScript (src/rules.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbAvailable, ownerSql, createTestOrg, setCheckout, syncEnv, syncRequest, callSync, syncSet, ownerEvents, type Sql, type TestOrg } from "./_db";
import type { PushResult } from "../../src/sync/push";
import { conditionMatches, renderTemplate } from "../../src/rules";

const available = await dbAvailable();

describe.skipIf(!available)("field_rules → action_items", () => {
  let owner: Sql;
  let t: TestOrg;
  const env = syncEnv();
  const push = async (actor: string, rows: { table: string; row: Record<string, unknown> }[]) =>
    (await callSync(env, syncRequest("POST", "/sync/push", { actor, org: t.org, body: { device_id: "phone-a", rows } }))).body as PushResult;
  const items = (sourceRefId: string) => owner<Record<string, unknown>[]>`select * from shared.action_items where organization_id = ${t.org} and source_ref_id = ${sourceRefId}`;

  beforeAll(async () => {
    owner = ownerSql();
    t = await createTestOrg(owner, "rules");
    await setCheckout(owner, t, t.designer);
  });
  afterAll(async () => { await owner.end({ timeout: 2 }); });

  it("pure helpers: condition matching + template rendering", () => {
    const ev = { organizationId: t.org, actorId: null, eventType: "capture.flagged", refTable: "places.location_notes", refId: "x", row: { kind: "flag", body: "b" }, projectId: null };
    expect(conditionMatches({ ref_table: "places.location_notes", kind: "flag" }, ev)).toBe(true);
    expect(conditionMatches({ kind: "note" }, ev)).toBe(false);
    expect(conditionMatches({}, ev)).toBe(true);
    expect(renderTemplate("Field flag: {{body}} ({{missing}})", { body: "hi" })).toBe("Field flag: hi ()");
  });

  it("a flag note pushed twice → exactly one capture.flagged event and ONE action item (field_flag, open, project from the walk)", async () => {
    const walk = syncSet(t, t.techA, { project_id: t.project, status: "attached", started_at: new Date().toISOString(), checked_out_revision: 0 });
    const flag = syncSet(t, t.techA, { walk_id: walk.id, project_id: t.project, room_id: t.rooms.kitchen, kind: "flag", body: "cracked box" });
    const batch = [{ table: "places.walks", row: walk }, { table: "places.location_notes", row: flag }];
    const r1 = await push(t.techA, batch);
    expect(r1.rejected).toEqual([]);
    const r2 = await push(t.techA, batch);
    expect(r2.accepted.map((a) => a.op)).toEqual(["noop", "noop"]);
    expect((await ownerEvents(owner, { ref_id: flag.id as string, event_type: "capture.flagged" })).length).toBe(1);
    const ai = await items(flag.id as string);
    expect(ai.length).toBe(1);
    expect(ai[0].source_kind).toBe("field_flag");
    expect(ai[0].source_ref_table).toBe("places.location_notes");
    expect(ai[0].project_id).toBe(t.project);
    expect(ai[0].status).toBe("open");
    expect(ai[0].title).toBe("Field flag: cracked box");
    expect(ai[0].assignee_id).toBeNull(); // L8/L10 fence: review item, not dispatchable work
    expect(ai[0].rule_id).toBeTruthy();
    const rule = (await owner<{ key: string; organization_id: string | null }[]>`select key, organization_id from shared.field_rules where id = ${ai[0].rule_id as string}`)[0];
    expect(rule.organization_id).toBeNull(); // the 060 platform default fired
    expect(rule.key).toContain("capture.flagged");
    // a retry at a HIGHER revision (edited flag text) still yields one item (partial UNIQUE)
    const r3 = await push(t.techA, [{ table: "places.location_notes", row: { ...flag, revision: 2, body: "cracked box — confirmed" } }]);
    expect(r3.accepted[0]?.op).toBe("updated");
    expect((await items(flag.id as string)).length).toBe(1);
  });

  it("a plain note creates no action item; a tombstoned flag creates none", async () => {
    const note = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, kind: "note", body: "fine" });
    const deadFlag = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.kitchen, kind: "flag", body: "withdrawn", deleted_at: new Date().toISOString() });
    const r = await push(t.techA, [{ table: "places.location_notes", row: note }, { table: "places.location_notes", row: deadFlag }]);
    expect(r.rejected).toEqual([]);
    expect((await items(note.id as string)).length).toBe(0);
    expect((await items(deadFlag.id as string)).length).toBe(0);
  });

  it("an as-walked placement → placement.as_walked → ONE verify_placement item (duplicate push stays one)", async () => {
    const placement = syncSet(t, t.techA, {
      project_id: t.project, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "as_walked",
      product_name: "Keypad K6", placement_status: "placed",
    });
    const batch = [{ table: "places.device_placements", row: placement }];
    expect((await push(t.techA, batch)).rejected).toEqual([]);
    expect((await push(t.techA, batch)).accepted[0]?.op).toBe("noop");
    const ai = await items(placement.id as string);
    expect(ai.length).toBe(1);
    expect(ai[0].source_kind).toBe("verify_placement");
    expect(ai[0].title).toBe("Verify as-walked placement: Keypad K6");
    expect(ai[0].project_id).toBe(t.project);
    // a PLAN placement (structure, by the checkout holder) fires no rule
    const plan = syncSet(t, t.designer, { project_id: t.project, room_id: t.rooms.kitchen, location_id: t.locationTv, capture_kind: "plan", product_name: "Keypad K6" });
    expect((await push(t.designer, [{ table: "places.device_placements", row: plan }])).rejected).toEqual([]);
    expect((await items(plan.id as string)).length).toBe(0);
  });

  it("an Organization's own rule runs beside the platform default; a disabled rule does not", async () => {
    const ownRule = crypto.randomUUID();
    const offRule = crypto.randomUUID();
    await owner`insert into shared.field_rules (id, organization_id, key, on_event, condition, action, action_params, enabled, sort_order) values
      (${ownRule}, ${t.org}, 'test:flag→room_hint item', 'capture.flagged', '{"kind":"flag"}', 'create_action_item', '{"source_kind":"room_hint","title_template":"Own rule: {{body}}"}', true, 99),
      (${offRule}, ${t.org}, 'test:disabled', 'capture.flagged', '{}', 'create_action_item', '{"source_kind":"annotation_flag"}', false, 100)`;
    const flag = syncSet(t, t.techA, { project_id: t.project, room_id: t.rooms.foyer, kind: "flag", body: "two rules" });
    expect((await push(t.techA, [{ table: "places.location_notes", row: flag }])).rejected).toEqual([]);
    const ai = await items(flag.id as string);
    expect(ai.map((a) => a.source_kind).sort()).toEqual(["field_flag", "room_hint"]);
    expect(ai.find((a) => a.source_kind === "room_hint")?.title).toBe("Own rule: two rules");
  });

  it("the review list surfaces the items (open, review source_kinds only)", async () => {
    const r = await callSync(env, syncRequest("GET", `/projects/${t.project}/review`, { actor: t.designer, org: t.org }));
    expect(r.status).toBe(200);
    const kinds = new Set((r.body as { action_items: { source_kind: string }[] }).action_items.map((a) => a.source_kind));
    expect(kinds.has("field_flag")).toBe(true);
    expect(kinds.has("verify_placement")).toBe(true);
    expect(kinds.has("room_hint")).toBe(true);
    expect(kinds.has("annotation_flag")).toBe(false);
  });
});
