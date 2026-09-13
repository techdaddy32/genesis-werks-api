//==============================================================================
// repo/materials.ts — the per-WO Materials list on Postgres (P2, S11).
//
//   GET    /work-orders/:id/materials       → listMaterials()   (?projectId= ignored, as before)
//   POST   /work-orders/:id/materials       → addMaterial()
//   PATCH  /work-orders/:id/materials/:mid  → updateMaterial()  (completed / name / notes — name+notes now honored, additive)
//   DELETE /work-orders/:id/materials/:mid  → deleteMaterial()  (soft delete)
//
// An item request (repo/items.ts addItem) mirrors a row here with from_request =
// true and source_item_id → items.id. Writes append events.
//==============================================================================

import type { CreateMaterialInput, Env, Material, UpdateMaterialInput } from "../types";
import { isUuid, withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { API_ACTOR, findWorkOrderRef, tenantOf } from "./_shared";
import { serializeMaterial, type MaterialViewRow } from "../serialize/material";

const MATERIAL_COLS = [
  "id", "work_order_id", "name", "notes", "from_request", "source_item_label", "source_item_id", "completed",
  "created_at", "updated_at",
] as const;

//------------------------------------------------------------------------------
// Transaction-level primitives
//------------------------------------------------------------------------------

export async function getMaterialTx(tx: Tx, materialId: string, workOrderId?: string): Promise<Material | null> {
  if (!isUuid(materialId)) return null;
  const rows = await tx<MaterialViewRow[]>`
    select ${tx(MATERIAL_COLS)} from public.v_materials
    where tenant_id = public.app_tenant_id() and id = ${materialId} and deleted_at is null
      and (${!workOrderId} or work_order_id = ${workOrderId ?? null}::uuid)
    limit 1`;
  return rows.length ? serializeMaterial(rows[0]) : null;
}

export async function listMaterialsTx(tx: Tx, workOrderId: string): Promise<Material[]> {
  const rows = await tx<MaterialViewRow[]>`
    select ${tx(MATERIAL_COLS)} from public.v_materials
    where tenant_id = public.app_tenant_id() and work_order_id = ${workOrderId} and deleted_at is null
    order by created_at asc, id asc`;
  return rows.map(serializeMaterial);
}

export interface CreateMaterialRow {
  name: string;
  notes?: string | null;
  fromRequest?: boolean;
  sourceItem?: string | null;
  sourceItemId?: string | null;
}

/** Insert a material on a resolved work_orders.id (manual, or the item-request mirror). */
export async function createMaterialTx(tx: Tx, workOrderId: string, input: CreateMaterialRow, opts: { actor?: string } = {}): Promise<Material> {
  const rows = await tx<{ id: string }[]>`
    insert into public.materials (tenant_id, work_order_id, name, notes, from_request, source_item_label, source_item_id)
    values (public.app_tenant_id(), ${workOrderId}, ${input.name.trim()}, ${input.notes?.trim() || null},
            ${input.fromRequest === true}, ${input.sourceItem ?? null}, ${input.sourceItemId ?? null})
    returning id`;
  const id = rows[0].id;
  await appendEvent(tx, {
    entity: "material",
    entityId: id,
    eventType: "material.created",
    payload: { workOrderId, name: input.name.trim(), fromRequest: input.fromRequest === true, sourceItemId: input.sourceItemId ?? null },
    actor: opts.actor ?? API_ACTOR,
  });
  return (await getMaterialTx(tx, id))!;
}

export async function updateMaterialTx(
  tx: Tx,
  woWireId: string,
  materialId: string,
  patch: UpdateMaterialInput,
  opts: { actor?: string } = {}
): Promise<Material | null> {
  const woId = await findWorkOrderRef(tx, woWireId);
  if (!woId) return null;
  const current = await getMaterialTx(tx, materialId, woId);
  if (!current) return null;
  await tx`
    update public.materials set
      name         = coalesce(${typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : null}, name),
      notes        = case when ${patch.notes !== undefined} then ${patch.notes?.trim() || null} else notes end,
      completed_at = case when ${typeof patch.completed === "boolean"}
                       then (case when ${patch.completed === true} then coalesce(completed_at, now()) else null end)
                       else completed_at end
    where tenant_id = public.app_tenant_id() and id = ${materialId}`;
  await appendEvent(tx, {
    entity: "material",
    entityId: materialId,
    eventType: "material.updated",
    payload: { workOrderId: woId, patch },
    actor: opts.actor ?? API_ACTOR,
  });
  return getMaterialTx(tx, materialId, woId);
}

/** Soft-delete a material. Returns false only when the WO itself is unknown (a missing material is idempotent, as before). */
export async function deleteMaterialTx(tx: Tx, woWireId: string, materialId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const woId = await findWorkOrderRef(tx, woWireId);
  if (!woId) return false;
  if (!isUuid(materialId)) return true;
  const r = await tx`
    update public.materials set deleted_at = now()
    where tenant_id = public.app_tenant_id() and id = ${materialId} and work_order_id = ${woId} and deleted_at is null`;
  if (r.count) {
    await appendEvent(tx, {
      entity: "material",
      entityId: materialId,
      eventType: "material.deleted",
      payload: { workOrderId: woId },
      actor: opts.actor ?? API_ACTOR,
    });
  }
  return true;
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts
//------------------------------------------------------------------------------

export async function listMaterials(env: Env, woWireId: string): Promise<Material[]> {
  return withTenantRead(env, tenantOf(env), async (tx) => {
    const woId = await findWorkOrderRef(tx, woWireId);
    return woId ? listMaterialsTx(tx, woId) : [];
  });
}

export async function addMaterial(env: Env, woWireId: string, input: CreateMaterialInput): Promise<Material | null> {
  return withTenant(env, tenantOf(env), async (tx) => {
    const woId = await findWorkOrderRef(tx, woWireId);
    if (!woId) return null;
    return createMaterialTx(tx, woId, { name: input.name, notes: input.notes ?? null, fromRequest: false });
  });
}

export async function updateMaterial(env: Env, woWireId: string, materialId: string, patch: UpdateMaterialInput): Promise<Material | null> {
  return withTenant(env, tenantOf(env), (tx) => updateMaterialTx(tx, woWireId, materialId, patch));
}

export async function deleteMaterial(env: Env, woWireId: string, materialId: string): Promise<boolean> {
  return withTenant(env, tenantOf(env), (tx) => deleteMaterialTx(tx, woWireId, materialId));
}
