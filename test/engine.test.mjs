/** Engine + client tests — DDNS update semantics (Go ddns-updater logic:
 *  detect IP → compare → push on change / skip when up-to-date) and
 *  lexicon-style upsert/CRUD orchestration, all against the mocks. */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { updateEntry, runOnce, startLoop } = await import("../src/engine.ts");
const { upsertRecord, createProvider, isPushProvider, isZoneProvider } = await import("../src/client.ts");
const { readConfig, writeConfig, configPath } = await import("../src/config.ts");
const { resolvePublicIp } = await import("../src/ip.ts");
const { startCloudflareMock } = await import("@aiti-ai/ddns-mocks");
const { startDuckdnsMock } = await import("@aiti-ai/ddns-mocks");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("engine: zone provider — create when missing, update on change, skip when up-to-date (Go semantics)", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  const entry = {
    name: "home",
    provider: "cloudflare",
    record: "home.example.com",
    zone: "example.com",
    token: "tk",
    zoneId,
    baseUrl: mock.url,
  };
  try {
    // 1) no record → create, changed
    const r1 = await updateEntry({ ...entry, ip: "1.1.1.1" });
    assert.equal(r1.changed, true);
    assert.equal(r1.ip, "1.1.1.1");
    assert.equal(mock.state.zones.get("example.com").records.length, 1);

    // 2) same IP → skipped unchanged (only the read-back list call, no write)
    const before = mock.state.requests.length;
    const r2 = await updateEntry({ ...entry, ip: "1.1.1.1" });
    assert.equal(r2.skipped, "unchanged");
    assert.equal(mock.state.requests.length, before + 1); // list only, no create/update

    // 3) new IP → update
    const r3 = await updateEntry({ ...entry, ip: "2.2.2.2" });
    assert.equal(r3.changed, true);
    assert.equal(mock.state.zones.get("example.com").records[0].content, "2.2.2.2");

    // 4) enabled:false → disabled; no ip (detection fails) → no-ip
    const r4 = await updateEntry({ ...entry, ip: "1.1.1.1", enabled: false });
    assert.equal(r4.skipped, "disabled");
    const r5 = await updateEntry({ ...entry, ip: undefined }, { detectIp: async () => null });
    assert.equal(r5.skipped, "no-ip");
  } finally {
    await mock.stop();
  }
});

test("engine: push provider (duckdns) pushes unconditionally; errors surface", async () => {
  const mock = await startDuckdnsMock({ token: "duck" });
  try {
    const r1 = await updateEntry({
      name: "d",
      provider: "duckdns",
      record: "mylab",
      token: "duck",
      ip: "203.0.113.9",
      baseUrl: mock.url,
    });
    assert.equal(r1.changed, true);
    assert.equal(mock.state.ips.get("mylab").ipv4, "203.0.113.9");

    // bad token → error on the result, no throw
    const r2 = await updateEntry({ name: "d", provider: "duckdns", record: "mylab", token: "bad", ip: "1.2.3.4", baseUrl: mock.url });
    assert.equal(r2.changed, false);
    assert.match(r2.error ?? "", /duckdns update failed: KO/);
  } finally {
    await mock.stop();
  }
});

test("engine: runOnce aggregates; startLoop fires immediately + on interval", async () => {
  const mock = await startDuckdnsMock({ token: "duck" });
  try {
    const results = await runOnce(
      [
        { name: "a", provider: "duckdns", record: "a", token: "duck", ip: "1.2.3.4", baseUrl: mock.url },
        { name: "b", provider: "duckdns", record: "b", token: "duck", ip: "5.6.7.8", enabled: false, baseUrl: mock.url },
      ],
      {},
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].changed, true);
    assert.equal(results[1].skipped, "disabled");

    const logs = [];
    const loop = startLoop(
      [{ name: "a", provider: "duckdns", record: "a", token: "duck", ip: "1.2.3.4", intervalSec: 30, baseUrl: mock.url }],
      { log: (l) => logs.push(l) },
    );
    await sleep(50); // initial tick settles
    assert.ok(logs.some((l) => l.includes("a: a → 1.2.3.4")));
    loop.stop();
  } finally {
    await mock.stop();
  }
});

test("client: createProvider registry + isPush/isZone + upsert create/update branches", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  const cfg = { provider: "cloudflare", token: "tk", zoneId, baseUrl: mock.url };
  try {
    const p = createProvider(cfg);
    assert.equal(isZoneProvider(p), true);
    assert.equal(isPushProvider(p), false);

    // upsert → create branch
    const c = await upsertRecord(cfg, "example.com", { type: "A", name: "home.example.com", value: "1.1.1.1", ttl: 300 });
    assert.equal(c.created, true);
    assert.equal(mock.state.zones.get("example.com").records.length, 1);

    // upsert → update branch (same name/type, new value)
    const u = await upsertRecord(cfg, "example.com", { type: "A", name: "home.example.com", value: "9.9.9.9" });
    assert.equal(u.created, false);
    assert.equal(mock.state.zones.get("example.com").records[0].content, "9.9.9.9");
  } finally {
    await mock.stop();
  }
});

test("config: read/write round-trip with 0600 perms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ddns-cfg-"));
  try {
    writeConfig(dir, [
      { name: "home", provider: "cloudflare", record: "home.example.com", zone: "example.com", token: "tk" },
    ]);
    assert.ok(existsSync(configPath(dir)));
    if (process.platform !== "win32") assert.equal(statSync(configPath(dir)).mode & 0o777, 0o600);
    const entries = readConfig(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].provider, "cloudflare");
    assert.equal(entries[0].token, "tk");
    // garbage → empty
    rmSync(configPath(dir));
    assert.deepEqual(readConfig(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ip: multi-source fallback and validation", async () => {
  let n = 0;
  const fakeFetch = async (url) => {
    n++;
    if (url.includes("ipify")) return { ok: true, status: 200, text: async () => "not-an-ip", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => "198.51.100.7\n", json: async () => ({}) };
  };
  assert.equal(await resolvePublicIp(4, fakeFetch), "198.51.100.7");
  assert.equal(n, 2); // fell through ipify
  assert.equal(await resolvePublicIp(6, fakeFetch), null); // no valid v6
});
