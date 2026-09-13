//==============================================================================
// repo/items.ts — unified Items (requested + used) on Postgres (P2).
//
//   GET    /work-orders/:id/items          → listItemsForWo()   (every status)
//   POST   /work-orders/:id/items          → addItem()          (+ Materials mirror, Cliq post)
//   GET    /items?status=&archived=        → listPurchasing()   (the purchasing aggregate)
//   PATCH  /items/:id                      → updateItem()
//   DELETE /items/:id                      → deleteItem()       (soft delete; idempotent)
//
// Status vocabulary = status_vocab item_status (auto-created for an unknown label —
// the Zoho path passed any string through). archived / terminal come from v_items
// (closed_at IS NOT NULL OR vocab.is_terminal); the completion gate reads the
// same view (pendingItemsTx). `custom` (entity "items") is validated on every
// write. Writes append events. NO Zoho, NO Google here.
//==============================================================================

import type { AddItemInput, Env, PurchaseItem, UpdatePurchaseInput } from "../types";
import { isUuid, withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { DEFAULT_ORDER_STATUS } from "../config";
import { postToCliq } from "../cliq";
import { API_ACTOR, ensureVocab, findWorkOrderRef, mergeAndValidateCustom, tenantOf } from "./_shared";
import { createMaterialTx } from "./materials";
import { serializeItem, type ItemViewRow } from "../serialize/item";

const ITEM_COLS = [
  "id", "work_order_id", "source_wo", "name", "quantity", "note", "status", "is_terminal", "archived", "created_at", "custom",
] as const;

//------------------------------------------------------------------------------
// Transaction-level primitives
//------------------------------------------------------------------------------

export async function getItemTx(tx: Tx, itemId: string): Promise<PurchaseItem | null> {
  if (!isUuid(itemId)) return null;
  const rows = await tx<ItemViewRow[]>`
    select ${tx(ITEM_COLS)} from public.v_items
    where tenant_id = public.app_tenant_id() and id = ${itemId} and deleted_at is null limit 1`;
  return rows.length ? serializeItem(rows[0]) : null;
}

/** Items (all WOs, or one), oldest first. `status` = case-insensitive exact match; archived excluded unless asked. */
export async function listItemsTx(
  tx: Tx,
  opts: { workOrderId?: string | null; status?: string; includeArchived?: boolean } = {}
): Promise<PurchaseItem[]> {
  const needle = (opts.status ?? "").trim().toLowerCase();
  const rows = await tx<ItemViewRow[]>`
    select ${tx(ITEM_COLS)} from public.v_items i
    where i.tenant_id = public.app_tenant_id() and i.deleted_at is null
      and exists (select 1 from public.work_orders w where w.id = i.work_order_id and w.deleted_at is null)
      and (${!opts.workOrderId} or i.work_order_id = ${opts.workOrderId ?? null}::uuid)
      and (${opts.includeArchived === true} or not i.archived)
      and (${needle === ""} or lower(btrim(i.status)) = ${needle})
    order by i.created_at asc, i.id asc`;
  return rows.map(serializeItem);
}

/** Names of this WO's items that are NOT terminal (the completion gate input). */
export async function pendingItemNamesTx(tx: Tx, workOrderId: string): Promise<string[]> {
  const rows = await tx<{ name: string }[]>`
    select name from public.v_items
    where tenant_id = public.app_tenant_id() and work_order_id = ${workOrderId} and deleted_at is null and not is_terminal
    order by created_at asc`;
  return rows.map((r) => r.name);
}

async function isTerminalStatus(tx: Tx, status: string): Promise<boolean> {
  const rows = await tx<{ t: boolean }[]>`
    select is_terminal as t from public.status_vocab
    where tenant_id = public.app_tenant_id() and domain = 'item_status' and code = ${status} limit 1`;
  return rows.length ? rows[0].t === true : false;
}

/** Insert an item on a resolved work_orders.id; mirrors a Materials row; Cliq post when still sourcing. */
export async function createItemTx(
  tx: Tx,
  env: Env,
  wo: { id: string; workOrderNumber: string; client: string; siteAddress: string | null },
  input: AddItemInput,
  opts: { actor?: string } = {}
): Promise<PurchaseItem> {
  const status = input.status?.trim() || DEFAULT_ORDER_STATUS;
  await ensureVocab(tx, "item_status", status);
  const terminal = await isTerminalStatus(tx, status);
  const note = input.note?.trim() ? input.note.trim() : null;
  const quantity = typeof input.quantity === "number" && Number.isFinite(input.quantity) ? input.quantity : null;
  const custom = await mergeAndValidateCustom(tx, "items", {}, input.custom);
  const rows = await tx<{ id: string }[]>`
    insert into public.items (tenant_id, work_order_id, name, quantity, note, status, closed_at, custom)
    values (public.app_tenant_id(), ${wo.id}, ${input.item.trim()}, ${quantity}, ${note}, ${status},
            ${terminal ? new Date() : null}, ${tx.json(custom as never)})
    returning id`;
  const id = rows[0].id;
  await appendEvent(tx, {
    entity: "item",
    entityId: id,
    eventType: "item.created",
    payload: { workOrderId: wo.id, item: input.item.trim(), quantity, note, status },
    actor: opts.actor ?? API_ACTOR,
  });

  // S11 mirror onto the Materials list (fromRequest) — same transaction, so never half-done.
  await createMaterialTx(
    tx,
    wo.id,
    { name: input.item.trim(), notes: note, fromRequest: true, sourceItem: `${input.item.trim()}${quantity ? ` ×${quantity}` : ""}`, sourceItemId: id },
    opts
  );

  // Cliq materials post only while the item still needs sourcing. Best-effort (postToCliq never throws).
  if (!terminal) {
    const qty = quantity ?? 1;
    const noteSuffix = note ? ` — ${note}` : "";
    await postToCliq(
      env.CLIQ_MATERIALS_WEBHOOK,
      `🧰 Item requested: ${input.item.trim()} x${qty} — WO ${wo.workOrderNumber} (${wo.client}, ${wo.siteAddress ?? ""})${noteSuffix}`
    );
  }
  return (await getItemTx(tx, id))!;
}

export async function updateItemTx(tx: Tx, itemId: string, patch: UpdatePurchaseInput, opts: { actor?: string } = {}): Promise<PurchaseItem | null> {
  if (!isUuid(itemId)) return null;
  const current = await tx<{ id: string; status: string; closed_at: Date | null; custom: unknown }[]>`
    select i.id, i.status, i.closed_at, i.custom from public.items i
    join public.work_orders w on w.id = i.work_order_id and w.deleted_at is null
    where i.tenant_id = public.app_tenant_id() and i.id = ${itemId} and i.deleted_at is null limit 1`;
  if (!current.length) return null;

  const status = patch.status !== undefined ? patch.status.trim() : current[0].status;
  let closedAt = current[0].closed_at;
  if (patch.status !== undefined) {
    await ensureVocab(tx, "item_status", status);
    // A DONE status closes the item; a non-done status re-opens it (mirrors the Zoho complete/reopen dance).
    closedAt = (await isTerminalStatus(tx, status)) ? closedAt ?? new Date() : null;
  }
  const custom =
    patch.custom !== undefined ? await mergeAndValidateCustom(tx, "items", current[0].custom as Record<string, unknown>, patch.custom) : null;
  await tx`
    update public.items set
      status    = ${status},
      note      = case when ${patch.note !== undefined} then ${patch.note?.trim() || null} else note end,
      quantity  = case when ${patch.quantity !== undefined} then ${typeof patch.quantity === "number" ? patch.quantity : null}::numeric else quantity end,
      closed_at = ${closedAt},
      custom    = coalesce(${custom ? tx.json(custom as never) : null}::jsonb, custom)
    where tenant_id = public.app_tenant_id() and id = ${itemId}`;
  await appendEvent(tx, {
    entity: "item",
    entityId: itemId,
    eventType: "item.updated",
    payload: { patch, status },
    actor: opts.actor ?? API_ACTOR,
  });
  return getItemTx(tx, itemId);
}

/** Soft delete; idempotent (a missing id is fine, as the Zoho path was). */
export async function deleteItemTx(tx: Tx, itemId: string, opts: { actor?: string } = {}): Promise<boolean> {
  if (!isUuid(itemId)) return true;
  const r = await tx`
    update public.items set deleted_at = now()
    where tenant_id = public.app_tenant_id() and id = ${itemId} and deleted_at is null`;
  if (r.count) {
    await appendEvent(tx, { entity: "item", entityId: itemId, eventType: "item.deleted", actor: opts.actor ?? API_ACTOR });
  }
  return true;
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts
//------------------------------------------------------------------------------

export async function listItemsForWo(env: Env, woWireId: string): Promise<PurchaseItem[]> {
  return withTenantRead(env, tenantOf(env), async (tx) => {
    const woId = await findWorkOrderRef(tx, woWireId);
    return woId ? listItemsTx(tx, { workOrderId: woId, includeArchived: true }) : [];
  });
}

export async function listPurchasing(env: Env, status?: string, includeArchived = false): Promise<PurchaseItem[]> {
  return withTenantRead(env, tenantOf(env), (tx) => listItemsTx(tx, { status, includeArchived }));
}

export async function addItem(env: Env, woWireId: string, input: AddItemInput): Promise<PurchaseItem | null> {
  return withTenant(env, tenantOf(env), async (tx) => {
    const woId = await findWorkOrderRef(tx, woWireId);
    if (!woId) return null;
    const rows = await tx<{ public_key: string; client_name: string | null; project_name: string; site_address: string | null }[]>`
      select public_key, client_name, project_name, site_address from public.v_work_orders
      where tenant_id = public.app_tenant_id() and id = ${woId} limit 1`;
    const r = rows[0];
    return createItemTx(tx, env, {
      id: woId,
      workOrderNumber: r.public_key,
      client: r.client_name ?? r.project_name.split(" - ")[0]?.trim() ?? r.project_name,
      siteAddress: r.site_address ?? null,
    }, input);
  });
}

export async function updateItem(env: Env, itemId: string, patch: UpdatePurchaseInput): Promise<PurchaseItem | null> {
  return withTenant(env, tenantOf(env), (tx) => updateItemTx(tx, itemId, patch));
}

export async function deleteItem(env: Env, itemId: string): Promise<boolean> {
  return withTenant(env, tenantOf(env), (tx) => deleteItemTx(tx, itemId));
}
