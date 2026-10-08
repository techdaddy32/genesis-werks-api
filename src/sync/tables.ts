// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W3 · run: run-2026-10-07-drawing-layer-05 · 2026-10-07 — rule-hook contract widened (rowClass / redirect fields / extra); hooks registered by sync/layers.ts
//==============================================================================
// sync/tables.ts — the /sync/push allow-list: which tables a device may push,
// which columns it may write, which columns are FK parents (unknown_parent
// checks), how each table resolves its PROJECT (the spine) and its ROOM, and
// its row CLASS (structure vs capture — walk spec §5.2).
//
// Every table here carries the uniform sync set (walk spec §5.1 / 001 §5):
//   organization_id, revision, occurred_at, received_at, device_id, created_by,
//   walk_id, captured_revision, deleted_at, deleted_by
// Source of truth for the column lists: work/migrations 002/030/035/036/040
// (test/sync/registry.test.ts asserts every column here exists in the live schema).
//
// PER-TABLE RULE HOOK (`rules`): W1 left it EMPTY for every table. Row W3 (sync/layers.ts)
// registers the layer-governance hooks for drawings.annotations (redirect-never-reject,
// class stamp, immutable_class) and drawings.layers (template validation). A hook runs
// AFTER parent-exists and BEFORE the generic class rules, so it may decide the row's class
// (annotations: copied from the landing layer). The hook may ONLY redirect / amend the row
// or return one of the reasons in REJECTION_REASONS — there is no layer-based rejection
// reason anywhere.
//==============================================================================

import type { Tx } from "../org-context";

/** Schema-qualified names, exactly as the device sends them in rows[].table. */
export const SYNC_TABLES = [
  "places.walks",
  "places.rooms",
  "places.locations",
  "places.device_placements",
  "places.location_notes",
  "places.location_media",
  "places.wire_runs",
  "places.room_polygons",
  "places.location_placements",
  "drawings.drawings",
  "drawings.pages",
  "drawings.layers",
  "drawings.annotations",
  "shared.files",
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export function isSyncTable(t: unknown): t is SyncTable {
  return typeof t === "string" && (SYNC_TABLES as readonly string[]).includes(t);
}

/** places.sync_rejections.reason CHECK (036) — verbatim. NEVER add a layer-based reason. */
export const REJECTION_REASONS = [
  "no_checkout",
  "checkout_expired",
  "not_row_owner",
  "actor_revoked",
  "unknown_parent",
  "stale_revision",
  "stale_tombstone",
  "immutable_class",
  "schema",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** places.structure_changes.change_kind CHECK (036) — verbatim. */
export type ChangeKind = "created" | "updated" | "tombstoned" | "stale_capture" | "room_hint_pending" | "annotation";

export type RowClass = "structure" | "capture";

/** The sync-set columns a device may send (received_at is always server-stamped). */
export const SYNC_SET_COLUMNS = [
  "organization_id",
  "revision",
  "occurred_at",
  "device_id",
  "created_by",
  "walk_id",
  "captured_revision",
  "deleted_at",
  "deleted_by",
] as const;

/** FK parents by column name → target table (all RLS-scoped; checked in-org). members.* are NOT FK'd by design (002). */
export const PARENT_TARGETS: Record<string, string> = {
  project_id: "shared.projects",
  account_id: "shared.accounts",
  room_id: "places.rooms",
  location_id: "places.locations",
  walk_id: "places.walks",
  file_id: "shared.files",
  preview_file_id: "shared.files",
  drawing_id: "drawings.drawings",
  drawing_version_id: "drawings.drawing_versions",
  page_id: "drawings.pages",
  layer_id: "drawings.layers",
  template_id: "drawings.layer_templates",
  replaced_placement_id: "places.device_placements",
};

export type JsonRow = Record<string, unknown>;

export interface RuleHookInput {
  tx: Tx;
  table: SyncTable;
  /** The device's allow-listed columns (new or changed). */
  row: JsonRow;
  existing: JsonRow | null;
  actorId: string;
  role: string;
  isAdmin: boolean;
  projectId: string | null;
}
export type RuleHookResult =
  | {
      kind: "ok";
      row: JsonRow;
      /** Server-owned columns to write alongside the row (e.g. redirected_from_layer_id). */
      extra?: JsonRow;
      /** The class the generic rules + events + structure_changes use (annotations: the landing layer's). */
      rowClass?: RowClass;
      /** Drawing the row belongs to (for structure_changes.drawing_id when the row has no drawing_id column). */
      drawingId?: string | null;
      redirected?: boolean;
      redirectedTo?: string;
      redirectReason?: "locked" | "policy";
    }
  | { kind: "reject"; reason: RejectionReason; detail?: string };
/** Per-table rule hook (W3: sync/layers.ts). Runs after parent-exists, BEFORE the generic class rules and the upsert. */
export type RuleHook = (input: RuleHookInput) => Promise<RuleHookResult>;

export interface TableSpec {
  /** Columns the device may write besides id + the sync set. */
  columns: readonly string[];
  /** How a row's PROJECT is found (the spine): its own column, or via a drawing/page parent. */
  project: "column" | "via_drawing" | "via_page" | "none";
  /** Column used to group review rows by room; "self" = the row IS the room. */
  room: "self" | "room_id" | "none";
  /** Static class, or decided per row (device_placements by capture_kind). */
  classify: (row: JsonRow) => RowClass;
  /** Event verb for an accepted row (payload carries op + class). */
  eventType: (row: JsonRow, op: "created" | "updated" | "tombstoned") => string;
  rules?: RuleHook;
}

const structure = () => "structure" as const;
const capture = () => "capture" as const;

export const TABLE_SPECS: Record<SyncTable, TableSpec> = {
  "places.walks": {
    columns: ["account_id", "project_id", "status", "label", "address_hint", "started_at", "ended_at", "checked_out_revision", "custom"],
    project: "column",
    room: "none",
    classify: capture,
    eventType: (_r, op) => (op === "created" ? "walk.started" : op === "tombstoned" ? "walk.tombstoned" : "walk.updated"),
  },
  "places.rooms": {
    columns: ["account_id", "project_id", "name", "room_type", "level", "sort_order", "custom"],
    project: "column",
    room: "self",
    classify: structure,
    eventType: () => "structure.changed",
  },
  "places.locations": {
    columns: ["account_id", "project_id", "room_id", "label", "sort_order", "custom"],
    project: "column",
    room: "room_id",
    classify: structure,
    eventType: () => "structure.changed",
  },
  "places.device_placements": {
    columns: [
      "account_id", "project_id", "location_id", "location_hint", "room_id", "room_hint", "capture_kind",
      "product_name", "product_sku", "catalog_key", "placement_status", "phase", "replaced_placement_id", "custom",
    ],
    project: "column",
    room: "room_id",
    classify: (row) => (row.capture_kind === "as_walked" ? "capture" : "structure"),
    eventType: (row) => (row.capture_kind === "as_walked" ? "placement.as_walked" : "structure.changed"),
  },
  "places.location_notes": {
    columns: ["account_id", "project_id", "room_id", "room_hint", "location_id", "location_hint", "kind", "phase", "note_layer", "body", "custom"],
    project: "column",
    room: "room_id",
    classify: capture,
    eventType: (row) => (row.kind === "flag" ? "capture.flagged" : "capture.synced"),
  },
  "places.location_media": {
    columns: ["account_id", "project_id", "room_id", "room_hint", "location_id", "location_hint", "file_id", "phase", "caption", "custom"],
    project: "column",
    room: "room_id",
    classify: capture,
    eventType: () => "capture.synced",
  },
  "places.wire_runs": {
    columns: [
      "account_id", "project_id", "from_schema", "from_table", "from_id", "to_schema", "to_table", "to_id",
      "run_kind", "cable_type", "label_text", "length_ft", "phase", "status", "custom",
    ],
    project: "column",
    room: "none",
    classify: structure, // walk spec §5.2 row classes: wire_runs is STRUCTURE
    eventType: () => "structure.changed",
  },
  "places.room_polygons": {
    columns: ["account_id", "project_id", "drawing_id", "drawing_version_id", "page_id", "room_id", "room_hint", "polygon", "metadata"],
    project: "column",
    room: "room_id",
    classify: structure,
    eventType: () => "structure.changed",
  },
  "places.location_placements": {
    columns: [
      "account_id", "project_id", "drawing_id", "drawing_version_id", "page_id", "location_id", "location_hint",
      "room_id", "room_hint", "x", "y", "rotation", "symbol_key", "label_text", "metadata",
    ],
    project: "column",
    room: "room_id",
    classify: structure,
    eventType: () => "structure.changed",
  },
  "drawings.drawings": {
    // attached_at/attached_by/detached_at are server-stamped (attach/detach/move are Worker acts, spec §5.2)
    columns: ["kind", "project_id", "account_id", "working_title", "address_hint", "custom"],
    project: "column",
    room: "none",
    classify: structure,
    eventType: (_r, op) => (op === "created" ? "drawing.created" : "structure.changed"),
  },
  "drawings.pages": {
    columns: ["drawing_id", "drawing_version_id", "ordinal", "name", "orientation", "preview_file_id", "source_page_no", "room_id", "room_hint", "custom"],
    project: "via_drawing",
    room: "room_id",
    classify: structure,
    eventType: () => "structure.changed",
  },
  "drawings.layers": {
    // locked / locked_by / locked_at are R-lock (row W3: office/admin act + layer.locked event) — not device-writable here
    columns: ["drawing_id", "template_id", "name", "ordinal", "class", "write_policy", "export", "color_hint"],
    project: "via_drawing",
    room: "none",
    classify: structure,
    eventType: () => "structure.changed",
  },
  "drawings.annotations": {
    // redirected_from_layer_id / moved_to_id are server-only (W3 / W4). class: COPIED from the landing layer by the
    // annotations hook (sync/layers.ts), stamped once; an UPDATE that changes it is 'immutable_class'.
    columns: ["page_id", "layer_id", "kind", "class", "geometry", "style", "label", "z", "room_id", "room_hint", "location_id", "file_id", "callout_no", "checked", "custom"],
    project: "via_page",
    room: "room_id",
    // Fallback only (the hook's rowClass wins): the STORED class on an existing row, else capture.
    classify: (row) => (row.class === "structure" ? "structure" : "capture"),
    eventType: () => "annotation.synced",
  },
  "shared.files": {
    // storage_key is server-set (<org>/<id>, CHECK-enforced); upload_status is monotone and server-owned (pending on create)
    columns: ["account_id", "project_id", "kind", "filename", "content_type", "byte_size", "sha256", "custom"],
    project: "column",
    room: "none",
    classify: capture,
    eventType: (_r, op) => (op === "created" ? "file.created" : "file.updated"),
  },
};

/** Register (or replace) the per-table rule hook — sync/layers.ts (W3) calls this for drawings.annotations and drawings.layers. */
export function setTableRuleHook(table: SyncTable, hook: RuleHook | undefined): void {
  TABLE_SPECS[table].rules = hook;
}
