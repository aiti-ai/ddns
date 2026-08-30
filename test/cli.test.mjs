/** CLI smoke tests — drive the built cli.ts against the mocks the same way
 *  a user would (spawn the CLI with a provider pointed at a mock). */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const { startCloudflareMock } = await import("../src/mocks/cloudflare.ts");
const { startDuckdnsMock } = await import("../src/mocks/duckdns.ts");

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr: stderr ?? "" });
    });
  });
}

test("cli: create/list/update/delete against the cloudflare mock", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  const creds = ["--token", "tk", "--zone-id", zoneId, "--base-url", mock.url];
  try {
    const created = await run(["create", "cloudflare", "example.com", "--name", "home.example.com", "--type", "A", "--value", "1.1.1.1", ...creds]);
    assert.equal(created.code, 0, created.stderr);
    const id = JSON.parse(created.stdout).id;
    assert.ok(id);

    const listed = await run(["list", "cloudflare", "example.com", "--type", "A", ...creds]);
    assert.equal(JSON.parse(listed.stdout).length, 1);

    const updated = await run(["update", "cloudflare", "example.com", "--id", id, "--name", "home.example.com", "--type", "A", "--value", "2.2.2.2", ...creds]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(mock.state.zones.get("example.com").records[0].content, "2.2.2.2");

    const deleted = await run(["delete", "cloudflare", "example.com", "--id", id, ...creds]);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(mock.state.zones.get("example.com").records.length, 0);
  } finally {
    await mock.stop();
  }
});

test("cli: delete-by-lookup and unknown provider error", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [{ type: "CNAME", name: "www.example.com", content: "example.com" }] } });
  const zoneId = [...mock.state.zones.values()][0].id;
  const creds = ["--token", "tk", "--zone-id", zoneId, "--base-url", mock.url];
  try {
    const del = await run(["delete", "cloudflare", "example.com", "--name", "www.example.com", "--type", "CNAME", ...creds]);
    assert.equal(JSON.parse(del.stdout).deleted, true);
    assert.equal(mock.state.zones.get("example.com").records.length, 0);

    const bad = await run(["list", "notaprovider", "example.com", ...creds]);
    assert.notEqual(bad.code, 0);
  } finally {
    await mock.stop();
  }
});

test("cli: duckdns push via sync entry file (config + updateEntry path)", async () => {
  const mock = await startDuckdnsMock({ token: "duck" });
  const { writeConfig } = await import("../src/config.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ddns-sync-"));
  try {
    writeConfig(dir, [{ name: "d", provider: "duckdns", record: "mylab", token: "duck", ip: "203.0.113.9", baseUrl: mock.url }]);
    const out = await run(["sync", "--config", join(dir, "ddns.json")]);
    assert.equal(out.code, 0, out.stderr);
    const results = JSON.parse(out.stdout);
    assert.equal(results[0].changed, true);
    assert.equal(mock.state.ips.get("mylab").ipv4, "203.0.113.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await mock.stop();
  }
});
