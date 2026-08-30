/** Client — lexicon-style record CRUD orchestration: build a provider from a
 *  flat config, list/create/update/delete records, plus an upsert helper the
 *  DDNS engine builds on. */

import type { DnsProvider, DnsRecord, ListFilter, ProviderConfig, PushProvider, ZoneProvider } from "./types.ts";
import { createCloudflare } from "./providers/cloudflare/index.ts";
import { createDnspod } from "./providers/dnspod/index.ts";
import { createAliyun } from "./providers/aliyun/index.ts";
import { createDuckdns } from "./providers/duckdns/index.ts";
import { createCustom } from "./providers/custom/index.ts";
import { createFreedns } from "./providers/freedns/index.ts";

export type ProviderLike = DnsProvider;

export function isPushProvider(p: DnsProvider): p is PushProvider {
  return p.meta.style === "push";
}

export function isZoneProvider(p: DnsProvider): p is ZoneProvider {
  return p.meta.style === "zone";
}

/** Provider registry — build a provider from a flat config. Unknown names
 *  throw (register more providers here as they land). */
export function createProvider(cfg: ProviderConfig): DnsProvider {
  switch (cfg.provider) {
    case "cloudflare": return createCloudflare(cfg);
    case "dnspod": return createDnspod(cfg);
    case "aliyun": return createAliyun(cfg);
    case "duckdns": return createDuckdns(cfg);
    case "custom": return createCustom(cfg);
    case "freedns": return createFreedns(cfg);
    default:
      throw new Error(`unknown provider: ${cfg.provider}`);
  }
}

export async function listRecords(cfg: ProviderConfig, zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
  const p = createProvider(cfg);
  if (isPushProvider(p)) throw new Error(`provider '${cfg.provider}' is push-style — it has no record list`);
  return p.listRecords(zone, filter);
}

export async function createRecord(cfg: ProviderConfig, zone: string, rec: DnsRecord): Promise<{ id: string }> {
  const p = createProvider(cfg);
  if (isPushProvider(p)) throw new Error(`provider '${cfg.provider}' is push-style — it has no record create`);
  return p.createRecord(zone, rec);
}

export async function updateRecord(cfg: ProviderConfig, zone: string, rec: DnsRecord, id: string): Promise<void> {
  const p = createProvider(cfg);
  if (isPushProvider(p)) throw new Error(`provider '${cfg.provider}' is push-style — it has no record update`);
  return p.updateRecord(zone, rec, id);
}

export async function deleteRecord(cfg: ProviderConfig, zone: string, id: string): Promise<void> {
  const p = createProvider(cfg);
  if (isPushProvider(p)) throw new Error(`provider '${cfg.provider}' is push-style — it has no record delete`);
  return p.deleteRecord(zone, id);
}

/** Find a record by (type, name) and delete it — lexicon's
 *  `delete_record` with matching semantics. */
export async function deleteRecordByName(cfg: ProviderConfig, zone: string, name: string, type: string): Promise<boolean> {
  const p = createProvider(cfg);
  if (isPushProvider(p)) throw new Error(`provider '${cfg.provider}' is push-style — it has no record delete`);
  const found = await p.listRecords(zone, { type, name });
  if (!found.length) return false;
  await p.deleteRecord(zone, found[0]!.id!);
  return true;
}

/** Upsert (create-or-update) — the DDNS engine's write path. Returns
 *  { created } so callers can tell which branch ran. */
export async function upsertRecord(
  cfg: ProviderConfig,
  zone: string,
  rec: DnsRecord,
): Promise<{ created: boolean }> {
  const p = createProvider(cfg);
  if (isPushProvider(p)) throw new Error(`provider '${cfg.provider}' is push-style — it has no upsert`);
  const found = await p.listRecords(zone, { type: rec.type, name: rec.name });
  const match = found.find((r) => r.type === rec.type && r.name === rec.name);
  if (match) {
    await p.updateRecord(zone, rec, match.id!);
    return { created: false };
  }
  await p.createRecord(zone, rec);
  return { created: true };
}
