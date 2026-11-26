'use strict';
// 8555 BFF：把两个内部服务（ctyun 8566 / cmcc 8577）聚合为统一资源视图 /api/resources。
// 只做「读 + 归一 + 内存分页」，不写任何业务数据，也不解析任何凭据（阶段 1 起全站单用户 local）。
// 归一规则（8 列）与状态六值见 docs/merge/02-unified-resource-model.md。

const http = require('http');
const fs = require('fs');
const path = require('path');
// 资费参考：只读本地快照（tariff-sync.js 抓取运营商公示价），拉不到就整列为空，不影响主流程
const tariffRef = require('./tariff');

const CACHE_TTL_MS = Number(process.env.RESOURCES_CACHE_TTL_MS || 5000);
const SOURCE_TIMEOUT_MS = Number(process.env.RESOURCES_SOURCE_TIMEOUT_MS || 8000);
const MAX_ROWS = Number(process.env.RESOURCES_MAX_ROWS || 500);
const MAX_PAGE_SIZE = 200;
// 上游端口可注入，便于本地验证 partial 降级（容器内固定 8566/8577）
const CTYUN_PORT = Number(process.env.RESOURCES_CTYUN_PORT || 8566);
const CMCC_PORT = Number(process.env.RESOURCES_CMCC_PORT || 8577);

// 2026-11-25：那 5 个 VDI 容器保活的正是「北京移动 · 移动爱家」名下的 5 台云电脑
// （USID 42531271/42455839/42381947/40725309/40725079），在同一个列表里出现两次纯属重复，
// 所以容器不再镜像成行。但「哪台机器由哪个容器保活、那个容器现在是否还在跑、
// 是否已被 watchdog-disabled 显式停掉」是面板必须回答的事实，故从容器侧只读读取看门狗状态，
// 用来判定行的真实状态（否则所有爱家行一律显示「容器保活中」，等于假绿）。
const VDI_DIR = process.env.VDI_DIR || '/vdi';
const VDI_KEEPER_TTL_MS = Number(process.env.VDI_KEEPER_TTL_MS || 60000);
const VDI_LOG_TAIL_BYTES = 512 * 1024;
// 实例日志可达几十 MB，最后一次 connect 行可能落在远大于 512KB 的位置
const VDI_LOG_SCAN_BYTES = Number(process.env.VDI_LOG_SCAN_BYTES || 8 * 1024 * 1024);
// 与 watchdog.py 的 WD_CYCLE_MAX_AGE 同口径（秒）：超过即判「卡死」
const VDI_CYCLE_MAX_AGE_MS = Number(process.env.VDI_CYCLE_MAX_AGE || 45 * 60) * 1000;
// 阈值只在这里定义一次：云手机失败软阈必须与 cmcc 引擎同源（引擎读 PHONE_FAIL_SOFT，默认 3），
// 云电脑「长周期」分界也只认一个常量，免得面板与两个源端各说一套。
const PHONE_FAIL_SOFT = Math.max(1, Number(process.env.PHONE_FAIL_SOFT) || 3);
const PC_LONG_INTERVAL_SEC = Math.max(60, Number(process.env.PC_LONG_INTERVAL_SEC) || 600);

// ---------------------------------------------------------------- 列定义（8 列，顺序即前端表头顺序）
const COLUMNS = [
  { key: 'typeLabel', label: '类型' },
  { key: 'name', label: '实例名称' },
  { key: 'platformLabel', label: '平台' },
  { key: 'account.label', label: '账号归属' },
  { key: 'keepalive.label', label: '保活状态' },
  { key: 'expire.text', label: '到期' },
  { key: 'heartbeat.text', label: '最近心跳' },
  { key: 'actionsText', label: '操作' },
];

const STATUS_LABEL = {
  idle: '未保活',
  keeping: '保活中',
  keeping_long: '长连保活中',
  paused: '已暂停',
  error: '异常',
  stopped: '已关机',
  // 不是面板在保活，也不是没保活：由外部（jiatingyun-pc 容器）接管，面板只读。
  // 少了这个值，看板只能把外部接管的实例显示成「未保活」，等于对用户说谎。
  managed: '容器保活中',
  // 容器纳管的两种异常：被显式停掉（没人保活）、看门狗循环停滞（保活已不可信）
  managed_off: '容器已停保活',
  managed_stalled: '容器循环停滞',
};

// ecloud=移动公众云电脑、ydpc=移动爱家（和家亲）、其余走天翼云
const PC_PLATFORM_LABEL = {
  ecloud: '移动公众云电脑',
  ydpc: '移动爱家云电脑',
  ctyun: '天翼云电脑',
};
const PHONE_PLATFORM_LABEL = '移动云手机';
const OFF_POWER_STATES = ['off', 'shutdown', 'shutting_down', 'stopped', 'poweroff', 'power_off'];

// ---------------------------------------------------------------- 小工具
const pad2 = (n) => String(n).padStart(2, '0');

function fmtTime(ms) {
  if (!ms || !Number.isFinite(Number(ms)) || Number(ms) <= 0) return '';
  const d = new Date(Number(ms));
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  );
}

function agoText(ms) {
  if (!ms) return '';
  const sec = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}

// 账号归属里只暴露打码手机号（BFF 输出脱敏的一部分）
// 账号名里带归属地（"北京移动"/"广州移动"），资费按省份收窄，否则同名的外省套餐会串价
const REGION_RE = /(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广州|深圳|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|广西|内蒙古)/;
function provinceHint(account) {
  const text = String((account && (account.name || account.label || account.remark || '')) || '');
  const m = REGION_RE.exec(text);
  return m ? m[1] : '';
}

// 资费匹配失败绝不能拖垮聚合：宁可这一行显示「未收录」
function tariffOf(name, province) {
  try {
    return tariffRef.match(name, { province: province }) || { status: 'unknown' };
  } catch (err) {
    return { status: 'unknown', error: (err && err.message) || 'match failed' };
  }
}

function maskMobile(value) {
  const m = String(value || '');
  return /^\d{11}$/.test(m) ? m.slice(0, 3) + '****' + m.slice(7) : m;
}

function accountLabel(name, mobile) {
  const parts = [];
  if (name) parts.push(String(name));
  const m = maskMobile(mobile);
  if (m) parts.push(m);
  return parts.length ? parts.join(' · ') : '—';
}

// '2026/11/30 23:59:59' 这类平台原生格式也接受
function parseLooseDate(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(/\//g, '-').replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function timeCell(ms) {
  const text = fmtTime(ms);
  return text ? { at: Number(ms), text: text + '（' + agoText(ms) + '）' } : { at: null, text: '—' };
}

// ---------------------------------------------------------------- 容器保活真值（jiatingyun-pc 只读）
// watchdog.py 写 watchdog-state.json（每实例 strikes / lastCycleMinutes / checkedAt）与
// watchdog-disabled（显式停保活的实例）。容器 ↔ 云电脑的对应关系只存在于各实例 vdi.log 的
// connect:{"userServiceId":N} 行里，没有别的映射表，所以按日志尾部反查。
function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function tailTextSafe(file, maxBytes) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { /* 关闭失败不影响读取结果 */ }
    }
  }
}

// watchdog.py 写的是宿主本地墙钟（Asia/Shanghai），且不带时区；容器多半是 UTC，
// 直接 Date.parse 会差 8 小时（把 8 小时前的循环当成"刚刚"），所以显式补 +08:00。
function parseWallClockShanghai(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ''));
  if (!m) return 0;
  const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+08:00');
  return Number.isFinite(t) ? t : 0;
}

function minutesText(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1) return '<1 分钟';
  if (n < 60) return Math.round(n) + ' 分钟';
  if (n < 1440) return Math.round(n / 60) + ' 小时';
  return Math.round(n / 1440) + ' 天';
}

function parseDisabledFile(text) {
  const indices = [];
  const notes = {};
  const comment = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.charAt(0) === '#') {
      comment.push(t.replace(/^#\s*/, ''));
      continue;
    }
    if (/^\d+$/.test(t)) indices.push(Number(t));
  }
  const blob = comment.join(' ');
  for (const idx of indices) {
    const m = new RegExp('(?:^|\\D)' + idx + '=([^\\s]+)').exec(blob);
    if (m) notes[idx] = m[1];
  }
  return { indices: indices, notes: notes, comment: blob };
}

// 日志里最后一次 connect:{"userServiceId":N} 就是该容器当前保活的云电脑
// 已停保活的实例不再产生新的 connect 行（vdi.log 里没有 userServiceId），
// 映射只能靠 watchdog-disabled 的备注与面板侧的机器名对上：
//   0 = "2C4G月包"        ↔ 42531271 vmName「2C4G版云电脑月包」（唯一同名）
//   4 = "09/04畅享版(已关机)" ↔ 40725079「家庭云电脑畅享版」且已关机（42455839 同名但运行中，已归容器 #1）
// 只用于 disabled 实例；在跑的实例一律以日志里的 connect 行为准。
const VDI_DISABLED_USID = { 0: '42531271', 4: '40725079' };

// 实例 ↔ 云电脑的权威映射来自 jiatingyun-pc/DEPLOY-NOTES.md「当前映射（2026-11-24 03:28 实测）」。
// 不能按 vdi.log 里最后一条 connect 行来认：5 个实例的日志互相夹杂着别台的 connect（实测 #3 的最后
// 一条是 42381947，实际它连的是 40725309），认错就会把行标成"保活已关闭"、丢掉容器归属。
// connect_index 会随退订/到期整体移位（2C4G 月包 11-30 到期），届时用 env VDI_INSTANCE_USID 覆盖。
const VDI_INSTANCE_USID = (() => {
  const base = { 0: '42531271', 1: '42455839', 2: '42381947', 3: '40725309', 4: '40725079' };
  try {
    const raw = JSON.parse(process.env.VDI_INSTANCE_USID || '');
    return raw && typeof raw === 'object' ? Object.assign({}, base, raw) : base;
  } catch (e) { return base; }
})();

function keeperUsidFromLog(index) {
  const file = path.join(VDI_DIR, 'repo', 'vdi_release', 'source_install', 'logs', 'logs_' + index, 'vdi.log');
  // 一轮长连接会把日志推到几十 MB，connect 行可能远在尾部之外：从文件末尾按块倒着找，
  // 找到就停，最多读 8MB（比"只读最后 512KB"稳，也比整文件读便宜）
  const text = tailTextSafe(file, VDI_LOG_SCAN_BYTES);
  if (!text) return { usid: '', logAt: 0 };
  const re = /connect:\{"userServiceId":(\d+)/g;
  let m = null;
  let last = '';
  while ((m = re.exec(text))) last = m[1];
  let logAt = 0;
  try { logAt = fs.statSync(file).mtimeMs; } catch (e) { logAt = 0; }
  return { usid: last, logAt: logAt };
}

let keeperCache = { at: 0, data: null };

function containerKeepers() {
  const now = Date.now();
  if (keeperCache.data && now - keeperCache.at < VDI_KEEPER_TTL_MS) return keeperCache.data;

  const data = {
    available: false,
    dir: VDI_DIR,
    error: '',
    instances: [],
    byUsid: {},
    disabled: [],
    stalled: [],
    active: [],
  };
  const stateText = readFileSafe(path.join(VDI_DIR, 'watchdog-state.json'));
  if (!stateText) {
    data.error = '读不到 watchdog-state.json（容器侧只读挂载缺失或路径不对）';
    keeperCache = { at: now, data: data };
    return data;
  }
  let state = {};
  try {
    state = JSON.parse(stateText);
  } catch (e) {
    data.error = 'watchdog-state.json 解析失败: ' + e.message;
    keeperCache = { at: now, data: data };
    return data;
  }
  const disabledInfo = parseDisabledFile(readFileSafe(path.join(VDI_DIR, 'watchdog-disabled')));
  const disabledSet = new Set(disabledInfo.indices);

  const indices = new Set(disabledInfo.indices);
  for (const key of Object.keys(state || {})) {
    if (/^\d+$/.test(key)) indices.add(Number(key));
  }

  for (const index of Array.from(indices).sort((a, b) => a - b)) {
    const st = state[String(index)] || {};
    const disabled = disabledSet.has(index);
    const checkedAtMs = parseWallClockShanghai(st.checkedAt);
    const cycleMin = Number(st.lastCycleMinutes);
    // 已停保活的实例日志停在停用那一刻，里面的 connect 行是"它以前保活过谁"，
    // 不是现在的归属；若让它参与 byUsid，会覆盖掉正在保活的那台的映射（实测 #4 的旧
    // connect 行就能顶掉 #2）。所以 disabled 实例只认显式表，且不登记进 byUsid。
    const logInfo = keeperUsidFromLog(index);
    const docUsid = String((disabled ? VDI_DISABLED_USID : VDI_INSTANCE_USID)[index] || '');
    let usid = docUsid || logInfo.usid;
    // 文档表与日志不一致时不改写归属（日志本就不可靠），只做标记，让页面提示"映射待核对"
    const mapDrift = !disabled && !!docUsid && !!logInfo.usid && logInfo.usid !== docUsid;
    const ageMs = checkedAtMs ? now - checkedAtMs : Infinity;
    const fresh = checkedAtMs > 0 && ageMs <= VDI_CYCLE_MAX_AGE_MS && ageMs > -60000;
    const inst = {
      index: index,
      usid: usid,
      usidSource: docUsid ? 'doc' : (logInfo.usid ? 'log' : 'none'),
      logUsid: logInfo.usid,
      mapDrift: mapDrift,
      disabled: disabled,
      disabledNote: disabledInfo.notes[index] || '',
      strikes: Number(st.strikes || 0),
      cycleText: minutesText(cycleMin),
      checkedAt: checkedAtMs,
      checkedAtText: fmtTime(checkedAtMs),
      fresh: fresh,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      ageText: checkedAtMs ? agoText(checkedAtMs) : '无记录',
      staleReason: '',
    };
    if (!disabled && !fresh) {
      inst.staleReason = '容器 #' + index + ' 已 ' + (checkedAtMs ? agoText(checkedAtMs) : '无记录') + ' 没有成功循环';
      data.stalled.push(index);
    } else if (!disabled) {
      data.active.push(index);
    }
    if (disabled) data.disabled.push(index);
    data.instances.push(inst);
    if (usid) {
      const key = String(usid);
      // 同一台云电脑不可能被两个容器同时保活：撞车时以在跑的实例为准，
      // 但已停用的实例仍要登记（面板正是靠它显示「容器 #N 已停保活」）
      const prev = data.byUsid[key];
      if (!prev || (!disabled && prev.disabled)) data.byUsid[key] = inst;
    }
  }

  data.available = true;
  // 容器整体退役（每个实例都显式停保活）后，面板是唯一托管方：
  // 继续在行上写「容器 #N 已停保活」，只会让用户以为外面还有个系统在管。
  data.retired = data.instances.length > 0 && data.instances.every(function (i) { return i.disabled; });
  keeperCache = { at: now, data: data };
  return data;
}

// ---------------------------------------------------------------- 上游读取
function fetchJson(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const req = http.request(
      { host: '127.0.0.1', port: port, path: path, method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 16 * 1024 * 1024) req.destroy(new Error('上游响应超过 16MB'));
        });
        res.on('end', () => {
          let json = null;
          let error = res.statusCode === 200 ? '' : 'HTTP ' + res.statusCode;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (e) {
            error = error || 'JSON 解析失败: ' + e.message;
          }
          finish({ ok: !error, status: res.statusCode, ms: Date.now() - started, json: json, error: error });
        });
        res.on('error', (e) => finish({ ok: false, status: res.statusCode || 0, ms: Date.now() - started, json: null, error: e.message }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('上游超时 ' + timeoutMs + 'ms')));
    req.on('error', (e) => finish({ ok: false, status: 0, ms: Date.now() - started, json: null, error: e.message }));
    req.end();
  });
}

// ---------------------------------------------------------------- 归一：云电脑行（ctyun /api/accounts）
function pcStatus(account, desktop, keeper) {
  // 由容器纳管的行：状态必须来自容器真值（watchdog-state.json + watchdog-disabled），
  // 而不是「平台是 ydpc」这一刀切——否则广州 3 台（根本没有容器）和已被
  // watchdog-disabled 停掉的 0/4 号实例都会显示「容器保活中」。
  if (keeper) {
    const tag = '容器 #' + keeper.index;
    const intervalSec = Number(account.keepaliveInterval || 0);
    if (keeper.disabled) {
      return {
        status: 'managed_off',
        intervalSec: intervalSec,
        reason: tag + ' 已停保活' + (keeper.disabledNote ? '（' + keeper.disabledNote + '）' : ''),
      };
    }
    if (!keeper.fresh) {
      return {
        status: 'managed_stalled',
        intervalSec: intervalSec,
        reason: tag + ' 已 ' + keeper.ageText + ' 没有成功循环（看门狗会尝试自愈，连续 3 次失败会告警）',
      };
    }
    return { status: 'managed', intervalSec: intervalSec, reason: tag + ' 保活中（上一轮 ' + keeper.cycleText + '前完成）' };
  }
  // 账号级登录态失效（ecloud 转短信验证/探针连续失败）时整行不能标绿：
  // 客户端 metrics.status 已经算出 needs_login/degraded/offline，BFF 以前完全不看它。
  const live = String((account.liveMetrics && account.liveMetrics.status) || '');
  if (live === 'needs_login' || live === 'offline' || live === 'degraded') {
    const shown = desktop.keepAliveView || {};
    if (!(Number(account.keepaliveInterval || 0) >= PC_LONG_INTERVAL_SEC)) {
      return {
        status: 'paused',
        intervalSec: Number(shown.intervalSec || account.keepaliveInterval || 0),
        reason: live === 'needs_login'
          ? '账号登录态失效，需要在账号面板重新短信/扫码登录'
          : (live === 'offline' ? '账号离线（探针连续失败）' : '账号状态降级，保活可能已中断'),
      };
    }
  }
  // 没有容器纳管的爱家行（例如广州）面板又拿不到 /cc 会话，只能按本地字段如实呈现
  const health = account.keepaliveHealth || {};
  const view = desktop.keepAliveView || {};
  const intervalSec = Number(view.intervalSec || account.keepaliveInterval || 0);
  const powerState = String(desktop.powerState || desktop.platformPowerState || '').toLowerCase();
  const lastLevel = String((view.lastAction || {}).level || '').toLowerCase();

  // 账号级开关（features.keepAlive===false）必须一起判：分组头关掉后行状态要跟着变「已关闭」，
  // 否则行上 enabled=false 而 status 仍是 保活中/已暂停，看板自相矛盾。
  const accountKeepAliveOff = !!(account.features && account.features.keepAlive === false);
  if (desktop.keepaliveEnabled === false || account.enabled === false || accountKeepAliveOff) {
    // 「♾️ 永久使用」的行 remainHours 也是 0，但那是无限时长，不是用尽
    const zeroHours = Number(desktop.remainHours) === 0 && !!desktop.remainText && !/永久|♾/.test(desktop.remainText);
    return {
      status: 'idle',
      intervalSec: intervalSec,
      reason: zeroHours
        ? '本月时长已用尽（' + desktop.remainText + '），下月 1 日重置'
        : (accountKeepAliveOff ? '账号级保活开关已关闭' : '实例或账号的保活已关闭'),
    };
  }
  // 机器关机是比"保活暂停"更强的现场事实（ydpc 用 vmStatusCode=16 / vmStatus='已关机'）
  // 必须与 ydpc_client isYdpcVmOff 同口径：只认 16/「关机」会把「未开机/停止/到期」算成在运行
  const vmOffCode = desktop.vmStatusCode === undefined || desktop.vmStatusCode === null
    ? null : Number(desktop.vmStatusCode);
  const vmOff = (vmOffCode !== null && [0, 16, 23].indexOf(vmOffCode) >= 0) ||
    /关机|停机|停止|未开机|到期/.test(String(desktop.vmStatus || ''));
  if (OFF_POWER_STATES.indexOf(powerState) >= 0 || vmOff) {
    return { status: 'stopped', intervalSec: intervalSec, reason: '平台状态: ' + (desktop.vmStatus || powerState) };
  }
  if (health.paused) {
    return { status: 'paused', intervalSec: intervalSec, reason: health.pausedReason || '保活已暂停' };
  }
  if (Number(health.failCount || 0) >= PHONE_FAIL_SOFT || lastLevel === 'err' || lastLevel === 'error') {
    return { status: 'error', intervalSec: intervalSec, reason: health.lastError || (view.lastAction || {}).text || '连续保活失败' };
  }
  if (intervalSec >= PC_LONG_INTERVAL_SEC) return { status: 'keeping_long', intervalSec: intervalSec, reason: '' };
  return { status: 'keeping', intervalSec: intervalSec, reason: '' };
}

function pcStaleReason(account, desktop, intervalSec) {
  // lastPulseAt 是天翼云保活 worker 实际写的心跳字段（server.js 里只写这个），
  // 只认 lastKeepAliveAt 会让所有天翼云行永远"无心跳记录"。
  const beat = Number(desktop.lastKeepAliveAt || desktop.lastPulseAt || desktop._l2At || 0);
  if (!beat) return '无心跳记录';
  const threshold = Math.max(300, intervalSec || 0) * 3 * 1000;
  if (Date.now() - beat > threshold) return '心跳已超时（>' + Math.round(threshold / 1000) + 's）';
  if (desktop.staleAt) return '上游标记 stale';
  return '';
}

function toPcRows(account, keepers) {
  const platform = String(account.platform || '');
  const platformLabel = PC_PLATFORM_LABEL[platform] || platform || '未知云电脑';
  const desktops = Array.isArray(account.desktops) && account.desktops.length
    ? account.desktops
    : Array.isArray(account.vms) ? account.vms : [];
  const health = account.keepaliveHealth || {};
  const province = provinceHint(account);
  // 账号级保活字段必须一起下发：看板的分组头（开关/周期）与行状态都以此为唯一真相，
  // 缺了它前端只能靠会话内 override 兜，刷新或新标签页就回弹。
  const accountEnabled = !(account.features && account.features.keepAlive === false);
  // 移动爱家（和家亲）的 /cc 会话被上游按 (AppKey,DeviceId) 拒（docs/merge/12），
  // 面板写开关只会得到"面板以为在保活、实际没人连"的假象，因此这平台的行一律标只读，
  // 前端据此禁用开关与周期；但「哪个容器在保活」要按容器的真实映射逐行判定，不能按平台一刀切。
  // 只有"容器仍在保活"的实例才算接管；watchdog-disabled 停掉的实例由面板接手，
  // 否则会出现"容器已停保活"却仍把行标成只读、面板永远不可写的自相矛盾。
  const containersRetired = !!(keepers && keepers.retired);
  const keeperOf = (desktop) => {
    if (platform !== 'ydpc' || !keepers || containersRetired) return null;
    const id = String(desktop.instanceId || desktop.userServiceId || desktop.machineId || '');
    const inst = (id && keepers.byUsid[id]) || null;
    return inst && !inst.disabled ? inst : null;
  };
  const stoppedKeeperOf = (desktop) => {
    if (platform !== 'ydpc' || !keepers || containersRetired) return null;
    const id = String(desktop.instanceId || desktop.userServiceId || desktop.machineId || '');
    const inst = (id && keepers.byUsid[id]) || null;
    return inst && inst.disabled ? inst : null;
  };
  // 面板是否被授权接管这个移动爱家账号（账号级保活开关 = 面板接管的意图信号）。
  // 关着就说明机器仍归容器或无人管，面板不该写；开着才允许逐台开。
  const panelOwnsAccount = desktop => platform === 'ydpc' && accountEnabled &&
    !!(account.features && account.features.keepAlive === true);
  const groupHasContainer = desktops.some((d) => !!keeperOf(d || {}));
  const containerReadOnly = platform === 'ydpc' && !containersRetired;
  // 只读的原因必须写准：有会话但账号开关没开，和"根本没登录"是两件事，
  // 都写"面板未接管"会让用户以为扫码没生效。
  const hasSession = account.hasToken === true || account.hasCookie === true;
  const accountWritable = panelOwnsAccount();
  // 账号可写时不能再写「开关未开」——features.keepAlive 已经是 true、面板正在保活，
  // 那句话只会让用户去关一个本来就开着的开关。
  const readOnlyNote = !containerReadOnly || accountWritable
    ? ''
    : groupHasContainer
      ? '容器接管 · 只读'
      : (hasSession ? '账号级保活开关未开 · 只读（面板已登录）' : '面板无会话（未登录）· 只读');
  const accountRef = {
    id: account.id || '',
    name: account.name || '',
    label: accountLabel(account.name, account.user),
    platform: platform,
    enabled: accountEnabled,
    keepaliveInterval: Number(account.keepaliveInterval || 0) || 0,
    hasSession: hasSession,
    readOnly: containerReadOnly && !accountWritable,
    readOnlyNote: readOnlyNote,
  };

  return desktops.map((desktop) => {
    const keeper = keeperOf(desktop);
    const stoppedKeeper = keeper ? null : stoppedKeeperOf(desktop);
    // 行级只读：容器在保活 → 只读；容器已停保活（disabled）→ 面板可写；
    // 面板未接管账号 → 只读
    const rowReadOnly = containerReadOnly && (!!keeper || !accountWritable);
    const rowReadOnlyNote = keeper
      ? ('容器 #' + keeper.index + ' 接管 · 只读' + (keeper.mapDrift ? ' · 映射待核对（日志显示 ' + keeper.logUsid + '）' : ''))
      : (stoppedKeeper
        ? ('容器 #' + stoppedKeeper.index + ' 已停保活，面板可接管')
        : readOnlyNote);
    const state = pcStatus(account, desktop, keeper);
    // 容器纳管的行：stale 取容器真值（显式停保活不算 stale，看门狗停滞才算）；
    // 非容器行仍按面板心跳判定——没有心跳记录就是没有心跳记录，不能因为平台是 ydpc 就不报。
    // stale 的语义是「本应在保活，却没心跳」。未保活/已关机/时长用尽的行没有心跳是正常状态，
    // 一律标 stale 只会制造噪音（曾让广州 3 台和时长用尽的 0 号常年飘红）。
    const staleAllowed = state.status === 'keeping' || state.status === 'keeping_long' || state.status === 'error';
    const staleReason = keeper
      ? (keeper.disabled ? '' : (keeper.staleReason || ''))
      : (staleAllowed ? pcStaleReason(account, desktop, state.intervalSec) : '');
    const beat = keeper && keeper.checkedAt ? keeper.checkedAt : Number(desktop.lastKeepAliveAt || desktop.lastPulseAt || desktop._l2At || 0);
    const instanceId = desktop.instanceId || desktop.userServiceId || desktop.machineId || '';
    const name = desktop.machineName || desktop.vmName || desktop.skuName || String(instanceId || '');
    const expireText = desktop.expireAt ? String(desktop.expireAt) : '';
    // 服务已到期：开关开着也连不上，必须与"用户没开保活"区分开
    const expireAtMs = parseLooseDate(expireText);
    const expired = !!expireAtMs && expireAtMs < Date.now();
    // 「保活开着」不等于「会一直在线」：关机后要靠自动开机守护拉起，守护没开时机器一关就掉线。
    // 口径与 ydpc_client.js _autoBootArmed 一致（账号级 autoBoot + 单机 autoBootEnabled，SCG 底座默认开）。
    const autoBootOn = !(account.features && account.features.autoBoot === false) &&
      (desktop.autoBootEnabled !== undefined
        ? desktop.autoBootEnabled !== false
        // 只有移动爱家（ydpc）要按底座判默认：SCG 有 CAG 开机通道、ZTE 没有（ydpc_client.js _autoBootArmed）；
        // 天翼云侧 server.js:2146 与 ecloud_client.js:784 都是「未显式关闭即开」，套 SCG 规则会误报。
        : (platform === 'ydpc' ? String(desktop.vendor || '').toUpperCase() === 'SCG' : true));
    const keepaliveOn = desktop.keepaliveEnabled !== false && accountEnabled;
    const remindAutoBootOff = keepaliveOn && !autoBootOn;
    return {
      id: (account.id || '') + ':' + (instanceId || name || ''),
      type: 'pc',
      typeLabel: '云电脑',
      name: name || '（未命名云电脑）',
      platform: platform,
      platformLabel: platformLabel,
      account: accountRef,
      keepalive: {
        status: state.status,
        label: STATUS_LABEL[state.status] || state.status,
        enabled: desktop.keepaliveEnabled !== false && accountEnabled,
        paused: !!health.paused,
        pausedReason: health.pausedReason || '',
        intervalSec: state.intervalSec,
        // 仅展示用（云电脑的周期由源端 cron/心跳决定，面板不写这个字段）
        mode: state.intervalSec >= PC_LONG_INTERVAL_SEC ? 'long' : 'periodic',
        failCount: Number(health.failCount || 0),
        lastError: health.lastError || '',
        reason: (expired && state.status !== 'keeping' && state.status !== 'keeping_long' && state.status !== 'managed')
          ? ('服务已到期（' + expireText + '）' + (state.reason ? ' · ' + state.reason : ''))
          : (state.reason || ''),
        expired: expired,
      },
      // 行级提醒：保活开着但自动开机守护关着（机器关机后不会被拉起）
      reminder: remindAutoBootOff
        ? { code: 'autoboot-off', text: '⚡ 保活已开，但「自动开机」未开：这台机器一旦关机就不会被自动拉起（详情 → 打开「自动开机」）' }
        : null,
      // 包月永久使用的机器没有到期时间，写「—」会被读成"缺数据"，直接写永久
      expire: expireText
        ? { at: parseLooseDate(expireText), text: expireText }
        : { at: null, text: (/永久|♾/.test(String(desktop.remainText || '')) ? '♾️ 永久' : '—') },
      // 容器纳管的行：面板没有心跳来源，列里给容器上一轮成功循环的时间才有意义
      heartbeat: keeper
        ? { at: keeper.checkedAt, text: '容器 #' + keeper.index + ' · ' + keeper.cycleText + '前' }
        : timeCell(beat),
      actions: [
        { id: 'open', label: '打开画面' },
        { id: 'keepalive-toggle', label: '保活开关' },
        { id: 'power', label: '电源' },
      ],
      actionsText: rowReadOnly ? '打开画面 / 详情' : '打开画面 / 保活开关 / 电源',
      stale: !!staleReason,
      staleReason: staleReason,
      readOnly: rowReadOnly,
      readOnlyNote: rowReadOnlyNote,
      // 归属：谁在保活这台机器（容器序号 / 面板 / 无人）
      owner: keeper
        ? { kind: 'container', index: keeper.index, label: '容器 #' + keeper.index }
        : (stoppedKeeper
          ? { kind: 'panel', index: null, label: '面板（容器 #' + stoppedKeeper.index + ' 已停）' }
          : (platform === 'ydpc' && !accountWritable
            ? { kind: 'none', index: null, label: hasSession ? '无（开关未开）' : '无（未登录）' }
            : { kind: 'panel', index: null, label: '面板' })),
      source: 'ctyun',
      accountId: account.id || '',
      instanceId: String(instanceId || ''),
      // 同名实例（家庭云电脑畅享版有两台）靠尾号区分，前端直接显示，不必开抽屉才知道是哪台
      shortId: String(instanceId || '').replace(/^[A-Za-z]+-/, '').slice(-5),
      powerState: desktop.vmStatus || desktop.powerState || '',
      // 单机任务开关（打卡/挂机）：看板抽屉要能直接改，不必回到账号卡片
      taskEnabled: desktop.taskEnabled !== false,
      // 自动开机守护的实际武装状态 = 账号级开关 且 单机开关（单机未显式设置时按底座默认：SCG 开、ZTE 关）
      // 只报单机字段会骗人：广州 2C4G 单机开着但账号级/单机口径错判时机器一直关机
      autoBootEnabled: autoBootOn,
      // 资费参考（运营商公示价，不是账单）：ok 才有唯一月价，ambiguous 列候选，未收录也照实说
      tariff: tariffOf(name, province),
      // 包月类云电脑的"时长"是关机真因：0 小时时开关全开着也连不上，面板必须照实说明
      remain: (desktop.remainText || Number.isFinite(Number(desktop.remainHours)))
        ? { hours: Number(desktop.remainHours || 0), text: String(desktop.remainText || '') }
        : null,
    };
  });
}

// ---------------------------------------------------------------- 归一：云手机行（cmcc /api/dashboard）
// 云手机状态必须读引擎的运行态快照（cmcc server.js:178 runtime = engine.getRuntimeSnapshot），
// 只按静态字段推导的话：引擎没起来、连接早断了、被浏览器抢了会话，面板全都显示「保活中」。
function phoneStatus(device) {
  const rt = device.runtime || {};
  const rtState = String(rt.state || '');
  // 连续失败自动停用（store.js 里 pausedReason 与 keepaliveEnabled=false 同时写）优先于「开关关闭」：
  // 否则系统停用会被显示成用户自己关的，运维永远不会去查失败原因。
  if (device.pausedReason || rt.pausedReason) return { status: 'paused', reason: device.pausedReason || rt.pausedReason };
  if (!device.keepaliveEnabled) return { status: 'idle', reason: '该设备的保活已关闭' };
  if (rtState === 'KEEPING') {
    return {
      status: String(device.keepaliveMode || '') === 'continuous' ? 'keeping_long' : 'keeping',
      reason: rt.stateText || '',
    };
  }
  if (rtState === 'ERROR') return { status: 'error', reason: rt.lastError || device.lastError || '保活连接异常' };
  if (rtState === 'RECONNECTING' || rtState === 'CONNECTING' || rtState === 'PREPARING') {
    return { status: 'keeping', reason: '正在重连（' + (rt.stateText || rtState) + '）' };
  }
  if (rtState === 'WEB_CONTROL') return { status: 'paused', reason: '浏览器实时控制中，后台保活已让位' };
  if (rtState === 'SCHEDULE_WAIT') return { status: 'idle', reason: '等待下一轮保活（' + (rt.stateText || '周期等待') + '）' };
  if (Number(device.failCount || 0) >= PHONE_FAIL_SOFT) return { status: 'error', reason: device.lastError || '连续保活失败' };
  return { status: 'idle', reason: rt.stateText || '保活引擎未在运行' };
}

function phoneStaleReason(device) {
  if (device.synced === false) return '设备未同步';
  if (device.staleAt) return '上游标记 stale（' + fmtTime(device.staleAt) + '）';
  // socket 半死时引擎状态可能还残留 KEEPING：必须用心跳时间判活，否则永远绿。
  const rt = device.runtime || {};
  if (String(rt.state || '') === 'KEEPING') {
    const beatAt = Number(rt.lastHeartbeatAt || device.lastSuccessAt || 0);
    const cycleSec = Math.max(60, Number(device.waitMinutes || 5) * 60);
    const thr = Math.max(180, cycleSec * 3) * 1000;
    if (!beatAt) return '处于保活态但无心跳记录';
    if (Date.now() - beatAt > thr) return '心跳已超时（>' + Math.round(thr / 1000) + 's 未成功）';
  }
  if (device.keepaliveEnabled && !device.lastSuccessAt) return '从未成功保活';
  return '';
}

function toPhoneRows(device, account) {
  const state = phoneStatus(device);
  const staleReason = phoneStaleReason(device);
  const beat = Number(device.lastSuccessAt || 0);
  const accountInterval = Number((account && account.keepaliveInterval) || 0);
  return {
    id: device.id || device.phoneId || '',
    type: 'phone',
    typeLabel: '云手机',
    name: device.phoneName || device.phoneId || '（未命名云手机）',
    platform: 'cmcc-phone',
    platformLabel: PHONE_PLATFORM_LABEL,
    account: {
      id: device.accountId || '',
      name: device.accountRemark || '',
      label: accountLabel(device.accountRemark, device.accountMobile),
      platform: 'cmcc-phone',
      enabled: !!(account && account.keepaliveEnabled !== false),
      keepaliveInterval: Number((account && account.keepaliveInterval) || 0) || 0,
    },
    keepalive: {
      status: state.status,
      label: STATUS_LABEL[state.status] || state.status,
      enabled: !!device.keepaliveEnabled,
      paused: !!device.pausedReason,
      pausedReason: device.pausedReason || '',
      // 云手机没有账号级周期字段（store sanitizeAccount 不带 keepaliveInterval），
      // 间隔只能取设备自己的 waitMinutes；cycle 模式下引擎真实周期是 wait+connect
      // （keepaliveEngine.js 相位 elapsed % (wait+connect)），只报 waitMinutes 会少报一半。
      intervalSec: Number(device.waitMinutes || 0) * 60 +
        (String(device.keepaliveMode || '') === 'cycle' ? Number(device.connectMinutes || 0) * 60 : 0),
      // 只透传后端真实认识的两个值（continuous / cycle），不要再发明第三值 scheduled（PATCH 会 400）
      mode: String(device.keepaliveMode || ''),
      failCount: Number(device.failCount || 0),
      lastError: device.lastError || '',
      reason: state.reason || '',
    },
    expire: device.expireStr
      ? { at: device.endTime ? Date.parse(String(device.endTime).replace(' ', 'T')) || null : null, text: device.expireStr + (device.isExpired ? '（已到期）' : '') }
      : { at: null, text: '—' },
    heartbeat: timeCell(beat),
    actions: [
      { id: 'open', label: '打开画面' },
      { id: 'keepalive-toggle', label: '保活开关' },
      { id: 'power', label: '电源' },
    ],
    actionsText: '打开画面 / 保活开关 / 电源',
    stale: !!staleReason,
    staleReason: staleReason,
    source: 'cmcc',
    accountId: device.accountId || '',
    instanceId: device.phoneId || '',
    powerState: '',
    tariff: tariffOf(device.phoneName || '', provinceHint(account || { name: device.accountRemark })),
  };
}

// ---------------------------------------------------------------- 聚合 + 缓存
const cache = { at: 0, data: null, inflight: null };

/**
 * 写屏障：面板的写请求都走 boot.js 反代到源端，BFF 的 5s 缓存不会自己知道。
 * 写成功后立刻作废缓存，否则「改完开关马上刷新」读回旧快照（前端曾靠 refresh=1 绕开）。
 */
function invalidate() {
  cache.at = 0;
  cache.data = null;
}

async function buildSnapshot() {
  const startedAt = Date.now();
  const [ctyunRes, cmccRes] = await Promise.all([
    fetchJson(CTYUN_PORT, '/api/accounts', SOURCE_TIMEOUT_MS),
    fetchJson(CMCC_PORT, '/api/dashboard', SOURCE_TIMEOUT_MS),
  ]);

  const rows = [];
  const sources = {
    ctyun: { ok: false, status: ctyunRes.status, ms: ctyunRes.ms, error: '', count: 0, platform: '云电脑（ecloud/ydpc）' },
    cmcc: { ok: false, status: cmccRes.status, ms: cmccRes.ms, error: '', count: 0, platform: '云手机（cmcc-phone）' },
  };
  const partialReasons = [];

  const keepers = containerKeepers();

  if (ctyunRes.ok && ctyunRes.json) {
    const accounts = Array.isArray(ctyunRes.json) ? ctyunRes.json : ctyunRes.json.accounts || [];
    let pcCount = 0;
    for (const account of accounts) {
      const added = toPcRows(account || {}, keepers);
      pcCount += added.length;
      for (const row of added) rows.push(row);
    }
    sources.ctyun.ok = true;
    sources.ctyun.count = pcCount;
  } else {
    sources.ctyun.error = ctyunRes.error || '云电脑服务不可达';
    partialReasons.push('云电脑数据缺失: ' + sources.ctyun.error);
  }

  if (cmccRes.ok && cmccRes.json) {
    const devices = Array.isArray(cmccRes.json.devices) ? cmccRes.json.devices : [];
    const phoneAccounts = new Map(
      (Array.isArray(cmccRes.json.accounts) ? cmccRes.json.accounts : []).map((a) => [a.id, a])
    );
    for (const device of devices) {
      rows.push(toPhoneRows(device || {}, phoneAccounts.get(device && device.accountId) || null));
    }
    sources.cmcc.ok = true;
    sources.cmcc.count = devices.length;
  } else {
    sources.cmcc.error = cmccRes.error || '云手机服务不可达';
    partialReasons.push('云手机数据缺失: ' + sources.cmcc.error);
  }

  // 稳定排序：云电脑在前，再按平台、账号、名称
  const TYPE_ORDER = { pc: 0, phone: 1 };
  rows.sort((a, b) => {
    const t = (TYPE_ORDER[a.type] || 0) - (TYPE_ORDER[b.type] || 0);
    if (t) return t;
    return (
      String(a.platform || '').localeCompare(String(b.platform || '')) ||
      String(a.account.label || '').localeCompare(String(b.account.label || '')) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    );
  });

  return {
    fetchedAt: Date.now(),
    buildMs: Date.now() - startedAt,
    items: rows,
    sources: sources,
    partial: !sources.ctyun.ok || !sources.cmcc.ok,
    partialReasons: partialReasons,
    // 容器保活真值：前端据此显示「谁在保活」与看门狗健康，而不是把平台当容器
    keepers: {
      available: keepers.available,
      dir: keepers.dir,
      error: keepers.error,
      active: keepers.active,
      stalled: keepers.stalled,
      disabled: keepers.disabled,
      instances: keepers.instances,
    },
  };
}

async function getSnapshot(force) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return Object.assign({}, cache.data, { cache: { hit: true, ageMs: now - cache.at, ttlMs: CACHE_TTL_MS } });
  }
  if (cache.inflight) {
    const data = await cache.inflight;
    return Object.assign({}, data, { cache: { hit: true, ageMs: Date.now() - cache.at, ttlMs: CACHE_TTL_MS, shared: true } });
  }
  cache.inflight = (async () => {
    try {
      const snapshot = await buildSnapshot();
      cache.data = snapshot;
      cache.at = Date.now();
      return snapshot;
    } finally {
      cache.inflight = null;
    }
  })();
  const data = await cache.inflight;
  return Object.assign({}, data, { cache: { hit: false, ageMs: 0, ttlMs: CACHE_TTL_MS } });
}

// ---------------------------------------------------------------- 过滤 / 分页
function pickInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function applyFilters(items, params) {
  const type = params.get('type') || '';
  const platform = params.get('platform') || '';
  const status = params.get('status') || '';
  const staleOnly = params.get('stale') === '1';
  const q = (params.get('q') || '').trim().toLowerCase();
  return items.filter((row) => {
    if (type && row.type !== type) return false;
    if (platform && row.platform !== platform) return false;
    if (status && row.keepalive.status !== status) return false;
    if (staleOnly && !row.stale) return false;
    if (q) {
      const hay = [row.name, row.platformLabel, row.account.label, row.keepalive.label, row.instanceId].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}

function summarize(items) {
  const byStatus = {};
  let pc = 0;
  let phone = 0;
  let stale = 0;
  // 月资费参考：只累加"唯一月价"的行；多档/未收录单独计数，绝不摊进合计
  let costMonthly = 0;
  let costMatched = 0;
  let costAmbiguous = 0;
  let costUnknown = 0;
  for (const row of items) {
    byStatus[row.keepalive.status] = (byStatus[row.keepalive.status] || 0) + 1;
    if (row.type === 'pc') pc += 1;
    else phone += 1;
    if (row.stale) stale += 1;
    const t = row.tariff || {};
    if (t.status === 'ok' && typeof t.monthly === 'number') { costMonthly += t.monthly; costMatched += 1; }
    else if (t.status === 'ambiguous') costAmbiguous += 1;
    else costUnknown += 1;
  }
  return {
    total: items.length, pc: pc, phone: phone, stale: stale, byStatus: byStatus,
    costMonthly: Math.round(costMonthly * 100) / 100,
    costMatched: costMatched, costAmbiguous: costAmbiguous, costUnknown: costUnknown,
  };
}

// ---------------------------------------------------------------- HTTP handler
async function handle(url, res) {
  const force = url.searchParams.get('refresh') === '1';
  let snapshot;
  try {
    snapshot = await getSnapshot(force);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: '聚合失败: ' + (err && err.message) }));
    return;
  }

  const filtered = applyFilters(snapshot.items, url.searchParams);
  const truncated = filtered.length > MAX_ROWS;
  const kept = truncated ? filtered.slice(0, MAX_ROWS) : filtered;
  const page = pickInt(url.searchParams.get('page'), 1, 1, 100000);
  const pageSize = pickInt(url.searchParams.get('pageSize'), 50, 1, MAX_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(kept.length / pageSize));
  const items = kept.slice((page - 1) * pageSize, page * pageSize);

  const body = {
    ok: true,
    generatedAt: Date.now(),
    lastRefreshAt: snapshot.fetchedAt,
    lastRefreshText: fmtTime(snapshot.fetchedAt),
    buildMs: snapshot.buildMs,
    cache: snapshot.cache,
    partial: snapshot.partial,
    partialReasons: snapshot.partialReasons,
    sources: snapshot.sources,
    keepers: snapshot.keepers,
    // 资费快照自己的新鲜度：界面上要能看出"这是哪天的价"
    tariff: (function () {
      const db = tariffRef.load();
      return {
        updated: db.raw ? (db.raw.updated || '') : '',
        fetchedAt: db.raw ? Number(db.raw.fetchedAt || 0) : 0,
        plans: db.plans.length,
        source: db.raw ? (db.raw.source || '') : '',
        error: db.raw ? '' : (db.error || '未同步资费快照'),
        changes: (db.raw && db.raw.changes) || null,
      };
    })(),
    columns: COLUMNS,
    counts: summarize(kept),
    page: page,
    pageSize: pageSize,
    pages: pages,
    total: kept.length,
    truncated: truncated,
    droppedRows: truncated ? filtered.length - MAX_ROWS : 0,
    items: items,
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

module.exports = { handle: handle, invalidate: invalidate, COLUMNS: COLUMNS, buildSnapshot: buildSnapshot };
