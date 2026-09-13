//==============================================================================
// field-definitions.test.ts — validateCustom(): the pure core over every one of
// the 13 field types (no DB), then the tx loader against field_definitions
// rows inserted for a scratch tenant (skips without Postgres).
//==============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenant, withTenantRead, type Sql } from "../src/db";
import {
  validateCustomAgainst,
  validateCustom,
  loadFieldDefinitions,
  optionValues,
  FIELD_TYPES,
  type FieldDefinition,
} from "../src/field-definitions";
import { dbAvailable, testEnv, createScratchTenant, sharedSql } from "./_pg";

const up = await dbAvailable();

const def = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  entity: "work_orders",
  key,
  label: key.replace(/_/g, " "),
  type,
  options: [],
  required: false,
  ...extra,
});

const DEFS: FieldDefinition[] = [
  def("lockbox_code", "text", { required: true }),
  def("notes_long", "textarea"),
  def("panel_count", "number"),
  def("deposit", "currency"),
  def("pets", "boolean"),
  def("permit_date", "date"),
  def("inspection_at", "datetime"),
  def("preferred_contact", "picklist", { options: ["Call", "Text", "Email"] }),
  def("systems", "multipicklist", { options: [{ value: "AV", label: "Audio/Video" }, { value: "NET" }, "SEC"] }),
  def("companycam_url", "url"),
  def("site_phone", "phone"),
  def("site_email", "email"),
  def("owner", "lookup", { options: { entity: "contacts" } }),
];

const GOOD = {
  lockbox_code: "4471",
  notes_long: "two lines\nof notes",
  panel_count: 3,
  deposit: 1250.5,
  pets: true,
  permit_date: "2026-09-13",
  inspection_at: "2026-09-14T09:30:00-04:00",
  preferred_contact: "Text",
  systems: ["AV", "SEC"],
  companycam_url: "https://app.companycam.com/projects/123",
  site_phone: "+1 (407) 555-0142",
  site_email: "owner@example.com",
  owner: "0192b5a1-7c3e-7c3a-8f1a-1234567890ab",
};

describe("field-definitions.ts pure core", () => {
  it("covers exactly the 13 CHECK-constraint types", () => {
    expect([...FIELD_TYPES].sort()).toEqual(
      ["text", "number", "date", "datetime", "boolean", "picklist", "multipicklist", "url", "phone", "email", "lookup", "currency", "textarea"].sort()
    );
    expect(new Set(DEFS.map((d) => d.type)).size).toBe(13);
  });

  it("accepts a good record", () => {
    expect(validateCustomAgainst(DEFS, GOOD)).toEqual({ ok: true, errors: [] });
  });

  it("accepts an empty record when nothing is required, and null/'' for optional fields", () => {
    const optional = DEFS.map((d) => ({ ...d, required: false }));
    expect(validateCustomAgainst(optional, {}).ok).toBe(true);
    expect(validateCustomAgainst(optional, { panel_count: null, site_email: "", systems: [] }).ok).toBe(true);
    expect(validateCustomAgainst(optional, null).ok).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { lockbox_code: _omit, ...rest } = GOOD;
    const r = validateCustomAgainst(DEFS, rest);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ key: "lockbox_code", code: "required", message: "lockbox code is required" }]);
    expect(validateCustomAgainst(DEFS, { ...GOOD, lockbox_code: "  " }).errors[0].code).toBe("required");
  });

  it("rejects a bad picklist value (and lists the options)", () => {
    const r = validateCustomAgainst(DEFS, { ...GOOD, preferred_contact: "Fax" });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ key: "preferred_contact", code: "picklist" });
    expect(r.errors[0].message).toContain('"Call", "Text", "Email"');
  });

  it("rejects bad multipicklist entries and non-array values", () => {
    expect(validateCustomAgainst(DEFS, { ...GOOD, systems: ["AV", "HVAC"] }).errors[0]).toMatchObject({ key: "systems", code: "picklist" });
    expect(validateCustomAgainst(DEFS, { ...GOOD, systems: "AV" }).errors[0]).toMatchObject({ key: "systems", code: "type" });
    expect(optionValues(DEFS.find((d) => d.key === "systems")!.options)).toEqual(["AV", "NET", "SEC"]);
  });

  it("rejects a bad url", () => {
    for (const v of ["not a url", "ftp://files.example.com/x", "javascript:alert(1)", 42]) {
      const r = validateCustomAgainst(DEFS, { ...GOOD, companycam_url: v });
      expect(r.ok, String(v)).toBe(false);
      expect(r.errors[0].key).toBe("companycam_url");
    }
  });

  it("rejects bad phone / email / lookup / date / datetime / number / boolean", () => {
    const cases: Array<[string, unknown]> = [
      ["site_phone", "call me"],
      ["site_phone", "123"],
      ["site_email", "nope@"],
      ["owner", "not-a-uuid"],
      ["permit_date", "2026-02-30"],
      ["permit_date", "13/09/2026"],
      ["inspection_at", "2026-09-14"],
      ["inspection_at", "tomorrow"],
      ["panel_count", "3"],
      ["deposit", Number.NaN],
      ["pets", "yes"],
      ["lockbox_code", 4471],
    ];
    for (const [key, v] of cases) {
      const r = validateCustomAgainst(DEFS, { ...GOOD, [key]: v });
      expect(r.ok, `${key}=${String(v)}`).toBe(false);
      expect(r.errors.map((e) => e.key)).toEqual([key]);
    }
  });

  it("rejects unknown keys unless allowUnknown", () => {
    const r = validateCustomAgainst(DEFS, { ...GOOD, mystery: 1 });
    expect(r.errors).toEqual([{ key: "mystery", code: "unknown_field", message: '"mystery" is not a defined field' }]);
    expect(validateCustomAgainst(DEFS, { ...GOOD, mystery: 1 }, { allowUnknown: true }).ok).toBe(true);
  });

  it("reports every error at once", () => {
    const r = validateCustomAgainst(DEFS, { preferred_contact: "Fax", companycam_url: "x" });
    expect(r.errors.map((e) => e.key).sort()).toEqual(["companycam_url", "lockbox_code", "preferred_contact"]);
  });
});

describe.skipIf(!up)("field-definitions.ts loader against Postgres", () => {
  const env = testEnv();
  let sql: Sql;
  let tenant: string;

  beforeAll(async () => {
    sql = sharedSql(4);
    tenant = await createScratchTenant(env, sql, "fields");
    await withTenant(env, tenant, async (tx) => {
      await tx`
        insert into public.field_definitions (tenant_id, entity, key, label, type, options, required, sort_order, visible, group_name, help_text) values
          (public.app_tenant_id(), 'work_orders', 'lockbox_code', 'Lockbox code', 'text', '[]', true, 10, true, 'Site access', 'Shown to techs'),
          (public.app_tenant_id(), 'work_orders', 'companycam_url', 'CompanyCam', 'url', '[]', false, 20, true, null, null),
          (public.app_tenant_id(), 'contacts', 'preferred_contact_method', 'Preferred contact', 'picklist', '["Call","Text","Email"]', false, 20, true, 'Communication', null)`;
    }, { sql });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("loads only the entity's definitions for the tenant, in sort order", async () => {
    const defs = await withTenantRead(env, tenant, (tx) => loadFieldDefinitions(tx, "work_orders"), { sql });
    expect(defs.map((d) => d.key)).toEqual(["lockbox_code", "companycam_url"]);
    expect(defs[0]).toMatchObject({ type: "text", required: true, group_name: "Site access", options: [] });
    const none = await withTenantRead(env, testEnv().TENANT_ID!, (tx) => loadFieldDefinitions(tx, "work_orders"), { sql });
    expect(none.filter((d) => d.key === "lockbox_code")).toEqual([]); // FHI tenant does not see the scratch rows
  });

  it("validateCustom(tx, …) applies the stored definitions", async () => {
    const good = await withTenantRead(env, tenant, (tx) =>
      validateCustom(tx, "work_orders", { lockbox_code: "1234", companycam_url: "https://app.companycam.com/p/1" }), { sql });
    expect(good).toEqual({ ok: true, errors: [] });

    const bad = await withTenantRead(env, tenant, (tx) => validateCustom(tx, "work_orders", { companycam_url: "nope" }), { sql });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => [e.key, e.code])).toEqual([
      ["lockbox_code", "required"],
      ["companycam_url", "format"],
    ]);

    const pick = await withTenantRead(env, tenant, (tx) => validateCustom(tx, "contacts", { preferred_contact_method: "Fax" }), { sql });
    expect(pick.errors[0]).toMatchObject({ key: "preferred_contact_method", code: "picklist" });
  });

  it("the DB CHECK constraint rejects a 14th type", async () => {
    await expect(
      withTenant(env, tenant, (tx) => tx`
        insert into public.field_definitions (tenant_id, entity, key, label, type)
        values (public.app_tenant_id(), 'work_orders', 'bad', 'Bad', 'json')`, { sql })
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });
});
