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
    // code "10" = 记录列表为空 — a legal empty result, not an error
    if (!body || (body.status?.code !== "1" && body.status?.code !== "10")) {
      throw new ProviderError(
        `dnspod API error ${body?.status?.code ?? res.status}: ${body?.status?.message ?? "request failed"}`,
        "dnspod",
        res.status,
        body?.status?.code,
      );
    }
    // DNSPod returns payload fields at the TOP level ({status, records,
    // domain, ...}) — not under "data". Return the whole body so callers
    // read e.g. body.records / body.domain.
    return body as unknown as Record<string, unknown>;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const data = await this.#api("Record.List", {
      domain: zone,
      // DNSPod's Record.List takes the SHORT label (or "@" for the apex);
      // the response "name" is likewise the label — rebuild the FQDN here.
      sub_domain: filter?.name ? labelOf(filter.name, zone) : undefined,
      record_type: filter?.type ?? undefined,
      length: "200",
    });
    const records = (data.records ?? []) as DnspodRecord[];
    return (Array.isArray(records) ? records : []).map((r) => ({
      id: String(r.id),
      type: r.type,
      name: r.name === "@" || r.name === zone ? zone : `${r.name}.${zone}`,
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
    // Record.Create 返回 {record: {id, ...}} —— id 在 record 对象里
    const rid = (data.record as { id?: string | number } | undefined)?.id ?? (data as { id?: string | number }).id;
    return { id: String(rid ?? "") };
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

/** FQDN → DNSPod label ("home.example.com", "example.com" → "home"/"@"). */
function labelOf(name: string, zone: string): string {
  const r = name.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  if (r === z) return "@";
  if (r.endsWith(`.${z}`)) return r.slice(0, -(z.length + 1));
  throw new ProviderError(`record '${name}' is not under zone '${zone}'`, "dnspod");
}

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
