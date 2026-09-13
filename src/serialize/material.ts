//==============================================================================
// serialize/material.ts — v_materials row → Material (data-model §2.10, §4).
// Key order = service.ts materialFromTask().
//==============================================================================

import type { Material } from "../types";
import { iso } from "../repo/_shared";

export interface MaterialViewRow {
  id: string;
  work_order_id: string;
  name: string;
  notes: string | null;
  from_request: boolean;
  source_item_label: string | null;
  source_item_id: string | null;
  completed: boolean;
  created_at: Date;
  updated_at: Date;
}

export function serializeMaterial(r: MaterialViewRow): Material {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes || null,
    fromRequest: r.from_request === true,
    sourceItem: r.source_item_label ?? null,
    sourceItemId: r.source_item_id ?? null,
    completed: r.completed === true,
    workOrderId: r.work_order_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
