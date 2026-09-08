/** duckdns mock — in-memory /v3/update endpoint (GET form like the real
 *  service; "OK"/"KO" responses exactly as duckdns returns them, so Go
 *  ddns-updater and Python lexicon duckdns implementations both work). */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface DuckdnsMockOptions {
  token?: string;
  /** Fixed listen port (default: kernel-assigned free port). */
  port?: number;
}

export interface DuckdnsMockState {
  /** label → { ipv4?, ipv6? } as last pushed. */
  ips: Map<string, { ipv4?: string; ipv6?: string }>;
  requests: Array<{ url: string }>;
}

export interface DuckdnsMockHandle {
  url: string;
  state: DuckdnsMockState;
  stop(): Promise<void>;
}

export async function startDuckdnsMock(opts: DuckdnsMockOptions = {}): Promise<DuckdnsMockHandle> {
  const token = opts.token ?? "test-token";
  const state: DuckdnsMockState = { ips: new Map(), requests: [] };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    state.requests.push({ url: url.pathname + url.search });
    // The real duckdns service keys everything on the token — Go ddns-updater
    // hits /update, lexicon hits /, our client hits /v3/update. Answer every
    // path identically so all three implementations work against the mock.
    const domains = url.searchParams.get("domains") ?? "";
    const tok = url.searchParams.get("token") ?? "";
    const ip = url.searchParams.get("ip");
    const ipv6 = url.searchParams.get("ipv6");
    res.writeHead(200, { "content-type": "text/plain" });

    if (tok !== token) return res.end("KO");
    if (!domains) return res.end("KO");

    for (const label of domains.split(",")) {
      const entry = state.ips.get(label) ?? {};
      if (ip !== null) entry.ipv4 = ip;
      if (ipv6 !== null) entry.ipv6 = ipv6;
      state.ips.set(label, entry);
    }
    res.end("OK");
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
