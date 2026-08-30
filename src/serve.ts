/** Serve mode — ddns-updater style long-running process: update loop plus a
 *  small HTTP status API (GET /status, POST /update). What the WebUI is to
 *  ddns-updater, this endpoint is to ddns. */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { startLoop, type DdnsEntry, type DdnsResult, type DdnsDeps } from "./engine.ts";

export interface ServeOptions {
  entries: DdnsEntry[];
  /** Status API port (default 0 = kernel-assigned). */
  port?: number;
  log?: (line: string) => void;
  deps?: DdnsDeps;
}

export interface ServeStatus {
  running: boolean;
  entries: Array<{ name: string; provider: string; record: string; enabled: boolean }>;
  lastRun: DdnsResult[] | null;
  lastRunAt: number | null;
  uptimeMs: number;
}

export interface ServeHandle {
  /** Base URL of the status API (http://127.0.0.1:<port>). */
  url: string;
  status(): ServeStatus;
  /** Manually trigger a full update run. */
  triggerUpdate(): Promise<DdnsResult[]>;
  stop(): Promise<void>;
}

export async function startServe(opts: ServeOptions): Promise<ServeHandle> {
  const startedAt = Date.now();
  let lastRun: DdnsResult[] | null = null;
  let lastRunAt: number | null = null;

  const loop = startLoop(opts.entries, {
    ...opts.deps,
    log: opts.log,
    onResults: (results) => {
      lastRun = results;
      lastRunAt = Date.now();
    },
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-type", "application/json");
    if ((url.pathname === "/" || url.pathname === "/index.html") && (req.method === "GET" || req.method === "HEAD")) {
      // Minimal WebUI: live status + manual update trigger (ddns-updater
      // WebUI analogue). Auto-refreshes every 5s.
      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>ddns</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:640px}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}
.ok{color:#1a7f37}.err{color:#cf222e}.idle{color:#57606a}
button{padding:8px 16px;margin-top:12px;cursor:pointer}
</style></head>
<body><h1>ddns</h1><button onclick="trigger()">Update now</button>
<table id="t"><thead><tr><th>Entry</th><th>Record</th><th>Type</th><th>IP</th><th>Status</th></tr></thead><tbody></tbody></table>
<script>
async function refresh(){const s=await fetch('/status').then(r=>r.json());const tb=document.querySelector('tbody');tb.innerHTML='';
for(const e of s.entries||[]){const r=(s.lastRun||[]).find(x=>x.name===e.name);
const status=r?(r.error?'<span class=err>'+r.error+'</span>':r.changed?'<span class=ok>updated</span>':r.skipped||'ok'):'<span class=idle>pending</span>';
tb.insertAdjacentHTML('beforeend','<tr><td>'+e.name+'</td><td>'+e.record+'</td><td>'+(r?.type||e.type||'')+'</td><td>'+(r?.ip||'')+'</td><td>'+status+'</td></tr>');}}
async function trigger(){await fetch('/update',{method:'POST'});refresh();}
refresh();setInterval(refresh,5000);
</script></body></html>`;
      const body = Buffer.from(html);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/status" && (req.method === "GET" || req.method === "HEAD")) {
      const body = JSON.stringify(status(), null, 2);
      res.writeHead(200, { "content-length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/update" && req.method === "POST") {
      void loop.runOnce()
        .then((results) => {
          const body = JSON.stringify(results, null, 2);
          res.writeHead(200, { "content-length": Buffer.byteLength(body) });
          res.end(body);
        })
        .catch((err) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found", paths: ["/status", "/update"] }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const status = (): ServeStatus => ({
    running: true,
    entries: opts.entries.map((e) => ({
      name: e.name,
      provider: e.provider,
      record: e.record,
      enabled: e.enabled !== false,
    })),
    lastRun,
    lastRunAt,
    uptimeMs: Date.now() - startedAt,
  });

  return {
    url: `http://127.0.0.1:${port}`,
    status,
    triggerUpdate: () => loop.runOnce(),
    stop: async () => {
      loop.stop();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}
