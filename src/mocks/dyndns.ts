/** Generic dyndns2 mock — serves any of the update-only services: checks
 *  basic auth (when configured), records hostname/myip, and returns a
 *  configurable body so success/nochg/error semantics can be tested. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface DyndnsMockOptions {
  /** Require this basic-auth credential ("user:pass"). Empty = skip auth. */
  auth?: string;
  /** Response body (default "good 1.2.3.4"). */
  okText?: string;
  /** Response body when no basic auth matches (default "badauth"). */
  badAuthText?: string;
  port?: number;
}

export interface DyndnsMockState {
  requests: Array<{ url: string; hostname: string | null; myip: string | null; auth: string | null }>;
}

export interface DyndnsMockHandle {
  url: string;
  state: DyndnsMockState;
  stop(): Promise<void>;
}

export async function startDyndnsMock(opts: DyndnsMockOptions = {}): Promise<DyndnsMockHandle> {
  const state: DyndnsMockState = { requests: [] };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization ?? null;
    const expected = opts.auth ? `Basic ${Buffer.from(opts.auth).toString("base64")}` : null;
    state.requests.push({
      url: url.pathname + url.search,
      hostname: url.searchParams.get("hostname"),
      myip: url.searchParams.get("myip"),
      auth,
    });
    res.writeHead(200, { "content-type": "text/plain" });
    if (expected && auth !== expected) return res.end(opts.badAuthText ?? "badauth");
    res.end(opts.okText ?? "good 203.0.113.1");
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
