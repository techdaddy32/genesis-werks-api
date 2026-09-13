//==============================================================================
// wonumber.ts — mint the composite Work Order number.
//
// Composite format (FHI default, tenant-configurable via tenant_settings
// numbering.work_order = {pattern, scope, pad, yearly_reset}):
//   {projectKey}-WO-{YYYY}-{seq4}      e.g.  FHI-672-WO-2026-0001
//   - projectKey : the client SERVICE project's key (e.g. FHI-672)
//   - WO-{year}-{seq} : the MINTED part; sequence resets every January.
//
// F3: the counter is the `sequences` table, advanced by mint_public_key_parts()
// inside ONE Postgres transaction (keys.ts) — truly atomic (row lock), no KV
// read-modify-write race. Scope ("global" | "per_project") now comes from the
// tenant's numbering.work_order.scope, not WO_SEQUENCE_SCOPE (config.ts still
// reports the env value on /health; the DB setting is authoritative for minting).
// The number is consumed by the COMMIT of the mint transaction; today's callers
// mint after the Zoho tasks exist (so the save is real), same as before.
//==============================================================================

import type { Env } from "./types";
import { withTenant } from "./db";
import { mintPublicKey } from "./keys";
import { tenantOf } from "./tenant";

const SEQ_PAD = 4;

export interface MintedWo {
  full: string;        // FHI-672-WO-2026-0001
  projectKey: string;  // FHI-672
  mintedRef: string;   // 2026-0001  (the year+seq shown in the second UI field)
  year: number;
  seq: number;
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
 * `projectKey` is the SERVICE project's key (e.g. "FHI-672"). `now` is accepted for
 * signature compatibility; the year is computed by the DB in the tenant's timezone.
 */
export async function mintWorkOrderNumber(
  env: Env,
  projectKey: string,
  _now: Date = new Date()
): Promise<MintedWo> {
  if (!projectKey) throw new Error("mintWorkOrderNumber: projectKey is required.");
  return withTenant(env, tenantOf(env), (tx) => mintPublicKey(tx, "work_order", projectKey));
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
