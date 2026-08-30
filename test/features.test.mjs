/** freedns / beacon / serve tests — the remaining feature surface:
 *  freedns push semantics (Go response-text rules), beacon arbitrary-value
 *  sync (dimension-2), serve mode status API. */

import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";

const { FreednsProvider } = await import("../src/providers/freedns/index.ts");
const { startFreednsMock } = await import("../src/mocks/freedns.ts");
const { setBeacon, beaconValue } = await import("../src/beacon.ts");
const { startServe } = await import("../src/serve.ts");
const { startCloudflareMock } = await import("../src/mocks/cloudflare.ts");
const { startDuckdnsMock } = await import("../src/mocks/duckdns.ts");
const { updateEntry } = await import("../src/engine.ts");

/* ------------------------------- freedns ------------------------------- */

test("freedns: push via /u/<token>/, response text rules (Go shape)", async () => {
  const mock = await startFreednsMock({ token: "ftok", okText: "updated 203.0.113.1" });
  const p = new FreednsProvider({ token: "ftok", baseUrl: mock.url });
  try {
    await p.pushValue({ name: "home.example.com", type: "A", value: "203.0.113.1" });
    assert.equal(mock.state.requests.length, 1);
    assert.match(mock.state.requests[0].url, /^\/u\/ftok\//);

    // "no ip change detected" is a success (Go treats it as up-to-date)
    const mock2 = await startFreednsMock({ token: "ftok", okText: "no ip change detected" });
    const p2 = new FreednsProvider({ token: "ftok", baseUrl: mock2.url });
    await p2.pushValue({ name: "x", type: "A", value: "1.2.3.4" });
    await mock2.stop();

    // unknown response → error
    const mock3 = await startFreednsMock({ token: "ftok", okText: "something else" });
    const p3 = new FreednsProvider({ token: "ftok", baseUrl: mock3.url });
    await assert.rejects(() => p3.pushValue({ name: "x", type: "A", value: "1.2.3.4" }), /something else/);
    await mock3.stop();

    // bad token → invalid token response → unknown-response error
    const p4 = new FreednsProvider({ token: "wrong", baseUrl: mock.url });
    await assert.rejects(() => p4.pushValue({ name: "x", type: "A", value: "1.2.3.4" }), /invalid token/);
  } finally {
    await mock.stop();
  }
});

test("engine: freedns entry works through the generic DDNS path", async () => {
  const mock = await startFreednsMock({ token: "ftok" });
  try {
    const r = await updateEntry({ name: "fd", provider: "freedns", record: "home.example.com", token: "ftok", ip: "1.2.3.4", baseUrl: mock.url });
    assert.equal(r.changed, true);
    assert.equal(mock.state.requests.length, 1);
  } finally {
    await mock.stop();
  }
});

/* -------------------------------- beacon ------------------------------- */

test("beaconValue: CNAME strips scheme/path; TXT keeps raw input", () => {
  assert.equal(beaconValue("https://abc123.trycloudflare.com/foo", "CNAME"), "abc123.trycloudflare.com");
  assert.equal(beaconValue("abc123.trycloudflare.com", "CNAME"), "abc123.trycloudflare.com");
  assert.equal(beaconValue("https://abc.trycloudflare.com", "TXT"), "https://abc.trycloudflare.com");
});

test("beacon: create CNAME → update on value change → skip when in sync", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  const provider = { provider: "cloudflare", token: "tk", zoneId, baseUrl: mock.url };
  try {
    // create
    const r1 = await setBeacon({ provider, zone: "example.com", name: "discover.example.com", type: "CNAME", value: "https://abc123.trycloudflare.com" });
    assert.equal(r1.created, true);
    assert.equal(r1.value, "abc123.trycloudflare.com");
    assert.equal(mock.state.zones.get("example.com").records[0].type, "CNAME");

    // same value → no write (skip)
    const before = mock.state.requests.length;
    const r2 = await setBeacon({ provider, zone: "example.com", name: "discover.example.com", type: "CNAME", value: "abc123.trycloudflare.com" });
    assert.equal(r2.created, false);
    assert.equal(mock.state.requests.length, before + 1); // list only

    // new value → update
    const r3 = await setBeacon({ provider, zone: "example.com", name: "discover.example.com", type: "CNAME", value: "def456.trycloudflare.com" });
    assert.equal(r3.created, false);
    assert.equal(mock.state.zones.get("example.com").records[0].content, "def456.trycloudflare.com");

    // TXT beacon holds a full URL
    await setBeacon({ provider, zone: "example.com", name: "discover-txt.example.com", type: "TXT", value: "https://def456.trycloudflare.com" });
    const txt = mock.state.zones.get("example.com").records.find((r) => r.name === "discover-txt.example.com");
    assert.equal(txt.type, "TXT");
    assert.equal(txt.content, "https://def456.trycloudflare.com");
  } finally {
    await mock.stop();
  }
});

test("beacon: push-style provider rejected with a clear error", async () => {
  const mock = await startDuckdnsMock({ token: "duck" });
  try {
    await assert.rejects(
      () => setBeacon({ provider: { provider: "duckdns", token: "duck", baseUrl: mock.url }, zone: "x", name: "b.example.com", value: "h.example.com" }),
      /beacon requires a zone-style provider/,
    );
  } finally {
    await mock.stop();
  }
});

/* --------------------------------- serve -------------------------------- */

test("serve: status API reports entries + last run; POST /update triggers", async () => {
  const mock = await startDuckdnsMock({ token: "duck" });
  const serve = await startServe({
    entries: [{ name: "d", provider: "duckdns", record: "mylab", token: "duck", ip: "203.0.113.9", intervalSec: 300, baseUrl: mock.url }],
    log: () => {},
  });
  try {
    // initial loop tick already ran; poll until lastRun appears
    let st = serve.status();
    const deadline = Date.now() + 3000;
    while (!st.lastRun && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      st = serve.status();
    }
    assert.ok(st.lastRun, "initial tick completed");
    assert.equal(st.entries.length, 1);
    assert.equal(st.entries[0].record, "mylab");
    assert.equal(st.lastRun[0].changed, true);

    // GET /status over HTTP
    const body = await new Promise((resolve, reject) => {
      httpRequest(`${serve.url}/status`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }).on("error", reject).end();
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.running, true);
    assert.equal(parsed.entries[0].name, "d");

    // POST /update triggers a run
    const res2 = await new Promise((resolve, reject) => {
      const req = httpRequest(`${serve.url}/update`, { method: "POST" }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(res2.status, 200);
    assert.equal(JSON.parse(res2.body)[0].name, "d");

    // WebUI root serves HTML
    const web = await new Promise((resolve, reject) => {
      httpRequest(`${serve.url}/`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, ct: res.headers["content-type"], body: d }));
      }).on("error", reject).end();
    });
    assert.equal(web.status, 200);
    assert.match(web.ct, /text\/html/);
    assert.match(web.body, /<h1>ddns<\/h1>/);
    assert.match(web.body, /Update now/);

    // unknown path → 404
    const res3 = await new Promise((resolve, reject) => {
      httpRequest(`${serve.url}/nope`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }).on("error", reject).end();
    });
    assert.equal(res3, 404);
  } finally {
    await serve.stop();
    await mock.stop();
  }
});
