/** freedns mock — in-memory sync.afraid.org (Go ddns-updater shape:
 *  GET /u/<token>/, response text decides success). Also accepts the
 *  optional ?value= param (the classic afraid.org update API) for clients
 *  that push arbitrary values. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface FreednsMockOptions {
  token?: string;
  /** Response body on success (default "updated 203.0.113.1"). */
  okText?: string;
  port?: number;
}

export interface FreednsMockState {
  requests: Array<{ url: string; token: string | null; value: string | null }>;
}

export interface FreednsMockHandle {
  url: string;
  state: FreednsMockState;
  stop(): Promise<void>;
}

export async function startFreednsMock(opts: FreednsMockOptions = {}): Promise<FreednsMockHandle> {
  const token = opts.token ?? "freedns-token";
  const state: FreednsMockState = { requests: [] };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/u\/([^/]+)\/?$/.exec(url.pathname);
    const tok = m?.[1] ?? null;
    const value = url.searchParams.get("value");
    state.requests.push({ url: url.pathname + url.search, token: tok, value });
    res.writeHead(200, { "content-type": "text/plain" });
    if (tok !== token) return res.end("invalid token");
    res.end(opts.okText ?? "updated 203.0.113.1");
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
