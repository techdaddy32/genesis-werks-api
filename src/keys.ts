//==============================================================================
// keys.ts — public-key minting through the DB (F2). Replaces the KV counter in
// wonumber.ts once F3 retires WO_KV; wonumber.ts is untouched in this row.
//
// SQL (0001 §8):
//   mint_public_key_parts(p_tenant uuid, p_kind text, p_project_key text DEFAULT NULL)
//     RETURNS TABLE (public_key text, seq int, year int)
//   mint_public_key(p_tenant uuid, p_kind text, p_project_key text DEFAULT NULL)
//     RETURNS text
// Both read tenant_settings `numbering.<kind>` and advance `sequences` with a
// single INSERT ... ON CONFLICT DO UPDATE ... RETURNING (row-lock serialised,
// so concurrent callers never collide). The number is consumed only if the
// caller's transaction commits — call this INSIDE the same withTenant() tx as
// the row insert so a failed insert never burns a number.
//
// Returned shape == wonumber.ts MintedWo so callers can switch at F3.
//==============================================================================

import type { Tx } from "./db";
import type { MintedWo } from "./wonumber";

export type { MintedWo };

/** kinds seeded for FHI: work_order | project | deal (any key with a numbering.<kind> setting works). */
export type PublicKeyKind = "work_order" | "project" | "deal" | (string & {});

interface MintRow {
  public_key: string;
  seq: number;
  year: number;
}

/**
 * Mint the next public key of `kind` for the transaction's tenant.
 * `projectKey` fills {projectKey} (required when the kind's scope is per_project).
 */
export async function mintPublicKey(tx: Tx, kind: PublicKeyKind, projectKey?: string): Promise<MintedWo> {
  if (!kind) throw new Error("mintPublicKey: kind is required.");
  const rows = await tx<MintRow[]>`
    select m.public_key, m.seq, m.year
    from public.mint_public_key_parts(public.app_tenant_id(), ${kind}, ${projectKey ?? null}) m`;
  if (rows.length !== 1) throw new Error(`mintPublicKey: expected 1 row from mint_public_key_parts, got ${rows.length}`);
  const r = rows[0];
  const seq = Number(r.seq);
  const year = Number(r.year);
  return {
    full: r.public_key,
    projectKey: projectKey ?? "",
    mintedRef: mintedRef(r.public_key, year, seq),
    year,
    seq,
  };
}

/** Formatted key only (mint_public_key). Same allocation semantics as mintPublicKey(). */
export async function mintPublicKeyString(tx: Tx, kind: PublicKeyKind, projectKey?: string): Promise<string> {
  const rows = await tx<{ key: string }[]>`
    select public.mint_public_key(public.app_tenant_id(), ${kind}, ${projectKey ?? null}) as key`;
  return rows[0].key;
}

/**
 * The "minted part" shown in the second UI field. For the WO pattern
 * ({projectKey}-WO-{YYYY}-{seq4}) that is "2026-0001" — read straight off the
 * formatted key so padding always matches the tenant's pattern. Other kinds
 * fall back to "<year>-<seq>".
 */
function mintedRef(full: string, year: number, seq: number): string {
  const m = full.match(/-WO-(\d{4}-\d+)$/);
  return m ? m[1] : `${year}-${seq}`;
}
