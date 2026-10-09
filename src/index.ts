// row: W1 · run: run-2026-10-07-drawing-layer-03 · 2026-10-07
// row: W2 · run: run-2026-10-07-drawing-layer-04 · 2026-10-07 — scheduled(): walk-tool cron (lease warnings, file verify, orphan report) behind SYNC_ROUTES
// row: W5 · run: run-2026-10-07-drawing-layer-07 · 2026-10-09 — a SyncResponse with contentType (GET /walk/:token HTML, GET /files/:id bytes) is sent verbatim, not as JSON
//==============================================================================
// index.ts — Worker entry point: HTTP router + cron handler.
//
// Endpoints (JSON in/out, CORS for APP_ORIGIN):
//   POST   /work-orders          mint + create ticket/tasks + WO# + notes + calendar event
//   GET    /work-orders          list across SERVICE projects (filter/q/sort; derives status)
//   GET    /work-orders/:id       one WO (id = Action task id)
//   PATCH  /work-orders/:id       update schedule / notes / access codes / status
//   POST   /work-orders/:id/visits            add a visit (its own calendar event)
//   PATCH  /work-orders/:id/visits/:visitId   update a visit
//   DELETE /work-orders/:id/visits/:visitId   remove a visit
//   POST   /work-orders/:id/visits/:visitId/confirm  promote a tentative visit to confirmed
//   POST   /work-orders/:id/hours             log hours (native Zoho time log)
//   GET    /work-orders/:id/items             unified items for a WO (requested + used, any status)
//   POST   /work-orders/:id/items             add an item (optional initial status; default Needed)
//   GET    /items                             unified items dashboard (all WOs; ?status=&archived=1)
//   PATCH  /items/:id                         update an item (status / note / quantity)
//   (RETIRED 2026-08-23: /work-orders/:id/used-items, /work-orders/:id/requested-items,
//    GET /purchasing, PATCH /purchasing/:id — superseded by the /items routes above)
//   POST   /work-orders/:id/invoice-notes     polish raw notes -> customer-facing invoice text (AI)
//   POST   /work-orders/:id/daily-report/entries   append a daily-report note
//   GET    /work-orders/:id/daily-report?date=     a day's entries (+ sent/pdfUrl)
//   GET    /work-orders/:id/daily-report/days      days that have reports
//   POST   /work-orders/:id/daily-report/send      compile PDF -> Cliq + Zoho subtask
//                                                   body { mode?: "day"|"cumulative", date? }
//   GET    /work-orders/:id/daily-report/:date/pdf serve the compiled PDF (raw bytes)
//                                                   (:date="cumulative" serves the cumulative PDF)
//   GET    /work-orders/:id/summary.pdf   comprehensive WO summary PDF (raw bytes)
//   POST   /sync/calendar         two-way reconcile (also run by cron every 10 min)
//   GET    /health               liveness + config readiness
//
// The phone app calls THIS Worker; it holds no secrets. Secrets live in Worker env.
//==============================================================================

import type {
  Env,
  AdminConfig,
  CreateWorkOrderInput,
  UpdateWorkOrderInput,
  SetTaskStatusInput,
  AddVisitInput,
  UpdateVisitInput,
  LogHoursInput,
  AddItemInput,
  UpdatePurchaseInput,
  AddDailyReportEntryInput,
  CreateTodoInput,
  UpdateTodoInput,
  CreateMaterialInput,
  UpdateMaterialInput,
  WorkOrderFilter,
  WorkOrderSort,
  ScheduleStatus,
} from "./types";
import * as service from "./service";
import { generateInvoiceNotes } from "./ai";
import * as techs from "./repo/technicians";
import { TechnicianError } from "./repo/technicians";
import * as people from "./repo/people";
import { PersonError } from "./repo/people";
import { DailyReportError } from "./repo/daily-reports";
import { CustomFieldError } from "./repo/_shared";
import * as setup from "./setup";
import { SetupError } from "./setup";
import * as forums from "./forums";
import * as issues from "./issues";
import * as cliq from "./cliq";
import * as reminders from "./reminders";
import { getPortalUsers } from "./zoho";
import * as admin from "./admin";
import { ConfigError, isWoFieldConfigured, adminPin, TASK_STATUSES, BILLING_STATUSES } from "./config";
import { ZohoError, ZohoThrottleError, resolveTaskField } from "./zoho";
import { CalendarError } from "./calendar";
import { dbHealth } from "./db";
import { resolveTenant } from "./tenant";
import { handleEventFanout } from "./events";
import { handleSyncRoute } from "./sync/routes";
import { runSyncCron } from "./sync/cron";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await this.handle(request, env, ctx);
    // Any successful app write may have touched tasks/projects → drop the short-TTL list caches
    // so the next read is exact (edits made directly in Zoho age out within the fresh window).
    const m = request.method.toUpperCase();
    if (m !== "GET" && m !== "OPTIONS" && m !== "HEAD" && res.ok) {
      await service.invalidateTaskCaches(env).catch(() => undefined);
    }
    return res;
  },

  async handle(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Resolve the CORS origin once per request from the APP_ORIGIN allowlist.
    const cors = corsHeaders(resolveAllowedOrigin(env, request.headers.get("Origin")));
    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    // F3: bind the request's tenant once. Repos/services read env.TENANT_ID (tenantOf), so a
    // header/JWT-resolved tenant flows through by overriding it on a per-request env copy.
    // Resolution failure is left to surface where the DB is actually used (TenantError → 500),
    // so /health and /setup keep answering while TENANT_ID is unconfigured.
    try {
      const t = await resolveTenant(request, env);
      if (t.tenantId !== (env.TENANT_ID ?? "").trim().toLowerCase()) env = { ...env, TENANT_ID: t.tenantId };
    } catch {
      /* see above */
    }

    try {
      // GET /health
      if (path === "/health" && method === "GET") {
        // F2: db + tenant are ADDITIVE fields; the existing keys are unchanged.
        const db = await dbHealth(env);
        const tenant = await resolveTenant(request, env).then(
          (t) => t.tenantId,
          () => null
        );
        return json(cors, 200, {
          ok: true,
          service: "fhi-service-wo",
          time: new Date().toISOString(),
          config: {
            woFieldConfigured: isWoFieldConfigured(env),
            sequenceScope: env.WO_SEQUENCE_SCOPE,
            googleAuthMethod: env.GOOGLE_AUTH_METHOD,
            defaultCalendar: env.DEFAULT_CALENDAR_ID,
          },
          db,
          tenant,
        });
      }

      // POST /internal/events/fanout — Supabase DB-webhook receiver (F2 stub; see events.ts).
      // Guarded by X-Internal-Token = env.INTERNAL_TOKEN. Not a client route.
      if (path === "/internal/events/fanout") {
        if (method !== "POST") return methodNotAllowed(cors);
        const r = await handleEventFanout(request, env);
        return json(cors, r.status, r.body);
      }

      const baseUrl = url.origin;

      // /setup — one-time browser setup for Zoho creds (GET form, POST exchange)
      if (path === "/setup") {
        if (method === "GET") {
          return html(cors, 200, await setup.renderSetupForm(env, baseUrl));
        }
        if (method === "POST") {
          const form = await parseForm(request);
          try {
            return html(cors, 200, await setup.handleSetupPost(env, form));
          } catch (e) {
            if (e instanceof SetupError) return html(cors, 400, setup.renderSetupError(e.message));
            throw e;
          }
        }
        return methodNotAllowed(cors);
      }

      // POST /setup/google — begin Google OAuth: store id/secret, redirect to consent.
      if (path === "/setup/google" && method === "POST") {
        const form = await parseForm(request);
        try {
          const redirectUrl = await setup.handleGoogleStart(env, form, baseUrl);
          return new Response(null, { status: 302, headers: { Location: redirectUrl, ...cors } });
        } catch (e) {
          if (e instanceof SetupError) return html(cors, 400, setup.renderSetupError(e.message));
          throw e;
        }
      }

      // GET /setup/google/callback?code=... — finish Google OAuth.
      if (path === "/setup/google/callback" && method === "GET") {
        const code = url.searchParams.get("code") ?? "";
        const err = url.searchParams.get("error");
        if (err) return html(cors, 400, setup.renderSetupError(`Google returned: ${err}`));
        try {
          return html(cors, 200, await setup.handleGoogleCallback(env, code, baseUrl));
        } catch (e) {
          if (e instanceof SetupError) return html(cors, 400, setup.renderSetupError(e.message));
          throw e;
        }
      }

      // GET /projects?q=&all= — search client projects for the New WO picker.
      if (path === "/projects" && method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const includeAll = url.searchParams.get("all") === "true";
        const refresh = url.searchParams.get("refresh") === "1"; // bypass the 2-min project cache
        const projects = await service.searchProjects(env, { q, includeAll, refresh });
        return json(cors, 200, { count: projects.length, projects });
      }

      // PUT/POST /projects/:pid/membership { value } — set a project's support-membership level
      // (S1b: editable on the Projects dashboard). Writes the Zoho project custom field.
      const membershipMatch = path.match(/^\/projects\/([^/]+)\/membership$/);
      if (membershipMatch) {
        const projectId = decodeURIComponent(membershipMatch[1]);
        if (method === "PUT" || method === "POST") {
          const body = (await parseBody(request)) as { value?: string };
          const value = typeof body?.value === "string" ? body.value.trim() : "";
          // P2: the Postgres path reports an unknown project (false) → 404; Zoho path always true.
          const found = await service.setProjectMembership(env, projectId, value);
          if (!found) return json(cors, 404, { error: "project not found" });
          return json(cors, 200, { ok: true, membershipLevel: value });
        }
        return methodNotAllowed(cors);
      }

      // ---- Zoho Forums (PROJECT-level conversations + threaded comments) ----------
      // Forums attach to a project, so a client's forum is shared across all their WOs.
      // Requires the token to carry ZohoProjects.forums.ALL (re-auth via /setup).

      // GET /projects/:pid/forum-categories        list categories
      // POST /projects/:pid/forum-categories       add a category { name }
      const forumCatMatch = path.match(/^\/projects\/([^/]+)\/forum-categories$/);
      if (forumCatMatch) {
        const projectId = decodeURIComponent(forumCatMatch[1]);
        if (method === "GET") {
          const categories = await forums.listCategories(env, projectId);
          return json(cors, 200, { count: categories.length, categories });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as { name?: string };
          if (!body?.name || !body.name.trim()) throw new BadRequest("name is required");
          const category = await forums.addCategory(env, projectId, body.name.trim());
          return json(cors, 201, { category });
        }
        return methodNotAllowed(cors);
      }

      // ---- Zoho Issues = "Action Items" (PROJECT-level, native Zoho module) --------
      // Requires ZohoProjects.bugs.ALL on the token (re-auth via /setup).

      // GET /action-item-users — portal users (zpuid + name) for the assignee picker.
      if (path === "/action-item-users" && method === "GET") {
        const users = await getPortalUsers(env);
        return json(cors, 200, { count: users.length, users });
      }

      // GET /action-items?statustype=open|closed — CENTRAL dashboard: action items (issues)
      // across all SERVICE projects, each tagged with its project. Default = open only.
      if (path === "/action-items" && method === "GET") {
        const stParam = url.searchParams.get("statustype");
        const statustype = stParam === "closed" ? "closed" : stParam === "all" ? undefined : "open";
        // ?refresh=1 bypasses the 90s aggregate cache (the dashboard's Refresh button).
        const refresh = url.searchParams.get("refresh") === "1";
        const { items, meta } = await issues.aggregateActionItemsWithMeta(env, statustype, { refresh });
        // ?debug=1 → also report which aggregation path ran (deploy-freshness / diagnosis aid).
        const debug = url.searchParams.get("debug") === "1";
        return json(cors, 200, {
          count: items.length,
          actionItems: items,
          // Rate-limit / cache signals the dashboard shows instead of silently rendering "empty".
          throttled: !!meta.throttled,
          retryAfterMin: meta.retryAfterMin ?? null,
          cached: !!meta.cached,
          stale: !!meta.stale,
          fetchedAt: meta.fetchedAt ?? null,
          ...(debug ? { meta: { ...meta, build: "wa-0.201.0" } } : {}),
        });
      }

      // GET /projects/:pid/action-item-statuses — the project's issue status options.
      const aiStatusMatch = path.match(/^\/projects\/([^/]+)\/action-item-statuses$/);
      if (aiStatusMatch) {
        if (method !== "GET") return methodNotAllowed(cors);
        const projectId = decodeURIComponent(aiStatusMatch[1]);
        const statuses = await issues.listStatuses(env, projectId);
        return json(cors, 200, { count: statuses.length, statuses });
      }

      // GET  /projects/:pid/action-items         list issues (?statustype=open|closed)
      // POST /projects/:pid/action-items         add { title, description?, flag?, assigneeZpuid?, statusId? }
      const aiCollMatch = path.match(/^\/projects\/([^/]+)\/action-items$/);
      if (aiCollMatch) {
        const projectId = decodeURIComponent(aiCollMatch[1]);
        if (method === "GET") {
          const stParam = url.searchParams.get("statustype");
          const statustype = stParam === "open" || stParam === "closed" ? stParam : undefined;
          const list = await issues.listActionItems(env, projectId, { statustype });
          return json(cors, 200, { count: list.length, actionItems: list });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as {
            title?: string;
            description?: string;
            flag?: string;
            assigneeZpuid?: string;
            statusId?: string;
          };
          if (!body?.title || !body.title.trim()) throw new BadRequest("title is required");
          const item = await issues.addActionItem(env, projectId, {
            title: body.title.trim(),
            description: body.description,
            flag: body.flag,
            assigneeZpuid: body.assigneeZpuid,
            statusId: body.statusId,
          });
          // S8: notify the Action Items channel when the new item is created already assigned.
          if (item && body.assigneeZpuid && item.assigneeName) {
            await cliq.notifyActionItemAssigned(env, { assigneeName: item.assigneeName, title: item.title });
          }
          return json(cors, 201, { actionItem: item });
        }
        return methodNotAllowed(cors);
      }

      // GET  /projects/:pid/action-items/:id     one issue's details
      // POST /projects/:pid/action-items/:id     update { title?, description?, flag?, statusId?, assigneeZpuid? }
      const aiOneMatch = path.match(/^\/projects\/([^/]+)\/action-items\/([^/]+)$/);
      if (aiOneMatch) {
        const projectId = decodeURIComponent(aiOneMatch[1]);
        const issueId = decodeURIComponent(aiOneMatch[2]);
        if (method === "GET") {
          const item = await issues.getActionItem(env, projectId, issueId);
          return item ? json(cors, 200, { actionItem: item }) : json(cors, 404, { error: "action item not found" });
        }
        if (method === "POST" || method === "PATCH") {
          const body = (await parseBody(request)) as {
            title?: string;
            description?: string;
            flag?: string;
            statusId?: string;
            assigneeZpuid?: string;
          };
          // S8: capture the prior assignee (only when an assignee change is being requested) so
          // we can notify on an actual assign/reassign — not on every unrelated edit.
          const before =
            body.assigneeZpuid !== undefined
              ? await issues.getActionItem(env, projectId, issueId).catch(() => null)
              : null;
          const item = await issues.updateActionItem(env, projectId, issueId, {
            title: body.title,
            description: body.description,
            flag: body.flag,
            statusId: body.statusId,
            assigneeZpuid: body.assigneeZpuid,
          });
          if (
            item &&
            body.assigneeZpuid !== undefined &&
            item.assigneeName &&
            item.assigneeZpuid !== (before?.assigneeZpuid ?? null)
          ) {
            await cliq.notifyActionItemAssigned(env, { assigneeName: item.assigneeName, title: item.title });
          }
          return item ? json(cors, 200, { actionItem: item }) : json(cors, 404, { error: "action item not found" });
        }
        if (method === "DELETE") {
          await issues.deleteActionItem(env, projectId, issueId);
          return json(cors, 200, { deleted: true, id: issueId });
        }
        return methodNotAllowed(cors);
      }

      // GET/PUT/DELETE /projects/:pid/action-items/:id/reminder — a reminder that fires a Cliq post.
      const aiReminderMatch = path.match(/^\/projects\/([^/]+)\/action-items\/([^/]+)\/reminder$/);
      if (aiReminderMatch) {
        const projectId = decodeURIComponent(aiReminderMatch[1]);
        const issueId = decodeURIComponent(aiReminderMatch[2]);
        if (method === "GET") {
          const reminder = await reminders.getReminder(env, issueId);
          return json(cors, 200, { reminder });
        }
        if (method === "PUT" || method === "POST") {
          const body = (await parseBody(request)) as {
            remindAt?: string;
            message?: string;
            title?: string;
            projectName?: string;
            assigneeName?: string;
          };
          if (!body?.remindAt || !Number.isFinite(Date.parse(body.remindAt))) {
            throw new BadRequest("remindAt (ISO 8601 datetime) is required");
          }
          const reminder = await reminders.setReminder(env, issueId, {
            projectId,
            projectName: body.projectName,
            title: body.title,
            assigneeName: body.assigneeName,
            remindAt: body.remindAt,
            message: body.message,
          });
          return json(cors, 201, { reminder });
        }
        if (method === "DELETE") {
          await reminders.clearReminder(env, issueId);
          return json(cors, 200, { deleted: true });
        }
        return methodNotAllowed(cors);
      }

      // GET  /projects/:pid/action-items/:id/comments   list an action item's comments
      // POST /projects/:pid/action-items/:id/comments   add a comment { content }
      const aiCommentsMatch = path.match(/^\/projects\/([^/]+)\/action-items\/([^/]+)\/comments$/);
      if (aiCommentsMatch) {
        const projectId = decodeURIComponent(aiCommentsMatch[1]);
        const issueId = decodeURIComponent(aiCommentsMatch[2]);
        if (method === "GET") {
          const comments = await issues.listComments(env, projectId, issueId);
          return json(cors, 200, { count: comments.length, comments });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as { content?: string };
          if (!body?.content || !body.content.trim()) throw new BadRequest("content is required");
          const comment = await issues.addComment(env, projectId, issueId, body.content);
          return json(cors, 201, { comment });
        }
        return methodNotAllowed(cors);
      }

      // GET  /projects/:pid/forums                 list conversations (?category_id=)
      // POST /projects/:pid/forums                 add a conversation { name, content, categoryId?, flag?, type?, notify? }
      const forumCollMatch = path.match(/^\/projects\/([^/]+)\/forums$/);
      if (forumCollMatch) {
        const projectId = decodeURIComponent(forumCollMatch[1]);
        if (method === "GET") {
          const categoryId = url.searchParams.get("category_id") ?? undefined;
          const list = await forums.listForums(env, projectId, { categoryId });
          return json(cors, 200, { count: list.length, forums: list });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as {
            name?: string;
            content?: string;
            categoryId?: string;
            flag?: string;
            type?: string;
            notify?: string;
          };
          if (!body?.name || !body.name.trim()) throw new BadRequest("name is required");
          if (!body?.content || !body.content.trim()) throw new BadRequest("content is required");
          // A conversation needs a category; use the one given, else the project's first / a default.
          const categoryId =
            body.categoryId && body.categoryId.trim()
              ? body.categoryId.trim()
              : (await forums.ensureDefaultCategory(env, projectId)).id;
          const forum = await forums.addForum(env, projectId, {
            name: body.name.trim(),
            content: body.content,
            categoryId,
            flag: body.flag,
            type: body.type,
            notify: body.notify,
          });
          return json(cors, 201, { forum });
        }
        return methodNotAllowed(cors);
      }

      // GET  /projects/:pid/forums/:fid            one conversation's details
      // POST /projects/:pid/forums/:fid            update conversation { name, content, categoryId, flag?, type? }
      const forumOneMatch = path.match(/^\/projects\/([^/]+)\/forums\/([^/]+)$/);
      if (forumOneMatch) {
        const projectId = decodeURIComponent(forumOneMatch[1]);
        const forumId = decodeURIComponent(forumOneMatch[2]);
        if (method === "GET") {
          const forum = await forums.getForum(env, projectId, forumId);
          return forum ? json(cors, 200, { forum }) : json(cors, 404, { error: "forum not found" });
        }
        if (method === "POST" || method === "PATCH") {
          const body = (await parseBody(request)) as {
            name?: string;
            content?: string;
            categoryId?: string;
            flag?: string;
            type?: string;
          };
          if (!body?.name || !body.name.trim()) throw new BadRequest("name is required");
          if (!body?.content || !body.content.trim()) throw new BadRequest("content is required");
          // Category is mandatory on update; if the client didn't send one, reuse the current forum's.
          let categoryId = body.categoryId && body.categoryId.trim() ? body.categoryId.trim() : "";
          if (!categoryId) {
            const current = await forums.getForum(env, projectId, forumId);
            categoryId = current?.categoryId ?? (await forums.ensureDefaultCategory(env, projectId)).id;
          }
          const forum = await forums.updateForum(env, projectId, forumId, {
            name: body.name.trim(),
            content: body.content,
            categoryId,
            flag: body.flag,
            type: body.type,
          });
          return forum ? json(cors, 200, { forum }) : json(cors, 404, { error: "forum not found" });
        }
        if (method === "DELETE") {
          await forums.deleteForum(env, projectId, forumId);
          return json(cors, 200, { deleted: true, id: forumId });
        }
        return methodNotAllowed(cors);
      }

      // GET  /projects/:pid/forums/:fid/comments        list comments (threaded)
      // POST /projects/:pid/forums/:fid/comments        add a comment { content, parentId?, type?, notify? }
      const forumCommentsMatch = path.match(/^\/projects\/([^/]+)\/forums\/([^/]+)\/comments$/);
      if (forumCommentsMatch) {
        const projectId = decodeURIComponent(forumCommentsMatch[1]);
        const forumId = decodeURIComponent(forumCommentsMatch[2]);
        if (method === "GET") {
          const comments = await forums.listComments(env, projectId, forumId);
          return json(cors, 200, { count: comments.length, comments });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as {
            content?: string;
            parentId?: string;
            type?: string;
            notify?: string;
          };
          if (!body?.content || !body.content.trim()) throw new BadRequest("content is required");
          const comment = await forums.addComment(env, projectId, forumId, {
            content: body.content,
            parentId: body.parentId,
            type: body.type,
            notify: body.notify,
          });
          return json(cors, 201, { comment });
        }
        return methodNotAllowed(cors);
      }

      // POST /projects/:pid/forums/:fid/comments/:cid   update a comment { content }
      const forumCommentOneMatch = path.match(/^\/projects\/([^/]+)\/forums\/([^/]+)\/comments\/([^/]+)$/);
      if (forumCommentOneMatch) {
        const projectId = decodeURIComponent(forumCommentOneMatch[1]);
        const forumId = decodeURIComponent(forumCommentOneMatch[2]);
        const commentId = decodeURIComponent(forumCommentOneMatch[3]);
        if (method === "POST" || method === "PATCH") {
          const body = (await parseBody(request)) as { content?: string };
          if (!body?.content || !body.content.trim()) throw new BadRequest("content is required");
          const comment = await forums.updateComment(env, projectId, forumId, commentId, body.content);
          return comment ? json(cors, 200, { comment }) : json(cors, 404, { error: "comment not found" });
        }
        return methodNotAllowed(cors);
      }

      // /work-orders collection
      if (path === "/work-orders") {
        if (method === "POST") {
          const input = (await parseBody(request)) as CreateWorkOrderInput;
          validateCreate(input);
          // Resolve checked technicians (registry ids) to guest emails and merge
          // with any raw emails passed in schedule.attendees.
          if (input.technicianIds?.length) {
            const emails = await techs.resolveGuestEmails(env, input.technicianIds);
            const existing = input.schedule?.attendees ?? [];
            const merged = Array.from(new Set([...existing, ...emails]));
            if (input.schedule) input.schedule.attendees = merged;
          }
          const wo = await service.createWorkOrder(env, input);
          return json(cors, 201, wo);
        }
        if (method === "GET") {
          const filter = (url.searchParams.get("filter") ?? "active") as WorkOrderFilter;
          const sort = (url.searchParams.get("sort") ?? "newest") as WorkOrderSort;
          const q = url.searchParams.get("q") ?? undefined;
          assertEnum(filter, ["active", "billing", "done", "all"], "filter");
          assertEnum(sort, ["newest", "oldest", "client", "priority"], "sort");
          // Optional schedule-status filter; validated only if provided, else omitted.
          const scheduleParam = url.searchParams.get("schedule");
          let schedule: ScheduleStatus | undefined;
          if (scheduleParam) {
            schedule = scheduleParam as ScheduleStatus;
            assertEnum(schedule, ["unscheduled", "scheduled", "needs_reschedule"], "schedule");
          }
          const list = await service.listWorkOrders(env, { filter, q, sort, schedule });
          return json(cors, 200, { count: list.length, workOrders: list });
        }
        return methodNotAllowed(cors);
      }

      // /work-orders/:id
      const woMatch = path.match(/^\/work-orders\/([^/]+)$/);
      if (woMatch) {
        const id = decodeURIComponent(woMatch[1]);
        if (method === "GET") {
          const wo = await service.getWorkOrder(env, id, { allowCached: url.searchParams.get("refresh") !== "1" });
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order not found" });
        }
        if (method === "PATCH") {
          const patch = (await parseBody(request)) as UpdateWorkOrderInput;
          validateUpdateWorkOrder(patch);
          const wo = await service.updateWorkOrder(env, id, patch);
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order not found" });
        }
        if (method === "DELETE") {
          // Delete/cancel the whole WO: removes its calendar events + Zoho ticket task list.
          const ok = await service.deleteWorkOrder(env, id);
          return ok ? json(cors, 200, { deleted: true, id }) : json(cors, 404, { error: "work order not found" });
        }
        return methodNotAllowed(cors);
      }

      // PATCH /work-orders/:id/tasks/:taskId { taskStatus: "Pending"|"Completed" } — set a work
      // task / subtask / Billing task's wo_task_status (+ native open/closed). Returns
      // { workOrder, autoPromoted, gateMessage }: completing the Work Order Tasks task while
      // pre-billing auto-moves the WO to Ready for Billing (unless the items gate blocks it).
      const taskStatusMatch = path.match(/^\/work-orders\/([^/]+)\/tasks\/([^/]+)$/);
      if (taskStatusMatch) {
        if (method !== "PATCH") return methodNotAllowed(cors);
        const woId = decodeURIComponent(taskStatusMatch[1]);
        const taskId = decodeURIComponent(taskStatusMatch[2]);
        const body = (await parseBody(request)) as SetTaskStatusInput;
        if (!body || typeof body.taskStatus !== "string") throw new BadRequest("taskStatus is required");
        assertEnum(body.taskStatus, [...TASK_STATUSES] as string[], "taskStatus");
        const result = await service.setTaskStatus(env, woId, taskId, body.taskStatus);
        return result ? json(cors, 200, result) : json(cors, 404, { error: "work order not found" });
      }

      // POST /work-orders/:id/visits/:visitId/confirm — promote a TENTATIVE visit to confirmed
      // (strips the bold TENTATIVE marker from its Google event + resolves the confirmer's to-do).
      const visitConfirmMatch = path.match(/^\/work-orders\/([^/]+)\/visits\/([^/]+)\/confirm$/);
      if (visitConfirmMatch) {
        if (method !== "POST") return methodNotAllowed(cors);
        const woId = decodeURIComponent(visitConfirmMatch[1]);
        const visitId = decodeURIComponent(visitConfirmMatch[2]);
        const wo = await service.confirmVisit(env, woId, visitId);
        return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order or visit not found" });
      }

      // /work-orders/:id/visits  and  /work-orders/:id/visits/:visitId
      // A WO can have several visits; each is its own calendar event.
      const visitMatch = path.match(/^\/work-orders\/([^/]+)\/visits(?:\/([^/]+))?$/);
      if (visitMatch) {
        const woId = decodeURIComponent(visitMatch[1]);
        const visitId = visitMatch[2] ? decodeURIComponent(visitMatch[2]) : null;

        if (!visitId) {
          // Collection: POST /work-orders/:id/visits — add a visit.
          if (method === "POST") {
            const body = (await parseBody(request)) as AddVisitInput;
            validateAddVisit(body);
            const wo = await service.addVisit(env, woId, body);
            return wo ? json(cors, 201, wo) : json(cors, 404, { error: "work order not found" });
          }
          return methodNotAllowed(cors);
        }

        // Item: PATCH / DELETE /work-orders/:id/visits/:visitId
        if (method === "PATCH") {
          const body = (await parseBody(request)) as UpdateVisitInput;
          const wo = await service.updateVisit(env, woId, visitId, body);
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order or visit not found" });
        }
        if (method === "DELETE") {
          const wo = await service.removeVisit(env, woId, visitId);
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order or visit not found" });
        }
        return methodNotAllowed(cors);
      }

      // RETIRED 2026-08-23 (app cut over to the unified Items API): the old
      // /work-orders/:id/used-items routes (POST/PATCH/DELETE) are gone — used items are
      // now Items with an Installed status (POST /work-orders/:id/items). Legacy used-item
      // JSON is still READ into usedItems[] on GET until the data migration runs.

      // POST /work-orders/:id/hours — log time against the WO's Action task.
      const hoursMatch = path.match(/^\/work-orders\/([^/]+)\/hours$/);
      if (hoursMatch) {
        const woId = decodeURIComponent(hoursMatch[1]);
        if (method === "POST") {
          const body = (await parseBody(request)) as LogHoursInput;
          validateLogHours(body);
          const wo = await service.logHours(env, woId, body);
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order not found" });
        }
        if (method === "PATCH") {
          // Edit an existing hours entry by index: { index, hours?, note?, tech? }.
          const body = (await parseBody(request)) as { index?: number; hours?: number; note?: string | null; tech?: string | null };
          if (typeof body?.index !== "number") throw new BadRequest("index is required");
          if (body.hours !== undefined && !(typeof body.hours === "number" && body.hours >= 0)) {
            throw new BadRequest("hours must be a non-negative number");
          }
          const wo = await service.editHoursEntry(env, woId, body.index, { hours: body.hours, note: body.note, tech: body.tech });
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order or hours entry not found" });
        }
        if (method === "DELETE") {
          const idxRaw = url.searchParams.get("index");
          const index = idxRaw === null ? NaN : Number(idxRaw);
          if (!Number.isInteger(index)) throw new BadRequest("index query param is required");
          const wo = await service.deleteHoursEntry(env, woId, index);
          return wo ? json(cors, 200, wo) : json(cors, 404, { error: "work order or hours entry not found" });
        }
        return methodNotAllowed(cors);
      }

      // RETIRED 2026-08-23: POST /work-orders/:id/requested-items — superseded by
      // POST /work-orders/:id/items (add an item; default status "Needed").

      // /work-orders/:id/items — UNIFIED ITEMS (requested + used together). An item is a
      // purchasing task linked to this WO; "requested" vs "used" is just a status view.
      //   GET  -> all items for this WO (any status)
      //   POST -> add an item (optional initial status; default "Needed")
      const woItemsMatch = path.match(/^\/work-orders\/([^/]+)\/items$/);
      if (woItemsMatch) {
        const woId = decodeURIComponent(woItemsMatch[1]);
        if (method === "GET") {
          const items = await service.listItemsForWo(env, woId);
          return json(cors, 200, { count: items.length, items });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as AddItemInput;
          validateAddItem(body);
          const item = await service.addItem(env, woId, body);
          return item ? json(cors, 201, item) : json(cors, 404, { error: "work order not found" });
        }
        return methodNotAllowed(cors);
      }

      // /work-orders/:id/materials  and  /work-orders/:id/materials/:mid — the WO's MATERIALS
      // list. Each material is a subtask under the WO's "Materials" holder task; requesting an
      // item (POST /work-orders/:id/items) auto-mirrors one here marked fromRequest.
      //   GET    -> the WO's materials
      //   POST   -> add a material manually { name, notes? }
      //   PATCH  -> update a material { completed? }
      //   DELETE -> remove a material
      const materialsMatch = path.match(/^\/work-orders\/([^/]+)\/materials(?:\/([^/]+))?$/);
      if (materialsMatch) {
        const woId = decodeURIComponent(materialsMatch[1]);
        const materialId = materialsMatch[2] ? decodeURIComponent(materialsMatch[2]) : null;
        if (!materialId) {
          if (method === "GET") {
            const materials = await service.listMaterialsForWo(env, woId, url.searchParams.get("projectId"));
            return json(cors, 200, { count: materials.length, materials });
          }
          if (method === "POST") {
            const body = (await parseBody(request)) as CreateMaterialInput;
            if (!body || typeof body.name !== "string" || !body.name.trim()) {
              return json(cors, 400, { error: "name is required" });
            }
            const material = await service.addMaterial(env, woId, body);
            return material ? json(cors, 201, material) : json(cors, 404, { error: "work order not found" });
          }
          return methodNotAllowed(cors);
        }
        if (method === "PATCH") {
          const body = (await parseBody(request)) as UpdateMaterialInput;
          const material = await service.updateMaterial(env, woId, materialId, body || {});
          return material ? json(cors, 200, material) : json(cors, 404, { error: "work order or material not found" });
        }
        if (method === "DELETE") {
          const ok = await service.deleteMaterial(env, woId, materialId);
          return ok ? json(cors, 200, { ok: true }) : json(cors, 404, { error: "work order not found" });
        }
        return methodNotAllowed(cors);
      }

      // /work-orders/:id/todos  and  /work-orders/:id/todos/:todoId — a WO's to-dos /
      // action items. Each todo is a subtask under the WO's auto-created "To-Dos" task.
      //   GET   -> the WO's todos (?archived=1 to include Completed/archived)
      //   POST  -> add a todo (status default "Open"; "Completed" archives it)
      //   PATCH -> update a todo (title/status/priority/notes/assignee)
      const todoMatch = path.match(/^\/work-orders\/([^/]+)\/todos(?:\/([^/]+))?$/);
      if (todoMatch) {
        const woId = decodeURIComponent(todoMatch[1]);
        const todoId = todoMatch[2] ? decodeURIComponent(todoMatch[2]) : null;

        if (!todoId) {
          // Collection: GET (list) / POST (add).
          if (method === "GET") {
            const archivedParam = url.searchParams.get("archived") ?? url.searchParams.get("includeArchived");
            const includeArchived = archivedParam === "1" || archivedParam === "true";
            const todos = await service.listTodos(env, woId, includeArchived);
            return json(cors, 200, { count: todos.length, todos });
          }
          if (method === "POST") {
            const body = (await parseBody(request)) as CreateTodoInput;
            validateCreateTodo(body);
            const todo = await service.addTodo(env, woId, body);
            return todo ? json(cors, 201, todo) : json(cors, 404, { error: "work order not found" });
          }
          return methodNotAllowed(cors);
        }

        // Item: PATCH /work-orders/:id/todos/:todoId — update a todo.
        if (method === "PATCH") {
          const body = (await parseBody(request)) as UpdateTodoInput;
          validateUpdateTodo(body);
          const todo = await service.updateTodo(env, woId, todoId, body);
          return todo ? json(cors, 200, todo) : json(cors, 404, { error: "work order or todo not found" });
        }
        return methodNotAllowed(cors);
      }

      // POST /work-orders/:id/invoice-notes — rewrite the WO's raw notes into FHI's
      // customer-facing invoice-notes house style via the Anthropic API. Returns
      // { invoiceNotes }. 404 if the WO is gone; an AI/config failure returns a clear
      // 400 (not a 500 stack).
      const invoiceNotesMatch = path.match(/^\/work-orders\/([^/]+)\/invoice-notes$/);
      if (invoiceNotesMatch) {
        const woId = decodeURIComponent(invoiceNotesMatch[1]);
        if (method === "POST") {
          // Assemble the WHOLE work order (notes, visits, hours, used items, requested
          // parts, and daily-report entries across all days) into one labeled block,
          // then feed that to the house-style AI prompt. Tech notes live mostly in the
          // daily reports, so we no longer rely on wo.notes alone.
          const assembled = await service.buildInvoiceNotesMaterial(env, woId);
          if (!assembled) return json(cors, 404, { error: "work order not found" });
          if (!assembled.hasContent) {
            return json(cors, 400, {
              error:
                "Nothing to summarize yet — add notes, a daily report, hours, or parts to this work order first.",
            });
          }
          const { wo, material } = assembled;
          try {
            const invoiceNotes = await generateInvoiceNotes(env, {
              woNumber: wo.workOrderNumber || null,
              client: wo.client || null,
              notes: wo.notes,
              material,
              hoursEntries: wo.hours.entries.map((e) => ({ tech: e.tech, at: e.at })),
            });
            return json(cors, 200, { invoiceNotes });
          } catch (e) {
            // Missing key / upstream AI failure -> a clear 400 with the message.
            return json(cors, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        return methodNotAllowed(cors);
      }

      // GET /work-orders/:id/summary.pdf — one comprehensive WO summary PDF.
      // Reachable WITHOUT the JSON envelope: returns application/pdf raw bytes,
      // same response style as the daily-report PDF route. 404 if the WO is gone.
      const summaryMatch = path.match(/^\/work-orders\/([^/]+)\/summary\.pdf$/);
      if (summaryMatch) {
        const woId = decodeURIComponent(summaryMatch[1]);
        if (method === "GET") {
          // Load once for the filename WO# (+ existence check), then render.
          const wo = await service.getWorkOrder(env, woId, { allowCached: true });
          if (!wo) return json(cors, 404, { error: "work order not found" });
          const bytes = await service.buildWorkOrderSummary(env, woId);
          if (!bytes) return json(cors, 404, { error: "work order not found" });
          const label = wo.workOrderNumber || woId;
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `inline; filename="work-order-summary-${label}.pdf"`,
              ...cors,
            },
          });
        }
        return methodNotAllowed(cors);
      }

      // /work-orders/:id/daily-report[...] — daily-report entries, days, send, PDF.
      const drMatch = path.match(/^\/work-orders\/([^/]+)\/daily-report(?:\/(.+))?$/);
      if (drMatch) {
        const woId = decodeURIComponent(drMatch[1]);
        const rest = drMatch[2] ?? ""; // "" | "entries" | "days" | "send" | "<date>/pdf"

        // GET /work-orders/:id/daily-report/:date/pdf — serve the raw PDF bytes.
        // Reachable WITHOUT the JSON envelope: returns application/pdf directly.
        const pdfSub = rest.match(/^([^/]+)\/pdf$/);
        if (pdfSub) {
          if (method === "GET") {
            const date = decodeURIComponent(pdfSub[1]);
            const found = await service.getDailyReportPdf(env, woId, date);
            if (!found) return json(cors, 404, { error: "no daily report pdf for that date" });
            const label = found.woNumber ?? woId;
            return new Response(found.bytes, {
              status: 200,
              headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="daily-report-${label}-${date}.pdf"`,
                ...cors,
              },
            });
          }
          return methodNotAllowed(cors);
        }

        // POST  /work-orders/:id/daily-report/entries — append an entry.
        // PATCH /work-orders/:id/daily-report/entries — edit one entry { index, text, date? }.
        if (rest === "entries") {
          if (method === "POST") {
            const body = (await parseBody(request)) as AddDailyReportEntryInput;
            validateDailyReportEntry(body);
            const day = await service.addDailyReportEntry(env, woId, body);
            return json(cors, 201, day);
          }
          if (method === "PATCH") {
            const body = (await parseBody(request)) as { index?: number; text?: string; date?: string };
            if (typeof body?.index !== "number") throw new BadRequest("index is required");
            if (!body?.text || typeof body.text !== "string" || !body.text.trim()) {
              throw new BadRequest("text is required");
            }
            const day = await service.editDailyReportEntry(env, woId, body.index, body.text, body.date);
            return day ? json(cors, 200, day) : json(cors, 404, { error: "daily-report entry not found" });
          }
          if (method === "DELETE") {
            const idxRaw = url.searchParams.get("index");
            const index = idxRaw === null ? NaN : Number(idxRaw);
            if (!Number.isInteger(index)) throw new BadRequest("index query param is required");
            const dateParam = url.searchParams.get("date") ?? undefined;
            const day = await service.deleteDailyReportEntry(env, woId, index, dateParam);
            return day ? json(cors, 200, day) : json(cors, 404, { error: "daily-report entry not found" });
          }
          return methodNotAllowed(cors);
        }

        // GET /work-orders/:id/daily-report/days — days that have reports, ENRICHED
        // into { date, entries, sent, pdfUrl } objects (the UI's "Sent reports" list
        // expects objects, not bare date strings — see the mock shape).
        if (rest === "days") {
          if (method === "GET") {
            // F3: one query over v_daily_report_days (was N KV reads); same row shape.
            const enriched = await service.listDailyReportDaysEnriched(env, woId);
            return json(cors, 200, { days: enriched });
          }
          return methodNotAllowed(cors);
        }

        // POST /work-orders/:id/daily-report/send — compile + distribute a report.
        //   { mode?: "day" | "cumulative", date? }  (mode defaults to "day")
        //   "day"        = compile that date's entries (date defaults to today ET).
        //   "cumulative" = compile ALL entries across ALL days into one PDF.
        // Re-sending is allowed. Empty -> 400 { error: "no entries to send" }.
        if (rest === "send") {
          if (method === "POST") {
            const body = (await parseBody(request)) as { mode?: "day" | "cumulative"; date?: string };
            const mode = body?.mode === "cumulative" ? "cumulative" : "day";
            try {
              const result =
                mode === "cumulative"
                  ? await service.sendCumulativeReport(env, woId)
                  : await service.sendDailyReport(env, woId, body?.date);
              return result ? json(cors, 200, result) : json(cors, 404, { error: "work order not found" });
            } catch (e) {
              // "no entries to send" -> 400 with the message; let upstream errors
              // (Zoho/etc.) fall through to the outer handler.
              if (e instanceof Error && e.message.startsWith("no entries")) {
                return json(cors, 400, { error: e.message });
              }
              throw e;
            }
          }
          return methodNotAllowed(cors);
        }

        // GET /work-orders/:id/daily-report?date= — a day's entries (default today).
        if (rest === "") {
          if (method === "GET") {
            const date = url.searchParams.get("date") ?? undefined;
            const report = await service.getDailyReport(env, woId, date);
            return json(cors, 200, report);
          }
          return methodNotAllowed(cors);
        }

        return json(cors, 404, { error: "not found", path });
      }

      // RETIRED 2026-08-23: GET /purchasing — superseded by GET /items (same rows).

      // GET /items?status=<label>&archived=1 — the unified Items dashboard across all WOs.
      // The status filter is NOT validated against a local whitelist: any value is accepted
      // and matched case-insensitively by service.listPurchasing (Zoho owns the pick-list).
      // By default only ACTIVE (non-archived) items are returned; ?archived=1 includes DONE.
      if (path === "/items" && method === "GET") {
        const statusParam = url.searchParams.get("status");
        const status = statusParam && statusParam.trim() ? statusParam.trim() : undefined;
        const archivedParam = url.searchParams.get("archived") ?? url.searchParams.get("includeArchived");
        const includeArchived = archivedParam === "1" || archivedParam === "true";
        const items = await service.listPurchasing(env, status, includeArchived);
        return json(cors, 200, { count: items.length, items });
      }

      // GET /todos?archived=1&assignee=&status=&urgency= — the CENTRAL to-dos dashboard
      // across all WOs. Filters are NOT validated against a local whitelist (Zoho owns the
      // status pick-list); they match case-insensitively in service.listAllTodos. By default
      // only ACTIVE (non-archived) todos are returned; ?archived=1 includes Completed ones.
      if (path === "/todos" && method === "GET") {
        const archivedParam = url.searchParams.get("archived") ?? url.searchParams.get("includeArchived");
        const includeArchived = archivedParam === "1" || archivedParam === "true";
        const assignee = url.searchParams.get("assignee")?.trim() || undefined;
        const status = url.searchParams.get("status")?.trim() || undefined;
        const urgency = url.searchParams.get("urgency")?.trim() || undefined;
        const todos = await service.listAllTodos(env, { includeArchived, assignee, status, urgency });
        return json(cors, 200, { count: todos.length, todos });
      }

      // PATCH /items/:id — update an item (status / note / quantity).
      // (RETIRED 2026-08-23: the /purchasing/:id alias — use /items/:id.)
      const purchasingMatch = path.match(/^\/items\/([^/]+)$/);
      if (purchasingMatch) {
        const id = decodeURIComponent(purchasingMatch[1]);
        if (method === "PATCH") {
          const body = (await parseBody(request)) as UpdatePurchaseInput;
          validateUpdatePurchase(body);
          const item = await service.updatePurchase(env, id, body);
          return item ? json(cors, 200, item) : json(cors, 404, { error: "item not found" });
        }
        if (method === "DELETE") {
          await service.deleteItem(env, id);
          return json(cors, 200, { deleted: true, id });
        }
        return methodNotAllowed(cors);
      }

      // /technicians collection — the managed registry (starts empty; no seeds)
      if (path === "/technicians") {
        if (method === "GET") {
          const activeOnly = url.searchParams.get("active") === "true";
          const list = await techs.listTechnicians(env, { activeOnly });
          return json(cors, 200, { count: list.length, technicians: list });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as techs.AddTechnicianInput;
          const created = await techs.addTechnician(env, body);
          return json(cors, 201, created);
        }
        return methodNotAllowed(cors);
      }

      // /technicians/:id
      const techMatch = path.match(/^\/technicians\/([^/]+)$/);
      if (techMatch) {
        const id = decodeURIComponent(techMatch[1]);
        if (method === "PATCH") {
          const body = (await parseBody(request)) as techs.UpdateTechnicianInput;
          const updated = await techs.updateTechnician(env, id, body);
          return updated ? json(cors, 200, updated) : json(cors, 404, { error: "technician not found" });
        }
        return methodNotAllowed(cors);
      }

      // /people collection — the managed People registry (populates the to-do assignee
      // pick-list; starts empty, no seeds). Mirrors /technicians.
      if (path === "/people") {
        if (method === "GET") {
          // Active only by default; ?all=1 returns everyone (for the Manage People screen).
          const allParam = url.searchParams.get("all");
          const includeAll = allParam === "1" || allParam === "true";
          const list = await people.getPeople(env, { activeOnly: !includeAll });
          return json(cors, 200, { count: list.length, people: list });
        }
        if (method === "POST") {
          const body = (await parseBody(request)) as people.AddPersonInput;
          const created = await people.savePerson(env, body);
          return json(cors, 201, created);
        }
        return methodNotAllowed(cors);
      }

      // /people/:id
      const personMatch = path.match(/^\/people\/([^/]+)$/);
      if (personMatch) {
        const id = decodeURIComponent(personMatch[1]);
        if (method === "PATCH") {
          const body = (await parseBody(request)) as people.UpdatePersonInput;
          const updated = await people.updatePerson(env, id, body);
          return updated ? json(cors, 200, updated) : json(cors, 404, { error: "person not found" });
        }
        return methodNotAllowed(cors);
      }

      // POST /admin/verify-pin — body { pin }. 200 { ok: true } on match, else 401.
      if (path === "/admin/verify-pin" && method === "POST") {
        const body = (await parseBody(request)) as { pin?: string };
        if (body?.pin === adminPin(env)) return json(cors, 200, { ok: true });
        return json(cors, 401, { ok: false });
      }

      // GET /admin/resolve-field?name=<field>&pin=<pin> — diagnostic: does a task custom
      // field exist on the live layout? 200 { field, exists } (exists=true when the portal
      // task-filter resolves it, false on 400 FIELDS_VALIDATION_ERROR). Use to confirm e.g.
      // order_status on the SERVICE task layout before relying on it.
      if (path === "/admin/resolve-field" && method === "GET") {
        const pin = url.searchParams.get("pin") ?? "";
        if (pin !== adminPin(env)) return json(cors, 401, { error: "invalid admin pin" });
        const name = (url.searchParams.get("name") ?? "").trim();
        if (!name) return json(cors, 400, { error: "name required" });
        const exists = await resolveTaskField(env, name);
        return json(cors, 200, { field: name, exists });
      }

      // POST /admin/migrate-status?pin=<pin>[&apply=1][&limit=15][&id=<woId>] — one-time
      // migration onto the Zoho-native status model (Work Order Status task + wo_task_status
      // + billing_status). Without apply=1 it's a DRY RUN returning the per-WO crosswalk.
      // Throttle-aware: stops on a rate limit and reports `stoppedBy`; rerun until pending=0.
      if (path === "/admin/migrate-status" && (method === "POST" || method === "GET")) {
        const pin = request.headers.get("X-Admin-Pin") ?? url.searchParams.get("pin") ?? "";
        if (pin !== adminPin(env)) return json(cors, 401, { error: "invalid admin pin" });
        const apply = method === "POST" && url.searchParams.get("apply") === "1";
        // Default 8 / cap 10 per call: the Worker's subrequest budget ran out at ~10 WOs (live 2026-09-09).
        const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") ?? 8) || 8));
        const onlyId = url.searchParams.get("id") ?? undefined;
        const report = await service.migrateStatusModel(env, { apply, limit, onlyId });
        return json(cors, 200, report);
      }

      // GET /admin/report-access/check?email=<email> — no-PIN boolean gate for
      // the UI. 200 { allowed, email } where email is trim+lowercased and craig is
      // always allowed. This is a UI gate, not hard security (matches app-side
      // enforcement); real server-side identity enforcement is a future item.
      if (path === "/admin/report-access/check" && method === "GET") {
        const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
        if (!email) return json(cors, 400, { error: "email required" });
        const allowed = await admin.canGenerateReports(env, email);
        return json(cors, 200, { allowed, email });
      }

      // /admin/config — PIN-gated read/write of the admin config (see admin.ts).
      // The PIN is accepted via the X-Admin-Pin header (preferred) OR a ?pin=
      // query param (GET) / body.pin (PUT). Reads are gated too (admin-only page).
      if (path === "/admin/config") {
        if (method === "GET") {
          const pin = request.headers.get("X-Admin-Pin") ?? url.searchParams.get("pin") ?? "";
          if (pin !== adminPin(env)) return json(cors, 401, { error: "invalid admin pin" });
          const cfg = await admin.getAdminConfig(env);
          return json(cors, 200, cfg);
        }
        if (method === "PUT") {
          const body = (await parseBody(request)) as Partial<AdminConfig> & { pin?: string };
          const pin = request.headers.get("X-Admin-Pin") ?? body?.pin ?? "";
          if (pin !== adminPin(env)) return json(cors, 401, { error: "invalid admin pin" });
          validateAdminConfig(body);
          // MERGE into the existing config so a partial PUT (just reportAccess, or just
          // zohoUserOptions, or just schedulingConfirmer) never wipes the other fields.
          const existingCfg = await admin.getAdminConfig(env);
          const merged: Partial<AdminConfig> = {
            ...existingCfg,
            ...(body.reportAccess !== undefined ? { reportAccess: body.reportAccess } : {}),
            ...(body.zohoUserOptions !== undefined ? { zohoUserOptions: body.zohoUserOptions } : {}),
            ...(body.schedulingConfirmer !== undefined ? { schedulingConfirmer: body.schedulingConfirmer } : {}),
          };
          const saved = await admin.saveAdminConfig(env, merged);
          return json(cors, 200, saved);
        }
        return methodNotAllowed(cors);
      }

      // W1 (sandbox/walk-tool): POST /sync/push · GET /sync/pull · PUT /sync/files/:id — the
      // new-schema (001→090) walk-tool routes. Gated by env.SYNC_ROUTES === "on" ([env.sandbox]):
      // backend-mode.ts reads the tenant-era public.tenant_settings, which the new schema does
      // not have, so a plain env flag gates these instead. /sync/calendar below is untouched.
      if (env.SYNC_ROUTES === "on") {
        const r = await handleSyncRoute(request, env, path, method);
        if (r) {
          // W5: raw bodies (text/html review page, file bytes) carry their own Content-Type.
          if (r.contentType) return new Response(r.body as BodyInit, { status: r.status, headers: { "Content-Type": r.contentType, ...(r.headers ?? {}), ...cors } });
          return json(cors, r.status, r.body);
        }
      }

      // POST /sync/calendar
      if (path === "/sync/calendar" && method === "POST") {
        const result = await service.reconcileCalendar(env);
        return json(cors, 200, result);
      }

      return json(cors, 404, { error: "not found", path });
    } catch (err) {
      return errorResponse(cors, err);
    }
  },

  // Cron -> calendar reconcile + fire any due action-item reminders (both best-effort).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      service.reconcileCalendar(env).then(
        (r) => console.log("calendar reconcile:", JSON.stringify(r)),
        (e) => console.error("calendar reconcile failed:", e)
      )
    );
    ctx.waitUntil(
      reminders.fireDueReminders(env).then(
        (r) => console.log("reminders fired:", JSON.stringify(r)),
        (e) => console.error("reminders scan failed:", e)
      )
    );
    // W2 (sandbox/walk-tool): lease-expiry warnings (checkout.expiring), file sha256 verification
    // (uploaded → verified) and the report-only orphan sweep. Gated like the routes.
    if (env.SYNC_ROUTES === "on") {
      ctx.waitUntil(
        runSyncCron(env).then(
          (r) => console.log("walk-tool cron:", JSON.stringify(r)),
          (e) => console.error("walk-tool cron failed:", e)
        )
      );
    }
  },
};

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------
function corsHeaders(allowOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Pin, X-Actor-Id, X-Organization-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// APP_ORIGIN may be a single origin or a comma-separated allowlist. We echo back
// the request's Origin only if it's on the list (never a blanket wildcard); if it
// isn't listed we fall back to the first configured origin so responses are still
// well-formed. Origins are scheme+host, no trailing slash, e.g. https://app.example.com
function resolveAllowedOrigin(env: Env, requestOrigin: string | null): string {
  const list = (env.APP_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (list.length === 0) return "*";
  if (requestOrigin && list.includes(requestOrigin)) return requestOrigin;
  return list[0];
}

function json(cors: Record<string, string>, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function methodNotAllowed(cors: Record<string, string>): Response {
  return json(cors, 405, { error: "method not allowed" });
}

function html(cors: Record<string, string>, status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...cors },
  });
}

/** Parse an application/x-www-form-urlencoded (or multipart) form body into a flat map. */
async function parseForm(request: Request): Promise<Record<string, string>> {
  try {
    const fd = await request.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
    return out;
  } catch {
    // Fallback: URL-encoded body parsed manually.
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
}

async function parseBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("invalid JSON body");
  }
}

function validateCreate(input: CreateWorkOrderInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (!input.projectId) throw new BadRequest("projectId is required");
  if (!input.subject) throw new BadRequest("subject is required");
  if (input.billingStatus !== undefined) {
    if (typeof input.billingStatus !== "string") throw new BadRequest("billingStatus must be a string");
    assertEnum(input.billingStatus, [...BILLING_STATUSES] as string[], "billingStatus");
  }
  // Scheduling is OPTIONAL. A schedule with only a partial date (e.g. the UI sent an
  // empty schedule object) is simply treated as "no schedule" in service.createWorkOrder,
  // so we don't reject it here.
}

function validateAddVisit(input: AddVisitInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (!input.start || !input.end) throw new BadRequest("start and end are required");
}

function validateLogHours(input: LogHoursInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (typeof input.hours !== "number" || !(input.hours > 0)) {
    throw new BadRequest("hours must be a positive number");
  }
}

// NOTE: there is deliberately NO local order_status whitelist here anymore. The
// current Zoho pick-list is Needed | On Order | Received | Backordered | Cancelled |
// Not Needed (default "Needed"), but the backend does not enforce it — status values
// are passed straight through to Zoho, which validates its own pick-list and returns
// a clear error the backend already surfaces. See validateUpdatePurchase below.

function validateUpdateWorkOrder(input: UpdateWorkOrderInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (input.status !== undefined) {
    assertEnum(input.status, ["action", "billing", "completed"], "status");
  }
  if (input.woStatus !== undefined) {
    if (typeof input.woStatus !== "string") throw new BadRequest("woStatus must be a string");
    assertEnum(input.woStatus, [...service.WO_STATUS_INPUTS] as string[], "woStatus");
  }
  if (input.billingStatus !== undefined) {
    if (typeof input.billingStatus !== "string") throw new BadRequest("billingStatus must be a string");
    assertEnum(input.billingStatus, [...BILLING_STATUSES] as string[], "billingStatus");
  }
}

function validateAddItem(input: AddItemInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (!input.item || typeof input.item !== "string") throw new BadRequest("item is required");
  if (input.status !== undefined && (typeof input.status !== "string" || !input.status.trim())) {
    throw new BadRequest("status, when supplied, must be a non-empty string");
  }
}

function validateCreateTodo(input: CreateTodoInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
    throw new BadRequest("title is required");
  }
  // status is NOT checked against a local whitelist — any value is passed straight through
  // to Zoho's `to_do-s` pick-list (Zoho validates its own options). We only reject an
  // explicitly-supplied empty/non-string status.
  if (input.status !== undefined && (typeof input.status !== "string" || !input.status.trim())) {
    throw new BadRequest("status, when supplied, must be a non-empty string");
  }
}

function validateUpdateTodo(input: UpdateTodoInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  // Every field optional; validate only what's supplied. Status is pass-through (see above).
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) {
    throw new BadRequest("title, when supplied, must be a non-empty string");
  }
  if (input.status !== undefined && (typeof input.status !== "string" || !input.status.trim())) {
    throw new BadRequest("status, when supplied, must be a non-empty string");
  }
}

function validateDailyReportEntry(input: AddDailyReportEntryInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  if (!input.text || typeof input.text !== "string" || !input.text.trim()) {
    throw new BadRequest("text is required");
  }
}

function validateUpdatePurchase(input: UpdatePurchaseInput): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  // Every field is optional; validate only what's supplied. Status is NOT checked
  // against a local allowed-list — any non-empty string is accepted and passed
  // straight through to Zoho, which validates its own pick-list (Craig has renamed
  // these labels twice; a backend whitelist was the fragility). We still reject a
  // missing/empty or non-string status when the key is present.
  if (input.status !== undefined) {
    if (typeof input.status !== "string" || !input.status.trim()) {
      throw new BadRequest("status must be a non-empty string");
    }
  }
}

function validateAdminConfig(input: Partial<AdminConfig>): void {
  if (!input || typeof input !== "object") throw new BadRequest("body required");
  // reportAccess is OPTIONAL on a partial update; when present it must be a string[].
  if (input.reportAccess !== undefined) {
    if (
      !Array.isArray(input.reportAccess) ||
      !input.reportAccess.every((e) => typeof e === "string")
    ) {
      throw new BadRequest("reportAccess must be an array of strings");
    }
  }
  // zohoUserOptions is OPTIONAL; when present it must be an array of strings
  // (normalization — trim/dedupe/drop-empty — happens in admin.normalize).
  if (input.zohoUserOptions !== undefined) {
    if (
      !Array.isArray(input.zohoUserOptions) ||
      !input.zohoUserOptions.every((o) => typeof o === "string")
    ) {
      throw new BadRequest("zohoUserOptions must be an array of strings");
    }
  }
  // schedulingConfirmer is OPTIONAL; a string when present.
  if (input.schedulingConfirmer !== undefined && typeof input.schedulingConfirmer !== "string") {
    throw new BadRequest("schedulingConfirmer must be a string");
  }
}

function assertEnum<T extends string>(value: T, allowed: T[], name: string): void {
  if (!allowed.includes(value)) {
    throw new BadRequest(`invalid ${name}: '${value}' (allowed: ${allowed.join(", ")})`);
  }
}

function errorResponse(cors: Record<string, string>, err: unknown): Response {
  if (err instanceof BadRequest) return json(cors, 400, { error: err.message });
  if (err instanceof TechnicianError) return json(cors, 400, { error: err.message });
  if (err instanceof PersonError) return json(cors, 400, { error: err.message });
  if (err instanceof DailyReportError) return json(cors, 400, { error: err.message });
  // P2: a `custom` payload that fails field_definitions validation.
  if (err instanceof CustomFieldError) return json(cors, 400, { error: err.message, fields: err.errors });
  if (err instanceof service.WorkOrderNotFound) return json(cors, 404, { error: err.message });
  // Completion gate: a WO can't be closed while it has unresolved requested parts.
  if (err instanceof service.CompletionGateError) return json(cors, 409, { error: err.message });
  if (err instanceof ConfigError) {
    // A required config value (e.g. ZOHO_WO_FIELD) isn't set yet.
    return json(cors, 501, { error: "not configured", detail: err.message });
  }
  if (err instanceof ZohoThrottleError) {
    // Zoho's 100-requests-per-API-per-2-minutes cap. Tell the UI when to retry (429 + Retry-After).
    const res = json(cors, 429, {
      error: "zoho rate limit",
      detail: `Zoho is rate-limiting this API — try again in about ${err.retryAfterMin} minute${err.retryAfterMin === 1 ? "" : "s"}.`,
      retryAfterMin: err.retryAfterMin,
    });
    res.headers.set("Retry-After", String(err.retryAfterMin * 60));
    return res;
  }
  if (err instanceof ZohoError) return json(cors, 502, { error: "zoho upstream error", detail: err.message });
  if (err instanceof CalendarError) return json(cors, 502, { error: "calendar upstream error", detail: err.message });
  console.error("unhandled error:", err);
  return json(cors, 500, { error: "internal error", detail: String((err as Error)?.message ?? err) });
}

class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}
