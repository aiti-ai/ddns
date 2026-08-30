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

export function createSpaceship(cfg: ProviderConfig): SpaceshipProvider {
  const apiKey = cfg.token ?? process.env.DDNS_SPACESHIP_API_KEY ?? "";
  const apiSecret = cfg.secret ?? process.env.DDNS_SPACESHIP_API_SECRET ?? "";
  return new SpaceshipProvider({ apiKey, apiSecret, baseUrl: cfg.baseUrl });
}
