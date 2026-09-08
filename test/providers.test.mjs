/** Provider contract tests — every provider runs against ITS OWN mock over
 *  real HTTP, asserting the exact request shapes Go ddns-updater and Python
 *  lexicon rely on (same endpoints, params, response fields). */

import assert from "node:assert/strict";
import test from "node:test";

const { CloudflareProvider } = await import("../src/providers/cloudflare/index.ts");
const { DnspodProvider } = await import("../src/providers/dnspod/index.ts");
const { AliyunProvider } = await import("../src/providers/aliyun/index.ts");
const { DuckdnsProvider } = await import("../src/providers/duckdns/index.ts");
const { CustomProvider } = await import("../src/providers/custom/index.ts");
const { startCloudflareMock } = await import("@aiti-ti/ddns-mocks");
const { startDnspodMock } = await import("@aiti-ti/ddns-mocks");
const { startAliyunMock } = await import("@aiti-ti/ddns-mocks");
const { startDuckdnsMock } = await import("@aiti-ti/ddns-mocks");
const { startCustomMock } = await import("@aiti-ti/ddns-mocks");

/* ----------------------------- cloudflare ------------------------------ */

test("cloudflare: zone lookup → list/create/update/delete (lexicon + Go shapes)", async () => {
  const mock = await startCloudflareMock({
    token: "tk",
    zones: { "example.com": [{ type: "A", name: "home.example.com", content: "1.1.1.1" }] },
  });
  const p = new CloudflareProvider({ token: "tk", baseUrl: mock.url });
  try {
    // list with filter — the request Go sends carries type+name (and page
    // params, which the mock tolerates); lexicon filters client-side too
    const found = await p.listRecords("example.com", { type: "A", name: "home.example.com" });
    assert.equal(found.length, 1);
    assert.equal(found[0].value, "1.1.1.1");
    assert.ok(found[0].id);

    // create — POST with the exact body lexicon/Go send
    const created = await p.createRecord("example.com", { type: "CNAME", name: "www.example.com", value: "example.com", ttl: 300 });
    assert.ok(created.id);
    const rec = mock.state.zones.get("example.com").records.find((r) => r.id === created.id);
    assert.equal(rec.type, "CNAME");
    assert.equal(rec.content, "example.com");

    // update — PUT to /dns_records/:id
    await p.updateRecord("example.com", { type: "A", name: "home.example.com", value: "2.2.2.2", ttl: 120 }, found[0].id);
    assert.equal(mock.state.zones.get("example.com").records.find((r) => r.id === found[0].id).content, "2.2.2.2");

    // delete — DELETE /dns_records/:id
    await p.deleteRecord("example.com", found[0].id);
    assert.equal(mock.state.zones.get("example.com").records.length, 1);

    // bad token → ProviderError with API code
    const bad = new CloudflareProvider({ token: "nope", baseUrl: mock.url });
    await assert.rejects(() => bad.listRecords("example.com"), /9109: Invalid Token/);
  } finally {
    await mock.stop();
  }
});

test("cloudflare: zoneId override skips the zone lookup", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const realZoneId = [...mock.state.zones.values()][0].id;
  const p = new CloudflareProvider({ token: "tk", zoneId: realZoneId, baseUrl: mock.url });
  try {
    // no /zones lookup happened: directly hit dns_records with the pinned id
    await p.listRecords("example.com");
    assert.ok(mock.state.requests.every((r) => !r.url.startsWith("/client/v4/zones?")));
  } finally {
    await mock.stop();
  }
});

/* ------------------------------- dnspod -------------------------------- */

test("dnspod: Domain.Info auth (lexicon) + Record CRUD (lexicon + Go shapes)", async () => {
  const mock = await startDnspodMock({
    token: "10001,secrettok",
    records: [{ name: "home.example.com", type: "A", value: "1.1.1.1" }],
  });
  const p = new DnspodProvider({ token: "10001,secrettok", baseUrl: mock.url });
  try {
    // lexicon's authenticate() flow: POST /Domain.Info with login_token
    const info = await p.listRecords("example.com", {});
    assert.equal(info.length, 1);
    assert.equal(info[0].value, "1.1.1.1");

    const created = await p.createRecord("example.com", { type: "A", name: "lab.example.com", value: "3.3.3.3", ttl: 600 });
    assert.ok(created.id);

    // the mock recorded a form body with login_token + record_line 默认
    const createReq = mock.state.requests.find((r) => r.action === "Record.Create");
    assert.equal(createReq.params.get("login_token"), "10001,secrettok");
    assert.equal(createReq.params.get("sub_domain"), "lab");
    assert.equal(createReq.params.get("record_line"), "默认");
    assert.equal(createReq.params.get("value"), "3.3.3.3");

    await p.updateRecord("example.com", { type: "A", name: "home.example.com", value: "5.5.5.5" }, info[0].id);
    const modReq = mock.state.requests.find((r) => r.action === "Record.Modify");
    assert.equal(modReq.params.get("record_id"), info[0].id);
    assert.equal(modReq.params.get("value"), "5.5.5.5");

    await p.deleteRecord("example.com", created.id);
    assert.equal(mock.state.requests.some((r) => r.action === "Record.Remove"), true);
    assert.equal(mock.state.records.length, 1);

    // bad token → dnspod error code
    const bad = new DnspodProvider({ token: "1,no", baseUrl: mock.url });
    await assert.rejects(() => bad.listRecords("example.com"), /Invalid Token/);
  } finally {
    await mock.stop();
  }
});

/* ------------------------------- aliyun -------------------------------- */

test("aliyun: signed RPC — mock verifies HMAC, CRUD flows (Go shape)", async () => {
  const mock = await startAliyunMock({
    accessKeyId: "AKID",
    accessKeySecret: "SK",
    zone: "example.com",
    records: [{ rr: "home", type: "A", value: "1.1.1.1" }],
  });
  const p = new AliyunProvider({ accessKeyId: "AKID", accessKeySecret: "SK", baseUrl: mock.url });
  try {
    const found = await p.listRecords("example.com", { type: "A", name: "home.example.com" });
    assert.equal(found.length, 1);
    assert.equal(found[0].value, "1.1.1.1");
    // every request carried a valid signature (mock recomputes and rejects bad ones)
    assert.ok(mock.state.requests.every((r) => r.signatureValid === true));

    const created = await p.createRecord("example.com", { type: "A", name: "lab.example.com", value: "3.3.3.3" });
    assert.ok(created.id);
    assert.equal(mock.state.requests.at(-1).action, "AddDomainRecord");

    await p.updateRecord("example.com", { type: "A", name: "home.example.com", value: "5.5.5.5" }, found[0].id);
    assert.equal(mock.state.requests.at(-1).action, "UpdateDomainRecord");
    assert.equal(mock.state.records.find((r) => r.recordId === found[0].id).value, "5.5.5.5");

    await p.deleteRecord("example.com", created.id);
    assert.equal(mock.state.requests.at(-1).action, "DeleteDomainRecord");

    // wrong secret → signature mismatch rejected by the mock
    const bad = new AliyunProvider({ accessKeyId: "AKID", accessKeySecret: "WRONG", baseUrl: mock.url });
    await assert.rejects(() => bad.listRecords("example.com"), /signature is not matched/i);
  } finally {
    await mock.stop();
  }
});

/* ------------------------------- duckdns ------------------------------- */

test("duckdns: push A/AAAA via the update endpoint (Go + lexicon shape)", async () => {
  const mock = await startDuckdnsMock({ token: "duck-tok" });
  const p = new DuckdnsProvider({ token: "duck-tok", baseUrl: mock.url });
  try {
    await p.pushValue({ name: "mylab", type: "A", value: "203.0.113.9" });
    assert.equal(mock.state.ips.get("mylab").ipv4, "203.0.113.9");
    const req = mock.state.requests[0];
    assert.equal(new URL(`http://x${req.url}`).searchParams.get("domains"), "mylab");

    await p.pushValue({ name: "mylab", type: "AAAA", value: "2001:db8::1" });
    assert.equal(mock.state.ips.get("mylab").ipv6, "2001:db8::1");

    // bad token → KO surfaced
    const bad = new DuckdnsProvider({ token: "wrong", baseUrl: mock.url });
    await assert.rejects(() => bad.pushValue({ name: "mylab", type: "A", value: "1.2.3.4" }), /duckdns update failed: KO/);
  } finally {
    await mock.stop();
  }
});

/* -------------------------------- custom ------------------------------- */

test("custom: webhook URL gets the ipv4/ipv6 query keys, success_regex gates (Go shape)", async () => {
  const mock = await startCustomMock({ responseText: "good" });
  const p = new CustomProvider({ url: `${mock.url}?domain=mylab&token=t`, ipv4key: "ipv4", ipv6key: "ipv6", successRegex: "good" });
  try {
    await p.pushValue({ name: "mylab", type: "A", value: "203.0.113.9" });
    const req = mock.state.requests[0];
    assert.equal(req.query.get("domain"), "mylab");
    assert.equal(req.query.get("ipv4"), "203.0.113.9");
    assert.equal(req.query.get("ipv6"), null);

    // AAAA → ipv6 key
    await p.pushValue({ name: "mylab", type: "AAAA", value: "2001:db8::1" });
    assert.equal(mock.state.requests[1].query.get("ipv6"), "2001:db8::1");

    // response not matching success_regex → error
    const p2 = new CustomProvider({ url: mock.url, successRegex: "updated" });
    await assert.rejects(() => p2.pushValue({ name: "mylab", type: "A", value: "1.2.3.4" }), /does not match successRegex/);
  } finally {
    await mock.stop();
  }
});
