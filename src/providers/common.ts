/** Shared provider plumbing: errors, zone/owner splitting (lexicon model),
 *  a fetch adapter that tolerates test base URLs. */

import type { FetchLike, ProviderConfig } from "../types.ts";

/** Provider API error with the provider's own code/message when available. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly apiCode?: string;

  constructor(message: string, provider: string, status?: number, apiCode?: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.apiCode = apiCode;
  }
}

/** Normalize a DNS name for comparison: lowercase + strip trailing dot.
 *  DNS names are case-insensitive and FQDNs conventionally end with "." —
 *  config values like "Home.example.com." must match provider responses. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/** Split an FQDN into [owner, rootZone] given the root zone. Mirrors
 *  lexicon's `name_to_zone` semantics:
 *    splitZone("home.example.com", "example.com") → ["home", "example.com"]
 *    splitZone("example.com", "example.com")      → ["@", "example.com"]
 *  Throws when the record is not under the zone. */
export function splitZone(record: string, zone: string): [string, string] {
  const r = record.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  if (r === z) return ["@", z];
  if (r.endsWith(`.${z}`)) return [r.slice(0, -(z.length + 1)), z];
  throw new ProviderError(`record '${record}' is not under zone '${zone}'`, "core");
}

/** Form-encode an object (dnspod uses application/x-www-form-urlencoded). */
export function formEncode(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  return p.toString();
}

/** Default fetch adapter (global fetch). */
export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/** Resolve the effective base URL for a provider (test override support). */
export function baseUrl(cfg: ProviderConfig, official: string): string {
  return cfg.baseUrl ?? official;
}
