'use strict';

/**
 * 单容器双进程引导器
 *   - 子进程 1：天翼云 / 移动云电脑控制台（ctyun-dashboard），默认 8566
 *   - 子进程 2：中国移动云手机控制台（cmcc-phone），默认 8577
 *   - 本进程：8555 唯一入口控制台（顶栏双页签内嵌两个子应用）+ /health + 反代
 *
 * 设计原则：
 *   1. 两个上游项目互不感知，各自用独立的数据目录，互不污染；
 *   2. 任一子进程崩溃自动拉起（指数退避，稳定运行后重置）；
 *   3. 收到 SIGTERM/SIGINT 时先给子进程发信号，等待退出，避免数据写坏；
 *   4. 只依赖 Node 内置模块，不引入 supervisor / s6 之类的额外组件。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const resources = require('./resources');
const tariff = require('./tariff');
const timeline = require('./timeline');
const billing = require('./cmcc-billing-api');

// 配置导出/导入是唯一会把账号密码明文下发或写入的接口（备份格式必须保持可恢复，故不改格式）。
// 这两个接口在 8555 上默认不对外：必须携带与 EXPORT_PASS 一致的口令，口令未配置则一律拒绝。
const EXPORT_PASS = process.env.EXPORT_PASS || '';
const SECRET_CONFIG_PATHS = [/^\/(?:ctyun\/)?api\/config\/(?:export|import)$/i];

function isSecretConfigPath(pathname) {
  return SECRET_CONFIG_PATHS.some((re) => re.test(pathname));
}

// 只认请求头：query 参数会进浏览器历史、反代日志与 Referer，口令不能走 URL。
function secretConfigAllowed(req) {
  if (!EXPORT_PASS) return false;
  return String(req.headers['x-export-pass'] || '') === EXPORT_PASS;
}

const CTYUN_DIR = process.env.CTYUN_DIR || '/opt/ctyun';
const CMCC_DIR = process.env.CMCC_DIR || '/opt/cmcc';
const DATA_ROOT = process.env.DATA_ROOT || '/data';
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 8555);

const APPS = [
  {
    name: 'ctyun',
    label: '天翼云 / 移动云电脑',
    port: Number(process.env.CTYUN_PORT || 8566),
    script: path.join(CTYUN_DIR, 'server.js'),
    cwd: CTYUN_DIR,
    dataDir: path.join(DATA_ROOT, 'ctyun'),
    env: (dataDir, port) => ({
      PORT: String(port),
      CTYUN_DATA_DIR: dataDir,
      ECLOUD_CRED_FILE: path.join(dataDir, 'ecloud_credentials.json'),
      ECLOUD_SESSION_FILE: path.join(dataDir, 'ecloud_sessions.json'),
      ECLOUD_LOGIN_RATE_LIMIT_FILE: path.join(dataDir, 'ecloud_login_rate_limit.json'),
      ECLOUD_PYTHON: process.env.ECLOUD_PYTHON || '/usr/bin/python3',
    }),
  },
  {
    name: 'cmcc',
    label: '中国移动云手机',
    port: Number(process.env.CMCC_PORT || 8577),
    script: path.join(CMCC_DIR, 'src', 'server.js'),
    cwd: CMCC_DIR,
    dataDir: path.join(DATA_ROOT, 'cmcc'),
    env: (dataDir, port) => ({
      PORT: String(port),
      DATA_DIR: dataDir,
      HOST: '0.0.0.0',
    }),
  },
];

const children = new Map();
let shuttingDown = false;

function log(app, line, isErr) {
  const text = String(line).replace(/\r/g, '');
  const stream = isErr ? process.stderr : process.stdout;
  for (const piece of text.split('\n')) {
    if (piece.trim().length === 0) continue;
    stream.write(`[${app}] ${piece}\n`);
  }
}

function pipeLines(stream, app, isErr) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const p of parts) log(app, p, isErr);
  });
  stream.on('end', () => {
    if (buffer) {
      log(app, buffer, isErr);
      buffer = '';
    }
  });
}

function startApp(app, priorFailures = 0) {
  if (shuttingDown) return;

  if (!fs.existsSync(app.script)) {
    log(app.name, `启动失败：找不到入口文件 ${app.script}`, true);
    return scheduleRestart(app, { failures: priorFailures + 1, startedAt: 0 });
  }

  fs.mkdirSync(app.dataDir, { recursive: true });

  const child = spawn(process.execPath, [app.script], {
    cwd: app.cwd,
    env: {
      ...process.env,
      ...app.env(app.dataDir, app.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, startedAt: Date.now(), failures: priorFailures };
  children.set(app.name, state);

  pipeLines(child.stdout, app.name, false);
  pipeLines(child.stderr, app.name, true);

  log(app.name, `进程已启动 (pid=${child.pid}, 端口 ${app.port}, 数据目录 ${app.dataDir})`);

  child.on('exit', (code, signal) => {
    children.delete(app.name);
    log(app.name, `进程退出 code=${code} signal=${signal || '-'}`, true);
    if (!shuttingDown) scheduleRestart(app, state);
  });

  child.on('error', (err) => {
    log(app.name, `进程启动异常: ${err.message}`, true);
  });
}

function scheduleRestart(app, state) {
  if (shuttingDown) return;
  // 稳定运行超过 60 秒后再挂，视为新故障，退避从头开始
  const healthyRun = state && state.startedAt && Date.now() - state.startedAt > 60000;
  const failures = healthyRun ? 0 : ((state && state.failures) || 0) + 1;
  const delay = Math.min(30000, 2000 * Math.pow(2, Math.max(0, failures - 1)));
  log(app.name, `${Math.round(delay / 1000)} 秒后自动重启（第 ${failures} 次）`);
  setTimeout(() => startApp(app, failures), delay);
}

// ---------------------------------------------------------------- 健康检查
function probe(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ up: res.statusCode < 500, status: res.statusCode });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ up: false, status: 0 }); });
    req.on('error', () => resolve({ up: false, status: 0 }));
    req.end();
  });
}

function collectHealth() {
  return Promise.all(
    APPS.map(async (app) => {
      const r = await probe(app.port);
      return { name: app.name, label: app.label, port: app.port, up: r.up, status: r.status };
    })
  );
}

// ---------------------------------------------------------------- 入口页
// 8555 只服务一个单页控制台：顶栏两个页签内嵌 /ctyun/、/cmcc/ 两个子应用。
const SHELL_HTML = path.join(__dirname, 'shell', 'index.html');

// --------------------------------------------- 子应用 HTML 同源化改写
// 两个子应用的前端资源与接口都写死了绝对路径（/static/app.js、/api/...），挂到
// /ctyun/、/cmcc/ 下会被浏览器解析回 8555 根路径。因此只对 text/html 响应做缓冲
// 改写：给 href/src/action 的绝对路径加前缀，并在 <head> 最前面注入同源 shim 脚本，
// 由它改写运行时发出的 fetch / XHR / EventSource / window.open / sendBeacon 请求。
// 其余响应（SSE、二进制、JSON、重定向）保持原有的纯 pipe 行为，一律不缓冲。
const APP_PREFIXES = APPS.map((a) => '/' + a.name);
const CTYUN_TOP_PATHS = [/^\/desktop-view$/, /^\/workers\//, /^\/ctyun-static\//];
const HTML_URL_ATTR = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function hasAppPrefix(value) {
  if (value === '/health' || value.startsWith('/health?') || value.startsWith('/health#')) return true;
  return APP_PREFIXES.some(
    (p) => value === p || value.startsWith(p + '/') || value.startsWith(p + '?') || value.startsWith(p + '#')
  );
}

function withPrefix(value, prefix) {
  if (!value || value.charAt(0) !== '/' || value.charAt(1) === '/') return value;
  return hasAppPrefix(value) ? value : prefix + value;
}

function rewriteHtmlUrls(html, prefix) {
  return html.replace(HTML_URL_ATTR, (whole, attr, dq, sq) => {
    const raw = dq === undefined ? sq : dq;
    const fixed = withPrefix(raw, prefix);
    return fixed === raw ? whole : attr + '="' + fixed + '"';
  });
}

// 同源 shim：注入点必须晚于 <base href="前缀/">（见 injectShim），只依赖标准 API。
const SHIM_SRC = String.raw`
(function () {
  'use strict';
  var PREFIX = '__PREFIX__';
  var APPS = __APPS__;

  function hasAppPrefix(p) {
    if (p === '/health' || p.indexOf('/health?') === 0 || p.indexOf('/health#') === 0) return true;
    for (var i = 0; i < APPS.length; i++) {
      var a = APPS[i];
      if (p === a || p.indexOf(a + '/') === 0 || p.indexOf(a + '?') === 0 || p.indexOf(a + '#') === 0) return true;
    }
    return false;
  }

  function fix(u) {
    if (typeof u !== 'string' || u.charAt(0) !== '/' || u.charAt(1) === '/') return u;
    return hasAppPrefix(u) ? u : PREFIX + u;
  }

  // cmcc 的独立控制窗口靠 location.pathname === '/control.html' 认出自己
  // (cmcc-phone/public/app.js:154/781)，前缀下永不成立；这里只把地址栏还原成
  // 根路径，资源与接口仍走 PREFIX，8555 亦保留 /control.html 反代以便刷新。
  try {
    if (PREFIX === '/cmcc' && /\/control\.html$/.test(location.pathname)) {
      history.replaceState(history.state, '', '/control.html' + location.search + location.hash);
    }
  } catch (e) { /* ignore */ }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') return nativeFetch.call(this, fix(input), init);
        if (typeof Request !== 'undefined' && input instanceof Request) {
          var fixedUrl = fix(input.url);
          if (fixedUrl !== input.url) return nativeFetch.call(this, new Request(fixedUrl, input), init);
        }
        if (typeof URL !== 'undefined' && input instanceof URL) {
          var next = new URL(input.href);
          var nextPath = fix(next.pathname);
          if (nextPath !== next.pathname) {
            next.pathname = nextPath;
            return nativeFetch.call(this, next, init);
          }
        }
      } catch (e) { /* ignore */ }
      return nativeFetch.call(this, input, init);
    };
  }

  var nativeXhrOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  if (nativeXhrOpen) {
    window.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 1) args[1] = fix(url);
      return nativeXhrOpen.apply(this, args);
    };
  }

  var NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    var PatchedEventSource = function (url, config) {
      return new NativeEventSource(fix(url), config);
    };
    PatchedEventSource.prototype = NativeEventSource.prototype;
    PatchedEventSource.CONNECTING = 0;
    PatchedEventSource.OPEN = 1;
    PatchedEventSource.CLOSED = 2;
    window.EventSource = PatchedEventSource;
  }

  var nativeWindowOpen = window.open;
  if (nativeWindowOpen) {
    window.open = function (url) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 0) args[0] = fix(url);
      return nativeWindowOpen.apply(window, args);
    };
  }

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(fix(url), data);
    };
  }
})();
`;

function injectShim(html, prefix) {
  const tag =
    '<base href="' + prefix + '/">' +
    '<script>' +
    SHIM_SRC.replace(/__PREFIX__/g, prefix).replace('__APPS__', JSON.stringify(APP_PREFIXES)) +
    '<\/script>';
  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const root = html.match(/<html[^>]*>/i);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

function rewriteHtml(html, prefix) {
  return injectShim(rewriteHtmlUrls(html, prefix), prefix);
}

function decodeBody(buf, encoding) {
  if (!encoding || encoding === 'identity') return buf;
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buf);
  if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  if (encoding === 'deflate') {
    try { return zlib.inflateSync(buf); } catch (_) { return zlib.inflateRawSync(buf); }
  }
  throw new Error('不支持的 content-encoding: ' + encoding);
}

/**
 * 把请求转发给某个子进程端口（含请求体、Cookie、查询串）。
 * text/html 响应缓冲后做前缀改写并重算 content-length；其余一律纯 pipe。
 */
function proxyTo(port, req, res, subPath, prefix) {
  const headers = { ...req.headers, host: '127.0.0.1:' + port };
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const upstream = http.request(
    { host: '127.0.0.1', port, path: subPath, method: req.method, headers },
    (up) => {
      const status = up.statusCode || 502;
      if (isMutating) {
        // 写成功后作废 BFF 快照（写屏障），避免"改完立刻刷新读回旧值"
        up.on('end', () => {
          if (status < 400) resources.invalidate();
        });
      }
      const isHtml = /text\/html/i.test(String(up.headers['content-type'] || ''));
      if (!isHtml || status === 204 || status === 304) {
        res.writeHead(status, up.headers);
        up.pipe(res);
        return;
      }
      const chunks = [];
      up.on('data', (chunk) => chunks.push(chunk));
      up.on('error', () => { res.end(); });
      up.on('end', () => {
        const raw = Buffer.concat(chunks);
        let plain = null;
        try { plain = decodeBody(raw, String(up.headers['content-encoding'] || '').toLowerCase()); } catch (_) { plain = null; }
        if (!plain) {
          res.writeHead(status, up.headers);
          res.end(raw);
          return;
        }
        const body = Buffer.from(rewriteHtml(plain.toString('utf8'), prefix), 'utf8');
        const out = { ...up.headers };
        delete out['content-encoding'];
        delete out['transfer-encoding'];
        delete out.etag;
        out['content-length'] = String(body.length);
        res.writeHead(status, out);
        res.end(body);
      });
    }
  );
  upstream.on('error', (err) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '后端 ' + port + ' 不可达: ' + err.message }));
  });
  req.pipe(upstream);
}

const entry = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    const apps = await collectHealth();
    const body = JSON.stringify({
      ok: apps.every((a) => a.up),
      time: Date.now(),
      apps,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  // 阶段 2：BFF 统一资源视图（云电脑 + 云手机归一成 8 列）
  if (url.pathname === '/api/resources') {
    await resources.handle(url, res);
    return;
  }

  // 近 24 小时心跳 / 掉线聚合（只读日志文件，不打上游接口）：总览时间线图
  if (url.pathname === '/api/timeline') {
    let body;
    try {
      body = JSON.stringify(timeline.get(url.searchParams.get('refresh') === '1'));
    } catch (err) {
      body = JSON.stringify({ error: '日志聚合失败: ' + (err && err.message ? err.message : err), hours: [], totals: {} });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  // 资费库查询（只读本地快照，不联网）：面板「💰 资费」页
  if (url.pathname === '/api/tariff/catalog') {
    let body;
    try { body = JSON.stringify(tariff.catalog(url.searchParams)); } catch (err) {
      body = JSON.stringify({ error: '号卡资费快照读取失败: ' + (err && err.message ? err.message : err), items: [], total: 0 });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  // 中国移动 App 凭证只读账单（余额 / 本月消费 / 流量包 / 积分）：凭证等同于登录态，落盘前加密
  if (url.pathname === '/api/cmcc-billing') {
    let body;
    if (req.method === 'GET') {
      try { body = JSON.stringify(await billing.list({ refresh: url.searchParams.get('refresh') === '1' })); }
      catch (err) { body = JSON.stringify({ error: '账单读取失败: ' + (err && err.message ? err.message : err), items: [], totals: {} }); }
    } else {
      body = JSON.stringify({ error: '只支持 GET' });
    }
    res.writeHead(req.method === 'GET' ? 200 : 405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url.pathname === '/api/cmcc-billing/credential') {
    let status = 200, out;
    const readJson = () => new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => { raw += String(c); if (raw.length > 64000) { reject(new Error('请求体过大')); req.destroy(); } });
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
      req.on('error', reject);
    });
    try {
      if (req.method === 'POST') {
        out = billing.add(await readJson());
        if (out.error) status = 400;
      } else if (req.method === 'DELETE') {
        const phone = url.searchParams.get('phone') || '';
        out = billing.remove(phone);
        if (out.error) status = 400;
      } else {
        status = 405; out = { error: '只支持 POST（新增/替换）与 DELETE（删除）' };
      }
    } catch (err) { status = 400; out = { error: err && err.message ? err.message : String(err) }; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }

  if (url.pathname === '/api/tariff') {
    let body;
    try { body = JSON.stringify(tariff.list(url.searchParams)); } catch (err) {
      body = JSON.stringify({ error: '资费快照读取失败: ' + (err && err.message ? err.message : err), items: [], total: 0 });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // 阶段 1（2026-11-25 去登录）：8555 根路径不再有门户页/iframe 壳，直接 302 进统一控制台。
    // deploy/shell/index.html 与 deploy/portal/index.html 均作废（阶段 3 换成 BFF 静态壳时删除）。
    res.writeHead(302, { Location: '/ctyun/' + (url.search || ''), 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // ------------------------------------------------ 反代：/ctyun/* 与 /cmcc/* → 各自后端
  // 控制台（8555）用同源路径内嵌两个子应用，避免跨端口 CORS 与暴露更多端口。
  // 导出口令闸门：必须在反代之前拦截，否则明文密码可被内网任意客户端一键下载
  if (isSecretConfigPath(url.pathname) && !secretConfigAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      error: '该接口需要口令：请在请求头 X-Export-Pass 中提供 EXPORT_PASS（不支持 query 参数）。',
      hint: EXPORT_PASS ? '口令由部署方在 cloud-dashboard/.env 的 EXPORT_PASS 中设置。' : '当前部署未设置 EXPORT_PASS，该接口一律拒绝。',
    }));
    return;
  }

  const proxyMatch = url.pathname.match(/^\/(ctyun|cmcc)(\/.*)?$/);
  if (proxyMatch) {
    const app = APPS.find((a) => a.name === proxyMatch[1]);
    if (app) {
      proxyTo(app.port, req, res, (proxyMatch[2] || '/') + url.search, '/' + app.name);
      return;
    }
  }

  // cmcc 的独立控制窗口在浏览器里把地址栏还原成根路径 /control.html（见 SHIM_SRC），
  // 这里对该根路径同样反代给 cmcc，保证刷新、收藏、直接打开都仍然可用。
  if (url.pathname === '/control.html') {
    const cmcc = APPS.find((a) => a.name === 'cmcc');
    if (cmcc) {
      proxyTo(cmcc.port, req, res, '/control.html' + url.search, '/cmcc');
      return;
    }
  }

  // 顶层白名单：ctyun 桌面页被弹窗拦截时用 window.location.href 直跳根路径 /desktop-view
  // (ctyun-dashboard/app/static/app.js:3934)；该页面自身又引用 /ctyun-static/* 与 /workers/*
  // (ctyun-dashboard/server.js:3723/3739)。只映射到 ctyun，不做双上游轮询兜底以免串台。
  if (CTYUN_TOP_PATHS.some((re) => re.test(url.pathname))) {
    const ctyun = APPS.find((a) => a.name === 'ctyun');
    if (ctyun) {
      proxyTo(ctyun.port, req, res, url.pathname + url.search, '/ctyun');
      return;
    }
  }

  if (url.pathname === '/api/ports') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(APPS.map((a) => ({ name: a.name, label: a.label, port: a.port }))));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

entry.on('error', (err) => {
  console.error(`[entry] 控制台服务异常: ${err.message}`);
});

// ---------------------------------------------------------------- 生命周期
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boot] 收到 ${signal}，正在停止所有子进程…`);
  for (const [, state] of children) {
    try { state.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
  entry.close(() => {});
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[boot] 未捕获异常（继续运行）:', err && err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[boot] 未处理 Promise 拒绝（继续运行）:', reason && reason.message);
});

fs.mkdirSync(DATA_ROOT, { recursive: true });
entry.listen(PORTAL_PORT, '0.0.0.0', () => {
  console.log(`[boot] 统一控制台已就绪: http://127.0.0.1:${PORTAL_PORT}`);
});
for (const app of APPS) startApp(app);

// ---------------------------------------------------------------- 资费快照定时同步
// 公示资费由运营商每季度才动一次，12 小时一轮足够；改成 0 即关闭。
// 同步完必须作废 BFF 缓存，否则运维页还会显示旧快照的时间。
const TARIFF_SYNC_HOURS = Number(process.env.TARIFF_SYNC_HOURS || 12);
function syncTariff(force) {
  if (!TARIFF_SYNC_HOURS && !force) return;
  const child = spawn(process.execPath, ['/opt/tariff-sync.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  child.on('exit', (code) => {
    const tail = out.trim().split('\n').slice(-2).join(' | ');
    console.log('[boot] 资费同步退出 ' + code + ': ' + tail);
    if (code === 0) resources.invalidate();
  });
  child.on('error', (err) => console.error('[boot] 资费同步启动失败:', err && err.message));
}
// ---------------------------------------------------------------- 配置快照
// saveConfig 每次把 app_config.json 与 .bak 一起覆盖，误导入/误删就无路可退（审计 §P1-4：
// 全系统此前没有任何备份）。每天留一份带时间的快照，保留最近 N 份，恢复只需 cp 回去。
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7);
const BACKUP_SOURCES = [
  '/data/ctyun/app_config.json',
  '/data/ctyun/accounts.json',
  '/data/cmcc/store.json',
  '/data/ctyun/.master.key',
  '/data/cmcc/.master.key',
];

function runBackup() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let copied = 0;
    for (const src of BACKUP_SOURCES) {
      try {
        fs.copyFileSync(src, path.join(dir, src.split('/').pop()));
        copied++;
      } catch (e) { /* 文件不存在（例如没接云手机）就跳过 */ }
    }
    // 密钥与密文同目录，快照目录权限必须收紧
    for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o600);
    const all = fs.readdirSync(BACKUP_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
    while (all.length > BACKUP_KEEP) {
      const victim = all.shift();
      fs.rmSync(path.join(BACKUP_DIR, victim), { recursive: true, force: true });
    }
    console.log('[boot] 配置快照 ' + stamp + '：' + copied + ' 个文件（保留 ' + BACKUP_KEEP + ' 份）');
  } catch (err) {
    console.error('[boot] 配置快照失败:', err && err.message);
  }
}
if (String(process.env.BACKUP_DISABLE || '') !== '1') {
  setTimeout(runBackup, Number(process.env.BACKUP_FIRST_DELAY_MS || 90 * 1000)).unref();
  setInterval(runBackup, 24 * 3600 * 1000).unref();
}

const TARIFF_FIRST_DELAY_MS = Number(process.env.TARIFF_FIRST_DELAY_MS || 5 * 60 * 1000);
if (TARIFF_FIRST_DELAY_MS > 0) setTimeout(() => syncTariff(), TARIFF_FIRST_DELAY_MS).unref();
if (TARIFF_SYNC_HOURS > 0) setInterval(() => syncTariff(), TARIFF_SYNC_HOURS * 3600 * 1000).unref();
