# cloud-dashboard · 云电脑 / 云手机 统一保活面板

把天翼云电脑、中国移动云电脑（和家亲 / 爱家）、中国移动云手机三个平台塞进**一个自托管面板**：
账号保活、自动开机守护、实例看板、资费库、话费查询、运行日志，全在一个页面里。

> 非官方项目，与任何运营商无关；用的是各平台官方客户端自己的接口，协议可能随时变更。
> 面板**默认不带登录**，只适合放在内网 / 反代后面。详见 [SECURITY.md](SECURITY.md)。

---

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 多平台账号 | 天翼云电脑（ecloud）、中国移动云电脑（ydpc / SOHO，SCG 与 ZTE 两种通道）、中国移动云手机（cmcc-phone） |
| 登录方式 | 账号密码、短信验证码、移动爱家 App 扫码（新增账号与补登录态都支持扫码） |
| 保活 | 心跳 / 长连接 / MQTT 三档，支持「连续保活」与「周期保活（开机 N 分钟 + 间隔 N 分钟）」 |
| 自动开机守护 | 机器被关机后自动拉起；与保活开关**独立**，行上会给「保活已开但自动开机未开」的提醒徽标 |
| 实例看板 | 表格 / 卡片两种视图，按账号分组，行内直接开关保活、自动开机、周期排序，抽屉里看详情与日志 |
| 资费库 | 抓运营商官网公示资费构建本地快照：云电脑 / 云手机 1102 条 + 号卡 7738 条，每 12 小时同步并做变更比对；每条带「怎么开通 / 去哪办 / 怎么退」，公示里写的短信指令逐条列出 |
| 话费（只读） | 用中国移动 App 的 autoLogin 凭证换会话，读余额、本月消费、套餐余量、积分（凭证只保存一次，AES-256-GCM 落盘） |
| 可视化 | 状态分布环图、近 24 小时心跳与掉线时间线、到期时间轴、月资费估算 |
| 运维 | 日志检索、配置导出 / 导入（带口令闸门）、每日配置快照（保留 7 份） |

## 架构

三个进程跑在同一个容器里，由 `deploy/boot.js` 负责编排：

```
浏览器 ──► :8555  deploy/boot.js        统一壳（静态页 + BFF /api/*）
                     ├─► :8566  ctyun-dashboard  天翼云 / 移动云电脑
                     └─► :8577  cmcc-phone       中国移动云手机

:8555 只做聚合与静态托管：/api/resources（实例看板）、/api/timeline（心跳时间线）、
/api/tariff、/api/tariff/catalog（资费库）、/api/cmcc-billing（话费）、/api/config/*（配置）。
:8566 / :8577 保持各自完整的原面板，BFF 通过回环调用它们。
```

```
cloud-dashboard-main/
├── deploy/                # BFF 与容器编排：boot.js 网关、resources.js 看板聚合、
│                          # tariff.js 资费匹配、timeline.js 心跳聚合、cmcc_billing.js 话费协议
├── ctyun-dashboard/       # 云电脑面板（Node + 原生前端，含 ydpc / ecloud / SCG / ZTE 通道实现）
└── cmcc-phone/            # 云手机面板（保活引擎 + 和家亲接口）
```

## 快速开始

```bash
git clone https://github.com/<you>/cloud-dashboard.git && cd cloud-dashboard
cp -n .env.example .env 2>/dev/null || true
echo "EXPORT_PASS=$(openssl rand -base64 18)" >> .env   # 配置导出/导入的口令
docker compose build
docker compose up -d
```

打开 <http://127.0.0.1:8555> ，在「资源」页右上角「添加」里选平台加账号：

- **天翼云电脑**：账号密码或短信验证码。
- **中国移动云电脑 / 云手机**：短信验证码，或「📱 App 扫码」用和家亲 / 爱家 App 扫一下。
- **话费页**：按页面里的抓包指引，用手机抓一次中国移动 App 的 `autoLogin` 请求体粘进去（只需一次）。

数据全部落在 `./data`（配置、日志、资费快照、凭证），删掉这个目录等于恢复出厂。

## 常用环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `EXPORT_PASS` | 无 | 配置导出 / 导入必须带 `X-Export-Pass` 头 |
| `LOCAL_NOAUTH` | `1` | 设为 `0` 恢复原面板的登录校验 |
| `TARIFF_SYNC_HOURS` | `12` | 资费库同步间隔，`0` 关闭 |
| `TARIFF_FULL_SECTIONS` | `beijing,guangdong,quanguo` | 号卡目录抓哪几个分区 |
| `PC_LONG_INTERVAL_SEC` | `600` | 云电脑「长保活」判定阈值（秒） |
| `PHONE_FAIL_SOFT` | `3` | 云手机软失败阈值 |
| `RESOURCES_CACHE_TTL_MS` | `5000` | 看板聚合缓存 |
| `BACKUP_KEEP` | `7` | 每日配置快照保留份数 |
| `NODE_IMAGE` | `node:22-bookworm-slim` | 构建用基础镜像（国内可换镜像站） |

完整清单：`grep -rho "process.env.[A-Z0-9_]*" cloud-dashboard-main --include="*.js" | sort -u`。

## 已知边界

- **不是官方客户端**：接口来自各平台官方 App / 网页，随时可能改；改了就等上游适配，面板没有兜底。
- **云手机保活**依赖和家亲的长连接能力，平台侧风控收紧时成功率会下降，面板会在连续失败后自动停用并在行上标注原因。
- **资费库**是官网公示价（快照），不等于你的账单；个人实订套餐 / 余量 / 账单只有登录中国移动 App 才拿得到（见话费页）。
- **话费凭证**是 App 的长效登录凭证，能读你名下的话费信息，务必只放在自己的机器上；面板以 AES-256-GCM 加密落盘，但能够读容器卷的人就能解密。
- 移动爱家「摄像头 / 看家 / 云存」这类智慧家庭业务尚未接入（需要抓一次 App 的对应请求，欢迎 PR）。

## 致谢与来源

- 上游面板：<https://github.com/717998477/cloud-dashboard>（本仓库在其基础上做了统一网关、保活引擎修补、资费与话费模块）
- 中国移动 App 协议参考：<https://github.com/margrop/ha-china-mobile>（MIT）
- 资费数据：各运营商官网资费公示专区

## 许可

MIT，见 [LICENSE](LICENSE)。仅供个人自用与研究，请遵守各平台服务条款；因使用本工具导致的账号风险、费用或数据损失由使用者自负。
