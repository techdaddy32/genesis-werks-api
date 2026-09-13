-- =============================================================================
-- 0003_seed_sandbox.sql — the "Genesis Sandbox" tenant (row SB1)
--
-- A SECOND tenant, fully fictional, so Craig can play in a stand-alone Genesis
-- Werks UI before any real data is imported. Every row here carries the fixed
-- sandbox tenant uuid; nothing touches the FHI tenant (or any other), so this
-- file is safe to apply to production — it only adds the sandbox.
--
--   tenant  f4100000-0000-4000-8000-000000000002   slug `sandbox`   "Genesis Sandbox"
--
-- Idempotent: tenant / settings / vocab / field_definitions / sequences upsert
-- on their natural keys; the domain data (users … events) is inserted ONCE —
-- the block returns early when the sandbox already has work orders. Wipe +
-- reseed with `npx tsx scripts/reset-sandbox.ts`.
--
-- Atomic: the domain data is one DO block (= one statement), so a failure
-- leaves nothing behind. Dates are RELATIVE TO now() so the board always looks
-- current (some overdue, some today, some next week). Runs as postgres/service
-- role (RLS bypassed) or as a bound role (app.tenant_id is set below).
--
-- People, streets and companies are invented. Central-Florida city names and
-- zip codes are real places; nothing else is.
-- =============================================================================

SELECT set_config('app.tenant_id', 'f4100000-0000-4000-8000-000000000002', false);

-- Deterministic ids: sbid(entity, n) → f420<entity hex4>-0000-4000-8000-<n hex12>
-- (valid v4-shaped uuids, stable across environments). Temp schema: gone at
-- session end, never part of the schema.
CREATE OR REPLACE FUNCTION pg_temp.sbid(e int, n int)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('f420' || lpad(to_hex(e), 4, '0') || '-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid
$$;

-- -----------------------------------------------------------------------------
-- 1. Tenant
-- -----------------------------------------------------------------------------
INSERT INTO public.tenants (id, name, slug)
VALUES ('f4100000-0000-4000-8000-000000000002', 'Genesis Sandbox', 'sandbox')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;

-- -----------------------------------------------------------------------------
-- 2. tenant_settings — same keys as the FHI seed, sandbox values. No calendar
--    (visits carry calendar_id NULL; the serializer supplies the default shape),
--    no zoho.* (nothing to sync), admin.* empty.
-- -----------------------------------------------------------------------------
INSERT INTO public.tenant_settings (tenant_id, key, value) VALUES
  ('f4100000-0000-4000-8000-000000000002', 'app.origin',                 to_jsonb('https://genesis-sandbox.pages.dev'::text)),
  ('f4100000-0000-4000-8000-000000000002', 'app.wo_url_template',        to_jsonb('https://genesis-sandbox.pages.dev/work-orders?id={id}'::text)),
  ('f4100000-0000-4000-8000-000000000002', 'app.timezone',               to_jsonb('America/New_York'::text)),
  ('f4100000-0000-4000-8000-000000000002', 'wo.sequence_scope',          to_jsonb('global'::text)),
  ('f4100000-0000-4000-8000-000000000002', 'admin.report_access',        '[]'::jsonb),
  ('f4100000-0000-4000-8000-000000000002', 'admin.zoho_user_options',    '[]'::jsonb),
  ('f4100000-0000-4000-8000-000000000002', 'admin.scheduling_confirmer', '[]'::jsonb),
  ('f4100000-0000-4000-8000-000000000002', 'numbering.work_order',
     '{"pattern":"{projectKey}-WO-{YYYY}-{seq4}","scope":"global","pad":4,"yearly_reset":true}'::jsonb),
  ('f4100000-0000-4000-8000-000000000002', 'numbering.project',
     '{"pattern":"GS-{seq}","scope":"global","pad":0,"yearly_reset":false}'::jsonb),
  ('f4100000-0000-4000-8000-000000000002', 'numbering.deal',
     '{"pattern":"GS-D-{seq}","scope":"global","pad":0,"yearly_reset":false}'::jsonb)
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. status_vocab — every FHI domain (0002) copied literally, plus the sandbox
--    membership levels, a 4-state action_item_status, and the CRM pick-lists
--    (deal_stage / lead_source / deal_type / lead_type) that FHI leaves empty
--    until harvested. Vocab must exist BEFORE any status-bearing row (trg_vocab).
-- -----------------------------------------------------------------------------
INSERT INTO public.status_vocab (tenant_id, domain, code, label, sort_order, is_default, is_terminal, is_auto, is_closed, meta) VALUES
  -- wo_status: 3 auto + 5 manual/sticky, + 2 legacy aliases (as FHI)
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Not Scheduled',      'Not Scheduled',      10, true,  false, true,  false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Scheduled',          'Scheduled',          20, false, false, true,  false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Needs Reschedule',   'Needs Reschedule',   30, false, false, true,  false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'On Hold',            'On Hold',            40, false, false, false, false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Active Monitoring',  'Active Monitoring',  50, false, false, false, false, '{"lifecycle":"action"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Ready for Billing',  'Ready for Billing',  60, false, false, false, false, '{"lifecycle":"billing"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Waiting Payment',    'Waiting Payment',    70, false, false, false, false, '{"lifecycle":"billing"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Closed',             'Closed',             80, false, true,  false, true,  '{"lifecycle":"completed"}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Completed',          'Completed (legacy)', 90, false, true,  false, true,  '{"lifecycle":"completed","alias_of":"Closed","legacy":true}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_status', 'Needs Rescheduled',  'Needs Rescheduled (legacy)', 91, false, false, true, false, '{"lifecycle":"action","alias_of":"Needs Reschedule","legacy":true}'),

  ('f4100000-0000-4000-8000-000000000002', 'wo_lifecycle', 'action',    'Action',    10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_lifecycle', 'billing',   'Billing',   20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_lifecycle', 'completed', 'Completed', 30, false, true,  false, true,  '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'schedule_status', 'unscheduled',      'Not Scheduled',    10, true,  false, true, false, '{"label":"Not Scheduled"}'),
  ('f4100000-0000-4000-8000-000000000002', 'schedule_status', 'scheduled',        'Scheduled',        20, false, false, true, false, '{"label":"Scheduled"}'),
  ('f4100000-0000-4000-8000-000000000002', 'schedule_status', 'needs_reschedule', 'Needs Reschedule', 30, false, false, true, false, '{"label":"Needs Reschedule"}'),

  ('f4100000-0000-4000-8000-000000000002', 'task_status', 'Pending',   'Pending',   10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'task_status', 'Completed', 'Completed', 20, false, true,  false, true,  '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'billing_status', 'Billable',     'Billable',     10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'billing_status', 'Non-Billable', 'Non-Billable', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'billing_status', 'Internal',     'Internal',     30, false, false, false, false, '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Needed',                     'Needed',                     10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'On Order',                   'On Order',                   20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Staged',                     'Staged',                     30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Backordered',                'Backordered',                40, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Installed (From Stock)',     'Installed (From Stock)',     50, false, true,  false, true,  '{"installed":true}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Installed (Field Purchase)', 'Installed (Field Purchase)', 60, false, true,  false, true,  '{"installed":true}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Canceled',                   'Canceled',                   70, false, true,  false, true,  '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Cancelled',                  'Cancelled (legacy)',         80, false, true,  false, true,  '{"legacy":true,"alias_of":"Canceled"}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Installed',                  'Installed (legacy)',         81, false, true,  false, true,  '{"legacy":true,"installed":true}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Not Needed',                 'Not Needed (legacy)',        82, false, true,  false, true,  '{"legacy":true}'),
  ('f4100000-0000-4000-8000-000000000002', 'item_status', 'Received',                   'Received (legacy)',          83, false, false, false, false, '{"legacy":true}'),

  ('f4100000-0000-4000-8000-000000000002', 'todo_status', 'Open',              'Open',              10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'todo_status', 'Awaiting Feedback', 'Awaiting Feedback', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'todo_status', 'On-Hold',           'On-Hold',           30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'todo_status', 'Completed',         'Completed',         40, false, true,  false, true,  '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'wo_type', 'Service WO',    'Service WO',    10, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_type', 'Production WO', 'Production WO', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_type', 'Prewire WO',    'Prewire WO',    30, false, false, false, false, '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'task_priority', 'none',   'None',   10, true,  false, false, false, '{"rank":3}'),
  ('f4100000-0000-4000-8000-000000000002', 'task_priority', 'low',    'Low',    20, false, false, false, false, '{"rank":2}'),
  ('f4100000-0000-4000-8000-000000000002', 'task_priority', 'medium', 'Medium', 30, false, false, false, false, '{"rank":1}'),
  ('f4100000-0000-4000-8000-000000000002', 'task_priority', 'high',   'High',   40, false, false, false, false, '{"rank":0}'),

  ('f4100000-0000-4000-8000-000000000002', 'action_item_flag', 'Internal', 'Internal', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'action_item_flag', 'External', 'External', 20, false, false, false, false, '{}'),

  -- action_item_status: sandbox 4-state list
  ('f4100000-0000-4000-8000-000000000002', 'action_item_status', 'Open',        'Open',        10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'action_item_status', 'In Progress', 'In Progress', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'action_item_status', 'Waiting',     'Waiting',     30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'action_item_status', 'Closed',      'Closed',      40, false, true,  false, true,  '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'forum_flag', 'internal', 'Internal', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'forum_flag', 'external', 'External', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'forum_type', 'normal',   'Normal',   10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'forum_type', 'question', 'Question', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'forum_comment_type', 'normal',   'Normal',   10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'forum_comment_type', 'question', 'Question', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'forum_comment_type', 'answer',   'Answer',   30, false, false, false, false, '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'wo_task_kind', 'work',    'Work Order Tasks', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_task_kind', 'billing', 'Billing',          20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'wo_task_kind', 'step',    'Step',             30, false, false, false, false, '{}'),

  -- membership-type: the sandbox tiers
  ('f4100000-0000-4000-8000-000000000002', 'membership-type', 'Essential', 'Essential', 10, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'membership-type', 'Preferred', 'Preferred', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'membership-type', 'Elite',     'Elite',     30, false, false, false, false, '{}'),

  ('f4100000-0000-4000-8000-000000000002', 'user_role', 'technician', 'Technician', 10, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'user_role', 'office',     'Office',     20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'user_role', 'admin',      'Admin',      30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'user_role', 'sales',      'Sales',      40, false, false, false, false, '{}'),

  -- project_status / project_group / project_type: sandbox lists
  ('f4100000-0000-4000-8000-000000000002', 'project_status', 'Active',    'Active',    10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'project_status', 'On Hold',   'On Hold',   20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'project_status', 'Complete',  'Complete',  30, false, true,  false, true,  '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'project_group',  'Service Projects', 'Service Projects', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'project_group',  'New Construction', 'New Construction', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'project_type',   'active',    'Active',    10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'project_type',   'inactive',  'Inactive',  20, false, false, false, false, '{}'),

  -- CRM pick-lists (empty for FHI until harvested; the sandbox needs them for deals/contacts)
  ('f4100000-0000-4000-8000-000000000002', 'deal_stage', 'Lead',      'Lead',      10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_stage', 'Qualified', 'Qualified', 20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_stage', 'Proposal',  'Proposal',  30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_stage', 'Won',       'Won',       40, false, true,  false, true,  '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_stage', 'Lost',      'Lost',      50, false, true,  false, true,  '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'lead_source', 'Referral', 'Referral', 10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'lead_source', 'Website',  'Website',  20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'lead_source', 'Builder',  'Builder',  30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_type', 'New Construction', 'New Construction', 10, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_type', 'Retrofit',         'Retrofit',         20, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'deal_type', 'Service',          'Service',          30, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'lead_type', 'Homeowner',        'Homeowner',        10, true,  false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'lead_type', 'Builder',          'Builder',          20, false, false, false, false, '{}'),
  ('f4100000-0000-4000-8000-000000000002', 'lead_type', 'Property Manager', 'Property Manager', 30, false, false, false, false, '{}')
ON CONFLICT (tenant_id, domain, code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. field_definitions — three custom fields to exercise `custom` end to end
-- -----------------------------------------------------------------------------
INSERT INTO public.field_definitions
  (tenant_id, entity, key, label, type, options, required, sort_order, visible, group_name, help_text)
VALUES
  ('f4100000-0000-4000-8000-000000000002', 'work_orders', 'po_number', 'PO number', 'text', '[]', false, 10, true, 'Billing', 'Client purchase-order number, printed on the invoice'),
  ('f4100000-0000-4000-8000-000000000002', 'work_orders', 'warranty',  'Warranty',  'picklist', '["Yes","No","Partial"]', false, 20, true, 'Billing', 'Is this visit covered by a warranty?'),
  ('f4100000-0000-4000-8000-000000000002', 'contacts', 'preferred_contact', 'Preferred contact', 'picklist', '["Phone","Email","Text"]', false, 10, true, 'Communication', NULL)
ON CONFLICT (tenant_id, entity, key) DO UPDATE
  SET label = EXCLUDED.label, type = EXCLUDED.type, options = EXCLUDED.options, group_name = EXCLUDED.group_name, help_text = EXCLUDED.help_text;

-- -----------------------------------------------------------------------------
-- 5. Domain data — ONE atomic block, inserted once.
--    Entity codes for pg_temp.sbid(): 1 users · 2 accounts · 3 contacts · 4 deals ·
--    5 projects · 6 work_orders · 7 wo_tasks (n = work, 100+n = billing, 200+ = steps) ·
--    8 visits · 9 items · 10 daily_reports · 11 action_items · 12 reminders ·
--    13 forum_categories · 14 forums · 15 files · 16 todos · 17 materials
-- -----------------------------------------------------------------------------
DO $seed$
DECLARE
  t      constant uuid := 'f4100000-0000-4000-8000-000000000002';
  v_now  timestamptz := now();
  v_tz   constant text := 'America/New_York';
  v_year int;
  -- 09:00 local today, as timestamptz (visits are placed at clean hours relative to this)
  d0     timestamptz;
  -- people
  u_marcus uuid := pg_temp.sbid(1, 1);
  u_dana   uuid := pg_temp.sbid(1, 2);
  u_tyler  uuid := pg_temp.sbid(1, 3);
  u_priya  uuid := pg_temp.sbid(1, 4);
  u_jordan uuid := pg_temp.sbid(1, 5);
  u_renee  uuid := pg_temp.sbid(1, 6);
  u_sam    uuid := pg_temp.sbid(1, 7);
  u_alex   uuid := pg_temp.sbid(1, 8);
  u_chris  uuid := pg_temp.sbid(1, 9);
  e_marcus constant text := 'marcus.reyes@genesis-sandbox.example';
  e_dana   constant text := 'dana.whitfield@genesis-sandbox.example';
  e_tyler  constant text := 'tyler.brooks@genesis-sandbox.example';
  e_priya  constant text := 'priya.natarajan@genesis-sandbox.example';
  e_jordan constant text := 'jordan.ellis@genesis-sandbox.example';
  -- projects
  p101 uuid := pg_temp.sbid(5, 101);
  p102 uuid := pg_temp.sbid(5, 102);
  p103 uuid := pg_temp.sbid(5, 103);
  p104 uuid := pg_temp.sbid(5, 104);
  p105 uuid := pg_temp.sbid(5, 105);
  p106 uuid := pg_temp.sbid(5, 106);
  p107 uuid := pg_temp.sbid(5, 107);
  p108 uuid := pg_temp.sbid(5, 108);
  r    record;
BEGIN
  v_year := extract(year FROM (v_now AT TIME ZONE v_tz))::int;
  d0     := (date_trunc('day', v_now AT TIME ZONE v_tz) + interval '9 hours') AT TIME ZONE v_tz;

  -- sequences: keep live counters at least past the seeded numbers (never move them back)
  INSERT INTO public.sequences AS s (tenant_id, kind, scope_key, year, next) VALUES
    (t, 'work_order', 'global', v_year, 26),
    (t, 'project',    'global', 0,      109),
    (t, 'deal',       'global', 0,      6)
  ON CONFLICT (tenant_id, kind, scope_key, year) DO UPDATE
    SET next = greatest(s.next, EXCLUDED.next), updated_at = now();

  IF EXISTS (SELECT 1 FROM public.work_orders WHERE tenant_id = t) THEN
    RAISE NOTICE '0003_seed_sandbox: sandbox already has data — domain rows left as they are (run scripts/reset-sandbox.ts to wipe + reseed)';
    RETURN;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Users (5 technicians, 2 office, 1 admin, 1 sales) + roles
  -- ---------------------------------------------------------------------------
  INSERT INTO public.users (id, tenant_id, name, email, active) VALUES
    (u_marcus, t, 'Marcus Reyes',    e_marcus, true),
    (u_dana,   t, 'Dana Whitfield',  e_dana,   true),
    (u_tyler,  t, 'Tyler Brooks',    e_tyler,  true),
    (u_priya,  t, 'Priya Natarajan', e_priya,  true),
    (u_jordan, t, 'Jordan Ellis',    e_jordan, true),
    (u_renee,  t, 'Renee Castillo',  'renee.castillo@genesis-sandbox.example', true),
    (u_sam,    t, 'Sam Okafor',      'sam.okafor@genesis-sandbox.example',     true),
    (u_alex,   t, 'Alex Morgan',     'alex.morgan@genesis-sandbox.example',    true),
    (u_chris,  t, 'Chris Delgado',   'chris.delgado@genesis-sandbox.example',  true);

  INSERT INTO public.user_roles (tenant_id, user_id, role) VALUES
    (t, u_marcus, 'technician'), (t, u_dana, 'technician'), (t, u_tyler, 'technician'),
    (t, u_priya, 'technician'), (t, u_jordan, 'technician'),
    (t, u_renee, 'office'), (t, u_sam, 'office'),
    (t, u_alex, 'admin'),
    (t, u_chris, 'sales');

  -- ---------------------------------------------------------------------------
  -- CRM: accounts (6), contacts (12), deals (5)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.accounts (id, tenant_id, name, owner_user_id, custom) VALUES
    (pg_temp.sbid(2, 1), t, 'Okonkwo Residence',            u_chris, '{}'),
    (pg_temp.sbid(2, 2), t, 'Bellamy Residence',            u_chris, '{}'),
    (pg_temp.sbid(2, 3), t, 'Vance-Whitmore Residence',     u_chris, '{}'),
    (pg_temp.sbid(2, 4), t, 'Sandpiper Property Management', u_alex, '{"segment":"multi-unit"}'),
    (pg_temp.sbid(2, 5), t, 'Lakeshore Custom Homes',       u_chris, '{"segment":"builder"}'),
    (pg_temp.sbid(2, 6), t, 'Crestview Builders',           u_chris, '{"segment":"builder"}');

  INSERT INTO public.contacts (id, tenant_id, owner_user_id, first_name, last_name, full_name, account_id, email, phone, mobile,
                               mailing_street, mailing_city, mailing_state, mailing_zip, lead_source, lead_type, title, company, custom) VALUES
    (pg_temp.sbid(3, 1),  t, u_chris, 'Daniel',  'Okonkwo',   'Daniel Okonkwo',   pg_temp.sbid(2, 1), 'daniel.okonkwo@example.net',  '407-555-0141', '407-555-0142', '1427 Heron Marsh Ln',        'Winter Garden', 'FL', '34787', 'Referral', 'Homeowner', NULL, NULL, '{"preferred_contact":"Text"}'),
    (pg_temp.sbid(3, 2),  t, u_chris, 'Amara',   'Okonkwo',   'Amara Okonkwo',    pg_temp.sbid(2, 1), 'amara.okonkwo@example.net',   NULL,           '407-555-0143', '1427 Heron Marsh Ln',        'Winter Garden', 'FL', '34787', 'Referral', 'Homeowner', NULL, NULL, '{"preferred_contact":"Email"}'),
    (pg_temp.sbid(3, 3),  t, u_chris, 'Grace',   'Bellamy',   'Grace Bellamy',    pg_temp.sbid(2, 2), 'grace.bellamy@example.net',   '321-555-0177', NULL,           '88 Sawgrass Bend Ct',        'Lake Mary',     'FL', '32746', 'Website',  'Homeowner', NULL, NULL, '{"preferred_contact":"Phone"}'),
    (pg_temp.sbid(3, 4),  t, u_chris, 'Robert',  'Vance',     'Robert Vance',     pg_temp.sbid(2, 3), 'rvance@example.net',          NULL,           '407-555-0188', '3105 Cypress Hollow Dr',     'Windermere',    'FL', '34786', 'Referral', 'Homeowner', NULL, NULL, '{"preferred_contact":"Text"}'),
    (pg_temp.sbid(3, 5),  t, u_chris, 'Ellen',   'Whitmore',  'Ellen Whitmore',   pg_temp.sbid(2, 3), 'ellen.whitmore@example.net',  NULL,           '407-555-0189', '3105 Cypress Hollow Dr',     'Windermere',    'FL', '34786', 'Referral', 'Homeowner', NULL, NULL, '{}'),
    (pg_temp.sbid(3, 6),  t, u_alex,  'Monica',  'Tran',      'Monica Tran',      pg_temp.sbid(2, 4), 'mtran@sandpiper-pm.example',  '352-555-0120', '352-555-0121', '610 Tidewater Loop',         'Clermont',      'FL', '34711', 'Website',  'Property Manager', 'Property Manager', 'Sandpiper Property Management', '{"preferred_contact":"Email"}'),
    (pg_temp.sbid(3, 7),  t, u_alex,  'Luis',    'Herrera',   'Luis Herrera',     pg_temp.sbid(2, 4), 'lherrera@sandpiper-pm.example', '352-555-0122', NULL,         '610 Tidewater Loop',         'Clermont',      'FL', '34711', 'Website',  'Property Manager', 'Maintenance Lead', 'Sandpiper Property Management', '{}'),
    (pg_temp.sbid(3, 8),  t, u_chris, 'Kevin',   'Marsh',     'Kevin Marsh',      pg_temp.sbid(2, 5), 'kevin@lakeshore-homes.example', '407-555-0150', '407-555-0151', '2200 Alafaya Woods Blvd',  'Oviedo',        'FL', '32765', 'Builder',  'Builder', 'Project Manager', 'Lakeshore Custom Homes', '{"preferred_contact":"Phone"}'),
    (pg_temp.sbid(3, 9),  t, u_chris, 'Beth',    'Sandoval',  'Beth Sandoval',    pg_temp.sbid(2, 5), 'beth@lakeshore-homes.example',  '407-555-0152', NULL,          '2200 Alafaya Woods Blvd',  'Oviedo',        'FL', '32765', 'Builder',  'Builder', 'Superintendent', 'Lakeshore Custom Homes', '{}'),
    (pg_temp.sbid(3, 10), t, u_chris, 'Paul',    'Harrington','Paul Harrington',  NULL,               'paul.harrington@example.net', '407-555-0166', NULL,           '2290 Pelican Cove Way',      'Winter Park',   'FL', '32789', 'Referral', 'Homeowner', NULL, NULL, '{"preferred_contact":"Phone"}'),
    (pg_temp.sbid(3, 11), t, u_chris, 'Simone',  'Delacroix', 'Simone Delacroix', NULL,               'simone.delacroix@example.net', NULL,          '321-555-0199', '75 Magnolia Trace',          'Celebration',   'FL', '34747', 'Website',  'Homeowner', NULL, NULL, '{"preferred_contact":"Text"}'),
    (pg_temp.sbid(3, 12), t, u_chris, 'Nate',    'Pruitt',    'Nate Pruitt',      pg_temp.sbid(2, 6), 'nate@crestview-builders.example', '407-555-0170', '407-555-0171', '4402 Ironwood Pass',     'Apopka',        'FL', '32712', 'Builder',  'Builder', 'Sales Manager', 'Crestview Builders', '{}');

  -- ---------------------------------------------------------------------------
  -- Projects GS-101 … GS-108 (sites)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.projects (id, tenant_id, public_key, name, client_name, is_service, site_address, site_city, site_state, site_zip,
                               gate_code, community_gate, door_code, membership_level, status, project_group, project_type,
                               start_date, description, tags, owner_user_id, account_id, custom) VALUES
    (p101, t, 'GS-101', 'Okonkwo, Daniel - 1427 Heron Marsh Ln - SERVICE', 'Okonkwo, Daniel', true, '1427 Heron Marsh Ln', 'Winter Garden', 'FL', '34787',
       '4471#', 'Heron Marsh main gate: #2260, tell guard "Genesis"', '1988', 'Elite', 'Active', 'Service Projects', 'active',
       (v_now - interval '14 months')::date, 'Whole-home Control4, Lutron RA3, 12 cameras, Sonos, pool audio. Dog is friendly (Biscuit).', '{SERVICE Project}', u_alex, pg_temp.sbid(2, 1), '{}'),
    (p102, t, 'GS-102', 'Bellamy, Grace - 88 Sawgrass Bend Ct - SERVICE', 'Bellamy, Grace', true, '88 Sawgrass Bend Ct', 'Lake Mary', 'FL', '32746',
       NULL, 'Sawgrass Bend: call box, dial 088', '2468', 'Preferred', 'Active', 'Service Projects', 'active',
       (v_now - interval '8 months')::date, 'Araknis network, Sonos x6, Ring doorbell, garage integration in progress.', '{SERVICE Project}', u_alex, pg_temp.sbid(2, 2), '{}'),
    (p103, t, 'GS-103', 'Vance, Robert & Whitmore, Ellen - 3105 Cypress Hollow Dr - SERVICE', 'Vance, Robert & Whitmore, Ellen', true, '3105 Cypress Hollow Dr', 'Windermere', 'FL', '34786',
       '7731', 'Cypress Hollow: guard gate, on the list', '0525', 'Elite', 'Active', 'Service Projects', 'active',
       (v_now - interval '2 years')::date, 'Media room (JVC + Anthem), Lutron HomeWorks, 2 outdoor APs, network rack in garage closet.', '{SERVICE Project}', u_alex, pg_temp.sbid(2, 3), '{}'),
    (p104, t, 'GS-104', 'Sandpiper PM - 610 Tidewater Loop - SERVICE', 'Sandpiper PM', true, '610 Tidewater Loop', 'Clermont', 'FL', '34711',
       '1010#', NULL, NULL, 'Essential', 'Active', 'Service Projects', 'active',
       (v_now - interval '5 months')::date, '8-unit townhome block. Doorbell cams + thermostats per unit; coordinate through Monica Tran for unit access.', '{SERVICE Project}', u_alex, pg_temp.sbid(2, 4), '{"units":8}'),
    (p105, t, 'GS-105', 'Lakeshore Custom Homes - Lot 17 Osprey Ridge - PREWIRE', 'Lakeshore Custom Homes', true, 'Lot 17 Osprey Ridge Cir', 'Oviedo', 'FL', '32765',
       NULL, 'Construction entrance off Alafaya Woods; site super Beth', NULL, NULL, 'Active', 'New Construction', 'active',
       (v_now - interval '50 days')::date, 'New build, 4,200 sq ft. Prewire phases 1-2, trim-out after drywall.', '{New Construction}', u_alex, pg_temp.sbid(2, 5), '{"lot":"17","sq_ft":4200}'),
    (p106, t, 'GS-106', 'Harrington, Paul - 2290 Pelican Cove Way - SERVICE', 'Harrington, Paul', true, '2290 Pelican Cove Way', 'Winter Park', 'FL', '32789',
       '5150', NULL, '3311', 'Preferred', 'Active', 'Service Projects', 'active',
       (v_now - interval '11 months')::date, 'Theater (Epson projector), Lutron Caseta, Sonos, streaming devices. Client prefers afternoon visits.', '{SERVICE Project}', u_alex, NULL, '{}'),
    (p107, t, 'GS-107', 'Delacroix, Simone - 75 Magnolia Trace - SERVICE', 'Delacroix, Simone', true, '75 Magnolia Trace', 'Celebration', 'FL', '34747',
       NULL, 'Magnolia Trace: gate code 9090 (changes quarterly)', NULL, 'Essential', 'On Hold', 'Service Projects', 'active',
       (v_now - interval '20 months')::date, 'Lutron shades x14, Control4 lighting. Client travels frequently — confirm the day before.', '{SERVICE Project}', u_alex, NULL, '{}'),
    (p108, t, 'GS-108', 'Crestview Builders - 4402 Ironwood Pass (Model) - SERVICE', 'Crestview Builders', true, '4402 Ironwood Pass', 'Apopka', 'FL', '32712',
       '2024#', NULL, '4402', NULL, 'Active', 'Service Projects', 'active',
       (v_now - interval '4 months')::date, 'Builder model home; demo scenes must be reset after every open house.', '{SERVICE Project,Model Home}', u_alex, pg_temp.sbid(2, 6), '{}');

  -- ---------------------------------------------------------------------------
  -- Deals (5), varied stages; GS-D-<seq> in service_order_number
  -- ---------------------------------------------------------------------------
  INSERT INTO public.deals (id, tenant_id, name, owner_user_id, account_id, contact_id, project_id, amount, closing_date, stage, deal_type, lead_source, lead_type,
                            next_step, site_address, site_city, site_state, site_zip, new_or_existing_construction, preferred_membership, service_order_number, description, custom) VALUES
    (pg_temp.sbid(4, 1), t, 'Lakeshore - Lot 17 Osprey Ridge - Full Integration', u_chris, pg_temp.sbid(2, 5), pg_temp.sbid(3, 8), p105, 48500.00, (v_now - interval '55 days')::date, 'Won', 'New Construction', 'Builder', 'Builder',
       NULL, 'Lot 17 Osprey Ridge Cir', 'Oviedo', 'FL', '32765', 'New', NULL, 'GS-D-1', 'Prewire + trim-out + rack. Phased billing.', '{}'),
    (pg_temp.sbid(4, 2), t, 'Okonkwo - Pool audio + landscape lighting', u_chris, pg_temp.sbid(2, 1), pg_temp.sbid(3, 1), p101, 6200.00, (v_now + interval '10 days')::date, 'Proposal', 'Retrofit', 'Referral', 'Homeowner',
       'Send revised proposal with the 8-speaker option', '1427 Heron Marsh Ln', 'Winter Garden', 'FL', '34787', 'Existing', 'Elite', 'GS-D-2', NULL, '{}'),
    (pg_temp.sbid(4, 3), t, 'Sandpiper - Units 5-8 doorbell + thermostat package', u_alex, pg_temp.sbid(2, 4), pg_temp.sbid(3, 6), p104, 9800.00, (v_now + interval '21 days')::date, 'Qualified', 'Service', 'Website', 'Property Manager',
       'Site walk with Luis on the next visit', '610 Tidewater Loop', 'Clermont', 'FL', '34711', 'Existing', 'Essential', 'GS-D-3', NULL, '{}'),
    (pg_temp.sbid(4, 4), t, 'Harrington - Theater refresh (laser projector)', u_chris, NULL, pg_temp.sbid(3, 10), p106, 11400.00, (v_now + interval '45 days')::date, 'Lead', 'Retrofit', 'Referral', 'Homeowner',
       'Client wants to see a demo first', '2290 Pelican Cove Way', 'Winter Park', 'FL', '32789', 'Existing', 'Preferred', 'GS-D-4', NULL, '{}'),
    (pg_temp.sbid(4, 5), t, 'Crestview - Ironwood Pass Phase 2 models (x3)', u_chris, pg_temp.sbid(2, 6), pg_temp.sbid(3, 12), NULL, 27000.00, (v_now - interval '12 days')::date, 'Lost', 'New Construction', 'Builder', 'Builder',
       NULL, 'Ironwood Pass', 'Apopka', 'FL', '32712', 'New', NULL, 'GS-D-5', 'Lost to a lower bid; keep the relationship warm.', '{"reason_lost_detail":"price"}');
  UPDATE public.deals SET reason_lost = 'Price' WHERE tenant_id = t AND id = pg_temp.sbid(4, 5);

  -- ---------------------------------------------------------------------------
  -- Work orders (25). Global counter → GS-<proj>-WO-<year>-0001 … 0025.
  --   wo_status spread: Not Scheduled 5 · Scheduled 6 · Needs Reschedule 3 ·
  --   On Hold 1 · Active Monitoring 1 · Ready for Billing 2 · Waiting Payment 2 · Closed 5
  -- ---------------------------------------------------------------------------
  INSERT INTO public.work_orders (id, tenant_id, public_key, project_id, wo_year, wo_seq, subject, notes, priority, wo_status, billing_status, wo_type,
                                  task_list_completed, closed_at, created_at, custom)
  SELECT pg_temp.sbid(6, x.n), t, x.pk || '-WO-' || v_year::text || '-' || lpad(x.n::text, 4, '0'), x.pid, v_year, x.n, x.subject, x.notes, x.priority, x.status, x.billing, x.wo_type,
         x.status = 'Closed', CASE WHEN x.status = 'Closed' THEN v_now - x.age + interval '6 days' END, v_now - x.age, x.custom::jsonb
  FROM (VALUES
    ( 1, 'GS-101', p101, 'Annual system health check',                       'Elite membership annual visit: firmware, camera lens cleaning, network audit, rack tidy.',                'medium', 'Closed',            'Non-Billable', 'Service WO',    interval '40 days', '{}'),
    ( 2, 'GS-103', p103, 'Replace failed Lutron keypad in primary bedroom',   'Keypad unresponsive, LEDs dead. Confirmed bad keypad on site; replaced from truck stock.',                'high',   'Closed',            'Billable',     'Service WO',    interval '38 days', '{"warranty":"Partial","po_number":"PO-87710"}'),
    ( 3, 'GS-102', p102, 'Wi-Fi dead zone in lanai',                          'Client reports drops on the lanai TV and phones. Added an outdoor AP on the soffit.',                        'medium', 'Waiting Payment',   'Billable',     'Service WO',    interval '30 days', '{}'),
    ( 4, 'GS-104', p104, 'Unit 4 doorbell camera offline',                    'Tenant says doorbell shows offline since the storm. Check PoE injector and transformer.',                   'low',    'Ready for Billing', 'Billable',     'Service WO',    interval '28 days', '{}'),
    ( 5, 'GS-105', p105, 'Prewire rough-in - phase 1 (first floor)',          'Cat6 x 38, RG6 x 6, 16/4 to 12 speaker locations, conduit to rack. Two-day pull.',                          'high',   'Closed',            'Billable',     'Prewire WO',    interval '45 days', '{"po_number":"LCH-0417-P1"}'),
    ( 6, 'GS-105', p105, 'Prewire rough-in - phase 2 (second floor + attic)', 'Second-floor drops, attic AP locations, shade power to 9 windows. Drywall scheduled the week after.',        'high',   'Scheduled',         'Billable',     'Prewire WO',    interval '12 days', '{"po_number":"LCH-0417-P2"}'),
    ( 7, 'GS-106', p106, 'Theater projector lamp warning',                    'Lamp-hours warning on the Epson. Replacement lamp is backordered from the distributor.',                    'medium', 'Needs Reschedule',  'Billable',     'Service WO',    interval '14 days', '{}'),
    ( 8, 'GS-101', p101, 'Add outdoor speakers by pool',                      'Two rock speakers on the pool side, tie into existing Sonos Amp in the lanai closet.',                       'low',    'Scheduled',         'Billable',     'Service WO',    interval '10 days', '{}'),
    ( 9, 'GS-107', p107, 'Shades not responding to schedule',                 'Lutron shades skip the sunset close. Client is travelling until further notice — on hold at her request.',  'medium', 'On Hold',           'Billable',     'Service WO',    interval '16 days', '{}'),
    (10, 'GS-103', p103, 'Network drops after storms - monitoring',           'Intermittent WAN drops correlated with afternoon storms. Logging from the OvrC agent for two weeks.',        'medium', 'Active Monitoring', 'Non-Billable', 'Service WO',    interval '15 days', '{}'),
    (11, 'GS-102', p102, 'Sonos rebuild after ISP change',                    'Client moved to a new ISP; Sonos system needs re-pairing and the Araknis WAN reconfigured.',                'medium', 'Scheduled',         'Billable',     'Service WO',    interval '3 days',  '{}'),
    (12, 'GS-108', p108, 'Model home: reset demo scenes after open house',    'Standing request from Crestview after each open-house weekend.',                                             'low',    'Not Scheduled',     'Non-Billable', 'Service WO',    interval '2 days',  '{}'),
    (13, 'GS-104', p104, 'Unit 2 thermostat integration',                     'New tenant wants the Ecobee tied into the unit''s app. Access via Monica.',                                  'none',   'Not Scheduled',     'Billable',     'Service WO',    interval '4 days',  '{}'),
    (14, 'GS-106', p106, 'Remote support: streaming app login',               'Apple TV signed out of the client''s streaming apps after an update. Resolved remotely.',                    'low',    'Closed',            'Non-Billable', 'Service WO',    interval '9 days',  '{}'),
    (15, 'GS-101', p101, 'Camera NVR storage upgrade',                        'Swap the 4 TB drive for a 12 TB surveillance drive; client wants 60 days of retention.',                     'high',   'Scheduled',         'Billable',     'Service WO',    interval '6 days',  '{"po_number":"PO-88213","warranty":"No"}'),
    (16, 'GS-103', p103, 'Warranty: replace outdoor AP (pool side)',          'AP rebooting every few hours. Distributor approved the RMA; swap under warranty.',                            'medium', 'Needs Reschedule',  'Non-Billable', 'Service WO',    interval '8 days',  '{"warranty":"Yes"}'),
    (17, 'GS-107', p107, 'Quarterly membership tune-up',                      'Essential membership quarterly: firmware, backups, shade limits.',                                            'low',    'Scheduled',         'Non-Billable', 'Service WO',    interval '5 days',  '{}'),
    (18, 'GS-102', p102, 'Garage door sensor integration',                    'Add the myQ bridge to the app and a "garage open at night" alert.',                                           'low',    'Ready for Billing', 'Billable',     'Service WO',    interval '11 days', '{}'),
    (19, 'GS-105', p105, 'Trim-out: rack build and device install',           'Post-drywall: rack build, AP/keypad/speaker install, Lutron programming. Waiting on paint.',                 'high',   'Not Scheduled',     'Billable',     'Production WO', interval '7 days',  '{"po_number":"LCH-0417-T"}'),
    (20, 'GS-108', p108, 'Internal: photograph install for portfolio',        'Marketing photos of the model-home rack and theater.',                                                       'low',    'Closed',            'Internal',     'Service WO',    interval '22 days', '{}'),
    (21, 'GS-106', p106, 'Add Lutron dimmers in guest wing',                  'Four Caseta dimmers + Pico in the guest hall and bedroom. Tentative — client confirming the afternoon.',      'medium', 'Scheduled',         'Billable',     'Service WO',    interval '4 days',  '{}'),
    (22, 'GS-104', p104, 'Unit 7 move-in: network handoff',                   'New tenant moving in; reset the router, hand off Wi-Fi credentials, verify doorbell. Missed yesterday.',      'high',   'Needs Reschedule',  'Billable',     'Service WO',    interval '6 days',  '{}'),
    (23, 'GS-101', p101, 'Elite: annual firmware sweep',                      'Controller, AP, switch, camera firmware. Can combine with the pool-speaker visit.',                           'none',   'Not Scheduled',     'Non-Billable', 'Service WO',    interval '3 days',  '{}'),
    (24, 'GS-103', p103, 'Media room remote reprogram',                       'Added the new Apple TV and Blu-ray to the Control4 remote; client wants a "Movie Night" scene.',              'medium', 'Waiting Payment',   'Billable',     'Service WO',    interval '25 days', '{}'),
    (25, 'GS-102', p102, 'Investigate intermittent doorbell chime',           'Chime rings twice sometimes. Check the Ring transformer and the chime kit setting.',                          'medium', 'Not Scheduled',     'Billable',     'Service WO',    interval '1 day',   '{}')
  ) AS x(n, pk, pid, subject, notes, priority, status, billing, wo_type, age, custom);

  -- ---------------------------------------------------------------------------
  -- wo_tasks: one work + one billing task per WO; steps on 4 WOs
  -- ---------------------------------------------------------------------------
  INSERT INTO public.wo_tasks (id, tenant_id, work_order_id, kind, name, task_status, position, completed_at)
  SELECT pg_temp.sbid(7, wo.wo_seq), t, wo.id, 'work', 'Work Order Tasks',
         CASE WHEN wo.wo_status IN ('Closed', 'Ready for Billing', 'Waiting Payment') THEN 'Completed' ELSE 'Pending' END, 0,
         CASE WHEN wo.wo_status IN ('Closed', 'Ready for Billing', 'Waiting Payment') THEN wo.created_at + interval '5 days' END
  FROM public.work_orders wo WHERE wo.tenant_id = t;

  INSERT INTO public.wo_tasks (id, tenant_id, work_order_id, kind, name, task_status, position, completed_at)
  SELECT pg_temp.sbid(7, 100 + wo.wo_seq), t, wo.id, 'billing', 'Billing',
         CASE WHEN wo.wo_status = 'Closed' THEN 'Completed' ELSE 'Pending' END, 1,
         CASE WHEN wo.wo_status = 'Closed' THEN wo.closed_at END
  FROM public.work_orders wo WHERE wo.tenant_id = t;

  INSERT INTO public.wo_tasks (id, tenant_id, work_order_id, kind, parent_task_id, name, task_status, position, completed_at)
  SELECT pg_temp.sbid(7, 200 + s.k), t, pg_temp.sbid(6, s.wo), 'step', pg_temp.sbid(7, s.wo), s.name, s.st, s.pos,
         CASE WHEN s.st = 'Completed' THEN v_now - interval '39 days' END
  FROM (VALUES
    (1,  5,  'Mark drops with the super',               'Completed', 0),
    (2,  5,  'Pull Cat6 / RG6 first floor',             'Completed', 1),
    (3,  5,  'Speaker wire + conduit to rack',          'Completed', 2),
    (4,  5,  'Label and photograph every drop',         'Completed', 3),
    (5,  6,  'Second-floor drops',                      'Pending',   0),
    (6,  6,  'Attic AP locations (x3)',                 'Pending',   1),
    (7,  6,  'Shade power to 9 windows',                'Pending',   2),
    (8,  15, 'Back up NVR config',                      'Pending',   0),
    (9,  15, 'Swap drive, re-initialise, verify 60d',   'Pending',   1),
    (10, 19, 'Rack build (shop)',                       'Pending',   0),
    (11, 19, 'Device install on site',                  'Pending',   1),
    (12, 19, 'Lutron programming + client walk-through','Pending',   2)
  ) AS s(k, wo, name, st, pos);

  -- ---------------------------------------------------------------------------
  -- Visits (past / today / next week / multi-day) + attendees (techs)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.visits (id, tenant_id, work_order_id, starts_at, ends_at, label, confirmed, remote)
  SELECT pg_temp.sbid(8, v.k), t, pg_temp.sbid(6, v.wo), v.s, v.e, v.label, v.confirmed, v.remote
  FROM (VALUES
    ( 1,  1, d0 - interval '35 days',                       d0 - interval '35 days' + interval '4 hours',  NULL,                 true,  false),
    ( 2,  2, d0 - interval '30 days' + interval '4 hours',  d0 - interval '30 days' + interval '6 hours',  NULL,                 true,  false),
    ( 3,  3, d0 - interval '22 days',                       d0 - interval '22 days' + interval '3 hours',  NULL,                 true,  false),
    ( 4,  4, d0 - interval '20 days' + interval '1 hour',   d0 - interval '20 days' + interval '3 hours',  NULL,                 true,  false),
    ( 5,  5, d0 - interval '40 days' - interval '1 hour',   d0 - interval '40 days' + interval '8 hours',  'Day 1',              true,  false),
    ( 6,  5, d0 - interval '39 days' - interval '1 hour',   d0 - interval '39 days' + interval '7 hours',  'Day 2',              true,  false),
    ( 7,  6, d0 + interval '8 days' - interval '1 hour',    d0 + interval '8 days' + interval '8 hours',   'Day 1',              true,  false),
    ( 8,  6, d0 + interval '9 days' - interval '1 hour',    d0 + interval '9 days' + interval '8 hours',   'Day 2',              true,  false),
    ( 9,  7, d0 - interval '9 days' + interval '4 hours',   d0 - interval '9 days' + interval '6 hours',   'Lamp swap',          true,  false),
    (10,  8, d0 + interval '3 days',                        d0 + interval '3 days' + interval '5 hours',   NULL,                 true,  false),
    (11,  9, d0 - interval '5 days' + interval '1 hour',    d0 - interval '5 days' + interval '3 hours',   NULL,                 true,  false),
    (12, 10, d0 - interval '12 days',                       d0 - interval '12 days' + interval '2 hours',  'Install OvrC logging', true, false),
    (13, 11, v_now + interval '90 minutes',                 v_now + interval '4 hours',                    NULL,                 true,  false),
    (14, 14, d0 - interval '7 days' + interval '5 hours',   d0 - interval '7 days' + interval '5 hours 30 minutes', 'Remote',    true,  true),
    (15, 15, d0 + interval '1 day',                         d0 + interval '1 day' + interval '3 hours',    NULL,                 true,  false),
    (16, 16, d0 - interval '3 days' + interval '4 hours',   d0 - interval '3 days' + interval '6 hours',   NULL,                 true,  false),
    (17, 17, d0 + interval '12 days',                       d0 + interval '12 days' + interval '2 hours',  NULL,                 true,  false),
    (18, 18, d0 - interval '4 days',                        d0 - interval '4 days' + interval '2 hours',   NULL,                 true,  false),
    (19, 20, d0 - interval '16 days' + interval '2 hours',  d0 - interval '16 days' + interval '4 hours',  NULL,                 true,  false),
    (20, 21, v_now + interval '4 hours',                    v_now + interval '7 hours',                    'Tentative',          false, false),
    (21, 22, d0 - interval '1 day' + interval '4 hours',    d0 - interval '1 day' + interval '6 hours',    'Move-in handoff',    true,  false),
    (22, 24, d0 - interval '18 days' + interval '4 hours',  d0 - interval '18 days' + interval '6 hours',  NULL,                 true,  false)
  ) AS v(k, wo, s, e, label, confirmed, remote);

  INSERT INTO public.visit_attendees (tenant_id, visit_id, email, technician_id, position)
  SELECT t, pg_temp.sbid(8, a.k), a.email, a.uid, a.pos
  FROM (VALUES
    ( 1, e_marcus, u_marcus, 0),
    ( 2, e_dana,   u_dana,   0),
    ( 3, e_tyler,  u_tyler,  0),
    ( 4, e_jordan, u_jordan, 0),
    ( 5, e_marcus, u_marcus, 0), ( 5, e_tyler, u_tyler, 1), ( 5, e_jordan, u_jordan, 2),
    ( 6, e_marcus, u_marcus, 0), ( 6, e_tyler, u_tyler, 1),
    ( 7, e_marcus, u_marcus, 0), ( 7, e_tyler, u_tyler, 1), ( 7, e_jordan, u_jordan, 2),
    ( 8, e_marcus, u_marcus, 0), ( 8, e_tyler, u_tyler, 1),
    ( 9, e_dana,   u_dana,   0),
    (10, e_tyler,  u_tyler,  0), (10, e_jordan, u_jordan, 1),
    (11, e_priya,  u_priya,  0),
    (12, e_dana,   u_dana,   0),
    (13, e_priya,  u_priya,  0),
    (14, e_priya,  u_priya,  0),
    (15, e_marcus, u_marcus, 0),
    (16, e_dana,   u_dana,   0),
    (17, e_priya,  u_priya,  0),
    (18, e_tyler,  u_tyler,  0),
    (19, e_jordan, u_jordan, 0),
    (20, e_dana,   u_dana,   0), (20, e_jordan, u_jordan, 1),
    (21, e_jordan, u_jordan, 0),
    (22, e_dana,   u_dana,   0)
  ) AS a(k, email, uid, pos);

  -- ---------------------------------------------------------------------------
  -- Items (all 7 live statuses represented)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.items (id, tenant_id, work_order_id, name, quantity, note, status, closed_at, created_at)
  SELECT pg_temp.sbid(9, i.k), t, pg_temp.sbid(6, i.wo), i.name, i.qty, i.note, i.status,
         CASE WHEN i.status IN ('Installed (From Stock)', 'Installed (Field Purchase)', 'Canceled') THEN v_now - i.age + interval '3 days' END,
         v_now - i.age
  FROM (VALUES
    ( 1,  2, 'Lutron RA3 Sunnata keypad, white',            1, 'Truck stock',                                   'Installed (From Stock)',     interval '36 days'),
    ( 2,  3, 'Araknis 810 outdoor AP',                      1, NULL,                                            'Installed (From Stock)',     interval '26 days'),
    ( 3,  3, 'Outdoor Cat6 30 ft + mount',                  1, 'Picked up at the supply house on the way',      'Installed (Field Purchase)', interval '24 days'),
    ( 4,  4, 'PoE injector 48V',                            1, NULL,                                            'Installed (Field Purchase)', interval '21 days'),
    ( 5,  6, 'Cat6 1000 ft box, blue',                      3, 'Second-floor pull',                             'Staged',                     interval '9 days'),
    ( 6,  6, '16/4 speaker wire 500 ft',                    2, NULL,                                            'On Order',                   interval '9 days'),
    ( 7,  6, 'Shade power supply, 24V',                     9, 'Lutron; ETA before the visit',                  'On Order',                   interval '8 days'),
    ( 8,  7, 'Epson ELPLP lamp',                            1, 'Backordered at the distributor - 2-3 weeks',    'Backordered',                interval '12 days'),
    ( 9,  8, 'Sonance rock speaker pair (brown)',           1, NULL,                                            'Staged',                     interval '7 days'),
    (10,  8, 'Direct-burial speaker wire 100 ft',           1, NULL,                                            'Staged',                     interval '7 days'),
    (11, 15, '12 TB surveillance HDD',                      1, 'Confirm compatibility with the NVR firmware',   'On Order',                   interval '5 days'),
    (12, 16, 'Araknis 810 outdoor AP (RMA)',                1, 'Warranty replacement',                          'Needed',                     interval '6 days'),
    (13, 19, 'Control4 CORE 5',                             1, NULL,                                            'Needed',                     interval '6 days'),
    (14, 19, 'Araknis 24-port PoE switch',                  1, NULL,                                            'Needed',                     interval '6 days'),
    (15, 19, 'Araknis 810 indoor AP',                       3, NULL,                                            'Needed',                     interval '6 days'),
    (16, 19, '42U rack + shelves',                          1, NULL,                                            'Needed',                     interval '6 days'),
    (17, 21, 'Caseta dimmer (white)',                       4, NULL,                                            'Staged',                     interval '3 days'),
    (18, 21, 'Pico remote + wall bracket',                  1, NULL,                                            'Staged',                     interval '3 days'),
    (19,  9, 'Lutron shade motor (replacement)',            1, 'Client put the job on hold; canceled the order', 'Canceled',                   interval '13 days'),
    (20, 25, 'Ring chime kit',                              1, 'Only if the transformer checks out',            'Needed',                     interval '1 day')
  ) AS i(k, wo, name, qty, note, status, age);

  -- materials (S11 list): 2 manual, 1 mirrored from an item request
  INSERT INTO public.materials (id, tenant_id, work_order_id, name, notes, from_request, source_item_label, source_item_id, completed_at) VALUES
    (pg_temp.sbid(17, 1), t, pg_temp.sbid(6, 8),  'Sonance rock speaker pair (brown)', NULL, true, 'Sonance rock speaker pair (brown) ×1', pg_temp.sbid(9, 9), NULL),
    (pg_temp.sbid(17, 2), t, pg_temp.sbid(6, 8),  'Silicone + wire nuts (outdoor)',    'Truck stock', false, NULL, NULL, NULL),
    (pg_temp.sbid(17, 3), t, pg_temp.sbid(6, 15), 'SATA cable + drive tray screws',    NULL, false, NULL, NULL, v_now - interval '1 day');

  -- ---------------------------------------------------------------------------
  -- Hours (10 WOs)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.hours_entries (tenant_id, work_order_id, position, tech, technician_id, hours, logged_at, note)
  SELECT t, pg_temp.sbid(6, h.wo), h.pos, h.email, h.uid, h.hrs, d0 - h.age, h.note
  FROM (VALUES
    ( 1, 0, e_marcus, u_marcus, 3.50, interval '35 days', 'Annual check, all systems'),
    ( 2, 0, e_dana,   u_dana,   1.50, interval '30 days', 'Keypad swap + programming'),
    ( 3, 0, e_tyler,  u_tyler,  2.75, interval '22 days', 'AP install on soffit'),
    ( 4, 0, e_jordan, u_jordan, 1.25, interval '20 days', NULL),
    ( 5, 0, e_marcus, u_marcus, 8.00, interval '40 days', 'Day 1'),
    ( 5, 1, e_tyler,  u_tyler,  8.00, interval '40 days', 'Day 1'),
    ( 5, 2, e_jordan, u_jordan, 8.00, interval '40 days', 'Day 1'),
    ( 5, 3, e_marcus, u_marcus, 7.50, interval '39 days', 'Day 2'),
    ( 5, 4, e_tyler,  u_tyler,  7.50, interval '39 days', 'Day 2'),
    (10, 0, e_dana,   u_dana,   1.00, interval '12 days', 'OvrC agent + logging'),
    (14, 0, e_priya,  u_priya,  0.50, interval '7 days',  'Remote'),
    (18, 0, e_tyler,  u_tyler,  1.75, interval '4 days',  NULL),
    (20, 0, e_jordan, u_jordan, 2.00, interval '16 days', 'Photos'),
    (24, 0, e_dana,   u_dana,   2.25, interval '18 days', 'Remote programming + scene')
  ) AS h(wo, pos, email, uid, hrs, age, note);

  -- ---------------------------------------------------------------------------
  -- Daily reports (5 WOs; WO1 sent with a PDF; WO5 two days + cumulative)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.files (id, tenant_id, entity, entity_id, kind, filename, content_type, byte_size, bytes) VALUES
    (pg_temp.sbid(15, 1), t, 'daily_report', pg_temp.sbid(10, 1), 'daily_report_pdf',
     'daily-report-GS-101-WO-' || v_year::text || '-0001-' || to_char((d0 - interval '35 days') AT TIME ZONE v_tz, 'YYYY-MM-DD') || '.pdf',
     'application/pdf', 0, NULL);
  UPDATE public.files SET bytes = convert_to(
    E'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'UTF8')
  WHERE tenant_id = t AND id = pg_temp.sbid(15, 1);
  UPDATE public.files SET byte_size = octet_length(bytes) WHERE tenant_id = t AND id = pg_temp.sbid(15, 1);

  INSERT INTO public.daily_reports (id, tenant_id, work_order_id, report_date, sent_at, pdf_file_id) VALUES
    (pg_temp.sbid(10, 1), t, pg_temp.sbid(6, 1),  ((d0 - interval '35 days') AT TIME ZONE v_tz)::date, d0 - interval '35 days' + interval '9 hours', pg_temp.sbid(15, 1)),
    (pg_temp.sbid(10, 2), t, pg_temp.sbid(6, 4),  ((d0 - interval '20 days') AT TIME ZONE v_tz)::date, NULL, NULL),
    (pg_temp.sbid(10, 3), t, pg_temp.sbid(6, 5),  ((d0 - interval '40 days') AT TIME ZONE v_tz)::date, NULL, NULL),
    (pg_temp.sbid(10, 4), t, pg_temp.sbid(6, 5),  ((d0 - interval '39 days') AT TIME ZONE v_tz)::date, NULL, NULL),
    (pg_temp.sbid(10, 5), t, pg_temp.sbid(6, 5),  NULL, NULL, NULL),  -- cumulative pseudo-day
    (pg_temp.sbid(10, 6), t, pg_temp.sbid(6, 10), ((d0 - interval '12 days') AT TIME ZONE v_tz)::date, NULL, NULL),
    (pg_temp.sbid(10, 7), t, pg_temp.sbid(6, 18), ((d0 - interval '4 days')  AT TIME ZONE v_tz)::date, NULL, NULL);

  INSERT INTO public.daily_report_entries (tenant_id, daily_report_id, position, tech, text, noted_at)
  SELECT t, pg_temp.sbid(10, e.rep), e.pos, e.tech, e.txt, d0 - e.age
  FROM (VALUES
    (1, 0, e_marcus, 'Arrived 9:05. Updated controller, switch and 12 camera firmware.', interval '35 days' - interval '3 hours'),
    (1, 1, e_marcus, 'Cleaned camera domes; driveway cam had a spider web. Rack tidied, labels replaced.', interval '35 days' - interval '3 hours 40 minutes'),
    (1, 2, e_marcus, 'Network audit clean. Recommended the NVR storage upgrade (see separate WO).', interval '35 days' - interval '4 hours'),
    (2, 0, e_jordan, 'PoE injector dead; replaced. Doorbell back online, tenant notified.', interval '20 days' - interval '2 hours'),
    (3, 0, e_marcus, 'Walked drops with Beth; two speaker locations moved to the great room ceiling.', interval '40 days' - interval '1 hour'),
    (3, 1, e_tyler,  'Pulled 38 Cat6 and 6 RG6 to the rack location. Conduit to attic in.', interval '40 days' - interval '8 hours'),
    (4, 0, e_marcus, 'Speaker wire to all 12 locations. Everything labeled and photographed.', interval '39 days' - interval '7 hours'),
    (5, 0, e_marcus, 'Phase 1 complete over two days; ready for inspection.', interval '39 days' - interval '7 hours 30 minutes'),
    (6, 0, e_dana,   'Installed OvrC logging on the router; will review in two weeks.', interval '12 days' - interval '2 hours'),
    (7, 0, e_tyler,  'myQ bridge paired; night alert configured and tested with the client.', interval '4 days' - interval '2 hours')
  ) AS e(rep, pos, tech, txt, age);

  -- ---------------------------------------------------------------------------
  -- Todos (per-WO), one of them the tentative-visit confirmation
  -- ---------------------------------------------------------------------------
  INSERT INTO public.todos (id, tenant_id, work_order_id, title, status, urgency, assignee_name, assignee_user_id, notes, closed_at) VALUES
    (pg_temp.sbid(16, 1), t, pg_temp.sbid(6, 21), 'Confirm appointment with Paul Harrington', 'Open', 'high', 'Renee Castillo', u_renee, 'Client said "probably this afternoon" — confirm by noon.', NULL),
    (pg_temp.sbid(16, 2), t, pg_temp.sbid(6, 7),  'Call distributor for lamp ETA',           'Awaiting Feedback', 'medium', 'Sam Okafor', u_sam, NULL, NULL),
    (pg_temp.sbid(16, 3), t, pg_temp.sbid(6, 9),  'Check back with Simone on her return date', 'On-Hold', 'low', 'Renee Castillo', u_renee, NULL, NULL),
    (pg_temp.sbid(16, 4), t, pg_temp.sbid(6, 22), 'Reschedule Unit 7 handoff with Monica',   'Open', 'high', 'Renee Castillo', u_renee, 'Tenant moved in yesterday; they need Wi-Fi.', NULL),
    (pg_temp.sbid(16, 5), t, pg_temp.sbid(6, 3),  'Send invoice',                            'Completed', 'medium', 'Sam Okafor', u_sam, NULL, v_now - interval '19 days'),
    (pg_temp.sbid(16, 6), t, pg_temp.sbid(6, 19), 'Ask Beth when paint is done',             'Open', 'medium', 'Chris Delgado', u_chris, NULL, NULL);
  UPDATE public.visits SET confirm_todo_id = pg_temp.sbid(16, 1) WHERE tenant_id = t AND id = pg_temp.sbid(8, 20);

  -- ---------------------------------------------------------------------------
  -- Action items (8; three without a project) + comments + reminders
  -- ---------------------------------------------------------------------------
  INSERT INTO public.action_items (id, tenant_id, public_key, project_id, title, description, flag, status, assignee_user_id, created_at, custom) VALUES
    (pg_temp.sbid(11, 1), t, 'GS-AI-1', p101, 'Client asked about landscape lighting',           'Daniel wants a quote for path + uplights along the pool deck. Ties to deal GS-D-2.', 'External', 'In Progress', u_chris,  v_now - interval '20 days', '{}'),
    (pg_temp.sbid(11, 2), t, 'GS-AI-2', p103, 'Guard gate list needs Genesis added for all techs', 'Only Marcus and Dana are on the list; add Tyler, Priya, Jordan.',                        'Internal', 'Open',        u_renee,  v_now - interval '6 days',  '{}'),
    (pg_temp.sbid(11, 3), t, 'GS-AI-3', p104, 'Sandpiper wants a monthly uptime summary',       'Monica asked for a one-page monthly report per unit.',                                      'External', 'Waiting',     u_alex,   v_now - interval '15 days', '{}'),
    (pg_temp.sbid(11, 4), t, 'GS-AI-4', p105, 'Drywall date moved — confirm phase 2 still fits', 'Beth said drywall might start 3 days earlier.',                                            'External', 'Open',        u_marcus, v_now - interval '2 days',  '{}'),
    (pg_temp.sbid(11, 5), t, 'GS-AI-5', p107, 'Simone''s gate code rotates next quarter',        'Update the project gate field when the HOA sends the new code.',                           'Internal', 'Closed',      u_renee,  v_now - interval '30 days', '{}'),
    (pg_temp.sbid(11, 6), t, 'GS-AI-6', NULL, 'Truck 2 needs a new label printer',              'Brother PT-E550W died. Order a replacement.',                                                'Internal', 'Open',        u_sam,    v_now - interval '4 days',  '{}'),
    (pg_temp.sbid(11, 7), t, 'GS-AI-7', NULL, 'Renew OvrC Pro subscription',                    'Expires at the end of next month; confirm the seat count.',                                  'Internal', 'In Progress', u_alex,   v_now - interval '10 days', '{"vendor":"Snap One"}'),
    (pg_temp.sbid(11, 8), t, 'GS-AI-8', NULL, 'Update the service-agreement template',          'Add the Elite tier wording and the remote-support clause.',                                  'Internal', 'Closed',      u_alex,   v_now - interval '40 days', '{}');

  INSERT INTO public.action_item_comments (tenant_id, action_item_id, content, added_by_user_id, created_at) VALUES
    (t, pg_temp.sbid(11, 1), 'Walked the pool deck with Daniel; he prefers warm-white uplights on the palms.', u_chris, v_now - interval '18 days'),
    (t, pg_temp.sbid(11, 1), 'Proposal draft ready for review.', u_chris, v_now - interval '9 days'),
    (t, pg_temp.sbid(11, 3), 'Sent Monica a sample report; waiting for her feedback.', u_alex, v_now - interval '11 days'),
    (t, pg_temp.sbid(11, 4), 'Called Beth — drywall is now the Tuesday after our phase 2 dates, so we are fine.', u_marcus, v_now - interval '1 day');

  INSERT INTO public.reminders (id, tenant_id, action_item_id, remind_at, message, fired_at) VALUES
    (pg_temp.sbid(12, 1), t, pg_temp.sbid(11, 7), d0 + interval '1 day',  'Renew OvrC Pro before it lapses', NULL),
    (pg_temp.sbid(12, 2), t, pg_temp.sbid(11, 3), d0 - interval '8 days', 'Follow up with Monica on the uptime report', d0 - interval '8 days' + interval '2 minutes');

  -- ---------------------------------------------------------------------------
  -- Forums: site notes on GS-101 and GS-103
  -- ---------------------------------------------------------------------------
  INSERT INTO public.forum_categories (id, tenant_id, project_id, name) VALUES
    (pg_temp.sbid(13, 1), t, p101, 'General'),
    (pg_temp.sbid(13, 2), t, p101, 'Site Notes & Credentials'),
    (pg_temp.sbid(13, 3), t, p103, 'Site Notes & Credentials');

  INSERT INTO public.forums (id, tenant_id, project_id, category_id, name, content, flag, type, posted_by_user_id, posted_at, last_activity_at, is_sticky) VALUES
    (pg_temp.sbid(14, 1), t, p101, pg_temp.sbid(13, 2), 'Rack location + access', '<p>Rack is in the lanai closet (left of the pool bath). Breaker panel in the garage, circuit 14 feeds the rack.</p><p>Dog (Biscuit) is friendly but will bolt out the side gate — keep it latched.</p>', 'internal', 'normal', u_marcus, v_now - interval '13 months', v_now - interval '9 days', true),
    (pg_temp.sbid(14, 2), t, p101, pg_temp.sbid(13, 1), 'Client prefers text updates', '<p>Daniel asked for text rather than calls before a visit.</p>', 'internal', 'normal', u_renee, v_now - interval '3 months', v_now - interval '3 months', false),
    (pg_temp.sbid(14, 3), t, p103, pg_temp.sbid(13, 3), 'Guard gate + media room', '<p>Tell the guard "Genesis for Vance". Media room equipment closet key is on the hook inside the pantry.</p>', 'internal', 'normal', u_dana, v_now - interval '18 months', v_now - interval '30 days', true);

  INSERT INTO public.forum_comments (tenant_id, forum_id, level, content, type, posted_by_user_id, posted_at) VALUES
    (t, pg_temp.sbid(14, 1), 1, 'Circuit 14 was relabeled to 16 after the panel work — updated the rack label.', 'normal', u_tyler, v_now - interval '9 days'),
    (t, pg_temp.sbid(14, 3), 1, 'Key moved to the lockbox by the garage side door (code = door code).', 'normal', u_dana, v_now - interval '30 days');

  -- ---------------------------------------------------------------------------
  -- Events: one per WO (created) + the sent daily report + the seed itself.
  --   Idempotency keys make a re-run a no-op even without the guard above.
  -- ---------------------------------------------------------------------------
  INSERT INTO public.events (tenant_id, entity, entity_id, event_type, payload, actor, idempotency_key, occurred_at)
  SELECT t, 'work_order', wo.id, 'work_order.created',
         jsonb_build_object('workOrderNumber', wo.public_key, 'subject', wo.subject, 'projectKey', p.public_key),
         'system:seed', 'sandbox:work_order.created:' || wo.public_key, wo.created_at
  FROM public.work_orders wo JOIN public.projects p ON p.id = wo.project_id
  WHERE wo.tenant_id = t
  ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  INSERT INTO public.events (tenant_id, entity, entity_id, event_type, payload, actor, idempotency_key, occurred_at)
  SELECT t, 'daily_report', d.id, 'daily_report.sent',
         jsonb_build_object('workOrderId', d.work_order_id, 'date', to_char(d.report_date, 'YYYY-MM-DD')),
         e_marcus, 'sandbox:daily_report.sent:' || d.id::text, d.sent_at
  FROM public.daily_reports d WHERE d.tenant_id = t AND d.sent_at IS NOT NULL
  ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  INSERT INTO public.events (tenant_id, entity, entity_id, event_type, payload, actor, idempotency_key)
  VALUES (t, 'tenant', t, 'sandbox.seeded', jsonb_build_object('migration', '0003_seed_sandbox', 'year', v_year), 'system:migration',
          'sandbox:seeded:' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.US'))
  ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  -- sanity: every WO has a work + billing task and a vocab-valid status (the trigger already enforced the latter)
  SELECT count(*) INTO r FROM public.work_orders wo
  WHERE wo.tenant_id = t AND NOT EXISTS (SELECT 1 FROM public.wo_tasks k WHERE k.work_order_id = wo.id AND k.kind = 'work');
  IF r.count <> 0 THEN
    RAISE EXCEPTION '0003_seed_sandbox: % work orders without a work task', r.count;
  END IF;

  RAISE NOTICE '0003_seed_sandbox: seeded Genesis Sandbox (tenant %) — 9 users, 8 projects, 25 work orders, year %', t, v_year;
END;
$seed$;

-- =============================================================================
-- End of 0003_seed_sandbox.sql
-- =============================================================================
