/** More lexicon-only providers — signed/session APIs:
 *   - aurora    : HMAC-SHA256 signature header (AuroraDNSv1)
 *   - cloudxns  : API-KEY + API-REQUEST-DATE + API-HASH (sha1 chain)
 *   - yandex    : PDD legacy API (PddToken header)
 *   - gratisdns: basic-auth JSON API
 */

import { createHmac, createHash } from "node:crypto";
import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/* -------------------------------- aurora -------------------------------- */

/** aurora (AuroraDNS): Authorization: AuroraDNSv1 <b64(apiKey:b64(hmac-sha256(secret, method+path+timestamp)))>
 *  + X-AuroraDNS-Date: <iso8601 timestamp> */
export class AuroraProvider implements ZoneProvider {
  readonly meta = { name: "aurora", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (api key)", "secret (secret key)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; secret: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey || !opts.secret) throw new ProviderError("aurora requires apiKey + secret", "aurora");
    this.#apiKey = opts.apiKey;
    this.#secret = opts.secret;
    this.#base = opts.baseUrl ?? "https://api.auroradns.eu";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #authHeader(method: string, path: string, timestamp: string): string {
    const sig = method + path + timestamp;
    const signature = createHmac("sha256", this.#secret).update(sig).digest("base64");
    const auth = Buffer.from(`${this.#apiKey}:${signature}`).toString("base64");
    return `AuroraDNSv1 ${auth}`;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const timestamp = new Date().toISOString();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: this.#authHeader(method, path, timestamp), "x-auroradns-date": timestamp, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!res.ok && res.status !== 409) throw new ProviderError(`aurora API error HTTP ${res.status}`, "aurora", res.status);
    return { status: res.status, json };
  }

  async #zoneId(zone: string): Promise<string> {
    const { json } = await this.#req("GET", "/zones");
    const zones = json as Array<{ id: string; name: string }> | null;
    const z = (Array.isArray(zones) ? zones : []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`aurora: zone '${zone}' not found`, "aurora");
    return z.id;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const zid = await this.#zoneId(zone);
    const { json } = await this.#req("GET", `/zones/${zid}/records`);
    let out = ((json as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.content ?? r.rdata ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const zid = await this.#zoneId(zone);
    const { json } = await this.#req("POST", `/zones/${zid}/records`, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
    return { id: String((json as { id?: string } | null)?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    await this.#req("PUT", `/zones/${zid}/records/${id}`, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    await this.#req("DELETE", `/zones/${zid}/records/${id}`);
  }
}

/* ------------------------------- cloudxns ------------------------------- */

/** cloudxns: API-KEY + API-REQUEST-DATE + API-HASH
 *  hash = sha1(apiKey + endpoint + url + query + body + date + secret) */
export class CloudxnsProvider implements ZoneProvider {
  readonly meta = { name: "cloudxns", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (secret)", "username (api key)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; secret: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey || !opts.secret) throw new ProviderError("cloudxns requires apiKey + secret", "cloudxns");
    this.#apiKey = opts.apiKey;
    this.#secret = opts.secret;
    this.#base = opts.baseUrl ?? "https://www.cloudxns.net/api2";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #date(): string {
    return new Date().toUTCString().replace("GMT", "UTC").replace(/,/, "");
  }

  #hash(urlPath: string, query: string, body: string, date: string): string {
    return createHash("sha1").update(`${this.#apiKey}${this.#base}${urlPath}${query}${body}${date}${this.#secret}`).digest("hex");
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const date = this.#date();
    const bodyStr = body !== undefined ? JSON.stringify(body) : "";
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { "api-key": this.#apiKey, "api-request-date": date, "api-hash": this.#hash(path, "", bodyStr, date), "content-type": "application/json" },
      body: bodyStr || undefined,
    });
    const json = (await res.json().catch(() => null)) as { code?: number; data?: unknown; msg?: string } | null;
    if (!res.ok || (json && json.code !== 1 && json.code !== 0)) throw new ProviderError(`cloudxns API error ${json?.code ?? res.status}: ${json?.msg ?? ""}`, "cloudxns", res.status);
    return { status: res.status, json };
  }

  async #domainId(zone: string): Promise<string> {
    const { json } = await this.#req("GET", "/domain");
    const list = ((json as { data?: Array<{ id: string; domain: string }> }).data ?? []) as Array<{ id: string; domain: string }>;
    const d = list.find((x) => x.domain === `${zone}.`);
    if (!d) throw new ProviderError(`cloudxns: zone '${zone}' not found`, "cloudxns");
    return d.id;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const did = await this.#domainId(zone);
    const { json } = await this.#req("GET", `/record/${did}?host_id=0&offset=0&row_num=2000`);
    const list = ((json as { data?: Array<Record<string, unknown>> }).data ?? []) as Array<Record<string, unknown>>;
    let out = list.map((r) => ({
      id: String(r.record_id),
      type: String(r.type),
      name: String(r.host ?? ""),
      value: String(r.value ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const did = await this.#domainId(zone);
    const { json } = await this.#req("POST", "/record", { domain_id: did, host: rec.name, type: rec.type, value: rec.value, ttl: rec.ttl ?? 300 });
    return { id: String((json as { data?: { id?: string } }).data?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PUT", `/record/${id}`, { host: rec.name, type: rec.type, value: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("DELETE", `/record/${id}/${did}`);
  }
}

/* -------------------------------- yandex -------------------------------- */

/** yandex PDD: GET/POST https://pddimp.yandex.ru/api2/admin/dns/<action>, PddToken header */
export class YandexProvider implements ZoneProvider {
  readonly meta = { name: "yandex", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (PDD token)"], params: [] } as const;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token) throw new ProviderError("yandex requires a PDD token", "yandex");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? "https://pddimp.yandex.ru/api2/admin/dns";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, action: string, params: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const q = new URLSearchParams(params).toString();
    const url = `${this.#base}/${action}${q ? `?${q}` : ""}`;
    const res = await this.#fetch(url, {
      method,
      headers: { pdttoken: this.#token, "content-type": "application/x-www-form-urlencoded" },
      body: method === "POST" ? q : undefined,
    });
    const json = (await res.json().catch(() => null)) as { success?: string; domain?: string; records?: unknown; record_id?: string } | null;
    if (json?.success !== "ok") throw new ProviderError(`yandex API error: ${String((json as { error?: string })?.error ?? res.status)}`, "yandex", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", "list", { domain: zone });
    let out = ((json as { records?: Array<Record<string, unknown>> }).records ?? []).map((r) => ({
      id: String(r.record_id),
      type: String(r.type),
      name: String(r.fqdn ?? ""),
      value: String(r.content ?? r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { json } = await this.#req("POST", "add", { domain: zone, subdomain: rec.name.replace(`.${zone}`, "") || "@", type: rec.type, content: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: String((json as { record_id?: string }).record_id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("POST", "edit", { domain: zone, record_id: id, subdomain: rec.name.replace(`.${zone}`, "") || "@", type: rec.type, content: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("POST", "del", { domain: zone, record_id: id });
  }
}

/* ------------------------------- gratisdns ------------------------------ */

/** gratisdns: POST https://admin.gratisdns.com (basic auth) */
export class GratisdnsProvider implements ZoneProvider {
  readonly meta = { name: "gratisdns", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("gratisdns requires username + password", "gratisdns");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://admin.gratisdns.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(path: string, body: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.#username}:${this.#password}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`gratisdns API error HTTP ${res.status}`, "gratisdns", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("/api/dns/", { action: "list", domain: zone });
    let out = ((json as { data?: Array<Record<string, unknown>> }).data ?? []).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { json } = await this.#req("/api/dns/", { action: "add", domain: zone, name: rec.name, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: String((json as { id?: string }).id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("/api/dns/", { action: "update", id, domain: zone, name: rec.name, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("/api/dns/", { action: "delete", id });
  }
}

/* ------------------------------ registry -------------------------------- */

export function createAurora(cfg: ProviderConfig): AuroraProvider {
  const apiKey = cfg.token ?? process.env.DDNS_AURORA_API_KEY ?? "";
  const secret = cfg.secret ?? process.env.DDNS_AURORA_SECRET_KEY ?? "";
  return new AuroraProvider({ apiKey, secret, baseUrl: cfg.baseUrl });
}

export function createCloudxns(cfg: ProviderConfig): CloudxnsProvider {
  const apiKey = cfg.username ?? process.env.DDNS_CLOUDXNS_API_KEY ?? "";
  const secret = cfg.token ?? process.env.DDNS_CLOUDXNS_SECRET ?? "";
  return new CloudxnsProvider({ apiKey, secret, baseUrl: cfg.baseUrl });
}

export function createYandex(cfg: ProviderConfig): YandexProvider {
  const token = cfg.token ?? process.env.DDNS_YANDEX_TOKEN ?? "";
  return new YandexProvider({ token, baseUrl: cfg.baseUrl });
}

export function createGratisdns(cfg: ProviderConfig): GratisdnsProvider {
  const username = cfg.username ?? process.env.DDNS_GRATISDNS_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_GRATISDNS_PASSWORD ?? "";
  return new GratisdnsProvider({ username, password, baseUrl: cfg.baseUrl });
}

/* -------------------------------- transip ------------------------------- */

/** transip: RSA-SHA512 (PKCS1v15) signature of {login,nonce} → POST /auth →
 *  Bearer token → /domains/:zone/dns CRUD. */
export class TransipProvider implements ZoneProvider {
  readonly meta = { name: "transip", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "secret (PEM private key)"], params: [] } as const;
  readonly #login: string;
  readonly #privateKeyPem: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  #tokenCache: string | null = null;

  constructor(opts: { login: string; privateKeyPem: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.login || !opts.privateKeyPem) throw new ProviderError("transip requires login + private key (PEM)", "transip");
    this.#login = opts.login;
    this.#privateKeyPem = opts.privateKeyPem;
    this.#base = opts.baseUrl ?? "https://api.transip.nl/v6";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #token(): Promise<string> {
    if (this.#tokenCache) return this.#tokenCache;
    const { createSign, constants } = await import("node:crypto");
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const body = JSON.stringify({ login: this.#login, nonce, global_key: false });
    const signer = createSign("RSA-SHA512");
    signer.update(body);
    const signature = signer.sign({ key: this.#privateKeyPem, padding: constants.RSA_PKCS1_PADDING }).toString("base64");
    const res = await this.#fetch(`${this.#base}/auth`, {
      method: "POST",
      headers: { signature, "content-type": "application/json" },
      body,
    });
    const json = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!json?.token) throw new ProviderError("transip auth failed", "transip", res.status);
    this.#tokenCache = json.token;
    return this.#tokenCache;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const token = await this.#token();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { domains?: unknown; dnsEntries?: unknown } | null;
    if (!res.ok) throw new ProviderError(`transip API error HTTP ${res.status}`, "transip", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", `/domains/${zone}/dns`);
    let out = ((json as { dnsEntries?: Array<Record<string, unknown>> }).dnsEntries ?? []).map((r) => ({
      id: String(r.id ?? ""),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#req("POST", `/domains/${zone}/dns`, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("POST", `/domains/${zone}/dns`, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("DELETE", `/domains/${zone}/dns`, { name: id.split("/")[0], type: id.split("/")[1] });
  }
}

/* -------------------------------- qcloud -------------------------------- */

/** qcloud (Tencent Cloud DNSPod): TC3-HMAC-SHA256 signed POST to
 *  dnspod.tencentcloudapi.com (DescribeDomainList / CreateRecord /
 *  ModifyRecord / DeleteRecord). */
export class QcloudProvider implements ZoneProvider {
  readonly meta = { name: "qcloud", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (SecretId)", "secret (SecretKey)"], params: [] } as const;
  readonly #secretId: string;
  readonly #secretKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { secretId: string; secretKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.secretId || !opts.secretKey) throw new ProviderError("qcloud requires secretId + secretKey", "qcloud");
    this.#secretId = opts.secretId;
    this.#secretKey = opts.secretKey;
    this.#base = opts.baseUrl ?? "https://dnspod.tencentcloudapi.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  /** TC3-HMAC-SHA256 signing (Tencent Cloud standard). */
  #sign(action: string, payload: Record<string, unknown>, timestamp: number): { authorization: string; token: string } {
    const { createHmac } = requireHmac();
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const body = JSON.stringify(payload);
    const hashedPayload = createHmac("sha256", "").update(body).digest("hex");
    void hashedPayload;
    // TC3: sha256 of body is computed with sha256 (not hmac)
    const { createHash } = requireHash();
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${new URL(this.#base).host}\n`;
    const signedHeaders = "content-type;host";
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${date}/dnspod/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const kDate = createHmac("sha256", `TC3${this.#secretKey}`).update(date).digest();
    const kService = createHmac("sha256", kDate).update("dnspod").digest();
    const kSigning = createHmac("sha256", kService).update("tc3_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    return {
      authorization: `TC3-HMAC-SHA256 Credential=${this.#secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      token: payloadHash,
    };
  }

  async #api(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const { authorization } = this.#sign(action, payload, timestamp);
    const res = await this.#fetch(`${this.#base}/`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json; charset=utf-8", "x-tc-action": action.toLowerCase(), "x-tc-timestamp": String(timestamp), "x-tc-version": "2021-03-23" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => null)) as { Response?: { Error?: { Code?: string; Message?: string } } } | null;
    if (!res.ok || json?.Response?.Error) {
      const err = json?.Response?.Error;
      throw new ProviderError(`qcloud API error: ${err?.Code ?? res.status}: ${err?.Message ?? ""}`, "qcloud", res.status);
    }
    return (json?.Response ?? {}) as Record<string, unknown>;
  }

  async #domainId(zone: string): Promise<string> {
    const resp = await this.#api("DescribeDomainList", { Keyword: zone });
    const list = (resp.DomainList as Array<{ DomainId?: number }> | undefined) ?? [];
    if (!list.length) throw new ProviderError(`qcloud: zone '${zone}' not found`, "qcloud");
    return String(list[0]!.DomainId);
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const did = await this.#domainId(zone);
    const resp = await this.#api("DescribeRecordList", { DomainId: Number(did), Limit: 100 });
    let out = ((resp.RecordList as Array<Record<string, unknown>> | undefined) ?? []).map((r) => ({
      id: String(r.RecordId),
      type: String(r.Type),
      name: r.Name === "@" ? zone : `${r.Name}.${zone}`,
      value: String(r.Value),
      ttl: r.TTL !== undefined ? Number(r.TTL) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const did = await this.#domainId(zone);
    const sub = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    const resp = await this.#api("CreateRecord", { DomainId: Number(did), SubDomain: sub, RecordType: rec.type, RecordLine: "默认", Value: rec.value, TTL: rec.ttl ?? 600 });
    return { id: String((resp as { RecordId?: number }).RecordId ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    const sub = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    await this.#api("ModifyRecord", { DomainId: Number(did), RecordId: Number(id), SubDomain: sub, RecordType: rec.type, RecordLine: "默认", Value: rec.value, TTL: rec.ttl ?? 600 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#api("DeleteRecord", { DomainId: Number(did), RecordId: Number(id) });
  }
}

function requireHmac(): { createHmac: typeof createHmac } {
  return { createHmac };
}
function requireHash(): { createHash: typeof createHash } {
  return { createHash };
}

export function createTransip(cfg: ProviderConfig): TransipProvider {
  const login = cfg.username ?? process.env.DDNS_TRANSIP_LOGIN ?? "";
  const key = cfg.secret ?? process.env.DDNS_TRANSIP_PRIVATE_KEY ?? "";
  return new TransipProvider({ login, privateKeyPem: key, baseUrl: cfg.baseUrl });
}

export function createQcloud(cfg: ProviderConfig): QcloudProvider {
  const secretId = cfg.token ?? process.env.DDNS_QCLOUD_SECRET_ID ?? "";
  const secretKey = cfg.secret ?? process.env.DDNS_QCLOUD_SECRET_KEY ?? "";
  return new QcloudProvider({ secretId, secretKey, baseUrl: cfg.baseUrl });
}

/* ------------------------- hostingde / httpnet --------------------------- */

/** hostingde + httpnet (sister APIs): POST JSON to /recordsFind, /recordsCreate,
 *  /recordsUpdate, /recordsDelete with authToken in the body. */
export class HostingdeProvider implements ZoneProvider {
  readonly meta = { name: "hostingde", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (authToken)"], params: [] } as const;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #displayName: string;

  constructor(opts: { token: string; baseUrl?: string; fetchImpl?: FetchLike; displayName?: string }) {
    if (!opts.token) throw new ProviderError(`${opts.displayName ?? "hostingde"} requires authToken`, opts.displayName ?? "hostingde");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? "https://secure.hosting.de/api/dns/v1/json";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
    this.#displayName = opts.displayName ?? "hostingde";
  }

  async #call(endpoint: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.#fetch(`${this.#base}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authToken: this.#token, ...data }),
    });
    const json = (await res.json().catch(() => null)) as { status?: string; data?: unknown; errors?: Array<{ code: number; text: string }> } | null;
    if (!res.ok || json?.status === "error") {
      throw new ProviderError(`${this.#displayName} API error: ${json?.errors?.[0]?.text ?? res.status}`, this.#displayName, res.status);
    }
    return (json?.data ?? {}) as Record<string, unknown>;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = await this.#call("recordsFind", { filter: { zoneName: zone } });
    let out = ((json.records ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const json = await this.#call("recordsCreate", { records: [{ zoneName: zone, name: rec.name, type: rec.type, content: rec.value, ttl: rec.ttl ?? 300 }] });
    return { id: String((json.records as Array<{ id?: string }> | undefined)?.[0]?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#call("recordsUpdate", { records: [{ id, zoneName: zone, name: rec.name, type: rec.type, content: rec.value, ttl: rec.ttl ?? 300 }] });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call("recordsDelete", { records: [{ id }] });
  }
}

/* --------------------------------- wedos -------------------------------- */

/** wedos: POST https://api.wedos.com/wapi/json with
 *  {request: {user, auth: sha1(login+sha1(pass)+hour), command, data}}. */
export class WedosProvider implements ZoneProvider {
  readonly meta = { name: "wedos", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("wedos requires username + password", "wedos");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://api.wedos.com/wapi/json";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #authHash(): string {
    const passHash = createHash("sha1").update(this.#password).digest("hex");
    const hour = new Date().toISOString().slice(11, 13);
    const phrase = this.#username + passHash + hour;
    return createHash("sha1").update(phrase).digest("hex");
  }

  async #call(command: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.#fetch(this.#base, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: JSON.stringify({ user: this.#username, auth: this.#authHash(), command, data }) }).toString(),
    });
    const json = (await res.json().catch(() => null)) as { response?: { code?: number; data?: Record<string, unknown> } } | null;
    if (!res.ok || json?.response?.code !== 1000) {
      throw new ProviderError(`wedos API error: code ${json?.response?.code ?? res.status}`, "wedos", res.status);
    }
    return (json.response?.data ?? {}) as Record<string, unknown>;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = await this.#call("dns-rows-list", { domain: zone });
    let out = ((json.row ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.ID ?? r.id ?? ""),
      type: String(r.rdtype ?? r.type ?? ""),
      name: String(r.name ?? ""),
      value: String(r.rdata ?? r.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const json = await this.#call("dns-row-add", { domain: zone, name: rec.name, rdtype: rec.type, rdata: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: String((json as { id?: string }).id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#call("dns-row-update", { domain: zone, row_id: id, name: rec.name, rdtype: rec.type, rdata: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call("dns-row-delete", { domain: zone, row_id: id });
  }
}

/* --------------------------------- nfsn -------------------------------- */

/** nfsn (NearlyFreeSpeech.NET): X-NFSN-Authentication: login:key, POST JSON. */
export class NfsnProvider implements ZoneProvider {
  readonly meta = { name: "nfsn", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "token (api key)"], params: [] } as const;
  readonly #login: string;
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { login: string; key: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.login || !opts.key) throw new ProviderError("nfsn requires login + api key", "nfsn");
    this.#login = opts.login;
    this.#key = opts.key;
    this.#base = opts.baseUrl ?? "https://api.nearlyfreespeech.net";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { "x-nfsn-authentication": `${this.#login}:${this.#key}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Array<Record<string, unknown>> | Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`nfsn API error HTTP ${res.status}`, "nfsn", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#call("GET", `/dns/${zone}/list`);
    let out = ((json as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      id: String(r.id ?? ""),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.data ?? ""),
      ttl: undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { json } = await this.#call("POST", `/dns/${zone}/add`, { type: rec.type, name: rec.name, data: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: String((json as { id?: string } | null)?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#call("POST", `/dns/${zone}/replace`, { id, type: rec.type, name: rec.name, data: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call("POST", `/dns/${zone}/remove`, { id });
  }
}

export function createHostingde(cfg: ProviderConfig): HostingdeProvider {
  const token = cfg.token ?? process.env.DDNS_HOSTINGDE_TOKEN ?? "";
  return new HostingdeProvider({ token, baseUrl: cfg.baseUrl, displayName: "hostingde" });
}
export function createHttpnet(cfg: ProviderConfig): HostingdeProvider {
  const token = cfg.token ?? process.env.DDNS_HTTPNET_TOKEN ?? "";
  return new HostingdeProvider({ token, baseUrl: cfg.baseUrl ?? "https://partner.http.net/api/dns/v1/json", displayName: "httpnet" });
}
export function createWedos(cfg: ProviderConfig): WedosProvider {
  const username = cfg.username ?? process.env.DDNS_WEDOS_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_WEDOS_PASSWORD ?? "";
  return new WedosProvider({ username, password, baseUrl: cfg.baseUrl });
}
export function createNfsn(cfg: ProviderConfig): NfsnProvider {
  const login = cfg.username ?? process.env.DDNS_NFSN_LOGIN ?? "";
  const key = cfg.token ?? process.env.DDNS_NFSN_KEY ?? "";
  return new NfsnProvider({ login, key, baseUrl: cfg.baseUrl });
}

/* ------------------------------ yandexcloud ------------------------------ */

/** yandexcloud: IAM token → /zones (folderId) → :listRecordSets /
 *  :upsertRecordSets (JSON). */
export class YandexcloudProvider implements ZoneProvider {
  readonly meta = { name: "yandexcloud", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (IAM token)", "username (folder id)"], params: [] } as const;
  readonly #token: string;
  readonly #folderId: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; folderId: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token || !opts.folderId) throw new ProviderError("yandexcloud requires IAM token + folderId", "yandexcloud");
    this.#token = opts.token;
    this.#folderId = opts.folderId;
    this.#base = opts.baseUrl ?? "https://dns.api.cloud.yandex.net/dns/v1";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`yandexcloud API error HTTP ${res.status}`, "yandexcloud", res.status);
    return json ?? {};
  }

  async #zoneId(zone: string): Promise<string> {
    const json = await this.#req("GET", `/zones?folderId=${encodeURIComponent(this.#folderId)}&filter=${encodeURIComponent(`zone='${zone}.'`)}`);
    const zones = (json.zones ?? []) as Array<{ id: string }>;
    if (!zones.length) throw new ProviderError(`yandexcloud: zone '${zone}' not found`, "yandexcloud");
    return zones[0]!.id;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const zid = await this.#zoneId(zone);
    const json = await this.#req("GET", `/zones/${zid}:listRecordSets`);
    let out = ((json.recordSets ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ""),
      type: String(r.type),
      name: String(r.fqdn ?? "").replace(/\.$/, ""),
      value: String((r.data as string[] | undefined)?.[0] ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const zid = await this.#zoneId(zone);
    await this.#req("POST", `/zones/${zid}:upsertRecordSets`, { upsertions: [{ name: `${rec.name}.`, type: rec.type, ttl: `${rec.ttl ?? 300}`, data: [rec.value] }] });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    await this.#req("POST", `/zones/${zid}:upsertRecordSets`, { upsertions: [{ name: `${rec.name}.`, type: rec.type, ttl: `${rec.ttl ?? 300}`, data: [rec.value] }] });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("POST", `/zones/${zid}:upsertRecordSets`, { deletions: [{ name: `${name}.`, type, data: [] }] });
  }
}

/* ------------------------------ valuedomain ------------------------------ */

/** valuedomain: Bearer token REST (/domains/:name/dns). */
export class ValuedomainProvider implements ZoneProvider {
  readonly meta = { name: "valuedomain", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (auth token)"], params: [] } as const;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token) throw new ProviderError("valuedomain requires an auth token", "valuedomain");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? "https://api.value-domain.com/v1";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`valuedomain API error HTTP ${res.status}`, "valuedomain", res.status);
    return json ?? {};
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = await this.#req("GET", `/domains/${zone}/dns`);
    let out = ((json.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ""),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.value ?? r.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const json = await this.#req("POST", `/domains/${zone}/dns`, { name: rec.name, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: String((json as { id?: string }).id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PUT", `/domains/${zone}/dns/${id}`, { name: rec.name, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("DELETE", `/domains/${zone}/dns/${id}`);
  }
}

/* ------------------------------- rackspace ------------------------------- */

/** rackspace: POST /tokens (RAX-KSKEY) → X-Auth-Token → /domains/:id/records. */
export class RackspaceProvider implements ZoneProvider {
  readonly meta = { name: "rackspace", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "token (api key)"], params: [] } as const;
  readonly #username: string;
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  #tokenCache: string | null = null;
  #tenantCache: string | null = null;

  constructor(opts: { username: string; apiKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.apiKey) throw new ProviderError("rackspace requires username + apiKey", "rackspace");
    this.#username = opts.username;
    this.#apiKey = opts.apiKey;
    this.#base = opts.baseUrl ?? "https://dns.api.rackspacecloud.com/v1.0";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #auth(): Promise<{ token: string; tenant: string }> {
    if (this.#tokenCache && this.#tenantCache) return { token: this.#tokenCache, tenant: this.#tenantCache };
    const res = await this.#fetch(`${this.#base}/../tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: { "RAX-KSKEY:apiKeyCredentials": { username: this.#username, apiKey: this.#apiKey } } }),
    });
    const json = (await res.json().catch(() => null)) as { access?: { token?: { id?: string }; user?: { tenantId?: string } } } | null;
    const token = json?.access?.token?.id;
    const tenant = json?.access?.user?.tenantId;
    if (!token || !tenant) throw new ProviderError("rackspace auth failed", "rackspace", res.status);
    this.#tokenCache = token;
    this.#tenantCache = tenant;
    return { token, tenant };
  }

  async #req(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const { token, tenant } = await this.#auth();
    const res = await this.#fetch(`${this.#base}/${tenant}${path}`, {
      method,
      headers: { "x-auth-token": token, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`rackspace API error HTTP ${res.status}`, "rackspace", res.status);
    return json ?? {};
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = await this.#req("GET", `/domains?name=${encodeURIComponent(zone)}`);
    const domains = (json.domains ?? []) as Array<{ id: string }>;
    if (!domains.length) throw new ProviderError(`rackspace: zone '${zone}' not found`, "rackspace");
    const recordsJson = await this.#req("GET", `/domains/${domains[0]!.id}/records`);
    let out = ((recordsJson.records ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const json = await this.#req("GET", `/domains?name=${encodeURIComponent(zone)}`);
    const domains = (json.domains ?? []) as Array<{ id: string }>;
    if (!domains.length) throw new ProviderError(`rackspace: zone '${zone}' not found`, "rackspace");
    const created = await this.#req("POST", `/domains/${domains[0]!.id}/records`, { records: [{ name: rec.name, type: rec.type, data: rec.value, ttl: rec.ttl ?? 300 }] });
    return { id: String((created.records as Array<{ id?: string }> | undefined)?.[0]?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const json = await this.#req("GET", `/domains?name=${encodeURIComponent(zone)}`);
    const domains = (json.domains ?? []) as Array<{ id: string }>;
    if (!domains.length) throw new ProviderError(`rackspace: zone '${zone}' not found`, "rackspace");
    await this.#req("PUT", `/domains/${domains[0]!.id}/records/${id}`, { name: rec.name, type: rec.type, data: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const json = await this.#req("GET", `/domains?name=${encodeURIComponent(zone)}`);
    const domains = (json.domains ?? []) as Array<{ id: string }>;
    if (!domains.length) throw new ProviderError(`rackspace: zone '${zone}' not found`, "rackspace");
    await this.#req("DELETE", `/domains/${domains[0]!.id}/records/${id}`);
  }
}

/* -------------------------------- memset -------------------------------- */

/** memset: GET JSON-RPC style /dns.zone_* with api key (X-Auth-Key). */
export class MemsetProvider implements ZoneProvider {
  readonly meta = { name: "memset", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (api key)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey) throw new ProviderError("memset requires an api key", "memset");
    this.#apiKey = opts.apiKey;
    this.#base = opts.baseUrl ?? "https://api.memset.com/v1/json";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const res = await this.#fetch(`${this.#base}/${method}?${q.toString()}`, { headers: { "x-auth-key": this.#apiKey } });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`memset API error HTTP ${res.status}`, "memset", res.status);
    return json ?? {};
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const info = await this.#call("dns.zone_domain_info", { domain: zone });
    const zid = info.zone_id ?? info.id ?? "";
    const json = await this.#call("dns.zone_info", { id: String(zid) });
    let out = ((json.records ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ""),
      type: String(r.type ?? ""),
      name: String(r.name ?? ""),
      value: String(r.content ?? r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const json = await this.#call("dns.zone_record_create", { domain: zone, name: rec.name, type: rec.type, content: rec.value, ttl: rec.ttl ?? 300 });
    return { id: String((json as { id?: string }).id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#call("dns.zone_record_update", { id, name: rec.name, type: rec.type, content: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call("dns.zone_record_delete", { id });
  }
}

export function createYandexcloud(cfg: ProviderConfig): YandexcloudProvider {
  const token = cfg.token ?? process.env.DDNS_YANDEXCLOUD_TOKEN ?? "";
  const folderId = cfg.username ?? process.env.DDNS_YANDEXCLOUD_FOLDER_ID ?? "";
  return new YandexcloudProvider({ token, folderId, baseUrl: cfg.baseUrl });
}
export function createValuedomain(cfg: ProviderConfig): ValuedomainProvider {
  const token = cfg.token ?? process.env.DDNS_VALUEDOMAIN_TOKEN ?? "";
  return new ValuedomainProvider({ token, baseUrl: cfg.baseUrl });
}
export function createRackspace(cfg: ProviderConfig): RackspaceProvider {
  const username = cfg.username ?? process.env.DDNS_RACKSPACE_USERNAME ?? "";
  const apiKey = cfg.token ?? process.env.DDNS_RACKSPACE_API_KEY ?? "";
  return new RackspaceProvider({ username, apiKey, baseUrl: cfg.baseUrl });
}
export function createMemset(cfg: ProviderConfig): MemsetProvider {
  const apiKey = cfg.token ?? process.env.DDNS_MEMSET_API_KEY ?? "";
  return new MemsetProvider({ apiKey, baseUrl: cfg.baseUrl });
}

/* -------------------------------- gehirn -------------------------------- */

/** gehirn: HTTP Basic (token/secret) + zones → versions → records. */
export class GehirnProvider implements ZoneProvider {
  readonly meta = { name: "gehirn", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (access token)", "secret"], params: [] } as const;
  readonly #token: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; secret: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token || !opts.secret) throw new ProviderError("gehirn requires token + secret", "gehirn");
    this.#token = opts.token;
    this.#secret = opts.secret;
    this.#base = opts.baseUrl ?? "https://api.gis.gehirn.jp/dns/v1";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${this.#token}:${this.#secret}`).toString("base64")}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { zones?: Array<Record<string, unknown>>; records?: Array<Record<string, unknown>> } | null;
    if (!res.ok) throw new ProviderError(`gehirn API error HTTP ${res.status}`, "gehirn", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", "/zones");
    const zones = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []) as Array<{ id: string; name: string }>;
    const z = zones.find((x) => x.name === zone);
    if (!z) throw new ProviderError(`gehirn: zone '${zone}' not found`, "gehirn");
    const { json: vjson } = await this.#req("GET", `/zones/${z.id}/versions`);
    const versions = (vjson as { versions?: Array<{ id: string }> }).versions ?? [];
    const vid = versions[0]?.id ?? "";
    const { json: rjson } = await this.#req("GET", `/zones/${z.id}/versions/${vid}/records`);
    let out = ((rjson as { records?: Array<Record<string, unknown>> }).records ?? []).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String(r.content ?? r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { json } = await this.#req("GET", "/zones");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`gehirn: zone '${zone}' not found`, "gehirn");
    const { json: vjson } = await this.#req("GET", `/zones/${z.id}/versions`);
    const vid = (vjson as { versions?: Array<{ id: string }> }).versions?.[0]?.id ?? "";
    const { json: cjson } = await this.#req("POST", `/zones/${z.id}/versions/${vid}/records`, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
    return { id: String((cjson as { id?: string } | null)?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const { json } = await this.#req("GET", "/zones");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`gehirn: zone '${zone}' not found`, "gehirn");
    const { json: vjson } = await this.#req("GET", `/zones/${z.id}/versions`);
    const vid = (vjson as { versions?: Array<{ id: string }> }).versions?.[0]?.id ?? "";
    await this.#req("PUT", `/zones/${z.id}/versions/${vid}/records/${id}`, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const { json } = await this.#req("GET", "/zones");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`gehirn: zone '${zone}' not found`, "gehirn");
    const { json: vjson } = await this.#req("GET", `/zones/${z.id}/versions`);
    const vid = (vjson as { versions?: Array<{ id: string }> }).versions?.[0]?.id ?? "";
    await this.#req("DELETE", `/zones/${z.id}/versions/${vid}/records/${id}`);
  }
}

/* ------------------------------- rcodezero ------------------------------- */

/** rcodezero: Bearer + rrset structure (records[] with disabled flag). */
export class RcodezeroProvider implements ZoneProvider {
  readonly meta = { name: "rcodezero", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token"], params: [] } as const;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token) throw new ProviderError("rcodezero requires a token", "rcodezero");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? "https://my.rcodezero.at/api/v1";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { zones?: Array<{ id: string; name: string }>; rrsets?: Array<Record<string, unknown>> } | null;
    if (!res.ok) throw new ProviderError(`rcodezero API error HTTP ${res.status}`, "rcodezero", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", "/zones/");
    const zones = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []) as Array<{ id: string; name: string }>;
    const z = zones.find((x) => x.name === zone);
    if (!z) throw new ProviderError(`rcodezero: zone '${zone}' not found`, "rcodezero");
    const { json: rjson } = await this.#req("GET", `/zones/${z.id}/rrsets?page_size=-1`);
    let out = ((rjson as { rrsets?: Array<Record<string, unknown>> }).rrsets ?? []).map((r) => ({
      id: String(r.name ?? "") + "/" + String(r.type ?? ""),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String((r.records as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { json } = await this.#req("GET", "/zones/");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`rcodezero: zone '${zone}' not found`, "rcodezero");
    await this.#req("PATCH", `/zones/${z.id}/rrsets`, { name: rec.name, type: rec.type, records: [{ content: rec.value, disabled: false }], ttl: rec.ttl ?? 300 });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const { json } = await this.#req("GET", "/zones/");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`rcodezero: zone '${zone}' not found`, "rcodezero");
    await this.#req("PATCH", `/zones/${z.id}/rrsets`, { name: rec.name, type: rec.type, records: [{ content: rec.value, disabled: false }], ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const { json } = await this.#req("GET", "/zones/");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`rcodezero: zone '${zone}' not found`, "rcodezero");
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("PATCH", `/zones/${z.id}/rrsets`, { name, type, records: [] });
  }
}

/* ------------------------------- devnomads ------------------------------- */

/** devnomads: Bearer + rrset REPLACE semantics. */
export class DevnomadsProvider implements ZoneProvider {
  readonly meta = { name: "devnomads", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token"], params: [] } as const;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token) throw new ProviderError("devnomads requires a token", "devnomads");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? "https://api.devnomads.nl/services/dns";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { zones?: Array<{ id: string; name: string }>; rrsets?: Array<Record<string, unknown>> } | null;
    if (!res.ok) throw new ProviderError(`devnomads API error HTTP ${res.status}`, "devnomads", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", "/zones/");
    const zones = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []) as Array<{ id: string; name: string }>;
    const z = zones.find((x) => x.name === zone);
    if (!z) throw new ProviderError(`devnomads: zone '${zone}' not found`, "devnomads");
    const { json: rjson } = await this.#req("GET", `/zones/${z.id}/rrsets`);
    let out = ((rjson as { rrsets?: Array<Record<string, unknown>> }).rrsets ?? []).map((r) => ({
      id: String(r.name ?? "") + "/" + String(r.type ?? ""),
      type: String(r.type),
      name: String(r.name ?? ""),
      value: String((r.records as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { json } = await this.#req("GET", "/zones/");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`devnomads: zone '${zone}' not found`, "devnomads");
    await this.#req("PUT", `/zones/${z.id}/rrsets/${rec.name}/${rec.type}`, { name: rec.name, type: rec.type, records: [{ content: rec.value, disabled: false }], ttl: rec.ttl ?? 600, changetype: "REPLACE" });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const { json } = await this.#req("GET", "/zones/");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`devnomads: zone '${zone}' not found`, "devnomads");
    await this.#req("PUT", `/zones/${z.id}/rrsets/${rec.name}/${rec.type}`, { name: rec.name, type: rec.type, records: [{ content: rec.value, disabled: false }], ttl: rec.ttl ?? 600, changetype: "REPLACE" });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const { json } = await this.#req("GET", "/zones/");
    const z = ((json as { zones?: Array<{ id: string; name: string }> }).zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`devnomads: zone '${zone}' not found`, "devnomads");
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("DELETE", `/zones/${z.id}/rrsets/${name}/${type}`);
  }
}

export function createGehirn(cfg: ProviderConfig): GehirnProvider {
  const token = cfg.token ?? process.env.DDNS_GEHIRN_TOKEN ?? "";
  const secret = cfg.secret ?? process.env.DDNS_GEHIRN_SECRET ?? "";
  return new GehirnProvider({ token, secret, baseUrl: cfg.baseUrl });
}
export function createRcodezero(cfg: ProviderConfig): RcodezeroProvider {
  const token = cfg.token ?? process.env.DDNS_RCODEZERO_TOKEN ?? "";
  return new RcodezeroProvider({ token, baseUrl: cfg.baseUrl });
}
export function createDevnomads(cfg: ProviderConfig): DevnomadsProvider {
  const token = cfg.token ?? process.env.DDNS_DEVNOMADS_TOKEN ?? "";
  return new DevnomadsProvider({ token, baseUrl: cfg.baseUrl });
}

/* -------------------------------- misaka -------------------------------- */

/** misaka: Authorization: Token <token>, /zones/:id/recordsets rr-set CRUD. */
export class MisakaProvider implements ZoneProvider {
  readonly meta = { name: "misaka", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token"], params: [] } as const;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { token: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.token) throw new ProviderError("misaka requires a token", "misaka");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? "https://api.misaka.io/dns";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Token ${this.#token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { id?: string; recordsets?: Array<Record<string, unknown>> } | null;
    if (!res.ok) throw new ProviderError(`misaka API error HTTP ${res.status}`, "misaka", res.status);
    return { status: res.status, json };
  }

  async #zoneId(zone: string): Promise<string> {
    const { json } = await this.#req("GET", `/zones/${zone}/settings`);
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new ProviderError(`misaka: zone '${zone}' not found`, "misaka");
    return id;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const zid = await this.#zoneId(zone);
    const { json } = await this.#req("GET", `/zones/${zid}/recordsets`);
    let out = ((json as { recordsets?: Array<Record<string, unknown>> }).recordsets ?? []).map((r) => ({
      id: String(r.name ?? "") + "/" + String(r.type ?? ""),
      type: String(r.type ?? ""),
      name: String(r.name ?? ""),
      value: String((r.records as Array<{ content?: string }> | undefined)?.[0]?.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const zid = await this.#zoneId(zone);
    await this.#req("PUT", `/zones/${zid}/recordsets/${rec.name}/${rec.type}`, { records: [{ content: rec.value, disabled: false }], ttl: rec.ttl ?? 300 });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    await this.#req("PUT", `/zones/${zid}/recordsets/${rec.name}/${rec.type}`, { records: [{ content: rec.value, disabled: false }], ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("DELETE", `/zones/${zid}/recordsets/${name}/${type}`);
  }
}

/* ------------------------------- dinahosting ----------------------------- */

/** dinahosting: POST https://dinahosting.com/special/api.php (form auth). */
export class DinahostingProvider implements ZoneProvider {
  readonly meta = { name: "dinahosting", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("dinahosting requires username + password", "dinahosting");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://dinahosting.com/special/api.php";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #call(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.#fetch(this.#base, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user: this.#username, passwd: this.#password, ...params }).toString(),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (!res.ok || (json && json.error)) throw new ProviderError(`dinahosting API error: ${String(json?.error ?? res.status)}`, "dinahosting", res.status);
    return json ?? {};
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = await this.#call({ cmd: "dns_zone_info", domain: zone });
    let out = ((json.records ?? json.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ""),
      type: String(r.type ?? ""),
      name: String(r.name ?? ""),
      value: String(r.content ?? r.value ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#call({ cmd: "dns_zone_add_record", domain: zone, name: rec.name, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#call({ cmd: "dns_zone_modify_record", domain: zone, id, name: rec.name, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call({ cmd: "dns_zone_delete_record", domain: zone, id });
  }
}

export function createMisaka(cfg: ProviderConfig): MisakaProvider {
  const token = cfg.token ?? process.env.DDNS_MISAKA_TOKEN ?? "";
  return new MisakaProvider({ token, baseUrl: cfg.baseUrl });
}
export function createDinahosting(cfg: ProviderConfig): DinahostingProvider {
  const username = cfg.username ?? process.env.DDNS_DINAHOSTING_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_DINAHOSTING_PASSWORD ?? "";
  return new DinahostingProvider({ username, password, baseUrl: cfg.baseUrl });
}

/* --------------------------------- joker -------------------------------- */

/** joker.com dmapi: POST /login (api-key) → auth-sid → POST /dns-zone-*
 *  (form data with auth-sid). */
export class JokerProvider implements ZoneProvider {
  readonly meta = { name: "joker", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (api key)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  #sid: string | null = null;

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey) throw new ProviderError("joker requires an api key", "joker");
    this.#apiKey = opts.apiKey;
    this.#base = opts.baseUrl ?? "https://dmapi.joker.com/request";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #session(): Promise<string> {
    if (this.#sid) return this.#sid;
    const res = await this.#fetch(`${this.#base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "api-key": this.#apiKey }).toString(),
    });
    const text = await res.text();
    // response: headers then a line like auth-sid=xxx, blank line, then data
    const m = /auth-sid=([^\n]+)/.exec(text);
    if (!res.ok || !m) throw new ProviderError("joker login failed", "joker", res.status);
    this.#sid = m[1]!;
    return this.#sid;
  }

  async #call(endpoint: string, data: Record<string, string>): Promise<string> {
    const sid = await this.#session();
    const res = await this.#fetch(`${this.#base}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "auth-sid": sid, ...data }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`joker API error HTTP ${res.status}`, "joker", res.status);
    return text;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const text = await this.#call("dns-zone-get", { domain: zone });
    // data section after blank line; entries "label type target ttl"
    const dataSection = text.split("\n\n").pop() ?? "";
    let out = dataSection.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((line, i) => {
      const [label, type, target, ttl] = line.trim().split(/\s+/);
      return {
        id: String(i),
        type: type ?? "",
        name: label ? (label === "@" ? zone : `${label}.${zone}`) : "",
        value: target ?? "",
        ttl: ttl ? Number(ttl) : undefined,
      };
    });
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const label = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    await this.#call("dns-zone-add", { domain: zone, type: rec.type, label, target: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const label = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    await this.#call("dns-zone-edit", { domain: zone, type: rec.type, label, target: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    const label = name && name === zone ? "@" : (name ?? "").replace(`.${zone}`, "");
    await this.#call("dns-zone-delete", { domain: zone, type: type ?? "", label });
  }
}

export function createJoker(cfg: ProviderConfig): JokerProvider {
  const apiKey = cfg.token ?? process.env.DDNS_JOKER_API_KEY ?? "";
  return new JokerProvider({ apiKey, baseUrl: cfg.baseUrl });
}

/* -------------------------------- powerdns ------------------------------- */

/** powerdns: HTTP API (X-API-Key) — /api/v1/zones/:zone rrset PATCH. */
export class PowerdnsProvider implements ZoneProvider {
  readonly meta = { name: "powerdns", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (api key)", "username (server url)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey) throw new ProviderError("powerdns requires an api key", "powerdns");
    this.#apiKey = opts.apiKey;
    const base = opts.baseUrl ?? "http://127.0.0.1:8081";
    this.#base = base.endsWith("/api/v1") ? base : `${base.replace(/\/$/, "")}/api/v1`;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { "x-api-key": this.#apiKey, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`powerdns API error HTTP ${res.status}`, "powerdns", res.status);
    return { status: res.status, json };
  }

  #dot(zone: string): string {
    return zone.endsWith(".") ? zone : `${zone}.`;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", `/zones/${this.#dot(zone)}`);
    let out = ((json as { records?: Array<Record<string, unknown>> }).records ?? []).map((r) => ({
      id: String(r.name ?? "") + "/" + String(r.type ?? ""),
      type: String(r.type),
      name: String(r.name ?? "").replace(/\.$/, ""),
      value: String(r.content ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#req("PATCH", `/zones/${this.#dot(zone)}`, {
      rrsets: [{ name: this.#dot(rec.name), type: rec.type, ttl: rec.ttl ?? 300, changetype: "REPLACE", records: [{ content: rec.value, disabled: false }] }],
    });
    return { id: `${this.#dot(rec.name)}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PATCH", `/zones/${this.#dot(zone)}`, {
      rrsets: [{ name: this.#dot(rec.name), type: rec.type, ttl: rec.ttl ?? 300, changetype: "REPLACE", records: [{ content: rec.value, disabled: false }] }],
    });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("PATCH", `/zones/${this.#dot(zone)}`, {
      rrsets: [{ name, type, changetype: "DELETE", records: [] }],
    });
  }
}

export function createPowerdns(cfg: ProviderConfig): PowerdnsProvider {
  const apiKey = cfg.token ?? process.env.DDNS_POWERDNS_API_KEY ?? "";
  return new PowerdnsProvider({ apiKey, baseUrl: cfg.baseUrl });
}
