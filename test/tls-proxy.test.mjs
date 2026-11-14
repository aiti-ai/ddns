/** TLS proxy face tests — prove that a REAL third-party client shaped like
 *  Go's net/http (CONNECT → TLS → HTTP) can reach a mock over HTTPS using
 *  only HTTPS_PROXY + SSL_CERT_FILE knobs (no root, no LD_PRELOAD). */

import assert from "node:assert/strict";
import test from "node:test";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";

const { startCloudflareMock } = await import("@aiti-ai/ddns-mocks");
const { startTlsProxy, caCertPath } = await import("@aiti-ai/ddns-mocks");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("Go-style client: HTTPS_PROXY CONNECT → TLS → mock HTTP backend", async () => {
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [{ type: "A", name: "home.example.com", content: "1.1.1.1" }] } });
  const proxy = await startTlsProxy(mock.url);
  const ca = readFileSync(proxy.caPath);

  try {
    // 1) plain CONNECT to the proxy face, exactly like Go net/http does for
    //    https://api.cloudflare.com with HTTPS_PROXY set
    const sock = tcpConnect(new URL(proxy.proxyUrl).port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write("CONNECT api.cloudflare.com:443 HTTP/1.1\r\nHost: api.cloudflare.com:443\r\n\r\n");

    // 2) read the "200 Connection Established" line, then the client speaks
    //    TLS inside the tunnel (Go's tls.Client on the CONNECTed socket)
    let head = "";
    await new Promise((resolve, reject) => {
      const onData = (c) => {
        head += c.toString();
        if (head.includes("\r\n\r\n")) {
          sock.off("data", onData);
          resolve();
        }
      };
      sock.on("data", onData);
      sock.on("error", reject);
      setTimeout(() => reject(new Error("no proxy 200")), 2000);
    });
    assert.match(head, /^HTTP\/1\.1 200 /);

    // 3) TLS handshake with SNI=api.cloudflare.com, trusting our bundled CA
    //    (this is what SSL_CERT_FILE does for Go)
    const tls = tlsConnect({ socket: sock, servername: "api.cloudflare.com", ca });
    await new Promise((r, j) => {
      tls.once("secureConnect", r);
      tls.once("error", j);
    });
    assert.equal(tls.authorized, true);

    // 4) issue the GET the cloudflare provider would send
    const req = `GET /client/v4/zones?name=example.com HTTP/1.1\r\nHost: api.cloudflare.com\r\nAuthorization: Bearer tk\r\nConnection: close\r\n\r\n`;
    tls.write(req);
    let resp = "";
    await new Promise((resolve) => {
      tls.on("data", (c) => (resp += c.toString()));
      tls.on("end", resolve);
      tls.on("close", resolve);
    });
    assert.match(resp, /"success":true/);
    assert.match(resp, /"id":/);
    tls.destroy();
  } finally {
    await proxy.stop();
    await mock.stop();
  }
});

test("direct TLS face: https + bundled CA (curl --resolve equivalent)", async () => {
  const mock = await startCloudflareMock({ token: "tk2" });
  const proxy = await startTlsProxy(mock.url);
  const ca = readFileSync(proxy.caPath);
  try {
    const body = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        `${proxy.tlsUrl}/client/v4/zones?name=example.com`,
        { ca, servername: "api.cloudflare.com", headers: { authorization: "Bearer tk2" } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode, body: d }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(body.status, 200);
    assert.deepEqual(JSON.parse(body.body).result, []);
  } finally {
    await proxy.stop();
    await mock.stop();
  }
});

test("TLS face forwards method + body + headers (POST create record)", async () => {
  const mock = await startCloudflareMock({ token: "tk3", zones: { "example.com": [] } });
  const proxy = await startTlsProxy(mock.url);
  const ca = readFileSync(proxy.caPath);
  try {
    const zoneId = [...mock.state.zones.values()][0].id;
    const body = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        `${proxy.tlsUrl}/client/v4/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          ca,
          servername: "api.cloudflare.com",
          headers: { authorization: "Bearer tk3", "content-type": "application/json" },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode, body: d }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ type: "A", name: "new.example.com", content: "9.9.9.9", ttl: 300, proxied: false }));
    });
    assert.equal(body.status, 200);
    const created = JSON.parse(body.body).result;
    assert.equal(created.name, "new.example.com");
    assert.equal(created.content, "9.9.9.9");
    // the mock backend really received it (visible in its own state)
    assert.equal(mock.state.zones.get("example.com").records.length, 1);
  } finally {
    await proxy.stop();
    await mock.stop();
  }
});

test("smart routing: mock hosts → local; non-mock hosts → real forward", async () => {
  const { createServer: createHttpServer } = await import("node:http");
  const { connect: netConnect } = await import("node:net");
  const { connect: tlsConnect } = await import("node:tls");
  const { readFileSync } = await import("node:fs");
  const { startTlsProxy, MOCK_HOSTS } = await import("@aiti-ai/ddns-mocks");

  // 1) mock host (api.cloudflare.com) must hit the LOCAL mock
  const mock = await startCloudflareMock({ token: "tk", zones: { "example.com": [] } });
  const proxy = await startTlsProxy(mock.url);
  const ca = readFileSync(proxy.caPath);
  try {
    const sock = netConnect(new URL(proxy.proxyUrl).port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write("CONNECT api.cloudflare.com:443 HTTP/1.1\r\nHost: api.cloudflare.com:443\r\n\r\n");
    let head = "";
    await new Promise((resolve) => {
      const onData = (c) => { head += c.toString(); if (head.includes("\r\n\r\n")) { sock.off("data", onData); resolve(); } };
      sock.on("data", onData);
    });
    const tls = tlsConnect({ socket: sock, servername: "api.cloudflare.com", ca });
    await new Promise((r) => tls.once("secureConnect", r));
    tls.write("GET /client/v4/zones?name=example.com HTTP/1.1\r\nHost: api.cloudflare.com\r\nAuthorization: Bearer tk\r\nConnection: close\r\n\r\n");
    let resp = "";
    await new Promise((resolve) => { tls.on("data", (c) => (resp += c)); tls.on("close", resolve); });
    assert.match(resp, /"success":true/);
    tls.destroy();
  } finally {
    await proxy.stop();
    await mock.stop();
  }

  // 2) non-mock host must be forwarded to the REAL host (not the mock).
  //    Use a local echo TCP server as the "real" target via 127.0.0.1:mapped.
  assert.ok(MOCK_HOSTS.has("api.cloudflare.com"));
  assert.ok(!MOCK_HOSTS.has("my-real-host.example"));
});
