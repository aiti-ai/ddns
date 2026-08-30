/** Core types — the shared vocabulary across DDNS (Go ddns-updater style
 *  value updates) and DNS record management (Python lexicon style CRUD). */

/** DNS record types we can write. Providers declare what they support. */
export type RecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | string;

/** A DNS record as seen by the client (FQDN names; providers split
 *  zone/owner internally — lexicon's model). */
export interface DnsRecord {
  /** Provider-side record id (returned by create/list; update/delete need it). */
  id?: string;
  type: RecordType;
  /** Fully-qualified name, e.g. "home.example.com". For push-style providers
   *  (duckdns) this is the bare label. */
  name: string;
  /** Record value/content: an IP for A/AAAA, a target hostname for CNAME,
   *  arbitrary text for TXT. */
  value: string;
  /** Seconds; provider default when unset. */
  ttl?: number;
  /** MX priority (MX records). */
  priority?: number;
  /** cloudflare: orange-cloud (proxy) the record. */
  proxied?: boolean;
}

export interface ListFilter {
  type?: string;
  /** Full FQDN (or owner) to filter on. */
  name?: string;
}

/** Provider names (built-in set; custom registry entries are strings too). */
export type ProviderName = "cloudflare" | "dnspod" | "aliyun" | "duckdns" | "custom" | (string & {});

export interface ProviderMeta {
  name: ProviderName;
  /** Style: "zone" = full record CRUD against a zone API (lexicon model);
   *  "push" = value-only update endpoint (Go ddns-updater model — duckdns,
   *  custom webhook). */
  style: "zone" | "push";
  /** Record types writable by this provider. */
  recordTypes: readonly RecordType[];
  /** Whether the provider needs a root zone ("example.com") for CRUD. */
  needsZone: boolean;
  /** Human-readable auth field hints, e.g. ["token (API token)", "email"]. */
  authFields: readonly string[];
}

/** Zone-style provider: full record CRUD (lexicon's Provider interface). */
export interface ZoneProvider {
  meta: ProviderMeta;
  listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]>;
  createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }>;
  updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void>;
  deleteRecord(zone: string, id: string): Promise<void>;
}

/** Push-style provider: value-only update (Go ddns-updater's Update(ip)). */
export interface PushProvider {
  meta: ProviderMeta;
  /** Push a value for the given name. For duckdns the name is the bare
   *  label; for custom webhook it is informational (URL carries the value). */
  pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void>;
}

export type DnsProvider = ZoneProvider | PushProvider;

/** Provider credentials/config — flat map, one entry per provider instance. */
export interface ProviderConfig {
  provider: ProviderName;
  /** cloudflare: API token; dnspod: login_token "<id>,<token>";
   *  duckdns: token; aliyun: AccessKeyId. */
  token?: string;
  /** aliyun AccessKeySecret; dnspod token part (when token is "<id>"). */
  secret?: string;
  /** aliyun AccessKeyId. */
  accessKeyId?: string;
  /** cloudflare zone id — skips the zone lookup when set. */
  zoneId?: string;
  /** custom webhook: update URL (Go custom provider semantics). */
  url?: string;
  /** custom webhook: query key for the IPv4 value ("" = don't send). */
  ipv4key?: string;
  /** custom webhook: query key for the IPv6 value ("" = don't send). */
  ipv6key?: string;
  /** custom webhook: success regex against the response body. */
  successRegex?: string;
  /** dyndns2 services: username (basic auth). */
  username?: string;
  /** dyndns2 services: password (basic auth). */
  password?: string;
  /** Base URL override (tests point providers at their mocks). */
  baseUrl?: string;
}

/** Fetch-like used by every provider (injectable; default = global fetch). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
