//==============================================================================
// serialize/project.ts — projects row → ProjectHit (data-model §2.2, §4).
// Key order = service.ts searchProjectsUncached(); `custom` is the additive key.
//==============================================================================

import { customOut } from "../repo/_shared";
import { clientOf } from "./work-order";

/** Same shape as service.ts ProjectHit (declared here to avoid a service → repo → service cycle). */
export interface ProjectHit {
  id: string;
  key: string | null;
  name: string;
  client: string;
  siteAddress: string | null;
  siteCity: string | null;
  siteState: string | null;
  siteZip: string | null;
  isService: boolean;
  membershipLevel: string | null;
  custom?: Record<string, unknown>;
}

export interface ProjectRow {
  id: string;
  public_key: string;
  name: string;
  client_name: string | null;
  is_service: boolean;
  site_address: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  membership_level: string | null;
  custom: unknown;
}

export function serializeProject(r: ProjectRow): ProjectHit {
  return {
    id: r.id,
    key: r.public_key,
    name: r.name,
    client: r.client_name ?? clientOf(r.name),
    siteAddress: r.site_address ?? null,
    siteCity: r.site_city ?? null,
    siteState: r.site_state ?? null,
    siteZip: r.site_zip ?? null,
    isService: r.is_service === true,
    membershipLevel: r.membership_level || null,
    custom: customOut(r.custom),
  };
}
