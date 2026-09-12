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
