# ddns

DDNS + DNS 记录管理，多供应商（**120 家**：Go ddns-updater 全量 61 家 + lexicon 补充 + 特例）。

合并两家成熟项目的设计：

- **ddns-updater（Go, qdm12/ddns-updater）** — 公网 IP 探测 → 记录值跟随更新（A/AAAA）、
  push 型供应商（duckdns、custom webhook）、常驻更新循环；
- **lexicon（Python, dns-lexicon）** — 任意记录 CRUD（A/AAAA/CNAME/TXT/MX…）的
  统一抽象（list / create / update / delete / upsert）。

每个供应商都带一个**内存 mock**（`src/mocks/`），按真实供应商 API 的形状实现——
不仅我们的 TS 实现对着它测，**Go ddns-updater 和 Python lexicon 的实现也能对着它跑通**
（含 TLS + CONNECT 代理面，供硬编码域名、静态编译的 Go 二进制使用，见下）。

## 能力

| 能力 | 说明 | 对应 |
|---|---|---|
| 记录 CRUD | `list / create / update / delete`（任意记录类型） | lexicon |
| 记录 upsert | 按 (type, name) 查 → 有则改、无则建 | 两者合成 |
| DDNS 跟随 | 探测公网 IP → 变化才推送 / 跳过 unchanged | ddns-updater |
| push 型供应商 | duckdns、custom webhook（无读回，无条件推） | ddns-updater |
| 签名供应商 | aliyun HMAC-SHA1 RPC（mock 会验签） | ddns-updater |
| mock 服务器 | 每供应商一个，真实 HTTP 形状，可 `--tls-proxy` | — |

## 快速开始

```bash
npm install && npm test

# 1) 起一个供应商 mock（本地零网络联调）
node src/cli.ts mock cloudflare
# → {"mocks":[{"provider":"cloudflare","url":"http://127.0.0.1:PORT/client/v4"}]}

# 2) 对 mock 做 CRUD（--base-url 指向 mock）
node src/cli.ts create cloudflare example.com --name home.example.com --type A --value 1.1.1.1 \
  --token tk --zone-id <zoneId> --base-url http://127.0.0.1:PORT/client/v4
node src/cli.ts list cloudflare example.com --base-url http://127.0.0.1:PORT/client/v4 --token tk

# 3) DDNS 跟随（配置文件里写条目）
node src/cli.ts sync --config ./ddns.json --once
node src/cli.ts sync --config ./ddns.json --loop   # 常驻循环
```

`ddns.json`（0600，可含 token）：

```json
[
  {
    "name": "home",
    "provider": "cloudflare",
    "record": "home.example.com",
    "zone": "example.com",
    "token": "…",
    "intervalSec": 300
  },
  { "name": "lab", "provider": "duckdns", "record": "mylab", "token": "…" },
  { "name": "fb", "provider": "custom", "record": "fb.example.com", "url": "https://hook.example.com/update", "successRegex": "good" }
]
```

## 让 Go / Python 实现连上我们的 mock（TLS 代理面）

Go ddns-updater 与 lexicon 的 provider 把供应商域名硬编码在代码里，无法直接改地址。
解决：mock 提供 **TLS + CONNECT 代理面**（内置自签 CA，SAN 覆盖四家域名）：

```bash
node src/cli.ts mock --tls-proxy
# 输出含 proxyUrl（HTTP CONNECT 代理）与 caPath（CA 证书）

# Go ddns-updater（静态二进制，走标准 HTTPS_PROXY / SSL_CERT_FILE）
HTTPS_PROXY=http://127.0.0.1:<proxyPort> SSL_CERT_FILE=<caPath> ./ddns-updater -config ddns.yaml

# Python lexicon（requests 同样认 HTTPS_PROXY / REQUESTS_CA_BUNDLE）
HTTPS_PROXY=http://127.0.0.1:<proxyPort> REQUESTS_CA_BUNDLE=<caPath> lexicon cloudflare list example.com --auth-token …

# 或直接 TLS 面 + curl --resolve
curl --resolve api.cloudflare.com:443:127.0.0.1 --cacert <caPath> https://api.cloudflare.com/client/v4/zones
```

原理：客户端 `CONNECT api.cloudflare.com:443` → 代理回复 200 → 隧道内 TLS（证书 SAN 含
该域名，CA 由 `SSL_CERT_FILE` 注入信任）→ 转发到 mock 明文 HTTP 面。无 root、无
LD_PRELOAD。详见 `docs/design.md`。

## 供应商

| provider | 风格 | 认证 | 记录类型 | mock |
|---|---|---|---|---|
| cloudflare | zone（REST v4） | Bearer token | A/AAAA/CNAME/TXT/MX/NS | `src/mocks/cloudflare.ts` |
| dnspod | zone（dnsapi.cn 表单） | login_token | 同上 | `src/mocks/dnspod.ts` |
| aliyun | zone（RPC + HMAC 签名） | AccessKey | 同上 | `src/mocks/aliyun.ts`（验签） |
| duckdns | push（GET update） | token | A/AAAA | `src/mocks/duckdns.ts`（OK/KO） |
| custom | push（webhook） | URL + successRegex | A/AAAA | `src/mocks/custom.ts` |
| freedns | push（afraid.org） | token | A/AAAA | `src/mocks/freedns.ts`（响应文本判定） |
| **14 家 REST zone API** | digitalocean / gandi / godaddy / hostinger / ionos / linode / luadns / namecom / porkbun / scaleway / servercow / vultr / hetznercloud / bunny | Bearer/API-Key/Basic（按各家） | 同上 | `src/mocks/rest.ts`（spec 驱动） |
| **28 家 dyndns2** | allinkl / changeip / dd24 / ddnss / dnsomatic / dyn / dynu / dynv6 / easydns / gigahostno / goip / he / infomaniak / inwx / ipv64 / loopia / myaddr / namecheap / njalla / noip / nowdns / opendns / ovh / selfhostde / spdyn / strato / variomedia / zoneedit | basic auth / token | A/AAAA | `src/mocks/dyndns.ts`（spec 驱动） |
| **7 家特例** | dreamhost（cmd API）/ dondominio（push JSON）/ netcup（会话流）/ namesilo（key API）/ spaceship（双密钥头）/ **route53（AWS SigV4 + XML）** / **gcp（OAuth JSON）** | 各家认证 | zone CRUD / push | `test/special.test.mjs` 内嵌 mock |
| **lexicon 补充** | dnsimple / cloudns / glesys / regfish / internetbs / pointhq / rage4 / online / timeweb / zonomi / dnspark / flexibleengine / conoha / sakuracloud（dreamhost/dondominio 与 Go 侧共享） | 各家 | zone CRUD / push | `src/mocks/rest.ts` + `test/specs.test.mjs` |

凭据也支持环境变量：`DDNS_CLOUDFLARE_TOKEN`、`DDNS_DNSPOD_TOKEN`、
`DDNS_ALIYUN_ACCESS_KEY_ID` / `DDNS_ALIYUN_ACCESS_KEY_SECRET`、`DDNS_DUCKDNS_TOKEN`。

## 插件：第三方 provider

`npm install ddns-provider-xxx` → 自动发现（命名约定），无需改本仓库。
插件导出 `{ providers, createProvider, createMock? }`，详见 `docs/api.md` §4。

## 开发

```bash
npm run verify   # 一键验证（推荐）：环境检查 → 依赖安装 → typecheck → 全量测试 → build
                # 从全新 clone（无 node_modules）直接跑即全绿，无需任何手工准备
npm run typecheck   # tsc --noEmit
npm test            # node --test（143 用例，全离线：mock + 注入 fetch）
npm run build       # tsc → dist/
```

测试对齐两家项目的断言：cloudflare/dnspod/duckdns/custom/freedns 同时覆盖 Go 与
lexicon 的请求形状，aliyun 完全按 Go（lexicon 无 aliyun），`test/tls-proxy.test.mjs`
模拟 Go 客户端 CONNECT→TLS→HTTP 全流程。详见 `docs/design.md` 的对照表。

## 许可

MIT
