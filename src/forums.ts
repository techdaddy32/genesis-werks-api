//==============================================================================
// forums.ts — Zoho Projects Forums client (conversations + comments).
//
// Forums are PROJECT-level. Unlike the rest of the backend (which uses the v3 API
// at `${ZOHO_API_BASE}` = https://projectsapi.zoho.com/api/v3), the Forums API is
// only exposed on Zoho's OLDER REST base:
//     https://projectsapi.zoho.com/restapi/portal/{portal}/projects/{project}/forums/...
// Same OAuth token; different base + a form-encoded (not JSON) request body.
//
// Scope required on the token: ZohoProjects.forums.ALL (added to /setup 2026-08-27;
// requires a re-auth to take effect).
//
// Endpoints (per https://www.zoho.com/projects/help/rest-api/forums-api.html):
//   GET  /forums/                          list conversations (?category_id, index, range)
//   GET  /forums/{fid}/                     one conversation (with content/followers)
//   POST /forums/                           add conversation (name*, content*, category_id*, flag, type)
//   POST /forums/{fid}/                     update conversation (name*, content*, category_id*)
//   GET  /forums/{fid}/comments/            list comments (threaded: parent_id/level/root_id)
//   POST /forums/{fid}/comments/            add comment (content*, parent_id?, type?)
//   POST /forums/{fid}/comments/{cid}/      update comment (content*)
//   GET  /categories/                       list forum categories
//   POST /categories/                       add category (name*)
//
// VERIFY-LIVE (2026-08-27): write parameters (name/content/category_id/…) are sent
// on the QUERY STRING — the classic Zoho Projects REST convention (params are query
// params even on POST; the body is reserved for multipart file uploads). If a
// create/update ever 400s on "mandatory parameter", the fallback is to send them as
// an application/x-www-form-urlencoded body instead — isolated in restFetch so it's
// a one-line change (set FORM_IN_BODY = true).
//==============================================================================

import type { Env } from "./types";
import { getAccessToken, ZohoError, zohoFailure } from "./zoho";

/** Derive the classic REST base (…/restapi) from the v3 API base's origin. */
function restBase(env: Env): string {
  try {
    return new URL(env.ZOHO_API_BASE).origin + "/restapi";
  } catch {
    return "https://projectsapi.zoho.com/restapi";
  }
}

const portal = (env: Env) => env.ZOHO_PORTAL_ID;
const forumsRoot = (env: Env, projectId: string) =>
  `/portal/${portal(env)}/projects/${projectId}/forums`;
const categoriesRoot = (env: Env, projectId: string) =>
  `/portal/${portal(env)}/projects/${projectId}/categories`;

//------------------------------------------------------------------------------
// Low-level request helper (mirrors zoho.ts's zohoFetch, but on the REST base and
// with a form-encoded body for writes).
//------------------------------------------------------------------------------
async function restFetch(
  env: Env,
  path: string,
  init: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    form?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
  } = {}
): Promise<any> {
  // Classic Zoho Projects REST wants params on the query string even for POST. Flip
  // this if a live test shows a create/update needs a urlencoded BODY instead.
  const FORM_IN_BODY = false;

  const token = await getAccessToken(env);
  const { method = "GET", query, form, headers } = init;

  let url = restBase(env) + path;
  const qs = (obj: Record<string, string | number | boolean | undefined>) =>
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");

  const merged: Record<string, string | number | boolean | undefined> = { ...(query ?? {}) };
  if (form && !FORM_IN_BODY) Object.assign(merged, form);
  const s = qs(merged);
  if (s) url += (url.includes("?") ? "&" : "?") + s;

  let body: string | undefined;
  const reqHeaders: Record<string, string> = {
    Authorization: `Zoho-oauthtoken ${token}`,
    Accept: "application/json",
    ...headers,
  };
  if (form && FORM_IN_BODY) {
    body = qs(form);
    reqHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(url, { method, headers: reqHeaders, body });
  if (!res.ok) {
    let detail = "<no body>";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw zohoFailure(`Zoho forums ${method} ${path} failed`, res.status, detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

//------------------------------------------------------------------------------
// Normalized shapes returned to the app.
//------------------------------------------------------------------------------
export interface Forum {
  id: string;
  name: string;
  content: string;
  flag: string; // "internal" (project users only) | "external" (project + client)
  type: string; // "normal" (discussion) | "question" (Q&A)
  categoryId: string | null;
  commentCount: number;
  postedPerson: string | null;
  postDate: string | null; // human-formatted (post_date_format)
  postDateLong: number | null; // epoch ms
  lastActivityLong: number | null; // epoch ms (for sorting newest-active)
  isSticky: boolean;
  isAnnouncement: boolean;
}

export interface ForumComment {
  id: string;
  content: string;
  level: string; // "1" top-level, "2" nested reply, …
  type: string; // "normal" | "question" | "answer"
  parentId: string | null; // comment replied to ("-" in raw => null)
  rootId: string | null;
  postedPerson: string | null;
  postDate: string | null; // human-formatted
  postDateLong: number | null;
  isBestAnswer: boolean;
}

export interface ForumCategory {
  id: string;
  name: string;
}

//------------------------------------------------------------------------------
// Normalizers — isolate the "which field is it really called" guesses here.
//------------------------------------------------------------------------------
const cleanRef = (v: any): string | null => {
  const s = v == null ? "" : String(v);
  return s === "" || s === "-" ? null : s;
};

/**
 * The forum id. The "All Forums" list payload has a documented quirk where the
 * top-level `id` can echo `category_id`; the authoritative id is the trailing
 * segment of link.self.url (…/forums/{id}/). Prefer that, fall back to `id`.
 */
function extractForumId(raw: any): string {
  const selfUrl: string | undefined = raw?.link?.self?.url;
  if (selfUrl) {
    const m = String(selfUrl).match(/\/forums\/(\d+)\/?$/);
    if (m) return m[1];
  }
  return String(raw?.id ?? "");
}

function normalizeForum(f: any): Forum {
  return {
    id: extractForumId(f),
    name: String(f?.name ?? ""),
    content: String(f?.content ?? ""),
    flag: String(f?.flag ?? "internal"),
    type: String(f?.type ?? "normal"),
    categoryId: cleanRef(f?.category_id),
    commentCount: Number(f?.comment_count ?? 0),
    postedPerson: f?.posted_person ?? null,
    postDate: f?.post_date_format ?? f?.post_date ?? null,
    postDateLong: f?.post_date_long != null ? Number(f.post_date_long) : null,
    lastActivityLong:
      f?.last_activity_time_long != null
        ? Number(f.last_activity_time_long)
        : f?.last_modified_time_long != null
        ? Number(f.last_modified_time_long)
        : null,
    isSticky: Boolean(f?.is_sticky_post),
    isAnnouncement: Boolean(f?.is_announcement_post),
  };
}

function normalizeComment(c: any): ForumComment {
  return {
    id: String(c?.id ?? ""),
    content: String(c?.content ?? ""),
    level: String(c?.level ?? "1"),
    type: String(c?.type ?? "normal"),
    parentId: cleanRef(c?.parent_id),
    rootId: cleanRef(c?.root_id),
    postedPerson: c?.posted_person ?? null,
    postDate: c?.post_date_format ?? c?.post_date ?? null,
    postDateLong: c?.post_date_long != null ? Number(c.post_date_long) : null,
    isBestAnswer: Boolean(c?.is_best_answer),
  };
}

function normalizeCategory(c: any): ForumCategory {
  return { id: String(c?.id ?? ""), name: String(c?.name ?? "") };
}

//------------------------------------------------------------------------------
// Forums (conversations)
//------------------------------------------------------------------------------

/** List a project's forum conversations (newest activity first). */
export async function listForums(
  env: Env,
  projectId: string,
  opts: { categoryId?: string } = {}
): Promise<Forum[]> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/`, {
    query: { index: 1, range: 200, category_id: opts.categoryId },
  });
  const forums: any[] = data?.forums ?? [];
  const out = forums.map(normalizeForum);
  out.sort((a, b) => (b.lastActivityLong ?? 0) - (a.lastActivityLong ?? 0));
  return out;
}

/** One conversation's details. */
export async function getForum(env: Env, projectId: string, forumId: string): Promise<Forum | null> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/${forumId}/`);
  const f = data?.forums?.[0];
  return f ? normalizeForum(f) : null;
}

export interface AddForumInput {
  name: string;
  content: string;
  categoryId: string;
  flag?: string; // internal | external
  type?: string; // normal | question
  notify?: string; // comma-separated emails
}

/** Add a conversation. name/content/categoryId are mandatory (Zoho). */
export async function addForum(env: Env, projectId: string, input: AddForumInput): Promise<Forum | null> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/`, {
    method: "POST",
    form: {
      name: input.name,
      content: input.content,
      category_id: input.categoryId,
      flag: input.flag,
      type: input.type,
      notify: input.notify,
    },
  });
  const f = data?.forums?.[0];
  return f ? normalizeForum(f) : null;
}

export interface UpdateForumInput {
  name: string;
  content: string;
  categoryId: string;
  flag?: string;
  type?: string;
}

/** Update a conversation. Zoho requires name/content/categoryId on update too. */
export async function updateForum(
  env: Env,
  projectId: string,
  forumId: string,
  input: UpdateForumInput
): Promise<Forum | null> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/${forumId}/`, {
    method: "POST",
    form: {
      name: input.name,
      content: input.content,
      category_id: input.categoryId,
      flag: input.flag,
      type: input.type,
    },
  });
  const f = data?.forums?.[0];
  return f ? normalizeForum(f) : null;
}

/** Delete a conversation. Swallows a 404 (already gone). */
export async function deleteForum(env: Env, projectId: string, forumId: string): Promise<void> {
  try {
    await restFetch(env, `${forumsRoot(env, projectId)}/${forumId}/`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof ZohoError && /\b404\b/.test(String(e.message))) return;
    throw e;
  }
}

//------------------------------------------------------------------------------
// Comments (threaded)
//------------------------------------------------------------------------------

/** List a conversation's comments (in Zoho's returned order). */
export async function listComments(
  env: Env,
  projectId: string,
  forumId: string
): Promise<ForumComment[]> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/${forumId}/comments/`, {
    query: { index: 1, range: 200 },
  });
  const comments: any[] = data?.comments ?? [];
  return comments.map(normalizeComment);
}

export interface AddCommentInput {
  content: string;
  parentId?: string; // reply-to comment id (threading)
  type?: string; // question | answer | normal
  notify?: string; // comma-separated emails
}

/** Add a comment (optionally a threaded reply via parentId). */
export async function addComment(
  env: Env,
  projectId: string,
  forumId: string,
  input: AddCommentInput
): Promise<ForumComment | null> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/${forumId}/comments/`, {
    method: "POST",
    form: {
      content: input.content,
      parent_id: input.parentId,
      type: input.type,
      notify_users: input.notify,
    },
  });
  const c = data?.comments?.[0];
  return c ? normalizeComment(c) : null;
}

/** Update a comment's content. */
export async function updateComment(
  env: Env,
  projectId: string,
  forumId: string,
  commentId: string,
  content: string
): Promise<ForumComment | null> {
  const data = await restFetch(env, `${forumsRoot(env, projectId)}/${forumId}/comments/${commentId}/`, {
    method: "POST",
    form: { content },
  });
  const c = data?.comments?.[0];
  return c ? normalizeComment(c) : null;
}

//------------------------------------------------------------------------------
// Categories (a conversation requires one)
//------------------------------------------------------------------------------

/** List a project's forum categories. */
export async function listCategories(env: Env, projectId: string): Promise<ForumCategory[]> {
  const data = await restFetch(env, `${categoriesRoot(env, projectId)}/`);
  const cats: any[] = data?.categories ?? [];
  return cats.map(normalizeCategory);
}

/** Add a forum category (name only). */
export async function addCategory(env: Env, projectId: string, name: string): Promise<ForumCategory | null> {
  const data = await restFetch(env, `${categoriesRoot(env, projectId)}/`, {
    method: "POST",
    form: { name },
  });
  const c = data?.categories?.[0];
  return c ? normalizeCategory(c) : null;
}

/**
 * Ensure a category exists to hang a new conversation on: return the first existing
 * category, else create a default one ("General"). Lets the UI post a conversation
 * without forcing the user to pick/create a category first.
 */
export async function ensureDefaultCategory(env: Env, projectId: string): Promise<ForumCategory> {
  const existing = await listCategories(env, projectId);
  if (existing.length) return existing[0];
  const created = await addCategory(env, projectId, "General");
  if (!created) throw new ZohoError("Could not create a default forum category.");
  return created;
}
