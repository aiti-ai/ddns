/** cloudflare mock — an in-memory implementation of the Cloudflare REST v4
 *  DNS API, so the real provider can be exercised end-to-end with no network
 *  (mirrors ddns-updater/lexicon tests, which stub the same endpoints). */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface CloudflareMockOptions {
  /** Token the mock accepts in Authorization: Bearer. Default "test-token". */
  token?: string;
  /** Fixed listen port (default: kernel-assigned free port). */
  port?: number;
  /** Pre-seeded zones: name → records. */
  zones?: Record<string, Array<{ type: string; name: string; content: string; ttl?: number; proxied?: boolean }>>;
}

export interface CloudflareMockState {
  zones: Map<string, { id: string; records: Array<Record<string, unknown>> }>;
  /** Every request the mock served (method, url, body). */
  requests: Array<{ method: string; url: string; body?: unknown }>;
}

export interface CloudflareMockHandle {
  /** Base URL to inject into the provider (cfg.baseUrl). */
  url: string;
  state: CloudflareMockState;
  /** Wait until the mock is listening. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export async function startCloudflareMock(opts: CloudflareMockOptions = {}): Promise<CloudflareMockHandle> {
  const token = opts.token ?? "test-token";
  const state: CloudflareMockState = { zones: new Map(), requests: [] };

  for (const [name, records] of Object.entries(opts.zones ?? {})) {
    state.zones.set(name, {
      id: randomUUID(),
      records: records.map((r) => ({ id: randomUUID(), ...r })),
    });
  }

  const authOk = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: number, message: string) =>
    json(res, status, { success: false, errors: [{ code, message }] });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Real Cloudflare API paths are /client/v4/zones... — the mock serves at
    // <baseUrl>/client/v4 (provider baseUrl = API root), so strip the prefix.
    const pathname = url.pathname.replace(/^\/client\/v4/, "") || "/";
    const parts = pathname.split("/").filter(Boolean); // zones, :id, dns_records, :rid
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      state.requests.push({ method: req.method ?? "GET", url: url.pathname + url.search, body: parsed });

      if (!authOk(req)) return fail(res, 403, 9109, "Invalid Token");

      // GET /zones?name=  — result_info is required by lexicon's
      // authenticate() (it paginates on result_info.total_pages).
      if (parts[0] === "zones" && parts.length === 1 && req.method === "GET") {
        const name = url.searchParams.get("name");
        const zones = [...state.zones.entries()]
          .filter(([n]) => !name || n === name)
          .map(([n, z]) => ({ id: z.id, name: n }));
        return json(res, 200, {
          success: true,
          result: zones,
          result_info: { page: 1, per_page: 100, count: zones.length, total_count: zones.length, total_pages: 1 },
        });
      }
      // GET /zones/:id/dns_records[?type&name]
      if (parts[0] === "zones" && parts[2] === "dns_records" && parts.length === 3 && req.method === "GET") {
        const zone = [...state.zones.values()].find((z) => z.id === parts[1]);
        if (!zone) return fail(res, 404, 6003, "Zone not found");
        let records = zone.records;
        const type = url.searchParams.get("type");
        const name = url.searchParams.get("name");
        if (type) records = records.filter((r) => r.type === type);
        if (name) records = records.filter((r) => r.name === name);
        return json(res, 200, { success: true, result: records });
      }
      // POST /zones/:id/dns_records
      if (parts[0] === "zones" && parts[2] === "dns_records" && parts.length === 3 && req.method === "POST") {
        const zone = [...state.zones.values()].find((z) => z.id === parts[1]);
        if (!zone) return fail(res, 404, 6003, "Zone not found");
        const rec = { id: randomUUID(), ...(parsed as object) };
        zone.records.push(rec);
        return json(res, 200, { success: true, result: rec });
      }
      // PUT /zones/:id/dns_records/:rid
      if (parts[0] === "zones" && parts[2] === "dns_records" && parts.length === 4 && req.method === "PUT") {
        const zone = [...state.zones.values()].find((z) => z.id === parts[1]);
        const rec = zone?.records.find((r) => r.id === parts[3]);
        if (!zone || !rec) return fail(res, 404, 81044, "Record not found");
        Object.assign(rec, parsed);
        return json(res, 200, { success: true, result: rec });
      }
      // DELETE /zones/:id/dns_records/:rid
      if (parts[0] === "zones" && parts[2] === "dns_records" && parts.length === 4 && req.method === "DELETE") {
        const zone = [...state.zones.values()].find((z) => z.id === parts[1]);
        const idx = zone?.records.findIndex((r) => r.id === parts[3]) ?? -1;
        if (!zone || idx < 0) return fail(res, 404, 81044, "Record not found");
        zone.records.splice(idx, 1);
        return json(res, 200, { success: true, result: { id: parts[3] } });
      }
      return fail(res, 404, 7000, `Unknown endpoint ${url.pathname}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/client/v4`,
    state,
    ready: Promise.resolve(),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
