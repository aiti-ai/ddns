/** aliyun — Aliyun DNS (alidns.aliyuncs.com) RPC API with HMAC-SHA1 request
 *  signing (ddns-updater's aliyun provider logic — lexicon has no aliyun). */

import { createHmac, randomUUID } from "node:crypto";
import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../../types.ts";
import { ProviderError, baseUrl } from "../common.ts";

const OFFICIAL = "https://alidns.aliyuncs.com";

export interface AliyunOptions {
  accessKeyId: string;
  accessKeySecret: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** RFC3986 percent-encoding — Aliyun's signing spec is stricter than
 *  encodeURIComponent (also escapes ! ' ( ) *). */
export function aliyunPercent(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonical query string: sorted keys, RFC3986-encoded (signing spec). */
export function aliyunCanonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${aliyunPercent(k)}=${aliyunPercent(v)}`)
    .join("&");
}

/** StringToSign = "GET&%2F&" + percentEncode(canonicalQuery). */
export function aliyunStringToSign(params: Record<string, string>): string {
  return `GET&%2F&${aliyunPercent(aliyunCanonicalQuery(params))}`;
}

/** HMAC-SHA1 signature (base64) with the shared secret + "&". */
export function aliyunSign(accessKeySecret: string, params: Record<string, string>): string {
  return createHmac("sha1", `${accessKeySecret}&`).update(aliyunStringToSign(params)).digest("base64");
}

interface AliyunRecord {
  RecordId: string;
  RR: string;
  Type: string;
  Value: string;
  TTL?: string | number;
}

export class AliyunProvider implements ZoneProvider {
  readonly meta = {
    name: "aliyun",
    style: "zone",
    recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX", "NS"],
    needsZone: true,
    authFields: ["accessKeyId (AccessKeyId)", "secret (AccessKeySecret)"],
  } as const;

  readonly #keyId: string;
  readonly #keySecret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: AliyunOptions) {
    if (!opts.accessKeyId || !opts.accessKeySecret) {
      throw new ProviderError("aliyun requires accessKeyId + accessKeySecret", "aliyun");
    }
    this.#keyId = opts.accessKeyId;
    this.#keySecret = opts.accessKeySecret;
    this.#base = baseUrl({ provider: "aliyun", token: opts.accessKeyId, secret: opts.accessKeySecret, baseUrl: opts.baseUrl }, OFFICIAL);
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #api(action: string, extra: Record<string, string>): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      Action: action,
      AccessKeyId: this.#keyId,
      Format: "JSON",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: randomUUID(),
      SignatureVersion: "1.0",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Version: "2015-01-09",
      ...extra,
    };
    const sig = aliyunSign(this.#keySecret, params);
    const qs = `${aliyunCanonicalQuery(params)}&Signature=${aliyunPercent(sig)}`;
    const res = await this.#fetch(`${this.#base}/?${qs}`);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || body?.Code) {
      throw new ProviderError(
        `aliyun API error: ${String(body?.Message ?? body?.Code ?? res.status)}`,
        "aliyun",
        res.status,
        body?.Code ? String(body.Code) : undefined,
      );
    }
    return body ?? {};
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const body = await this.#api("DescribeDomainRecords", { DomainName: zone, PageSize: "100" });
    const records = ((body.DomainRecords as { Record?: AliyunRecord[] } | undefined)?.Record) ?? [];
    let out = (Array.isArray(records) ? records : []).map((r) => ({
      id: r.RecordId,
      type: r.Type,
      name: r.RR === "@" ? zone : `${r.RR}.${zone}`,
      value: r.Value,
      ttl: r.TTL !== undefined ? Number(r.TTL) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const [rr] = splitRR(rec.name, zone);
    const body = await this.#api("AddDomainRecord", {
      DomainName: zone,
      RR: rr,
      Type: rec.type,
      Value: rec.value,
      TTL: String(rec.ttl ?? 600),
    });
    return { id: String(body.RecordId ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const [rr] = splitRR(rec.name, zone);
    await this.#api("UpdateDomainRecord", {
      RecordId: id,
      RR: rr,
      Type: rec.type,
      Value: rec.value,
      TTL: String(rec.ttl ?? 600),
    });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#api("DeleteDomainRecord", { RecordId: id });
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

function splitRR(name: string, zone: string): [string] {
  const r = name.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  if (r === z) return ["@"];
  if (r.endsWith(`.${z}`)) return [r.slice(0, -(z.length + 1))];
  throw new ProviderError(`record '${name}' is not under zone '${zone}'`, "aliyun");
}

/** Create an aliyun provider from a flat ProviderConfig. */
export function createAliyun(cfg: ProviderConfig): AliyunProvider {
  const keyId = cfg.accessKeyId ?? process.env.DDNS_ALIYUN_ACCESS_KEY_ID;
  const secret = cfg.secret ?? process.env.DDNS_ALIYUN_ACCESS_KEY_SECRET;
  if (!keyId || !secret) {
    throw new ProviderError("aliyun requires cfg.accessKeyId + cfg.secret (or DDNS_ALIYUN_* env)", "aliyun");
  }
  return new AliyunProvider({ accessKeyId: keyId, accessKeySecret: secret, baseUrl: cfg.baseUrl });
}
