//==============================================================================
// serialize/todo.ts — v_todos row → Todo (data-model §2.11, §4).
// Key order = service.ts todoFromTask().
//==============================================================================

import type { Todo } from "../types";
import { iso } from "../repo/_shared";

export interface TodoViewRow {
  id: string;
  work_order_id: string;
  work_order_number: string | null;
  title: string;
  status: string;
  urgency: string | null;
  assignee_name: string | null;
  notes: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export function serializeTodo(r: TodoViewRow): Todo {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    urgency: r.urgency ?? null,
    assignee: r.assignee_name || null,
    notes: r.notes || null,
    workOrderId: r.work_order_id,
    workOrderNumber: r.work_order_number ?? null,
    archived: r.archived === true,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
