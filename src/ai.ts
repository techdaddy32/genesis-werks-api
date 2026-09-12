//==============================================================================
// ai.ts — invoice-notes polish via the Anthropic Messages API.
//
// Turns a work order's raw technician notes into FHI's customer-facing
// invoice-notes house style. Used by POST /work-orders/:id/invoice-notes.
// The system prompt below is FHI's confirmed invoice-notes style — embed verbatim.
//==============================================================================

import type { Env } from "./types";

/** Default Anthropic model (overridable via env.AI_MODEL). */
const DEFAULT_AI_MODEL = "claude-haiku-4-5-20251001";

/** FHI's confirmed invoice-notes house-style system prompt (embedded verbatim). */
const INVOICE_NOTES_SYSTEM = `You write the customer-facing "notes" section of a service invoice for Future Home Integration (FHI Florida), an audio/video and home-automation company. Turn the raw technician field notes below into a short, polished, homeowner-facing summary. Rules:
- 3–5 sentences of professional flowing prose (2–3 for a small job; up to 6 for a big multi-item job). Minimal lines, full scope. Never pad a small job.
- Open with a brief header line naming the technician, date, and work-order reference when available, e.g. "Service by Mike R. on 3/12/2026 (WO #48213)." The lead verb may flex to the job ("Installation by…", "Structured wiring by…"). If the WO number, tech, or date is missing, gracefully omit that piece — never write "WO #N/A".
- One distinct task or finding per sentence, reading as a clean sequence of what was done.
- Prose only — never bullets or lists. This sits in an invoice notes field.
- Customer-facing plain language: translate jargon into outcomes a homeowner understands (e.g. "verified strong throughput in all zones" not "ran iperf").
- Describe only real, completed work. Drop arrival/departure times, internal quoting notes, remarks about the customer or prior installers, and speculative/future-quote chatter.
- If work was left unfinished with a return planned, report it in one clean, non-alarming closing sentence (e.g. "…will be completed on a scheduled return visit").
- For a multi-day/multi-tech job, collapse visits into one note, credit all techs in the header, use the completion date, and keep each phase as its own sentence.
- For a parts/sales-order-style input, convert line items into work-performed prose (SKUs → plain equipment names), inferring labor from any labor line without inventing detail.
Output ONLY the finished invoice note text — no preamble, no code fences, no commentary.`;

/** Input for the invoice-notes generator. */
export interface InvoiceNotesInput {
  woNumber: string | null;
  client: string | null;
  notes: string | null;
  hoursEntries?: Array<{ tech: string | null; at: string }>;
  /**
   * Assembled comprehensive raw material for the WHOLE work order — notes, visits,
   * hours, used items, requested parts, and daily-report entries across all days
   * (built by service.buildInvoiceNotesMaterial). When present, this is the primary
   * source handed to the model in place of just `notes`. The house-style system
   * prompt already knows how to turn raw material into invoice notes.
   */
  material?: string | null;
}

/** Shape of the Anthropic Messages API reply we read from. */
interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

/**
 * Build the user `content` handed to the model: a header line with the WO number
 * and client when present, an optional "Technicians/dates:" line summarizing the
 * distinct techs + earliest/latest logged date, then the raw notes verbatim.
 */
function buildUserContent(input: InvoiceNotesInput): string {
  const lines: string[] = [];

  const headerBits: string[] = [];
  if (input.woNumber && input.woNumber.trim()) headerBits.push(`Work Order: ${input.woNumber.trim()}`);
  if (input.client && input.client.trim()) headerBits.push(`Client: ${input.client.trim()}`);
  if (headerBits.length) lines.push(headerBits.join(" — "));

  const entries = input.hoursEntries ?? [];
  if (entries.length) {
    const techs = Array.from(
      new Set(entries.map((e) => (e.tech ?? "").trim()).filter((t) => t.length > 0))
    );
    const dates = entries
      .map((e) => (e.at ?? "").slice(0, 10))
      .filter((d) => d.length > 0)
      .sort();
    const bits: string[] = [];
    if (techs.length) bits.push(`techs ${techs.join(", ")}`);
    if (dates.length) {
      const first = dates[0];
      const last = dates[dates.length - 1];
      bits.push(first === last ? `on ${first}` : `${first} to ${last}`);
    }
    if (bits.length) lines.push(`Technicians/dates: ${bits.join("; ")}`);
  }

  if (lines.length) lines.push("");
  // Prefer the assembled whole-WO material when supplied; fall back to raw notes.
  const material = input.material && input.material.trim() ? input.material.trim() : null;
  if (material) {
    lines.push("Work order details:");
    lines.push(material);
  } else {
    lines.push("Raw technician notes:");
    lines.push(input.notes && input.notes.trim() ? input.notes.trim() : "(no notes recorded)");
  }

  return lines.join("\n");
}

/**
 * Generate polished, customer-facing invoice notes from a WO's raw material.
 * Throws Error("invoice-notes AI not configured: set ANTHROPIC_API_KEY") when the
 * key is missing (the route maps this to a clear 400), and a descriptive Error on
 * an upstream API failure.
 */
export async function generateInvoiceNotes(env: Env, input: InvoiceNotesInput): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("invoice-notes AI not configured: set ANTHROPIC_API_KEY");
  }
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: INVOICE_NOTES_SYSTEM,
      messages: [{ role: "user", content: buildUserContent(input) }],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`invoice-notes AI request failed: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  const text = data.content?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("invoice-notes AI returned no text");
  }
  return text.trim();
}
