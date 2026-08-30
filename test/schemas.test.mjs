/** Schema tests — provider parameter definitions (`ddns providers`),
 *  aligned with the service-tunnels ParamSpec shape. */

import assert from "node:assert/strict";
import test from "node:test";

const { providerSchema, providerMetas, providerMeta } = await import("../src/schemas.ts");
const { REST_SPECS } = await import("../src/providers/rest-specs.ts");
const { DYNDNS_SERVICES } = await import("../src/providers/dyndns-services.ts");

test("providerMetas: covers every built-in provider (69 unique names)", () => {
  const metas = providerMetas();
  const names = new Set(metas.map((m) => m.name));
  // all spec-driven providers are present
  for (const s of REST_SPECS) assert.ok(names.has(s.name), `rest spec ${s.name}`);
  for (const s of DYNDNS_SERVICES) assert.ok(names.has(s.name), `dyndns ${s.name}`);
  // hand-written providers are present
  for (const n of ["cloudflare", "dnspod", "aliyun", "duckdns", "custom", "freedns", "route53", "gcp", "netcup", "namesilo", "spaceship", "dreamhost", "dondominio"]) {
    assert.ok(names.has(n), `hand provider ${n}`);
  }
  // shape: every meta has the required fields
  for (const m of metas) {
    assert.ok(m.name && m.style && m.recordTypes.length, `${m.name} basic fields`);
    assert.ok(Array.isArray(m.params), `${m.name} params`);
    for (const p of m.params) {
      assert.ok(p.key, `${m.name}.${p.key} has key`);
      assert.ok(!p.key.includes(" "), `${m.name}.${p.key} key is a config field name`);
    }
  }
});

test("providerSchema: entry + zone + auth params compose correctly", () => {
  // zone provider: entry params + zone + auth
  const cf = providerSchema("cloudflare");
  const keys = cf.map((p) => p.key);
  assert.ok(keys.includes("name") && keys.includes("record") && keys.includes("zone"));
  assert.ok(keys.includes("token") && keys.includes("zoneId") && keys.includes("proxied"));
  const token = cf.find((p) => p.key === "token");
  assert.equal(token.type, "password");
  assert.equal(token.required, true);
  assert.ok(token.link, "cloudflare token has a setup link");

  // push provider (duckdns): no zone
  const dd = providerSchema("duckdns");
  assert.ok(!dd.some((p) => p.key === "zone"));
  assert.ok(dd.some((p) => p.key === "token"));

  // dyndns2: username/password (token-only variant has token)
  const noip = providerSchema("noip");
  assert.ok(noip.some((p) => p.key === "username" && p.required));
  assert.ok(noip.some((p) => p.key === "password" && p.type === "password"));
  const njalla = providerSchema("njalla");
  assert.ok(njalla.some((p) => p.key === "token"));

  // route53: accessKeyId + secret + zoneId all required
  const r53 = providerSchema("route53");
  for (const k of ["accessKeyId", "secret", "zoneId"]) {
    assert.ok(r53.find((p) => p.key === k && p.required), `route53 ${k} required`);
  }
});

test("providerSchema: spec-driven providers get auth params from their spec", () => {
  // rest spec with preLookups (dnsimple) gets accountId
  const ds = providerSchema("dnsimple");
  assert.ok(ds.some((p) => p.key === "accountId"));
  // basic-auth rest provider (luadns) gets password
  const lu = providerSchema("luadns");
  assert.ok(lu.some((p) => p.key === "password"));
});

test("providerMeta: unknown provider returns undefined; CLI path works", async () => {
  assert.equal(providerMeta("no-such-provider"), undefined);
  assert.equal(providerMeta("cloudflare").name, "cloudflare");
});
