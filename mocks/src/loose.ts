/** Loose zone REST mock — one shared mock for the hand-written providers
 *  whose CRUD follows the common zone-REST pattern (GET list, POST create,
 *  PUT update, DELETE by id) with varying paths/auth. It answers ANY path:
 *
 *    GET    → returns stored records (superset apiShape — every fields
 *             mapping in rest-specs can read name/content/data/…)
 *    POST   → creates a record (parses name/value/type from any common
 *             body field via stdRec: name/host/domain, data/content/value)
 *    PUT    → updates by trailing id segment
 *    DELETE → removes by trailing id segment
 *
 *  Auth is checked per kind: bearer / basic / none / token-in-body.
 *  This is what makes every hand-written provider verifiable through
 *  verify-all.mjs (ours + lexicon over HTTPS_PROXY).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface LooseMockOptions {
  /** Provider name for response-shape adaptation. */
  provider?: string;
  /** Authentication the mock enforces. Default "bearer". */
  auth?: "bearer" | "basic" | "none";
  /** Credential to accept. Default "test-token"; basic = "user:pass". */
  cred?: string;
  /** Pre-seeded records ({type,name,value,ttl}). */
  records?: Array<{ type: string; name: string; value: string; ttl?: number }>;
  /** Extra auth key the provider must include (e.g. custom header). */
  header?: { key: string; value: string };
  port?: number;
}

export interface LooseMockState {
  records: Array<{ id: string; type: string; name: string; value: string; ttl?: number }>;
  requests: Array<{ method: string; url: string; body?: unknown }>;
}

export interface LooseMockHandle {
  url: string;
  state: LooseMockState;
  stop(): Promise<void>;
}

const defaultFetchLike = null;

export async function startLooseZoneMock(opts: LooseMockOptions = {}): Promise<LooseMockHandle> {
  const auth = opts.auth ?? "bearer";
  const cred = opts.cred ?? "test-token";
  const state: LooseMockState = {
    records: (opts.records ?? []).map((r) => ({ id: randomUUID(), ...r })),
    requests: [],
  };

  const authOk = (req: IncomingMessage): boolean => {
    if (opts.header) {
      const h = req.headers[opts.header.key.toLowerCase()];
      if (h !== opts.header.value) return false;
    }
    if (auth === "none") return true;
    if (auth === "basic") return req.headers.authorization === `Basic ${Buffer.from(cred).toString("base64")}`;
    return req.headers.authorization === `Bearer ${cred}`;
  };

  const apiShape = (r: { id: string; type: string; name: string; value: string; ttl?: number }): Record<string, unknown> => {
    const [host, ...rest] = r.name.split(".");
    return {
      id: r.id, type: r.type, name: r.name, content: r.value, data: r.value,
      value: r.value, target: r.value, answer: r.value, ttl: r.ttl ?? 300,
      host: r.name.includes(".") ? host : "", domain: rest.join("."),
      rrset_name: host, rrset_type: r.type, rrset_values: [r.value],
      record_details: { id: r.id, record_type: r.type, name: r.name, data: r.value, ttl: r.ttl ?? 300 },
      answers: [{ answer: [r.value] }], records: [r.value],
    };
  };

  const stdRec = (body: unknown): { type: string; name: string; value: string; ttl?: number } => {
    let parsed = body;
    if (typeof body === "string") {
      try { parsed = JSON.parse(body); } catch { parsed = Object.fromEntries(new URLSearchParams(body)); }
    }
    const b = (Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>) : parsed) as Record<string, unknown>;
    const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
    const additions = (b.additions as Array<Record<string, unknown>> | undefined)?.[0];
    // Only treat record/dns_record/data/additions as a NESTED record object when
    // it is actually an object — some providers (nfsn, gcp rrdatas) use `data`/
    // `value` as a plain scalar string, which must NOT be unwrapped.
    const nested = isObj(b.record) ? b.record : isObj(b.dns_record) ? b.dns_record : isObj(b.data) ? b.data : isObj(additions) ? additions : undefined;
    const src = nested ?? b;
    return {
      type: String(src.type ?? src.record_type ?? src.rrtype ?? src.rtype ?? src.rdtype ?? src.Type ?? src.RecordType ?? ""),
      name: String(src.name ?? src.host ?? src.hostname ?? src.domain ?? src.fqdn ?? src.Name ?? src.SubDomain ?? ""),
      value: String(src.content ?? src.data ?? src.value ?? src.destination ?? src.target ?? src.answer ?? src.rdata ?? src.Value ?? src.ipv4addr ?? ((src.answers as Array<{ answer?: string[] }> | undefined)?.[0]?.answer?.[0]) ?? ""),
      ttl: src.ttl !== undefined ? Number(src.ttl) : src.TTL !== undefined ? Number(src.TTL) : undefined,
    };
  };

  // Per-provider response-shape adaptation (the loose mock serves records,
  // but each hand-written provider expects its own envelope/fields).
  const formatFor = (p: string | undefined, method: string, urlPath: string, out: unknown): [number, unknown] => {
    const isCreate = method === "POST" || (method === "PUT" && !urlPath.split("/").filter(Boolean).length);
    const recs = (out as { records?: unknown[] }).records ?? [];
    const short = (r: unknown) => {
      const rr = r as { name?: string; value?: string; type?: string; id?: string; ttl?: number };
      const host = (rr.name ?? "").split(".")[0];
      return { ...rr, record: rr.name, host, record_id: rr.id, value: rr.value, data: rr.value, rrhost: host };
    };
    switch (p) {
      case "dreamhost":
        return [200, { result: "success", data: method === "GET" ? recs.map(short) : undefined }];
      case "namesilo":
        return [200, { reply: { code: 300, detail: "success", resource_records: method === "GET" ? recs.map(short) : undefined } }];
      case "netcup":
        return [200, { status: "success", responsedata: method === "GET" ? { dnsrecords: recs ?? [] } : { dnsrecords: [{ id: "r1" }] } }];
      case "dondominio":
        return [200, { success: true }];
      case "dnsmadeeasy":
        return [200, { id: "z1", data: recs ?? [] }];
      case "constellix":
        // domain lookup first (GET /domains/), then records list
        if (urlPath === "/domains/" || urlPath === "/domains") return [200, { data: [{ id: "c1", name: "example.com" }] }];
        return [200, { data: recs.map((r) => ({ id: (r as { id?: string }).id, name: (r as { name?: string }).name, type: (r as { type?: string }).type, ttl: (r as { ttl?: number }).ttl ?? 300, roundRobin: [{ disableFlag: false, value: (r as { value?: string }).value }] })) }];
      case "ultradns":
        return [200, { zones: [{ id: "z1", name: "example.com" }] }];
      case "aurora":
        if (urlPath === "/zones") return [200, [{ id: "z1", name: "example.com" }]];
        return [200, recs ?? []];
      case "softlayer":
        if (urlPath.includes("getResourceRecords")) return [200, recs ?? []];
        return [200, { data: recs ?? [] }];
      case "transip":
        return [200, { dnsEntries: recs.map((r) => { const rr = r as { name?: string; type?: string }; return { ...rr, id: `${rr.name ?? ""}/${rr.type ?? ""}` }; }) }];
      case "hostingde":
      case "httpnet":
        // recordsFind/api returns {status, data:{records}}; always expose records
        return [200, { status: "success", data: { records: recs ?? [] } }];
      case "valuedomain":
        // GET /domains/{z}/dns → {results:[...]}
        return [200, { results: recs ?? [] }];
      case "cloudxns":
        if (urlPath === "/domain") return [200, { code: 1, data: [{ id: "d1", domain: "example.com." }] }];
        if (urlPath.startsWith("/record/")) return [200, { code: 1, data: recs.map((r) => { const rr = r as { id?: string; name?: string }; return { ...rr, record_id: rr.id, host: rr.name }; }) }];
        return [200, { code: 0, data: {} }];
      case "yandex":
        // POST add/edit/del return {success:"ok", record_id}; GET list returns records
        return [200, { success: "ok", records: method === "GET" ? recs.map((r) => { const rr = r as { id?: string; name?: string; value?: string; type?: string; ttl?: number }; return { record_id: rr.id, fqdn: rr.name, content: rr.value, type: rr.type, ttl: rr.ttl }; }) : [], record_id: method === "POST" ? "1" : undefined }];
      case "he":
      case "henet":
        // dyndns2 push — the spec expects a plain-text "good"/"nochg" line
        return [200, "good 1.2.3.4"];
      case "dnsservices":
        if (urlPath === "/dns") return [200, { zones: [{ name: "example.com", domain_id: "d1", service_id: "s1" }] }];
        if (urlPath.startsWith("/service/")) return [200, { records: recs ?? [] }];
        return [200, { records: recs ?? [] }];
      case "spaceship":
        return [200, { records: recs ?? [] }];
      case "gcp":
      case "googleclouddns":
        return [200, { rrsets: (recs ?? []).map((r) => ({ name: (r as { name?: string }).name + ".", type: (r as { type?: string }).type, ttl: (r as { ttl?: number }).ttl ?? 300, rrdatas: [(r as { value?: string }).value ?? ""] })) }];
      case "rcodezero":
      case "devnomads":
      case "misaka":
        // these return {rrsets} or {recordsets} with nested records[{content}]
        return [200, (p === "misaka" ? { recordsets: (recs ?? []).map((r) => { const rr = r as { name?: string; type?: string; value?: string; ttl?: number }; return { name: rr.name, type: rr.type, ttl: rr.ttl ?? 300, records: [{ content: rr.value, disabled: false }] }; }) } : { rrsets: (recs ?? []).map((r) => { const rr = r as { name?: string; type?: string; value?: string; ttl?: number }; return { name: rr.name + ".", type: rr.type, ttl: rr.ttl ?? 300, records: [{ content: rr.value, disabled: false }] }; }) })];
      case "namecheap":
        return method === "GET" ? [200, "nochg 1.2.3.4"] : [200, "good 1.2.3.4"];
      default:
        return [200, out];
    }
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const urlPath = url.pathname;
      let reqBody: unknown = undefined;
      if (body) { try { reqBody = JSON.parse(body); } catch { reqBody = body; } }
      state.requests.push({ method: req.method ?? "GET", url: url.pathname + url.search, body: reqBody });
      if (!authOk(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify(auth === "basic" ? { error: "unauthorized" } : { success: false, errors: [{ code: 9109, message: "Invalid Token" }] }));
        return;
      }
      const method = req.method ?? "GET";
      const segments = url.pathname.split("/").filter(Boolean);
      const trailing = segments.at(-1) ?? "";
      const json = (code: number, out: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      };

      // Zone-lookup dispatch: providers that first resolve the zone id.
      // GET on their lookup endpoint returns a provider-specific envelope.
      if (method === "GET") {
        const z = "example.com";
        // hover: GET /signin → set-cookie hover_session (then auth.json)
        if (opts.provider === "hover" && urlPath === "/signin") {
          res.writeHead(200, { "content-type": "text/html", "set-cookie": "hover_session=mock-sess; Path=/; HttpOnly" });
          res.end("<html><body>ok</body></html>");
          return;
        }
        if (opts.provider === "hover" && urlPath.startsWith("/control_panel/dns")) {
          return json(200, { domain: { dns: state.records.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.value, ttl: r.ttl ?? 300 })) } });
        }
        // euserv: GET /index.php?subaction=... → HTML state machine (login → choose → dns)
        if (opts.provider === "euserv" && urlPath === "/index.php") {
          const q = Object.fromEntries(url.searchParams);
          const subaction = String(q.subaction ?? "");
          if (subaction === "login") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><table><tr><td>ord_no=123</td></tr></table></body></html>"); return; }
          if (subaction === "choose_order") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>choose</body></html>"); return; }
          if (subaction === "kc2_domain_dns_get_records") {
            const rows = state.records.map((r) => `<tr><td>${r.name}</td><td>${r.type}</td><td>${r.value}</td></tr>`).join("");
            res.writeHead(200, { "content-type": "text/html" }); res.end(`<html><body><table>${rows}</table></body></html>`); return;
          }
          if (subaction === "kc2_domain_dns_set") {
            const action = String(q.dns_action ?? "");
            if (action === "new") { state.records.push({ id: String(state.records.length + 1), type: String(q.dns_type ?? ""), name: String(q.dns_name ?? ""), value: String(q.dns_content ?? ""), ttl: undefined }); }
            if (action === "del") { const id = String(q.dns_id ?? ""); state.records = state.records.filter((r) => r.id !== id); }
            if (action === "mod") { const ex = state.records.find((r) => r.id === String(q.dns_id ?? "")); if (ex) { if (q.dns_content) ex.value = String(q.dns_content); } }
            res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>ok</body></html>"); return;
          }
          res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>ok</body></html>"); return;
        }
        // easyname: GET /en/login → CSRF-TOKEN cookie; GET dns index → HTML table
        if (opts.provider === "easyname" && urlPath === "/en/login") {
          res.writeHead(200, { "content-type": "text/html", "set-cookie": "CSRF-TOKEN=mock-csrf; Path=/; SameSite=Lax" });
          res.end("<html><body>login</body></html>");
          return;
        }
        if (opts.provider === "easyname" && urlPath.includes("/en/domain/dns/index/")) {
          const rows = state.records.map((r) => `<tr data-id="${r.id}"><td>${r.name}</td><td>${r.type}</td><td>${r.value}</td></tr>`).join("");
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<html><body><table>${rows}</table></body></html>`);
          return;
        }
        if (opts.provider === "qcloud" && urlPath === "/") {
          try {
            const q = Object.fromEntries(url.searchParams);
            if (q.Action === "DescribeDomainList") return json(200, { Response: { DomainList: [{ DomainId: 1 }] } });
            if (q.Action === "DescribeRecordList") return json(200, { Response: { RecordList: state.records.map((r) => ({ RecordId: r.id, Type: r.type, Name: r.name.split(".")[0], Value: r.value, TTL: r.ttl ?? 600 })) } });
            if (q.Action === "CreateRecord") return json(200, { Response: { RecordId: 9 } });
            if (q.Action === "ModifyRecord" || q.Action === "DeleteRecord") return json(200, { Response: {} });
          } catch { /* fallthrough */ }
        }
        if (opts.provider === "yandexcloud" && urlPath === "/zones") return json(200, { zones: [{ id: "z1" }] });
        if (opts.provider === "yandexcloud" && urlPath.includes(":listRecordSets")) return json(200, { recordSets: state.records.map((r) => ({ id: r.id, fqdn: r.name.endsWith(".") ? r.name : r.name + ".", type: r.type, ttl: r.ttl ?? 300, data: [r.value] })) });
        // ultradns: GET /zones/{zone}./rrsets → {rrsets:[{ownerName,rrtype,rdata,ttl}]}
        if (opts.provider === "ultradns" && urlPath.includes("/rrsets") && !/\/rrsets\//.test(urlPath)) return json(200, { rrsets: state.records.map((r) => ({ ownerName: r.name.endsWith(".") ? r.name : r.name + ".", rrtype: r.type, rdata: [r.value], ttl: r.ttl ?? 300 })) });
        // powerdns: GET /zones/{zone}. → {records:[{name,type,content,ttl}]}
        if (opts.provider === "powerdns" && /\/zones\/[^/]+$/.test(urlPath)) return json(200, { records: state.records.map((r) => ({ name: r.name.endsWith(".") ? r.name : r.name + ".", type: r.type, content: r.value, ttl: r.ttl ?? 300 })) });
        // OCI: GET /zones/{zone}/records → {items:[{domain,rtype,rdata,ttl}]}
        if (opts.provider === "oci" && /\/zones\/[^/]+\/records/.test(urlPath)) {
          return json(200, { items: state.records.map((r) => ({ domain: r.name, rtype: r.type, rdata: r.value, ttl: r.ttl ?? 300 })) });
        }
        // infoblox: GET record:a?name~= → array [{_ref,name,ipv4addr,ttl}]
        if (opts.provider === "infoblox" && urlPath.includes("/record:")) {
          return json(200, state.records.map((r) => ({ _ref: r.id, name: r.name.endsWith(".") ? r.name : r.name + ".", ipv4addr: r.value, ttl: r.ttl ?? 300 })));
        }
        // azure: GET /subscriptions/.../dnsZones/{zone}/recordsets → {value:[...]}
        if (opts.provider === "azure" && /\/dnsZones\/[^/]+\/recordsets/.test(urlPath)) {
          return json(200, { value: state.records.map((r) => ({
            id: r.id,
            type: "Microsoft.Network/dnszones/" + r.type,
            name: r.name,
            properties: { TTL: r.ttl ?? 300, ...(r.type === "TXT" ? { TXTRecords: [{ value: [r.value] }] } : { ARecords: [{ ipv4Address: r.value }] }) },
          })) });
        }
        // directadmin: GET /CMD_API_DNS_CONTROL — action in query
        if (opts.provider === "directadmin" && urlPath.endsWith("/CMD_API_DNS_CONTROL")) {
          const q = Object.fromEntries(url.searchParams);
          const action = String(q.action ?? "");
          if (action === "list") return json(200, { records: state.records.map((r) => ({ name: r.name.endsWith(".") ? r.name : r.name + ".", type: r.type, value: r.value, ttl: String(r.ttl ?? 300) })) });
          if (action === "add") { const nm = String(q.name ?? "").replace(/\.$/, ""); if (q.type) state.records.push({ id: randomUUID(), type: String(q.type), name: nm, value: String(q.value ?? ""), ttl: q.ttl !== undefined ? Number(q.ttl) : undefined }); return json(200, {}); }
          if (action === "modify") { const nm = String(q.name ?? "").replace(/\.$/, ""); const ex = state.records.find((r) => r.name === nm); if (ex) { if (q.value) ex.value = String(q.value); } return json(200, {}); }
          if (action === "delete") { const nm = String(q.name ?? "").replace(/\.$/, ""); state.records = state.records.filter((r) => !(r.name === nm && r.type === String(q.type ?? ""))); return json(200, {}); }
          return json(200, {});
        }
        if (opts.provider === "gehirn" && urlPath === "/zones") return json(200, { zones: [{ id: "z1", name: z }] });
        if (opts.provider === "rcodezero" && (urlPath === "/zones/" || urlPath === "/zones")) return json(200, { zones: [{ id: "z1", name: z }] });
        if (opts.provider === "devnomads" && (urlPath === "/zones/" || urlPath === "/zones")) return json(200, { zones: [{ id: "z1", name: z }] });
        if (opts.provider === "misaka" && urlPath === `/zones/${z}/settings`) return json(200, { id: "z1" });
        if (opts.provider === "softlayer" && urlPath.includes("getByDomainName")) return json(200, [{ id: 1 }]);
        if ((opts.provider === "linode4" || opts.provider === "linode") && urlPath === "/domains") return json(200, { data: [{ id: 1 }] });
        // linode: GET /domains/{zid}/records → {data:[{id,type,name,target,ttl}]}
        if ((opts.provider === "linode" || opts.provider === "linode4") && /\/domains\/[^/]+\/records/.test(urlPath)) return json(200, { data: state.records.map(apiShape) });
        if (opts.provider === "nfsn" && urlPath.endsWith("/list")) {
          return json(200, state.records.map((r) => ({ id: r.id, type: r.type, name: r.name, data: r.value })));
        }
        // rackspace: GET /{tenant}/domains?name= → {domains}; GET /domains/{id}/records → {records}
        if (opts.provider === "rackspace" && urlPath.endsWith("/domains")) return json(200, { domains: [{ id: "d1" }] });
        if (opts.provider === "rackspace" && /\/domains\/[^/]+\/records$/.test(urlPath)) return json(200, { records: state.records.map(apiShape) });
        // memset: JSON-RPC via GET query — dns.zone_domain_info / zone_info / record_create
        if (opts.provider === "memset") {
          const q = Object.fromEntries(url.searchParams);
          if (urlPath.endsWith("dns.zone_domain_info")) return json(200, { zone_id: "z1" });
          if (urlPath.endsWith("dns.zone_info")) return json(200, { records: state.records.map(apiShape) });
          if (urlPath.endsWith("dns.zone_record_create")) { state.records.push({ id: randomUUID(), type: String(q.type ?? ""), name: String(q.name ?? ""), value: String(q.content ?? q.data ?? ""), ttl: q.ttl !== undefined ? Number(q.ttl) : undefined }); return json(200, { id: String(state.records.length) }); }
          if (urlPath.endsWith("dns.zone_record_update")) return json(200, { ok: true });
          if (urlPath.endsWith("dns.zone_record_delete")) { state.records = state.records.filter((r) => r.id !== String(q.id ?? "")); return json(200, { ok: true }); }
        }
      }
      const listOut = { records: state.records.map(apiShape) };
      // dreamhost (cmd=dns-add_record) / namesilo (dnsAddRecord) create via GET
      const cmd = url.searchParams.get("cmd") ?? url.pathname.split("/").pop() ?? "";
      if (method === "GET" && /add[_-]?record/i.test(cmd) && !/list/i.test(cmd)) {
        // namesilo: params are rrtype/rrhost/rrvalue and the API has ?type=json
        // (format); dreamhost: cmd=dns-add_record&type=<real>&record=&value=
        const isNamesilo = opts.provider === "namesilo";
        const rec = {
          type: (isNamesilo ? url.searchParams.get("rrtype") : url.searchParams.get("type")) ?? "A",
          name: (isNamesilo ? url.searchParams.get("rrhost") : url.searchParams.get("record")) ?? "verify.example.com",
          value: (isNamesilo ? url.searchParams.get("rrvalue") : url.searchParams.get("value")) ?? "v1",
        };
        const full = rec.name.includes(".") ? rec.name : `${rec.name}.example.com`;
        const created = { id: randomUUID(), type: rec.type, name: rec.name.endsWith(".") ? rec.name.slice(0, -1) : full, value: rec.value, ttl: 300 };
        state.records.push(created);
        const [c, b] = formatFor(opts.provider, method, url.pathname, listOut);
        return json(c, b);
      }
      const [code, bodyOut] = formatFor(opts.provider, method, url.pathname, listOut);
      if (method === "GET") {
        if (typeof bodyOut === "string") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(bodyOut);
          return;
        }
        return json(code, bodyOut);
      }
      if (method === "POST") {
        const ct = (req.headers["content-type"] ?? "").toLowerCase();
        const urlPath = url.pathname;
        // hover: POST /signin/auth.json → set-cookie hoverauth
        if (opts.provider === "hover" && urlPath === "/signin/auth.json") {
          res.writeHead(200, { "content-type": "application/json", "set-cookie": "hoverauth=mock-auth; Path=/; HttpOnly" });
          res.end(JSON.stringify({ /* hover expects 200 with auth cookie */ }, null, 0));
          return;
        }
        if (opts.provider === "hover" && urlPath.startsWith("/control_panel/dns")) {
          const hb = (() => { if (body) { try { return JSON.parse(body); } catch { return {}; } } return {}; })() as Record<string, unknown>;
          // GET /control_panel/dns/{zone} → {domain:{dns:[...]}}; POST → create
          const rec = stdRec(hb);
          if (method === "POST") { if (rec.name) state.records.push({ id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl }); return json(200, { id: state.records.at(-1)?.id ?? `${rec.name}/${rec.type}` }); }
          return json(200, {});
        }
        // easyname: POST /en/authentication-api/login → set-cookie session + 200
        if (opts.provider === "easyname" && urlPath === "/en/authentication-api/login") {
          res.writeHead(200, { "content-type": "application/json", "set-cookie": "JSESSIONID=mock-session; Path=/; HttpOnly" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (opts.provider === "easyname" && urlPath.includes("/en/domain/dns/")) {
          const eb = (() => { if (body) { try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); } } return {}; })() as Record<string, unknown>;
          // easyname parses record ids via /data-id="?([0-9]+)"? — the id must be numeric
          if (urlPath.includes("/create/")) { const rec = stdRec(eb); if (rec.name) state.records.push({ id: String(state.records.length + 1), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl }); }
          if (urlPath.includes("/edit/")) { const rec = stdRec(eb); const ex = state.records.find((r) => r.id === String(eb.id ?? "") || r.name === rec.name); if (ex) { if (rec.value) ex.value = rec.value; } }
          if (urlPath.includes("/delete/")) { const id = String(eb.id ?? urlPath.split("/id/")[1] ?? urlPath.split("/id/")[1]?.split("/")[0] ?? ""); state.records = state.records.filter((r) => r.id !== id); }
          res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>ok</body></html>");
          return;
        }
        // gransy: SOAP XML POST /wsdl — op from soapaction header / <op> element
        if (opts.provider === "gransy" && urlPath.endsWith("/wsdl")) {
          const soapaction = String(req.headers["soapaction"] ?? "");
          const xml = String(body ?? "");
          const op = /xmlns=\"https:\/\/subreg.cz\">([^<]+)</.exec(xml)?.[1] ?? soapaction.split(":").pop() ?? soapaction;
          const wrap = (inner: string) => `<?xml version=\"1.0\" encoding=\"UTF-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
          if (/Login/.test(op)) { res.writeHead(200, { "content-type": "text/xml" }); res.end(wrap("<LoginResponse><status>ok</status></LoginResponse>")); return; }
          if (/Get_DNS_Zone/.test(op)) { const rows = state.records.map((r) => `<record><id>${r.id}</id><type>${r.type}</type><name>${r.name}</name><rdata>${r.value}</rdata></record>`).join(""); res.writeHead(200, { "content-type": "text/xml" }); res.end(wrap(`<Get_DNS_ZoneResponse>${rows}</Get_DNS_ZoneResponse>`)); return; }
          if (/Add_DNS_Record/.test(op)) { const m = /<name>([^<]*)<\/name>/.exec(xml); const t = /<type>([^<]*)<\/type>/.exec(xml); const d = /<rdata>([^<]*)<\/rdata>/.exec(xml); if (t?.[1]) state.records.push({ id: String(state.records.length + 1), type: t[1], name: m?.[1] ?? "", value: d?.[1] ?? "", ttl: undefined }); res.writeHead(200, { "content-type": "text/xml" }); res.end(wrap("<Add_DNS_RecordResponse><status>ok</status></Add_DNS_RecordResponse>")); return; }
          if (/Modify_DNS_Record/.test(op)) { res.writeHead(200, { "content-type": "text/xml" }); res.end(wrap("<Modify_DNS_RecordResponse><status>ok</status></Modify_DNS_RecordResponse>")); return; }
          if (/Delete_DNS_Record/.test(op)) { const m = /<id>([^<]*)<\/id>/.exec(xml); const id = m?.[1] ?? ""; state.records = state.records.filter((r) => r.id !== id); res.writeHead(200, { "content-type": "text/xml" }); res.end(wrap("<Delete_DNS_RecordResponse><status>ok</status></Delete_DNS_RecordResponse>")); return; }
          res.writeHead(200, { "content-type": "text/xml" }); res.end(wrap("<status>ok</status>")); return;
        }
        // plesk: XML body (<site><get>|<dns><get_rec>|<add_rec>|<del_rec>|…)
        if (opts.provider === "plesk" && String(body ?? "").includes("<packet>")) {
          const xml = String(body ?? "");
          res.writeHead(200, { "content-type": "text/xml" });
          if (/<site><get>/.test(xml)) { res.end("<?xml version=\"1.0\"?><packet><site><get><result><id>#S1</id><status>ok</status></result></get></site></packet>"); return; }
          if (/<dns><get_rec>/.test(xml)) {
            const rows = state.records.map((r) => { const host = r.name === "example.com" ? "@" : r.name.replace(".example.com", ""); return `<rec><id>${r.id}</id><type>${r.type}</type><host>${host}</host><value>${r.value}</value></rec>`; });
            res.end(`<?xml version=\"1.0\"?><packet><dns><get_rec><result><status>ok</status>${rows.join("")}</result></get_rec></dns></packet>`); return;
          }
          if (/<dns><add_rec>/.test(xml)) { const m = /<host>([^<]*)<\/host>/.exec(xml); const t = /<type>([^<]*)<\/type>/.exec(xml); const v = /<value>([^<]*)<\/value>/.exec(xml); const host = m?.[1] ?? ""; const name = host === "@" ? "example.com" : `${host}.example.com`; if (t?.[1]) state.records.push({ id: randomUUID(), type: t[1], name, value: v?.[1] ?? "", ttl: undefined }); res.end("<?xml version=\"1.0\"?><packet><dns><add_rec><result><status>ok</status></result></add_rec></dns></packet>"); return; }
          if (/<dns><set_rec>/.test(xml)) { res.end("<?xml version=\"1.0\"?><packet><dns><set_rec><result><status>ok</status></result></set_rec></dns></packet>"); return; }
          if (/<dns><del_rec>/.test(xml)) { const m = /<id>([^<]*)<\/id>/.exec(xml); const id = m?.[1] ?? ""; state.records = state.records.filter((r) => r.id !== id); res.end("<?xml version=\"1.0\"?><packet><dns><del_rec><result><status>ok</status></result></del_rec></dns></packet>"); return; }
          res.end("<?xml version=\"1.0\"?><packet><status>ok</status></packet>"); return;
        }
        const authBody = (() => {
          if (body) {
            try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); }
          }
          return {};
        })() as Record<string, unknown>;
        // qcloud (Tencent DNSPod): POST / with JSON body containing Action
        if (opts.provider === "qcloud") {
          const action = String(req.headers["x-tc-action"] ?? "").toLowerCase();
          if (action === "describedomainlist") return json(200, { Response: { DomainList: [{ DomainId: 1 }] } });
          if (action === "describerecordlist") return json(200, { Response: { RecordList: state.records.map((r) => ({ RecordId: r.id, Type: r.type, Name: r.name.split(".")[0], Value: r.value, TTL: r.ttl ?? 600 })) } });
          if (action === "createrecord") {
            const rec = stdRec(authBody);
            if (rec.name) state.records.push({ id: String(state.records.length + 1), type: rec.type || "A", name: rec.name, value: rec.value, ttl: rec.ttl });
            return json(200, { Response: { RecordId: 9 } });
          }
          if (action === "modifyrecord" || action === "deleterecord") return json(200, { Response: {} });
        }
        // wedos: POST /wapi/json with form-encoded {request=<urlencoded JSON>}
        if (opts.provider === "wedos") {
          const form = Object.fromEntries(new URLSearchParams(String(body ?? "")));
          const reqObj = (JSON.parse(String(form.request ?? "{}")).request ?? JSON.parse(String(form.request ?? "{}"))) as { command?: string; data?: Record<string, unknown> };
          const cmd = reqObj.command ?? "";
          if (cmd === "dns-domains-list") return json(200, { response: { code: 1000, data: { domain: [{ name: "example.com" }] } } });
          if (cmd === "dns-rows-list") return json(200, { response: { code: 1000, data: { row: state.records.map((r) => ({ ID: r.id, name: r.name, rdtype: r.type, rdata: r.value, ttl: r.ttl ?? 300 })) } } });
          if (cmd.startsWith("dns-row-add")) { const rec = stdRec(reqObj.data); if (rec.name) state.records.push({ id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl }); return json(200, { response: { code: 1000, data: { id: "1" } } }); }
          if (cmd.startsWith("dns-row-update")) return json(200, { response: { code: 1000, data: {} } });
          if (cmd.startsWith("dns-row-delete")) return json(200, { response: { code: 1000, data: {} } });
          return json(200, { response: { code: 1000, data: {} } });
        }
        // nfsn: GET|POST /dns/{zone}/list|add|replace|remove (POST body = JSON)
        if (opts.provider === "nfsn" && urlPath.includes("/dns/")) {
          if (urlPath.endsWith("/add")) { const rec = stdRec(authBody); if (rec.name) state.records.push({ id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl }); return json(200, { id: "1" }); }
          if (urlPath.endsWith("/replace")) return json(200, { id: "1" });
          if (urlPath.endsWith("/remove")) { const delId = String(stdRec(authBody).name ?? ""); state.records = state.records.filter((r) => (r.id !== delId && r.name !== delId)); return json(200, {}); }
        }
        // gratisdns: POST form {action:list|add|...} — list returns records
        if (opts.provider === "gratisdns" && authBody.action === "list") {
          return json(200, { data: state.records.map(apiShape) });
        }
        // token endpoints: ultradns (grant_type=password), dnsservices (/login)
        if (opts.provider === "ultradns" && urlPath.includes("/authorization/token")) {
          return json(200, { access_token: "tok-1" });
        }
        if (opts.provider === "dnsservices" && urlPath === "/login") {
          return json(200, { token: "tok-1" });
        }
        if (opts.provider === "azure" && urlPath.includes("oauth2")) {
          return json(200, { access_token: "tok-1" });
        }
        if (opts.provider === "rackspace" && urlPath.includes("tokens")) {
          return json(200, { access: { token: { id: "tok-1" }, user: { tenantId: "t1" } } });
        }
        if (opts.provider === "rackspace" && urlPath.endsWith("/domains")) {
          return json(200, { domains: [{ id: "d1" }] });
        }
        if (opts.provider === "oci" && urlPath.includes("authorization/token")) {
          return json(200, { access_token: "tok-1" });
        }
        if (opts.provider === "transip" && urlPath === "/auth") {
          return json(200, { token: "tok-1" });
        }
        // ultradns: POST /authorization/token → {access_token}
        if (opts.provider === "ultradns" && urlPath.includes("/authorization/token")) {
          return json(200, { access_token: "tok-1" });
        }
        // googleclouddns: POST /oauth2/gcp → {access_token} (JWT exchange)
        if (opts.provider === "googleclouddns" && urlPath.includes("/oauth2/")) {
          return json(200, { access_token: "tok-1" });
        }
        // cloudxns: POST /record with JSON body → {code:1, data:{id}}
        if (opts.provider === "cloudxns" && urlPath === "/record") {
          const crec = stdRec(body);
          if (crec.name) state.records.push({ id: String(state.records.length + 1), type: crec.type, name: crec.name, value: crec.value, ttl: crec.ttl });
          return json(200, { code: 1, data: { id: String(state.records.length) } });
        }
        // joker: text protocol — /login → auth-sid=.., /dns-zone-get → data rows
        if (opts.provider === "joker") {
          if (urlPath.endsWith("/login")) { res.writeHead(200, { "content-type": "text/plain" }); res.end("auth-sid=sid-1\n\n"); return; }
          if (urlPath.endsWith("/dns-zone-get")) {
            const lines = state.records.map((r) => { const label = r.name === "example.com" ? "@" : r.name.replace(".example.com", ""); return `${label} ${r.type} ${r.value} ${r.ttl ?? 300}`; });
            res.writeHead(200, { "content-type": "text/plain" }); res.end("# joker\n\n" + lines.join("\n") + "\n"); return;
          }
          if (urlPath.endsWith("/dns-zone-add")) {
            const q = Object.fromEntries(new URLSearchParams(String(body ?? "")));
            const label = String(q.label ?? "");
            const name = label === "@" || label === "" ? "example.com" : `${label}.example.com`;
            if (q.type) state.records.push({ id: randomUUID(), type: String(q.type), name, value: String(q.target ?? ""), ttl: q.ttl !== undefined ? Number(q.ttl) : undefined });
            res.writeHead(200, { "content-type": "text/plain" }); res.end("ok\n"); return;
          }
          if (urlPath.endsWith("/dns-zone-delete")) {
            const q = Object.fromEntries(new URLSearchParams(String(body ?? "")));
            const label = String(q.label ?? "");
            const name = label === "@" || label === "" ? "example.com" : `${label}.example.com`;
            state.records = state.records.filter((r) => !(r.name === name && r.type === String(q.type ?? "")));
            res.writeHead(200, { "content-type": "text/plain" }); res.end("ok\n"); return;
          }
          if (urlPath.endsWith("/dns-zone-edit")) {
            const q = Object.fromEntries(new URLSearchParams(String(body ?? "")));
            const label = String(q.label ?? "");
            const name = label === "@" || label === "" ? "example.com" : `${label}.example.com`;
            const ex = state.records.find((r) => r.name === name && r.type === String(q.type ?? ""));
            if (ex) { if (q.target) ex.value = String(q.target); }
            res.writeHead(200, { "content-type": "text/plain" }); res.end("ok\n"); return;
          }
          res.writeHead(200, { "content-type": "text/plain" }); res.end("ok\n"); return;
        }
        // dinahosting: POST form {cmd:...} → {records} (list) or success (mutate)
        if (opts.provider === "dinahosting") {
          const cmd = String(authBody.cmd ?? "");
          if (cmd === "dns_zone_info") return json(200, { records: state.records.map(apiShape) });
          if (cmd === "dns_zone_add_record") { const rec = stdRec(authBody); if (rec.name) state.records.push({ id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl }); return json(200, {}); }
          if (cmd === "dns_zone_modify_record") { const rec = stdRec(authBody); const ex = state.records.find((r) => r.id === String(authBody.id ?? "")); if (ex) { if (rec.value) ex.value = rec.value; if (rec.type) ex.type = rec.type; } return json(200, {}); }
          if (cmd === "dns_zone_delete_record") { const id = String(authBody.id ?? ""); state.records = state.records.filter((r) => r.id !== id); return json(200, {}); }
          return json(200, {});
        }
        // hostingde/httpnet: POST recordsFind (list) — return the current records
        if ((opts.provider === "hostingde" || opts.provider === "httpnet") && urlPath.endsWith("recordsFind")) {
          return json(200, { status: "success", data: { records: state.records.map(apiShape) } });
        }
        // hostingde/httpnet: POST recordsCreate — nested {records:[...]}
        if ((opts.provider === "hostingde" || opts.provider === "httpnet") && urlPath.endsWith("recordsCreate")) {
          const recs0 = (authBody.records ?? []) as Array<Record<string, unknown>>;
          for (const r of recs0) { const rr = stdRec(r); if (rr.name) state.records.push({ id: randomUUID(), type: rr.type, name: rr.name, value: rr.value, ttl: rr.ttl }); }
          return json(200, { status: "success", data: { records: state.records.map(apiShape) } });
        }
        if ((opts.provider === "hostingde" || opts.provider === "httpnet") && urlPath.endsWith("recordsUpdate")) {
          const recs0 = (authBody.records ?? []) as Array<Record<string, unknown>>;
          for (const r of recs0) { const rr = stdRec(r); const ex = state.records.find((x) => x.id === String(rr.name ?? "") || x.id === String((r as { id?: string }).id)); if (ex && rr.value) ex.value = rr.value; if (rr.type) ex!.type = rr.type; if (rr.ttl !== undefined) ex!.ttl = rr.ttl; }
          return json(200, { status: "success", data: { records: state.records.map(apiShape) } });
        }
        if ((opts.provider === "hostingde" || opts.provider === "httpnet") && urlPath.endsWith("recordsDelete")) {
          const recs0 = (authBody.records ?? []) as Array<Record<string, unknown>>;
          for (const r of recs0) { const id = String((r as { id?: string }).id ?? ""); state.records = state.records.filter((x) => x.id !== id); }
          return json(200, { status: "success", data: { records: [] } });
        }
        // rackspace: POST /domains/{id}/records with {records:[...]}
        if (opts.provider === "rackspace" && /\/domains\/[^/]+\/records$/.test(urlPath)) {
          const rs = (authBody.records ?? []) as Array<Record<string, unknown>>;
          const ids: string[] = [];
          for (const r of rs) { const rr = stdRec(r); const created = { id: randomUUID(), type: rr.type, name: rr.name, value: rr.value, ttl: rr.ttl }; if (rr.name) state.records.push(created); ids.push(created.id); }
          return json(200, { records: ids.map((id) => ({ id })) });
        }
        // yandexcloud: POST /zones/{zid}:upsertRecordSets — upsertions / deletions
        if (opts.provider === "yandexcloud" && urlPath.includes(":upsertRecordSets")) {
          const ups = (authBody.upsertions ?? []) as Array<Record<string, unknown>>;
          for (const u of ups) {
            const nm = String(u.name ?? "").replace(/\.$/, "");
            const tp = String(u.type ?? "");
            const dt = (u.data as string[] | undefined) ?? [];
            const ex = state.records.find((r) => r.name === nm && r.type === tp);
            if (ex) { ex.value = dt[0] ?? ex.value; if (u.ttl !== undefined) ex.ttl = Number(u.ttl); }
            else if (nm) state.records.push({ id: randomUUID(), type: tp, name: nm, value: dt[0] ?? "", ttl: u.ttl !== undefined ? Number(u.ttl) : undefined });
          }
          const dels = (authBody.deletions ?? []) as Array<Record<string, unknown>>;
          for (const d of dels) { const nm = String(d.name ?? "").replace(/\.$/, ""); state.records = state.records.filter((r) => !(r.name === nm && r.type === String(d.type ?? ""))); }
          return json(200, {});
        }
        // yandex: POST add with form query (subdomain + domain) → {success:"ok", record_id}
        if (opts.provider === "yandex") {
          const q = Object.fromEntries(new URLSearchParams(String(body ?? "")));
          const sub = String(q.subdomain ?? "");
          const dom = String(q.domain ?? "example.com");
          const name = sub === "@" || sub === "" ? dom : `${sub}.${dom}`;
          if (q.type) state.records.push({ id: String(state.records.length + 1), type: String(q.type), name, value: String(q.content ?? q.value ?? ""), ttl: q.ttl !== undefined ? Number(q.ttl) : undefined });
          return json(200, { success: "ok", record_id: name && q.type ? String(state.records.length) : undefined });
        }
        let bodyObj = authBody as { action?: string; param?: { dnsrecordset?: { dnsrecords?: Array<Record<string, unknown>> } } };
        if (opts.provider === "netcup" && bodyObj.action) {
          if (bodyObj.action === "login") return json(200, { status: "success", responsedata: { apisessionid: "sid-1" } });
          if (bodyObj.action === "logout") return json(200, { status: "success" });
          if (bodyObj.action.startsWith("info")) return json(200, { status: "success", responsedata: { dnsrecords: state.records.map(apiShape) } });
          if (bodyObj.action === "updateDnsRecords") {
            const set = bodyObj.param?.dnsrecordset?.dnsrecords ?? [];
            for (const dr of set) {
              const rec = stdRec(dr);
              const created = { id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl };
              if (rec.name) state.records.push(created);
            }
            return json(200, { status: "success", responsedata: { dnsrecords: [{ id: "r1" }] } });
          }
          return json(200, { status: "success", responsedata: { dnsrecords: [{ id: "r1" }] } });
        }
        if (opts.provider === "namecheap") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("good 1.2.3.4");
          return;
        }
        const rec = stdRec(body);
        // ultradns: create path /zones/:z/rrsets/{TYPE}/{NAME} — extract from URL
        if (opts.provider === "ultradns" && !rec.name) {
          const m = url.pathname.match(/\/rrsets\/([^/]+)\/([^/]+)$/);
          if (m) { rec.type = rec.type || m[1] || ""; rec.name = (m[2] ?? "").replace(/\.$/, ""); }
        }
        // only store the record if we actually parsed a name (some providers
        // post metadata-only or batch payloads that pass through here)
        const created = { id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl };
        if (rec.name) state.records.push(created);
        const out = opts.provider === "dnsmadeeasy" ? { id: created.id, data: state.records.map(apiShape) }
          : opts.provider === "constellix" ? { data: { id: created.id } }
          : { id: created.id, record: apiShape(created) };
        if (opts.provider === "cloudxns") return json(200, { code: 1, data: { id: created.id } });
        if (opts.provider === "infoblox") return json(200, { _ref: created.id });
        return json(200, out);
      }
      if (method === "PUT") {
        const rec = stdRec(body);
        // ultradns updates via PUT /rrsets/{TYPE}/{NAME} with body {ttl, rdata} —
        // extract the real name/type from the URL (body has no name).
        if (opts.provider === "ultradns" && !rec.name) {
          const m = url.pathname.match(/\/rrsets\/([^/]+)\/([^/]+)$/);
          if (m) { rec.type = rec.type || m[1] || ""; rec.name = (m[2] ?? "").replace(/\.$/, ""); }
        }
        // devnomads PUT /zones/{zid}/rrsets/{NAME}/{TYPE}; misaka PUT /recordsets/{NAME}/{TYPE}
        if (!rec.name && /\/(rrsets|recordsets)\/([^/]+)\/([^/]+)$/.test(url.pathname)) {
          const m = url.pathname.match(/\/(?:rrsets|recordsets)\/([^/]+)\/([^/]+)$/);
          if (m) { rec.name = (m[1] ?? "").replace(/\.$/, ""); rec.type = rec.type || m[2] || ""; }
        }
        // azure PUT /subscriptions/.../dnsZones/{zone}/{TYPE}/{label} — name in the
        // URL, value in {properties:{TXTRecords|ARecords|CNAMERecord}}.
        if (opts.provider === "azure" && /\/dnsZones\/[^/]+\/([^/]+)\/([^/]+)/.test(url.pathname)) {
          const m = url.pathname.match(/\/dnsZones\/[^/]+\/([^/]+)\/([^/]+)/);
          if (m) { rec.type = rec.type || m[1] || ""; rec.name = m[2] ?? ""; }
          const props = ((() => { if (body) { try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); } } return {}; })() as Record<string, unknown>);
          const txt = (props.TXTRecords as Array<{ value?: string[] }> | undefined)?.[0]?.value?.[0];
          const a = (props.ARecords as Array<{ ipv4Address?: string }> | undefined)?.[0]?.ipv4Address;
          const cname = (props.CNAMERecord as { cname?: string } | undefined)?.cname;
          const ttl = props.TTL !== undefined ? Number(props.TTL) : undefined;
          rec.value = String(txt ?? a ?? cname ?? rec.value ?? "");
          rec.ttl = ttl !== undefined && !isNaN(ttl) ? ttl : rec.ttl;
        }
        const existing = state.records.find((r) => r.id === trailing || r.name === rec.name);
        if (!existing && rec.name) {
          const created = { id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl };
          state.records.push(created);
          return json(200, opts.provider === "namecheap" ? "good 1.2.3.4" : apiShape(created));
        }
        if (existing) {
          if (rec.type) existing.type = rec.type;
          if (rec.name) existing.name = rec.name;
          if (rec.value) existing.value = rec.value;
          if (rec.ttl !== undefined) existing.ttl = rec.ttl;
          return json(200, opts.provider === "namecheap" ? "good 1.2.3.4" : opts.provider === "cloudxns" ? { code: 1, data: {} } : apiShape(existing));
        }
        return json(404, { error: "not found" });
      }
      if (method === "PATCH") {
        // rcodezero: PATCH /zones/{zid}/rrsets {name,type,records:[{content}],ttl}
        // powerdns:   PATCH /zones/{zone}. {rrsets:[{name,type,ttl,changetype,records}]}
        const srcBody = (() => { if (body) { try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); } } return {}; })() as Record<string, unknown>;
        // OCI: PATCH /zones/{zone}/records/{name} with {items:[{domain,rtype,rdata,ttl}]}
        if (opts.provider === "oci") {
          const items = (srcBody.items as Array<Record<string, unknown>> | undefined) ?? [];
          const pathName = url.pathname.split("/").pop() ?? "";
          for (const it of items) {
            const rec = stdRec(it);
            const nm = rec.name || pathName.replace(/\.$/, "");
            if (rec.name) state.records.push({ id: randomUUID(), type: rec.type, name: nm, value: rec.value, ttl: rec.ttl });
            else { const ex = state.records.find((r) => r.name === nm); if (ex && rec.value) ex.value = rec.value; }
          }
          return json(200, {});
        }
        const src = (srcBody.rrsets as Array<Record<string, unknown>> | undefined)?.[0] ?? srcBody;
        const rec = stdRec(src);
        // powerdns wraps the value in records[0].content
        if (rec.value === "") {
          const inner = (src as { records?: Array<Record<string, unknown>> }).records?.[0];
          if (inner) rec.value = String(inner.content ?? inner.value ?? "");
        }
        const ct = String((src as { changetype?: string }).changetype ?? "");
        // powerdns DELETE changetype
        if (ct === "DELETE") state.records = state.records.filter((r) => !(r.name === rec.name && (!rec.type || r.type === rec.type)));
        else {
          const existing = state.records.find((r) => r.name === rec.name && (!rec.type || r.type === rec.type));
          if (existing) { existing.value = rec.value; if (rec.ttl !== undefined) existing.ttl = rec.ttl; }
          else if (rec.name) state.records.push({ id: randomUUID(), type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl });
        }
        return json(200, {});
      }
      if (method === "DELETE") {
        const delRec = stdRec(body);
        const norm = (s: string) => s.replace(/\.$/, "");
        // hover deletes by body {id} (no path segment / body name) — parse the id.
        const delBody = (() => { if (body) { try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); } } return {}; })() as Record<string, unknown>;
        const delId = String(delBody.id ?? "");
        if (opts.provider === "hover" && delId) {
          const idxH = state.records.findIndex((r) => r.id === delId);
          if (idxH >= 0) state.records.splice(idxH, 1);
          return json(200, {});
        }
        // collect candidate record identifiers from the path: trailing segment,
        // the segment before it (cloudxns /id/did), and the NAME after
        // /rrsets/{TYPE}/{NAME} (ultradns).
        const segs = url.pathname.split("/").filter(Boolean);
        const rrsetsMatch = url.pathname.match(/\/rrsets\/[^/]+\/([^/]+)$/);
        const candidates = [trailing, segs[segs.length - 2], rrsetsMatch?.[1] ?? "", delRec.name ?? ""]
          .filter((s): s is string => Boolean(s)).map(norm);
        const idx = state.records.findIndex((r) => {
          if (r.id === trailing || candidates.includes(norm(r.id ?? ""))) return true;
          if (candidates.includes(norm(r.name ?? ""))) return true;
          if (delRec.name && norm(r.name ?? "") === norm(delRec.name) && (!delRec.type || r.type === delRec.type)) return true;
          return false;
        });
        if (idx < 0) return json(404, { error: "not found" });
        state.records.splice(idx, 1);
        if (opts.provider === "cloudxns") return json(200, { code: 1, data: {} });
        if (opts.provider === "namecheap") return json(200, "good 1.2.3.4");
        return json(200, { ok: true });
      }
      json(405, { error: "method not allowed" });
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

export { defaultFetchLike };