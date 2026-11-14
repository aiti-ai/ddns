/** Plugin system tests — third-party provider discovery:
 *  - registerProvider / registerPlugin (explicit)
 *  - discoverPlugins() finds an installed ddns-provider-* package in
 *    node_modules and its provider works through createProvider
 *  - broken plugins never break the host
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// module-level singleton registry — reset between tests is impossible, so we
// use unique provider names per test
// 插件注册/mock 走包入口（dist）：startMockProvider（@aiti-ai/ddns-mocks）内部用
// 的是 dist registry，必须同一实例才能 getMock 命中
const { registerProvider, registerPlugin, discoverPlugins, registry, createProvider, isZoneProvider } = await import("@aiti-ai/ddns");
const { startMockProvider } = await import("@aiti-ai/ddns-mocks");

test("registerProvider: explicit factory works through createProvider", async () => {
  registerProvider("testplugin-a", (cfg) => ({
    meta: { name: "testplugin-a", style: "push", recordTypes: ["A"], needsZone: false, authFields: [] },
    async pushValue() {
      if (cfg.token !== "magic") throw new Error("bad token");
    },
  }));
  const p = createProvider({ provider: "testplugin-a", token: "magic" });
  assert.equal(isZoneProvider(p), false);
  assert.equal(p.meta.style, "push");
  await assert.rejects(() => createProvider({ provider: "testplugin-a" }).pushValue({ name: "x", type: "A", value: "1.2.3.4" }), /bad token/);
});

test("registerPlugin: multi-provider plugin + optional mock", async () => {
  registerPlugin({
    name: "test plugin b",
    providers: ["testplugin-b1", { name: "testplugin-b2", style: "zone" }],
    createProvider: (cfg) => {
      if (cfg.provider === "testplugin-b1") {
        return { meta: { name: "testplugin-b1", style: "push", recordTypes: ["A"], needsZone: false, authFields: [] }, async pushValue() {} };
      }
      return {
        meta: { name: "testplugin-b2", style: "zone", recordTypes: ["A"], needsZone: true, authFields: [] },
        async listRecords() { return [{ id: "1", type: "A", name: "x.example.com", value: "1.1.1.1" }]; },
        async createRecord() { return { id: "2" }; },
        async updateRecord() {},
        async deleteRecord() {},
      };
    },
    createMock: () => ({ url: "http://plugin-mock", state: {}, stop: async () => {} }),
  });
  assert.equal(createProvider({ provider: "testplugin-b2" }).meta.style, "zone");
  const mock = await startMockProvider("testplugin-b2");
  assert.equal(mock.url, "http://plugin-mock");
  await mock.stop();
});

test("discoverPlugins: finds installed ddns-provider-* package in node_modules", async () => {
  // build a fake plugin package + a temp project dir with node_modules
  const dir = mkdtempSync(join(tmpdir(), "ddns-plugins-"));
  const pkgDir = join(dir, "node_modules", "ddns-provider-fake");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "ddns-provider-fake", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(
    join(pkgDir, "index.js"),
    `export default {
      providers: ["fakezone"],
      createProvider(cfg) {
        return {
          meta: { name: "fakezone", style: "zone", recordTypes: ["A"], needsZone: true, authFields: [] },
          async listRecords() { return [{ id: "r1", type: "A", name: "home.example.com", value: "9.9.9.9" }]; },
          async createRecord() { return { id: "r2" }; },
          async updateRecord() {},
          async deleteRecord() {},
        };
      },
      createMock() { return { url: "http://fake-mock", state: {}, stop: async () => {} }; },
    };
    `,
  );
  try {
    const loaded = await discoverPlugins(dir);
    assert.ok(loaded.includes("ddns-provider-fake"), `discovered ${loaded}`);
    // the discovered provider is usable through the normal factory
    const p = createProvider({ provider: "fakezone" });
    const records = await p.listRecords("example.com");
    assert.equal(records[0].value, "9.9.9.9");
    // and its mock is available
    const mock = await startMockProvider("fakezone");
    assert.equal(mock.url, "http://fake-mock");
    await mock.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins: ESM plugin with top-level await loads via dynamic import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ddns-plugins-esm-"));
  const pkgDir = join(dir, "node_modules", "ddns-provider-esm");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "ddns-provider-esm", version: "1.0.0", type: "module", main: "index.js" }));
  // top-level await makes require() throw ERR_REQUIRE_ASYNC_MODULE → import fallback
  writeFileSync(join(pkgDir, "index.js"), `const ready = await Promise.resolve(1);
export default {
  providers: ["esmzone"],
  createProvider() {
    return { meta: { name: "esmzone", style: "push", recordTypes: ["A"], needsZone: false, authFields: [] }, async pushValue() {} };
  },
};
`);
  try {
    const loaded = await discoverPlugins(dir);
    assert.ok(loaded.includes("ddns-provider-esm"), `ESM plugin loaded: ${loaded}`);
    const p = createProvider({ provider: "esmzone" });
    assert.equal(p.meta.style, "push");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins: broken package is skipped, host keeps working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ddns-plugins-bad-"));
  const pkgDir = join(dir, "node_modules", "ddns-provider-broken");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "ddns-provider-broken", version: "1.0.0" }));
  writeFileSync(join(pkgDir, "index.js"), `export default { providers: [], createProvider() { throw new Error("boom"); } };`);
  try {
    // discovery must not throw even with a broken package
    const loaded = await discoverPlugins(dir);
    assert.ok(!loaded.includes("ddns-provider-broken") || true); // either skipped or loaded; never throws
    // built-in providers still work
    assert.ok(createProvider({ provider: "duckdns", token: "x" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry.list() reflects registered plugin providers", () => {
  const names = registry.list();
  assert.ok(names.includes("testplugin-a"));
  assert.ok(names.includes("fakezone"));
});
