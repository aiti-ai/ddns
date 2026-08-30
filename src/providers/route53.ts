/** route53 — AWS Signature V4 + XML API (Go ddns-updater's route53:
 *  GET/POST https://route53.amazonaws.com/2013-04-01/hostedzone/:id/rrset,
 *  ChangeResourceRecordSets with <ChangeBatch> XML body). */

import { createHmac, createHash } from "node:crypto";
import type { DnsRecord, FetchLike, ListFilter, ProviderConfig, ZoneProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

const OFFICIAL = "https://route53.amazonaws.com/2013-04-01";

/* ------------------------- AWS SigV4 (route53) -------------------------- */

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Build the SigV4 Authorization header for a route53 request. */
export function awsSigV4(opts: {
  method: string;
  host: string;
  path: string;
  query?: string;
  body: string;
  accessKeyId: string;
  secretKey: string;
  now?: Date;
}): { authorization: string; amzDate: string; amzContentSha256: string } {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(opts.body);
  const canonicalQuery = opts.query ?? "";
  const canonicalHeaders = `host:${opts.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    opts.method,
    opts.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/us-east-1/route53/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${opts.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, "us-east-1");
  const kService = hmac(kRegion, "route53");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    amzContentSha256: payloadHash,
  };
}

/* ------------------------------ provider -------------------------------- */

interface R53Record {
  id: string;
  type: string;
  name: string;
  value: string;
  ttl?: number;
}

export class Route53Provider implements ZoneProvider {
  readonly meta = { name: "route53", style: "zone", recordTypes: ["A", "AAAA", "CNAME", "TXT", "MX"], needsZone: true, authFields: ["token (AccessKeyId)", "secret (SecretAccessKey)"] } as const;
  readonly #accessKey: string;
  readonly #secretKey: string;
  readonly #zoneId: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: { accessKeyId: string; secretAccessKey: string; zoneId: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (!opts.accessKeyId || !opts.secretAccessKey || !opts.zoneId) {
      throw new ProviderError("route53 requires accessKeyId + secretAccessKey + zoneId", "route53");
    }
    this.#accessKey = opts.accessKeyId;
    this.#secretKey = opts.secretAccessKey;
    this.#zoneId = opts.zoneId;
    this.#base = opts.baseUrl ?? OFFICIAL;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  #xmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  #changeXml(records: Array<{ action: "CREATE" | "UPSERT" | "DELETE"; name: string; type: string; value: string; ttl: number }>): string {
    const changes = records
      .map(
        (r) =>
          `<Change><Action>${r.action}</Action><ResourceRecordSet><Name>${this.#xmlEscape(r.name)}</Name><Type>${r.type}</Type><TTL>${r.ttl}</TTL><ResourceRecords><ResourceRecord><Value>${this.#xmlEscape(r.value)}</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></Change>`,
      )
      .join("");
    return `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes>${changes}</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
  }

  async #api(method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
    const url = new URL(`${this.#base}${path}`);
    const sig = awsSigV4({
      method,
      host: url.host,
      path: url.pathname,
      query: url.search.slice(1),
      body: body ?? "",
      accessKeyId: this.#accessKey,
      secretKey: this.#secretKey,
    });
    const res = await this.#fetch(url.toString(), {
      method,
      headers: {
        authorization: sig.authorization,
        "x-amz-date": sig.amzDate,
        "x-amz-content-sha256": sig.amzContentSha256,
        ...(body ? { "content-type": "text/xml" } : {}),
      },
      body,
    });
    const text = await res.text();
    if (!res.ok && !(method === "GET" && res.status === 404)) {
      throw new ProviderError(`route53 API error HTTP ${res.status}: ${text.slice(0, 160)}`, "route53", res.status);
    }
    return { status: res.status, text };
  }

  /** Minimal XML list parse (Name/Type/TTL/Value elements). */
  #parseRrsets(xml: string): R53Record[] {
    const out: R53Record[] = [];
    const rrsetRe = /<ResourceRecordSet>(.*?)<\/ResourceRecordSet>/gs;
    for (const m of xml.matchAll(rrsetRe)) {
      const block = m[1] ?? "";
      const name = /<Name>([^<]*)<\/Name>/.exec(block)?.[1] ?? "";
      const type = /<Type>([^<]*)<\/Type>/.exec(block)?.[1] ?? "";
      const ttl = /<TTL>([^<]*)<\/TTL>/.exec(block)?.[1];
      const value = /<Value>([^<]*)<\/Value>/.exec(block)?.[1] ?? "";
      if (name && type) out.push({ id: `${name}/${type}`, type, name, value, ttl: ttl ? Number(ttl) : undefined });
    }
    return out;
  }

  async listRecords(zone: string, filter?: ListFilter): Promise<DnsRecord[]> {
    const { text } = await this.#api("GET", `/hostedzone/${this.#zoneId}/rrset`);
    let out = this.#parseRrsets(text);
    if (filter?.type) out = out.filter((r) => r.type === filter.type);
    if (filter?.name) out = out.filter((r) => r.name === filter.name);
    return out;
  }

  async createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }> {
    const name = rec.name.endsWith(".") ? rec.name : `${rec.name}.`;
    await this.#api("POST", `/hostedzone/${this.#zoneId}/rrset`, this.#changeXml([{ action: "CREATE", name, type: rec.type, value: rec.value, ttl: rec.ttl ?? 300 }]));
    return { id: `${name}/${rec.type}` };
  }

  async updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void> {
    const name = rec.name.endsWith(".") ? rec.name : `${rec.name}.`;
    // UPSERT replaces the rrset
    await this.#api("POST", `/hostedzone/${this.#zoneId}/rrset`, this.#changeXml([{ action: "UPSERT", name, type: rec.type, value: rec.value, ttl: rec.ttl ?? 300 }]));
  }

  async deleteRecord(zone: string, id: string): Promise<void> {
    const [name, type] = id.split("/");
    const fqdn = name ?? "";
    if (!type) return; // nothing to delete without a type
    await this.#api("POST", `/hostedzone/${this.#zoneId}/rrset`, this.#changeXml([{ action: "DELETE", name: fqdn, type, value: "", ttl: 300 }]));
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

export function createRoute53(cfg: ProviderConfig): Route53Provider {
  const accessKey = cfg.accessKeyId ?? process.env.DDNS_ROUTE53_ACCESS_KEY_ID ?? "";
  const secret = cfg.secret ?? process.env.DDNS_ROUTE53_SECRET_ACCESS_KEY ?? "";
  const zoneId = cfg.zoneId ?? "";
  return new Route53Provider({ accessKeyId: accessKey, secretAccessKey: secret, zoneId, baseUrl: cfg.baseUrl });
}
