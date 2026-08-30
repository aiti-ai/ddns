# Changelog

## 0.1.0 (2026-08-30)

- **120 家 provider 全覆盖**：Go ddns-updater 全量 + lexicon 全量 + 特例。
  协议覆盖：dyndns2（28 家）、REST zone（spec 驱动 30+ 家）、TC3 签名（qcloud）、
  RSA 签名（transip/oci）、HMAC（aurora/cloudxns/dnsmadeeasy/constellix）、
  OAuth/JWT（azure/gcp/googleclouddns）、SOAP（gransy）、XML-RPC（plesk）、
  cookie 会话（hover/easyname/euserv）、本地 zone 文件（localzone）。
- **双风格引擎**：Go 式 IP 跟随 DDNS（updateEntry/runOnce/startLoop，变化才推、
  unchanged 跳过、ttl/proxied 感知）+ lexicon 式任意记录 CRUD（list/create/
  update/delete/upsert，名称规范化）。
- **信标（维度 2）**：`setBeacon` 把任意值（tunnel 域名/完整 URL）注册到固定
  名字（CNAME 剥 host / TXT 存完整 URL），幂等。
- **serve 模式**：常驻循环 + 状态 API（`/status`、`/update`）+ WebUI（根路径
  HTML 实时状态页，5s 自动刷新 + 手动更新按钮）。
- **每供应商 mock**：独立 mocks 目录，按真实 API 形状实现（cloudflare REST、
  dnspod 表单、aliyun 验签、duckdns OK/KO、dyndns2 good/nochg、REST spec 通用）；
  TLS + CONNECT 代理面供 Go/Python 实现直连（HTTPS_PROXY + SSL_CERT_FILE）。
- **插件系统**：`ddns-provider-*` 命名约定装包即发现（CJS + ESM 含 top-level
  await），`registerProvider`/`registerPlugin` 显式注册，失败可重试。
- **参数 schema**：`providerMetas`/`providerSchema`（service-tunnels ParamSpec
  形状），CLI `ddns providers [name]`。
- **CLI**：`ip / mock(--tls-proxy) / providers / list / create / update / delete /
  beacon / sync / serve / config`。
- 144 测试全绿（mock + 注入 fetch，全离线）。
