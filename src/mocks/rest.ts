/** Generic REST zone-API mock — in-memory implementation driven by a
 *  RestSpec, so every spec'd provider gets a working mock automatically. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { RestSpec } from "../providers/rest.ts";
import { getPath } from "../providers/rest.ts";

export interface RestMockOptions {
  spec: RestSpec;
  /** Credential to accept (matches spec auth type). Default "test-token". */
  cred?: string;
  /** Pre-seed records: {type,name,value,ttl?}. */
  records?: Array<{ type: string; name: string; value: string; ttl?: number }>;
  /** Zone name for zoneIdLookup providers. */
  zone?: string;
  port?: number;
}

export interface RestMockState {
  /** Standard records {id,type,name,value,ttl}. */
  records: Array<{ id: string; type: string; name: string; value: string; ttl?: number }>;
  requests: Array<{ method: string; url: string; body?: unknown }>;
}

export interface RestMockHandle {
  url: string;
  state: RestMockState;
  stop(): Promise<void>;
}

/** Generic mock: routes by the spec's endpoint templates. Works for the
 *  list/create/update/delete shapes in the REST_SPECS registry. */
export async function startRestMock(opts: RestMockOptions): Promise<RestMockHandle> {
  const spec = opts.spec;
  const zone = opts.zone ?? "example.com";
  const state: RestMockState = {
    records: (opts.records ?? []).map((r) => ({ id: randomUUID(), type: r.type, name: r.name, value: r.value, ttl: r.ttl })),
    requests: [],
  };

  /** Locate a record: by captured id, or by (name, type) when the template
   *  carries {name}/{type} (gandi-style composite ids). */
  const findRec = (m: RegExpExecArray): { id: string; type: string; name: string; value: string; ttl?: number } | undefined => {
    const a = m[1];
    const b = m[2];
    const nameMatches = (name: string) => name === a || name.endsWith(`.${a}`) || name === `${a}.${zone}`;
    return state.records.find(
      (r) =>
        r.id === a ||
        // {name}/{type} template order (gandi)
        (b !== undefined && nameMatches(r.name) && r.type === b) ||
        // {type}/{name} template order (godaddy)
        (b !== undefined && r.type === a && (r.name === b || r.name.endsWith(`.${b}`) || r.name === `${b}.${zone}`)),
    );
  };

  /** Expand a standard record into the superset shape every spec.fields
   *  reads (id/type/name + content/data/target/answer/value/rrset_*). */
  const apiShape = (r: { id: string; type: string; name: string; value: string; ttl?: number }): Record<string, unknown> => {
    const [host, ...rest] = r.name.split(".");
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.value,
      data: r.value,
      target: r.value,
      answer: r.value,
      value: r.value,
      ttl: r.ttl ?? 300,
      host: r.name.includes(".") ? host : "",
      rrset_name: host,
      rrset_type: r.type,
      rrset_values: [r.value],
      rrset_ttl: r.ttl ?? 300,
      rrset_domain: rest.join("."),
      domain: rest.join("."),
    };
  };

  /** Extract a standard record from a create/update body (any of the common
   *  field vocabularies; gandi-style name/type come from path captures). */
  const stdRec = (body: unknown, nameFromPath?: string, typeFromPath?: string): { type: string; name: string; value: string; ttl?: number } => {
    const b = Array.isArray(body) ? (body[0] as Record<string, unknown> ?? {}) : (body as Record<string, unknown> ?? {});
    const val = String(b.data ?? b.content ?? b.target ?? b.answer ?? b.value ?? (b.rrset_values as string[])?.[0] ?? "");
    let name = nameFromPath ?? String(b.name ?? b.host ?? "");
    // short names ("home", host-only) are joined with the mock's zone; "@"
    // (root) stays as-is; full fqdns pass through
    if (name && name !== "@" && !name.includes(".")) name = `${name}.${zone}`;
    return {
      type: typeFromPath ?? String(b.type ?? ""),
      name,
      value: val,
      ttl: b.ttl !== undefined ? Number(b.ttl) : b.rrset_ttl !== undefined ? Number(b.rrset_ttl) : undefined,
    };
  };
  const zoneId = randomUUID();

  const authOk = (req: IncomingMessage): boolean => {
    const a = spec.auth;
    const expected = opts.cred ?? "test-token";
    if (a.type === "bearer") return req.headers.authorization === `Bearer ${expected}`;
    if (a.type === "header") return req.headers[(a.header ?? "x-api-key").toLowerCase()] === expected;
    if (a.type === "basic") return req.headers.authorization === `Basic ${Buffer.from(expected).toString("base64")}`;
    return true; // query/body auth — skip in generic mock
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      state.requests.push({ method: req.method ?? "GET", url: url.pathname + url.search, body: parsed });

      if (!authOk(req)) return json(res, 401, { error: "unauthorized" });

      const p = url.pathname;
      const method = req.method ?? "GET";
      const stripQuery = (t: string) => t.split("?")[0]!;
      // regex matcher for path templates with {id}/{name}/{type} placeholders
      const pathRegex = (template: string): RegExp => {
        const esc = template.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        const rx = esc.replace(/\\\{id\\\}/g, "([^/]+)").replace(/\\\{name\\\}/g, "([^/]+)").replace(/\\\{type\\\}/g, "([^/]+)");
        return new RegExp(`^${rx}$`);
      };

      // zone-id lookup endpoint (query-stripped compare)
      if (spec.zoneIdLookup && p === stripQuery(spec.zoneIdLookup.path(zone))) {
        const wrapper = { zones: [{ id: zoneId, name: zone }], items: [{ id: zoneId, name: zone }], data: [{ id: zoneId, domain: zone }] };
        return json(res, 200, wrapper);
      }

      // list (query-stripped compare; empty recordsPath = bare array body)
      if (method === "GET" && p === stripQuery(spec.list.path(zone, zoneId))) {
        const shaped = state.records.map(apiShape);
        if (spec.list.recordsPath.length === 0) return json(res, 200, shaped);
        const wrapped: Record<string, unknown> = {};
        setPath(wrapped, spec.list.recordsPath, shaped);
        if (spec.list.pagesPath) setPath(wrapped, spec.list.pagesPath, shaped);
        return json(res, 200, wrapped);
      }

      // create: matches POST to the collection path, or the create template
      // with {name}/{type} placeholders (gandi-style)
      const createTemplate = spec.create.path(zone, zoneId, { name: "x", type: "A", value: "x" } as never);
      const createMatch = p === stripQuery(spec.list.path(zone, zoneId))
        || pathRegex(createTemplate).test(p);
      if (method === (spec.create.method ?? "POST") && createMatch) {
        const cap = pathRegex(createTemplate).exec(p);
        const std = stdRec(parsed, cap?.[1], cap?.[2]);
        const rec = { id: randomUUID(), type: std.type, name: std.name, value: std.value, ttl: std.ttl };
        state.records.push(rec);
        const shaped = apiShape(rec);
        const wrapped: Record<string, unknown> = { id: rec.id, record: shaped, domain_record: shaped };
        if (spec.create.idPath) setPath(wrapped, spec.create.idPath, rec.id);
        return json(res, 200, wrapped);
      }

      // update / delete: match the spec's path templates against the request
      const updateMatch = pathRegex(spec.update.path(zone, "{id}", zoneId)).exec(p);
      if (method === (spec.update.method ?? "PUT") && updateMatch) {
        const rec = findRec(updateMatch);
        if (!rec) return json(res, 404, { error: "not found" });
        const std = stdRec(parsed);
        if (std.type) rec.type = std.type;
        if (std.name) rec.name = std.name;
        if (std.value) rec.value = std.value;
        if (std.ttl !== undefined) rec.ttl = std.ttl;
        return json(res, 200, apiShape(rec));
      }
      const deleteMatch = pathRegex(spec.delete.path(zone, "{id}", zoneId)).exec(p);
      if (method === (spec.delete.method ?? "DELETE") && deleteMatch) {
        const idx = state.records.findIndex((r) => r.id === findRec(deleteMatch)?.id);
        if (idx < 0) return json(res, 404, { error: "not found" });
        state.records.splice(idx, 1);
        return json(res, 200, { id: deleteMatch[1] });
      }

      return json(res, 404, { error: `unknown endpoint ${method} ${p}` });
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

/** Set a dotted path on an object (creates intermediate objects). */
function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    cur[k] ??= {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

void getPath; // (re-exported helper; kept for API symmetry)
