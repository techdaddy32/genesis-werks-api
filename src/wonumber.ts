//==============================================================================
// wonumber.ts — mint the composite Work Order number with an atomic yearly
// counter backed by Cloudflare KV.
//
// Composite format (canonical spec):
//   {projectKey}-WO-{year}-{seq4}      e.g.  FHI-672-WO-2026-0001
//   - projectKey : the client SERVICE project's key (e.g. FHI-672)
//   - WO-{year}-{seq} : the MINTED part; sequence resets every January.
//
// Sequence SCOPE is configurable:
//   - "global"      : one portal-wide counter per year (spec default / assumed).
//   - "per_project" : a separate counter per project key per year.
// Switch via WO_SEQUENCE_SCOPE (config.ts sequenceScope()).
//==============================================================================

import type { Env } from "./types";
import { sequenceScope } from "./config";

const SEQ_PAD = 4;

export interface MintedWo {
  full: string;        // FHI-672-WO-2026-0001
  projectKey: string;  // FHI-672
  mintedRef: string;   // 2026-0001  (the year+seq shown in the second UI field)
  year: number;
  seq: number;
}

/** Build the KV key for the counter given scope + year (+ project key). */
function counterKey(env: Env, year: number, projectKey: string): string {
  if (sequenceScope(env) === "per_project") {
    return `wo_seq:${year}:${projectKey}`;
  }
  return `wo_seq:${year}:__global__`;
}

/**
 * Atomically (best-effort) increment and return the next sequence for the year.
 *
 * RACE WINDOW — read this before relying on it at high volume:
 *   Cloudflare KV is eventually-consistent and has no compare-and-swap. This is
 *   a read-modify-write: two requests that read the same value in the same
 *   instant could both write N+1 and collide. For FHI's service volume (a
 *   handful of WOs a day) that window is effectively never hit, so KV is fine.
 *
 *   Guard implemented here: after writing, we immediately re-read; if the stored
 *   value doesn't match what we wrote, someone else raced us — we back off and
 *   retry with the newly-observed value. This shrinks (does not eliminate) the
 *   window.
 *
 *   HARDENING PATH if volume ever demands true atomicity: move the counter to a
 *   Durable Object (single-threaded, strongly consistent) and call it from here
 *   instead of KV — the rest of this module stays the same. See README.
 */
async function nextSequence(env: Env, year: number, projectKey: string): Promise<number> {
  const key = counterKey(env, year, projectKey);
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await env.WO_KV.get(key);
    const currentSeq = current ? parseInt(current, 10) : 0;
    const nextSeq = currentSeq + 1;

    await env.WO_KV.put(key, String(nextSeq));

    // Guard: re-read and confirm nobody clobbered our write in the meantime.
    const confirm = await env.WO_KV.get(key);
    if (confirm !== null && parseInt(confirm, 10) === nextSeq) {
      return nextSeq;
    }
    // Someone raced us — loop and try again from the newly-observed value.
    // Small jitter reduces the chance of re-colliding on retry.
    await sleep(15 + Math.floor(Math.random() * 35));
  }

  throw new Error(
    `Could not atomically mint WO sequence for ${key} after ${MAX_RETRIES} attempts (KV contention).`
  );
}

/** Zero-pad the sequence to SEQ_PAD digits (0001, 0042, 1234, 12345 if it overflows). */
export function formatSeq(seq: number): string {
  return String(seq).padStart(SEQ_PAD, "0");
}

/** Compose the full string from parts — used by mint and by tests/back-fill. */
export function composeWoNumber(projectKey: string, year: number, seq: number): string {
  return `${projectKey}-WO-${year}-${formatSeq(seq)}`;
}

/**
 * Mint the next work-order number for a project.
 * `projectKey` is the SERVICE project's key (e.g. "FHI-672").
 */
export async function mintWorkOrderNumber(
  env: Env,
  projectKey: string,
  now: Date = new Date()
): Promise<MintedWo> {
  if (!projectKey) throw new Error("mintWorkOrderNumber: projectKey is required.");
  const year = now.getUTCFullYear();
  const seq = await nextSequence(env, year, projectKey);
  return {
    full: composeWoNumber(projectKey, year, seq),
    projectKey,
    mintedRef: `${year}-${formatSeq(seq)}`,
    year,
    seq,
  };
}

/** Parse a composite WO string back into parts (for GET/PATCH lookups). */
export function parseWoNumber(full: string): MintedWo | null {
  // {projectKey}-WO-{year}-{seq}. projectKey may itself contain hyphens (FHI-672),
  // so anchor on the "-WO-" separator.
  const m = full.match(/^(.*)-WO-(\d{4})-(\d+)$/);
  if (!m) return null;
  const [, projectKey, yearStr, seqStr] = m;
  return {
    full,
    projectKey,
    mintedRef: `${yearStr}-${seqStr}`,
    year: parseInt(yearStr, 10),
    seq: parseInt(seqStr, 10),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
