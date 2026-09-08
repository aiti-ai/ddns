/** route53 mock — AWS Route53 XML API (SigV4 header accepted loosely, XML
 *  ListResourceRecordSets / ChangeResourceRecordSets responses like the real
 *  service so the provider's #parseRrsets works). */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface Route53MockOptions {
  zoneId?: string;
  records?: Array<{ name: string; type: string; value: string; ttl?: number }>;
  port?: number;
}

export interface Route53MockState {
  records: Array<{ name: string; type: string; value: string; ttl: number }>;
  requests: Array<{ method: string; url: string; body?: string }>;
}

export interface Route53MockHandle {
  url: string;
  state: Route53MockState;
  stop(): Promise<void>;
}

export async function startRoute53Mock(opts: Route53MockOptions = {}): Promise<Route53MockHandle> {
  const state: Route53MockState = {
    records: (opts.records ?? []).map((r) => ({ ttl: r.ttl ?? 300, ...r })),
    requests: [],
  };

  const rrsetsXml = () =>
    state.records
      .map(
        (r) =>
          `<ResourceRecordSet><Name>${r.name}.</Name><Type>${r.type}</Type><TTL>${r.ttl}</TTL><ResourceRecords><ResourceRecord><Value>${r.value}</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>`,
      )
      .join("");

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests.push({ method: req.method ?? "GET", url: req.url ?? "", body: body || undefined });
      res.writeHead(200, { "content-type": "application/xml" });
      if (req.method === "GET") {
        // ListResourceRecordSets — provider parses <ResourceRecordSet> blocks
        res.end(`<ListResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ResourceRecordSets>${rrsetsXml()}</ResourceRecordSets></ListResourceRecordSetsResponse>`);
        return;
      }
      if (req.method === "POST" && body.includes("<Action>CREATE</Action>")) {
        const name = /<Name>([^<]+)<\/Name>/.exec(body)?.[1] ?? "";
        const type = /<Type>([^<]+)<\/Type>/.exec(body)?.[1] ?? "";
        const value = /<Value>([^<]+)<\/Value>/.exec(body)?.[1] ?? "";
        const ttl = Number(/<TTL>([^<]+)<\/TTL>/.exec(body)?.[1] ?? 300);
        if (name && type) state.records.push({ name: name.replace(/\.$/, ""), type, value, ttl });
        res.end(`<ChangeResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeInfo><Id>/change/C1</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`);
        return;
      }
      if (req.method === "POST" && body.includes("<Action>UPSERT</Action>")) {
        const name = /<Name>([^<]+)<\/Name>/.exec(body)?.[1] ?? "";
        const type = /<Type>([^<]+)<\/Type>/.exec(body)?.[1] ?? "";
        const value = /<Value>([^<]+)<\/Value>/.exec(body)?.[1] ?? "";
        const rec = state.records.find((r) => r.name === name.replace(/\.$/, "") && r.type === type);
        if (rec) rec.value = value;
        res.end(`<ChangeResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeInfo><Id>/change/C2</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`);
        return;
      }
      if (req.method === "POST" && body.includes("<Action>DELETE</Action>")) {
        const name = /<Name>([^<]+)<\/Name>/.exec(body)?.[1] ?? "";
        const type = /<Type>([^<]+)<\/Type>/.exec(body)?.[1] ?? "";
        const idx = state.records.findIndex((r) => r.name === name.replace(/\.$/, "") && r.type === type);
        if (idx >= 0) state.records.splice(idx, 1);
        res.end(`<ChangeResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeInfo><Id>/change/C3</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`);
        return;
      }
      res.end(`<ChangeResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeInfo><Id>/change/C9</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`);
    });
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
