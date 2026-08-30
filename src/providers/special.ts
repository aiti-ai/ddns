/** Special-case providers — APIs that don't fit the REST/dyndns2 spec
 *  framework (Go ddns-updater shapes verified):
 *   - dreamhost : cmd-style query API (dns-list_records / add / remove)
 *   - dondominio: push JSON (user/password/host/ip)
 *   - netcup    : JSON-RPC-ish webservice (login → infoDnsRecords →
 *                 updateDnsRecords)
 *   - namesilo  : key-query XML-ish JSON API (listRecords / addRecord /
 *                 dnsUpdateRecord)
 *   - spaceship : REST with X-API-Key + X-API-Secret headers
 */

import { createHmac } from "node:crypto";
import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, PushProvider, ZoneProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/* ------------------------------- dreamhost ------------------------------ */

/** dreamhost: GET https://api.dreamhost.com/?key=..&unique_id=..&format=json&cmd=.. */
export class DreamhostProvider implements ZoneProvider {
  readonly meta = { name: "dreamhost", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (API key)"],
    params: [] } as const;
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { key: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.key) throw new ProviderError("dreamhost requires an API key", "dreamhost");
    this.#key = opts.key;
    this.#base = opts.baseUrl ?? "https://api.dreamhost.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #cmd(params: Record<string, string>): Promise<unknown> {
    const q = new URLSearchParams({ key: this.#key, unique_id: crypto.randomUUID(), format: "json", ...params });
    const res = await this.#fetch(`${this.#base}/?${q.toString()}`);
    const body = (await res.json()) as { result?: string; data?: unknown };
    if (body.result !== "success") throw new ProviderError(`dreamhost error: ${String(body.result)}`, "dreamhost", res.status);
    return body.data;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const data = (await this.#cmd({ cmd: "dns-list_records" })) as Array<{ record: string; type: string; value: string; edns?: string; comment?: string }>;
    let out = (Array.isArray(data) ? data : []).map((r) => ({ id: r.record, type: r.type, name: r.record, value: r.value, ttl: undefined }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#cmd({ cmd: "dns-add_record", record: rec.name, type: rec.type, value: rec.value });
    return { id: rec.name };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    // dreamhost: remove then add (no in-place update)
    await this.#cmd({ cmd: "dns-remove_record", record: id, type: rec.type, value: rec.value });
    await this.#cmd({ cmd: "dns-add_record", record: rec.name, type: rec.type, value: rec.value });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    // id = "record" — but delete needs type+value; dreamhost's remove needs
    // exact record/type/value. We only know the name here; providers calling
    // delete should pass name as id and accept best-effort remove.
    await this.#cmd({ cmd: "dns-remove_record", record: id, type: "", value: "" });
  }
}

/* ------------------------------- dondominio ----------------------------- */

/** dondominio: GET https://dondns.dondominio.com/json/?user&password&host&ip&lang */
export class DondominioProvider implements PushProvider {
  readonly meta = { name: "dondominio", style: "push", recordTypes: ["A", "AAAA"], needsZone: false, authFields: ["username", "password"],
    params: [] } as const;
  readonly #user: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("dondominio requires username + password", "dondominio");
    this.#user = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://dondns.dondominio.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void> {
    const q = new URLSearchParams({ user: this.#user, password: this.#password, host: rec.name, ip: rec.value, lang: "en" });
    const res = await this.#fetch(`${this.#base}/json/?${q.toString()}`, { headers: { accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    if (!body?.success) {
      throw new ProviderError(`dondominio error: ${String(body?.error ?? res.status)}`, "dondominio", res.status);
    }
  }
}

/* -------------------------------- netcup -------------------------------- */

/** netcup: POST https://ccp.netcup.net/run/webservice/servers/endpoint.php
 *  JSON-RPC-ish: {action, param: {apikey, apisessionid, clientrequestid, ...}} */
interface NetcupRecord {
  id: string;
  hostname: string;
  type: string;
  destination: string;
  priority?: string;
  ttl?: string;
}

export class NetcupProvider implements ZoneProvider {
  readonly meta = { name: "netcup", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (API key)", "secret (API password)", "username (customer number)"],
    params: [] } as const;
  readonly #customer: string;
  readonly #apiKey: string;
  readonly #apiPassword: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { customerNumber: string; apiKey: string; apiPassword: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.customerNumber || !opts.apiKey || !opts.apiPassword) {
      throw new ProviderError("netcup requires customerNumber + apiKey + apiPassword", "netcup");
    }
    this.#customer = opts.customerNumber;
    this.#apiKey = opts.apiKey;
    this.#apiPassword = opts.apiPassword;
    this.#base = opts.baseUrl ?? "https://ccp.netcup.net/run/webservice/servers/endpoint.php";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #call(action: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = { action, param: { apikey: this.#apiKey, apisessionid: "", clientrequestid: crypto.randomUUID(), ...param } };
    const res = await this.#fetch(this.#base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { status?: string; responsedata?: unknown; shortmessage?: string } | null;
    if (json?.status !== "success") throw new ProviderError(`netcup error: ${String(json?.shortmessage ?? json?.status ?? res.status)}`, "netcup", res.status);
    return (json.responsedata ?? {}) as Record<string, unknown>;
  }

  async #login(): Promise<string> {
    const data = (await this.#call("login", { customernumber: this.#customer, apipassword: this.#apiPassword })) as { apisessionid?: string };
    const sid = data.apisessionid;
    if (!sid) throw new ProviderError("netcup login failed: no session id", "netcup");
    return sid;
  }

  async #withSession<T>(fn: (sid: string) => Promise<T>): Promise<T> {
    const sid = await this.#login();
    try {
      return await fn(sid);
    } finally {
      await this.#call("logout", { apisessionid: sid }).catch(() => {});
    }
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    return this.#withSession(async (sid) => {
      const data = (await this.#call("infoDnsRecords", { domainname: zone, apisessionid: sid })) as { dnsrecords?: NetcupRecord[] };
      let out = (data.dnsrecords ?? []).map((r) => ({
        id: r.id,
        type: r.type,
        name: r.hostname === "@" ? zone : `${r.hostname}.${zone}`,
        value: r.destination,
        ttl: r.ttl ? Number(r.ttl) : undefined,
      }));
      if (filter?.type) out = out.filter((r) => r.type === filter.type);
      if (filter?.name) out = out.filter((r) => r.name === filter.name);
      return out;
    });
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    return this.#withSession(async (sid) => {
      const hostname = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
      const data = (await this.#call("updateDnsRecords", {
        domainname: zone,
        apisessionid: sid,
        dnsrecordset: { dnsrecords: [{ id: "", hostname, type: rec.type, destination: rec.value, ttl: String(rec.ttl ?? 300) }] },
      })) as { dnsrecords?: Array<{ id?: string }> };
      return { id: String(data.dnsrecords?.[0]?.id ?? "") };
    });
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    return this.#withSession(async (sid) => {
      const hostname = rec.name === zone ? "@" : rec.name.replace(`.${zone}`, "");
      await this.#call("updateDnsRecords", {
        domainname: zone,
        apisessionid: sid,
        dnsrecordset: { dnsrecords: [{ id, hostname, type: rec.type, destination: rec.value, ttl: String(rec.ttl ?? 300) }] },
      });
    });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    return this.#withSession(async (sid) => {
      await this.#call("updateDnsRecords", {
        domainname: zone,
        apisessionid: sid,
        dnsrecordset: { dnsrecords: [{ id, deleteRecord: true }] },
      });
    });
  }
}

/* -------------------------------- namesilo ------------------------------ */

/** namesilo: GET https://www.namesilo.com/api/<cmd>?version=1&type=json&key=..&domain=.. */
export class NamesiloProvider implements ZoneProvider {
  readonly meta = { name: "namesilo", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (API key)"],
    params: [] } as const;
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { key: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.key) throw new ProviderError("namesilo requires an API key", "namesilo");
    this.#key = opts.key;
    this.#base = opts.baseUrl ?? "https://www.namesilo.com/api";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #cmd(cmd: string, params: Record<string, string>): Promise<unknown> {
    const q = new URLSearchParams({ version: "1", type: "json", key: this.#key, ...params });
    const res = await this.#fetch(`${this.#base}/${cmd}?${q.toString()}`);
    const body = (await res.json()) as { reply?: { code?: number; detail?: string; resource_records?: unknown; rr_id?: string; record_id?: string } };
    if (body.reply?.code !== 300) {
      throw new ProviderError(`namesilo error ${body.reply?.code}: ${body.reply?.detail ?? "unknown"}`, "namesilo", res.status, String(body.reply?.code));
    }
    return body.reply;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const reply = (await this.#cmd("dnsListRecords", { domain: zone })) as { resource_records?: Array<{ record_id: string; type: string; host: string; value: string; ttl?: string }> };
    let out = (reply.resource_records ?? []).map((r) => ({
      id: r.record_id,
      type: r.type,
      name: r.host === "" ? zone : `${r.host}.${zone}`,
      value: r.value,
      ttl: r.ttl ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const host = rec.name === zone ? "" : rec.name.replace(`.${zone}`, "");
    const reply = (await this.#cmd("dnsAddRecord", { domain: zone, rrtype: rec.type, rrhost: host, rrvalue: rec.value, rrttl: String(rec.ttl ?? 3600) })) as { record_id?: string };
    return { id: String(reply.record_id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const host = rec.name === zone ? "" : rec.name.replace(`.${zone}`, "");
    await this.#cmd("dnsUpdateRecord", { domain: zone, rrid: id, rrhost: host, rrvalue: rec.value, rrttl: String(rec.ttl ?? 3600) });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#cmd("dnsDeleteRecord", { domain: zone, rrid: id });
  }
}

/* ----------------------------- dnsmadeeasy ------------------------------ */

/** dnsmadeeasy — x-dnsme-apiKey + x-dnsme-requestDate + x-dnsme-hmac
 *  (HMAC-SHA1 of the date with the secret key). */
export class DnsmadeeasyProvider implements ZoneProvider {
  readonly meta = { name: "dnsmadeeasy", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (api key)", "secret (hmac secret)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; secret: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey || !opts.secret) throw new ProviderError("dnsmadeeasy requires apiKey + secret", "dnsmadeeasy");
    this.#apiKey = opts.apiKey;
    this.#secret = opts.secret;
    this.#base = opts.baseUrl ?? "https://api.dnsmadeeasy.com/V2.0";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #headers(): Record<string, string> {
    const requestDate = new Date().toUTCString();
    const hashed = createHmac("sha1", this.#secret).update(requestDate).digest("hex");
    return { "x-dnsme-apiKey": this.#apiKey, "x-dnsme-requestDate": requestDate, "x-dnsme-hmac": hashed, "content-type": "application/json", accept: "application/json" };
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, { method, headers: this.#headers(), body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = (await res.json().catch(() => null)) as { id?: string; data?: unknown[]; records?: unknown[] } | null;
    if (!res.ok && !(method === "PUT" && res.status === 404)) throw new ProviderError(`dnsmadeeasy API error HTTP ${res.status}`, "dnsmadeeasy", res.status);
    return { status: res.status, json };
  }

  async #domainId(zone: string): Promise<string> {
    const { json } = await this.#req("GET", `/dns/managed/name?domainname=${encodeURIComponent(zone)}`);
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new ProviderError(`dnsmadeeasy: zone '${zone}' not found`, "dnsmadeeasy");
    return id;
  }

  async listRecords(zone: string, filter?: { type?: string; name?: string }): Promise<DnsRecord[]> {
    const did = await this.#domainId(zone);
    const q = new URLSearchParams();
    if (filter?.type) q.set("type", filter.type);
    if (filter?.name) q.set("name", filter.name);
    const { json } = await this.#req("GET", `/dns/managed/${did}/records${q.toString() ? `?${q}` : ""}`);
    const records = ((json as { data?: Array<Record<string, unknown>> }).data ?? []) as Array<Record<string, unknown>>;
    return records.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name),
      value: String(r.value ?? r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const did = await this.#domainId(zone);
    const { json } = await this.#req("POST", `/dns/managed/${did}/records/`, { type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 300 });
    return { id: String((json as { id?: string } | null)?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("PUT", `/dns/managed/${did}/records/${id}`, { type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("DELETE", `/dns/managed/${did}/records/${id}`);
  }
}

/* ------------------------------ constellix ------------------------------ */

/** constellix — x-cnsdns-apiKey + x-cnsdns-requestDate + x-cnsdns-hmac
 *  (HMAC-SHA1 of epoch-ms date, base64). Records are rr-sets (roundRobin). */
export class ConstellixProvider implements ZoneProvider {
  readonly meta = { name: "constellix", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (secret key)", "username (api key)"], params: [] } as const;
  readonly #apiKey: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; secret: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey || !opts.secret) throw new ProviderError("constellix requires apiKey + secret", "constellix");
    this.#apiKey = opts.apiKey;
    this.#secret = opts.secret;
    this.#base = opts.baseUrl ?? "https://api.dns.constellix.com/v1";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #headers(): Record<string, string> {
    const requestDate = String(Date.now());
    const hashed = createHmac("sha1", this.#secret).update(requestDate).digest("base64");
    return { "x-cnsdns-apiKey": this.#apiKey, "x-cnsdns-requestDate": requestDate, "x-cnsdns-hmac": hashed, "content-type": "application/json" };
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, { method, headers: this.#headers(), body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`constellix API error HTTP ${res.status}`, "constellix", res.status);
    return json;
  }

  async #domainId(zone: string): Promise<string> {
    const json = (await this.#req("GET", `/domains/`)) as { data?: Array<{ id: string; name: string }> };
    const d = (json.data ?? []).find((x) => x.name === zone);
    if (!d) throw new ProviderError(`constellix: zone '${zone}' not found`, "constellix");
    return d.id;
  }

  async listRecords(zone: string, filter?: { type?: string; name?: string }): Promise<DnsRecord[]> {
    const did = await this.#domainId(zone);
    const json = (await this.#req("GET", `/domains/${did}/records/${filter?.type ?? ""}`)) as { data?: Array<{ id: number; name: string; type: string; roundRobin?: Array<{ value: string }>; ttl?: number }> };
    let out = (json.data ?? []).map((r) => ({
      id: String(r.id),
      type: r.type,
      name: r.name,
      value: r.roundRobin?.[0]?.value ?? "",
      ttl: r.ttl,
    }));
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const did = await this.#domainId(zone);
    const json = (await this.#req("POST", `/domains/${did}/records/${rec.type}/`, { name: rec.name, ttl: rec.ttl ?? 300, roundRobin: [{ disableFlag: false, value: rec.value }] })) as { data?: { id?: number } };
    return { id: String(json.data?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("PUT", `/domains/${did}/records/${rec.type}/${id}`, { name: rec.name, ttl: rec.ttl ?? 300, roundRobin: [{ disableFlag: false, value: rec.value }] });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const did = await this.#domainId(zone);
    await this.#req("DELETE", `/domains/${did}/records/${id}`);
  }
}

/* ------------------------------- dnsservices ----------------------------- */

/** dnsservices — POST /login (username/password) → token → zone CRUD. */
export class DnsservicesProvider implements ZoneProvider {
  readonly meta = { name: "dnsservices", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("dnsservices requires username + password", "dnsservices");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://dns.services/api";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #login(): Promise<string> {
    const res = await this.#fetch(`${this.#base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: this.#username, password: this.#password }).toString(),
    });
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) throw new ProviderError("dnsservices login failed", "dnsservices", res.status);
    return body.token;
  }

  async #req(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`dnsservices API error HTTP ${res.status}`, "dnsservices", res.status);
    return json;
  }

  async #zoneIds(token: string, zone: string): Promise<{ serviceId: string; domainId: string }> {
    const json = (await this.#req("GET", `/dns`, token)) as { zones?: Array<{ name: string; domain_id: string; service_id: string }> };
    const z = (json.zones ?? []).find((x) => x.name === zone);
    if (!z) throw new ProviderError(`dnsservices: zone '${zone}' not found`, "dnsservices");
    return { serviceId: z.service_id, domainId: z.domain_id };
  }

  async listRecords(zone: string, filter?: { type?: string; name?: string }): Promise<DnsRecord[]> {
    const token = await this.#login();
    const { serviceId, domainId } = await this.#zoneIds(token, zone);
    const json = (await this.#req("GET", `/service/${serviceId}/dns/${domainId}`, token)) as Record<string, unknown>;
    let out = ((json.records ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name),
      value: String(r.content ?? r.data ?? ""),
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const token = await this.#login();
    const { serviceId, domainId } = await this.#zoneIds(token, zone);
    const json = (await this.#req("POST", `/service/${serviceId}/dns/${domainId}/records`, token, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 })) as { record?: { id?: string } };
    return { id: String(json.record?.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const token = await this.#login();
    const { serviceId, domainId } = await this.#zoneIds(token, zone);
    await this.#req("PUT", `/service/${serviceId}/dns/${domainId}/records/${id}`, token, { type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const token = await this.#login();
    const { serviceId, domainId } = await this.#zoneIds(token, zone);
    await this.#req("DELETE", `/service/${serviceId}/dns/${domainId}/records/${id}`, token);
  }
}

/* ------------------------------- ultradns ------------------------------- */

/** ultradns — POST /v2/authorization/token → Bearer, then rrset CRUD. */
export class UltradnsProvider implements ZoneProvider {
  readonly meta = { name: "ultradns", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["username", "password"], params: [] } as const;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.username || !opts.password) throw new ProviderError("ultradns requires username + password", "ultradns");
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://restapi.ultradns.com/v2";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #token(): Promise<string> {
    const res = await this.#fetch(`${this.#base}/authorization/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: this.#username, password: this.#password }).toString(),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
    if (!body?.access_token) throw new ProviderError("ultradns token acquisition failed", "ultradns", res.status);
    return body.access_token;
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.#token();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`ultradns API error HTTP ${res.status}`, "ultradns", res.status);
    return json;
  }

  #dot(name: string): string {
    return name.endsWith(".") ? name : `${name}.`;
  }

  #zonePath(zone: string): string {
    return `/zones/${this.#dot(zone)}/`;
  }

  async listRecords(zone: string, filter?: { type?: string; name?: string }): Promise<DnsRecord[]> {
    const json = (await this.#req("GET", `${this.#zonePath(zone)}rrsets`)) as { rrsets?: Array<{ ownerName: string; rrtype: string; rdata?: string[]; ttl?: number }> };
    let out = (json.rrsets ?? []).map((r) => ({
      id: `${r.ownerName}/${r.rrtype}`,
      type: r.rrtype,
      name: r.ownerName.replace(/\.$/, ""),
      value: r.rdata?.[0] ?? "",
      ttl: r.ttl,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    await this.#req("POST", `${this.#zonePath(zone)}rrsets/${rec.type}/${this.#dot(rec.name)}`, { ttl: rec.ttl ?? 300, rdata: [rec.value] });
    return { id: `${this.#dot(rec.name)}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PUT", `${this.#zonePath(zone)}rrsets/${rec.type}/${this.#dot(rec.name)}`, { ttl: rec.ttl ?? 300, rdata: [rec.value] });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#req("DELETE", `${this.#zonePath(zone)}rrsets/${type}/${this.#dot(name)}`);
  }
}

/* ------------------------------- namecheap ------------------------------ */

/** namecheap — dynamic DNS via query params (NOT basic auth):
 *  GET https://dynamicdns.park-your-domain.com/update?host=<label>&domain=<zone>
 *     &password=<32hex>&ip=<ip>
 *  Responses: "good <ip>", "nochg <ip>", "badauth", "nohost", "911". */
export class NamecheapProvider implements PushProvider {
  readonly meta = { name: "namecheap", style: "push", recordTypes: ["A", "AAAA"], needsZone: false, authFields: ["token (32-hex Dynamic DNS password)"], params: [] } as const;
  readonly #password: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.password) throw new ProviderError("namecheap requires the 32-hex Dynamic DNS password", "namecheap");
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? "https://dynamicdns.park-your-domain.com";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void> {
    // rec.name is a full FQDN; namecheap wants host (label) + domain (root)
    const dot = rec.name.indexOf(".");
    const host = dot < 0 ? "@" : rec.name.slice(0, dot);
    const domain = dot < 0 ? rec.name : rec.name.slice(dot + 1);
    const q = new URLSearchParams({ host, domain, password: this.#password, ip: rec.value });
    const res = await this.#fetch(`${this.#base}/update?${q.toString()}`);
    const body = (await res.text()).trim().toLowerCase();
    if (body.startsWith("good") || body.startsWith("nochg")) return;
    if (body.startsWith("badauth") || body.startsWith("nohost") || body.startsWith("911") || body.startsWith("badagent")) {
      throw new ProviderError(`namecheap rejected: ${body}`, "namecheap", res.status);
    }
    throw new ProviderError(`namecheap unknown response: ${body}`, "namecheap", res.status);
  }
}

/* ------------------------------- spaceship ------------------------------ */

/** spaceship: REST https://api.spaceship.dev/ with X-API-Key + X-API-Secret. */
export class SpaceshipProvider implements ZoneProvider {
  readonly meta = { name: "spaceship", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (API key)", "secret (API secret)"],
    params: [] } as const;
  readonly #key: string;
  readonly #secret: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { apiKey: string; apiSecret: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.apiKey || !opts.apiSecret) throw new ProviderError("spaceship requires apiKey + apiSecret", "spaceship");
    this.#key = opts.apiKey;
    this.#secret = opts.apiSecret;
    this.#base = opts.baseUrl ?? "https://api.spaceship.dev";
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #headers(): Record<string, string> {
    return { "x-api-key": this.#key, "x-api-secret": this.#secret, "content-type": "application/json", accept: "application/json" };
  }

  async #req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, { method, headers: this.#headers(), body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new ProviderError(`spaceship API error HTTP ${res.status}`, "spaceship", res.status);
    return json;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const data = (await this.#req("GET", `/v1/dns/zones/${zone}/records`)) as { records?: Array<{ id: string; type: string; name: string; value: string; ttl?: number }> };
    let out = (data.records ?? []).map((r) => ({ id: r.id, type: r.type, name: r.name, value: r.value, ttl: r.ttl }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const data = (await this.#req("POST", `/v1/dns/zones/${zone}/records`, { type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 3600 })) as { id?: string };
    return { id: String(data.id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    await this.#req("PUT", `/v1/dns/zones/${zone}/records/${id}`, { type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 3600 });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#req("DELETE", `/v1/dns/zones/${zone}/records/${id}`);
  }
}

/* ------------------------- registry (createXxx) ------------------------- */

export function createDreamhost(cfg: ProviderConfig): DreamhostProvider {
  const key = cfg.token ?? process.env.DDNS_DREAMHOST_KEY;
  if (!key) throw new ProviderError("dreamhost requires cfg.token (API key)", "dreamhost");
  return new DreamhostProvider({ key, baseUrl: cfg.baseUrl });
}

export function createDondominio(cfg: ProviderConfig): DondominioProvider {
  const username = cfg.username ?? process.env.DDNS_DONDOMINIO_USERNAME ?? "";
  const password = cfg.password ?? cfg.secret ?? process.env.DDNS_DONDOMINIO_PASSWORD ?? "";
  return new DondominioProvider({ username, password, baseUrl: cfg.baseUrl });
}

export function createNetcup(cfg: ProviderConfig): NetcupProvider {
  const customer = cfg.username ?? process.env.DDNS_NETCUP_CUSTOMER ?? "";
  const apiKey = cfg.token ?? process.env.DDNS_NETCUP_API_KEY ?? "";
  const apiPassword = cfg.secret ?? process.env.DDNS_NETCUP_API_PASSWORD ?? "";
  return new NetcupProvider({ customerNumber: customer, apiKey, apiPassword, baseUrl: cfg.baseUrl });
}

export function createNamesilo(cfg: ProviderConfig): NamesiloProvider {
  const key = cfg.token ?? process.env.DDNS_NAMESILO_KEY;
  if (!key) throw new ProviderError("namesilo requires cfg.token (API key)", "namesilo");
  return new NamesiloProvider({ key, baseUrl: cfg.baseUrl });
}

export function createConstellix(cfg: ProviderConfig): ConstellixProvider {
  const apiKey = cfg.username ?? process.env.DDNS_CONSTELLIX_API_KEY ?? "";
  const secret = cfg.token ?? process.env.DDNS_CONSTELLIX_SECRET ?? "";
  return new ConstellixProvider({ apiKey, secret, baseUrl: cfg.baseUrl });
}

export function createDnsservices(cfg: ProviderConfig): DnsservicesProvider {
  const username = cfg.username ?? process.env.DDNS_DNSSERVICES_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_DNSSERVICES_PASSWORD ?? "";
  return new DnsservicesProvider({ username, password, baseUrl: cfg.baseUrl });
}

export function createDnsmadeeasy(cfg: ProviderConfig): DnsmadeeasyProvider {
  const apiKey = cfg.token ?? process.env.DDNS_DNSMADEEASY_API_KEY ?? "";
  const secret = cfg.secret ?? process.env.DDNS_DNSMADEEASY_SECRET ?? "";
  return new DnsmadeeasyProvider({ apiKey, secret, baseUrl: cfg.baseUrl });
}

export function createUltradns(cfg: ProviderConfig): UltradnsProvider {
  const username = cfg.username ?? process.env.DDNS_ULTRADNS_USERNAME ?? "";
  const password = cfg.password ?? process.env.DDNS_ULTRADNS_PASSWORD ?? "";
  return new UltradnsProvider({ username, password, baseUrl: cfg.baseUrl });
}

export function createNamecheap(cfg: ProviderConfig): NamecheapProvider {
  const password = cfg.token ?? process.env.DDNS_NAMECHEAP_PASSWORD ?? "";
  return new NamecheapProvider({ password, baseUrl: cfg.baseUrl });
}

export function createSpaceship(cfg: ProviderConfig): SpaceshipProvider {
  const apiKey = cfg.token ?? process.env.DDNS_SPACESHIP_API_KEY ?? "";
  const apiSecret = cfg.secret ?? process.env.DDNS_SPACESHIP_API_SECRET ?? "";
  return new SpaceshipProvider({ apiKey, apiSecret, baseUrl: cfg.baseUrl });
}
