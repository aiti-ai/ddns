/** dnspod mock — in-memory dnsapi.cn (Record.List/Create/Modify/Remove),
 *  form-encoded POST like the real service. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface DnspodMockOptions {
  token?: string;
  /** Fixed listen port (default: kernel-assigned free port). */
  port?: number;
  records?: Array<{ name: string; type: string; value: string; ttl?: number }>;
}

export interface DnspodMockState {
  records: Array<{ id: string; name: string; type: string; value: string; ttl: number; line: string }>;
  requests: Array<{ action: string; params: URLSearchParams }>;
}

export interface DnspodMockHandle {
  url: string;
  state: DnspodMockState;
  stop(): Promise<void>;
}

export async function startDnspodMock(opts: DnspodMockOptions = {}): Promise<DnspodMockHandle> {
  const token = opts.token ?? "1,test-token";
  const state: DnspodMockState = {
    records: (opts.records ?? []).map((r) => ({ id: randomUUID(), line: "默认", ttl: r.ttl ?? 600, ...r })),
    requests: [],
  };

  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ok = (res: ServerResponse, data: unknown = {}) => json(res, { status: { code: "1", message: "Action completed successful" }, data });
  const fail = (res: ServerResponse, code: string, message: string) => json(res, { status: { code, message } });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const action = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
      state.requests.push({ action, params });

      if (params.get("login_token") !== token) return fail(res, "6", "Invalid Token");

      switch (action) {
        case "Domain.Info": {
          // lexicon's dnspod authenticate() calls this first — domain.id is
          // required, status.code must be "1".
          const domain = params.get("domain");
          const exists = state.records.some((r) => r.name.endsWith(`.${domain}`) || r.name === domain);
          if (!exists) return fail(res, "8", "Domain not found");
          return ok(res, { id: randomUUID(), name: domain });
        }
        case "Record.List": {
          const domain = params.get("domain");
          const sub = params.get("sub_domain");
          const type = params.get("record_type");
          let records = state.records;
          if (domain) records = records.filter((r) => r.name.endsWith(`.${domain}`) || r.name === domain);
          if (sub && sub !== "@") records = records.filter((r) => r.name.split(".")[0] === sub);
          if (type) records = records.filter((r) => r.type === type);
          // real DNSPod returns the SHORT label as "name" (not the FQDN)
          const shaped = records.map((r) => ({
            ...r,
            name: r.name === domain ? "@" : r.name.replace(`.${domain}`, ""),
          }));
          return ok(res, { records: shaped });
        }
        case "Record.Create": {
          const domain = params.get("domain") ?? "";
          const sub = params.get("sub_domain") ?? "";
          const owner = sub === "@" ? "" : `${sub}.`;
          const rec = {
            id: randomUUID(),
            name: `${owner}${domain}`,
            type: params.get("record_type") ?? "A",
            value: params.get("value") ?? "",
            ttl: Number(params.get("ttl") ?? 600),
            line: params.get("record_line") ?? "默认",
          };
          state.records.push(rec);
          return ok(res, { id: rec.id });
        }
        case "Record.Modify": {
          const id = params.get("record_id");
          const rec = state.records.find((r) => r.id === id);
          if (!rec) return fail(res, "8", "Record not found");
          rec.type = params.get("record_type") ?? rec.type;
          rec.value = params.get("value") ?? rec.value;
          rec.ttl = Number(params.get("ttl") ?? rec.ttl);
          return ok(res, { id });
        }
        case "Record.Remove": {
          const id = params.get("record_id");
          const idx = state.records.findIndex((r) => r.id === id);
          if (idx < 0) return fail(res, "8", "Record not found");
          state.records.splice(idx, 1);
          return ok(res, { id });
        }
        default:
          return fail(res, "15", `Unknown action ${action}`);
      }
    });
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
