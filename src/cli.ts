#!/usr/bin/env node
/** ddns CLI — lexicon-style record CRUD + Go-style DDNS sync + mock runner. */

import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { listRecords, createRecord as clientCreate, updateRecord as clientUpdate, deleteRecord as clientDelete, deleteRecordByName } from "./client.ts";
import { runOnce, startLoop } from "./engine.ts";
import { readConfig, configPath } from "./config.ts";
import { resolvePublicIp } from "./ip.ts";
import { startMockProvider, startTlsProxy, type MockProviderName } from "./mocks/index.ts";

const PROVIDERS = ["cloudflare", "dnspod", "aliyun", "duckdns", "custom", "freedns"];

function usage(): void {
  console.log(`ddns — DDNS + DNS record management (cloudflare/dnspod/aliyun/duckdns/custom)

  ddns ip                                   # show detected public IPv4/IPv6
  ddns mock [provider] [--port <p>] [--tls-proxy] [--zone <z>]
                                            # run provider mock(s); --tls-proxy also
                                            # serves HTTPS_PROXY face + CA path
  ddns list <provider> <domain> [--zone <z>] [--type <t>] [--name <fqdn>] [creds...]
  ddns create <provider> <domain> --name <owner|fqdn> --type <A|AAAA|CNAME|TXT> --value <v> [--ttl <s>] [--proxied] [creds...]
  ddns update <provider> <domain> --id <rid> --name <owner|fqdn> --type <t> --value <v> [--ttl <s>] [creds...]
  ddns delete <provider> <domain> --id <rid> [creds...]
                                            # or delete by lookup: --name <fqdn> --type <t>
  ddns beacon <provider> <domain> --name <fqdn> --value <host|url> [--type CNAME|TXT] [creds...]
                                            # keep a FIXED name pointing at an arbitrary
                                            # value (tunnel discovery beacon)
  ddns sync [--config <file>] [--once] [--loop] [--interval <sec>]
                                            # DDNS: point every entry at the current public IP
  ddns serve [--config <file>] [--port <p>]  # loop + status API (GET /status, POST /update)
  ddns config path | show [--config <file>]

  creds: --token <t> | --secret <s> | --access-key-id <k> | --zone-id <zid> |
         --url <u> [--ipv4key <k>] [--ipv6key <k>] [--success-regex <re>]
`);
}

interface Args {
  config?: string;
  port?: number;
  tlsProxy?: boolean;
  zone?: string;
  type?: string;
  name?: string;
  value?: string;
  ttl?: number;
  proxied?: boolean;
  id?: string;
  token?: string;
  secret?: string;
  accessKeyId?: string;
  zoneId?: string;
  url?: string;
  ipv4key?: string;
  ipv6key?: string;
  successRegex?: string;
  baseUrl?: string;
  beaconType?: string;
  once?: boolean;
  loop?: boolean;
  interval?: number;
  json?: boolean;
}

function parseArgs(argv: string[]): { cmd: string[]; args: Args } {
  const cmd: string[] = [];
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--config": args.config = argv[++i]; break;
      case "--port": args.port = Number(argv[++i]); break;
      case "--tls-proxy": args.tlsProxy = true; break;
      case "--zone": args.zone = argv[++i]; break;
      case "--type": args.type = argv[++i]; break;
      case "--name": args.name = argv[++i]; break;
      case "--value": args.value = argv[++i]; break;
      case "--ttl": args.ttl = Number(argv[++i]); break;
      case "--proxied": args.proxied = true; break;
      case "--id": args.id = argv[++i]; break;
      case "--token": args.token = argv[++i]; break;
      case "--secret": args.secret = argv[++i]; break;
      case "--access-key-id": args.accessKeyId = argv[++i]; break;
      case "--zone-id": args.zoneId = argv[++i]; break;
      case "--url": args.url = argv[++i]; break;
      case "--ipv4key": args.ipv4key = argv[++i]; break;
      case "--ipv6key": args.ipv6key = argv[++i]; break;
      case "--success-regex": args.successRegex = argv[++i]; break;
      case "--base-url": args.baseUrl = argv[++i]; break;
      case "--beacon-type": args.beaconType = argv[++i]; break;
      case "--once": args.once = true; break;
      case "--loop": args.loop = true; break;
      case "--interval": args.interval = Number(argv[++i]); break;
      case "--json": args.json = true; break;
      default:
        if (a.startsWith("-")) {
          console.error(`unknown option: ${a}`);
          process.exit(2);
        }
        cmd.push(a);
    }
  }
  return { cmd, args };
}

function credsFromArgs(args: Args): Record<string, string | undefined> {
  return {
    token: args.token,
    secret: args.secret,
    accessKeyId: args.accessKeyId,
    zoneId: args.zoneId,
    url: args.url,
    ipv4key: args.ipv4key,
    ipv6key: args.ipv6key,
    successRegex: args.successRegex,
    baseUrl: args.baseUrl,
  };
}

/** Config file resolution: explicit --config (relative to cwd) else
 *  ~/.config/ddns/ddns.json. */
function resolveConfigFile(args: Args): string {
  if (args.config) return isAbsolute(args.config) ? args.config : join(process.cwd(), args.config);
  return join(homedir(), ".config", "ddns", "ddns.json");
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const sub = cmd[0] ?? "";
  const out = (o: unknown) => process.stdout.write(JSON.stringify(o, null, args.json ? 2 : 0) + "\n");

  switch (sub) {
    case "ip": {
      out({ ipv4: await resolvePublicIp(4), ipv6: await resolvePublicIp(6) });
      break;
    }

    case "mock": {
      const provider = cmd[1] as MockProviderName | undefined;
      if (provider && !PROVIDERS.includes(provider)) {
        console.error(`unknown provider: ${provider} (known: ${PROVIDERS.join(", ")})`);
        process.exit(2);
      }
      const names: MockProviderName[] = provider ? [provider] : ["cloudflare", "dnspod", "aliyun", "duckdns", "custom", "freedns"];
      const started: unknown[] = [];
      for (const n of names) {
        const h = await startMockProvider(n, { zone: args.zone ?? "example.com", port: args.port } as never);
        const entry: Record<string, unknown> = { provider: n, url: h.url };
        if (args.tlsProxy) {
          const tls = await startTlsProxy(h.url);
          entry.tlsUrl = tls.tlsUrl;
          entry.proxyUrl = tls.proxyUrl;
          entry.caPath = tls.caPath;
        }
        started.push(entry);
      }
      out({ mocks: started });
      if (args.tlsProxy) {
        process.stdout.write(
          "# Go ddns-updater / Python lexicon can now reach these mocks with:\n" +
          "#   HTTPS_PROXY=http://127.0.0.1:<proxyPort> SSL_CERT_FILE=<caPath> <binary>\n",
        );
      }
      process.on("SIGINT", () => process.exit(0));
      await new Promise(() => {}); // keep serving
      break;
    }

    case "list": {
      const provider = cmd[1];
      const domain = cmd[2];
      if (!provider || !domain) return usage();
      const cfg = { provider, ...credsFromArgs(args) };
      out(await listRecords(cfg, args.zone ?? domain, { type: args.type, name: args.name }));
      break;
    }

    case "create": {
      const provider = cmd[1];
      const domain = cmd[2];
      if (!provider || !domain || !args.name || !args.type || !args.value) return usage();
      const cfg = { provider, ...credsFromArgs(args) };
      out(await clientCreate(cfg, args.zone ?? domain, { type: args.type, name: args.name, value: args.value, ttl: args.ttl, proxied: args.proxied }));
      break;
    }

    case "update": {
      const provider = cmd[1];
      const domain = cmd[2];
      if (!provider || !domain || !args.id || !args.name || !args.type || !args.value) return usage();
      const cfg = { provider, ...credsFromArgs(args) };
      await clientUpdate(cfg, args.zone ?? domain, { type: args.type, name: args.name, value: args.value, ttl: args.ttl }, args.id);
      out({ updated: args.id });
      break;
    }

    case "delete": {
      const provider = cmd[1];
      const domain = cmd[2];
      if (!provider || !domain) return usage();
      const cfg = { provider, ...credsFromArgs(args) };
      const zone = args.zone ?? domain;
      if (args.id) {
        await clientDelete(cfg, zone, args.id);
        out({ deleted: args.id });
      } else if (args.name && args.type) {
        out({ deleted: await deleteRecordByName(cfg, zone, args.name, args.type) });
      } else {
        return usage();
      }
      break;
    }

    case "beacon": {
      const provider = cmd[1];
      const domain = cmd[2];
      if (!provider || !domain || !args.name || !args.value) return usage();
      const { setBeacon } = await import("./beacon.ts");
      const cfg = { provider, ...credsFromArgs(args) };
      const type = (args.beaconType === "TXT" ? "TXT" : "CNAME") as "CNAME" | "TXT";
      out(await setBeacon({ provider: cfg, zone: args.zone ?? domain, name: args.name, type, value: args.value, ttl: args.ttl }));
      break;
    }

    case "sync": {
      const file = resolveConfigFile(args);
      const dir = dirname(file);
      const entries = readConfig(dir).filter((e) => e.enabled !== false);
      if (!entries.length) {
        console.error(`no ddns entries in ${file} — see 'ddns config path'`);
        process.exit(2);
      }
      if (args.loop) {
        const handle = startLoop(entries, { log: (l) => process.stdout.write(l + "\n") });
        process.on("SIGINT", () => { handle.stop(); process.exit(0); });
        process.on("SIGTERM", () => { handle.stop(); process.exit(0); });
        await new Promise(() => {});
      }
      out(await runOnce(entries));
      break;
    }

    case "serve": {
      const file = resolveConfigFile(args);
      const entries = readConfig(dirname(file)).filter((e) => e.enabled !== false);
      if (!entries.length) {
        console.error(`no ddns entries in ${file} — see 'ddns config path'`);
        process.exit(2);
      }
      const { startServe } = await import("./serve.ts");
      const handle = await startServe({ entries, port: args.port, log: (l) => process.stdout.write(l + "\n") });
      out({ statusUrl: `${handle.url}/status`, updateUrl: `${handle.url}/update` });
      process.on("SIGINT", async () => { await handle.stop(); process.exit(0); });
      process.on("SIGTERM", async () => { await handle.stop(); process.exit(0); });
      await new Promise(() => {});
      break;
    }

    case "config": {
      if (cmd[1] === "path") {
        process.stdout.write(resolveConfigFile(args) + "\n");
      } else if (cmd[1] === "show") {
        out(readConfig(dirname(resolveConfigFile(args))));
      } else {
        usage();
        process.exit(2);
      }
      break;
    }

    default:
      usage();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
