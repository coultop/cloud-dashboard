# 安全说明

## 默认没有登录

面板沿用上游两个子面板的「本地管理员会话」实现：请求一律以本地管理员身份处理，`http://<host>:8555`
打开即可读写全部账号、开关保活、导出配置。`LOCAL_NOAUTH=0` 可以恢复原登录墙。

因此：

- **只在可信内网使用**，或放在带鉴权的反向代理（Nginx basic auth / Authelia / Cloudflare Access 等）后面。
- `docker-compose.yml` 默认只把端口绑到 `127.0.0.1`；改成 `"8555:8555"` 之前请先想清楚暴露面。
- 千万别把 8555 直接映射到公网。历史版本里这一层是完全开放的（含 CORS `*`）。

## 凭证与密钥

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `data/ctyun/app_config.json` | 账号、密码、token | 密码字段以 `ENC:` 前缀用 AES-256-GCM 加密 |
| `data/ctyun/.master.key` | 上述密文的密钥 | 与密文同目录；能读整个卷就能解密，建议 `chmod 600` |
| `data/cmcc/store.json` | 云手机设备与账号 | 面板数据 |
| `data/cmcc/billing-credentials.json` + `.billing.key` | 话费凭证（App autoLogin 请求体） | 加密落盘；等同于你手机上的登录态 |
| `.env` 的 `EXPORT_PASS` | 配置导出 / 导入口令 | 不设则该接口直接 403 |

- 备份目录 `data/backups/` 里是上述文件的每日快照（保留 7 份），权限 0600，但它**包含密钥**。
- 导出的配置文件里带明文密码与 token，别丢到公开仓库或聊天窗口。

## 仓库不含任何真实凭证

- `ctyun-dashboard/app/ecloud_engine/public_credentials.json` 在本仓库中是**占位符**，请用
  `ECLOUD_CRED_FILE` / `app/ecloud_engine/credentials.json` / 环境变量提供你自己的材料。
- 没有内置账号、手机号、token 或 cookie。

## 报告问题

发现安全问题时请开 issue（不要贴真实 token / 手机号 / 订单号），或直接提 PR。

## 仓库里带的「协议常量」是什么

`ctyun-dashboard/app/ydpc/soho_client.js` 的 `APP_KEY` / `APP_SECRET_HEX`、`app/ecloud_engine/public_credentials.json`
的 `accessKey` / `secretKey`，以及若干 hex buffer，都是**官方客户端里内置的 App 级协议常量**，
用于让请求看起来像官方客户端 —— 它们不是任何人的账号凭证，也不能单独登录任何账号（还需要你的
token / cookie / 短信验证码）。放在仓库里是为了开箱即用；平台若轮换，按文件里的注释替换即可。

真正属于「你」的秘密只有 `data/` 目录里那些：账号密码、token、cookie、话费凭证、`.master.key`。
这些一律不进仓库、不随镜像分发。
