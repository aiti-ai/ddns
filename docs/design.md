# ddns 设计文档

本包合并两家成熟项目的能力，并以「它们的实现对着我们的 mock 也能过」为验收标准。

## 1. 能力对照

| 能力 | ddns-updater (Go) | lexicon (Python) | 本项目 (TS) |
|---|---|---|---|
| 记录值跟随公网 IP（A/AAAA） | ✅ 核心 | ❌（只做证书挑战外的通用 CRUD） | ✅ `engine.ts` |
| 变化才推送（up-to-date 跳过） | ✅ | — | ✅（list 比对） |
| 任意记录 CRUD（CNAME/TXT/MX） | ❌（Update 只收 IP） | ✅ 核心 | ✅ `client.ts` |
| upsert（无则建、有则改） | ✅（create 当缺失） | ✅（--if-* 选项） | ✅ |
| push 型供应商（duckdns/custom webhook） | ✅ | ✅ duckdns | ✅ |
| 签名 API（aliyun） | ✅ HMAC-SHA1 | ❌ 无 aliyun | ✅（mock 验签） |
| provider 统一抽象 | `Update(ctx, client, ip)` | `list/create/update/delete_record` | 双风格：`ZoneProvider` + `PushProvider` |
| 长跑循环 | ✅ 定时器 | ❌（CLI 单次） | ✅ `startLoop`（unref 定时器） |

## 2. 架构

```
src/
├── types.ts        # DnsRecord / ZoneProvider / PushProvider / ProviderConfig
├── ip.ts           # 公网 IP 探测（ipify → icanhazip 双源容错，Go publicip 语义）
├── client.ts       # lexicon 式 CRUD + createProvider 注册表 + upsert
├── engine.ts       # Go 式 DDNS：detect → compare → push；runOnce / startLoop
├── config.ts       # ddns.json（0600，原子写）
├── cli.ts          # 命令：ip / mock / list / create / update / delete / beacon / sync / serve / config
├── beacon.ts       # 信标：任意值（CNAME/TXT）同步到固定名字（维度 2）
├── serve.ts        # serve 模式：更新循环 + 状态 API（GET /status、POST /update）
├── providers/      # 5 家实现（注入 fetch + baseUrl，可测）
│   └── common.ts   # ProviderError / splitZone / formEncode
└── mocks/          # ★ 每供应商一个 mock（真实 HTTP 形状）+ TLS 代理面
    ├── cloudflare.ts   # REST v4：zones?name=、dns_records CRUD、Bearer 校验
    ├── dnspod.ts       # dnsapi.cn：Domain.Info / Record.List/Create/Modify/Remove
    ├── aliyun.ts       # RPC：Describe/Add/Update/Delete，验签（错签拒绝）
    ├── duckdns.ts      # /update 任意路径 OK/KO（Go 打 /update、lexicon 打 /、我们打 /v3/update）
    ├── custom.ts       # 任意 webhook URL，可配响应体（success_regex 测试）
    ├── tls.ts          # TLS 面 + CONNECT 代理面（内置自签 CA）
    └── assets/         # mock-ca.pem + mock-server.pem（SAN 覆盖四家域名）
```

## 3. mock 的「他们能过」保证（契约）

每个 mock 都按**真实 API 的形状**实现，并针对两家实现的具体行为校准：

| mock | 为兼容 Go 的细节 | 为兼容 lexicon 的细节 |
|---|---|---|
| cloudflare | 列表查询容忍 `page`/`per_page` 参数；`/zones?name=` | `/zones` 响应带 `result_info.total_pages`（authenticate 分页循环读它） |
| dnspod | `Record.List/Modify` 用 `record_id`；表单 `login_token` | 先调 `POST /Domain.Info` 认证（返回 `domain.id`、`status.code=="1"`） |
| aliyun | `DescribeDomainRecords` + `PageSize`、`DomainRecords.Record[]` 响应；**验签**（给 secret 时错签直接拒） | lexicon 无此供应商 |
| duckdns | 请求路径 `/update` | 请求路径 `/` —— mock **忽略路径**统一响应 |
| custom | URL 追加 `&ipv4=/&ipv6=`、`success_regex` 判定 | — |

## 4. TLS 代理面（静态编译 Go 二进制怎么连 mock）

Go 的 provider 把 `api.cloudflare.com` 等域名硬编码，配置无 base URL 注入点。
对静态编译（CGO_ENABLED=0）的二进制，LD_PRELOAD 劫持 getaddrinfo 无效（纯 Go
resolver 不走 NSS），但：

1. Go `net/http` **原生读 `HTTPS_PROXY`**（`ProxyFromEnvironment`）；
2. Go `crypto/x509` **原生读 `SSL_CERT_FILE`**。

所以 `src/mocks/tls.ts` 提供：

```
客户端 ──HTTPS_PROXY=proxyUrl──► CONNECT api.cloudflare.com:443 → 200
        → TLS（SNI=api.cloudflare.com，证书 SAN 覆盖，CA 由 SSL_CERT_FILE 注入）
        → 桥接到 TLS 面 → 转发 mock 明文 HTTP 面
```

- 无 root（不碰 443/hosts）、无 preload，只设两个标准环境变量；
- 内置 CA/服务端证书在 `src/mocks/assets/`（10 年有效期，仅测试用）；
- Python lexicon（requests）同样认 `HTTPS_PROXY` + `REQUESTS_CA_BUNDLE`。

## 5. 测试矩阵（18 用例，全离线）

| 文件 | 覆盖 | 对齐 |
|---|---|---|
| `test/providers.test.mjs` | 5 家 provider 对自家 mock 的 CRUD/推送/错误 | Go + lexicon 请求形状 |
| `test/engine.test.mjs` | DDNS 语义（create/update/unchanged/disabled/no-ip）、loop、upsert、config 0600、IP 探测容错 | Go update 循环 |
| `test/cli.test.mjs` | CLI 端到端（spawn cli.ts）对 mock | — |
| `test/tls-proxy.test.mjs` | CONNECT→TLS→HTTP 全流程（模拟 Go 客户端）、直接 TLS 面、POST 透传 | Go net/http 行为 |
| `test/features.test.mjs` | freedns 响应文本规则、beacon 任意值同步、serve 状态 API | Go freedns / 维度 2 |
| `test/specs.test.mjs` | 14 家 REST + 28 家 dyndns2 的 spec 驱动契约（自动遍历） | Go 各家 |
| `test/special.test.mjs` | 特例：dreamhost/dondominio/netcup/namesilo/spaceship/route53(SigV4)/gcp | Go 各家 |

## 6. 后续（未做）

- `--tls-proxy` 下 lexicon 的 `api_endpoint` 实例属性覆盖用法文档；
- service-tunnels 集成：`beacon` API + tunnel url 事件联动（远端服务器无人值守
  注册当前 tunnel 域名的完整闭环）。

## 7. 供应商全景（77 家，对齐 Go ddns-updater 61 家 + lexicon 补充 16 家）

| 类别 | 数量 | 实现 |
|---|---|---|
| 手写精装 | 6 | cloudflare / dnspod / aliyun / duckdns / custom / freedns |
| REST zone API（spec 驱动，Go 侧） | 14 | digitalocean / gandi / godaddy / hostinger / ionos / linode / luadns / namecom / porkbun / scaleway / servercow / vultr / hetznercloud / bunny |
| dyndns2（spec 驱动） | 28 | allinkl … zoneedit（见 `dyndns-services.ts`） |
| 特例 | 7 | dreamhost / dondominio / netcup / namesilo / spaceship / route53(SigV4) / gcp(OAuth) |
| lexicon 补充（spec 驱动） | 16 | dnsimple / cloudns / glesys / regfish / internetbs / pointhq / rage4 / online / timeweb / zonomi / dnspark / flexibleengine / conoha / sakuracloud / dreamhost / dondominio |

接口融合：lexicon 的 `(rtype, name, content)` 记录模型与 `ZoneProvider` 同构，
其 REST 类 provider 直接进 RestSpec 框架（每家 ~15 行声明 + 自动 mock + 自动契约
测试）；account 预查找（dnsimple）通过 `preLookups` 支持。每家都有 mock（手写或
spec 通用）与契约测试；route53 的 SigV4 签名由 mock 侧行为验证，aliyun 的 HMAC
由 mock 验签。
