# FHI Service Work Order — Backend (Cloudflare Worker)

Reference backend for FHI's interim **Service Work Order System**. It is the thin
integration layer between the mobile UI (added to the LV Plan / `fhi-am-analyser` app)
and the systems of record: **Zoho Projects** (the source of truth for tickets/tasks)
and **Google Calendar** (tech scheduling).

**The app calls this Worker. The phone never holds a secret** — all Zoho + Google
credentials live only in the Worker's env. Zoho stays the system of record; this
service writes to Zoho and holds no truth of its own (nothing to migrate later).

Canonical spec: `../../knowledge/service-work-order-system.md`.

---

## What it does

- **Mints the Work Order number** — a composite reference stored on the Zoho task.
- **Creates a ticket** — a Zoho task list holding an **Action** task (+ step subtasks)
  and a **Billing** task.
- **Writes notes** — the Action task's built-in `description`.
- **Reads/writes access codes** — three Zoho **project** custom fields (`gate_code`,
  `community_gate`, `door_code`); editing a code writes back to the project.
- **Schedules** — creates **one** Google Calendar event and invites techs as **guests**
  (not copies on many calendars); stores the event id on the WO.
- **Two-way calendar sync** — a cron-driven reconcile reads reschedules back; the WO
  is the tie-breaker source of truth.
- **Derives status** — Action/Billing/Completed computed from the two tasks (never stored).

---

## The Work Order number

Composite: `{projectKey}-WO-{year}-{seq4}` — e.g. **`FHI-672-WO-2026-0001`**.

| Part | Example | Source |
|------|---------|--------|
| `projectKey` | `FHI-672` | the client SERVICE project's `key` (already on every project) |
| minted `WO-{year}-{seq}` | `WO-2026-0001` | year + zero-padded sequence, **resets each January** |

- The UI shows the `FHI-###` and the `year-seq` in two fields; the **stored** reference
  is the full string, written to the Zoho task custom field named by `ZOHO_WO_FIELD`.
- **Sequence scope / pattern** are tenant settings since F3: `tenant_settings`
  `numbering.work_order = {pattern, scope, pad, yearly_reset}` (`global` = one portal-wide
  yearly counter; `per_project` = one per project key). `WO_SEQUENCE_SCOPE` is only echoed on
  `/health` — keep it in step with the setting.
- The counter is the `sequences` table, advanced atomically by `mint_public_key_parts()`
  inside the mint transaction (`src/keys.ts`, wrapped by `src/wonumber.ts`). No KV, no race.

---

## Two-way sync model

- One event per WO on a chosen calendar (default `notifications@fhiflorida.com`), techs
  as **attendees/guests**. The event id + calendar id are stored in a machine-readable
  trailer inside the Action task description (`<!-- fhi-cal:{...} -->`), and the WO number
  is stamped on the event's `extendedProperties.private.fhiWoNumber`.
- **WO edits push to the event** (PATCH re-patches start/end/attendees).
- **Calendar reschedules are read back** by `reconcileCalendar()` (cron every 10 min, or
  `POST /sync/calendar`), which lists events changed in the last ~20 min, matches them to
  WOs by event id / WO number, and mirrors the change.
- **WO is the tie-breaker.** In this interim build the schedule times live on the event, so a
  calendar reschedule is accepted and recorded. When WO-side date fields are added, compare
  timestamps in `reconcileCalendar()` and let the WO win on conflict (a `conflicts` counter
  is already in `SyncResult` for that). A Google "watch" webhook can make this near-instant later.

---

## Counter atomicity

Numbers are minted by `public.mint_public_key_parts()` with a single
`INSERT … ON CONFLICT DO UPDATE … RETURNING` on `sequences` — concurrent callers serialize on
the row lock and never receive the same number; a number is consumed only if the minting
transaction commits. (The pre-F3 KV read-modify-write and its race window are gone.)

---

## Endpoint contract

All JSON. CORS is restricted to `APP_ORIGIN`.

### `POST /work-orders`
Mint number, create ticket list + Action + Billing tasks, write WO# + notes, optionally create
the calendar event.

Request:
```json
{
  "projectId": "1234567890",
  "subject": "AC not cooling — service call",
  "notes": "Customer reports warm air. Link: https://…",
  "priority": "High",
  "steps": ["Diagnose", "Replace capacitor", "Test"],
  "schedule": {
    "calendarId": "notifications@fhiflorida.com",
    "start": "2026-08-20T14:00:00-04:00",
    "end": "2026-08-20T16:00:00-04:00",
    "attendees": ["charlie@fhiflorida.com", "ahartman@fhiflorida.com"]
  },
  "accessCodes": { "gate_code": "1234", "door_code": "5678" }
}
```
Response `201`:
```json
{
  "id": "actionTaskId",
  "workOrderNumber": "FHI-672-WO-2026-0001",
  "projectKey": "FHI-672",
  "mintedRef": "2026-0001",
  "projectId": "1234567890",
  "projectName": "Smith, John - 123 Main St - SERVICE",
  "client": "Smith, John",
  "siteAddress": "123 Main St",
  "subject": "AC not cooling — service call",
  "status": "action",
  "priority": "High",
  "taskListId": "…",
  "actionTaskId": "…",
  "billingTaskId": "…",
  "notes": "Customer reports warm air. Link: https://…",
  "accessCodes": { "gate_code": "1234", "community_gate": null, "door_code": "5678" },
  "schedule": {
    "calendarId": "notifications@fhiflorida.com",
    "eventId": "abc123",
    "start": "2026-08-20T14:00:00-04:00",
    "end": "2026-08-20T16:00:00-04:00",
    "attendees": ["charlie@fhiflorida.com", "ahartman@fhiflorida.com"],
    "htmlLink": "https://www.google.com/calendar/event?eid=…"
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

### `GET /work-orders?filter=active&q=smith&sort=newest`
- `filter`: `active` (default) | `billing` | `done` | `all`
- `q`: substring over WO#, client, address, subject
- `sort`: `newest` (default) | `oldest` | `client` | `priority`

Response `200`: `{ "count": 3, "workOrders": [ …WorkOrder… ] }`

### `GET /work-orders/:id`
`:id` = the Action task id. Returns the WorkOrder or `404`.

### `PATCH /work-orders/:id`
Any subset of:
```json
{
  "notes": "updated notes",
  "priority": "Medium",
  "status": "billing",
  "accessCodes": { "gate_code": "9999" },
  "schedule": { "start": "…", "end": "…", "attendees": ["…"] }
}
```
- `status` maps to opening/closing tasks: `action` (Action open), `billing` (Action closed,
  Billing open), `completed` (both closed).
- `accessCodes` **writes back to the project**.
- `schedule` patches the existing event (or creates one if none exists yet).

Returns the updated WorkOrder.

### WO status — Zoho-native model (2026-09-09)
The status is REAL in Zoho: three pick-list custom fields on the SERVICE task layout.

| Field | On | Values |
|---|---|---|
| `wo_cycle_status` | the per-WO **"Work Order Status"** task (created at WO create, tagged with the WO#) | Not Scheduled · Scheduled · Needs Reschedule (auto, calendar-derived) · On Hold · Active Monitoring · Ready for Billing · Waiting Payment · Closed (manual, sticky). Legacy `Completed` reads as Closed. |
| `wo_task_status` | Work Order Tasks task, its subtasks, the Billing task | Pending · Completed (the Worker also flips the native open/closed status in the same PATCH) |
| `billing_status` | the Billing task | Billable · Non-Billable · Internal (replaces the old KV `billable` flag; `billable` boolean still returned = `billingStatus === "Billable"`) |

- `PATCH /work-orders/:id { woStatus }` accepts the labels above (+ legacy `Completed` → Closed,
  `Needs Rescheduled` → Needs Reschedule). `{ billingStatus }` writes the Billing task field.
- `PATCH /work-orders/:id/tasks/:taskId { taskStatus: "Pending"|"Completed" }` → `{ workOrder,
  autoPromoted, gateMessage }`. Completing the Work Order Tasks task while the WO is pre-billing
  auto-moves it to **Ready for Billing** (regardless of billing status; items gate applies —
  a blocked move returns `gateMessage`, WO unchanged). Reopening it returns the WO to the
  calendar-driven flow. The detail read (`GET /work-orders/:id`) also promotes when it sees the
  work task Completed in Zoho while `wo_cycle_status` is still pre-billing (one write, only then).
- Close-out is the app's popup → `{ woStatus: "Closed" }` (both tasks Completed).
- WorkOrder gains `billingStatus`, `statusTaskId`, `cycleStatusRaw`, and `tasks[].taskStatus`.
- **One-time migration** for pre-existing WOs: `GET /admin/migrate-status?pin=…` (dry run, per-WO
  crosswalk) then `POST /admin/migrate-status?pin=…&apply=1&limit=15` repeatedly until
  `pending: 0` (throttle-aware; ~4 Zoho calls per WO). Crosswalk: today's status name-for-name,
  Completed → Closed; KV billable → Billable/Non-Billable; task open/closed → Pending/Completed.
  Subtask `wo_task_status` is not back-filled (native closed flag stays the fallback).

### `POST /sync/calendar`
Runs the reconcile now. Response: `{ "scanned", "reconciled", "conflicts", "details": [...] }`.
Also runs automatically via the cron trigger (every 10 min).

### `GET /health`
Liveness + config readiness (shows whether `ZOHO_WO_FIELD` is configured, the sequence scope,
Google auth method, default calendar).

---

## Error codes

| Status | Meaning |
|--------|---------|
| 400 | bad request (missing/invalid input) |
| 404 | work order / route not found |
| 405 | method not allowed |
| 501 | **not configured** — a required env value (e.g. `ZOHO_WO_FIELD`) is still `__TODO__` |
| 502 | Zoho or Google upstream error |
| 500 | unhandled error |

---

## Project layout

```
backend/
├── wrangler.toml          Worker config: Hyperdrive/R2 bindings, cron, vars/secrets docs (no KV since F3)
├── package.json           deps + scripts (dev / deploy / typecheck)
├── tsconfig.json          strict TS, Workers types
├── .dev.vars.example      every env var + placeholder (copy to .dev.vars for local dev)
├── .gitignore             keeps .dev.vars / secrets out of git
├── README.md              this file
└── src/
    ├── index.ts           router + cron handler (the only entry point)
    ├── config.ts          THE one place unknowns/knobs are resolved (WO field, scope, auth)
    ├── types.ts           Env + WorkOrder + Create/Update input types
    ├── wonumber.ts        WO number minting (Postgres sequences via keys.ts); composite-string parsing
    ├── repo/              Postgres repos (technicians, people, hours, daily-reports) — F3
    ├── status.ts          pure status derivation from the two tasks
    ├── zoho.ts            Zoho Projects v3 client (token refresh, projects, lists, tasks)
    ├── calendar.ts        Google Calendar v3 client (SA-JWT / OAuth-user; event CRUD)
    └── service.ts         orchestration: create/list/get/update/reconcile; WO assembly
```

---

## Deploy steps

```bash
# 0) install deps
npm install

# 1) log in
npx wrangler login

# 2) (no KV namespace since F3 — Postgres via the HYPERDRIVE binding; see RUNBOOK.md)

# 3) set secrets (never commit these)
npx wrangler secret put ZOHO_REFRESH_TOKEN
npx wrangler secret put ZOHO_CLIENT_ID
npx wrangler secret put ZOHO_CLIENT_SECRET
#    Google — service-account method (default):
npx wrangler secret put GOOGLE_SA_CLIENT_EMAIL
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
npx wrangler secret put GOOGLE_SA_SUBJECT
#    …or the shared-OAuth-user method instead:
# npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
# npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
# npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN

# 4) set the non-secret vars in wrangler.toml [vars] — especially ZOHO_WO_FIELD and APP_ORIGIN

# 5) typecheck + deploy
npm run typecheck
npx wrangler deploy
```

Local dev: `cp .dev.vars.example .dev.vars`, fill it in, then `npx wrangler dev`.

---

## ⚠️ BEFORE YOU DEPLOY — values a human must supply

These are the unknowns the code references via config (each marked `TODO(craig)`); the Worker
returns `501 not configured` for anything it can't safely proceed without.

1. **`ZOHO_WO_FIELD`** — the real Zoho **task** custom-field API/column name for the field
   Craig labeled "Work Orders #". This is the single value that gates WO creation. Set it in
   `wrangler.toml [vars]` (or as a var). Until then, `POST /work-orders` returns 501.
2. **Sequence scope decision** — confirm `WO_SEQUENCE_SCOPE` = `global` (assumed) vs `per_project`.
3. **Google Calendar auth method** — `service_account` (default; needs a GCP service account with
   domain-wide delegation + the SA email/key/subject secrets) **or** `oauth_user` (a single shared
   Google user's client id/secret/refresh token). Pick one and set the matching secrets.
4. **SERVICE-project match** — how to identify SERVICE projects: `name_suffix` (default, matches
   names ending in `SERVICE`), `tag` (the "SERVICE Project" tag), or `group` (the "Service Projects"
   group id). Set `ZOHO_SERVICE_MATCH_MODE` / `ZOHO_SERVICE_MATCH_VALUE` if not using the default.
5. **Tasklist / status ids** — optional `ZOHO_TASKLIST_FLAG`, `ZOHO_STATUS_OPEN_ID`,
   `ZOHO_STATUS_CLOSED_ID` if the portal requires explicit status ids rather than the completion flag.
6. **Database** — the `HYPERDRIVE` binding + `genesis_api` role password (RUNBOOK.md); no KV since F3.
7. **`APP_ORIGIN`** — the LV Plan app's origin, for CORS.
8. **Zoho v3 endpoint/field shapes** — several `TODO(craig)` markers in `src/zoho.ts` flag where the
   exact v3 path or field name (project `key`, custom-field payload shape, subtask param, task-name
   conventions "Action"/"Billing") should be confirmed against the live API. This environment has no
   egress, so none of the Zoho/Google calls were validated live.

## Technicians registry (implemented 2026-08-19)

A managed list (name + email + active) that drives the work order 'Assign technicians' pick-list;
checked techs are added as **guests** on the calendar event. No tech emails are hardcoded.

- Storage (F3): Postgres `users` + `user_roles` (role `technician`), read through `v_technicians`
  (`src/repo/technicians.ts`). Was the `WO_KV` `technicians` JSON key.
- Endpoints:
  - `GET /technicians` — list (UI pick-list + Technicians screen)
  - `POST /technicians` — add `{ name, email }`
  - `PATCH /technicians/:id` — edit / toggle `active`
- Event calendar is fixed to Tech Schedule `notifications@fhiflorida.com`.

Implemented in `src/repo/technicians.ts` (Postgres) + routed in `src/index.ts`. Starts empty — no seeds.
On `POST /work-orders`, send `technicianIds: []` (registry ids) and the backend resolves them to active
guest emails and invites them on the event. Endpoints:
- `GET /technicians` (add `?active=true` for the WO pick-list) → `{ count, technicians[] }`
- `POST /technicians` `{ name, email }` → the created technician (dupe email → 400)
- `PATCH /technicians/:id` `{ name?, email?, active? }` → updated (unknown id → 404)

## One-time Zoho setup via /setup (added 2026-08-19)

Instead of setting the three `ZOHO_*` secrets by hand, deploy the Worker then open
`https://<worker-url>/setup` in a browser. Paste your Zoho **Client ID**, **Client Secret**, and a
fresh **grant code** (Self Client → Generate Code, scopes
`ZohoProjects.portals.READ,ZohoProjects.projects.ALL,ZohoProjects.tasklists.ALL,ZohoProjects.tasks.ALL`).
The Worker exchanges the code for a refresh token and stores `{clientId, clientSecret, refreshToken}`
AES-256-GCM-encrypted in Postgres `integration_credentials` (F3; needs the `CREDS_KEY` secret — was KV
`zoho_creds`). `src/creds.ts` reads the store first, then env — so /setup fully replaces the CLI path
and overrides any stale env secrets. Lock the page after first use by setting a `SETUP_TOKEN` var.

## Tentative scheduling (added 2026-08-25)
A visit can be created as **tentative** (pending confirmation):
- `POST /work-orders/:id/visits` accepts `pending: true`. The Google event is still created on the
  Tech Schedule calendar, but its description is prefixed with a **bold `TENTATIVE — pending
  confirmation`** line. The stored `Visit` gets `confirmed: false` and `confirmTodoId`.
- On a pending create, the backend posts to the **#Scheduling** Cliq channel
  (`CLIQ_SCHEDULING_WEBHOOK`) tagging the scheduling confirmer, and auto-creates a high-priority
  "Confirm appointment" **to-do assigned to the confirmer**.
- `POST /work-orders/:id/visits/:visitId/confirm` promotes it: removes the TENTATIVE line from the
  Google event description, sets `confirmed: true`, and resolves the confirmer's to-do.
- The **scheduling confirmer** (who is tagged + assigned) is an admin-config field
  `schedulingConfirmer` (default `"Angie Hartman"`), editable via `/admin/config` — no code change
  to switch people.
- New env secret: `CLIQ_SCHEDULING_WEBHOOK` (see DEPLOY-CHECKLIST.md).
NOTE: Cliq `@mention` rendering from an incoming webhook may need a specific token format; verify
the tag renders live and adjust `schedulingConfirmer` accordingly.
