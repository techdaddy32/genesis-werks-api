-- =============================================================================
-- 0002_seed_fhi.sql — FHI tenant seed (row F1)
-- Idempotent: every insert is ON CONFLICT DO NOTHING / DO UPDATE on its natural
-- key, so re-running is safe. Values come from wrangler-vars.txt, data-model.md
-- §2.29/§2.32/§8, and the literal vocab strings in types.ts / status.ts /
-- config.ts / service.ts. Rows marked ASSUMPTION were not derivable from the
-- sources and should be confirmed by Craig.
-- =============================================================================

-- Fixed ids (stable across environments so migration scripts can reference them)
--   FHI tenant:      f4100000-0000-4000-8000-000000000001
--   default calendar f4100000-0000-4000-8000-000000000002  (Google address in external_ids)

-- Bind the transaction to the FHI tenant so RLS-restricted roles can run this too.
SELECT set_config('app.tenant_id', 'f4100000-0000-4000-8000-000000000001', false);

-- -----------------------------------------------------------------------------
-- 1. Tenant
-- -----------------------------------------------------------------------------
INSERT INTO public.tenants (id, name, slug)
VALUES ('f4100000-0000-4000-8000-000000000001', 'FHI Florida', 'fhi')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;

-- -----------------------------------------------------------------------------
-- 2. Default calendar (Google address lives in external_ids, not on the row)
-- -----------------------------------------------------------------------------
INSERT INTO public.calendars (id, tenant_id, name, is_default)
VALUES ('f4100000-0000-4000-8000-000000000002', 'f4100000-0000-4000-8000-000000000001', 'Tech Schedule', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.external_ids (tenant_id, entity, entity_id, system, external_id, synced_at)
VALUES ('f4100000-0000-4000-8000-000000000001', 'calendar', 'f4100000-0000-4000-8000-000000000002',
        'google_calendar_calendar', 'notifications@fhiflorida.com', now())
ON CONFLICT (tenant_id, system, external_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. tenant_settings
--    (secrets — CLIQ webhooks, ADMIN_PIN, Zoho/Google OAuth — are NOT seeded;
--     they go to integration_credentials / the API's env, never a migration)
-- -----------------------------------------------------------------------------
INSERT INTO public.tenant_settings (tenant_id, key, value) VALUES
  -- from wrangler-vars.txt
  ('f4100000-0000-4000-8000-000000000001', 'zoho.portal_id',              to_jsonb('705869960'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.wo_field',               to_jsonb('work_order_hash'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.status_closed_id',       to_jsonb('1545398000000616329'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.status_open_id',         to_jsonb('1545398000000120013'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.visits_field',           to_jsonb('wo_schedule'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.nextvisit_field',        to_jsonb('wo_date_time'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.schedstatus_field',      to_jsonb('wo_schedule_status'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.wo_task_status_field',   to_jsonb('wo_task_status'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.billing_status_field',   to_jsonb('billing_status'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.wo_cycle_status_field',  to_jsonb('wo_cycle_status'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.used_items_field',       to_jsonb('wo_used_items'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.todo_status_field',      to_jsonb('to_do_s'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.purchasing_project_id',  to_jsonb('1545398000015424003'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'zoho.order_status_field',     to_jsonb('order_status'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'calendar.default_id',         to_jsonb('f4100000-0000-4000-8000-000000000002'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'calendar.default_address',    to_jsonb('notifications@fhiflorida.com'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'app.origin',                  to_jsonb('https://fhi-plan-markup.onrender.com'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'app.wo_url_template',         to_jsonb('https://fhi-plan-markup.onrender.com/work-orders?id={id}'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'wo.sequence_scope',           to_jsonb('global'::text)),
  -- defaults stated in the model (§2.32) — ASSUMPTION that they still hold
  ('f4100000-0000-4000-8000-000000000001', 'app.timezone',                to_jsonb('America/New_York'::text)),
  ('f4100000-0000-4000-8000-000000000001', 'admin.report_access',         '[]'::jsonb),  -- client fills in (Setup page)
  ('f4100000-0000-4000-8000-000000000001', 'admin.zoho_user_options',     '[]'::jsonb),
  ('f4100000-0000-4000-8000-000000000001', 'admin.scheduling_confirmer',  '[]'::jsonb),  -- empty; client fills in one or more names (Setup page)
  -- numbering (§8.10). work_order = confirmed FHI default; project / deal = ASSUMPTION
  ('f4100000-0000-4000-8000-000000000001', 'numbering.work_order',
     '{"pattern":"{projectKey}-WO-{YYYY}-{seq4}","scope":"global","pad":4,"yearly_reset":true}'::jsonb),
  ('f4100000-0000-4000-8000-000000000001', 'numbering.project',
     '{"pattern":"FHI-{seq}","scope":"global","pad":0,"yearly_reset":false}'::jsonb),
  ('f4100000-0000-4000-8000-000000000001', 'numbering.deal',
     '{"pattern":"FHI-D-{seq}","scope":"global","pad":0,"yearly_reset":false}'::jsonb)
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- -----------------------------------------------------------------------------
-- 4. status_vocab — literal wire values from the code
-- -----------------------------------------------------------------------------
INSERT INTO public.status_vocab (tenant_id, domain, code, label, sort_order, is_default, is_terminal, is_auto, is_closed, meta) VALUES
  -- wo_status (service.ts WO_STATUSES, 2026-09-09): 3 auto + 5 manual/sticky, + 2 legacy aliases
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Not Scheduled',      'Not Scheduled',      10, true,  false, true,  false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Scheduled',          'Scheduled',          20, false, false, true,  false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Needs Reschedule',   'Needs Reschedule',   30, false, false, true,  false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'On Hold',            'On Hold',            40, false, false, false, false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Active Monitoring',  'Active Monitoring',  50, false, false, false, false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Ready for Billing',  'Ready for Billing',  60, false, false, false, false, '{"lifecycle":"billing"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Waiting Payment',    'Waiting Payment',    70, false, false, false, false, '{"lifecycle":"billing"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Closed',             'Closed',             80, false, true,  false, true,  '{"lifecycle":"completed"}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Completed',          'Completed (legacy)', 90, false, true,  false, true,  '{"lifecycle":"completed","alias_of":"Closed","legacy":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_status', 'Needs Rescheduled',  'Needs Rescheduled (legacy)', 91, false, false, true, false, '{"lifecycle":"action","alias_of":"Needs Reschedule","legacy":true}'),

  -- wo_lifecycle (types.ts WorkOrderStatus) — documentation domain for the derived value
  ('f4100000-0000-4000-8000-000000000001', 'wo_lifecycle', 'action',    'Action',    10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_lifecycle', 'billing',   'Billing',   20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_lifecycle', 'completed', 'Completed', 30, false, true,  false, true,  '{}'),

  -- schedule_status (types.ts ScheduleStatus) — derived, documentation domain
  ('f4100000-0000-4000-8000-000000000001', 'schedule_status', 'unscheduled',      'Not Scheduled',    10, true,  false, true, false, '{"label":"Not Scheduled"}'),
  ('f4100000-0000-4000-8000-000000000001', 'schedule_status', 'scheduled',        'Scheduled',        20, false, false, true, false, '{"label":"Scheduled"}'),
  ('f4100000-0000-4000-8000-000000000001', 'schedule_status', 'needs_reschedule', 'Needs Reschedule', 30, false, false, true, false, '{"label":"Needs Reschedule"}'),

  -- task_status (config.ts TASK_STATUSES)
  ('f4100000-0000-4000-8000-000000000001', 'task_status', 'Pending',   'Pending',   10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'task_status', 'Completed', 'Completed', 20, false, true,  false, true,  '{}'),

  -- billing_status (config.ts BILLING_STATUSES)
  ('f4100000-0000-4000-8000-000000000001', 'billing_status', 'Billable',     'Billable',     10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'billing_status', 'Non-Billable', 'Non-Billable', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'billing_status', 'Internal',     'Internal',     30, false, false, false, false, '{}'),

  -- item_status (config.ts ITEM_STATUSES + DEFAULT_DONE_STATUSES + types.ts OrderStatus legacy)
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Needed',                     'Needed',                     10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'On Order',                   'On Order',                   20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Staged',                     'Staged',                     30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Backordered',                'Backordered',                40, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Installed (From Stock)',     'Installed (From Stock)',     50, false, true,  false, true,  '{"installed":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Installed (Field Purchase)', 'Installed (Field Purchase)', 60, false, true,  false, true,  '{"installed":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Canceled',                   'Canceled',                   70, false, true,  false, true,  '{}'),
  -- legacy labels kept until the Part-5 migration re-tags
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Cancelled',                  'Cancelled (legacy)',         80, false, true,  false, true,  '{"legacy":true,"alias_of":"Canceled"}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Installed',                  'Installed (legacy)',         81, false, true,  false, true,  '{"legacy":true,"installed":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Not Needed',                 'Not Needed (legacy)',        82, false, true,  false, true,  '{"legacy":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'item_status', 'Received',                   'Received (legacy)',          83, false, false, false, false, '{"legacy":true}'),

  -- todo_status (types.ts / config.ts to_do_s)
  ('f4100000-0000-4000-8000-000000000001', 'todo_status', 'Open',              'Open',              10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'todo_status', 'Awaiting Feedback', 'Awaiting Feedback', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'todo_status', 'On-Hold',           'On-Hold',           30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'todo_status', 'Completed',         'Completed',         40, false, true,  false, true,  '{}'),

  -- wo_type (types.ts / config.ts wo_type)
  ('f4100000-0000-4000-8000-000000000001', 'wo_type', 'Service WO',    'Service WO',    10, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_type', 'Production WO', 'Production WO', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_type', 'Prewire WO',    'Prewire WO',    30, false, false, false, false, '{}'),

  -- task_priority (Zoho native priority; WO priority + todo urgency)
  ('f4100000-0000-4000-8000-000000000001', 'task_priority', 'none',   'None',   10, true,  false, false, false, '{"rank":3}'),
  ('f4100000-0000-4000-8000-000000000001', 'task_priority', 'low',    'Low',    20, false, false, false, false, '{"rank":2}'),
  ('f4100000-0000-4000-8000-000000000001', 'task_priority', 'medium', 'Medium', 30, false, false, false, false, '{"rank":1}'),
  ('f4100000-0000-4000-8000-000000000001', 'task_priority', 'high',   'High',   40, false, false, false, false, '{"rank":0}'),

  -- action_item_flag (issues.ts)
  ('f4100000-0000-4000-8000-000000000001', 'action_item_flag', 'Internal', 'Internal', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'action_item_flag', 'External', 'External', 20, false, false, false, false, '{}'),

  -- action_item_status — TENANT-WIDE (§8.7). ASSUMPTION: Zoho's per-project issue
  -- status list was not in the sources; Open/In Progress/Closed are placeholders and
  -- the migration adds the real Zoho status names as found (§8.8).
  ('f4100000-0000-4000-8000-000000000001', 'action_item_status', 'Open',        'Open',        10, true,  false, false, false, '{"assumption":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'action_item_status', 'In Progress', 'In Progress', 20, false, false, false, false, '{"assumption":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'action_item_status', 'Closed',      'Closed',      30, false, true,  false, true,  '{"assumption":true}'),

  -- forum_flag / forum_type / forum_comment_type (forums.ts)
  ('f4100000-0000-4000-8000-000000000001', 'forum_flag', 'internal', 'Internal', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'forum_flag', 'external', 'External', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'forum_type', 'normal',   'Normal',   10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'forum_type', 'question', 'Question', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'forum_comment_type', 'normal',   'Normal',   10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'forum_comment_type', 'question', 'Question', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'forum_comment_type', 'answer',   'Answer',   30, false, false, false, false, '{}'),

  -- wo_task_kind (types.ts WorkOrderTask.kind + steps)
  ('f4100000-0000-4000-8000-000000000001', 'wo_task_kind', 'work',    'Work Order Tasks', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_task_kind', 'billing', 'Billing',          20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'wo_task_kind', 'step',    'Step',             30, false, false, false, false, '{}'),

  -- membership-type (§8.4 — ONE domain). ASSUMPTION: only the two sample values are
  -- known ("Proactive", "Needs Update"); the real pick-list is harvested at migration.
  ('f4100000-0000-4000-8000-000000000001', 'membership-type', 'Proactive',    'Proactive',    10, false, false, false, false, '{"assumption":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'membership-type', 'Needs Update', 'Needs Update', 20, false, false, false, false, '{"assumption":true}'),

  -- user_role (§8.6, revised 2026-09-13): prefill technician/office/admin/sales; tenant-custom thereafter. (was: ASSUMPTION; `person` = the legacy "People"
  -- registry (to-do assignee picker), `technician` = calendar guests.
  ('f4100000-0000-4000-8000-000000000001', 'user_role', 'technician', 'Technician',                   10, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'user_role', 'office',     'Office',                       20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'user_role', 'admin',      'Admin',                        30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000001', 'user_role', 'sales',      'Sales',                        40, false, false, false, false, '{}'),
  -- Roles are tenant-custom (Craig 2026-09-13): these four are the prefill only. `homeowner` is added at P5a (portal); importers auto-create missing vocab rows.

  -- project_status / project_group / project_type — Smackdab sample values only;
  -- the full lists are harvested at migration (§8.8). ASSUMPTION.
  ('f4100000-0000-4000-8000-000000000001', 'project_status', 'Serv2 - Pending Ticket', 'Serv2 - Pending Ticket', 10, false, false, false, false, '{"assumption":true,"sample":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'project_group',  'Service Projects',       'Service Projects',       10, true,  false, false, false, '{"sample":true}'),
  ('f4100000-0000-4000-8000-000000000001', 'project_type',   'active',                 'Active',                 10, true,  false, false, false, '{"sample":true}')
ON CONFLICT (tenant_id, domain, code) DO NOTHING;

-- deal_stage, deal_type, lead_source, lead_type: intentionally EMPTY — no
-- option lists were in the sources; §8.8 says harvest at migration. NOTE: the
-- vocab trigger will reject a contact/deal whose value is not yet a row, so the
-- migration must INSERT the harvested vocab rows BEFORE the CRM rows.

-- -----------------------------------------------------------------------------
-- 5. field_definitions — seeded EMPTY. Shape for reference:
--
-- INSERT INTO public.field_definitions
--   (tenant_id, entity, key, label, type, options, required, sort_order, visible, group_name, help_text)
-- VALUES
--   ('f4100000-0000-4000-8000-000000000001', 'work_orders', 'lockbox_code', 'Lockbox code',
--    'text', '[]', false, 10, true, 'Site access', 'Shown to techs on the WO detail'),
--   ('f4100000-0000-4000-8000-000000000001', 'contacts', 'preferred_contact_method', 'Preferred contact',
--    'picklist', '["Call","Text","Email"]', false, 20, true, 'Communication', NULL);
--
-- Values are written by genesis-api into <table>.custom -> 'lockbox_code' etc.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- End of 0002_seed_fhi.sql
-- =============================================================================
