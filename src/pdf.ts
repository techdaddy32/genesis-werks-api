//==============================================================================
// pdf.ts — a minimal, dependency-free PDF writer for plain text.
//
// Zoho Projects v3 has NO reliable task-attachment endpoint on our API base
// (attachments live on the old /restapi/ multipart base), so daily-report PDFs
// are generated and served by the Worker itself. This module lays out plain text
// lines in Helvetica on Letter-size pages, wrapping long lines and paginating
// when a page fills, and emits a valid %PDF-1.4 byte stream with a correct xref
// table so it opens in Chrome / Acrobat.
//
// Runs in a Cloudflare Worker: uses ONLY btoa/TextEncoder-free byte assembly
// (no Node APIs). Every character is written as a single byte (char code & 0xff)
// so JS string lengths equal byte offsets — which is what keeps the xref honest.
//==============================================================================

// Letter-size page geometry (points; 72pt = 1in).
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75in
const FONT_SIZE = 10;
const LEADING = 14; // line height

const START_Y = PAGE_HEIGHT - MARGIN; // first baseline
const USABLE_HEIGHT = START_Y - MARGIN;
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN;
// Lines per page (integer count that fits within the usable height).
const MAX_LINES_PER_PAGE = Math.max(1, Math.floor(USABLE_HEIGHT / LEADING));
// Approximate max characters per line. Helvetica averages ~0.5em per glyph, so
// USABLE_WIDTH / (fontSize * 0.5) is a safe, slightly-conservative wrap width.
const MAX_CHARS_PER_LINE = Math.max(8, Math.floor(USABLE_WIDTH / (FONT_SIZE * 0.5)));

/**
 * Build a plain-text PDF (Letter, Helvetica) from an array of text lines.
 * Long lines are word-wrapped; overly long words are hard-broken; the document
 * paginates automatically. Returns the raw PDF bytes.
 */
export function buildDailyReportPdf(lines: string[]): Uint8Array {
  // 1) Wrap every input line, preserving blank lines.
  const wrapped: string[] = [];
  const src = lines.length ? lines : [""];
  for (const raw of src) {
    for (const chunk of wrapLine(raw ?? "", MAX_CHARS_PER_LINE)) wrapped.push(chunk);
  }

  // 2) Paginate.
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += MAX_LINES_PER_PAGE) {
    pages.push(wrapped.slice(i, i + MAX_LINES_PER_PAGE));
  }
  if (!pages.length) pages.push([""]);

  // 3) Assemble objects. Numbering:
  //    1 = Catalog, 2 = Pages, 3 = Font, then one Page + one Contents per page.
  const pageObjNums = pages.map((_, p) => 4 + p);
  const contentObjNums = pages.map((_, p) => 4 + pages.length + p);
  const objCount = 3 + 2 * pages.length;

  const bytes: number[] = [];
  const offsets: number[] = []; // offsets[objNum] = byte offset of that object
  const push = (str: string) => {
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
  };
  const startObj = (num: number) => {
    offsets[num] = bytes.length;
    push(`${num} 0 obj\n`);
  };

  push("%PDF-1.4\n");
  // Binary marker comment (tells readers the file contains binary data).
  push("%\xE2\xE3\xCF\xD3\n");

  // Catalog
  startObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Pages
  startObj(2);
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  // Font (Helvetica, WinAnsi so Latin-1 text renders correctly).
  startObj(3);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");

  // Page objects.
  for (let p = 0; p < pages.length; p++) {
    startObj(pageObjNums[p]);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNums[p]} 0 R >>\nendobj\n`
    );
  }

  // Content streams.
  for (let p = 0; p < pages.length; p++) {
    const content = buildContentStream(pages[p]);
    startObj(contentObjNums[p]);
    // content is pure Latin-1 (single-byte chars), so JS length == byte length.
    push(`<< /Length ${content.length} >>\nstream\n`);
    push(content);
    push("\nendstream\nendobj\n");
  }

  // xref table.
  const xrefOffset = bytes.length;
  const size = objCount + 1; // +1 for the free object 0
  push(`xref\n0 ${size}\n`);
  push("0000000000 65535 f \n"); // object 0 (always free)
  for (let n = 1; n < size; n++) {
    push(`${pad10(offsets[n] ?? 0)} 00000 n \n`);
  }

  // Trailer.
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Uint8Array.from(bytes);
}

/**
 * Generic alias for {@link buildDailyReportPdf}: the same plain-text PDF writer,
 * named for the general case. Any feature that needs a plain-text PDF (daily
 * reports, work-order summaries, …) can call this — the engine is identical.
 */
export const buildTextPdf = buildDailyReportPdf;

/** Draw a page's lines as one text content stream (BT ... Tj/T-star ... ET). */
function buildContentStream(pageLines: string[]): string {
  let s = `BT\n/F1 ${FONT_SIZE} Tf\n${MARGIN} ${START_Y} Td\n${LEADING} TL\n`;
  for (let i = 0; i < pageLines.length; i++) {
    s += `(${pdfEscape(pageLines[i])}) Tj\n`;
    if (i < pageLines.length - 1) s += "T*\n"; // advance to next line by leading
  }
  s += "ET";
  return s;
}

/**
 * Word-wrap a single logical line to a max character count. Blank input yields a
 * single blank line (so vertical spacing is preserved). Words longer than the
 * limit are hard-broken.
 */
function wrapLine(text: string, maxChars: number): string[] {
  const t = (text ?? "").replace(/\t/g, "    ").replace(/\r/g, "");
  if (t.length === 0) return [""];
  const out: string[] = [];
  let cur = "";
  for (let word of t.split(" ")) {
    // Hard-break a word that can't fit on a line by itself.
    while (word.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (cur === "") cur = word;
    else if ((cur + " " + word).length <= maxChars) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  out.push(cur);
  return out;
}

// Common typographic characters (outside the single-byte WinAnsi range we emit)
// mapped to readable ASCII so they render as intended instead of "?".
const ASCII_FOLD: Record<string, string> = {
  "—": "-",  // em dash —
  "–": "-",  // en dash –
  "‒": "-",  // figure dash
  "‘": "'",  // left single quote ‘
  "’": "'",  // right single quote / apostrophe ’
  "“": '"',  // left double quote “
  "”": '"',  // right double quote ”
  "…": "...", // ellipsis …
  " ": " ",  // non-breaking space
  "•": "*",  // bullet •
};

/** Escape a string for a PDF literal string: (, ), and backslash; fold non-Latin1 to ASCII. */
function pdfEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (ASCII_FOLD[ch] !== undefined) ch = ASCII_FOLD[ch]; // — ' " … etc -> ASCII
    for (let j = 0; j < ch.length; j++) {
      const c = ch[j];
      const code = ch.charCodeAt(j);
      if (c === "\\") out += "\\\\";
      else if (c === "(") out += "\\(";
      else if (c === ")") out += "\\)";
      else if (code < 32 || code > 255) out += "?"; // still outside WinAnsi single-byte range
      else out += c;
    }
  }
  return out;
}

/** Zero-pad an integer to the 10-digit width an xref offset entry requires. */
function pad10(n: number): string {
  return String(n).padStart(10, "0");
}
