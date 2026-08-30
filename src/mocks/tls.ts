/** TLS proxy face for mocks — lets REAL third-party clients (Go
 *  ddns-updater's statically-linked binary, Python lexicon via requests)
 *  reach a mock over HTTPS with zero root and zero LD_PRELOAD:
 *
 *    Go/Python client ──HTTPS_PROXY=proxyUrl──► CONNECT api.cloudflare.com:443
 *        → 200 → TLS ClientHello → bridged to the TLS face → mock HTTP backend
 *
 *  The client only needs two standard Go/requests knobs:
 *    HTTPS_PROXY=http://127.0.0.1:<proxyPort>
 *    SSL_CERT_FILE=<caPath>      (Go)  /  REQUESTS_CA_BUNDLE=<caPath> (Python)
 *
 *  The bundled CA (assets/mock-ca.pem) signs a server cert whose SAN covers
 *  every provider hostname (api.cloudflare.com, dnsapi.cn,
 *  alidns.aliyuncs.com, www.duckdns.org), so TLS verification passes for any
 *  provider while the traffic lands on the local mock.
 */

import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { connect as tcpConnect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");

export function caCertPath(): string {
  return join(ASSETS, "mock-ca.pem");
}

export function serverCertPath(): string {
  return join(ASSETS, "mock-server.pem");
}

export interface TlsProxyHandle {
  /** Direct TLS endpoint: https://127.0.0.1:<port> (curl --resolve works). */
  tlsUrl: string;
  /** HTTP CONNECT proxy endpoint for HTTPS_PROXY. */
  proxyUrl: string;
  /** Bundled CA cert — point SSL_CERT_FILE / REQUESTS_CA_BUNDLE here. */
  caPath: string;
  stop(): Promise<void>;
}

/** Wrap a running mock (its plain-HTTP `url`) with a TLS face + a CONNECT
 *  proxy face. `target` is the mock's base URL (http://127.0.0.1:<port>). */
export async function startTlsProxy(target: string): Promise<TlsProxyHandle> {
  const targetUrl = new URL(target);
  const key = readFileSync(join(ASSETS, "mock-server.key"), "utf8");
  const cert = readFileSync(serverCertPath(), "utf8");

  // --- TLS face: terminates TLS, forwards the plain HTTP request to the mock
  const tlsServer: TlsServer = createTlsServer({ key, cert }, (req, res) => {
    // Rebuild the request against the mock backend, preserving method,
    // URL path/query, headers (authorization etc.) and body.
    const headers = { ...req.headers, host: targetUrl.host };
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const upstream = httpRequest(
        {
          host: targetUrl.hostname,
          port: Number(targetUrl.port),
          method: req.method,
          path: req.url,
          headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("mock backend unreachable");
      });
      if (chunks.length) upstream.write(Buffer.concat(chunks));
      upstream.end();
    });
  });

  // --- CONNECT proxy face: 200, then bridge the raw socket into the TLS face
  let tlsPort = 0;
  const proxyServer: HttpServer = createHttpServer();
  const tunnels = new Set<Socket>();
  proxyServer.on("connect", (req, clientSocket: Socket) => {
    // Standard proxy reply; then the client speaks TLS inside the tunnel —
    // bridge the bytes straight to the TLS face (which terminates TLS).
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSocket: Socket = tcpConnect(tlsPort, "127.0.0.1", () => {
      clientSocket.pipe(tlsSocket);
      tlsSocket.pipe(clientSocket);
    });
    tunnels.add(clientSocket);
    tunnels.add(tlsSocket);
    const drop = () => {
      tunnels.delete(clientSocket);
      tunnels.delete(tlsSocket);
    };
    tlsSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => tlsSocket.destroy());
    clientSocket.on("close", () => { tlsSocket.destroy(); drop(); });
    tlsSocket.on("close", () => { clientSocket.destroy(); drop(); });
  });

  await Promise.all([
    new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", r)),
  ]);
  tlsPort = (tlsServer.address() as { port: number }).port;
  const proxyPort = (proxyServer.address() as { port: number }).port;

  return {
    tlsUrl: `https://127.0.0.1:${tlsPort}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    caPath: caCertPath(),
    stop: async () => {
      for (const s of tunnels) s.destroy();
      tunnels.clear();
      await Promise.all([
        new Promise((r) => tlsServer.close(() => r(undefined))),
        new Promise((r) => proxyServer.close(() => r(undefined))),
      ]);
    },
  };
}
