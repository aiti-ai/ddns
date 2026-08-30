/** Provider parameter schemas — data-driven declarations of what each
 *  provider needs (same ParamSpec shape as service-tunnels schemas, so
 *  hosts can render forms / validate inputs from one structure).
 *
 *  `providerSchemas()` returns every provider's parameters; the CLI exposes
 *  it via `ddns providers [name]`. Spec-driven providers (REST specs,
 *  dyndns2 services) generate their schema from the spec; hand-written
 *  providers declare theirs here.
 */

import { REST_SPECS } from "./providers/rest-specs.ts";
import { DYNDNS_SERVICES } from "./providers/dyndns-services.ts";
import type { ParamSpec, ProviderMeta, RecordType } from "./types.ts";

/** Common params shared by zone-style providers. */
const ZONE_PARAMS: ParamSpec[] = [
  { key: "zone", label: "Root zone", type: "string", required: true, description: "Root domain the records live under, e.g. example.com" },
];

const RECORD_TYPE_OPTIONS = [
  { value: "A", label: "A (IPv4 address)" },
  { value: "AAAA", label: "AAAA (IPv6 address)" },
  { value: "CNAME", label: "CNAME (alias)" },
  { value: "TXT", label: "TXT (text)" },
  { value: "MX", label: "MX (mail)" },
];

/** Params every entry needs (DDNS / CRUD target). */
const ENTRY_PARAMS: ParamSpec[] = [
  { key: "name", label: "Entry name", type: "string", required: true, description: "Local label for this record (config key)" },
  { key: "record", label: "Record (FQDN)", type: "string", required: true, description: "Full name to update, e.g. home.example.com (duckdns: bare label)" },
  { key: "type", label: "Record type", type: "string", options: RECORD_TYPE_OPTIONS, default: "A", description: "Record type (DDNS entries use A or AAAA)" },
  { key: "ttl", label: "TTL (seconds)", type: "number", placeholder: "300", description: "DNS TTL; provider default when unset" },
];

/** Build a ParamSpec from a rest spec's auth declaration. */
function restAuthParams(spec: (typeof REST_SPECS)[number]): ParamSpec[] {
  const a = spec.auth;
  const descs: Record<string, string> = {
    token: "API token / key",
    secret: "API secret",
    accessKeyId: "AccessKeyId",
  };
  const params: ParamSpec[] = [{
    key: a.cfgField,
    label: a.cfgField,
    type: a.cfgField === "secret" ? "password" : "string",
    required: true,
    description: descs[a.cfgField] ?? a.cfgField,
  }];
  if (a.type === "basic") params.push({ key: "password", label: "Password", type: "password", description: "Basic-auth password (token is the username)" });
  if (spec.zoneIdLookup) params.push({ key: "zoneId", label: "Zone id", type: "string", description: "Pre-resolved zone id (skips lookup)" });
  if (spec.preLookups?.length) params.push({ key: "accountId", label: "Account id", type: "string", description: "Pre-resolved account id (skips lookup)" });
  return params;
}

/** Build a ParamSpec from a dyndns2 service spec. */
function dyndnsParams(spec: (typeof DYNDNS_SERVICES)[number]): ParamSpec[] {
  if (spec.tokenOnly) {
    return [{ key: "token", label: "Token", type: "password", required: true, description: "Service token" }];
  }
  return [
    { key: "username", label: "Username", type: "string", required: true, description: "Dyndns2 account username" },
    { key: "password", label: "Password", type: "password", required: true, description: "Dyndns2 account password" },
  ];
}

/** Hand-written provider schemas (auth params per provider). */
const HAND_PARAMS: Record<string, ParamSpec[]> = {
  cloudflare: [
    { key: "token", label: "API token", type: "password", required: true, description: "Cloudflare API token (Zone:DNS edit permission)", link: "https://dash.cloudflare.com/profile/api-tokens" },
    { key: "zoneId", label: "Zone id", type: "string", description: "Zone id (skips the zone-name lookup)" },
    { key: "proxied", label: "Orange-cloud", type: "boolean", default: false, description: "Proxy through Cloudflare (hide origin IP)" },
  ],
  dnspod: [
    { key: "token", label: "login_token", type: "password", required: true, description: "DNSPod login_token '<id>,<token>' (https://console.dnspod.cn/account/token)" },
  ],
  aliyun: [
    { key: "accessKeyId", label: "AccessKeyId", type: "string", required: true, description: "Aliyun AccessKeyId (RAM with AlidnsFullAccess)", link: "https://ram.console.aliyun.com/manage/ak" },
    { key: "secret", label: "AccessKeySecret", type: "password", required: true, description: "Aliyun AccessKeySecret" },
  ],
  duckdns: [
    { key: "token", label: "Token", type: "password", required: true, description: "DuckDNS token (https://www.duckdns.org)" },
  ],
  custom: [
    { key: "url", label: "Update URL", type: "string", required: true, description: "Webhook URL; the IP is appended as a query param" },
    { key: "ipv4key", label: "IPv4 key", type: "string", default: "ipv4", description: "Query key for the IPv4 value ('' = don't send)" },
    { key: "ipv6key", label: "IPv6 key", type: "string", default: "ipv6", description: "Query key for the IPv6 value ('' = don't send)" },
    { key: "successRegex", label: "Success regex", type: "string", default: "good", description: "Regex matched against the response body" },
  ],
  freedns: [
    { key: "token", label: "Record token", type: "password", required: true, description: "afraid.org record update token (from the update URL)" },
  ],
  dreamhost: [
    { key: "token", label: "API key", type: "password", required: true, description: "Dreamhost API key (Panel → API → Generate Key)" },
  ],
  dondominio: [
    { key: "username", label: "Username", type: "string", required: true, description: "dondns.dondominio.com account" },
    { key: "password", label: "Password", type: "password", required: true, description: "Account password" },
  ],
  netcup: [
    { key: "username", label: "Customer number", type: "string", required: true, description: "Netcup customer number" },
    { key: "token", label: "API key", type: "password", required: true, description: "Netcup API key" },
    { key: "secret", label: "API password", type: "password", required: true, description: "Netcup API password" },
  ],
  namesilo: [
    { key: "token", label: "API key", type: "password", required: true, description: "NameSilo API key (https://www.namesilo.com/account/api-manager)" },
  ],
  spaceship: [
    { key: "token", label: "API key", type: "password", required: true, description: "Spaceship API key" },
    { key: "secret", label: "API secret", type: "password", required: true, description: "Spaceship API secret" },
  ],
  route53: [
    { key: "accessKeyId", label: "AccessKeyId", type: "string", required: true, description: "AWS access key (Route53 change-resource-record-sets permission)" },
    { key: "secret", label: "SecretAccessKey", type: "password", required: true, description: "AWS secret access key" },
    { key: "zoneId", label: "Hosted zone id", type: "string", required: true, description: "Route53 hosted zone id (e.g. Z1234567890)" },
  ],
  namecheap: [
    { key: "token", label: "Dynamic DNS password", type: "password", required: true, description: "32-hex Dynamic DNS password (Advanced DNS → Dynamic DNS)" },
  ],
  dnsmadeeasy: [
    { key: "token", label: "API key", type: "password", required: true, description: "DNS Made Easy API key" },
    { key: "secret", label: "HMAC secret", type: "password", required: true, description: "DNS Made Easy HMAC secret" },
  ],
  constellix: [
    { key: "username", label: "API key", type: "string", required: true, description: "Constellix API key" },
    { key: "token", label: "Secret key", type: "password", required: true, description: "Constellix secret key (HMAC)" },
  ],
  dnsservices: [
    { key: "username", label: "Username", type: "string", required: true, description: "dns.services account email" },
    { key: "password", label: "Password", type: "password", required: true, description: "Account password" },
  ],
  ultradns: [
    { key: "username", label: "Username", type: "string", required: true, description: "UltraDNS account username" },
    { key: "password", label: "Password", type: "password", required: true, description: "UltraDNS account password" },
  ],
  gcp: [
    { key: "token", label: "OAuth token", type: "password", required: true, description: "Access token (gcloud auth print-access-token), or service-account token" },
    { key: "username", label: "Project id", type: "string", required: true, description: "GCP project id" },
    { key: "password", label: "Managed zone", type: "string", required: true, description: "Cloud DNS managed zone name" },
  ],
};

/** Full parameter schema for one provider. */
export function providerSchema(name: string): ParamSpec[] {
  const rest = REST_SPECS.find((s) => s.name === name);
  if (rest) return [...ENTRY_PARAMS, ...(rest.needsZone ? ZONE_PARAMS : []), ...restAuthParams(rest)];
  const dyn = DYNDNS_SERVICES.find((s) => s.name === name);
  if (dyn) return [...ENTRY_PARAMS, ...dyndnsParams(dyn)];
  const hand = HAND_PARAMS[name];
  if (hand) return [...ENTRY_PARAMS, ...(name === "duckdns" ? [] : name === "dondominio" || name === "custom" || name === "freedns" ? [] : ZONE_PARAMS), ...hand];
  // plugin providers: no declared schema — callers see plugin meta only
  return [...ENTRY_PARAMS];
}

/** All provider metas (name/style/recordTypes/needsZone/params). */
export function providerMetas(): ProviderMeta[] {
  const names = new Set<string>([
    ...Object.keys(HAND_PARAMS),
    ...REST_SPECS.map((s) => s.name),
    ...DYNDNS_SERVICES.map((s) => s.name),
  ]);
  return [...names].sort().map((name) => {
    const rest = REST_SPECS.find((s) => s.name === name);
    const dyn = DYNDNS_SERVICES.find((s) => s.name === name);
    const handStyle = HAND_PARAMS[name] ? (name === "duckdns" || name === "custom" || name === "freedns" || name === "dondominio" ? "push" : "zone") : "zone";
    const recordTypes: readonly RecordType[] = rest?.recordTypes ?? (dyn ? ["A", "AAAA"] : ["A", "AAAA", "CNAME", "TXT", "MX", "NS"]);
    return {
      name,
      style: (rest?.style ?? (dyn ? "push" : handStyle)) as "zone" | "push",
      recordTypes,
      needsZone: rest?.needsZone ?? (dyn ? false : true),
      authFields: [],
      params: providerSchema(name),
    };
  });
}

/** One provider's meta (for CLI single queries). */
export function providerMeta(name: string): ProviderMeta | undefined {
  return providerMetas().find((m) => m.name === name);
}
