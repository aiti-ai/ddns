/** Special-provider mocks + contract tests — dreamhost (cmd API),
 *  dondominio (push JSON), netcup (login→CRUD session flow), namesilo
 *  (key-query API), spaceship (X-API-Key/Secret), route53 (SigV4 + XML),
 *  gcp (OAuth JSON). Each mock mirrors the real API shape so the Go
 *  implementation's assumptions hold. */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const { DreamhostProvider, DondominioProvider, NetcupProvider, NamesiloProvider, SpaceshipProvider, NamecheapProvider, DnsmadeeasyProvider, UltradnsProvider, ConstellixProvider, DnsservicesProvider } = await import("../src/providers/special.ts");
const { AuroraProvider, CloudxnsProvider, YandexProvider, TransipProvider, QcloudProvider, HostingdeProvider, WedosProvider, NfsnProvider, YandexcloudProvider, ValuedomainProvider, RackspaceProvider, MemsetProvider, GehirnProvider, RcodezeroProvider, DevnomadsProvider, MisakaProvider, DinahostingProvider, JokerProvider, PowerdnsProvider, DirectadminProvider, InfobloxProvider, AzureProvider } = await import("../src/providers/lexicon-more.ts");
const { Route53Provider, awsSigV4 } = await import("../src/providers/route53.ts");
const { GcpProvider } = await import("../src/providers/gcp.ts");

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

/* ------------------------------ dreamhost ------------------------------ */

test("dreamhost: cmd-style list/add/remove with API key + format=json", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    calls.push(Object.fromEntries(u.searchParams));
    res.writeHead(200, { "content-type": "application/json" });
    if (u.searchParams.get("cmd") === "dns-list_records") {
      res.end(JSON.stringify({ result: "success", data: [{ record: "home.example.com", type: "A", value: "1.1.1.1" }] }));
    } else {
      res.end(JSON.stringify({ result: "success" }));
    }
  });
  try {
    const p = new DreamhostProvider({ key: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(calls[0].key, "k");
    assert.equal(calls[0].format, "json");
    assert.equal(calls[0].cmd, "dns-list_records");

    await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(calls.at(-1).cmd, "dns-add_record");
    assert.equal(calls.at(-1).record, "x.example.com");

    // error surface
    const srv2 = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: "error: invalid key" }));
    });
    const p2 = new DreamhostProvider({ key: "k", baseUrl: urlOf(srv2) });
    await assert.rejects(() => p2.listRecords("example.com"), /invalid key/);
    await new Promise((r) => srv2.close(r));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ dondominio ------------------------------ */

test("dondominio: push user/password/host/ip; success flag checked", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    calls.push(Object.fromEntries(u.searchParams));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });
  try {
    const p = new DondominioProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    await p.pushValue({ name: "home.example.com", type: "A", value: "203.0.113.9" });
    assert.equal(calls[0].user, "u");
    assert.equal(calls[0].password, "p");
    assert.equal(calls[0].host, "home.example.com");
    assert.equal(calls[0].ip, "203.0.113.9");

    const srv2 = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "bad credentials" }));
    });
    const p2 = new DondominioProvider({ username: "u", password: "p", baseUrl: urlOf(srv2) });
    await assert.rejects(() => p2.pushValue({ name: "h", type: "A", value: "1.2.3.4" }), /bad credentials/);
    await new Promise((r) => srv2.close(r));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- netcup -------------------------------- */

test("netcup: login → infoDnsRecords → update (session flow)", async () => {
  const actions = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { action, param } = JSON.parse(body);
      actions.push(action);
      res.writeHead(200, { "content-type": "application/json" });
      if (action === "login") return res.end(JSON.stringify({ status: "success", responsedata: { apisessionid: "sid1" } }));
      if (action === "logout") return res.end(JSON.stringify({ status: "success" }));
      if (action === "infoDnsRecords") {
        return res.end(JSON.stringify({ status: "success", responsedata: { dnsrecords: [{ id: "1", hostname: "home", type: "A", destination: "1.1.1.1", ttl: "300" }] } }));
      }
      if (action === "updateDnsRecords") {
        return res.end(JSON.stringify({ status: "success", responsedata: { dnsrecords: [{ id: "2" }] } }));
      }
      res.end(JSON.stringify({ status: "error", shortmessage: "unknown" }));
    });
  });
  try {
    const p = new NetcupProvider({ customerNumber: "c1", apiKey: "k", apiPassword: "pw", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "home.example.com");
    assert.deepEqual(actions.slice(0, 3), ["login", "infoDnsRecords", "logout"]);

    const created = await p.createRecord("example.com", { type: "A", name: "lab.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "2");
    assert.ok(actions.includes("updateDnsRecords"));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- namesilo ------------------------------- */

test("namesilo: key-query API with reply.code 300 = success", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    calls.push({ cmd: u.pathname.split("/").pop(), key: u.searchParams.get("key"), domain: u.searchParams.get("domain") });
    res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname.endsWith("dnsListRecords")) {
      res.end(JSON.stringify({ reply: { code: 300, detail: "success", resource_records: [{ record_id: "r1", type: "A", host: "home", value: "1.1.1.1", ttl: "3600" }] } }));
    } else if (u.pathname.endsWith("dnsAddRecord")) {
      res.end(JSON.stringify({ reply: { code: 300, record_id: "r2" } }));
    } else {
      res.end(JSON.stringify({ reply: { code: 300, detail: "success" } }));
    }
  });
  try {
    const p = new NamesiloProvider({ key: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].name, "home.example.com");
    assert.equal(calls[0].key, "k");
    assert.equal(calls[0].domain, "example.com");

    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "r2");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- spaceship ------------------------------ */

test("spaceship: X-API-Key + X-API-Secret headers on CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-api-key"], secret: req.headers["x-api-secret"] });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET") res.end(JSON.stringify({ records: [{ id: "r1", type: "A", name: "home.example.com", value: "1.1.1.1", ttl: 300 }] }));
    else if (req.method === "POST") res.end(JSON.stringify({ id: "r2" }));
    else res.end("{}");
  });
  try {
    const p = new SpaceshipProvider({ apiKey: "ak", apiSecret: "as", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].key, "ak");
    assert.equal(seen[0].secret, "as");
    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "r2");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ----------------------------- dnsmadeeasy ------------------------------ */

test("dnsmadeeasy: HMAC headers + managed zone CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("/dns/managed/name")) res.end(JSON.stringify({ id: "z1" }));
      else if (req.url.includes("/records") && req.method === "GET") res.end(JSON.stringify({ data: [{ id: "r1", type: "A", name: "home.example.com", value: "1.1.1.1", ttl: 300 }] }));
      else if (req.method === "POST") res.end(JSON.stringify({ id: "r2" }));
      else res.end("{}");
    });
  });
  try {
    const p = new DnsmadeeasyProvider({ apiKey: "k", secret: "s", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    // HMAC headers present
    assert.ok(seen[0].headers["x-dnsme-apikey"] === "k");
    assert.ok(seen[0].headers["x-dnsme-hmac"]);
    assert.ok(seen[0].headers["x-dnsme-requestdate"]);

    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "r2");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ constellix ------------------------------ */

test("constellix: HMAC headers + rr-set CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === "/domains/" && req.method === "GET") res.end(JSON.stringify({ data: [{ id: "d1", name: "example.com" }] }));
    else if (req.url.includes("/records") && req.method === "GET") res.end(JSON.stringify({ data: [{ id: 1, name: "home.example.com", type: "A", roundRobin: [{ value: "1.1.1.1" }], ttl: 300 }] }));
    else if (req.method === "POST") res.end(JSON.stringify({ data: { id: 9 } }));
    else res.end("{}");
  });
  try {
    const p = new ConstellixProvider({ apiKey: "k", secret: "s", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com", { type: "A" });
    assert.equal(listed[0].value, "1.1.1.1");
    assert.ok(seen[0].headers["x-cnsdns-apikey"] === "k");
    assert.ok(seen[0].headers["x-cnsdns-hmac"]);
    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "9");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ dnsservices ------------------------------ */

test("dnsservices: login token flow + zone CRUD", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, method: req.method });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/login") res.end(JSON.stringify({ token: "tok1" }));
      else if (req.url === "/dns") res.end(JSON.stringify({ zones: [{ name: "example.com", domain_id: "dom1", service_id: "svc1" }] }));
      else if (req.url.startsWith("/service/") && req.method === "GET") res.end(JSON.stringify({ records: [{ id: "r1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }] }));
      else if (req.method === "POST") res.end(JSON.stringify({ record: { id: "r2" } }));
      else res.end("{}");
    });
  });
  try {
    const p = new DnsservicesProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    // token flow: login first, then Bearer on API calls
    assert.ok(calls[0].url === "/login");
    const apiCall = calls.find((c) => c.url.startsWith("/service/"));
    assert.equal(apiCall.auth, "Bearer tok1");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- ultradns ------------------------------- */

test("ultradns: token acquisition + rrset CRUD", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("/authorization/token")) res.end(JSON.stringify({ access_token: "tok1" }));
      else if (req.url.includes("/rrsets") && req.method === "GET") res.end(JSON.stringify({ rrsets: [{ ownerName: "home.example.com.", rrtype: "A", rdata: ["1.1.1.1"], ttl: 300 }] }));
      else res.end(JSON.stringify({}));
    });
  });
  try {
    const p = new UltradnsProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].name, "home.example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    // token call happened, then Bearer used
    assert.ok(calls.some((c) => c.url.includes("/authorization/token")));
    const rrsetCall = calls.find((c) => c.url.includes("/rrsets"));
    assert.equal(rrsetCall.auth, "Bearer tok1");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- aurora -------------------------------- */

test("aurora: AuroraDNSv1 HMAC signature header + CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, date: req.headers["x-auroradns-date"] });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/zones") res.end(JSON.stringify([{ id: "z1", name: "example.com" }]));
    else if (req.url.includes("/records") && req.method === "GET") res.end(JSON.stringify([{ id: "r1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }]));
    else if (req.method === "POST") res.end(JSON.stringify({ id: "r2" }));
    else res.end("{}");
  });
  try {
    const p = new AuroraProvider({ apiKey: "k", secret: "s", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.match(seen[0].auth, /^AuroraDNSv1 /);
    assert.ok(seen[0].date);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- cloudxns ------------------------------- */

test("cloudxns: API-KEY + API-REQUEST-DATE + API-HASH signed headers", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, key: req.headers["api-key"], date: req.headers["api-request-date"], hash: req.headers["api-hash"] });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/domain") res.end(JSON.stringify({ code: 1, data: [{ id: "d1", domain: "example.com." }] }));
    else if (req.url.includes("/record/") && req.method === "GET") res.end(JSON.stringify({ code: 1, data: [{ record_id: "r1", type: "A", host: "home.example.com", value: "1.1.1.1", ttl: 300 }] }));
    else res.end(JSON.stringify({ code: 1, data: {} }));
  });
  try {
    const p = new CloudxnsProvider({ apiKey: "k", secret: "s", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].key, "k");
    assert.ok(seen[0].date);
    assert.ok(seen[0].hash, "API-HASH present");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- yandex -------------------------------- */

test("yandex: PddToken header + list/add/edit/del", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, token: req.headers.pdttoken, method: req.method });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/list")) res.end(JSON.stringify({ success: "ok", records: [{ record_id: "r1", type: "A", fqdn: "home.example.com", content: "1.1.1.1", ttl: 300 }] }));
    else res.end(JSON.stringify({ success: "ok", record_id: "r2" }));
  });
  try {
    const p = new YandexProvider({ token: "t", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].token, "t");
    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "r2");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- transip ------------------------------- */

test("transip: RSA-signed auth → Bearer → dns CRUD", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ url: req.url, sig: req.headers.signature, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/auth") res.end(JSON.stringify({ token: "tok1" }));
      else if (req.url.includes("/dns") && req.method === "GET") res.end(JSON.stringify({ dnsEntries: [{ id: "1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }] }));
      else res.end(JSON.stringify({}));
    });
  });
  try {
    // minimal RSA key for signing (test-only; transip validates server-side)
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const p = new TransipProvider({ login: "u", privateKeyPem: pem, baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    // auth call signed + Bearer used after
    assert.ok(calls[0].url === "/auth" && calls[0].sig);
    const apiCall = calls.find((c) => c.url.includes("/dns") && c.url !== "/auth");
    assert.equal(apiCall.auth, "Bearer tok1");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- qcloud -------------------------------- */

test("qcloud: TC3-HMAC-SHA256 signed requests + DNSPod CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ action: req.headers["x-tc-action"], auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      const payload = JSON.parse(body);
      if (payload.Keyword) res.end(JSON.stringify({ Response: { DomainList: [{ DomainId: 123 }] } }));
      else if (payload.RecordId === 9) res.end(JSON.stringify({ Response: {} }));
      else if (req.headers["x-tc-action"] === "describerecordlist") res.end(JSON.stringify({ Response: { RecordList: [{ RecordId: 9, Type: "A", Name: "home", Value: "1.1.1.1", TTL: 600 }] } }));
      else res.end(JSON.stringify({ Response: { RecordId: 9 } }));
    });
  });
  try {
    const p = new QcloudProvider({ secretId: "sid", secretKey: "skey", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    // TC3 signature header present
    assert.match(seen[0].auth, /^TC3-HMAC-SHA256 Credential=sid\//);
    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "9");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ hostingde ------------------------------- */

test("hostingde: JSON-RPC recordsFind/Create/Update/Delete with authToken", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("recordsFind")) res.end(JSON.stringify({ status: "success", data: { records: [{ id: "r1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }] } }));
      else if (req.url.includes("recordsCreate")) res.end(JSON.stringify({ status: "success", data: { records: [{ id: "r2" }] } }));
      else res.end(JSON.stringify({ status: "success", data: {} }));
    });
  });
  try {
    const p = new HostingdeProvider({ token: "t", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].body.authToken, "t");
    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "r2");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- wedos --------------------------------- */

test("wedos: wapi auth hash + dns-row commands", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqObj = JSON.parse(new URLSearchParams(body).get("request"));
      seen.push({ command: reqObj.command, user: reqObj.user, auth: reqObj.auth });
      res.writeHead(200, { "content-type": "application/json" });
      if (reqObj.command === "dns-rows-list") res.end(JSON.stringify({ response: { code: 1000, data: { row: [{ ID: "r1", name: "home.example.com", rdtype: "A", rdata: "1.1.1.1", ttl: 300 }] } } }));
      else res.end(JSON.stringify({ response: { code: 1000, data: { id: "r2" } } }));
    });
  });
  try {
    const p = new WedosProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].user, "u");
    assert.ok(seen[0].auth, "auth hash present");
    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "r2");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- nfsn ---------------------------------- */

test("nfsn: X-NFSN-Authentication header + dns CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers["x-nfsn-authentication"] });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/list")) res.end(JSON.stringify([{ id: "r1", type: "A", name: "home.example.com", data: "1.1.1.1" }]));
    else res.end(JSON.stringify({ id: "r2" }));
  });
  try {
    const p = new NfsnProvider({ login: "l", key: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "l:k");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ yandexcloud ------------------------------ */

test("yandexcloud: IAM token + folderId zone lookup + record sets", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/zones?")) res.end(JSON.stringify({ zones: [{ id: "z1" }] }));
    else if (req.url.includes("listRecordSets")) res.end(JSON.stringify({ recordSets: [{ id: "rs1", type: "A", fqdn: "home.example.com.", ttl: "300", data: ["1.1.1.1"] }] }));
    else res.end(JSON.stringify({}));
  });
  try {
    const p = new YandexcloudProvider({ token: "t", folderId: "f", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "Bearer t");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ valuedomain ------------------------------ */

test("valuedomain: Bearer REST /domains/:name/dns", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/dns") && req.method === "GET") res.end(JSON.stringify({ results: [{ id: "r1", type: "A", name: "home.example.com", value: "1.1.1.1", ttl: 300 }] }));
    else res.end(JSON.stringify({ id: "r2" }));
  });
  try {
    const p = new ValuedomainProvider({ token: "t", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "Bearer t");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- rackspace ------------------------------- */

test("rackspace: token acquisition → X-Auth-Token → records", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers["x-auth-token"] });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/tokens")) res.end(JSON.stringify({ access: { token: { id: "tok1" }, user: { tenantId: "ten1" } } }));
    else if (req.url.includes("/domains?name=")) res.end(JSON.stringify({ domains: [{ id: "d1" }] }));
    else if (req.url.includes("/records") && req.method === "GET") res.end(JSON.stringify({ records: [{ id: "r1", type: "A", name: "home.example.com", data: "1.1.1.1", ttl: 300 }] }));
    else res.end(JSON.stringify({}));
  });
  try {
    const p = new RackspaceProvider({ username: "u", apiKey: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    const recordsCall = seen.find((c) => c.url.includes("/records"));
    assert.equal(recordsCall.auth, "tok1");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- memset --------------------------------- */

test("memset: X-Auth-Key + JSON-RPC zone methods", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, key: req.headers["x-auth-key"] });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("dns.zone_domain_info")) res.end(JSON.stringify({ zone_id: "z1" }));
    else if (req.url.includes("dns.zone_info")) res.end(JSON.stringify({ records: [{ id: "r1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }] }));
    else res.end(JSON.stringify({ id: "r2" }));
  });
  try {
    const p = new MemsetProvider({ apiKey: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].key, "k");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- gehirn -------------------------------- */

test("gehirn: Basic auth + zones→versions→records", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/zones") res.end(JSON.stringify({ zones: [{ id: "z1", name: "example.com" }] }));
    else if (req.url.endsWith("/versions")) res.end(JSON.stringify({ versions: [{ id: "v1" }] }));
    else if (req.url.endsWith("/records")) res.end(JSON.stringify({ records: [{ id: "r1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }] }));
    else res.end(JSON.stringify({ id: "r2" }));
  });
  try {
    const p = new GehirnProvider({ token: "t", secret: "s", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.match(seen[0].auth, /^Basic /);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- rcodezero ------------------------------- */

test("rcodezero: Bearer + rrset CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/zones/") res.end(JSON.stringify({ zones: [{ id: "z1", name: "example.com" }] }));
    else if (req.url.includes("/rrsets") && req.method === "GET") res.end(JSON.stringify({ rrsets: [{ name: "home.example.com", type: "A", records: [{ content: "1.1.1.1", disabled: false }], ttl: 300 }] }));
    else res.end(JSON.stringify({}));
  });
  try {
    const p = new RcodezeroProvider({ token: "t", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "Bearer t");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- devnomads ------------------------------- */

test("devnomads: Bearer + rrset REPLACE", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/zones/") res.end(JSON.stringify({ zones: [{ id: "z1", name: "example.com" }] }));
    else if (req.url.includes("/rrsets") && req.method === "GET") res.end(JSON.stringify({ rrsets: [{ name: "home.example.com", type: "A", records: [{ content: "1.1.1.1", disabled: false }], ttl: 600 }] }));
    else res.end(JSON.stringify({}));
  });
  try {
    const p = new DevnomadsProvider({ token: "t", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "Bearer t");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- misaka -------------------------------- */

test("misaka: Token auth + recordsets CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/settings")) res.end(JSON.stringify({ id: "z1" }));
    else if (req.url.includes("/recordsets") && req.method === "GET") res.end(JSON.stringify({ recordsets: [{ name: "home.example.com", type: "A", records: [{ content: "1.1.1.1", disabled: false }], ttl: 300 }] }));
    else res.end(JSON.stringify({}));
  });
  try {
    const p = new MisakaProvider({ token: "t", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "Token t");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- dinahosting ----------------------------- */

test("dinahosting: form API with user/passwd + zone commands", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(Object.fromEntries(new URLSearchParams(body)));
      res.writeHead(200, { "content-type": "application/json" });
      if (seen.at(-1).cmd === "dns_zone_info") res.end(JSON.stringify({ records: [{ id: "r1", type: "A", name: "home.example.com", content: "1.1.1.1", ttl: 300 }] }));
      else res.end(JSON.stringify({}));
    });
  });
  try {
    const p = new DinahostingProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].user, "u");
    assert.equal(seen[0].cmd, "dns_zone_info");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* --------------------------------- joker -------------------------------- */

test("joker: login → auth-sid → dns-zone-get", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "text/plain" });
      if (req.url === "/login") res.end("auth-sid=abc123\n\n");
      else res.end("home.example.com A 1.1.1.1 300\nwww.example.com CNAME home.example.com 300");
    });
  });
  try {
    const p = new JokerProvider({ apiKey: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(listed.length, 2);
    assert.ok(seen[0].body.includes("api-key=k"));
    const zoneCall = seen.find((c) => c.url === "/dns-zone-get");
    assert.ok(zoneCall.body.includes("auth-sid=abc123"));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- powerdns -------------------------------- */

test("powerdns: X-API-Key + rrset PATCH", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["x-api-key"], body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") res.end(JSON.stringify({ records: [{ name: "home.example.com.", type: "A", content: "1.1.1.1", ttl: 300 }] }));
      else res.end("{}");
    });
  });
  try {
    const p = new PowerdnsProvider({ apiKey: "k", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].key, "k");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------ directadmin ------------------------------ */

test("directadmin: CMD_API_DNS_CONTROL basic auth CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("action=list")) res.end(JSON.stringify({ records: [{ name: "home.example.com", type: "A", value: "1.1.1.1", ttl: "300" }] }));
    else res.end(JSON.stringify({ success: "Record Added" }));
  });
  try {
    const p = new DirectadminProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.match(seen[0].auth, /^Basic /);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- infoblox ------------------------------- */

test("infoblox: WAPI basic auth + record CRUD", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("record:a")) res.end(JSON.stringify([{ _ref: "ref1", name: "home.example.com.", ipv4addr: "1.1.1.1", ttl: 300 }]));
    else if (req.method === "POST") res.end(JSON.stringify({ _ref: "ref2" }));
    else res.end("{}");
  });
  try {
    const p = new InfobloxProvider({ username: "u", password: "p", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.equal(seen[0].auth, "Basic " + Buffer.from("u:p").toString("base64"));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* --------------------------------- azure --------------------------------- */

test("azure: OAuth token flow + ARM DNS recordset PUT", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("/oauth2")) res.end(JSON.stringify({ access_token: "tok1" }));
      else if (req.url.includes("/recordsets?")) res.end(JSON.stringify({ value: [{ id: "/sub/rg/dnsZones/example.com/A/home", name: "home", type: "Microsoft.Network/dnszones/A", properties: { TTL: 300, ARecords: [{ ipv4Address: "1.1.1.1" }] } }] }));
      else if (req.method === "PUT") res.end(JSON.stringify({ id: "rec1" }));
      else res.end("{}");
    });
  });
  try {
    const p = new AzureProvider({ clientId: "c", clientSecret: "s", tenantId: "t", subscriptionId: "sub", resourceGroup: "rg", baseUrl: urlOf(srv), authUrl: urlOf(srv) + "/oauth2/token" });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].value, "1.1.1.1");
    const apiCall = seen.find((c) => c.url.includes("/recordsets?") && c.auth);
    assert.equal(apiCall.auth, "Bearer tok1");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------- namecheap ------------------------------ */

test("namecheap: query-param auth (host/domain/password/ip), good/nochg + rejection", async () => {
  const calls = [];
  const srv = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    calls.push(Object.fromEntries(u.searchParams));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(u.searchParams.get("password") === "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6" ? "good 203.0.113.9" : "badauth");
  });
  try {
    const p = new NamecheapProvider({ password: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6", baseUrl: urlOf(srv) });
    await p.pushValue({ name: "home.example.com", type: "A", value: "203.0.113.9" });
    assert.equal(calls[0].host, "home");
    assert.equal(calls[0].domain, "example.com");
    assert.equal(calls[0].ip, "203.0.113.9");
    assert.equal(calls[0].password, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6");

    // bad password → badauth rejection
    const p2 = new NamecheapProvider({ password: "wrong", baseUrl: urlOf(srv) });
    await assert.rejects(() => p2.pushValue({ name: "h.example.com", type: "A", value: "1.2.3.4" }), /badauth/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* -------------------------------- route53 ------------------------------- */

test("route53: SigV4 signs GET rrset + POST changes (XML)", async () => {
  const requests = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/xml" });
      if (req.method === "GET") {
        res.end(`<ListResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ResourceRecordSets><ResourceRecordSet><Name>home.example.com.</Name><Type>A</Type><TTL>300</TTL><ResourceRecords><ResourceRecord><Value>1.1.1.1</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></ResourceRecordSets></ListResourceRecordSetsResponse>`);
      } else {
        res.end(`<ChangeResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeInfo><Id>/change/C1</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`);
      }
    });
  });
  try {
    const p = new Route53Provider({ accessKeyId: "AK", secretAccessKey: "SK", zoneId: "Z123", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "home.example.com.");
    assert.equal(listed[0].value, "1.1.1.1");
    assert.match(requests[0].auth, /^AWS4-HMAC-SHA256 Credential=AK\//);

    const created = await p.createRecord("example.com", { type: "A", name: "new.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "new.example.com./A");
    const post = requests.at(-1);
    assert.match(post.auth, /^AWS4-HMAC-SHA256/);
    assert.match(post.body, /<Action>CREATE<\/Action>/);
    assert.match(post.body, /<Name>new\.example\.com\.<\/Name>/);

    // sigv4 unit: canonical request contains host + payload hash
    const sig = awsSigV4({ method: "GET", host: "route53.amazonaws.com", path: "/2013-04-01/hostedzone/Z123/rrset", body: "", accessKeyId: "AK", secretKey: "SK", now: new Date("2026-01-01T00:00:00Z") });
    assert.ok(sig.authorization.includes("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ---------------------------------- gcp --------------------------------- */

test("gcp: OAuth bearer + managedZones rrsets/changes JSON", async () => {
  const seen = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("/rrsets") && req.method === "GET") {
        res.end(JSON.stringify({ rrsets: [{ name: "home.example.com.", type: "A", ttl: 300, rrdatas: ["1.1.1.1"] }] }));
      } else {
        res.end(JSON.stringify({ id: "change1", status: "pending" }));
      }
    });
  });
  try {
    const p = new GcpProvider({ project: "proj1", zone: "example-com", accessToken: "tok", baseUrl: urlOf(srv) });
    const listed = await p.listRecords("example.com");
    assert.equal(listed[0].name, "home.example.com");
    assert.equal(seen[0].auth, "Bearer tok");
    assert.match(seen[0].url, /projects\/proj1\/managedZones\/example-com\/rrsets/);

    const created = await p.createRecord("example.com", { type: "A", name: "x.example.com", value: "2.2.2.2" });
    assert.equal(created.id, "x.example.com./A");
    const change = JSON.parse(seen.at(-1).body);
    assert.ok(change.additions?.[0]?.name === "x.example.com.");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
