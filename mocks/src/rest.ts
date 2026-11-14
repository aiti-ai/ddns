/** Generic REST zone-API mock — in-memory implementation driven by a
 *  RestSpec, so every spec'd provider gets a working mock automatically. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { RestSpec } from "@aiti-ai/ddns";

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
        // single {id} capture may address the record by name (zonomi)
        (b === undefined && nameMatches(r.name)) ||
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
      rrdata: r.value,
      record: r.value, // cloudns-style string record
      rdata: r.value,
      records: [r.value], // flexibleengine recordsets style
      answers: [{ answer: [r.value] }], // nsone rr-set style
      // nested record object (pointhq style)
      record_details: { id: r.id, record_type: r.type, name: r.name, data: r.value, ttl: r.ttl ?? 300 },
      // sakuracloud deep nesting
      CommonServiceItem: { Settings: { DNS: { ResourceRecordSets: [{ Name: r.name, Type: r.type, RData: r.value, TTL: r.ttl ?? 300 }] } } },
    };
  };

  /** Extract a standard record from a create/update body (any of the common
   *  field vocabularies; gandi-style name/type come from path captures). */
  const stdRec = (body: unknown, nameFromPath?: string, typeFromPath?: string): { type: string; name: string; value: string; ttl?: number } => {
    let b = (Array.isArray(body) ? (body[0] as Record<string, unknown> ?? {}) : (body as Record<string, unknown> ?? {})) as Record<string, unknown>;
    // sakuracloud nested CommonServiceItem.Settings.DNS.ResourceRecordSets
    const nested = (b.CommonServiceItem as Record<string, unknown> | undefined)
      ?.Settings as Record<string, unknown> | undefined;
    const saku = ((nested?.DNS as Record<string, unknown> | undefined)?.ResourceRecordSets as Record<string, unknown>[] | undefined)?.[0];
    if (saku) b = saku;
    // b.record may be a string (cloudns) or a nested object (pointhq)
    const recField = typeof b.record === "string" ? b.record : (b.record as Record<string, unknown> | undefined)?.data;
    // onapp nests the record under dns_record
    const dnsRec = b.dns_record as Record<string, unknown> | undefined;
    if (dnsRec) b = dnsRec;
    const nsoneAnswer = (b.answers as Array<{ answer?: string[] }> | undefined)?.[0]?.answer?.[0];
    const val = String(
      b.data ?? b.content ?? b.target ?? b.answer ?? b.value ?? b.Value ?? b.RData ??
      nsoneAnswer ?? recField ?? (b.records as string[])?.[0] ?? (b.rrset_values as string[])?.[0] ?? "",
    );
    let name = nameFromPath ?? String(b.name ?? b.host ?? b.Name ?? b.domain ?? (b.record as Record<string, unknown> | undefined)?.name ?? "");
    // short names ("home", host-only) are joined with the mock's zone; "@"
    // (root) stays as-is; full fqdns pass through
    if (name && name !== "@" && !name.includes(".")) name = `${name}.${zone}`;
    const recType = typeof b.record === "string" ? undefined : (b.record as Record<string, unknown> | undefined)?.record_type;
    return {
      type: typeFromPath ?? String(b.type ?? b.record_type ?? b.Type ?? recType ?? ""),
      name,
      value: val,
      ttl: b.ttl !== undefined ? Number(b.ttl) : b.TTL !== undefined ? Number(b.TTL) : b.rrset_ttl !== undefined ? Number(b.rrset_ttl) : undefined,
    };
  };
  const zoneId = randomUUID();

  const authOk = (req: IncomingMessage): boolean => {
    const a = spec.auth;
    const expected = opts.cred ?? "test-token";
    if (a.type === "bearer") return req.headers.authorization === `Bearer ${expected}`;
    if (a.type === "header") {
      const want = a.headerValue ? a.headerValue({ provider: spec.name, token: opts.cred, secret: opts.cred } as never) : `${a.headerPrefix ?? ""}${expected}`;
      return req.headers[(a.header ?? "x-api-key").toLowerCase()] === want;
    }
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
      const fullPath = url.pathname + url.search;
      const method = req.method ?? "GET";
      const stripQuery = (t: string) => t.split("?")[0]!;
      // regex matcher for path templates with {id}/{name}/{type} placeholders
      const pathRegex = (template: string): RegExp => {
        const esc = template.replace(/[.+^${}()|[\]?&\\]/g, "\\$&");
        const rx = esc.replace(/\\\{id\\\}/g, "([^/]+)").replace(/\\\{name\\\}/g, "([^/]+)").replace(/\\\{type\\\}/g, "([^/]+)");
        return new RegExp(`^${rx}$`);
      };
      // match against pathname only (query dropped) — for templates carrying ?query
      const querylessPathRegex = (template: string): RegExp => pathRegex(template.split("?")[0] ?? template);
      // full-path match where {id} stops at ? or & (query-carrying templates);
      // the tail is left open: providers may append auth query params
      const queryTplRegex = (template: string): RegExp => {
        const esc = template.replace(/[.+^${}()|[\]?&\\]/g, "\\$&");
        const rx = esc
          .replace(/\\\{id\\\}/g, "([^?&/]+)")
          .replace(/\\\{name\\\}/g, "([^?&/]+)")
          .replace(/\\\{type\\\}/g, "([^?&/]+)");
        return new RegExp(`^${rx}(?:&.*)?$`);
      };

      // pre-lookups (dnsimple account etc.) — return a fake id array shape
      for (const pl of spec.preLookups ?? []) {
        if (p === stripQuery(pl.path())) {
          return json(res, 200, [{ id: "acct1" }, { data: [{ id: "acct1" }] }]);
        }
      }

      // zone-id lookup endpoint (query-stripped compare) — superset shape:
      // zones[] / items[] / data[] / response.records[] all carry the id
      if (spec.zoneIdLookup && p === stripQuery(spec.zoneIdLookup.path(zone))) {
        const wrapper = {
          zones: [{ id: zoneId, name: zone }],
          items: [{ id: zoneId, name: zone }],
          data: [{ id: zoneId, domain: zone }],
          response: { records: [{ id: zoneId, domainname: zone }] },
        };
        // idPath "data.domain.id" style (arvancloud): serve the object form
        if (spec.zoneIdLookup.idPath.includes("domain.")) {
          return json(res, 200, { data: { domain: { id: zoneId, name: zone } } });
        }
        // top-level array form (onapp-style idPath "0.id")
        const arr = [{ id: zoneId, name: zone, domain: zone }];
        return json(res, 200, spec.zoneIdLookup.idPath === "0.id" ? arr : wrapper);
      }

      // list (query-stripped compare; empty recordsPath = bare array body)
      const listTpl = spec.list.path(zone, zoneId, "acct1");
      const listMethod = spec.list.method ?? "GET";
      if (method === listMethod && (p === stripQuery(spec.list.path(zone, zoneId)) || p === stripQuery(listTpl))) {
        const shaped = state.records.map(apiShape);
        if (spec.list.recordsPath.length === 0) return json(res, 200, shaped);
        const wrapped: Record<string, unknown> = {};
        setPath(wrapped, spec.list.recordsPath, shaped);
        if (spec.list.pagesPath) setPath(wrapped, spec.list.pagesPath, shaped);
        return json(res, 200, wrapped);
      }

      // create: matches POST to the collection path, or the create template
      // with {name}/{type} placeholders (gandi-style)
      const createTemplate = spec.create.path(zone, zoneId, { name: "x", type: "A", value: "x" } as never, "acct1");
      // nsone-style create paths embed the record TYPE as a real segment
      // (`/zones/:z/{name}/:type`) — dummy-expanded template fixes the type,
      // so also match with the type segment wildcarded. Only meaningful when the
      // create template is a PURE path (no query string) — otherwise the replace
      // would strip the query and produce a bare `/path/{type}` that falsely
      // matches unrelated endpoints (e.g. zonomi's `/dns/delete.jsp`).
      const createTypeFlex = createTemplate.includes("?")
        ? ""
        : createTemplate.replace(/\/[^/]+\/?$/, "/{type}");
      const createMatch = p === stripQuery(spec.list.path(zone, zoneId))
        || p === stripQuery(spec.create.path(zone, zoneId, { name: "x", type: "A", value: "x" } as never))
        || p === stripQuery(createTemplate)
        || pathRegex(createTemplate).test(p)
        || (createTypeFlex ? pathRegex(createTypeFlex).test(p) : false);
      if (method === (spec.create.method ?? "POST") && createMatch) {
        const cap = pathRegex(createTemplate).exec(p);
        const std = stdRec(parsed, cap?.[1], cap?.[2]);
        // idempotent SET-style APIs (zonomi modify.jsp): update in place when
        // a record with the same name/type already exists
        const existing = std.name
          ? state.records.find((r) => r.name === std.name && r.type === std.type)
          : undefined;
        const rec = existing ?? { id: spec.idFromName ? std.name || randomUUID() : randomUUID(), type: std.type, name: std.name, value: std.value, ttl: std.ttl };
        if (existing) {
          rec.value = std.value;
          if (std.ttl !== undefined) rec.ttl = std.ttl;
        } else {
          state.records.push(rec);
        }
        const shaped = apiShape(rec);
        const wrapped: Record<string, unknown> = { id: rec.id, record: shaped, domain_record: shaped };
        if (spec.create.idPath) setPath(wrapped, spec.create.idPath, rec.id);
        return json(res, 200, wrapped);
      }

      // update / delete: match the spec's path templates against the request
      const updateTpl = spec.update.path(zone, "{id}", zoneId, "acct1");
      // pathname match first (query-carrying templates use queryless form);
      // fullPath only when the template itself contains a query we must see
      // (there {id} must not eat ? or &)
      const qlMatch = querylessPathRegex(updateTpl).exec(p);
      const qtMatch = updateTpl.includes("?") ? queryTplRegex(updateTpl).exec(fullPath) : null;
      // id-less templates (zonomi modify.jsp): match by body name/type
      const bodyMatch = (qlMatch && qlMatch[1] === undefined && !qtMatch)
        ? { 1: stdRec(parsed).name } as unknown as RegExpExecArray
        : null;
      const updateMatch = (qlMatch && qlMatch[1] !== undefined ? qlMatch : null)
        ?? qtMatch
        ?? bodyMatch;
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
      const deleteTpl = spec.delete.path(zone, "{id}", zoneId, "acct1");
      const dqMatch = querylessPathRegex(deleteTpl).exec(p);
      const deleteMatch = (dqMatch && dqMatch[1] !== undefined ? dqMatch : null)
        ?? (deleteTpl.includes("?") ? queryTplRegex(deleteTpl).exec(fullPath) : null)
        ?? (method === (spec.delete.method ?? "DELETE") && dqMatch ? { 1: stdRec(parsed).name } as unknown as RegExpExecArray : null);
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

