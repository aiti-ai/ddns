/** mocks — one in-memory mock per provider, mirroring the REAL provider
 *  HTTP APIs closely enough that third-party implementations (Go
 *  ddns-updater, Python lexicon) pointed at the mock also work:
 *
 *    cloudflare → api.cloudflare.com/client/v4 (REST, Bearer token)
 *    dnspod     → dnsapi.cn Record.* (form POST, login_token)
 *    aliyun     → alidns.aliyuncs.com (signed RPC; signature verified when
 *                 the mock is given the AccessKeySecret)
 *    duckdns    → www.duckdns.org/v3/update ("OK"/"KO")
 *    custom     → arbitrary webhook URL (success regex semantics)
 *
 *  Every mock returns a handle with `url` to inject as the provider's
 *  baseUrl and a `state` object to assert on. Start one with
 *  startMockProvider(name, opts), or all of them with startAllMocks().
 */

export type MockProviderName = string; // any registered provider name (spec-driven mocks included)

import { startCloudflareMock, type CloudflareMockHandle, type CloudflareMockOptions } from "./cloudflare.ts";
import { startDnspodMock, type DnspodMockHandle, type DnspodMockOptions } from "./dnspod.ts";
import { startAliyunMock, type AliyunMockHandle, type AliyunMockOptions } from "./aliyun.ts";
import { startDuckdnsMock, type DuckdnsMockHandle, type DuckdnsMockOptions } from "./duckdns.ts";
import { startCustomMock, type CustomMockHandle, type CustomMockOptions } from "./custom.ts";
import { startFreednsMock, type FreednsMockHandle, type FreednsMockOptions } from "./freedns.ts";
import { startRestMock, type RestMockHandle, type RestMockOptions } from "./rest.ts";
import { startDyndnsMock, type DyndnsMockHandle, type DyndnsMockOptions } from "./dyndns.ts";
import { startLooseZoneMock, type LooseMockHandle, type LooseMockOptions } from "./loose.ts";
import { startRoute53Mock, type Route53MockHandle, type Route53MockOptions } from "./route53.ts";
import { registry } from "../plugins.ts";

export type AnyMockHandle = CloudflareMockHandle | DnspodMockHandle | AliyunMockHandle | DuckdnsMockHandle | CustomMockHandle | FreednsMockHandle | RestMockHandle | DyndnsMockHandle | LooseMockHandle | Route53MockHandle;

export type MockOptionsMap = {
  cloudflare: CloudflareMockOptions;
  dnspod: DnspodMockOptions;
  aliyun: AliyunMockOptions;
  duckdns: DuckdnsMockOptions;
  custom: CustomMockOptions;
  freedns: FreednsMockOptions;
};

/** Start a mock for ANY registered provider name (rest specs + dyndns
 *  services get their generic mocks automatically). */
export async function startMockFor(name: string, opts: { zone?: string; cred?: string; records?: Array<{ type: string; name: string; value: string; ttl?: number }>; port?: number } = {}): Promise<AnyMockHandle> {
  const { REST_SPECS } = await import("../providers/rest-specs.ts");
  const { DYNDNS_SERVICES } = await import("../providers/dyndns-services.ts");
  const rest = REST_SPECS.find((s) => s.name === name);
  if (rest) return startRestMock({ spec: rest, zone: opts.zone ?? "example.com", cred: opts.cred, records: opts.records, port: opts.port });
  const dyn = DYNDNS_SERVICES.find((s) => s.name === name);
  if (dyn) return startDyndnsMock({ auth: dyn.tokenOnly ? undefined : "user:pass", okText: `${dyn.successPrefixes[0] ?? "good"} 1.2.3.4`, port: opts.port });
  // hand-written providers without a dedicated mock: loose zone REST mock
  return startLooseZoneMock({ provider: name, auth: "none", cred: "test-token", ...(opts.zone ? { zone: opts.zone } : {}), ...(opts.records ? { records: opts.records } : {}), ...(opts.port ? { port: opts.port } : {}) });
}

export async function startMockProvider(name: MockProviderName, opts: Record<string, unknown> = {}): Promise<AnyMockHandle> {
  switch (name) {
    case "cloudflare": return startCloudflareMock(opts as CloudflareMockOptions);
    case "dnspod": return startDnspodMock(opts as DnspodMockOptions);
    case "aliyun": return startAliyunMock(opts as unknown as AliyunMockOptions);
    case "duckdns": return startDuckdnsMock(opts as DuckdnsMockOptions);
    case "custom": return startCustomMock(opts as CustomMockOptions);
    case "freedns": return startFreednsMock(opts as FreednsMockOptions);
    case "route53": return startRoute53Mock(opts as Route53MockOptions);
    default: {
      const pluginMock = registry.getMock(name);
      if (pluginMock) return pluginMock(opts as { zone?: string; cred?: string; port?: number }) as AnyMockHandle;
      return startMockFor(name, opts as { zone?: string; cred?: string });
    }
  }
}

export interface AllMocksHandle {
  handles: Record<MockProviderName, AnyMockHandle>;
  stopAll(): Promise<void>;
}

/** Start every provider mock (aliyun needs a zone). */
export async function startAllMocks(opts: { aliyunZone: string } = { aliyunZone: "example.com" }): Promise<AllMocksHandle> {
  const [cloudflare, dnspod, aliyun, duckdns, custom, freedns] = await Promise.all([
    startCloudflareMock(),
    startDnspodMock(),
    startAliyunMock({ zone: opts.aliyunZone }),
    startDuckdnsMock(),
    startCustomMock(),
    startFreednsMock(),
  ]);
  return {
    handles: { cloudflare, dnspod, aliyun, duckdns, custom, freedns },
    stopAll: async () => {
      await Promise.all([cloudflare.stop(), dnspod.stop(), aliyun.stop(), duckdns.stop(), custom.stop(), freedns.stop()]);
    },
  };
}

export { startCloudflareMock } from "./cloudflare.ts";
export { startDnspodMock } from "./dnspod.ts";
export { startAliyunMock } from "./aliyun.ts";
export { startDuckdnsMock } from "./duckdns.ts";
export { startCustomMock } from "./custom.ts";
export { startFreednsMock } from "./freedns.ts";
export { startRestMock } from "./rest.ts";
export { startDyndnsMock } from "./dyndns.ts";
export { startTlsProxy, caCertPath, serverCertPath } from "./tls.ts";

export type { CloudflareMockHandle, CloudflareMockOptions, CloudflareMockState } from "./cloudflare.ts";
export type { DnspodMockHandle, DnspodMockOptions, DnspodMockState } from "./dnspod.ts";
export type { AliyunMockHandle, AliyunMockOptions, AliyunMockState } from "./aliyun.ts";
export type { DuckdnsMockHandle, DuckdnsMockOptions, DuckdnsMockState } from "./duckdns.ts";
export type { CustomMockHandle, CustomMockOptions, CustomMockState } from "./custom.ts";
export type { FreednsMockHandle, FreednsMockOptions, FreednsMockState } from "./freedns.ts";
export type { RestMockHandle, RestMockOptions, RestMockState } from "./rest.ts";
export type { DyndnsMockHandle, DyndnsMockOptions, DyndnsMockState } from "./dyndns.ts";
