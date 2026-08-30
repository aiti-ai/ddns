/** Generic REST zone provider — spec-driven CRUD against the zone-API
 *  family (digitalocean, gandi, godaddy, hostinger, ionos, linode, luadns,
 *  namecom, porkbun, scaleway, servercow, vercel, vultr, hetznercloud,
 *  bunny, desec, dreamhost, dondominio …). Each service declares:
 *
 *   - base URL + auth (bearer / X-API-Key header / query key)
 *   - record-list endpoint template + JSON paths to the record array
 *   - create/update/delete endpoint templates
 *   - record field mapping (id/type/name/value/ttl/priority/proxied)
 *
 *  The Go source for each service was checked to extract these shapes.
 */

import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

export interface RestAuth {
  type: "bearer" | "header" | "query" | "basic";
  /** Header name for type "header" (e.g. "X-API-Key"). */
  header?: string;
  /** Query key for type "query" (e.g. "key"). */
  queryKey?: string;
  /** Config field holding the credential (token / secret / accessKeyId). */
  cfgField: "token" | "secret" | "accessKeyId";
  /** Env var fallback name. */
  env?: string;
}

export interface RestSpec {
  name: string;
  baseUrl: string;
  auth: RestAuth;
  /** Whether the API needs a zone-id lookup (hostinger/ionos/luadns/linode
   *  resolve zone name → numeric id first). */
  zoneIdLookup?: { path: (zone: string) => string; idPath: string };
  /** Record list. */
  list: {
    path: (zone: string, zoneId?: string) => string;
    /** JSON path to the record array, e.g. ["records"] or ["data"]. */
    recordsPath: string[];
    /** Optional: object wrapper, e.g. ["domain_records"] for linode pages. */
    pagesPath?: string[];
  };
  /** Field mapping: read from a record object. */
  fields: {
    id: (r: Record<string, unknown>) => string;
    type: (r: Record<string, unknown>) => string;
    name: (r: Record<string, unknown>) => string;
    value: (r: Record<string, unknown>) => string;
    ttl?: (r: Record<string, unknown>) => number | undefined;
    proxied?: (r: Record<string, unknown>) => boolean | undefined;
  };
  create: {
    /** Path template; may contain {name}/{type} placeholders (gandi-style). */
    path: (zone: string, zoneId: string | undefined, rec: DnsRecord) => string;
    body: (zone: string, rec: DnsRecord, zoneId?: string) => Record<string, unknown> | unknown[];
    /** JSON path to the created record id (optional). */
    idPath?: string[];
    /** HTTP method (default POST). */
    method?: string;
  };
  update: {
    path: (zone: string, id: string, zoneId?: string) => string;
    body: (zone: string, rec: DnsRecord, zoneId?: string) => Record<string, unknown> | unknown[];
    method?: string;
  };
  delete: {
    path: (zone: string, id: string, zoneId?: string) => string;
    method?: string;
  };
  /** Optional: filter the list result by name (for APIs that don't filter). */
  filterByName?: boolean;
  /** Composite record-id order: "name-type" (gandi: "home/A") or
   *  "type-name" (godaddy: "A/home"). Default "name-type". */
  idOrder?: "name-type" | "type-name";
  /** Optional: treat 404 on update as create (some APIs auto-create). */
  updateCreates?: boolean;
}

export class RestProvider implements ZoneProvider {
  readonly meta: { name: string; style: "zone"; recordTypes: string[]; needsZone: true; authFields: string[] };

  readonly #spec: RestSpec;
  readonly #cred: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  #zoneIds = new Map<string, string>();

  constructor(spec: RestSpec, cfg: ProviderConfig, fetchImpl?: FetchLike) {
    const cred = cfg[spec.auth.cfgField] ?? (spec.auth.env ? process.env[spec.auth.env] : undefined);
    if (!cred) throw new ProviderError(`provider '${spec.name}' requires ${spec.auth.cfgField}`, spec.name);
    this.#spec = spec;
    this.#cred = cred;
    this.#base = cfg.baseUrl ?? spec.baseUrl;
    this.#fetch = fetchImpl ?? defaultFetchImpl;
    this.meta = {
      name: spec.name,
      style: "zone",
      recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX", "NS"],
      needsZone: true,
      authFields: [spec.auth.cfgField],
    };
  }

  #headers(json = false): Record<string, string> {
    const h: Record<string, string> = { "user-agent": "ddns/0.1" };
    const a = this.#spec.auth;
    if (a.type === "bearer") h.authorization = `Bearer ${this.#cred}`;
    else if (a.type === "header") h[a.header ?? "X-API-Key"] = this.#cred;
    else if (a.type === "basic") h.authorization = `Basic ${Buffer.from(this.#cred).toString("base64")}`;
    if (json) h["content-type"] = "application/json";
    return h;
  }

  #url(path: string): string {
    if (this.#spec.auth.type !== "query") return `${this.#base}${path}`;
    const sep = path.includes("?") ? "&" : "?";
    return `${this.#base}${path}${sep}${this.#spec.auth.queryKey}=${encodeURIComponent(this.#cred)}`;
  }

  async #zoneId(zone: string): Promise<string | undefined> {
    const zl = this.#spec.zoneIdLookup;
    if (!zl) return undefined;
    const cached = this.#zoneIds.get(zone);
    if (cached) return cached;
    const res = await this.#fetch(this.#url(zl.path(zone)), { headers: this.#headers() });
    if (!res.ok) throw new ProviderError(`${this.#spec.name} zone lookup failed: HTTP ${res.status}`, this.#spec.name, res.status);
    const body = (await res.json()) as Record<string, unknown>;
    const id = getPath(body, zl.idPath.split(".")) as string | undefined;
    if (!id) throw new ProviderError(`${this.#spec.name}: zone '${zone}' not found`, this.#spec.name);
    this.#zoneIds.set(zone, id);
    return id;
  }

  async #req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(this.#url(path), {
      method,
      headers: this.#headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON
    }
    if (!res.ok && !(this.#spec.updateCreates && method === "PUT" && res.status === 404)) {
      throw new ProviderError(`${this.#spec.name} API error HTTP ${res.status}`, this.#spec.name, res.status);
    }
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const zid = await this.#zoneId(zone);
    const { json } = await this.#req("GET", this.#spec.list.path(zone, zid));
    let arr = getPath(json as Record<string, unknown>, this.#spec.list.recordsPath);
    if (this.#spec.list.pagesPath && !Array.isArray(arr)) {
      arr = getPath(json as Record<string, unknown>, this.#spec.list.pagesPath);
    }
    if (!Array.isArray(arr)) arr = [];
    let out = (arr as Record<string, unknown>[]).map((r) => {
      const rec: DnsRecord = {
        id: this.#spec.fields.id(r),
        type: this.#spec.fields.type(r),
        name: this.#spec.fields.name(r),
        value: this.#spec.fields.value(r),
      };
      const ttl = this.#spec.fields.ttl?.(r);
      if (ttl !== undefined) rec.ttl = ttl;
      const proxied = this.#spec.fields.proxied?.(r);
      if (proxied !== undefined) rec.proxied = proxied;
      return rec;
    });
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name || (this.#spec.filterByName && r.name.endsWith(`.${filter.name}`)));
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const zid = await this.#zoneId(zone);
    const { json } = await this.#req(this.#spec.create.method ?? "POST", expandPath(this.#spec.create.path(zone, zid, rec), rec), this.#spec.create.body(zone, rec, zid));
    const idPath = this.#spec.create.idPath;
    const id = idPath ? (getPath(json as Record<string, unknown>, idPath) as string | undefined) : undefined;
    return { id: id ?? "" };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    const path = expandPath(this.#spec.update.path(zone, id, zid), rec);
    await this.#req(this.#spec.update.method ?? "PUT", path, this.#spec.update.body(zone, rec, zid));
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const zid = await this.#zoneId(zone);
    const [a, b] = id.split("/");
    const name = this.#spec.idOrder === "type-name" ? b ?? "" : a ?? "";
    const type = this.#spec.idOrder === "type-name" ? a ?? "" : b ?? "";
    const path = expandPath(this.#spec.delete.path(zone, id, zid), { name, type } as DnsRecord);
    await this.#req(this.#spec.delete.method ?? "DELETE", path);
  }
}

/** Expand {name}/{type} placeholders in a create path template. */
function expandPath(path: string, rec: DnsRecord): string {
  return path.replaceAll("{name}", rec.name).replaceAll("{type}", rec.type);
}

/** Walk a dotted JSON path ("result.records") through an object. */
export function getPath(obj: Record<string, unknown> | null | undefined, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/** Create a RestProvider from a flat config + spec. */
export function createRest(spec: RestSpec, cfg: ProviderConfig): RestProvider {
  return new RestProvider(spec, cfg);
}
