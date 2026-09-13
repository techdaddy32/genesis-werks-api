//==============================================================================
// time.ts — Eastern Time (America/New_York) date helpers.
//
// FHI operates in Eastern Time. Calendar-day bucketing (which day a daily report
// belongs to) and every DISPLAYED date/time must be Eastern, with EDT/EST handled
// automatically. Cloudflare Workers ship full ICU, so Intl.DateTimeFormat with
// timeZone "America/New_York" is reliable and switches EDT<->EST on its own.
//
// IMPORTANT: these helpers only affect DAY BUCKETING and DISPLAY. Stored instant
// timestamps (entry `at`, hours `at`) stay full ISO UTC — they are precise
// instants and are reformatted to ET only when shown.
//==============================================================================

const ET_TZ = "America/New_York";

/**
 * The calendar date in America/New_York as `YYYY-MM-DD`. en-CA formats numeric
 * dates in that order, so this is a clean day key (e.g. a report entered at 9pm
 * ET no longer lands on the next UTC day).
 */
export function todayET(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET_TZ }).format(d);
}

/**
 * A short readable ET date, e.g. `Aug 22, 2026`. Guards bad/empty input: returns
 * "" for empty input and the raw string when it can't be parsed.
 */
export function formatDateET(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/**
 * Date + time in ET, e.g. `Aug 22, 2026, 7:05 PM`. Same guard as formatDateET:
 * "" for empty input, the raw string when unparseable.
 */
export function formatDateTimeET(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/**
 * Normalize an hours-entry `date` input to a precise instant (F3, data-model §2.12):
 * a bare `YYYY-MM-DD` becomes midnight of that calendar day in America/New_York
 * (EDT/EST resolved automatically); any other parseable value is returned as its
 * ISO UTC instant; unparseable input → null (caller falls back to now()).
 */
export function normalizeEntryDateToIso(input: string | undefined | null): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Start from the UTC midnight guess and shift by the ET offset observed at that instant
    // (two passes so a DST boundary on that day resolves to the post-shift offset).
    let guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
    for (let i = 0; i < 2; i++) guess = Date.UTC(y, mo - 1, d) - etOffsetMs(new Date(guess));
    return new Date(guess).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Offset of America/New_York from UTC at the given instant, in ms (negative in the west). */
function etOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}
