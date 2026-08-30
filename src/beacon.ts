/** Beacon — dimension-2 capability: keep an arbitrary VALUE (a tunnel
 *  hostname, a full URL) registered under a FIXED name, so anyone can
 *  discover the current value with a plain nslookup — even when the value
 *  cannot be used directly (hosted tunnel domains: TLS/SNI mismatch).
 *
 *  The beacon record does not need to be *usable* — it needs to be
 *  *queryable*. CNAME carries a bare hostname; TXT can carry a full URL.
 */

import type { ProviderConfig, RecordType, ZoneProvider } from "./types.ts";
import { createProvider, isZoneProvider } from "./client.ts";
import { normalizeName } from "./providers/common.ts";

export type BeaconType = "CNAME" | "TXT";

export interface BeaconOptions {
  /** Zone-style provider config (beacons need CRUD). */
  provider: ProviderConfig;
  /** Root zone of the beacon name. */
  zone: string;
  /** Fixed beacon name, e.g. "discover.example.com". */
  name: string;
  /** CNAME (bare hostname) or TXT (anything, URLs recommended). */
  type?: BeaconType;
  /** The value to register: a hostname, or a full URL (CNAME extracts the
   *  host automatically). */
  value: string;
  ttl?: number;
}

export interface BeaconResult {
  name: string;
  type: BeaconType;
  value: string;
  created: boolean;
}

/** Normalize a beacon value for the record type: CNAME must hold a bare
 *  hostname (strip scheme/path); TXT keeps the input as-is (full URLs OK). */
export function beaconValue(input: string, type: BeaconType): string {
  if (type === "CNAME") {
    try {
      const u = new URL(input.includes("://") ? input : `http://${input}`);
      if (u.port) throw new Error("CNAME target must not carry a port");
      return normalizeName(u.host);
    } catch {
      const stripped = input.replace(/^https?:\/\//, "").split("/")[0] ?? input;
      return normalizeName(stripped);
    }
  }
  return input;
}

/** Upsert the beacon record. Returns whether it was created. */
export async function setBeacon(opts: BeaconOptions): Promise<BeaconResult> {
  const type: BeaconType = opts.type ?? "CNAME";
  const value = beaconValue(opts.value, type);
  const p = createProvider(opts.provider) as ZoneProvider | ReturnType<typeof createProvider>;
  if (!isZoneProvider(p)) {
    throw new Error(`beacon requires a zone-style provider (got '${opts.provider.provider}', style '${p.meta.style}')`);
  }
  const found = await p.listRecords(opts.zone, { type, name: opts.name });
  const match = found.find((r) => r.type === type && normalizeName(r.name) === normalizeName(opts.name));
  if (match && normalizeName(match.value) === normalizeName(value)) {
    return { name: opts.name, type, value, created: false }; // already in sync
  }
  if (match) {
    await p.updateRecord(opts.zone, { type, name: opts.name, value, ttl: opts.ttl }, match.id!);
    return { name: opts.name, type, value, created: false };
  }
  await p.createRecord(opts.zone, { type, name: opts.name, value, ttl: opts.ttl });
  return { name: opts.name, type, value, created: true };
}

/** Convenience: setBeacon with the record type widened to RecordType for
 *  callers that already hold a DnsRecord shape. */
export function isBeaconType(t: RecordType): t is BeaconType {
  return t === "CNAME" || t === "TXT";
}
