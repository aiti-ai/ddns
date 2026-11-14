/** Spec-driven provider tests — every data-driven provider (REST specs +
 *  dyndns2 services) runs against its generic mock, verifying the same
 *  contract the Go / lexicon implementations rely on:
 *    zone-style: list → create → update → delete (auth header, paths)
 *    push-style: hostname/myip params + basic auth + success parsing */

import assert from "node:assert/strict";
import test from "node:test";

const { REST_SPECS } = await import("../src/providers/rest-specs.ts");
const { DYNDNS_SERVICES } = await import("../src/providers/dyndns-services.ts");
const { RestProvider } = await import("../src/providers/rest.ts");
const { DyndnsProvider } = await import("../src/providers/dyndns.ts");
const { startRestMock } = await import("@aiti-ai/ddns-mocks");
const { startDyndnsMock } = await import("@aiti-ai/ddns-mocks");

for (const spec of REST_SPECS) {
  test(`[rest] ${spec.name}: CRUD against its generic mock`, async () => {
    const mock = await startRestMock({ spec, zone: "example.com", cred: "test-token" });
    const cfg = spec.name === "exoscale"
      ? { provider: spec.name, token: "test-token", secret: "test-token", baseUrl: mock.url }
      : { provider: spec.name, token: "test-token", baseUrl: mock.url };
    const p = new RestProvider(spec, cfg);
    try {
      // list (empty)
      const empty = await p.listRecords("example.com");
      assert.deepEqual(empty, [], `${spec.name} fresh list`);

      // create
      const created = await p.createRecord("example.com", { type: "A", name: "home.example.com", value: "1.1.1.1", ttl: 300 });
      assert.ok(created.id !== undefined, `${spec.name} create returned id`);
      const listed = await p.listRecords("example.com");
      assert.equal(listed.length, 1, `${spec.name} list after create`);
      assert.equal(listed[0].value, "1.1.1.1", `${spec.name} value roundtrip`);

      // update (id from the list — some APIs return no create id, e.g. gandi)
      const rid = listed[0].id;
      assert.ok(rid, `${spec.name} listed record has an id`);
      await p.updateRecord("example.com", { type: "A", name: "home.example.com", value: "2.2.2.2", ttl: 300 }, rid);
      const after = await p.listRecords("example.com", { type: "A", name: "home.example.com" });
      assert.equal(after[0].value, "2.2.2.2", `${spec.name} update applied`);

      // delete
      await p.deleteRecord("example.com", rid);
      assert.equal((await p.listRecords("example.com")).length, 0, `${spec.name} delete applied`);

      // auth is enforced (query/body-style auth like porkbun/cloudns is
      // checked provider-side, not by the generic mock — skip those)
      if (spec.auth.type !== "query" && spec.auth.type !== "body") {
        const bad = new RestProvider(spec, { provider: spec.name, token: "wrong", baseUrl: mock.url });
        await assert.rejects(() => bad.listRecords("example.com"), /401|unauthorized/i);
      }
    } finally {
      await mock.stop();
    }
  });
}

for (const spec of DYNDNS_SERVICES) {
  test(`[dyndns] ${spec.name}: update push (hostname/myip + auth + response parsing)`, async () => {
    const auth = spec.tokenOnly ? undefined : "user:pass";
    const okPrefix = spec.successPrefixes[0] ?? "good";
    const mock = await startDyndnsMock({ auth, okText: `${okPrefix} 203.0.113.1` });
    const username = spec.tokenOnly ? "" : "user";
    const password = spec.tokenOnly ? "pass" : "pass";
    const p = new DyndnsProvider(spec, { username, password, baseUrl: mock.url });
    try {
      await p.pushValue({ name: "home.example.com", type: "A", value: "203.0.113.1" });
      assert.equal(mock.state.requests.length, 1);
      const r = mock.state.requests[0];
      assert.equal(r.hostname, "home.example.com");
      assert.equal(r.myip, "203.0.113.1");
      if (!spec.tokenOnly) {
        assert.equal(r.auth, `Basic ${Buffer.from("user:pass").toString("base64")}`);
      }

      // no-change response → success too (use the spec's own prefix)
      const noChangePrefix = spec.noChangePrefixes?.[0] ?? "nochg";
      const mock2 = await startDyndnsMock({ auth, okText: `${noChangePrefix} 203.0.113.1` });
      const p2 = new DyndnsProvider(spec, { username, password, baseUrl: mock2.url });
      await p2.pushValue({ name: "x.example.com", type: "A", value: "1.2.3.4" });
      await mock2.stop();

      // badauth → error
      const mock3 = await startDyndnsMock({ auth, okText: "badauth" });
      const p3 = new DyndnsProvider(spec, { username, password, baseUrl: mock3.url });
      await assert.rejects(() => p3.pushValue({ name: "x", type: "A", value: "1.2.3.4" }), /badauth/);
      await mock3.stop();
    } finally {
      await mock.stop();
    }
  });
}

// AAAA → v6 host variant (freedns-style), verified via injected fetch
test("[dyndns] IPv6 uses v6 host when the spec declares one", async () => {
  const base = DYNDNS_SERVICES.find((s) => s.name === "he");
  assert.ok(base, "he spec exists");
  const spec = { ...base, v6Host: "dyn6.dns.he.net" };
  let seen = "";
  const fakeFetch = async (url) => {
    seen = url;
    return { ok: true, status: 200, text: async () => "good", json: async () => ({}) };
  };
  const p = new DyndnsProvider(spec, { username: "u", password: "p", fetchImpl: fakeFetch });
  await p.pushValue({ name: "h.example.com", type: "AAAA", value: "2001:db8::1" });
  assert.match(seen, /^https:\/\/dyn6\.dns\.he\.net\//);
  assert.equal(new URL(seen).searchParams.get("myip"), "2001:db8::1");
});
