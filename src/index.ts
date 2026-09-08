/** ddns — DDNS + DNS record management, multi-provider.
 *
 *  Merges the capabilities of:
 *   - ddns-updater (Go, qdm12/ddns-updater): record-value updates driven by
 *     public-IP detection (A/AAAA), push-style providers (duckdns, custom
 *     webhook), long-running update loop;
 *   - lexicon (Python, dns-lexicon): arbitrary record CRUD (A/AAAA/CNAME/
 *     TXT/MX…) against zone-style provider APIs (cloudflare, dnspod, aliyun).
 *
 *  Every provider ships an in-memory mock that mirrors the real provider
 *  HTTP API closely enough for third-party implementations (Go ddns-updater,
 *  Python lexicon) pointed at it to work too — including a TLS + CONNECT
 *  proxy face for statically-linked Go binaries that hardcode provider
 *  hostnames. The mocks live in the separate package @aiti-ti/ddns-mocks
 *  (repo: mocks/), NOT in this runtime package; the `ddns mock` CLI command
 *  loads them lazily (install @aiti-ti/ddns-mocks to use it).
 */

export type {
  RecordType,
  DnsRecord,
  ListFilter,
  ProviderName,
  ProviderMeta,
  ZoneProvider,
  PushProvider,
  DnsProvider,
  ProviderConfig,
  FetchLike,
} from "./types.ts";

export { resolvePublicIp, isValidIp, IPV4_SOURCES, IPV6_SOURCES } from "./ip.ts";

export { ProviderError, splitZone, formEncode, defaultFetch, normalizeName } from "./providers/common.ts";

export { createProvider, isPushProvider, isZoneProvider, listRecords, createRecord, updateRecord, deleteRecord, deleteRecordByName, upsertRecord } from "./client.ts";

export {
  aliyunCanonicalQuery,
  aliyunStringToSign,
  aliyunSign,
  aliyunPercent,
  CloudflareProvider,
  DnspodProvider,
  AliyunProvider,
  DuckdnsProvider,
  CustomProvider,
  FreednsProvider,
  DreamhostProvider,
  DondominioProvider,
  NetcupProvider,
  NamesiloProvider,
  SpaceshipProvider,
  Route53Provider,
  awsSigV4,
  GcpProvider,
} from "./providers/index.ts";

export type { DdnsEntry, DdnsResult, DdnsDeps, DdnsLoopHandle } from "./engine.ts";
export { updateEntry, runOnce, startLoop } from "./engine.ts";

export type { BeaconOptions, BeaconResult, BeaconType } from "./beacon.ts";
export { setBeacon, beaconValue, isBeaconType } from "./beacon.ts";

export type { ServeOptions, ServeStatus, ServeHandle } from "./serve.ts";

export { registry, registerProvider, registerPlugin, discoverPlugins, PLUGIN_PREFIX } from "./plugins.ts";
export type { DdnsPlugin, PluginProviderSpec, ProviderFactory, MockFactory } from "./plugins.ts";
export { startServe } from "./serve.ts";

export { configPath, readConfig, writeConfig } from "./config.ts";

export { providerSchema, providerMetas, providerMeta } from "./schemas.ts";

export type { RestSpec } from "./providers/rest.ts";
