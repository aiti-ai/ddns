/** custom mock — a generic webhook endpoint for the custom provider (Go
 *  ddns-updater custom semantics): records every request's query params and
 *  returns a configurable response body so success_regex matching can be
 *  tested both ways. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface CustomMockOptions {
  /** Fixed listen port (default: kernel-assigned free port). */
  port?: number;
  /** Response body for every request (default "good"). */
  responseText?: string;
  /** HTTP status for every request (default 200). */
  status?: number;
}

export interface CustomMockState {
  requests: Array<{ url: string; query: URLSearchParams }>;
}

export interface CustomMockHandle {
  url: string;
  state: CustomMockState;
  stop(): Promise<void>;
}

export async function startCustomMock(opts: CustomMockOptions = {}): Promise<CustomMockHandle> {
  const state: CustomMockState = { requests: [] };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    state.requests.push({ url: url.pathname + url.search, query: url.searchParams });
    res.writeHead(opts.status ?? 200, { "content-type": "text/plain" });
    res.end(opts.responseText ?? "good");
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/update`,
    state,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
