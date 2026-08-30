/** gcp — Google Cloud DNS (OAuth bearer token, JSON REST; Go uses the
 *  golang.org/x/oauth2/google service-account flow — here the token is
 *  provided directly (CLI: gcloud auth print-access-token, or a service
 *  account token), keeping the provider dependency-free). */

import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

const OFFICIAL = "https://dns.googleapis.com/dns/v1";

export interface GcpOptions {
  project: string;
  zone: string;
  /** OAuth2 access token (gcloud auth print-access-token). */
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface GcpRrset {
  name: string;
  type: string;
  ttl?: number;
  rrdatas?: string[];
}

export class GcpProvider implements ZoneProvider {
  readonly meta = { name: "gcp", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (OAuth access token)", "username (project)", "password (managed zone)"],
    params: [] } as const;
  readonly #project: string;
  readonly #zone: string;
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: GcpOptions) {
    if (!opts.project || !opts.zone || !opts.accessToken) {
      throw new ProviderError("gcp requires project + zone + accessToken", "gcp");
    }
    this.#project = opts.project;
    this.#zone = opts.zone;
    this.#token = opts.accessToken;
    this.#base = opts.baseUrl ?? OFFICIAL;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new ProviderError(`gcp API error HTTP ${res.status}: ${json?.error?.message ?? ""}`, "gcp", res.status);
    return { status: res.status, json };
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { json } = await this.#api("GET", `/projects/${this.#project}/managedZones/${this.#zone}/rrsets`);
    let out = ((json as { rrsets?: GcpRrset[] }).rrsets ?? []).map((r) => ({
      id: `${r.name}/${r.type}`,
      type: r.type,
      name: r.name.endsWith(".") ? r.name.slice(0, -1) : r.name,
      value: r.rrdatas?.[0] ?? "",
      ttl: r.ttl,
    }));
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const name = rec.name.endsWith(".") ? rec.name : `${rec.name}.`;
    await this.#api("POST", `/projects/${this.#project}/managedZones/${this.#zone}/changes`, {
      additions: [{ name, type: rec.type, ttl: rec.ttl ?? 300, rrdatas: [rec.value] }],
    });
    return { id: `${name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const name = rec.name.endsWith(".") ? rec.name : `${rec.name}.`;
    // deletion + addition in one change
    await this.#api("POST", `/projects/${this.#project}/managedZones/${this.#zone}/changes`, {
      deletions: [{ name, type: rec.type }],
      additions: [{ name, type: rec.type, ttl: rec.ttl ?? 300, rrdatas: [rec.value] }],
    });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    if (!name || !type) return;
    await this.#api("POST", `/projects/${this.#project}/managedZones/${this.#zone}/changes`, {
      deletions: [{ name, type }],
    });
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

export function createGcp(cfg: ProviderConfig): GcpProvider {
  const project = cfg.username ?? process.env.DDNS_GCP_PROJECT ?? "";
  const zone = cfg.password ?? process.env.DDNS_GCP_ZONE ?? "";
  const token = cfg.token ?? process.env.DDNS_GCP_TOKEN ?? "";
  return new GcpProvider({ project, zone, accessToken: token, baseUrl: cfg.baseUrl });
}
