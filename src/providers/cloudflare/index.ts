/** cloudflare — REST v4 (lexicon's cloudflare + ddns-updater's cloudflare:
 *  same API, both implement list/create/update/delete on
 *  /zones/:id/dns_records, plus zone lookup by name). */

import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../../types.ts";
import { ProviderError, baseUrl, httpJson } from "../common.ts";

const OFFICIAL = "https://api.cloudflare.com/client/v4";

export interface CloudflareOptions {
  token: string;
  /** Skip the zone lookup. */
  zoneId?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface CfZone {
  id: string;
  name: string;
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
}

export class CloudflareProvider implements ZoneProvider {
  readonly meta = {
    name: "cloudflare",
    style: "zone",
    recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX", "NS"],
    needsZone: true,
    authFields: ["token (API token)", "zoneId (optional)"],
  } as const;

  readonly #token: string;
  readonly #zoneId: string | undefined;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: CloudflareOptions) {
    if (!opts.token) throw new ProviderError("cloudflare requires a token (API token)", "cloudflare");
    this.#token = opts.token;
    this.#zoneId = opts.zoneId;
    this.#base = opts.baseUrl ?? OFFICIAL;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: Array<{ code: number; message: string }>; result?: unknown } | null;
    if (!body?.success) {
      const e = body?.errors?.[0];
      throw new ProviderError(
        e ? `cloudflare API error ${e.code}: ${e.message}` : `cloudflare API error HTTP ${res.status}`,
        "cloudflare",
        res.status,
        e ? String(e.code) : undefined,
      );
    }
    return body.result;
  }

  async #resolveZoneId(zone: string): Promise<string> {
    if (this.#zoneId) return this.#zoneId;
    const zones = (await this.#api(`/zones?name=${encodeURIComponent(zone)}`)) as CfZone[];
    const z = zones?.[0];
    if (!z) throw new ProviderError(`cloudflare: zone '${zone}' not found`, "cloudflare");
    return z.id;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const zid = await this.#resolveZoneId(zone);
    const q = new URLSearchParams();
    if (filter?.type) q.set("type", filter.type);
    if (filter?.name) q.set("name", filter.name);
    const qs = q.toString();
    const records = (await this.#api(`/zones/${zid}/dns_records${qs ? `?${qs}` : ""}`)) as CfRecord[];
    return (records ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      value: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      priority: r.priority,
    }));
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const zid = await this.#resolveZoneId(zone);
    const body = {
      type: rec.type,
      name: rec.name,
      content: rec.value,
      ttl: rec.ttl ?? 1,
      proxied: rec.proxied ?? false,
      ...(rec.priority !== undefined ? { priority: rec.priority } : {}),
    };
    const created = (await this.#api(`/zones/${zid}/dns_records`, { method: "POST", body })) as { id: string };
    return { id: created.id };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const zid = await this.#resolveZoneId(zone);
    await this.#api(`/zones/${zid}/dns_records/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: {
        type: rec.type,
        name: rec.name,
        content: rec.value,
        ttl: rec.ttl ?? 1,
        proxied: rec.proxied ?? false,
        ...(rec.priority !== undefined ? { priority: rec.priority } : {}),
      },
    });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const zid = await this.#resolveZoneId(zone);
    await this.#api(`/zones/${zid}/dns_records/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/** Create a cloudflare provider from a flat ProviderConfig. */
export function createCloudflare(cfg: ProviderConfig): CloudflareProvider {
  const token = cfg.token ?? process.env.DDNS_CLOUDFLARE_TOKEN;
  if (!token) throw new ProviderError("cloudflare requires cfg.token (API token) or DDNS_CLOUDFLARE_TOKEN", "cloudflare");
  return new CloudflareProvider({ token, zoneId: cfg.zoneId, baseUrl: cfg.baseUrl });
}
