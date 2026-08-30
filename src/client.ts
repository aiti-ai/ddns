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
import { createDreamhost, createDondominio, createNetcup, createNamesilo, createSpaceship, createNamecheap, createDnsmadeeasy, createUltradns, createConstellix, createDnsservices } from "./providers/special.ts";
import { createAurora, createCloudxns, createYandex, createGratisdns, createTransip, createQcloud, createHostingde, createHttpnet, createWedos, createNfsn, createYandexcloud, createValuedomain, createRackspace, createMemset, createGehirn, createRcodezero, createDevnomads, createMisaka, createDinahosting, createJoker, createPowerdns, createDirectadmin, createInfoblox, createAzure, createOci, createSoftlayer, createPlesk, createEuserv, createLocalzone, createEasyname, createGransy, createHover } from "./providers/lexicon-more.ts";
import { createRoute53 } from "./providers/route53.ts";
import { createGcp } from "./providers/gcp.ts";
import { normalizeName } from "./providers/common.ts";
import { registry } from "./plugins.ts";
import { RestProvider } from "./providers/rest.ts";
import { REST_SPECS } from "./providers/rest-specs.ts";
import { DyndnsProvider } from "./providers/dyndns.ts";
import { DYNDNS_SERVICES } from "./providers/dyndns-services.ts";

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
    case "namecheap": return createNamecheap(cfg);
    case "dnsmadeeasy": return createDnsmadeeasy(cfg);
    case "ultradns": return createUltradns(cfg);
    case "constellix": return createConstellix(cfg);
    case "dnsservices": return createDnsservices(cfg);
    case "aurora": return createAurora(cfg);
    case "cloudxns": return createCloudxns(cfg);
    case "yandex": return createYandex(cfg);
    case "gratisdns": return createGratisdns(cfg);
    case "transip": return createTransip(cfg);
    case "qcloud": return createQcloud(cfg);
    case "hostingde": return createHostingde(cfg);
    case "httpnet": return createHttpnet(cfg);
    case "wedos": return createWedos(cfg);
    case "nfsn": return createNfsn(cfg);
    case "yandexcloud": return createYandexcloud(cfg);
    case "valuedomain": return createValuedomain(cfg);
    case "rackspace": return createRackspace(cfg);
    case "memset": return createMemset(cfg);
    case "gehirn": return createGehirn(cfg);
    case "rcodezero": return createRcodezero(cfg);
    case "devnomads": return createDevnomads(cfg);
    case "misaka": return createMisaka(cfg);
    case "dinahosting": return createDinahosting(cfg);
    case "joker": return createJoker(cfg);
    case "powerdns": return createPowerdns(cfg);
    case "directadmin": return createDirectadmin(cfg);
    case "infoblox": return createInfoblox(cfg);
    case "azure": return createAzure(cfg);
    case "oci": return createOci(cfg);
    case "softlayer": return createSoftlayer(cfg);
    case "plesk": return createPlesk(cfg);
    case "henet": return createHeAlias(cfg);
    case "euserv": return createEuserv(cfg);
    case "localzone": return createLocalzone(cfg);
    case "easyname": return createEasyname(cfg);
    case "gransy": return createGransy(cfg);
    case "hover": return createHover(cfg);
    case "linode4": return createLinodeAlias(cfg);
    case "zeit": return createVercelAlias(cfg);
    case "dreamhost": return createDreamhost(cfg);
    case "dondominio": return createDondominio(cfg);
    case "netcup": return createNetcup(cfg);
    case "namesilo": return createNamesilo(cfg);
    case "spaceship": return createSpaceship(cfg);
    case "route53": return createRoute53(cfg);
    case "gcp": return createGcp(cfg);
    default: {
      // data-driven providers: rest specs + dyndns2 services
      const rest = REST_SPECS.find((s) => s.name === cfg.provider);
      if (rest) return new RestProvider(rest, cfg);
      const dyn = DYNDNS_SERVICES.find((s) => s.name === cfg.provider);
      if (dyn) {
        const username = cfg.username ?? (dyn.tokenOnly ? "" : (cfg.token ?? process.env[`DDNS_${dyn.name.toUpperCase()}_USERNAME`] ?? ""));
        const password = cfg.password ?? cfg.token ?? process.env[`DDNS_${dyn.name.toUpperCase()}_PASSWORD`] ?? "";
        return new DyndnsProvider(dyn, { username, password, baseUrl: cfg.baseUrl });
      }
      const pluginFactory = registry.getFactory(cfg.provider);
      if (pluginFactory) return pluginFactory(cfg);
      throw new Error(
        `unknown provider: ${cfg.provider} — install a 'ddns-provider-<name>' npm package and call discoverPlugins(), or registerProvider(name, factory)`,
      );
    }
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
  const match = found.find((r) => r.type === rec.type && normalizeName(r.name) === normalizeName(rec.name));
  if (match) {
    await p.updateRecord(zone, rec, match.id!);
    return { created: false };
  }
  await p.createRecord(zone, rec);
  return { created: true };
}
function createLinodeAlias(cfg: ProviderConfig): DnsProvider {
  const spec = REST_SPECS.find((s) => s.name === "linode");
  if (!spec) throw new Error("linode spec missing");
  return new RestProvider(spec, cfg);
}
function createHeAlias(cfg: ProviderConfig): DnsProvider {
  // he.net's public API is the dyndns2 updater ("he"); "henet" is lexicon's
  // web-session variant — alias to the dyndns2 provider for updates.
  const dyn = DYNDNS_SERVICES.find((s) => s.name === "he");
  if (!dyn) throw new Error("he spec missing");
  const username = cfg.username ?? cfg.token ?? "";
  const password = cfg.password ?? cfg.secret ?? "";
  return new DyndnsProvider(dyn, { username, password, baseUrl: cfg.baseUrl });
}
function createVercelAlias(cfg: ProviderConfig): DnsProvider {
  const spec = REST_SPECS.find((s) => s.name === "vercel");
  if (!spec) throw new Error("vercel spec missing");
  return new RestProvider(spec, cfg);
}
