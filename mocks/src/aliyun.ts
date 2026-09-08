/** aliyun mock — in-memory alidns.aliyuncs.com RPC endpoint. Verifies the
 *  HMAC-SHA1 signature (when a secret is given) exactly like the real API,
 *  so signature bugs surface in tests. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHmac } from "node:crypto";


// ── aliyun 签名链（内联自 ddns core，mock 钉死真实 wire 行为）──
function aliyunPercent(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function aliyunCanonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${aliyunPercent(k)}=${aliyunPercent(v)}`)
    .join("&");
}
function aliyunStringToSign(params: Record<string, string>): string {
  return `GET&%2F&${aliyunPercent(aliyunCanonicalQuery(params))}`;
}
function aliyunSign(accessKeySecret: string, params: Record<string, string>): string {
  return createHmac("sha1", `${accessKeySecret}&`).update(aliyunStringToSign(params)).digest("base64");
}

export interface AliyunMockOptions {
  accessKeyId?: string;
  /** Fixed listen port (default: kernel-assigned free port). */
  port?: number;
  accessKeySecret?: string;
  records?: Array<{ rr: string; type: string; value: string; ttl?: number }>;
  zone: string;
}

export interface AliyunMockState {
  records: Array<{ recordId: string; rr: string; type: string; value: string; ttl: number }>;
  requests: Array<{ action: string; params: URLSearchParams; signatureValid: boolean | null }>;
}

export interface AliyunMockHandle {
  url: string;
  state: AliyunMockState;
  stop(): Promise<void>;
}

export async function startAliyunMock(opts: AliyunMockOptions): Promise<AliyunMockHandle> {
  const keyId = opts.accessKeyId ?? "AKID";
  const keySecret = opts.accessKeySecret;
  const state: AliyunMockState = {
    records: (opts.records ?? []).map((r) => ({ recordId: randomUUID(), ttl: r.ttl ?? 600, ...r })),
    requests: [],
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, code: string, message: string) => json(res, 400, { Code: code, Message: message, RequestId: randomUUID() });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const params = new URLSearchParams(url.search);
    const action = params.get("Action") ?? "";
    const signature = params.get("Signature") ?? "";

    // signature verification (mirrors the real gateway): recompute over the
    // canonical query of every param EXCEPT Signature
    let signatureValid: boolean | null = null;
    if (keySecret && signature) {
      const rest = Object.fromEntries([...params.entries()].filter(([k]) => k !== "Signature"));
      signatureValid = aliyunSign(keySecret, rest) === signature;
      if (!signatureValid) return fail(res, "SignatureDoesNotMatch", "Specified signature is not matched with our calculation.");
    }
    state.requests.push({ action, params, signatureValid });

    switch (action) {
      case "DescribeDomainRecords": {
        const domain = params.get("DomainName") ?? opts.zone;
        if (domain !== opts.zone) return fail(res, "InvalidDomainName.NoExist", "The specified domain name does not exist.");
        const records = state.records.map((r) => ({
          RecordId: r.recordId,
          RR: r.rr,
          Type: r.type,
          Value: r.value,
          TTL: String(r.ttl),
        }));
        return json(res, 200, { RequestId: randomUUID(), TotalCount: records.length, DomainRecords: { Record: records } });
      }
      case "AddDomainRecord": {
        const rec = {
          recordId: randomUUID(),
          rr: params.get("RR") ?? "@",
          type: params.get("Type") ?? "A",
          value: params.get("Value") ?? "",
          ttl: Number(params.get("TTL") ?? 600),
        };
        state.records.push(rec);
        return json(res, 200, { RequestId: randomUUID(), RecordId: rec.recordId });
      }
      case "UpdateDomainRecord": {
        const rec = state.records.find((r) => r.recordId === params.get("RecordId"));
        if (!rec) return fail(res, "RecordNotExist", "The specified record does not exist.");
        rec.rr = params.get("RR") ?? rec.rr;
        rec.type = params.get("Type") ?? rec.type;
        rec.value = params.get("Value") ?? rec.value;
        rec.ttl = Number(params.get("TTL") ?? rec.ttl);
        return json(res, 200, { RequestId: randomUUID(), RecordId: rec.recordId });
      }
      case "DeleteDomainRecord": {
        const idx = state.records.findIndex((r) => r.recordId === params.get("RecordId"));
        if (idx < 0) return fail(res, "RecordNotExist", "The specified record does not exist.");
        state.records.splice(idx, 1);
        return json(res, 200, { RequestId: randomUUID(), RecordId: params.get("RecordId") });
      }
      default:
        return fail(res, "InvalidAction", `Specified action is not supported: ${action}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
