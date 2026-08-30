/** dnspod — Tencent DNSPod legacy form API (lexicon's dnspod provider +
 *  ddns-updater's dnspod: both drive dnsapi.cn Record.List/Create/Modify/
 *  Remove with login_token). */

import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../../types.ts";
import { ProviderError, baseUrl, formEncode } from "../common.ts";

const OFFICIAL = "https://dnsapi.cn";

export interface DnspodOptions {
  /** login_token "<id>,<token>". */
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface DnspodStatus {
  code: string;
  message: string;
}

interface DnspodRecord {
  id: string | number;
  name: string;
  type: string;
  value: string;
  ttl?: string | number;
  line?: string;
}

export class DnspodProvider implements ZoneProvider {
  readonly meta = {
    name: "dnspod",
    style: "zone",
    recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX", "NS"],
    needsZone: true,
    authFields: ["token (login_token '<id>,<token>')"],
    params: [],
  } as const;

  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: DnspodOptions) {
    if (!opts.token) throw new ProviderError("dnspod requires a token (login_token '<id>,<token>')", "dnspod");
    this.#token = opts.token;
    this.#base = baseUrl({ provider: "dnspod", token: opts.token, baseUrl: opts.baseUrl }, OFFICIAL);
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async #api(action: string, params: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
    const res = await this.#fetch(`${this.#base}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode({ login_token: this.#token, format: "json", ...params }),
    });
    const body = (await res.json().catch(() => null)) as { status?: DnspodStatus; data?: unknown } | null;
    if (!body || body.status?.code !== "1") {
      throw new ProviderError(
        `dnspod API error ${body?.status?.code ?? res.status}: ${body?.status?.message ?? "request failed"}`,
        "dnspod",
        res.status,
        body?.status?.code,
      );
    }
    return (body.data ?? {}) as Record<string, unknown>;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const data = await this.#api("Record.List", {
      domain: zone,
      sub_domain: filter?.name ?? undefined,
      record_type: filter?.type ?? undefined,
    });
    const records = (data.records ?? []) as DnspodRecord[];
    return (Array.isArray(records) ? records : []).map((r) => ({
      id: String(r.id),
      type: r.type,
      name: r.name,
      value: r.value,
      ttl: r.ttl !== undefined ? Number(r.ttl) : undefined,
    }));
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const [owner] = splitOwner(rec.name, zone);
    const data = await this.#api("Record.Create", {
      domain: zone,
      sub_domain: owner,
      record_type: rec.type,
      record_line: "默认",
      value: rec.value,
      ttl: rec.ttl ?? 600,
      ...(rec.priority !== undefined ? { mx: rec.priority } : {}),
    });
    return { id: String((data as { id?: string | number }).id ?? "") };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const [owner] = splitOwner(rec.name, zone);
    await this.#api("Record.Modify", {
      domain: zone,
      record_id: id,
      sub_domain: owner,
      record_type: rec.type,
      record_line: "默认",
      value: rec.value,
      ttl: rec.ttl ?? 600,
    });
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    await this.#api("Record.Remove", { domain: zone, record_id: id });
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

function splitOwner(name: string, zone: string): [string] {
  const r = name.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  if (r === z) return ["@"];
  if (r.endsWith(`.${z}`)) return [r.slice(0, -(z.length + 1))];
  throw new ProviderError(`record '${name}' is not under zone '${zone}'`, "dnspod");
}

/** Create a dnspod provider from a flat ProviderConfig. */
export function createDnspod(cfg: ProviderConfig): DnspodProvider {
  const raw = cfg.token ?? process.env.DDNS_DNSPOD_TOKEN ?? "";
  const token = raw.includes(",") ? raw : cfg.secret ? `${raw},${cfg.secret}` : raw;
  if (!raw) throw new ProviderError("dnspod requires cfg.token (login_token) or DDNS_DNSPOD_TOKEN", "dnspod");
  return new DnspodProvider({ token, baseUrl: cfg.baseUrl });
}
