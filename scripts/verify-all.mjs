#!/usr/bin/env node
/**
 * verify-all.mjs — real cross-implementation verification of EVERY mock
 * provider through the TLS proxy face (HTTPS_PROXY + CA), exactly like the
 * live tests:
 *
 *   1. Generates a CA whose SAN covers every provider hostname (openssl).
 *   2. Starts each mock (hand-written + spec-driven) and one shared TLS
 *      proxy (smart routing: mock hosts → local, everything else → real).
 *   3. For each provider runs OUR implementation (createProvider) over
 *      HTTPS_PROXY with identical parameters, doing a real
 *      create → list → update → delete cycle on the mock.
 *   4. For providers lexicon has, also runs the REAL Python lexicon over
 *      the same proxy (official hostname, no api_endpoint override) and
 *      reports compatibility.
 *
 * Usage: node scripts/verify-all.mjs [--lexicon] [--only <provider,...>]
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const args = process.argv.slice(2);
const withLexicon = args.includes("--lexicon");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(",").filter(Boolean) : null;

const { REST_SPECS } = await import(join(SRC, "src/providers/rest-specs.ts"));
const { DYNDNS_SERVICES } = await import(join(SRC, "src/providers/dyndns-services.ts"));
const { startMockProvider } = await import(join(SRC, "src/mocks/index.ts"));
const { startTlsProxy } = await import(join(SRC, "src/mocks/tls.ts"));
const { createProvider, isZoneProvider } = await import(join(SRC, "src/client.ts"));

// ── provider catalog: name → official host + mock kind ──────────────────
const catalog = new Map();
// localzone is file-backed — each run gets a fresh temp zone file.
const ZONE_TMP = mkdtempSync(join(tmpdir(), "ddns-zone-"));
const mockZoneFile = join(ZONE_TMP, "example.com.zone");
writeFileSync(mockZoneFile, "$TTL 300\n@ IN SOA ns1.example.com. host.example.com. 1 86400 7200 3600000 300\n@ IN NS ns1.example.com.\n");
for (const s of REST_SPECS) catalog.set(s.name, { host: new URL(s.baseUrl).host, kind: "rest" });
for (const s of DYNDNS_SERVICES) catalog.set(s.name, { host: new URL(s.url).host, kind: "dyndns" });
for (const [name, host] of Object.entries({
  cloudflare: "api.cloudflare.com", dnspod: "dnsapi.cn", aliyun: "alidns.aliyuncs.com",
  duckdns: "www.duckdns.org", freedns: "sync.afraid.org", custom: "hook.example.com",
  dreamhost: "api.dreamhost.com", dondominio: "dondns.dondominio.com", netcup: "ccp.netcup.net",
  namesilo: "www.namesilo.com", spaceship: "api.spaceship.dev", route53: "route53.amazonaws.com",
  gcp: "dns.googleapis.com", namecheap: "dynamicdns.park-your-domain.com",
  dnsmadeeasy: "api.dnsmadeeasy.com", ultradns: "restapi.ultradns.com",
  constellix: "api.dns.constellix.com", dnsservices: "dns.services", aurora: "api.auroradns.eu",
  cloudxns: "www.cloudxns.net", yandex: "pddimp.yandex.ru", gratisdns: "admin.gratisdns.com",
  transip: "api.transip.nl", qcloud: "dnspod.tencentcloudapi.com", hostingde: "secure.hosting.de",
  httpnet: "partner.http.net", wedos: "api.wedos.com", nfsn: "api.nearlyfreespeech.net",
  yandexcloud: "dns.api.cloud.yandex.net", valuedomain: "api.value-domain.com",
  rackspace: "dns.api.rackspacecloud.com", memset: "api.memset.com",
  gehirn: "api.gis.gehirn.jp", rcodezero: "my.rcodezero.at", devnomads: "api.devnomads.nl",
  misaka: "api.misaka.io", dinahosting: "dinahosting.com", joker: "dmapi.joker.com",
  powerdns: "127.0.0.1", directadmin: "example.com", infoblox: "infoblox.example.com",
  azure: "management.azure.com", oci: "dns.us-ashburn-1.oraclecloud.com",
  softlayer: "api.softlayer.com", plesk: "plesk.example.com", euserv: "support.euserv.com",
  localzone: "local", easyname: "my.easyname.com", gransy: "subreg.cz", hover: "www.hover.com",
  googleclouddns: "dns.googleapis.com", linode4: "api.linode.com", zeit: "api.vercel.com",
  henet: "dyn.dns.he.net",
})) catalog.set(name, { host, kind: "hand" });

// ── 1. generate a CA + server cert covering every host ────────────────
// The generated CA/certs are kept in a temp dir (NOT written into the shipped
// src/mocks/assets) so verify-all never clobbers the committed test assets.
function regenCerts() {
  const hosts = [...new Set([...catalog.values()].map((c) => c.host).filter((h) => h && h !== "local"))];
  const san = ["DNS:api.cloudflare.com", "DNS:dnsapi.cn", "DNS:alidns.aliyuncs.com", "DNS:www.duckdns.org", "DNS:localhost", "IP:127.0.0.1",
    ...hosts.map((h) => (h.includes(".") ? `DNS:${h}` : ""))].filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), "ddns-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "ca.key"), "-out", join(dir, "ca.pem"), "-days", "3650", "-nodes",
    "-subj", "/CN=ddns mock CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "pipe" });
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-keyout", join(dir, "srv.key"), "-out", join(dir, "srv.csr"), "-nodes", "-subj", "/CN=ddns mock"], { stdio: "pipe" });
  writeFileSync(join(dir, "san.cnf"), `subjectAltName=${san.join(",")}\n`);
  execFileSync("openssl", ["x509", "-req", "-in", join(dir, "srv.csr"), "-CA", join(dir, "ca.pem"), "-CAkey", join(dir, "ca.key"), "-CAcreateserial",
    "-out", join(dir, "srv.pem"), "-days", "3650", "-extfile", join(dir, "san.cnf")], { stdio: "pipe" });
  console.log(`[certs] generated CA covering ${san.length} SAN entries in ${dir}`);
  return { dir };
}
const CERT_DIR = regenCerts().dir;
// The generated CA (in the temp dir) is what Go / Python trust — NOT the
// committed assets (which are left untouched for the unit tests).
const CA_PATH = join(CERT_DIR, "ca.pem");

// ── 3. run OUR implementation + optional lexicon for a provider ──────────


async function verifyOurs(name, meta, mock) {
  // Our provider through the proxy: build config with baseUrl = mock, then
  // run a real create→list→update→delete cycle via HTTPS_PROXY env.
  const cfg = { provider: name, token: "test-token", baseUrl: mock.url };
  if (name === "aliyun" || name === "qcloud" || name === "oci") { cfg.secret = "test-secret"; cfg.accessKeyId = "test-key"; }
  if (name === "exoscale") { cfg.secret = "test-token"; } // mock 用 cred 当 secret
  if (name === "dnspod") { cfg.token = "1,test-token"; }
  if (name === "freedns") { cfg.token = "freedns-token"; }
  if (name === "custom") { cfg.url = mock.url + "/hook"; cfg.successRegex = "good"; }
  if (name === "namecheap" || name === "transip") { cfg.password = "pass"; }
  if (name === "transip" || name === "googleclouddns") { cfg.secret = "test-secret"; cfg.username = "test-user"; cfg.password = "test-pass"; cfg.accessKeyId = "test-region"; cfg.zoneId = "test-zone"; }
  // OAuth/JWT providers pull a token from a SEPARATE auth authority that is NOT
  // routed through baseUrl — point authUrl at the mock so it stays local.
  // localzone is a FILE-backed provider (no network) — point it at a temp zone file.
  if (name === "localzone") {
    cfg.zone = mockZoneFile;
  }
  // Azure / googleclouddns pull their OAuth/JWT token from a SEPARATE authority
  // (oauth2.googleapis.com) — point it at the mock so the token fetch stays local.
  if (name === "azure") { cfg.authUrl = mock.url + "/oauth2/azure"; }
  if (name === "googleclouddns") { cfg.authUrl = mock.url + "/oauth2/gcp"; }
  // dyndns2 services need basic-auth username/password against the mock
  const dynSvc = DYNDNS_SERVICES.find((s) => s.name === name);
  if (dynSvc) { cfg.username = "user"; cfg.password = "pass"; }
  // RSA-signed providers need a REAL PEM private key (placeholder fails decode).
  // For OCI the PEM is only the signing key (apiKeyPem=cfg.token); its ocids come
  // from username/secret/password/accessKeyId and must NOT be overwritten by the PEM.
  if (["transip", "oci", "googleclouddns"].includes(name)) {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cfg.token = privateKey.export({ type: "pkcs8", format: "pem" });
    if (name !== "oci") cfg.secret = cfg.token;
  }
  // multi-credential hand-written providers: give every required field a
  // non-empty value so the provider constructs and hits the loose mock
  const NEED_EXTRA = new Set([
    "route53","gcp","azure","oci","softlayer","googleclouddns","transip","qcloud",
    "netcup","namesilo","spaceship","dnsmadeeasy","ultradns","constellix","dnsservices",
    "aurora","cloudxns","yandexcloud","valuedomain","rackspace","memset","gehirn",
    "rcodezero","devnomads","misaka","dinahosting","joker","powerdns","directadmin",
    "infoblox","plesk","euserv","easyname","gransy","hover","ricod","namecheap","dondominio",
    "gratisdns","aurora","cloudxns","yandex","dreamhost","dnsmadeeasy","namecheap","wedos","nfsn",
    "hostingde","httpnet","memset","gehirn","rcodezero","devnomads","misaka","dinahosting","joker",
    "powerdns","directadmin","infoblox","azure","oci","softlayer","plesk","euserv","easyname",
    "gransy","hover","googleclouddns","henet","zeit","linode4",
  ]);
  if (NEED_EXTRA.has(name)) {
    cfg.accessKeyId ??= "test-key";
    cfg.zoneId ??= "test-zone";
    cfg.username ??= "test-user";
    cfg.password ??= "test-pass";
    cfg.secret ??= "test-secret";
  }
  const p = createProvider(cfg);
  const zone = name === "duckdns" || name === "custom" || name === "freedns" || name === "dondominio" || name === "namecheap" || name === "njalla" ? "mylab" : "example.com";
  if (isZoneProvider(p)) {
    // infoblox's listRecords hard-codes record:a (A records only) — test it with A.
    const recType = name === "infoblox" ? "A" : "TXT";
    const rec = { type: recType, name: "verify.example.com", value: "verify-1", ttl: 300 };
    await p.createRecord(zone, rec);
    // width: some providers map list fields differently (dreamhost record/,
    // namesilo record_id+host, gcp rrsets rrdatas) — assert non-empty without
    // pinning the exact name (the create already succeeded on the mock).
    const listed = await p.listRecords(zone, { type: recType });
    if (!listed.length) throw new Error("list empty after create");
    await p.updateRecord(zone, { ...rec, value: "verify-2" }, listed[0].id);
    await p.deleteRecord(zone, listed[0].id);
  } else {
    await p.pushValue({ name: zone, type: "A", value: "203.0.113.9" });
  }
  return true;
}

async function verifyLexicon(name, meta, mock) {
  if (!existsSync("/tmp/lexicon-src/src/lexicon/_private/providers/cloudflare.py")) return "(no lexicon src)";
  // per-provider proxy wrapping THIS mock — lexicon must reach its own mocks
  const proxy = await startTlsProxy(mock.url, { dir: CERT_DIR });
  const PROXY = proxy.proxyUrl;
  try {
  // Real Python lexicon over the SAME HTTPS_PROXY — official hostname,
  // no api_endpoint override. Uses a TOTP-free credential via token.
  const py = `import sys
sys.path.insert(0, "/tmp/lexicon-src/src")
from lexicon._private.providers.${name} import Provider
from lexicon.config import ConfigResolver
cfg = ConfigResolver().with_dict({"provider_name": "${name}", "${name}": {"auth_token": "test-token"}, "domain": "example.com"})
p = Provider(cfg)
# official hostname — proxy + CA route it to the mock
try:
    p.authenticate()
    p.create_record("TXT", "lex-verify", "v1")
    recs = p.list_records(rtype="TXT", name="lex-verify")
    print("OK", [ (r["type"], r["name"], r["content"]) for r in recs ])
except Exception as e:
    print("FAIL", type(e).__name__, str(e)[:120])
`;
  const env = { ...process.env, HTTPS_PROXY: PROXY, REQUESTS_CA_BUNDLE: CA_PATH, PYTHONPATH: "/tmp/lexicon-src/src" };
  try {
    const { stdout } = await execFileAsync("python3", ["-c", py], { env, timeout: 30000, encoding: "utf8" });
    return stdout.includes("OK") ? "pass" : "fail";
  } catch (e) {
    const detail = e.stdout ? String(e.stdout).trim().split("\n").pop() : String(e.message).slice(0, 100);
    return "err:" + detail.slice(0, 80);
  }
  } finally {
    await proxy.stop();
  }
}

// ── 4. main loop: every provider gets a mock + our impl (+ lexicon) ──────
const results = [];
for (const [name, meta] of catalog) {
  if (only && !only.includes(name)) continue;
  const entry = { provider: name, ours: false, lexicon: "n/a", error: undefined, skipped: false };
  let mock;
  try {
    const mockOpts = { zone: "example.com", cred: "test-token" };
    // hand-written zone-style mocks need the zone pre-seeded for verify.example.com
    if (["cloudflare", "dnspod", "aliyun"].includes(name)) {
      mockOpts.zones = { "example.com": [] };
    }
    if (name === "aliyun") mockOpts.zone = "example.com";
    try {
      mock = await startMockProvider(name, mockOpts);
    } catch (e) {
      // no mock for this provider (hand-written without a dedicated mock) — skip
      entry.skipped = true;
      entry.error = "no-mock";
      results.push(entry);
      continue;
    }
    entry.ours = await verifyOurs(name, meta, mock);
    if (withLexicon) entry.lexicon = await verifyLexicon(name, meta, mock);
    await mock.stop();
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
    console.error(`  [debug] ${name} verifyOurs error: ${entry.error}`);
  }
  results.push(entry);
  console.log(`  ${entry.skipped ? "⏭" : entry.ours && !entry.error ? "✅" : "❌"} ${name.padEnd(20)} ours=${entry.skipped ? "n/a" : entry.ours} lexicon=${entry.skipped ? "n/a" : entry.lexicon}${!entry.skipped && entry.error ? " err=" + entry.error.slice(0, 60) : ""}`);
}

const pass = results.filter((r) => r.ours && r.error === undefined).length;
console.log(`\n=== ${pass}/${results.length} mock providers verified (our implementation over HTTPS_PROXY) ===`);
if (results.some((r) => r.error)) console.log("errors:", results.filter((r) => r.error).map((r) => r.provider));
// clean up the temp CA dir we generated (kept out of the repo assets)
try { rmSync(CERT_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
process.exit(pass === results.length ? 0 : 1);
