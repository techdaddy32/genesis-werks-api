//==============================================================================
// serialize/item.ts — v_items row → PurchaseItem / Item (data-model §2.8, §4).
// Key order = service.ts purchaseItemFromTask(); `custom` is the additive key.
//==============================================================================

import type { PurchaseItem } from "../types";
import { customOut, iso } from "../repo/_shared";

export interface ItemViewRow {
  id: string;
  work_order_id: string;
  source_wo: string;
  name: string;
  quantity: string | number | null;
  note: string | null;
  status: string;
  is_terminal: boolean;
  archived: boolean;
  created_at: Date;
  custom: unknown;
}

export function serializeItem(r: ItemViewRow): PurchaseItem {
  return {
    id: r.id,
    item: r.name,
    quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
    note: r.note || null,
    status: r.status,
    sourceWo: r.source_wo ?? null,
    sourceWoId: r.work_order_id,
    archived: r.archived === true,
    createdAt: iso(r.created_at),
    custom: customOut(r.custom),
  };
}
