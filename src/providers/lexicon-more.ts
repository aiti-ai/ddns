/** More lexicon-only providers — signed/session APIs:
 *   - aurora    : HMAC-SHA256 signature header (AuroraDNSv1)
 *   - cloudxns  : API-KEY + API-REQUEST-DATE + API-HASH (sha1 chain)
 *   - yandex    : PDD legacy API (PddToken header)
 *   - gratisdns: basic-auth JSON API
 */

import { createHmac, createHash } from "node:crypto";
import * as fsMod from "node:fs";
import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then(async (r) => {
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    const setCookie = r.headers.getSetCookie?.() ?? [];
    if (setCookie.length) headers["set-cookie"] = setCookie.join(", ");
    return { ok: r.ok, status: r.status, headers, text: () => r.text(), json: () => r.json() };
  });

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

/* ------------------------------ directadmin ------------------------------ */

/** directadmin: GET /CMD_API_DNS_CONTROL (basic auth, json=yes). */
export class DirectadminProvider implements ZoneProvider {
  readonly meta = { name: "directadmin", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("directadmin requires username + password", "directadmin");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://example.com:2222";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(params: Record<string, string>): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ json: "yes", ...params }).toString();
    const res = await this.#fetch(`${this.#base}/CMD_API_DNS_CONTROL?${q}`, {
      headers: { authorization: `Basic ${Buffer.from(`${this.#username}:${this.#password}`).toString("base64")}` },
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`directadmin API error HTTP ${res.status}`, "directadmin", res.status);
    return json ?? {};
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = await this.#req({ action: "list", domain: zone });
    const records = (json.records ?? []) as Array<{ name: string; type: string; value: string; ttl?: string }>;
    let out = records.map((r, i) => ({
      id: String(i),
      type: r.type,
      name: r.name,
      value: r.value,
      ttl: r.ttl ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#req({ action: "add", domain: zone, name: `${rec.name}.`, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req({ action: "modify", domain: zone, name: `${rec.name}.`, type: rec.type, value: rec.value, ttl: String(rec.ttl ?? 300) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req({ action: "delete", domain: zone, name: `${name}.`, type });
  }
}

/* -------------------------------- infoblox ------------------------------- */

/** infoblox WAPI: https://<host>/wapi/v2.x/zone_auth + record:* (basic auth). */
export class InfobloxProvider implements ZoneProvider {
  readonly meta = { name: "infoblox", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password", "url (WAPI base incl host)"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("infoblox requires username + password + host", "infoblox");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://infoblox.example.com/wapi/v2.12";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}/${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${this.#username}:${this.#password}`).toString("base64")}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ProviderError(`infoblox API error HTTP ${res.status}`, "infoblox", res.status);
    return json;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const result = (await this.#req("GET", `record:a?name~=${encodeURIComponent(`${zone}.`)}&_return_fields=name,ipv4addr,ttl`)) as Array<{ _ref: string; name: string; ipv4addr?: string; ttl?: number }>;
    let out = (Array.isArray(result) ? result : []).map((r) => ({
      id: r._ref,
      type: "A",
      name: (r.name ?? "").replace(/\.$/, ""),
      value: r.ipv4addr ?? "",
      ttl: r.ttl,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const created = (await this.#req("POST", `record:${rec.type.toLowerCase()}`, { name: `${rec.name}.`, ipv4addr: rec.value, ttl: rec.ttl ?? 300 })) as { _ref?: string };
    return { id: String(created._ref ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PUT", encodeURIComponent(id), { name: `${rec.name}.`, ipv4addr: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("DELETE", encodeURIComponent(id));
  }
}

/* --------------------------------- azure -------------------------------- */

/** azure ARM DNS: OAuth client_credentials → /subscriptions/.../dnsZones/:zone/:type/:name */
export class AzureProvider implements ZoneProvider {
  readonly meta = { name: "azure", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (client secret)", "username (client id)", "password (tenant id)", "accessKeyId (subscription id)", "zoneId (resource group)"], params: [] } as const;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #tenantId: string;
  readonly #subscriptionId: string;
  readonly #resourceGroup: string;
  readonly #base: string;
  readonly #authUrl: string;
  readonly #fetch: FetchLike;
  #tokenCache: string | null = null;

  constructor(opts: { clientId: string; clientSecret: string; tenantId: string; subscriptionId: string; resourceGroup: string; baseUrl?: string; authUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.clientId || !opts.clientSecret || !opts.tenantId || !opts.subscriptionId || !opts.resourceGroup) {
      throw new ProviderError("azure requires clientId + clientSecret + tenantId + subscriptionId + resourceGroup", "azure");
    }
    this.#clientId = opts.clientId;
    this.#clientSecret = opts.clientSecret;
    this.#tenantId = opts.tenantId;
    this.#subscriptionId = opts.subscriptionId;
    this.#resourceGroup = opts.resourceGroup;
    this.#base = opts.baseUrl ?? "https://management.azure.com";
    this.#authUrl = opts.authUrl ?? `https://login.microsoftonline.com/${opts.tenantId}/oauth2/v2.0/token`;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #token(): Promise<string> {
    if (this.#tokenCache) return this.#tokenCache;
    const res = await this.#fetch(this.#authUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.#clientId, client_secret: this.#clientSecret, scope: "https://management.azure.com/.default", grant_type: "client_credentials" }).toString(),
    });
    const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
    if (!json?.access_token) throw new ProviderError("azure token acquisition failed", "azure", res.status);
    this.#tokenCache = json.access_token;
    return this.#tokenCache;
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.#token();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ProviderError(`azure API error HTTP ${res.status}`, "azure", res.status);
    return json;
  }

  #zonePath(zone: string): string {
    return `/subscriptions/${this.#subscriptionId}/resourceGroups/${this.#resourceGroup}/providers/Microsoft.Network/dnsZones/${zone}`;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const json = (await this.#req("GET", `${this.#zonePath(zone)}/recordsets?api-version=2018-05-01`)) as { value?: Array<Record<string, unknown>> };
    let out = ((json.value ?? []) as Array<Record<string, unknown>>).map((r) => {
      const type = String(r.type ?? "").replace("Microsoft.Network/dnszones/", "");
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const txtValue = (props.TXTRecords as Array<{ value?: string[] }> | undefined)?.[0]?.value?.[0];
      const value = String((props.ARecords as Array<{ ipv4Address?: string }> | undefined)?.[0]?.ipv4Address ?? (props.CNAMERecord as { cname?: string } | undefined)?.cname ?? txtValue ?? "");
      return {
        id: String(r.id ?? ""),
        type,
        name: String(r.name ?? ""),
        value,
        ttl: props.TTL !== undefined ? Number(props.TTL) : undefined,
      };
    });
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const rel = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    const props = rec.type === "A"
      ? { TTL: rec.ttl ?? 300, ARecords: [{ ipv4Address: rec.value }] }
      : rec.type === "AAAA"
        ? { TTL: rec.ttl ?? 300, AAAARecords: [{ ipv6Address: rec.value }] }
        : rec.type === "CNAME"
          ? { TTL: rec.ttl ?? 300, CNAMERecord: { cname: `${rec.value}.` } }
          : rec.type === "TXT"
            ? { TTL: rec.ttl ?? 300, TXTRecords: [{ value: [rec.value] }] }
            : { TTL: rec.ttl ?? 300 };
    const json = (await this.#req("PUT", `${this.#zonePath(zone)}/${rec.type}/${rel}?api-version=2018-05-01`, { properties: props })) as { id?: string };
    return { id: String(json.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.createRecord(zone, rec); // ARM PUT is idempotent upsert
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const rel = id.split("/").pop() ?? "";
    const type = id.includes("/A/") ? "A" : id.includes("/AAAA/") ? "AAAA" : id.includes("/CNAME/") ? "CNAME" : id.includes("/TXT/") ? "TXT" : "A";
    await this.#req("DELETE", `${this.#zonePath(zone)}/${type}/${rel}?api-version=2018-05-01`);
  }
}

export function createDirectadmin(cfg: ProviderConfig): DirectadminProvider {
  const username = cfg.username ?? process.env.DDNS_DIRECTADMIN_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_DIRECTADMIN_PASSWORD ?? "";
  return new DirectadminProvider({ username, password, baseUrl: cfg.baseUrl });
}
export function createInfoblox(cfg: ProviderConfig): InfobloxProvider {
  const username = cfg.username ?? process.env.DDNS_INFOBLOX_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_INFOBLOX_PASSWORD ?? "";
  return new InfobloxProvider({ username, password, baseUrl: cfg.baseUrl });
}
export function createAzure(cfg: ProviderConfig): AzureProvider {
  const clientId = cfg.username ?? process.env.DDNS_AZURE_CLIENT_ID ?? "";
  const clientSecret = cfg.token ?? process.env.DDNS_AZURE_CLIENT_SECRET ?? "";
  const tenantId = cfg.password ?? process.env.DDNS_AZURE_TENANT_ID ?? "";
  const subscriptionId = cfg.accessKeyId ?? process.env.DDNS_AZURE_SUBSCRIPTION_ID ?? "";
  const resourceGroup = cfg.zoneId ?? process.env.DDNS_AZURE_RESOURCE_GROUP ?? "";
  return new AzureProvider({ clientId, clientSecret, tenantId, subscriptionId, resourceGroup, baseUrl: cfg.baseUrl });
}

/* ---------------------------------- oci ---------------------------------- */

/** OCI (Oracle Cloud DNS): RSA-SHA256 signed requests to
 *  https://dns.{region}.oraclecloud.com/20180115/zones/:zone/records/:name.
 *  Signature: keyId="<tenancy>/<user>/<fingerprint>", rsa-sha256 over
 *  (request-target), host, date, content-type, content-length, body. */
export class OciProvider implements ZoneProvider {
  readonly meta = { name: "oci", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (api key PEM)", "username (user ocid)", "secret (tenancy ocid)", "password (key fingerprint)", "accessKeyId (region)"], params: [] } as const;
  readonly #apiKeyPem: string;
  readonly #userOcid: string;
  readonly #tenancyOcid: string;
  readonly #fingerprint: string;
  readonly #region: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKeyPem: string; userOcid: string; tenancyOcid: string; fingerprint: string; region: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKeyPem || !opts.userOcid || !opts.tenancyOcid || !opts.fingerprint || !opts.region) {
      throw new ProviderError("oci requires apiKeyPem + userOcid + tenancyOcid + fingerprint + region", "oci");
    }
    this.#apiKeyPem = opts.apiKeyPem;
    this.#userOcid = opts.userOcid;
    this.#tenancyOcid = opts.tenancyOcid;
    this.#fingerprint = opts.fingerprint;
    this.#region = opts.region;
    this.#base = opts.baseUrl ?? `https://dns.${opts.region}.oraclecloud.com/20180115`;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const { createSign, constants } = await import("node:crypto");
    const url = new URL(`${this.#base}${path}`);
    const date = new Date().toUTCString();
    const bodyStr = body !== undefined ? JSON.stringify(body) : "";
    const sha256 = createHash("sha256").update(bodyStr).digest("base64");
    const requestTarget = `${method.toLowerCase()} ${url.pathname}`;
    const headers = ["(request-target)", "host", "date", "content-type", "content-length", "x-content-sha256"];
    const signingString = [
      `(request-target): ${requestTarget}`,
      `host: ${url.host}`,
      `date: ${date}`,
      `content-type: application/json`,
      `content-length: ${Buffer.byteLength(bodyStr)}`,
      `x-content-sha256: ${sha256}`,
    ].join("\n");
    const signer = createSign("RSA-SHA256");
    signer.update(signingString);
    const signature = signer.sign({ key: this.#apiKeyPem, padding: constants.RSA_PKCS1_PADDING }).toString("base64");
    const keyId = `${this.#tenancyOcid}/${this.#userOcid}/${this.#fingerprint}`;
    const authorization = `Signature keyId="${keyId}",algorithm="rsa-sha256",headers="${headers.join(" ")}",signature="${signature}"`;
    const res = await this.#fetch(url.toString(), {
      method,
      headers: { authorization, date, "content-type": "application/json", "x-content-sha256": sha256 },
      body: bodyStr || undefined,
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ProviderError(`oci API error HTTP ${res.status}`, "oci", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", `/zones/${zone}/records`);
    const items = (json as { items?: Array<Record<string, unknown>> }).items ?? [];
    let out = items.map((r) => ({
      id: String(r.fqdn ?? "") + "/" + String(r.rtype ?? ""),
      type: String(r.rtype),
      name: String(r.fqdn ?? "").replace(/\.$/, ""),
      value: String((r.rdata as string | undefined) ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#req("PATCH", `/zones/${zone}/records/${rec.name}`, { items: [{ domain: rec.name, rtype: rec.type, rdata: rec.value, ttl: rec.ttl ?? 300 }] });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PATCH", `/zones/${zone}/records/${rec.name}`, { items: [{ domain: rec.name, rtype: rec.type, rdata: rec.value, ttl: rec.ttl ?? 300 }] });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("PATCH", `/zones/${zone}/records/${name}`, { items: [{ domain: name, rtype: type, rdata: "", ttl: 0 }] });
  }
}

/* -------------------------------- softlayer ------------------------------ */

/** SoftLayer: REST API https://api.softlayer.com/rest/v3.1 (username + apiKey
 *  basic auth). DnsDomain records CRUD via SoftLayer_DnsDomain / _Record. */
export class SoftlayerProvider implements ZoneProvider {
  readonly meta = { name: "softlayer", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "token (api key)"], params: [] } as const;
  readonly #username: string;
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; apiKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.apiKey) throw new ProviderError("softlayer requires username + apiKey", "softlayer");
    this.#username = opts.username;
    this.#apiKey = opts.apiKey;
    this.#base = opts.baseUrl ?? "https://api.softlayer.com/rest/v3.1";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${this.#username}:${this.#apiKey}`).toString("base64")}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ProviderError(`softlayer API error HTTP ${res.status}`, "softlayer", res.status);
    return { status: res.status, json };
  }

  async #domainId(zone: string): Promise<string> {
    const { json } = await this.#req("GET", `/SoftLayer_DnsDomain/getByDomainName?name=${encodeURIComponent(zone)}`);
    const domains = json as Array<{ id: number }>;
    if (!Array.isArray(domains) || !domains.length) throw new ProviderError(`softlayer: zone '${zone}' not found`, "softlayer");
    return String(domains[0]!.id);
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const did = await this.#domainId(zone);
    const { json } = await this.#req("GET", `/SoftLayer_DnsDomain/${did}/getResourceRecords`);
    let out = ((json as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.data ?? r.host ?? ""),
      value: String(r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const did = await this.#domainId(zone);
    const { json } = await this.#req("POST", `/SoftLayer_DnsDomain/${did}/createResourceRecord`, { type: rec.type, data: rec.value, host: rec.name, ttl: rec.ttl ?? 300 });
    return { id: String((json as { id?: string } | null)?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("PUT", `/SoftLayer_DnsDomain/${did}/editResourceRecord/${id}`, { type: rec.type, data: rec.value, host: rec.name, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("DELETE", `/SoftLayer_DnsDomain/${did}/deleteResourceRecord/${id}`);
  }
}

export function createOci(cfg: ProviderConfig): OciProvider {
  const apiKeyPem = cfg.token ?? process.env.DDNS_OCI_API_KEY ?? "";
  const userOcid = cfg.username ?? process.env.DDNS_OCI_USER_OCID ?? "";
  const tenancyOcid = cfg.secret ?? process.env.DDNS_OCI_TENANCY_OCID ?? "";
  const fingerprint = cfg.password ?? process.env.DDNS_OCI_FINGERPRINT ?? "";
  const region = cfg.accessKeyId ?? process.env.DDNS_OCI_REGION ?? "";
  return new OciProvider({ apiKeyPem, userOcid, tenancyOcid, fingerprint, region, baseUrl: cfg.baseUrl });
}
export function createSoftlayer(cfg: ProviderConfig): SoftlayerProvider {
  const username = cfg.username ?? process.env.DDNS_SOFTLAYER_USERNAME ?? "";
  const apiKey = cfg.token ?? process.env.DDNS_SOFTLAYER_API_KEY ?? "";
  return new SoftlayerProvider({ username, apiKey, baseUrl: cfg.baseUrl });
}

/* --------------------------------- plesk --------------------------------- */

/** plesk: XML-RPC (packet XML over HTTP with basic auth). DNS via
 *  <dns><add_rec|get_rec|del_rec|set_rec>. Minimal XML build/parse. */
export class PleskProvider implements ZoneProvider {
  readonly meta = { name: "plesk", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password", "url (plesk host)"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("plesk requires username + password + host", "plesk");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://plesk.example.com/enterprise/control/agent.php";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #xmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async #call(inner: string): Promise<string> {
    const xml = `<?xml version="1.0" encoding="utf-8"?><packet>${inner}</packet>`;
    const res = await this.#fetch(this.#base, {
      method: "POST",
      headers: { "content-type": "text/xml", "http-auth-login": this.#username, "http-auth-passwd": this.#password },
      body: xml,
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`plesk API error HTTP ${res.status}`, "plesk", res.status);
    return text;
  }

  async #siteId(zone: string): Promise<string> {
    const text = await this.#call(`<site><get><filter><name>${this.#xmlEscape(zone)}</name></filter><dataset/></get></site>`);
    const m = /<id>([^<]+)<\/id>/.exec(text);
    if (!m) throw new ProviderError(`plesk: zone '${zone}' not found`, "plesk");
    return m[1]!;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const sid = await this.#siteId(zone);
    const text = await this.#call(`<dns><get_rec><site-id>${sid}</site-id></get_rec></dns>`);
    // parse <rec><id>..</id><type>..</type><host>..</host><value>..</value></rec>
    const out: DnsRecord[] = [];
    const recRe = /<rec>([\s\S]*?)<\/rec>/g;
    for (const m of text.matchAll(recRe)) {
      const block = m[1] ?? "";
      const id = /<id>([^<]*)<\/id>/.exec(block)?.[1] ?? "";
      const type = /<type>([^<]*)<\/type>/.exec(block)?.[1] ?? "";
      const host = /<host>([^<]*)<\/host>/.exec(block)?.[1] ?? "";
      const value = /<value>([^<]*)<\/value>/.exec(block)?.[1] ?? "";
      if (!id && !type) continue;
      out.push({ id, type, name: host === "@" ? zone : `${host}.${zone}`, value, ttl: undefined });
    }
    if (filter?.type) return out.filter((r) => r.type === filter.type);
    if (filter?.name) return out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const sid = await this.#siteId(zone);
    const host = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    await this.#call(`<dns><add_rec><site-id>${sid}</site-id><type>${this.#xmlEscape(rec.type)}</type><host>${this.#xmlEscape(host)}</host><value>${this.#xmlEscape(rec.value)}</value></add_rec></dns>`);
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const host = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
    await this.#call(`<dns><set_rec><id>${this.#xmlEscape(id)}</id><host>${this.#xmlEscape(host)}</host><value>${this.#xmlEscape(rec.value)}</value></set_rec></dns>`);
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call(`<dns><del_rec><id>${this.#xmlEscape(id)}</id></del_rec></dns>`);
  }
}

export function createPlesk(cfg: ProviderConfig): PleskProvider {
  const username = cfg.username ?? process.env.DDNS_PLESK_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_PLESK_PASSWORD ?? "";
  return new PleskProvider({ username, password, baseUrl: cfg.baseUrl });
}

/* --------------------------------- euserv -------------------------------- */

/** euserv: form POST (subaction=login → choose_order → kc2_domain_dns_*). */
export class EuservProvider implements ZoneProvider {
  readonly meta = { name: "euserv", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username (email)", "password"], params: [] } as const;
  readonly #email: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  #orderId: string | null = null;

  constructor(opts: { email: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.email || !opts.password) throw new ProviderError("euserv requires email + password", "euserv");
    this.#email = opts.email;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://support.euserv.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #call(params: Record<string, string>): Promise<string> {
    const q = new URLSearchParams(params).toString();
    const res = await this.#fetch(`${this.#base}/index.php?${q}`);
    if (!res.ok) throw new ProviderError(`euserv API error HTTP ${res.status}`, "euserv", res.status);
    return res.text();
  }

  async #login(): Promise<void> {
    if (this.#orderId) return;
    const html = await this.#call({ subaction: "login", email: this.#email, password: this.#password });
    // order id appears in the orders table; find "ord_no" or contract row
    const m = /ord_no=([0-9]+)/.exec(html);
    if (!m) throw new ProviderError("euserv login failed", "euserv");
    this.#orderId = m[1]!;
  }

  async #ensureOrder(): Promise<void> {
    await this.#login();
    await this.#call({ subaction: "choose_order", ord_no: this.#orderId! });
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    await this.#ensureOrder();
    const html = await this.#call({ subaction: "kc2_domain_dns_get_records" });
    // parse rows: subdomain / type / content
    const out: DnsRecord[] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let i = 0;
    for (const m of html.matchAll(rowRe)) {
      const cells = [...(m[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => (c[1] ?? "").replace(/<[^>]+>/g, "").trim());
      if (cells.length >= 3 && cells[1]) {
        out.push({ id: String(i++), type: cells[1] ?? "", name: cells[0] ?? "", value: cells[2] ?? "", ttl: undefined });
      }
    }
    if (filter?.type) return out.filter((r) => r.type === filter.type);
    if (filter?.name) return out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#ensureOrder();
    await this.#call({ subaction: "kc2_domain_dns_set", dns_action: "new", dns_type: rec.type, dns_name: rec.name, dns_content: rec.value });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#ensureOrder();
    await this.#call({ subaction: "kc2_domain_dns_set", dns_action: "mod", dns_id: id, dns_type: rec.type, dns_name: rec.name, dns_content: rec.value });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#ensureOrder();
    await this.#call({ subaction: "kc2_domain_dns_set", dns_action: "del", dns_id: id });
  }
}

/* -------------------------------- localzone ------------------------------- */

/** localzone: local BIND zone file (no network). zone = path to the file. */
export class LocalzoneProvider implements ZoneProvider {
  readonly meta = { name: "localzone", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["zone (zone file path)"], params: [] } as const;
  readonly #file: string;
  readonly #fetch: FetchLike;

  constructor(opts: { file: string; fetchImpl?: FetchLike }) {
    if (!opts.file) throw new ProviderError("localzone requires a zone file path", "localzone");
    this.#file = opts.file;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #records(): Array<{ id: string; type: string; name: string; value: string; ttl?: number }> {
    const { readFileSync } = requireFs();
    let text = "";
    try { text = readFileSync(this.#file, "utf8"); } catch { return []; }
    const out: Array<{ id: string; type: string; name: string; value: string; ttl?: number }> = [];
    text.split("\n").forEach((line, lineNo) => {
      const t = line.trim();
      if (!t || t.startsWith(";") || t.startsWith("$")) return;
      const parts = t.split(/\s+/);
      if (parts.length < 3) return;
      let name = parts[0]!;
      let ttl: number | undefined;
      let type: string;
      let value: string;
      // zone format: name [ttl] [IN] type value
      let idx = 1;
      if (/^\d+$/.test(parts[1]!)) { ttl = Number(parts[1]); idx = 2; }
      if (parts[idx]?.toUpperCase() === "IN") idx++;
      type = (parts[idx] ?? "").toUpperCase();
      value = parts.slice(idx + 1).join(" ");
      if (["A", "AAAA", "CNAME", "TXT", "MX"].includes(type)) {
        out.push({ id: String(lineNo), type, name: name.replace(/\.$/, ""), value, ttl });
      }
    });
    return out;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    let out = this.#records();
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const { appendFileSync } = requireFs();
    appendFileSync(this.#file, `\n${rec.name}. ${rec.ttl ?? 300} IN ${rec.type} ${rec.value}\n`);
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.deleteRecord(zone, id);
    await this.createRecord(zone, rec);
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const { readFileSync, writeFileSync } = requireFs();
    const idx = Number(id);
    const records = this.#records();
    const rec = records.find((r) => r.id === id) ?? records[idx];
    if (!rec) return;
    const text = readFileSync(this.#file, "utf8");
    const lineRe = new RegExp(`^[ \t]*${escapeRegex(rec.name)}\\.?[ \t]+(\\d+[ \t]+)?IN[ \t]+${rec.type}[ \t]+[^\n]*`, "m");
    writeFileSync(this.#file, text.replace(lineRe, ""));
  }
}

function requireFs(): { readFileSync: (p: string, e: string) => string; writeFileSync: (p: string, d: string) => void; appendFileSync: (p: string, d: string) => void } {
  const fs = fsMod;
  return { readFileSync: (p, e) => fs.readFileSync(p, e as BufferEncoding), writeFileSync: (p, d) => fs.writeFileSync(p, d), appendFileSync: (p, d) => fs.appendFileSync(p, d) };
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createEuserv(cfg: ProviderConfig): EuservProvider {
  const email = cfg.username ?? process.env.DDNS_EUSERV_EMAIL ?? "";
  const password = cfg.password ?? process.env.DDNS_EUSERV_PASSWORD ?? "";
  return new EuservProvider({ email, password, baseUrl: cfg.baseUrl });
}
export function createLocalzone(cfg: ProviderConfig): LocalzoneProvider {
  const file = cfg.zone ?? process.env.DDNS_LOCALZONE_FILE ?? "";
  return new LocalzoneProvider({ file });
}

/* -------------------------------- easyname ------------------------------- */

/** easyname: CSRF token + cookie session → POST DNS create/edit/delete. */
export class EasynameProvider implements ZoneProvider {
  readonly meta = { name: "easyname", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username (email)", "password"], params: [] } as const;
  readonly #email: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  #cookie = "";
  #csrf = "";

  constructor(opts: { email: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.email || !opts.password) throw new ProviderError("easyname requires email + password", "easyname");
    this.#email = opts.email;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://my.easyname.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #login(): Promise<void> {
    if (this.#csrf) return;
    // step 1: GET login page → CSRF-TOKEN cookie
    const home = await this.#fetch(`${this.#base}/en/login`);
    const setCookie = (home as unknown as { headers?: Record<string, string> }).headers?.["set-cookie"] ?? "";
    const m = /CSRF-TOKEN=([^;]+)/.exec(setCookie);
    if (!m) throw new ProviderError("easyname: no CSRF token", "easyname");
    this.#csrf = m[1]!;
    this.#cookie = `CSRF-TOKEN=${this.#csrf}`;
    // step 2: POST login with X-CSRF-TOKEN
    const login = await this.#fetch(`${this.#base}/en/authentication-api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": this.#csrf, cookie: this.#cookie },
      body: JSON.stringify({ emailAddress: this.#email, password: this.#password }),
    });
    const sc2 = (login as unknown as { headers?: Record<string, string> }).headers?.["set-cookie"] ?? "";
    const authM = /(?:hoverauth|session|JSESSIONID)=([^;]+)/.exec(sc2);
    if (authM) this.#cookie += `; ${sc2.split(";")[0]}`;
    if (!login.ok) throw new ProviderError("easyname login failed", "easyname", login.status);
  }

  async #post(path: string, body?: Record<string, unknown>): Promise<unknown> {
    await this.#login();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": this.#csrf, cookie: this.#cookie },
      body: body ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : undefined,
    });
    if (!res.ok) throw new ProviderError(`easyname API error HTTP ${res.status}`, "easyname", res.status);
    return res.text();
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    await this.#login();
    const res = await this.#fetch(`${this.#base}/en/domain/dns/index/domain/${zone}/`, { headers: { cookie: this.#cookie } });
    const html = await res.text();
    const out: DnsRecord[] = [];
    // parse table rows: host / type / value / edit link (id)
    const rowRe = /<tr[^>]*data-id="?([0-9]+)"?[^>]*>([\s\S]*?)<\/tr>/g;
    let i = 0;
    for (const m of html.matchAll(rowRe)) {
      const cells = [...(m[2] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => (c[1] ?? "").replace(/<[^>]+>/g, "").trim());
      if (cells.length >= 3) out.push({ id: m[1] ?? String(i++), type: cells[1] ?? "", name: cells[0] ?? "", value: cells[2] ?? "", ttl: undefined });
    }
    if (filter?.type) return out.filter((r) => r.type === filter.type);
    if (filter?.name) return out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#post(`/en/domain/dns/create/domain/${zone}/`, { name: rec.name, type: rec.type, value: rec.value });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#post(`/en/domain/dns/edit/domain/${zone}/id/${id}/`, { name: rec.name, type: rec.type, value: rec.value });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#post(`/en/domain/dns/delete/domain/${zone}/id/${id}/`);
  }
}

/* --------------------------------- gransy -------------------------------- */

/** gransy (subreg.cz): SOAP XML POST — Login / Get_DNS_Zone / Add_DNS_Record
 *  / Modify_DNS_Record / Delete_DNS_Record. Minimal envelope build/parse. */
export class GransyProvider implements ZoneProvider {
  readonly meta = { name: "gransy", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("gransy requires username + password", "gransy");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://subreg.cz";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async #call(op: string, fields: Record<string, string>): Promise<string> {
    const body = Object.entries(fields).map(([k, v]) => `<${k}>${this.#esc(v)}</${k}>`).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op} xmlns="https://subreg.cz">${body}</${op}></soap:Body></soap:Envelope>`;
    const res = await this.#fetch(`${this.#base}/wsdl`, {
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8", soapaction: op },
      body: xml,
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`gransy API error HTTP ${res.status}`, "gransy", res.status);
    return text;
  }

  #parseRecords(xml: string): Array<{ id: string; type: string; name: string; value: string }> {
    const out: Array<{ id: string; type: string; name: string; value: string }> = [];
    const recRe = /<record>([\s\S]*?)<\/record>/g;
    for (const m of xml.matchAll(recRe)) {
      const b = m[1] ?? "";
      const id = /<id>([^<]*)<\/id>/.exec(b)?.[1] ?? "";
      const type = /<type>([^<]*)<\/type>/.exec(b)?.[1] ?? "";
      const name = /<name>([^<]*)<\/name>/.exec(b)?.[1] ?? "";
      const value = /<rdata>([^<]*)<\/rdata>/.exec(b)?.[1] ?? /<value>([^<]*)<\/value>/.exec(b)?.[1] ?? "";
      if (type) out.push({ id, type, name, value });
    }
    return out;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    await this.#call("Login", { login: this.#username, password: this.#password });
    const xml = await this.#call("Get_DNS_Zone", { domain: zone });
    let out = this.#parseRecords(xml);
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#call("Login", { login: this.#username, password: this.#password });
    await this.#call("Add_DNS_Record", { domain: zone, type: rec.type, name: rec.name, rdata: rec.value });
    return { id: `${rec.name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#call("Login", { login: this.#username, password: this.#password });
    await this.#call("Modify_DNS_Record", { domain: zone, id, type: rec.type, name: rec.name, rdata: rec.value });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#call("Login", { login: this.#username, password: this.#password });
    await this.#call("Delete_DNS_Record", { domain: zone, id });
  }
}

export function createEasyname(cfg: ProviderConfig): EasynameProvider {
  const email = cfg.username ?? process.env.DDNS_EASYNAME_EMAIL ?? "";
  const password = cfg.password ?? process.env.DDNS_EASYNAME_PASSWORD ?? "";
  return new EasynameProvider({ email, password, baseUrl: cfg.baseUrl });
}
export function createGransy(cfg: ProviderConfig): GransyProvider {
  const username = cfg.username ?? process.env.DDNS_GRANSY_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_GRANSY_PASSWORD ?? "";
  return new GransyProvider({ username, password, baseUrl: cfg.baseUrl });
}

/* --------------------------------- hover --------------------------------- */

/** hover: cookie session (hover_session + hoverauth via TOTP 2FA) →
 *  /control_panel/dns JSON CRUD. totpCode injectable for tests. */
export class HoverProvider implements ZoneProvider {
  readonly meta = { name: "hover", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password", "secret (totp secret)"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #totp: (() => string) | null;
  #cookies: Record<string, string> = {};

  constructor(opts: { username: string; password: string; totpCode?: () => string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("hover requires username + password", "hover");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://www.hover.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
    this.#totp = opts.totpCode ?? null;
  }

  async #auth(): Promise<void> {
    if (this.#cookies.hoverauth) return;
    // step 1: GET /signin → hover_session cookie
    const home = await this.#fetch(`${this.#base}/signin`);
    const sc = (home as unknown as { headers?: Record<string, string> }).headers?.["set-cookie"] ?? "";
    const sessionM = /hover_session=([^;]+)/.exec(sc);
    if (!sessionM) throw new ProviderError("hover: no session cookie", "hover");
    this.#cookies.hover_session = sessionM[1]!;
    const cookieStr = `hover_session=${this.#cookies.hover_session}`;
    // step 2: POST auth.json (username/password)
    const login = await this.#fetch(`${this.#base}/signin/auth.json`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieStr },
      body: JSON.stringify({ username: this.#username, password: this.#password }),
    });
    if (!login.ok) throw new ProviderError("hover login failed", "hover", login.status);
    const sc2 = (login as unknown as { headers?: Record<string, string> }).headers?.["set-cookie"] ?? "";
    const authM = /hoverauth=([^;]+)/.exec(sc2);
    if (!authM) throw new ProviderError("hover: no auth cookie", "hover");
    this.#cookies.hoverauth = authM[1]!;
  }

  #cookieStr(): string {
    return Object.entries(this.#cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    await this.#auth();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie: this.#cookieStr() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new ProviderError(`hover API error HTTP ${res.status}`, "hover", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#req("GET", `/control_panel/dns/${zone}`);
    const domain = (json as { domain?: { dns?: Array<Record<string, unknown>> } }).domain;
    let out = ((domain?.dns ?? []) as Array<Record<string, unknown>>).map((r) => ({
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
    const { json } = await this.#req("POST", "/control_panel/dns", { domain: zone, name: rec.name, type: rec.type, content: rec.value });
    return { id: String((json as { id?: string } | null)?.id ?? `${rec.name}/${rec.type}`) };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("POST", "/control_panel/dns", { id, domain: zone, name: rec.name, type: rec.type, content: rec.value });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("DELETE", "/control_panel/dns", { id });
  }
}

export function createHover(cfg: ProviderConfig): HoverProvider {
  const username = cfg.username ?? process.env.DDNS_HOVER_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_HOVER_PASSWORD ?? "";
  return new HoverProvider({ username, password, baseUrl: cfg.baseUrl });
}
