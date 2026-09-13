-- =============================================================================
-- 0001_baseline.sql — Genesis Werks first Supabase/Postgres migration (row F1)
-- Source of truth: the-bridge F0 data-model.md (§1–§5) with §8 review decisions
-- applied. Valid Postgres 15+. No enums. No business-rule triggers: the only
-- triggers are (a) updated_at maintenance, (b) status_vocab data validation,
-- (c) events immutability.
--
-- Multi-tenancy: every table carries tenant_id. RLS is enabled on every table
-- with policy `tenant_isolation` keyed on the transaction-local GUC
-- `app.tenant_id`. genesis-api MUST run `SET LOCAL app.tenant_id = '<uuid>'`
-- (or `SELECT set_config('app.tenant_id', $1, true)`) at the start of every
-- transaction. NOTE: Supabase's `postgres` and `service_role` roles BYPASS RLS
-- (BYPASSRLS / table owner); the policies only bite for non-bypass roles such
-- as `authenticated`, `anon`, or the `genesis_api` role created below.
-- =============================================================================

-- Quiet the "does not exist, skipping" notices from the idempotent DROP ... IF EXISTS
-- statements below (transaction-scoped; Supabase runs each migration in a tx).
SET LOCAL client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Core functions
-- -----------------------------------------------------------------------------

-- uuidv7(): time-ordered UUID (RFC 9562 v7). Postgres 15/17 on Supabase has no
-- native uuidv7, so this is the standard recipe: take a random v4 (correct
-- variant bits), overlay the first 48 bits with unix-epoch milliseconds, then
-- flip the version nibble from 0100 (v4) to 0111 (v7) by setting bits 52 and 53.
CREATE OR REPLACE FUNCTION public.uuidv7()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send((floor(extract(epoch FROM clock_timestamp()) * 1000))::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;
COMMENT ON FUNCTION public.uuidv7() IS 'RFC 9562 UUID v7 (48-bit ms timestamp + random), built from gen_random_uuid + clock_timestamp.';

-- app_tenant_id(): the tenant of the current transaction, or NULL when unset.
-- nullif() guards against ''::uuid cast errors when the GUC is missing.
CREATE OR REPLACE FUNCTION public.app_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;
COMMENT ON FUNCTION public.app_tenant_id() IS 'Tenant bound to this transaction via SET LOCAL app.tenant_id; NULL when unset.';

-- set_updated_at(): BEFORE UPDATE trigger body applied to every table that has
-- an updated_at column.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- assert_vocab(): DATA VALIDATION ONLY. Raises when (tenant, domain, code) is
-- not a status_vocab row. NULL and '' are treated as "unset" and pass (the
-- model keeps wo_type = '' for "unset"). SECURITY DEFINER so the lookup works
-- for roles restricted by RLS; the tenant is passed explicitly so it cannot
-- read across tenants.
CREATE OR REPLACE FUNCTION public.assert_vocab(p_tenant uuid, p_domain text, p_code text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_code IS NULL OR p_code = '' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.status_vocab sv
    WHERE sv.tenant_id = p_tenant AND sv.domain = p_domain AND sv.code = p_code
  ) THEN
    RAISE EXCEPTION 'status_vocab violation: "%" is not a code in domain "%" for tenant %', p_code, p_domain, p_tenant
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END;
$$;
COMMENT ON FUNCTION public.assert_vocab(uuid, text, text) IS 'Validation only: raises unless (tenant, domain, code) exists in status_vocab. NULL/'''' pass as unset.';

-- trg_assert_vocab(): generic BEFORE INSERT/UPDATE trigger. Arguments come in
-- pairs: (column_name, vocab_domain, column_name, vocab_domain, ...). Reads the
-- column value off to_jsonb(NEW) so one function serves every table.
CREATE OR REPLACE FUNCTION public.trg_assert_vocab()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_i   int   := 0;
BEGIN
  WHILE v_i < TG_NARGS LOOP
    PERFORM public.assert_vocab(NEW.tenant_id, TG_ARGV[v_i + 1], v_row ->> TG_ARGV[v_i]);
    v_i := v_i + 2;
  END LOOP;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.trg_assert_vocab() IS 'BEFORE INSERT/UPDATE: validates (column, domain) argument pairs against status_vocab.';

-- events_immutable(): the events table is append-only.
CREATE OR REPLACE FUNCTION public.events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. System tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tenants (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  name        text        NOT NULL,
  slug        text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.tenants IS 'One row per company (FHI today). Every other row carries tenant_id.';

CREATE TABLE IF NOT EXISTS public.tenant_settings (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  key         text        NOT NULL,
  value       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
COMMENT ON TABLE public.tenant_settings IS 'Key/value config per tenant: admin.*, calendar.*, app.*, wo.*, zoho.*, numbering.<kind> = {pattern, scope, pad, yearly_reset}.';
COMMENT ON COLUMN public.tenant_settings.value IS 'jsonb; scalars are stored as JSON scalars (e.g. "global"), lists as arrays, numbering as objects.';

CREATE TABLE IF NOT EXISTS public.status_vocab (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  domain      text        NOT NULL,
  code        text        NOT NULL,
  label       text        NOT NULL,
  sort_order  smallint    NOT NULL DEFAULT 0,
  is_default  boolean     NOT NULL DEFAULT false,
  is_terminal boolean     NOT NULL DEFAULT false,
  is_auto     boolean     NOT NULL DEFAULT false,
  is_closed   boolean     NOT NULL DEFAULT false,
  color       text        NULL,
  meta        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, domain, code)
);
COMMENT ON TABLE public.status_vocab IS 'Every status / pick-list vocabulary as rows (never Postgres enums). Status columns hold `code` and are validated by trg_assert_vocab.';
COMMENT ON COLUMN public.status_vocab.code IS 'The exact wire value (e.g. "Ready for Billing", "Installed (From Stock)", "internal").';
COMMENT ON COLUMN public.status_vocab.is_terminal IS 'Done set: item DONE statuses, todo Completed, wo Closed.';
COMMENT ON COLUMN public.status_vocab.is_auto IS 'wo_status rows derived from the calendar (Not Scheduled / Scheduled / Needs Reschedule).';
COMMENT ON COLUMN public.status_vocab.is_closed IS 'action_item_status closed-type rows; wo Closed.';
COMMENT ON COLUMN public.status_vocab.meta IS 'e.g. {"installed":true}, {"lifecycle":"billing"}, {"alias_of":"Closed"}.';

CREATE TABLE IF NOT EXISTS public.field_definitions (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  entity      text        NOT NULL,
  key         text        NOT NULL,
  label       text        NOT NULL,
  type        text        NOT NULL,
  options     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  required    boolean     NOT NULL DEFAULT false,
  sort_order  smallint    NOT NULL DEFAULT 0,
  visible     boolean     NOT NULL DEFAULT true,
  group_name  text        NULL,
  help_text   text        NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key),
  CONSTRAINT field_definitions_type_check CHECK (type IN (
    'text','number','date','datetime','boolean','picklist','multipicklist',
    'url','phone','email','lookup','currency','textarea'
  ))
);
COMMENT ON TABLE public.field_definitions IS 'Tenant-defined custom fields (§8.11). Values live in each domain table''s `custom` jsonb keyed by `key`; genesis-api validates writes against these rows.';
COMMENT ON COLUMN public.field_definitions.entity IS 'Domain table name the field belongs to (e.g. "work_orders", "contacts").';
COMMENT ON COLUMN public.field_definitions.options IS 'For picklist/multipicklist: JSON array of option strings or {value,label} objects. For lookup: {"entity": "..."}.';
COMMENT ON COLUMN public.field_definitions.group_name IS 'Display group (the model spells this `group`; renamed because GROUP is a reserved word).';

CREATE TABLE IF NOT EXISTS public.sequences (
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  kind        text        NOT NULL,
  scope_key   text        NOT NULL DEFAULT 'global',
  year        smallint    NOT NULL DEFAULT 0,
  next        int         NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, scope_key, year)
);
COMMENT ON TABLE public.sequences IS 'Atomic counters behind public keys. kind = work_order | project | deal | ...; scope_key = ''global'' or a project public_key; year = 0 when the kind does not reset yearly.';
COMMENT ON COLUMN public.sequences.next IS 'The NEXT value to hand out (never the last one). next_public_key() advances it in one statement.';

CREATE TABLE IF NOT EXISTS public.external_ids (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  entity      text        NOT NULL,
  entity_id   uuid        NOT NULL,
  system      text        NOT NULL,
  external_id text        NOT NULL,
  synced_at   timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, system, external_id),
  UNIQUE (tenant_id, entity, entity_id, system)
);
COMMENT ON TABLE public.external_ids IS 'The ONLY place a foreign system''s id (Zoho, Google, Books, CompanyCam, Drive) is stored. URLs stay on domain rows; ids come here.';
COMMENT ON COLUMN public.external_ids.entity IS 'Singular entity name: project, work_order, wo_task, visit, calendar, item, material, todo, user, action_item, action_item_comment, forum, forum_category, forum_comment, contact, account, deal, file, daily_report.';
COMMENT ON COLUMN public.external_ids.system IS 'e.g. zoho_projects_project, zoho_projects_task_action, zoho_projects_user, zoho_crm_contact, google_calendar_calendar, google_calendar_event, google_drive_folder.';

CREATE TABLE IF NOT EXISTS public.events (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  entity          text        NOT NULL,
  entity_id       uuid        NULL,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actor           text        NULL,
  idempotency_key text        NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_key_uidx
  ON public.events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
COMMENT ON TABLE public.events IS 'Append-only audit/event log (Cliq posts, calendar reconcile details, status transitions, gate refusals). UPDATE/DELETE are blocked by trigger and revoked.';
COMMENT ON COLUMN public.events.event_type IS 'Dotted verb, e.g. work_order.created, visit.calendar_failed, item.requested, daily_report.sent, reminder.fired.';
COMMENT ON COLUMN public.events.actor IS 'User email, or system:cron / system:migration.';
COMMENT ON COLUMN public.events.idempotency_key IS 'Optional caller-supplied key; unique per tenant so retried webhooks/jobs do not double-log.';
COMMENT ON COLUMN public.events.occurred_at IS 'When the thing happened (may be back-dated by migration); created_at is when the row was written.';

DROP TRIGGER IF EXISTS trg_events_immutable ON public.events;
CREATE TRIGGER trg_events_immutable
  BEFORE UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_immutable();

CREATE TABLE IF NOT EXISTS public.integration_credentials (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  system      text        NOT NULL,
  ciphertext  bytea       NOT NULL,
  key_id      text        NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, system)
);
COMMENT ON TABLE public.integration_credentials IS 'Encrypted OAuth material written by /setup (google, zoho). Encrypted by genesis-api before insert (e.g. pgp_sym_encrypt); the DB never sees plaintext.';
COMMENT ON COLUMN public.integration_credentials.key_id IS 'Identifier of the encryption key used, so keys can be rotated.';

-- -----------------------------------------------------------------------------
-- 3. Users (unified: technicians / people / portal users → users + user_roles)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.users (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id      uuid        NOT NULL REFERENCES public.tenants(id),
  name           text        NOT NULL,
  email          text        NULL,
  active         boolean     NOT NULL DEFAULT true,
  zoho_user      text        NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz NULL,
  schema_version int         NOT NULL DEFAULT 1,
  custom         jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_uidx
  ON public.users (tenant_id, lower(email)) WHERE email IS NOT NULL AND email <> '' AND deleted_at IS NULL;
COMMENT ON TABLE public.users IS 'ONE people table (§8.6): technicians, to-do assignees ("people"), portal users, owners. Roles live in user_roles; /technicians and /people read v_technicians / v_people.';
COMMENT ON COLUMN public.users.email IS 'Lower-cased by the API. Required for the technician role (enforced by the API, not here — people rows may have none).';
COMMENT ON COLUMN public.users.zoho_user IS 'Legacy Person.zohoUser: the Zoho Projects pick-list LABEL chosen from admin.zoho_user_options (a label, not an id).';

CREATE TABLE IF NOT EXISTS public.user_roles (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id),
  user_id     uuid        NOT NULL REFERENCES public.users(id),
  role        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, role)
);
COMMENT ON TABLE public.user_roles IS 'Role categories per user. Roles are TENANT-CUSTOM rows in status_vocab domain user_role (prefilled: technician, office, admin, sales); clients add their own from the Setup page.';

-- -----------------------------------------------------------------------------
-- 4. CRM: accounts, contacts (deals follow projects because deals.project_id)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.accounts (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id      uuid        NOT NULL REFERENCES public.tenants(id),
  name           text        NOT NULL,
  owner_user_id  uuid        NULL REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz NULL,
  schema_version int         NOT NULL DEFAULT 1,
  custom         jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.accounts IS 'Zoho CRM Accounts (§8.2: name + custom jsonb + external_ids only; no Accounts field export exists yet).';

CREATE TABLE IF NOT EXISTS public.contacts (
  id                        uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id                 uuid        NOT NULL REFERENCES public.tenants(id),
  owner_user_id             uuid        NULL REFERENCES public.users(id),
  lead_source               text        NULL,
  first_name                text        NULL,
  last_name                 text        NULL,
  full_name                 text        NULL,
  salutation                text        NULL,
  account_id                uuid        NULL REFERENCES public.accounts(id),
  email                     text        NULL,
  title                     text        NULL,
  department                text        NULL,
  phone                     text        NULL,
  home_phone                text        NULL,
  business_phone            text        NULL,
  mobile                    text        NULL,
  date_of_birth             date        NULL,
  created_by_user_id        uuid        NULL REFERENCES public.users(id),
  source_created_at         timestamptz NULL,
  source_modified_at        timestamptz NULL,
  mailing_street            text        NULL,
  mailing_city              text        NULL,
  mailing_state             text        NULL,
  mailing_zip               text        NULL,
  mailing_country           text        NULL,
  other_street              text        NULL,
  other_city                text        NULL,
  other_state               text        NULL,
  other_zip                 text        NULL,
  other_country             text        NULL,
  description               text        NULL,
  twitter                   text        NULL,
  facebook                  text        NULL,
  reporting_to_contact_id   uuid        NULL REFERENCES public.contacts(id),
  drive_folder_url          text        NULL,
  company                   text        NULL,
  lead_type                 text        NULL,
  referred_by_contact_id    uuid        NULL REFERENCES public.contacts(id),
  referred_by_label         text        NULL,
  story_count               text        NULL,
  role                      text        NULL,
  estimated_travel_time     text        NULL,
  lead_referral_contact_id  uuid        NULL REFERENCES public.contacts(id),
  lead_referral_label       text        NULL,
  whatsapp_number           text        NULL,
  google_review_provided    text        NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz NULL,
  schema_version            int         NOT NULL DEFAULT 1,
  custom                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  search_tsv                tsvector    GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      coalesce(full_name, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
      coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(mobile, '') || ' ' ||
      coalesce(home_phone, '') || ' ' || coalesce(business_phone, '') || ' ' || coalesce(company, ''))
  ) STORED
);
COMMENT ON TABLE public.contacts IS 'Zoho CRM Contacts: the 43 mapped fields are columns; the other 49 live in custom jsonb keyed by Zoho api_name; the Zoho id and Drive folder id live in external_ids.';
COMMENT ON COLUMN public.contacts.full_name IS 'Zoho Full_Name stored as-is (Smackdab `name`), not recomputed.';
COMMENT ON COLUMN public.contacts.referred_by_label IS 'Display value of Reffered_By when no contact row matched.';
COMMENT ON COLUMN public.contacts.story_count IS 'Is_It_Single_Story_or_Two_or_More_Story pick-list value.';
COMMENT ON COLUMN public.contacts.custom IS 'Unmapped Zoho fields keyed by api_name (Vendor_Name, Other_Phone, Fax, Tag, twiliosmsextension0__*, ...) plus tenant custom fields per field_definitions.';
COMMENT ON COLUMN public.contacts.search_tsv IS 'FTS over name / email / phones / company (simple config).';

-- -----------------------------------------------------------------------------
-- 5. Service domain
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.projects (
  id                      uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id               uuid        NOT NULL REFERENCES public.tenants(id),
  public_key              text        NOT NULL,
  name                    text        NOT NULL,
  client_name             text        NULL,
  is_service              boolean     NOT NULL DEFAULT true,
  site_address            text        NULL,
  site_city               text        NULL,
  site_state              text        NULL,
  site_zip                text        NULL,
  google_maps_link        text        NULL,
  gate_code               text        NULL,
  community_gate          text        NULL,
  door_code               text        NULL,
  membership_level        text        NULL,
  status                  text        NULL,
  project_group           text        NULL,
  project_type            text        NULL,
  percent_complete        smallint    NULL,
  is_completed            boolean     NOT NULL DEFAULT false,
  new_construction_stage  text        NULL,
  system_upgrades         text        NULL,
  start_date              date        NULL,
  description             text        NULL,
  tags                    text[]      NOT NULL DEFAULT '{}'::text[],
  owner_user_id           uuid        NULL REFERENCES public.users(id),
  created_by_user_id      uuid        NULL REFERENCES public.users(id),
  updated_by_user_id      uuid        NULL REFERENCES public.users(id),
  cliq_channel_url        text        NULL,
  is_public_project       boolean     NOT NULL DEFAULT false,
  is_strict_project       boolean     NOT NULL DEFAULT false,
  source_created_at       timestamptz NULL,
  source_modified_at      timestamptz NULL,
  account_id              uuid        NULL REFERENCES public.accounts(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz NULL,
  schema_version          int         NOT NULL DEFAULT 1,
  custom                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  search_tsv              tsvector    GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      coalesce(public_key, '') || ' ' || coalesce(name, '') || ' ' || coalesce(client_name, '') || ' ' ||
      coalesce(site_address, '') || ' ' || coalesce(site_city, '') || ' ' || coalesce(site_zip, ''))
  ) STORED,
  UNIQUE (tenant_id, public_key)
);
COMMENT ON TABLE public.projects IS 'The client SITE record (one Zoho SERVICE project). public_key = FHI-###.';
COMMENT ON COLUMN public.projects.name IS 'Full Zoho name kept as-is: "Client, Name - Address - SERVICE".';
COMMENT ON COLUMN public.projects.client_name IS 'Materialized at migration by clientOf(name) (text before the first " - "); editable afterwards.';
COMMENT ON COLUMN public.projects.is_service IS 'Stored flag replacing the name-suffix / tag / group heuristic (ZOHO_SERVICE_MATCH_MODE).';
COMMENT ON COLUMN public.projects.membership_level IS 'status_vocab domain membership-type (§8.4).';
COMMENT ON COLUMN public.projects.status IS 'status_vocab domain project_status (Smackdab parity; not consumed by the app).';
COMMENT ON COLUMN public.projects.source_created_at IS 'Zoho''s own created_time; created_at is ours.';
COMMENT ON COLUMN public.projects.account_id IS 'CRM bridge: the account of the deal that produced this site.';

CREATE TABLE IF NOT EXISTS public.work_orders (
  id                   uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id),
  public_key           text        NOT NULL,
  project_id           uuid        NOT NULL REFERENCES public.projects(id),
  wo_year              smallint    NOT NULL,
  wo_seq               int         NOT NULL,
  subject              text        NOT NULL,
  notes                text        NULL,
  priority             text        NULL,
  wo_status            text        NOT NULL DEFAULT 'Not Scheduled',
  billing_status       text        NOT NULL DEFAULT 'Billable',
  wo_type              text        NOT NULL DEFAULT '',
  company_cam_url      text        NULL,
  provision_url        text        NOT NULL DEFAULT '',
  task_list_completed  boolean     NOT NULL DEFAULT false,
  closed_at            timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz NULL,
  schema_version       int         NOT NULL DEFAULT 1,
  custom               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  search_tsv           tsvector    GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      coalesce(public_key, '') || ' ' || coalesce(subject, '') || ' ' || coalesce(notes, ''))
  ) STORED,
  UNIQUE (tenant_id, public_key),
  CONSTRAINT work_orders_wo_seq_check CHECK (wo_seq > 0)
);
COMMENT ON TABLE public.work_orders IS 'One service ticket. public_key = {projectKey}-WO-{YYYY}-{seq4} minted by mint_public_key(); wo_year/wo_seq are the minted parts.';
COMMENT ON COLUMN public.work_orders.subject IS 'CLEAN subject (the legacy "WO-2026-0017 - " Zoho title prefix is never stored).';
COMMENT ON COLUMN public.work_orders.notes IS 'Action-task description after cleanNotes() (legacy visit trailers stripped).';
COMMENT ON COLUMN public.work_orders.priority IS 'status_vocab task_priority: none|low|medium|high; NULL when unset.';
COMMENT ON COLUMN public.work_orders.wo_status IS 'Stored cycle status (status_vocab wo_status). Legacy inputs are normalized by the API on write: Completed→Closed, Needs Rescheduled→Needs Reschedule.';
COMMENT ON COLUMN public.work_orders.billing_status IS 'status_vocab billing_status: Billable | Non-Billable | Internal. WorkOrder.billable = (billing_status = ''Billable'').';
COMMENT ON COLUMN public.work_orders.wo_type IS 'status_vocab wo_type; '''' = unset (kept as empty string to match today''s wire value).';
COMMENT ON COLUMN public.work_orders.company_cam_url IS 'A URL the user sees (value, not an id). Empty string clears → NULL.';
COMMENT ON COLUMN public.work_orders.provision_url IS 'Always a string on the wire ("" when unset).';
COMMENT ON COLUMN public.work_orders.task_list_completed IS 'Whole-ticket closed override (was Zoho tasklist.isCompleted); set true when wo_status = Closed.';

CREATE TABLE IF NOT EXISTS public.wo_tasks (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  work_order_id   uuid        NOT NULL REFERENCES public.work_orders(id),
  kind            text        NOT NULL,
  parent_task_id  uuid        NULL REFERENCES public.wo_tasks(id),
  name            text        NOT NULL,
  task_status     text        NOT NULL DEFAULT 'Pending',
  position        smallint    NOT NULL DEFAULT 0,
  completed_at    timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS wo_tasks_one_work_uidx
  ON public.wo_tasks (work_order_id) WHERE kind = 'work' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wo_tasks_one_billing_uidx
  ON public.wo_tasks (work_order_id) WHERE kind = 'billing' AND deleted_at IS NULL;
COMMENT ON TABLE public.wo_tasks IS 'The WO checklist: exactly one kind=work ("Work Order Tasks"), at most one kind=billing ("Billing"), and kind=step subtasks under the work task.';
COMMENT ON COLUMN public.wo_tasks.kind IS 'status_vocab wo_task_kind: work | billing | step.';
COMMENT ON COLUMN public.wo_tasks.task_status IS 'status_vocab task_status: Pending | Completed. isCompleted = (task_status = ''Completed'').';

CREATE TABLE IF NOT EXISTS public.calendars (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  name            text        NOT NULL,
  is_default      boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS calendars_one_default_uidx
  ON public.calendars (tenant_id) WHERE is_default AND deleted_at IS NULL;
COMMENT ON TABLE public.calendars IS 'Google calendars visits are booked on. The Google address (e.g. notifications@fhiflorida.com) lives in external_ids(system=google_calendar_calendar).';

CREATE TABLE IF NOT EXISTS public.todos (
  id                   uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id),
  work_order_id        uuid        NOT NULL REFERENCES public.work_orders(id),
  title                text        NOT NULL,
  status               text        NOT NULL DEFAULT 'Open',
  urgency              text        NULL,
  assignee_name        text        NULL,
  assignee_user_id     uuid        NULL REFERENCES public.users(id),
  notes                text        NULL,
  closed_at            timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz NULL,
  schema_version       int         NOT NULL DEFAULT 1,
  custom               jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.todos IS 'Per-WO to-dos / action items (Todo). Central board GET /todos.';
COMMENT ON COLUMN public.todos.status IS 'status_vocab todo_status: Open | Awaiting Feedback | On-Hold | Completed.';
COMMENT ON COLUMN public.todos.urgency IS 'status_vocab task_priority (none|low|medium|high).';
COMMENT ON COLUMN public.todos.assignee_name IS 'Free text preserved exactly (wire `assignee`); assignee_user_id is a convenience match against users (was assignee_person_id).';

CREATE TABLE IF NOT EXISTS public.visits (
  id               uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id        uuid        NOT NULL REFERENCES public.tenants(id),
  work_order_id    uuid        NOT NULL REFERENCES public.work_orders(id),
  starts_at        timestamptz NULL,
  ends_at          timestamptz NULL,
  label            text        NULL,
  calendar_id      uuid        NULL REFERENCES public.calendars(id),
  html_link        text        NULL,
  confirmed        boolean     NOT NULL DEFAULT true,
  confirm_todo_id  uuid        NULL REFERENCES public.todos(id),
  remote           boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz NULL,
  schema_version   int         NOT NULL DEFAULT 1,
  custom           jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.visits IS 'Scheduled visits, one per Google Calendar event. Google event id lives in external_ids(system=google_calendar_event).';
COMMENT ON COLUMN public.visits.starts_at IS 'NULL allowed (legacy date-less visits).';
COMMENT ON COLUMN public.visits.html_link IS 'Google event htmlLink — a URL shown to users, not an id.';
COMMENT ON COLUMN public.visits.confirmed IS 'false = TENTATIVE (marker p).';

CREATE TABLE IF NOT EXISTS public.visit_attendees (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  visit_id        uuid        NOT NULL REFERENCES public.visits(id),
  email           text        NOT NULL,
  technician_id   uuid        NULL REFERENCES public.users(id),
  position        smallint    NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.visit_attendees IS 'Guest emails per visit (Visit.attendees[]), in order; technician_id back-filled by email match against users.';

CREATE TABLE IF NOT EXISTS public.items (
  id              uuid          PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid          NOT NULL REFERENCES public.tenants(id),
  work_order_id   uuid          NOT NULL REFERENCES public.work_orders(id),
  name            text          NOT NULL,
  quantity        numeric(12,3) NULL,
  note            text          NULL,
  status          text          NOT NULL DEFAULT 'Needed',
  closed_at       timestamptz   NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  deleted_at      timestamptz   NULL,
  schema_version  int           NOT NULL DEFAULT 1,
  custom          jsonb         NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.items IS 'Unified Items (requested + used, §8.1 — used_items retired and folded in). Serialized as PurchaseItem / Item.';
COMMENT ON COLUMN public.items.status IS 'status_vocab item_status (order_status): archived = closed_at IS NOT NULL OR vocab.is_terminal.';

CREATE TABLE IF NOT EXISTS public.materials (
  id                 uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id          uuid        NOT NULL REFERENCES public.tenants(id),
  work_order_id      uuid        NOT NULL REFERENCES public.work_orders(id),
  name               text        NOT NULL,
  notes              text        NULL,
  from_request       boolean     NOT NULL DEFAULT false,
  source_item_label  text        NULL,
  source_item_id     uuid        NULL REFERENCES public.items(id),
  completed_at       timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz NULL,
  schema_version     int         NOT NULL DEFAULT 1,
  custom             jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.materials IS 'S11 Materials list per WO (manual or auto-mirrored from an item request). completed = completed_at IS NOT NULL.';
COMMENT ON COLUMN public.materials.source_item_label IS 'Material.sourceItem display text ("<item> ×<qty>").';

CREATE TABLE IF NOT EXISTS public.hours_entries (
  id              uuid         PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid         NOT NULL REFERENCES public.tenants(id),
  work_order_id   uuid         NOT NULL REFERENCES public.work_orders(id),
  position        int          NOT NULL,
  tech            text         NULL,
  technician_id   uuid         NULL REFERENCES public.users(id),
  hours           numeric(6,2) NOT NULL,
  logged_at       timestamptz  NOT NULL DEFAULT now(),
  note            text         NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  deleted_at      timestamptz  NULL,
  schema_version  int          NOT NULL DEFAULT 1,
  custom          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT hours_entries_hours_check CHECK (hours >= 0),
  CONSTRAINT hours_entries_position_uniq UNIQUE (work_order_id, position) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE public.hours_entries IS 'Time logged against a WO (WorkOrder.hours.entries[]); routes address entries by index → position (gap-free per WO, re-packed on delete).';
COMMENT ON COLUMN public.hours_entries.tech IS 'Tech email as entered (LogHoursInput.techEmail).';
COMMENT ON COLUMN public.hours_entries.logged_at IS 'LogHoursInput.date ?? now(); date-only inputs normalized to midnight America/New_York by the API.';

CREATE TABLE IF NOT EXISTS public.files (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  entity          text        NOT NULL,
  entity_id       uuid        NULL,
  kind            text        NOT NULL,
  filename        text        NOT NULL,
  content_type    text        NOT NULL DEFAULT 'application/octet-stream',
  byte_size       int         NOT NULL DEFAULT 0,
  bytes           bytea       NULL,
  storage_key     text        NULL,
  drive_url       text        NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.files IS 'Blob store: daily-report PDFs (bytes) today; photos/attachments later (storage_key for object storage; drive_url a value, Drive id in external_ids).';
COMMENT ON COLUMN public.files.entity IS 'Polymorphic owner: daily_report | work_order | forum_comment | action_item | contact | deal.';
COMMENT ON COLUMN public.files.kind IS 'daily_report_pdf | cumulative_pdf | attachment | photo.';

CREATE TABLE IF NOT EXISTS public.daily_reports (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  work_order_id   uuid        NOT NULL REFERENCES public.work_orders(id),
  report_date     date        NULL,
  sent_at         timestamptz NULL,
  pdf_file_id     uuid        NULL REFERENCES public.files(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS daily_reports_wo_date_uidx
  ON public.daily_reports (work_order_id, report_date) WHERE report_date IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS daily_reports_wo_cumulative_uidx
  ON public.daily_reports (work_order_id) WHERE report_date IS NULL AND deleted_at IS NULL;
COMMENT ON TABLE public.daily_reports IS 'One row per WO + day; the row with report_date NULL is the "cumulative" pseudo-day. sent = sent_at IS NOT NULL.';

CREATE TABLE IF NOT EXISTS public.daily_report_entries (
  id               uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id        uuid        NOT NULL REFERENCES public.tenants(id),
  daily_report_id  uuid        NOT NULL REFERENCES public.daily_reports(id),
  position         int         NOT NULL,
  tech             text        NULL,
  text             text        NOT NULL,
  noted_at         timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz NULL,
  schema_version   int         NOT NULL DEFAULT 1,
  custom           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT daily_report_entries_position_uniq UNIQUE (daily_report_id, position) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE public.daily_report_entries IS 'Dated notes of a daily report (DailyReportEntry); addressed by index → position, gap-free per day.';

CREATE TABLE IF NOT EXISTS public.action_items (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id           uuid        NOT NULL REFERENCES public.tenants(id),
  public_key          text        NULL,
  project_id          uuid        NULL REFERENCES public.projects(id),
  title               text        NOT NULL,
  description         text        NULL,
  flag                text        NOT NULL DEFAULT 'Internal',
  status              text        NOT NULL,
  assignee_user_id    uuid        NULL REFERENCES public.users(id),
  source_created_at   timestamptz NULL,
  source_updated_at   timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz NULL,
  schema_version      int         NOT NULL DEFAULT 1,
  custom              jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS action_items_public_key_uidx
  ON public.action_items (tenant_id, public_key) WHERE public_key IS NOT NULL;
COMMENT ON TABLE public.action_items IS 'Project-level Action Items (Zoho Issues). project_id nullable (§8.7). Statuses are tenant-wide status_vocab domain action_item_status.';
COMMENT ON COLUMN public.action_items.public_key IS 'Zoho issue prefix (e.g. SK1-I2) on migrated rows; minted from numbering.action_item later.';
COMMENT ON COLUMN public.action_items.flag IS 'status_vocab action_item_flag: Internal | External.';
COMMENT ON COLUMN public.action_items.status IS 'status_vocab action_item_status code. closed = vocab.is_closed; wire statusId = status_vocab.id, statusName = label.';

CREATE TABLE IF NOT EXISTS public.action_item_comments (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id           uuid        NOT NULL REFERENCES public.tenants(id),
  action_item_id      uuid        NOT NULL REFERENCES public.action_items(id),
  content             text        NOT NULL,
  added_by_user_id    uuid        NULL REFERENCES public.users(id),
  added_person_name   text        NULL,
  source_added_at     timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz NULL,
  schema_version      int         NOT NULL DEFAULT 1,
  custom              jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.action_item_comments IS 'Comments on an action item (IssueComment). added_person_name kept for migrated rows with no user match.';

CREATE TABLE IF NOT EXISTS public.reminders (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  action_item_id  uuid        NOT NULL REFERENCES public.action_items(id),
  remind_at       timestamptz NOT NULL,
  message         text        NULL,
  fired_at        timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_action_item_uidx
  ON public.reminders (action_item_id) WHERE deleted_at IS NULL;
COMMENT ON TABLE public.reminders IS 'One reminder per action item; fired = fired_at IS NOT NULL (firing also writes events reminder.fired).';

CREATE TABLE IF NOT EXISTS public.forum_categories (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),
  project_id      uuid        NOT NULL REFERENCES public.projects(id),
  name            text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz NULL,
  schema_version  int         NOT NULL DEFAULT 1,
  custom          jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.forum_categories IS 'Forum categories per project (ForumCategory): General, Internal, Service Call Template, ...';

CREATE TABLE IF NOT EXISTS public.forums (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id           uuid        NOT NULL REFERENCES public.tenants(id),
  project_id          uuid        NOT NULL REFERENCES public.projects(id),
  category_id         uuid        NULL REFERENCES public.forum_categories(id),
  name                text        NOT NULL,
  content             text        NOT NULL DEFAULT '',
  flag                text        NOT NULL DEFAULT 'internal',
  type                text        NOT NULL DEFAULT 'normal',
  posted_by_user_id   uuid        NULL REFERENCES public.users(id),
  posted_person_name  text        NULL,
  posted_at           timestamptz NULL,
  last_activity_at    timestamptz NULL,
  is_sticky           boolean     NOT NULL DEFAULT false,
  is_announcement     boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz NULL,
  schema_version      int         NOT NULL DEFAULT 1,
  custom              jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.forums IS 'Project-level conversations / site Notes & Credentials (Forum). content is HTML/rich text as Zoho returned it.';
COMMENT ON COLUMN public.forums.flag IS 'status_vocab forum_flag: internal | external.';
COMMENT ON COLUMN public.forums.type IS 'status_vocab forum_type: normal | question.';
COMMENT ON COLUMN public.forums.last_activity_at IS 'Maintained by the API on comment insert (list sort key).';

CREATE TABLE IF NOT EXISTS public.forum_comments (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id           uuid        NOT NULL REFERENCES public.tenants(id),
  forum_id            uuid        NOT NULL REFERENCES public.forums(id),
  parent_comment_id   uuid        NULL REFERENCES public.forum_comments(id),
  root_comment_id     uuid        NULL REFERENCES public.forum_comments(id),
  level               smallint    NOT NULL DEFAULT 1,
  content             text        NOT NULL,
  type                text        NOT NULL DEFAULT 'normal',
  posted_by_user_id   uuid        NULL REFERENCES public.users(id),
  posted_person_name  text        NULL,
  posted_at           timestamptz NULL,
  is_best_answer      boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz NULL,
  schema_version      int         NOT NULL DEFAULT 1,
  custom              jsonb       NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.forum_comments IS 'Threaded forum comments (ForumComment). root_comment_id / level are set by the API on insert (level = parent.level + 1).';
COMMENT ON COLUMN public.forum_comments.type IS 'status_vocab forum_comment_type: normal | question | answer.';

CREATE TABLE IF NOT EXISTS public.deals (
  id                             uuid          PRIMARY KEY DEFAULT public.uuidv7(),
  tenant_id                      uuid          NOT NULL REFERENCES public.tenants(id),
  name                           text          NOT NULL,
  owner_user_id                  uuid          NULL REFERENCES public.users(id),
  created_by_user_id             uuid          NULL REFERENCES public.users(id),
  source_created_at              timestamptz   NULL,
  source_modified_at             timestamptz   NULL,
  account_id                     uuid          NULL REFERENCES public.accounts(id),
  contact_id                     uuid          NULL REFERENCES public.contacts(id),
  project_id                     uuid          NULL REFERENCES public.projects(id),
  amount                         numeric(14,2) NULL,
  anticipated_amount             numeric(14,2) NULL,
  expected_revenue               numeric(14,2) NULL,
  closing_date                   date          NULL,
  stage                          text          NULL,
  stage_modified_at              timestamptz   NULL,
  type                           text          NULL,
  deal_type                      text          NULL,
  probability                    smallint      NULL,
  next_step                      text          NULL,
  lead_source                    text          NULL,
  lead_type                      text          NULL,
  description                    text          NULL,
  referred_by_contact_id         uuid          NULL REFERENCES public.contacts(id),
  referred_by_label              text          NULL,
  service_order_number           text          NULL,
  site_address                   text          NULL,
  site_city                      text          NULL,
  site_state                     text          NULL,
  site_zip                       text          NULL,
  lot_number                     int           NULL,
  google_maps_link               text          NULL,
  new_or_existing_construction   text          NULL,
  construction_phase             text          NULL,
  product_category               text[]        NULL,
  project_complexity             int           NULL,
  site_survey_required           boolean       NULL,
  drawings_needed                boolean       NULL,
  reason_lost                    text          NULL,
  estimated_day_1                date          NULL,
  deal_closing                   date          NULL,
  deal_registration              date          NULL,
  estimated_sign_date            date          NULL,
  preferred_membership           text          NULL,
  presold_membership             text          NULL,
  membership_sales_notes         text          NULL,
  cpp_level                      text          NULL,
  cpp_term                       text          NULL,
  drive_folder_url               text          NULL,
  budget                         text          NULL,
  role                           text          NULL,
  expected_finish_window         text          NULL,
  start_window                   text          NULL,
  created_at                     timestamptz   NOT NULL DEFAULT now(),
  updated_at                     timestamptz   NOT NULL DEFAULT now(),
  deleted_at                     timestamptz   NULL,
  schema_version                 int           NOT NULL DEFAULT 1,
  custom                         jsonb         NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS deals_service_order_number_uidx
  ON public.deals (tenant_id, service_order_number) WHERE service_order_number IS NOT NULL;
COMMENT ON TABLE public.deals IS 'Zoho CRM Deals, first-class (§8.3): 49 mapped columns + Drive folder id in external_ids; the other 38 fields in custom jsonb keyed by api_name.';
COMMENT ON COLUMN public.deals.project_id IS 'CRM bridge: the site (FHI-###) this deal produced; filled by migration on address/account match, else linked by the office.';
COMMENT ON COLUMN public.deals.stage IS 'status_vocab deal_stage (harvested at migration, §8.8).';
COMMENT ON COLUMN public.deals.preferred_membership IS 'status_vocab membership-type (shared with projects.membership_level).';
COMMENT ON COLUMN public.deals.service_order_number IS 'Zoho Service_Order_Number ("SO Number"); unique per tenant when set.';
COMMENT ON COLUMN public.deals.custom IS 'Unmapped Zoho fields keyed by api_name (Deal_Address_*, Campaign_Source, twiliosmsextension0__*, ...) plus tenant custom fields.';

-- -----------------------------------------------------------------------------
-- 6. Vocabulary validation triggers (data validation only)
--    Argument pairs: column, domain, column, domain, ...
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_vocab ON public.user_roles;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab('role', 'user_role');

DROP TRIGGER IF EXISTS trg_vocab ON public.projects;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'membership_level', 'membership-type',
    'status', 'project_status',
    'project_group', 'project_group',
    'project_type', 'project_type');

DROP TRIGGER IF EXISTS trg_vocab ON public.work_orders;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'priority', 'task_priority',
    'wo_status', 'wo_status',
    'billing_status', 'billing_status',
    'wo_type', 'wo_type');

DROP TRIGGER IF EXISTS trg_vocab ON public.wo_tasks;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.wo_tasks
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'kind', 'wo_task_kind',
    'task_status', 'task_status');

DROP TRIGGER IF EXISTS trg_vocab ON public.items;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab('status', 'item_status');

DROP TRIGGER IF EXISTS trg_vocab ON public.todos;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.todos
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'status', 'todo_status',
    'urgency', 'task_priority');

DROP TRIGGER IF EXISTS trg_vocab ON public.action_items;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.action_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'flag', 'action_item_flag',
    'status', 'action_item_status');

DROP TRIGGER IF EXISTS trg_vocab ON public.forums;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.forums
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'flag', 'forum_flag',
    'type', 'forum_type');

DROP TRIGGER IF EXISTS trg_vocab ON public.forum_comments;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.forum_comments
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab('type', 'forum_comment_type');

DROP TRIGGER IF EXISTS trg_vocab ON public.contacts;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'lead_source', 'lead_source',
    'lead_type', 'lead_type');

DROP TRIGGER IF EXISTS trg_vocab ON public.deals;
CREATE TRIGGER trg_vocab BEFORE INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_assert_vocab(
    'stage', 'deal_stage',
    'deal_type', 'deal_type',
    'lead_source', 'lead_source',
    'lead_type', 'lead_type',
    'preferred_membership', 'membership-type',
    'presold_membership', 'membership-type');

-- -----------------------------------------------------------------------------
-- 7. updated_at triggers + RLS on EVERY public table (driven from the catalog,
--    so a table added later by mistake without these is caught by the lint).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    -- updated_at trigger wherever the column exists
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = 'updated_at'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON public.%I', r.tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
        r.tbl);
    END IF;

    -- RLS: every table
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.tbl);
    IF r.tbl = 'tenants' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON public.tenants '
           || 'USING (id = public.app_tenant_id()) WITH CHECK (id = public.app_tenant_id())';
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = public.app_tenant_id()) WITH CHECK (tenant_id = public.app_tenant_id())',
        r.tbl);
    END IF;
  END LOOP;
END;
$$;

-- events: belt and braces — revoke UPDATE/DELETE from the API-facing roles.
-- (Table owner `postgres` can still ALTER, and the trigger blocks it anyway.)
DO $$
DECLARE
  rl text;
BEGIN
  FOREACH rl IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rl) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.events FROM %I', rl);
    END IF;
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Public-key minting
-- -----------------------------------------------------------------------------

-- next_public_key(): atomic, single-statement counter. Returns the minted
-- value; `sequences.next` is left pointing at the NEXT one. Two concurrent
-- callers serialize on the row lock and never receive the same number. The
-- number is consumed only if the caller's transaction commits (matches today's
-- "no burned numbers" guarantee when called inside the work_orders insert tx).
CREATE OR REPLACE FUNCTION public.next_public_key(
  p_tenant    uuid,
  p_kind      text,
  p_scope_key text,
  p_year      int
)
RETURNS int
LANGUAGE sql
VOLATILE
AS $$
  INSERT INTO public.sequences AS s (tenant_id, kind, scope_key, year, next)
  VALUES (p_tenant, p_kind, coalesce(p_scope_key, 'global'), coalesce(p_year, 0)::smallint, 2)
  ON CONFLICT (tenant_id, kind, scope_key, year)
  DO UPDATE SET next = s.next + 1, updated_at = now()
  RETURNING s.next - 1;
$$;
COMMENT ON FUNCTION public.next_public_key(uuid, text, text, int) IS 'Atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING; returns the minted sequence value for (tenant, kind, scope_key, year).';

-- mint_public_key_parts(): reads tenant_settings key `numbering.<kind>`
--   {"pattern":"{projectKey}-WO-{YYYY}-{seq4}","scope":"global","pad":4,"yearly_reset":true}
-- allocates the next number and formats the pattern. Tokens:
--   {projectKey}  the p_project_key argument
--   {YYYY} {YY}   year (tenant timezone from tenant_settings app.timezone, default America/New_York)
--   {seq}         sequence, zero-padded to `pad` (pad 0 = no padding)
--   {seqN}        sequence, zero-padded to N (e.g. {seq4})
--   {kind}        p_kind
-- Returns (public_key, seq, year) so callers can store wo_year / wo_seq.
CREATE OR REPLACE FUNCTION public.mint_public_key_parts(
  p_tenant      uuid,
  p_kind        text,
  p_project_key text DEFAULT NULL
)
RETURNS TABLE (public_key text, seq int, year int)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_cfg        jsonb;
  v_pattern    text;
  v_scope      text;
  v_pad        int;
  v_yearly     boolean;
  v_tz         text;
  v_year       int;
  v_scope_key  text;
  v_seq        int;
  v_out        text;
  v_m          text[];
BEGIN
  SELECT ts.value INTO v_cfg
  FROM public.tenant_settings ts
  WHERE ts.tenant_id = p_tenant AND ts.key = 'numbering.' || p_kind;

  IF v_cfg IS NULL THEN
    RAISE EXCEPTION 'no numbering pattern configured: tenant_settings key "numbering.%" is missing for tenant %', p_kind, p_tenant
      USING ERRCODE = 'no_data_found';
  END IF;

  v_pattern := v_cfg ->> 'pattern';
  v_scope   := coalesce(v_cfg ->> 'scope', 'global');
  v_pad     := coalesce((v_cfg ->> 'pad')::int, 0);
  v_yearly  := coalesce((v_cfg ->> 'yearly_reset')::boolean, false);

  IF v_pattern IS NULL OR v_pattern = '' THEN
    RAISE EXCEPTION 'numbering.% has no "pattern"', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT coalesce(ts.value #>> '{}', 'America/New_York') INTO v_tz
  FROM public.tenant_settings ts
  WHERE ts.tenant_id = p_tenant AND ts.key = 'app.timezone';
  v_tz := coalesce(v_tz, 'America/New_York');

  v_year := extract(year FROM (now() AT TIME ZONE v_tz))::int;

  IF v_scope = 'per_project' THEN
    IF p_project_key IS NULL OR p_project_key = '' THEN
      RAISE EXCEPTION 'numbering.% is scoped per_project but no project key was given', p_kind
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_scope_key := p_project_key;
  ELSE
    v_scope_key := 'global';
  END IF;

  v_seq := public.next_public_key(p_tenant, p_kind, v_scope_key, CASE WHEN v_yearly THEN v_year ELSE 0 END);

  v_out := v_pattern;
  v_out := replace(v_out, '{projectKey}', coalesce(p_project_key, ''));
  v_out := replace(v_out, '{kind}', p_kind);
  v_out := replace(v_out, '{YYYY}', v_year::text);
  v_out := replace(v_out, '{YY}', lpad((v_year % 100)::text, 2, '0'));
  -- {seqN}
  FOR v_m IN SELECT regexp_matches(v_pattern, '\{seq(\d+)\}', 'g') LOOP
    v_out := replace(v_out, '{seq' || v_m[1] || '}', lpad(v_seq::text, v_m[1]::int, '0'));
  END LOOP;
  -- {seq}
  IF v_pad > 0 THEN
    v_out := replace(v_out, '{seq}', lpad(v_seq::text, v_pad, '0'));
  ELSE
    v_out := replace(v_out, '{seq}', v_seq::text);
  END IF;

  public_key := v_out;
  seq        := v_seq;
  year       := v_year;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.mint_public_key_parts(uuid, text, text) IS 'Allocates and formats a public key from tenant_settings numbering.<kind>; returns (public_key, seq, year).';

CREATE OR REPLACE FUNCTION public.mint_public_key(
  p_tenant      uuid,
  p_kind        text,
  p_project_key text DEFAULT NULL
)
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT m.public_key FROM public.mint_public_key_parts(p_tenant, p_kind, p_project_key) m;
$$;
COMMENT ON FUNCTION public.mint_public_key(uuid, text, text) IS 'mint_public_key_parts() returning only the formatted key, e.g. FHI-672-WO-2026-0001.';

-- -----------------------------------------------------------------------------
-- 9. Pure derivation helpers (no data changes)
-- -----------------------------------------------------------------------------

-- normalize_wo_status(): the legacy-label normalization from service.ts
-- (Completed → Closed, Needs Rescheduled → Needs Reschedule). Used by the views
-- so a migrated legacy value still derives correctly.
CREATE OR REPLACE FUNCTION public.normalize_wo_status(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE btrim(coalesce(p, ''))
           WHEN 'Completed'        THEN 'Closed'
           WHEN 'Needs Rescheduled' THEN 'Needs Reschedule'
           ELSE btrim(coalesce(p, ''))
         END;
$$;

-- -----------------------------------------------------------------------------
-- 10. Indexes
-- -----------------------------------------------------------------------------

-- tenant_id on everything that has it
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name AS tbl
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND pc.relkind = 'r'
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)', r.tbl || '_tenant_idx', r.tbl);
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS external_ids_entity_idx        ON public.external_ids (tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS events_entity_idx              ON public.events (tenant_id, entity, entity_id, created_at);
CREATE INDEX IF NOT EXISTS events_type_idx                ON public.events (tenant_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS status_vocab_domain_idx        ON public.status_vocab (tenant_id, domain, sort_order);
CREATE INDEX IF NOT EXISTS field_definitions_entity_idx   ON public.field_definitions (tenant_id, entity, sort_order);
CREATE INDEX IF NOT EXISTS user_roles_user_idx            ON public.user_roles (user_id);
CREATE INDEX IF NOT EXISTS user_roles_role_idx            ON public.user_roles (tenant_id, role);
CREATE INDEX IF NOT EXISTS projects_service_idx           ON public.projects (tenant_id, is_service) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_account_idx           ON public.projects (account_id);
CREATE INDEX IF NOT EXISTS projects_search_idx            ON public.projects USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS work_orders_project_idx        ON public.work_orders (project_id);
CREATE INDEX IF NOT EXISTS work_orders_status_idx         ON public.work_orders (tenant_id, wo_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS work_orders_created_idx        ON public.work_orders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS work_orders_search_idx         ON public.work_orders USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS wo_tasks_wo_idx                ON public.wo_tasks (work_order_id, kind);
CREATE INDEX IF NOT EXISTS wo_tasks_parent_idx            ON public.wo_tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS visits_wo_idx                  ON public.visits (work_order_id, starts_at);
CREATE INDEX IF NOT EXISTS visits_calendar_idx            ON public.visits (calendar_id);
CREATE INDEX IF NOT EXISTS visits_starts_idx              ON public.visits (tenant_id, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visit_attendees_visit_idx      ON public.visit_attendees (visit_id, position);
CREATE INDEX IF NOT EXISTS items_wo_idx                   ON public.items (work_order_id);
CREATE INDEX IF NOT EXISTS items_status_idx               ON public.items (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS materials_wo_idx               ON public.materials (work_order_id);
CREATE INDEX IF NOT EXISTS materials_source_item_idx      ON public.materials (source_item_id);
CREATE INDEX IF NOT EXISTS todos_wo_idx                   ON public.todos (work_order_id);
CREATE INDEX IF NOT EXISTS todos_status_idx               ON public.todos (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS todos_assignee_idx             ON public.todos (assignee_user_id);
CREATE INDEX IF NOT EXISTS hours_entries_wo_idx           ON public.hours_entries (work_order_id, position);
CREATE INDEX IF NOT EXISTS files_entity_idx               ON public.files (tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS daily_reports_wo_idx           ON public.daily_reports (work_order_id, report_date);
CREATE INDEX IF NOT EXISTS daily_report_entries_dr_idx    ON public.daily_report_entries (daily_report_id, position);
CREATE INDEX IF NOT EXISTS action_items_project_idx       ON public.action_items (project_id);
CREATE INDEX IF NOT EXISTS action_items_status_idx        ON public.action_items (tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS action_items_assignee_idx      ON public.action_items (assignee_user_id);
CREATE INDEX IF NOT EXISTS action_item_comments_ai_idx    ON public.action_item_comments (action_item_id, created_at);
CREATE INDEX IF NOT EXISTS reminders_due_idx              ON public.reminders (tenant_id, remind_at) WHERE fired_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS forum_categories_project_idx   ON public.forum_categories (project_id);
CREATE INDEX IF NOT EXISTS forums_project_idx             ON public.forums (project_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS forums_category_idx            ON public.forums (category_id);
CREATE INDEX IF NOT EXISTS forum_comments_forum_idx       ON public.forum_comments (forum_id, posted_at);
CREATE INDEX IF NOT EXISTS forum_comments_parent_idx      ON public.forum_comments (parent_comment_id);
CREATE INDEX IF NOT EXISTS forum_comments_root_idx        ON public.forum_comments (root_comment_id);
CREATE INDEX IF NOT EXISTS contacts_account_idx           ON public.contacts (account_id);
CREATE INDEX IF NOT EXISTS contacts_email_idx             ON public.contacts (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS contacts_search_idx            ON public.contacts USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS deals_account_idx              ON public.deals (account_id);
CREATE INDEX IF NOT EXISTS deals_contact_idx              ON public.deals (contact_id);
CREATE INDEX IF NOT EXISTS deals_project_idx              ON public.deals (project_id);
CREATE INDEX IF NOT EXISTS deals_stage_idx                ON public.deals (tenant_id, stage) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 11. Views (§5) — pure SQL derivations, security_invoker so RLS applies.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_work_order_hours
WITH (security_invoker = true) AS
SELECT
  h.work_order_id,
  round(sum(h.hours), 2)::numeric(10,2) AS total,
  count(*)::int                         AS entry_count
FROM public.hours_entries h
WHERE h.deleted_at IS NULL
GROUP BY h.work_order_id;
COMMENT ON VIEW public.v_work_order_hours IS 'WorkOrder.hours.total = round(sum(hours), 2) per WO.';

CREATE OR REPLACE VIEW public.v_work_order_schedule
WITH (security_invoker = true) AS
SELECT DISTINCT ON (v.work_order_id)
  v.work_order_id,
  v.id                                            AS visit_id,
  v.calendar_id,
  cal_ext.external_id                             AS calendar_external_id,
  ev_ext.external_id                              AS event_id,
  v.starts_at,
  v.ends_at,
  v.html_link,
  v.confirmed,
  v.remote,
  coalesce(att.emails, ARRAY[]::text[])           AS attendees
FROM public.visits v
LEFT JOIN public.external_ids cal_ext
  ON cal_ext.tenant_id = v.tenant_id AND cal_ext.entity = 'calendar'
 AND cal_ext.entity_id = v.calendar_id AND cal_ext.system = 'google_calendar_calendar'
LEFT JOIN public.external_ids ev_ext
  ON ev_ext.tenant_id = v.tenant_id AND ev_ext.entity = 'visit'
 AND ev_ext.entity_id = v.id AND ev_ext.system = 'google_calendar_event'
LEFT JOIN LATERAL (
  SELECT array_agg(a.email ORDER BY a.position) AS emails
  FROM public.visit_attendees a
  WHERE a.visit_id = v.id AND a.deleted_at IS NULL
) att ON true
WHERE v.deleted_at IS NULL
ORDER BY v.work_order_id, v.starts_at ASC NULLS LAST, v.created_at ASC;
COMMENT ON VIEW public.v_work_order_schedule IS 'WorkOrder.schedule = the earliest visit (starts_at NULLS LAST); serializer supplies the default-calendar shape when no row.';

CREATE OR REPLACE VIEW public.v_work_orders
WITH (security_invoker = true) AS
SELECT
  wo.id,
  wo.tenant_id,
  wo.public_key,
  wo.project_id,
  wo.wo_year,
  wo.wo_seq,
  wo.wo_year::text || '-' || lpad(wo.wo_seq::text, 4, '0')          AS minted_ref,
  wo.subject,
  wo.notes,
  wo.priority,
  wo.wo_status,
  public.normalize_wo_status(wo.wo_status)                           AS wo_status_normalized,
  wo.billing_status,
  (wo.billing_status = 'Billable')                                   AS billable,
  wo.wo_type,
  wo.company_cam_url,
  wo.provision_url,
  wo.task_list_completed,
  wo.closed_at,
  wo.created_at,
  wo.updated_at,
  wo.deleted_at,
  wo.schema_version,
  wo.custom,
  p.public_key                                                       AS project_key,
  p.name                                                             AS project_name,
  p.client_name,
  p.site_address,
  p.site_city,
  p.site_state,
  p.site_zip,
  p.membership_level,
  p.gate_code,
  p.community_gate,
  p.door_code,
  lc.lifecycle,
  ss.schedule_status,
  CASE
    WHEN public.normalize_wo_status(wo.wo_status) IN ('On Hold', 'Active Monitoring', 'Ready for Billing', 'Waiting Payment', 'Closed')
      THEN public.normalize_wo_status(wo.wo_status)
    WHEN lc.lifecycle = 'completed' THEN 'Closed'
    WHEN lc.lifecycle = 'billing'   THEN 'Ready for Billing'
    WHEN ss.schedule_status = 'scheduled'        THEN 'Scheduled'
    WHEN ss.schedule_status = 'needs_reschedule' THEN 'Needs Reschedule'
    ELSE 'Not Scheduled'
  END                                                                AS wo_status_effective,
  vt.latest_visit_at,
  vt.next_visit_at,
  vt.visit_count,
  coalesce(h.total, 0)::numeric(10,2)                                AS hours_total,
  wt.id                                                              AS work_task_id,
  bt.id                                                              AS billing_task_id,
  CASE wo.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END AS priority_rank
FROM public.work_orders wo
JOIN public.projects p ON p.id = wo.project_id
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN wo.task_list_completed THEN 'completed'
    WHEN public.normalize_wo_status(wo.wo_status) = 'Closed' THEN 'completed'
    WHEN public.normalize_wo_status(wo.wo_status) IN ('Ready for Billing', 'Waiting Payment') THEN 'billing'
    ELSE 'action'
  END AS lifecycle
) lc
CROSS JOIN LATERAL (
  SELECT
    max(coalesce(v.ends_at, v.starts_at))                                            AS latest_visit_at,
    min(v.starts_at) FILTER (WHERE coalesce(v.ends_at, v.starts_at) >= now())         AS next_visit_at,
    count(*)::int                                                                     AS visit_count
  FROM public.visits v
  WHERE v.work_order_id = wo.id AND v.deleted_at IS NULL
) vt
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN vt.latest_visit_at IS NULL     THEN 'unscheduled'
    WHEN vt.latest_visit_at >= now()    THEN 'scheduled'
    WHEN lc.lifecycle = 'completed'     THEN 'scheduled'
    ELSE 'needs_reschedule'
  END AS schedule_status
) ss
LEFT JOIN public.v_work_order_hours h ON h.work_order_id = wo.id
LEFT JOIN public.wo_tasks wt ON wt.work_order_id = wo.id AND wt.kind = 'work'    AND wt.deleted_at IS NULL
LEFT JOIN public.wo_tasks bt ON bt.work_order_id = wo.id AND bt.kind = 'billing' AND bt.deleted_at IS NULL;
COMMENT ON VIEW public.v_work_orders IS 'WorkOrder scalar + derived columns: lifecycle (action/billing/completed), schedule_status (unscheduled/scheduled/needs_reschedule, uses now()), wo_status_effective (WorkOrder.woStatus), project joins, hours_total, task ids.';

CREATE OR REPLACE VIEW public.v_work_order_board
WITH (security_invoker = true) AS
SELECT *
FROM public.v_work_orders
WHERE deleted_at IS NULL;
COMMENT ON VIEW public.v_work_order_board IS 'GET /work-orders list source. §8.5: the LIST path is FILLED (membershipLevel, accessCodes, hours_total are real values, not nulls). Filter on lifecycle / schedule_status; sort on created_at / client_name / priority_rank.';

CREATE OR REPLACE VIEW public.v_items
WITH (security_invoker = true) AS
SELECT
  i.id,
  i.tenant_id,
  i.work_order_id,
  wo.public_key                                                   AS source_wo,
  wo.project_id,
  i.name,
  i.quantity,
  i.note,
  i.status,
  sv.label                                                        AS status_label,
  coalesce(sv.is_terminal, false)                                 AS is_terminal,
  coalesce((sv.meta ->> 'installed')::boolean, false)             AS is_installed,
  (i.closed_at IS NOT NULL OR coalesce(sv.is_terminal, false))    AS archived,
  i.closed_at,
  i.created_at,
  i.updated_at,
  i.deleted_at,
  i.schema_version,
  i.custom
FROM public.items i
JOIN public.work_orders wo ON wo.id = i.work_order_id
LEFT JOIN public.status_vocab sv
  ON sv.tenant_id = i.tenant_id AND sv.domain = 'item_status' AND sv.code = i.status;
COMMENT ON VIEW public.v_items IS 'PurchaseItem shape: archived = closed_at IS NOT NULL OR vocab.is_terminal; source_wo = work_orders.public_key.';

CREATE OR REPLACE VIEW public.v_todos
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.tenant_id,
  t.work_order_id,
  wo.public_key                                                   AS work_order_number,
  t.title,
  t.status,
  t.urgency,
  t.assignee_name,
  t.assignee_user_id,
  t.notes,
  t.closed_at,
  (t.closed_at IS NOT NULL OR lower(t.status) = 'completed')      AS archived,
  t.created_at,
  t.updated_at,
  t.deleted_at,
  t.schema_version,
  t.custom
FROM public.todos t
JOIN public.work_orders wo ON wo.id = t.work_order_id;
COMMENT ON VIEW public.v_todos IS 'Todo shape: archived = closed_at IS NOT NULL OR status = Completed (case-insensitive); work_order_number joined.';

CREATE OR REPLACE VIEW public.v_materials
WITH (security_invoker = true) AS
SELECT
  m.id,
  m.tenant_id,
  m.work_order_id,
  m.name,
  m.notes,
  m.from_request,
  m.source_item_label,
  m.source_item_id,
  (m.completed_at IS NOT NULL)                                    AS completed,
  m.completed_at,
  m.created_at,
  m.updated_at,
  m.deleted_at,
  m.schema_version,
  m.custom
FROM public.materials m;
COMMENT ON VIEW public.v_materials IS 'Material shape: completed = completed_at IS NOT NULL.';

CREATE OR REPLACE VIEW public.v_daily_report_days
WITH (security_invoker = true) AS
SELECT
  d.id                                                            AS daily_report_id,
  d.tenant_id,
  d.work_order_id,
  d.report_date,
  coalesce(to_char(d.report_date, 'YYYY-MM-DD'), 'cumulative')    AS date_key,
  coalesce(e.entry_count, 0)                                      AS entry_count,
  (d.sent_at IS NOT NULL)                                         AS sent,
  d.sent_at,
  d.pdf_file_id,
  d.created_at,
  d.updated_at
FROM public.daily_reports d
LEFT JOIN LATERAL (
  SELECT count(*)::int AS entry_count
  FROM public.daily_report_entries x
  WHERE x.daily_report_id = d.id AND x.deleted_at IS NULL
) e ON true
WHERE d.deleted_at IS NULL;
COMMENT ON VIEW public.v_daily_report_days IS 'GET …/daily-report/days rows: date_key ("YYYY-MM-DD" or "cumulative"), entry count, sent. pdfUrl is built by the serializer from app.public_url.';

CREATE OR REPLACE VIEW public.v_action_items
WITH (security_invoker = true) AS
SELECT
  ai.id,
  ai.tenant_id,
  ai.public_key,
  ai.project_id,
  p.name                                                          AS project_name,
  p.is_service                                                    AS project_is_service,
  ai.title,
  ai.description,
  ai.flag,
  ai.status,
  sv.id                                                           AS status_id,
  sv.label                                                        AS status_name,
  coalesce(sv.is_closed, false)                                   AS closed,
  ai.assignee_user_id,
  u.name                                                          AS assignee_name,
  zp.external_id                                                  AS assignee_zpuid,
  ai.source_created_at,
  ai.source_updated_at,
  ai.created_at,
  ai.updated_at,
  ai.deleted_at,
  ai.schema_version,
  ai.custom
FROM public.action_items ai
LEFT JOIN public.projects p ON p.id = ai.project_id
LEFT JOIN public.status_vocab sv
  ON sv.tenant_id = ai.tenant_id AND sv.domain = 'action_item_status' AND sv.code = ai.status
LEFT JOIN public.users u ON u.id = ai.assignee_user_id
LEFT JOIN public.external_ids zp
  ON zp.tenant_id = ai.tenant_id AND zp.entity = 'user' AND zp.entity_id = ai.assignee_user_id
 AND zp.system = 'zoho_projects_user';
COMMENT ON VIEW public.v_action_items IS 'ActionItem / DashboardActionItem shape: statusId = status_vocab.id, statusName = label, closed = is_closed, assignee name + legacy zpuid.';

CREATE OR REPLACE VIEW public.v_forums
WITH (security_invoker = true) AS
SELECT
  f.id,
  f.tenant_id,
  f.project_id,
  f.category_id,
  f.name,
  f.content,
  f.flag,
  f.type,
  f.posted_by_user_id,
  coalesce(u.name, f.posted_person_name)                          AS posted_person,
  f.posted_at,
  (extract(epoch FROM f.posted_at) * 1000)::bigint                AS post_date_long,
  f.last_activity_at,
  (extract(epoch FROM f.last_activity_at) * 1000)::bigint         AS last_activity_long,
  f.is_sticky,
  f.is_announcement,
  coalesce(c.comment_count, 0)                                    AS comment_count,
  f.created_at,
  f.updated_at,
  f.deleted_at,
  f.schema_version,
  f.custom
FROM public.forums f
LEFT JOIN public.users u ON u.id = f.posted_by_user_id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS comment_count
  FROM public.forum_comments fc
  WHERE fc.forum_id = f.id AND fc.deleted_at IS NULL
) c ON true;
COMMENT ON VIEW public.v_forums IS 'Forum shape: comment_count, epoch-ms post_date_long / last_activity_long, posted_person resolved from users.';

CREATE OR REPLACE VIEW public.v_technicians
WITH (security_invoker = true) AS
SELECT
  u.id,
  u.tenant_id,
  u.name,
  coalesce(u.email, '')                                           AS email,
  u.active,
  u.created_at,
  u.updated_at
FROM public.users u
JOIN public.user_roles r ON r.user_id = u.id AND r.role = 'technician'
WHERE u.deleted_at IS NULL;
COMMENT ON VIEW public.v_technicians IS 'GET /technicians source (§8.6): users with role technician, Technician shape.';

CREATE OR REPLACE VIEW public.v_people
WITH (security_invoker = true) AS
SELECT
  u.id,
  u.tenant_id,
  u.name,
  coalesce(u.email, '')                                           AS email,
  u.active,
  u.zoho_user,
  u.created_at,
  u.updated_at
FROM public.users u
WHERE u.deleted_at IS NULL;
COMMENT ON VIEW public.v_people IS 'GET /people source (§8.6): ALL non-deleted users regardless of role (roles are tenant-custom, so no fixed "person" role), Person shape (email "" when unset).';

-- -----------------------------------------------------------------------------
-- 12. Application role (optional but recommended): a NOBYPASSRLS role for
--     genesis-api so tenant_isolation actually applies. Craig sets the login
--     password out-of-band:  ALTER ROLE genesis_api LOGIN PASSWORD '...';
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'genesis_api') THEN
    CREATE ROLE genesis_api NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;
GRANT USAGE ON SCHEMA public TO genesis_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO genesis_api;
REVOKE UPDATE, DELETE, TRUNCATE ON public.events FROM genesis_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO genesis_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO genesis_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO genesis_api;

-- =============================================================================
-- End of 0001_baseline.sql
-- =============================================================================
