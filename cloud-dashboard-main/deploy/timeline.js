'use strict';

/**
 * 近 24 小时心跳 / 掉线聚合（只读日志，不碰上游接口）
 *
 * 数据源：
 *   - /data/ctyun/logs/dashboard-YYYY-MM-DD.jsonl（天翼云 / 移动云电脑控制台日志）
 *   - /data/cmcc/runtime.jsonl（云手机运行时日志）
 *
 * 口径（写死在这里，前端只负责画）：
 *   beat  = 明确的保活/心跳类成功事件（心跳可达 / 数据面保活已启动 / 链路连接保持 / 保活成功）
 *   fail  = error 级事件，或 warning 级且带 失败|超时|断开|异常|掉线|退出
 *   噪声行（progress / 材料探测 / CEM 轮询 / 首帧 / firm-auth）不计入，否则图表会被刷屏
 *   每小时同时统计「有心跳的账号数」，掉线表现为该小时塌到 0
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.TIMELINE_LOG_DIR || '/data/ctyun/logs';
const CMCC_LOG = process.env.TIMELINE_CMCC_LOG || '/data/cmcc/runtime.jsonl';
const CACHE_MS = Math.max(5000, Number(process.env.TIMELINE_CACHE_MS) || 60000);
const HOURS = 24;
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const NL = String.fromCharCode(10);

let cache = { at: 0, data: null };

const NOISE_RE = /progress |SCG 材料探测|CEM |firm-auth|首帧|auth 通过|session_id|桌面登记|协议侧车启动|看门狗已启动|调度引擎已启动|服务已就绪|下一次自动化任务|任务分项均由独立 Cron/;
const BEAT_RE = /心跳可达|数据面保活已启动|链路已连接保持|保活成功|心跳成功|保活已恢复|认证成功/;
const FAIL_RE = /失败|超时|断开|异常|掉线|退出|错误|失效|拒绝/;

// 日志里的 timestamp 是宿主本地钟（Asia/Shanghai），显式补 +08:00，避免容器 UTC 造成 8 小时错位
function parseWallClock(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  const ms = Date.parse(s.replace(' ', 'T') + '+08:00');
  return Number.isFinite(ms) ? ms : 0;
}

function dayFiles(now) {
  const out = [];
  for (let i = 0; i < 2; i += 1) {
    const d = new Date(now + SHANGHAI_OFFSET_MS - i * 86400000);
    const name = 'dashboard-' + d.toISOString().slice(0, 10) + '.jsonl';
    const full = path.join(LOG_DIR, name);
    try { if (fs.statSync(full).isFile()) out.push(full); } catch (e) { /* 文件还没生成 */ }
  }
  return out;
}

function emptyBuckets(now) {
  const out = [];
  for (let i = HOURS - 1; i >= 0; i -= 1) {
    const ts = Math.floor(now / 3600000) * 3600000 - i * 3600000;
    const d = new Date(ts + SHANGHAI_OFFSET_MS);
    out.push({ ts: ts, label: String(d.getUTCHours()).padStart(2, '0') + ':00', beats: 0, fails: 0, lines: 0, accounts: new Set() });
  }
  return out;
}

function bucketOf(buckets, ts, now) {
  if (!ts) return null;
  const hoursAgo = Math.floor((now - ts) / 3600000);
  if (hoursAgo < 0 || hoursAgo >= HOURS) return null;
  return buckets[HOURS - 1 - hoursAgo];
}

// 一行日志可能属于某台具体云电脑（userServiceId: 40725079），优先用它做身份，
// 这样「每小时有几台机器有心跳」才是机器数而不是账号数
function identityOf(message, fallback) {
  const need = 'userServiceId: ';
  const k = message.indexOf(need);
  if (k >= 0) {
    let out = '';
    let i = k + need.length;
    while (i < message.length) {
      const ch = message[i];
      if (ch < '0' || ch > '9') break;
      out += ch;
      i += 1;
    }
    if (out) return 'usid:' + out;
  }
  return 'acct:' + String(fallback || '');
}

function addEvent(buckets, ts, level, message, who, now) {
  const msg = String(message || '');
  if (NOISE_RE.test(msg)) return;
  const lv = String(level || '').toLowerCase();
  const isFail = lv === 'error' || (lv === 'warning' && FAIL_RE.test(msg));
  const isBeat = !isFail && BEAT_RE.test(msg);
  if (!isFail && !isBeat) return;
  const bucket = bucketOf(buckets, ts, now);
  if (!bucket) return;
  if (isFail) bucket.fails += 1;
  if (isBeat) {
    bucket.beats += 1;
    bucket.accounts.add(identityOf(msg, who));
  }
}

// 面板活跃度：任何一行日志都算「面板当时在跑」。用来区分
//   「这一小时没有日志」（面板/容器停着）与「有日志但没心跳」（保活当时没驱动）
function markLine(buckets, ts, now) {
  const bucket = bucketOf(buckets, ts, now);
  if (bucket) bucket.lines += 1;
}

function readCtyun(buckets, now) {
  let lines = 0;
  const files = [];
  dayFiles(now).forEach((file) => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    files.push(path.basename(file));
    text.split(NL).forEach((line) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch (e) { return; }
      lines += 1;
      const numeric = Number(row.ts);
      const ts = Number.isFinite(numeric) && numeric > 0 ? numeric : parseWallClock(row.timestamp);
      markLine(buckets, ts, now);
      addEvent(buckets, ts, row.level, row.message, row.accountName || row.source || '', now);
    });
  });
  return { lines: lines, files: files };
}

function readCmcc(buckets, now) {
  let text = '';
  try { text = fs.readFileSync(CMCC_LOG, 'utf8'); } catch (e) { return { lines: 0 }; }
  let n = 0;
  text.split(NL).forEach((line) => {
    if (!line) return;
    let row;
    try { row = JSON.parse(line); } catch (e) { return; }
    n += 1;
    markLine(buckets, Number(row.ts) || 0, now);
    addEvent(buckets, Number(row.ts) || 0, row.level, row.message, row.ownerId || row.deviceId || '云手机', now);
  });
  return { lines: n };
}

function build() {
  const now = Date.now();
  const buckets = emptyBuckets(now);
  const ctyun = readCtyun(buckets, now);
  const cmcc = readCmcc(buckets, now);
  const hours = buckets.map((b) => ({ ts: b.ts, label: b.label, beats: b.beats, fails: b.fails, lines: b.lines, accounts: b.accounts.size }));
  const totals = hours.reduce((acc, h) => {
    acc.beats += h.beats;
    acc.fails += h.fails;
    if (h.accounts > acc.peakAccounts) acc.peakAccounts = h.accounts;
    return acc;
  }, { beats: 0, fails: 0, peakAccounts: 0 });
  totals.coveredHours = hours.filter((h) => h.accounts > 0).length;
  totals.windowHours = HOURS;
  totals.lines = hours.reduce((a, h) => a + h.lines, 0);
  totals.darkHours = hours.filter((h) => h.lines === 0).length;
  return {
    generatedAt: now,
    hours: hours,
    totals: totals,
    source: { ctyunLines: ctyun.lines, cmccLines: cmcc.lines, files: ctyun.files, logDir: LOG_DIR, cmccLog: CMCC_LOG }
  };
}

function get(force) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;
  let data;
  try {
    data = build();
  } catch (err) {
    data = { generatedAt: now, hours: [], totals: { beats: 0, fails: 0, peakAccounts: 0, coveredHours: 0, windowHours: HOURS }, error: String((err && err.message) || err) };
  }
  cache = { at: now, data: data };
  return data;
}

function invalidate() { cache = { at: 0, data: null }; }

module.exports = { get: get, invalidate: invalidate, HOURS: HOURS };
