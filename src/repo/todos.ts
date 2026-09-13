//==============================================================================
// repo/todos.ts — per-WO to-dos / action items on Postgres (P2).
//
//   GET   /work-orders/:id/todos?archived=   → listTodos()
//   POST  /work-orders/:id/todos             → addTodo()
//   PATCH /work-orders/:id/todos/:todoId     → updateTodo()
//   GET   /todos?archived=&assignee=&status=&urgency= → listAllTodos()
//
// Vocabulary: status → status_vocab todo_status (auto-created when new — the
// Zoho path passed any string through, so an unknown label is accepted, not
// rejected); urgency → task_priority (none|low|medium|high, else NULL, exactly
// like the old createTask lower-cased + validated). archived = closed_at IS NOT NULL
// OR status = Completed (v_todos). Writes append events.
//==============================================================================

import type { CreateTodoInput, Env, Todo, UpdateTodoInput } from "../types";
import { isUuid, withTenant, withTenantRead, type Tx } from "../db";
import { appendEvent } from "../events";
import { DEFAULT_TODO_STATUS } from "../config";
import { API_ACTOR, ensureVocab, findWorkOrderRef, tenantOf } from "./_shared";
import { serializeTodo, type TodoViewRow } from "../serialize/todo";

const PRIORITIES = ["none", "low", "medium", "high"];

/** Zoho-compatible urgency normalization: lower-cased, one of the four, else null. */
export function normalizeUrgency(p: string | null | undefined): string | null {
  const v = String(p ?? "").trim().toLowerCase();
  return PRIORITIES.includes(v) ? v : null;
}

function isCompletedStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "completed";
}

const TODO_COLS = [
  "id", "work_order_id", "work_order_number", "title", "status", "urgency", "assignee_name", "notes", "archived",
  "created_at", "updated_at",
] as const;

//------------------------------------------------------------------------------
// Transaction-level primitives
//------------------------------------------------------------------------------

export async function getTodoTx(tx: Tx, todoId: string): Promise<Todo | null> {
  if (!isUuid(todoId)) return null;
  const rows = await tx<TodoViewRow[]>`
    select ${tx(TODO_COLS)} from public.v_todos
    where tenant_id = public.app_tenant_id() and id = ${todoId} and deleted_at is null limit 1`;
  return rows.length ? serializeTodo(rows[0]) : null;
}

export interface TodoFilter {
  includeArchived?: boolean;
  assignee?: string;
  status?: string;
  urgency?: string;
}

/** Todos across all WOs (or one when workOrderId is given), oldest first; filters are case-insensitive exact matches. */
export async function listTodosTx(tx: Tx, opts: TodoFilter & { workOrderId?: string | null } = {}): Promise<Todo[]> {
  const eq = (v?: string) => (v ?? "").trim().toLowerCase();
  const rows = await tx<TodoViewRow[]>`
    select ${tx(TODO_COLS)} from public.v_todos t
    where t.tenant_id = public.app_tenant_id() and t.deleted_at is null
      and exists (select 1 from public.work_orders w where w.id = t.work_order_id and w.deleted_at is null)
      and (${!opts.workOrderId} or t.work_order_id = ${opts.workOrderId ?? null}::uuid)
      and (${opts.includeArchived === true} or not t.archived)
      and (${eq(opts.assignee) === ""} or lower(btrim(coalesce(t.assignee_name, ''))) = ${eq(opts.assignee)})
      and (${eq(opts.status) === ""} or lower(btrim(t.status)) = ${eq(opts.status)})
      and (${eq(opts.urgency) === ""} or lower(btrim(coalesce(t.urgency, ''))) = ${eq(opts.urgency)})
    order by t.created_at asc, t.id asc`;
  return rows.map(serializeTodo);
}

/** Insert a todo on a resolved work_orders.id. */
export async function createTodoTx(
  tx: Tx,
  workOrderId: string,
  input: CreateTodoInput,
  opts: { actor?: string } = {}
): Promise<Todo> {
  const status = input.status?.trim() || DEFAULT_TODO_STATUS;
  await ensureVocab(tx, "todo_status", status);
  const urgency = normalizeUrgency(input.priority);
  const assignee = input.assignee?.trim() || null;
  const notes = input.notes?.trim() || null;
  const rows = await tx<{ id: string }[]>`
    insert into public.todos (tenant_id, work_order_id, title, status, urgency, assignee_name, notes, closed_at)
    values (public.app_tenant_id(), ${workOrderId}, ${input.title.trim()}, ${status}, ${urgency}, ${assignee}, ${notes},
            ${isCompletedStatus(status) ? new Date() : null})
    returning id`;
  const id = rows[0].id;
  await appendEvent(tx, {
    entity: "todo",
    entityId: id,
    eventType: "todo.created",
    payload: { workOrderId, title: input.title.trim(), status, urgency, assignee, notes },
    actor: opts.actor ?? API_ACTOR,
  });
  return (await getTodoTx(tx, id))!;
}

/** Add a todo to a WO by wire id; null when the WO is unknown. */
export async function addTodoTx(tx: Tx, woWireId: string, input: CreateTodoInput): Promise<Todo | null> {
  const woId = await findWorkOrderRef(tx, woWireId);
  if (!woId) return null;
  return createTodoTx(tx, woId, input);
}

/** Patch a todo (must belong to the WO). Completed archives; any other status re-opens. Null when unknown. */
export async function updateTodoTx(
  tx: Tx,
  woWireId: string,
  todoId: string,
  patch: UpdateTodoInput,
  opts: { actor?: string } = {}
): Promise<Todo | null> {
  const woId = await findWorkOrderRef(tx, woWireId);
  if (!woId || !isUuid(todoId)) return null;
  const current = await tx<{ id: string; status: string; closed_at: Date | null }[]>`
    select id, status, closed_at from public.todos
    where tenant_id = public.app_tenant_id() and id = ${todoId} and work_order_id = ${woId} and deleted_at is null limit 1`;
  if (!current.length) return null;

  const status = patch.status !== undefined ? patch.status.trim() : current[0].status;
  if (patch.status !== undefined) await ensureVocab(tx, "todo_status", status);
  const closedAt =
    patch.status !== undefined ? (isCompletedStatus(status) ? current[0].closed_at ?? new Date() : null) : current[0].closed_at;

  await tx`
    update public.todos set
      title         = coalesce(${patch.title !== undefined ? patch.title.trim() : null}, title),
      status        = ${status},
      urgency       = case when ${patch.priority !== undefined} then ${normalizeUrgency(patch.priority)} else urgency end,
      assignee_name = case when ${patch.assignee !== undefined} then ${patch.assignee?.trim() || null} else assignee_name end,
      notes         = case when ${patch.notes !== undefined} then ${patch.notes?.trim() || null} else notes end,
      closed_at     = ${closedAt}
    where tenant_id = public.app_tenant_id() and id = ${todoId}`;
  await appendEvent(tx, {
    entity: "todo",
    entityId: todoId,
    eventType: "todo.updated",
    payload: { workOrderId: woId, patch },
    actor: opts.actor ?? API_ACTOR,
  });
  return getTodoTx(tx, todoId);
}

//------------------------------------------------------------------------------
// Public API (env-level) — used by service.ts
//------------------------------------------------------------------------------

export async function listTodos(env: Env, woWireId: string, includeArchived = false): Promise<Todo[]> {
  return withTenantRead(env, tenantOf(env), async (tx) => {
    const woId = await findWorkOrderRef(tx, woWireId);
    return woId ? listTodosTx(tx, { workOrderId: woId, includeArchived }) : [];
  });
}

export async function listAllTodos(env: Env, opts: TodoFilter = {}): Promise<Todo[]> {
  return withTenantRead(env, tenantOf(env), (tx) => listTodosTx(tx, opts));
}

export async function addTodo(env: Env, woWireId: string, input: CreateTodoInput): Promise<Todo | null> {
  return withTenant(env, tenantOf(env), (tx) => addTodoTx(tx, woWireId, input));
}

export async function updateTodo(env: Env, woWireId: string, todoId: string, patch: UpdateTodoInput): Promise<Todo | null> {
  return withTenant(env, tenantOf(env), (tx) => updateTodoTx(tx, woWireId, todoId, patch));
}
