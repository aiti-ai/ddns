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

export type MockProviderName = "cloudflare" | "dnspod" | "aliyun" | "duckdns" | "custom";

import { startCloudflareMock, type CloudflareMockHandle, type CloudflareMockOptions } from "./cloudflare.ts";
import { startDnspodMock, type DnspodMockHandle, type DnspodMockOptions } from "./dnspod.ts";
import { startAliyunMock, type AliyunMockHandle, type AliyunMockOptions } from "./aliyun.ts";
import { startDuckdnsMock, type DuckdnsMockHandle, type DuckdnsMockOptions } from "./duckdns.ts";
import { startCustomMock, type CustomMockHandle, type CustomMockOptions } from "./custom.ts";

export type AnyMockHandle = CloudflareMockHandle | DnspodMockHandle | AliyunMockHandle | DuckdnsMockHandle | CustomMockHandle;

export type MockOptionsMap = {
  cloudflare: CloudflareMockOptions;
  dnspod: DnspodMockOptions;
  aliyun: AliyunMockOptions;
  duckdns: DuckdnsMockOptions;
  custom: CustomMockOptions;
};

export async function startMockProvider<N extends MockProviderName>(name: N, opts: MockOptionsMap[N] = {} as MockOptionsMap[N]): Promise<AnyMockHandle> {
  switch (name) {
    case "cloudflare": return startCloudflareMock(opts as CloudflareMockOptions);
    case "dnspod": return startDnspodMock(opts as DnspodMockOptions);
    case "aliyun": return startAliyunMock(opts as AliyunMockOptions);
    case "duckdns": return startDuckdnsMock(opts as DuckdnsMockOptions);
    case "custom": return startCustomMock(opts as CustomMockOptions);
    default: throw new Error(`unknown mock provider: ${name}`);
  }
}

export interface AllMocksHandle {
  handles: Record<MockProviderName, AnyMockHandle>;
  stopAll(): Promise<void>;
}

/** Start every provider mock (aliyun needs a zone). */
export async function startAllMocks(opts: { aliyunZone: string } = { aliyunZone: "example.com" }): Promise<AllMocksHandle> {
  const [cloudflare, dnspod, aliyun, duckdns, custom] = await Promise.all([
    startCloudflareMock(),
    startDnspodMock(),
    startAliyunMock({ zone: opts.aliyunZone }),
    startDuckdnsMock(),
    startCustomMock(),
  ]);
  return {
    handles: { cloudflare, dnspod, aliyun, duckdns, custom },
    stopAll: async () => {
      await Promise.all([cloudflare.stop(), dnspod.stop(), aliyun.stop(), duckdns.stop(), custom.stop()]);
    },
  };
}

export { startCloudflareMock } from "./cloudflare.ts";
export { startDnspodMock } from "./dnspod.ts";
export { startAliyunMock } from "./aliyun.ts";
export { startDuckdnsMock } from "./duckdns.ts";
export { startCustomMock } from "./custom.ts";
export { startTlsProxy, caCertPath, serverCertPath } from "./tls.ts";

export type { CloudflareMockHandle, CloudflareMockOptions, CloudflareMockState } from "./cloudflare.ts";
export type { DnspodMockHandle, DnspodMockOptions, DnspodMockState } from "./dnspod.ts";
export type { AliyunMockHandle, AliyunMockOptions, AliyunMockState } from "./aliyun.ts";
export type { DuckdnsMockHandle, DuckdnsMockOptions, DuckdnsMockState } from "./duckdns.ts";
export type { CustomMockHandle, CustomMockOptions, CustomMockState } from "./custom.ts";
