# ddns 对外接口（API + CLI）

本文档是 ddns 的对外接口契约。**修改接口时必须同步更新本文档。**

版本：0.1.0 ｜ 120 家 provider ｜ 144 测试全绿

---

## 1. 库 API（`import ... from "ddns"`）

入口：`src/index.ts`。Node >= 22.18（直接运行 .ts，无需构建）。

### 1.1 核心类型

```ts
/** DNS 记录（lexicon 风格） */
interface DnsRecord {
  id?: string;              // provider 侧记录 id（list/create 返回）
  type: string;             // A | AAAA | CNAME | TXT | MX | NS …
  name: string;             // 完整 FQDN，如 "home.example.com"
  value: string;            // 记录值：IP / CNAME 目标 / TXT 文本
  ttl?: number;             // 秒；不传用 provider 默认
  priority?: number;        // MX
  proxied?: boolean;        // cloudflare orange-cloud
}

/** provider 凭据/配置（flat） */
interface ProviderConfig {
  provider: string;         // 见 §3 供应商清单
  token?: string;           // cloudflare/dnspod/duckdns/freedns/… 的 token
  secret?: string;          // aliyun AccessKeySecret / netcup apiPassword / route53 SecretAccessKey
  accessKeyId?: string;     // aliyun / route53
  zoneId?: string;          // cloudflare zone id（跳过查找）；route53 hosted zone id
  username?: string;        // dyndns2 / dondominio / netcup customer / gcp project
  password?: string;        // dyndns2 / dondominio / gcp managed zone
  url?: string;             // custom webhook 更新端点
  ipv4key?: string;         // custom：IPv4 值的 query key（默认 "ipv4"）
  ipv6key?: string;         // custom：IPv6 值的 query key（默认 "ipv6"）
  successRegex?: string;    // custom：响应成功判定（默认 "good"）
  baseUrl?: string;         // 覆盖官方端点（测试/代理注入）
}

/** 供应商两种风格 */
interface ZoneProvider {    // lexicon 风格：完整 CRUD
  meta: { name; style: "zone"; recordTypes; needsZone: true; authFields };
  listRecords(zone: string, filter?: { type?: string; name?: string }): Promise<DnsRecord[]>;
  createRecord(zone: string, rec: DnsRecord): Promise<{ id: string }>;
  updateRecord(zone: string, rec: DnsRecord, id: string): Promise<void>;
  deleteRecord(zone: string, id: string): Promise<void>;
}
interface PushProvider {    // Go 风格：只推值（duckdns/custom/freedns/dyndns2 类）
  meta: { name; style: "push"; recordTypes; needsZone: false; authFields };
  pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void>;
}
```

### 1.2 记录 CRUD（`src/client.ts`）

```ts
createProvider(cfg: ProviderConfig): DnsProvider            // 注册表工厂
isZoneProvider(p): p is ZoneProvider
isPushProvider(p): p is PushProvider

listRecords(cfg, zone, filter?): Promise<DnsRecord[]>
createRecord(cfg, zone, rec): Promise<{ id: string }>
updateRecord(cfg, zone, rec, id): Promise<void>             // 按 id
deleteRecord(cfg, zone, id): Promise<void>
deleteRecordByName(cfg, zone, name, type): Promise<boolean> // lexicon 兼容
upsertRecord(cfg, zone, rec): Promise<{ created: boolean }> // 有则改、无则建
```

### 1.3 DDNS 引擎（`src/engine.ts`，Go ddns-updater 语义）

```ts
interface DdnsEntry {          // ddns.json 条目
  name: string;                // 本地标签
  provider: string;
  record: string;              // FQDN（duckdns: 裸标签）
  zone?: string;               // zone provider 必需
  type?: "A" | "AAAA";         // 默认 A
  ttl?: number;
  proxied?: boolean;
  intervalSec?: number;        // 循环间隔（默认 300）
  enabled?: boolean;           // false = 跳过
  ip?: string;                 // 钉死 IP（不探测）
  // 凭据：同 ProviderConfig（token/secret/accessKeyId/zoneId/username/password/url/…）
  baseUrl?: string;
}
interface DdnsResult {
  name; provider; record; type: "A"|"AAAA";
  ip: string | null;
  changed: boolean;
  pushed?: boolean;            // push 型 provider（无读回）每次 changed 时标注
  skipped?: "disabled" | "no-ip" | "unchanged" | "busy";
  error?: string;              // 出错不 throw，落在结果上
}
interface DdnsDeps {
  fetchImpl?;                  // 注入 fetch（测试）
  detectIp?;                   // 注入 IP 探测
  log?(line: string): void;
  onResults?(results: DdnsResult[]): void;   // 每次跑完回调（serve 用）
}

updateEntry(entry, deps?): Promise<DdnsResult>       // 单条
runOnce(entries, deps?): Promise<DdnsResult[]>       // 一次全量
startLoop(entries, deps?): DdnsLoopHandle            // 常驻
// DdnsLoopHandle: { stop(): void; runOnce(): Promise<DdnsResult[]> }
```

### 1.4 信标（`src/beacon.ts`，维度 2）

```ts
interface BeaconOptions {
  provider: ProviderConfig;
  zone: string;
  name: string;                // 固定信标名，如 "discover.example.com"
  type?: "CNAME" | "TXT";      // 默认 CNAME
  value: string;               // 任意值：hostname 或完整 URL
  ttl?: number;
}
setBeacon(opts): Promise<{ name; type; value; created: boolean }>
beaconValue(input, type): string   // CNAME 剥 scheme/path；TXT 原样
isBeaconType(t): t is "CNAME" | "TXT"
```

### 1.5 serve 模式（`src/serve.ts`）

```ts
interface ServeOptions {
  entries: DdnsEntry[];
  port?: number;               // 默认 0 = 随机
  log?; deps?: DdnsDeps;
}
startServe(opts): Promise<ServeHandle>
// ServeHandle: { url, status(): ServeStatus, triggerUpdate(), stop() }
// ServeStatus: { running; entries[]; lastRun: DdnsResult[]|null; lastRunAt; uptimeMs }
// HTTP 端点：
//   GET  /status  → ServeStatus（JSON）
//   POST /update  → 触发一次全量更新，返回 DdnsResult[]
```

### 1.6 IP 探测 / 配置 / 错误

```ts
resolvePublicIp(family: 4 | 6, fetchImpl?): Promise<string | null>
isValidIp(ip, family): boolean
IPV4_SOURCES / IPV6_SOURCES                     // 探测源列表（可替换）

splitZone(record, zone): [owner, root]          // "home.example.com","example.com" → ["home","example.com"]
formEncode(params): string
defaultFetch: FetchLike

configPath(configDir): string                   // <configDir>/ddns.json
readConfig(configDir): DdnsEntry[]
writeConfig(configDir, entries): void           // 0600 原子写

class ProviderError extends Error {
  provider: string; status?: number; apiCode?: string;
}
```

### 1.7 Mock 体系（独立包 `@aiti-ti/ddns-mocks`，repo `mocks/`）

```ts
startMockProvider(name, opts?): Promise<AnyMockHandle>   // 任意已注册 provider
startCloudflareMock / startDnspodMock / startAliyunMock /
startDuckdnsMock / startCustomMock / startFreednsMock    // 独立起单个
startAllMocks({ aliyunZone }): Promise<{ handles; stopAll() }>
startTlsProxy(target): Promise<TlsProxyHandle>
//   TlsProxyHandle: { tlsUrl, proxyUrl, caPath, stop() }
//   —— Go ddns-updater / Python lexicon 可经 HTTPS_PROXY + SSL_CERT_FILE 直连

// 每个 mock handle: { url, state, stop() }
//   state 可断言：requests[]（方法/URL/body）、records[]（内存记录）、
//   ips（duckdns）、signatureValid（aliyun 验签结果）
```

---

## 2. CLI（`ddns`）

```bash
# 信息
ddns ip                          # 探测公网 IPv4/IPv6 → {ipv4, ipv6}
ddns config path | show          # 配置路径 / 内容（默认 ~/.config/ddns/ddns.json）

# 记录 CRUD（lexicon 风格）
ddns list   <provider> <domain> [--zone z] [--type t] [--name fqdn] [creds]
ddns create <provider> <domain> --name <owner|fqdn> --type <T> --value <v> [--ttl s] [--proxied] [creds]
ddns update <provider> <domain> --id <rid> --name <owner|fqdn> --type <T> --value <v> [--ttl s] [creds]
ddns delete <provider> <domain> --id <rid> | --name <fqdn> --type <t> [creds]

# 信标（维度 2：固定名指向任意值）
ddns beacon <provider> <domain> --name <fqdn> --value <host|url> [--type CNAME|TXT] [creds]

# DDNS 跟随（Go 风格）
ddns sync [--config <file>] [--once] [--loop] [--interval <sec>]   # 默认一次全量

# serve 常驻（循环 + 状态 API）
ddns serve [--config <file>] [--port p]
#   GET  http://127.0.0.1:<port>/status   POST http://127.0.0.1:<port>/update

# mock 服务器（联调/测试）
ddns mock [provider] [--port p] [--tls-proxy] [--zone z]
#   --tls-proxy 输出 proxyUrl + caPath（Go/Python 实现直连）

# 凭据参数（creds）—— 也支持 DDNS_<PROVIDER>_* 环境变量
--token <t> --secret <s> --access-key-id <k> --zone-id <zid>
--username <u> --password <p>
--url <u> [--ipv4key <k>] [--ipv6key <k>] [--success-regex <re>]
--base-url <url>          # 覆盖官方端点（指 mock）
```

所有输出为 JSON（`--json` 格式化）。

### 配置格式 `~/.config/ddns/ddns.json`（0600）

```json
[
  { "name": "home", "provider": "cloudflare", "record": "home.example.com",
    "zone": "example.com", "token": "…", "intervalSec": 300 },
  { "name": "lab", "provider": "duckdns", "record": "mylab", "token": "…" },
  { "name": "fb", "provider": "custom", "record": "fb.example.com",
    "url": "https://hook.example.com/update", "successRegex": "good" }
]
```

---

## 3. 供应商参数 schema

每个 provider 的参数定义可用结构化查询（同 service-tunnels ParamSpec 形状，
宿主可据此渲染表单/校验输入）：

```ts
providerMetas(): ProviderMeta[]        // 全部：{name, style, recordTypes, needsZone, params}
providerMeta(name): ProviderMeta | undefined
providerSchema(name): ParamSpec[]      // 单家参数
// ParamSpec: { key, label?, type?: string|number|boolean|password,
//              description?, link?, default?, placeholder?, required?, options? }
```

CLI：`ddns providers`（全部）/ `ddns providers <name>`（单家）。

每家参数组成：通用条目参数（`name`/`record`/`type`/`ttl`）+ zone 参数（`zone`，
push 型无）+ 各家认证参数（token/secret/username/password/accessKeyId/zoneId/
url/ipv4key/ipv6key/successRegex，按 provider 声明，含 required/type/link 说明）。

---

## 4. 供应商清单（120 家）

| 类别 | provider 名 |
|---|---|
| 手写精装 | cloudflare · dnspod · aliyun · duckdns · custom · freedns |
| REST zone API（Go 侧） | digitalocean · gandi · godaddy · hostinger · ionos · linode · luadns · namecom · porkbun · scaleway · servercow · vultr · hetznercloud · bunny |
| dyndns2 | allinkl · changeip · dd24 · ddnss · dnsomatic · dyn · dynu · dynv6 · easydns · gigahostno · goip · he · infomaniak · inwx · ipv64 · loopia · myaddr · namecheap · njalla · noip · nowdns · opendns · ovh · selfhostde · spdyn · strato · variomedia · zoneedit |
| 特例 | dreamhost · dondominio · netcup · namesilo · spaceship · route53(SigV4) · gcp(OAuth) |
| lexicon 补充 | dnsimple · cloudns · glesys · regfish · internetbs · pointhq · rage4 · online · timeweb · zonomi · dnspark · flexibleengine · conoha · sakuracloud · hetzner · vercel（dreamhost/dondominio 与特例共享） |

环境变量约定：`DDNS_<PROVIDER_UPPER>_TOKEN` / `_SECRET` / `_ACCESS_KEY_ID` / `_USERNAME` / `_PASSWORD` 等（如 `DDNS_CLOUDFLARE_TOKEN`、`DDNS_ALIYUN_ACCESS_KEY_SECRET`）。

---

## 4. 插件系统（第三方 provider）

第三方 provider **不需要改本仓库**——装包即发现：

```bash
npm install ddns-provider-foo     # 约定命名，装进 node_modules 即可
```

### 插件包契约

包名以 `ddns-provider-` 开头（支持 `@scope/ddns-provider-*`），default export
（或 named `plugin`）导出：

```js
export default {
  providers: ["foo", { name: "foo2", style: "zone" }],  // 提供的 provider 名
  createProvider(cfg) { return new FooProvider(cfg); },  // 必须：返回 ZoneProvider | PushProvider
  createMock(opts) { return { url, state, stop }; },     // 可选：mock 支持
};
```

`createProvider(cfg)` 收到 flat `ProviderConfig`（token/secret/…），返回
`ZoneProvider` 或 `PushProvider`（见 §1.1 类型）。

### 库 API

```ts
discoverPlugins(cwd?): string[]        // 扫描 node_modules 的 ddns-provider-* 并加载（幂等）
registerProvider(name, factory)        // 显式注册单个 provider 工厂
registerPlugin(plugin)                 // 注册整个插件对象（宿主内置插件用）
registry.list(): string[]              // 当前已注册的插件 provider 名
```

- `createProvider()` 内置 provider 找不到时自动查插件注册表；
- `startMockProvider()` 同样支持插件的 `createMock`；
- CLI 启动时自动 `discoverPlugins()`；
- 加载失败的插件只记日志，**绝不破坏宿主**。

### 安全边界

插件是**可执行代码**——只在显式安装进 node_modules 时才会被加载，与 npm
生态的常规信任模型一致（如同任何 dependency）。

---

## 5. 变更约定

- 新增 provider：`src/providers/rest-specs.ts`（REST 类 ~15 行）或 `dyndns-services.ts`（一行）或手写类；更新本清单。
- 新增导出：`src/index.ts` 必须 re-export，本文档 §1 同步。
- 新增 CLI 命令：`src/cli.ts` usage + 本文档 §2 同步。
- 接口变更必须过 `npm run verify`（typecheck + 测试 + build）。
