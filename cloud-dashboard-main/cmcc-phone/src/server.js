'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MultiTenantStore } = require('./store');
const { CmccClient, generateDeviceFingerprint } = require('./cmccClient');
const { KeepaliveEngine } = require('./keepaliveEngine');

// 内网免登录开关：默认开启，LOCAL_NOAUTH=0 可恢复平台账号登录
const LOCAL_NOAUTH = process.env.LOCAL_NOAUTH !== '0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const pair of String(cookieHeader).split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('无效的 JSON 请求格式'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function createApp({
  dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  publicDir = path.join(__dirname, '..', 'public'),
  cmccClient = new CmccClient(),
  engineOptions = {},
} = {}) {
  const store = new MultiTenantStore(dataDir);
  const engine = new KeepaliveEngine({ store, cmccClient, options: engineOptions });

  // Ephemeral captcha verification sessions scoped by platform user id
  // sessionId -> { ownerId, mobile, captchaToken, secretKey, fingerprint, smsSent, createdAt }
  const captchaSessions = new Map();

  function pruneCaptchaSessions() {
    const now = Date.now();
    for (const [id, sess] of captchaSessions.entries()) {
      if (now - sess.createdAt > 10 * 60 * 1000) {
        captchaSessions.delete(id);
      }
    }
  }

  function extractSessionToken(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      return auth.slice(7).trim();
    }
    const cookies = parseCookies(req.headers.cookie);
    return cookies.cmcc_sid || '';
  }

  function buildAuthCookie(token, maxAgeSec = 30 * 24 * 3600) {
    return `cmcc_sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  }

  async function finalizeAccountBind(ownerId, loginData, remark = '') {
    const hydrated = store.upsertCmccAccount(ownerId, {
      mobile: loginData.mobile,
      remark,
      token: loginData.token,
      hwToken: loginData.hwToken,
      cmccUserId: loginData.cmccUserId,
      province: loginData.province,
      fingerprint: loginData.fingerprint,
    });

    store.appendLog(ownerId, {
      level: 'success',
      message: `官方账号 ${hydrated.mobile} 认证成功，正在同步云手机实例...`,
    });

    let syncedDevices = [];
    try {
      const remoteDevs = await cmccClient.listDevices(hydrated);
      syncedDevices = store.syncDevicesForAccount(ownerId, hydrated.id, remoteDevs, {
        complete: remoteDevs.complete !== false,
      });
      store.appendLog(ownerId, {
        level: 'info',
        message: `账号 ${hydrated.mobile} 同步完成，共发现 ${syncedDevices.length} 台云手机`,
      });
    } catch (err) {
      store.appendLog(ownerId, {
        level: 'warn',
        message: `账号 ${hydrated.mobile} 已保存，但首次拉取设备列表异常：${err.message}`,
      });
    }

    engine.reconcileAllDevices();
    return {
      account: store.sanitizeAccount(hydrated),
      deviceCount: syncedDevices.length,
    };
  }

  async function handleApi(req, res, pathname) {
    // Public health & bootstrap endpoints
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: Date.now() });
    }

    // ===== 单用户模式（2026-11-25）：无登录 / 无注册 / 无多用户 =====
    // 鉴权类接口一律 404；currentUser 恒为本地 owner 'local'，完全不解析 cookie / Authorization，
    // 因此伪造 cmcc_sid、伪造 Bearer、伪造 ?token= 都只会落到同一个 local owner。
    if (pathname.startsWith('/api/auth/') && pathname !== '/api/auth/me') {
      return sendJson(res, 404, { ok: false, error: '单用户模式下该接口已下线' });
    }
    if (pathname.startsWith('/api/admin/users')) {
      return sendJson(res, 404, { ok: false, error: '单用户模式下该接口已下线' });
    }

    const currentUser = store.ensureLocalOwner();

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      return sendJson(res, 200, { ok: true, user: currentUser });
    }

    // ----- Dashboard Snapshot (Strictly Scoped to currentUser.id) -----
    if (req.method === 'GET' && pathname === '/api/dashboard') {
      const accounts = store.listAccountsByOwner(currentUser.id);
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const devices = store.listDevicesByOwner(currentUser.id).map((d) => ({
        ...d,
        accountMobile: accountMap.get(d.accountId)?.mobile || '',
        accountRemark: accountMap.get(d.accountId)?.remark || '',
        accountAuthStatus: accountMap.get(d.accountId)?.authStatus || 'valid',
        runtime: engine.getRuntimeSnapshot(d.id),
      }));
      const logs = store.getLogsForOwner(currentUser.id, 100);
      return sendJson(res, 200, {
        ok: true,
        user: currentUser,
        accounts,
        devices,
        logs,
      });
    }

    // ----- Official CMCC SMS Login Flow -----
    if (req.method === 'POST' && pathname === '/api/cmcc/captcha/get') {
      pruneCaptchaSessions();
      const body = await readJsonBody(req);
      // Reuse existing fingerprint if user already bound this mobile before
      const existingAccs = store.getAllHydratedAccounts().filter(
        (a) => a.ownerId === currentUser.id && a.mobile === String(body.mobile || '').replace(/\s+/g, '')
      );
      const fp = existingAccs[0]?.fingerprint || generateDeviceFingerprint();
      const cap = await cmccClient.getCaptcha(body.mobile, fp);
      const captchaSessionId = crypto.randomUUID();
      captchaSessions.set(captchaSessionId, {
        ownerId: currentUser.id,
        mobile: cap.mobile,
        captchaToken: cap.captchaToken,
        secretKey: cap.secretKey,
        fingerprint: cap.fingerprint,
        smsSent: false,
        createdAt: Date.now(),
      });
      return sendJson(res, 200, {
        ok: true,
        captchaSessionId,
        mobile: cap.mobile,
        originalImageBase64: cap.originalImageBase64,
        jigsawImageBase64: cap.jigsawImageBase64,
      });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/captcha/send-sms') {
      const body = await readJsonBody(req);
      const sess = captchaSessions.get(body.captchaSessionId);
      if (!sess || sess.ownerId !== currentUser.id) {
        return sendJson(res, 400, { ok: false, error: '图形验证会话已失效，请重新获取滑块验证码' });
      }
      await cmccClient.verifyCaptchaAndSendSms({
        mobile: sess.mobile,
        captchaToken: sess.captchaToken,
        secretKey: sess.secretKey,
        moveX: body.moveX,
        fingerprint: sess.fingerprint,
      });
      sess.smsSent = true;
      return sendJson(res, 200, { ok: true, mobile: sess.mobile });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/login/sms') {
      const body = await readJsonBody(req);
      const cleanMobile = String(body.mobile || '').replace(/\s+/g, '');
      let fp = null;
      if (body.captchaSessionId) {
        const sess = captchaSessions.get(body.captchaSessionId);
        if (sess && sess.ownerId === currentUser.id && sess.mobile === cleanMobile) {
          fp = sess.fingerprint;
          captchaSessions.delete(body.captchaSessionId);
        }
      }
      if (!fp) {
        fp = generateDeviceFingerprint();
      }
      const loginData = await cmccClient.loginWithSmsCode({
        mobile: cleanMobile,
        code: body.code,
        fingerprint: fp,
      });
      const result = await finalizeAccountBind(currentUser.id, loginData, body.remark);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/login/password') {
      const body = await readJsonBody(req);
      const loginData = await cmccClient.loginWithPassword({
        mobile: body.mobile,
        password: body.password,
      });
      const result = await finalizeAccountBind(currentUser.id, loginData, body.remark);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/cmcc/login/token') {
      const body = await readJsonBody(req);
      const cleanMobile = String(body.mobile || '').replace(/\s+/g, '');
      const rawToken = String(body.token || '').trim();
      if (!/^1\d{10}$/.test(cleanMobile) || !rawToken) {
        return sendJson(res, 400, { ok: false, error: '请填写完整的 11 位手机号和有效官方 Token' });
      }
      const fp = generateDeviceFingerprint();
      // Validate token by listing devices
      const tempAcc = { mobile: cleanMobile, token: rawToken, hwToken: body.hwToken || '', fingerprint: fp };
      await cmccClient.listDevices(tempAcc);
      const result = await finalizeAccountBind(
        currentUser.id,
        {
          mobile: cleanMobile,
          token: rawToken,
          hwToken: body.hwToken || '',
          cmccUserId: body.cmccUserId || '',
          province: '',
          fingerprint: fp,
        },
        body.remark
      );
      return sendJson(res, 200, { ok: true, ...result });
    }

    // ----- Account Operations (Owner Isolated) -----
    const accSyncMatch = pathname.match(/^\/api\/accounts\/([a-f0-9-]+)\/sync$/i);
    if (accSyncMatch && req.method === 'POST') {
      const acc = store.getHydratedAccountForOwner(currentUser.id, accSyncMatch[1]);
      if (!acc) return sendJson(res, 404, { ok: false, error: '未找到该账号或无权操作' });
      const tokenCheck = await cmccClient.checkAndRefreshToken(acc);
      if (tokenCheck.refreshed) {
        store.updateAccountTokens(acc.id, {
          token: tokenCheck.token,
          hwToken: tokenCheck.hwToken,
          authStatus: 'valid',
        });
      }
      const freshAcc = store.getHydratedAccountForOwner(currentUser.id, acc.id);
      const remoteDevs = await cmccClient.listDevices(freshAcc);
      const synced = store.syncDevicesForAccount(currentUser.id, acc.id, remoteDevs, {
        complete: remoteDevs.complete !== false,
      });
      engine.reconcileAllDevices();
      return sendJson(res, 200, { ok: true, deviceCount: synced.length });
    }

    const accDelMatch = pathname.match(/^\/api\/accounts\/([a-f0-9-]+)$/i);
    if (accDelMatch && req.method === 'DELETE') {
      store.deleteAccountForOwner(currentUser.id, accDelMatch[1]);
      engine.reconcileAllDevices();
      return sendJson(res, 200, { ok: true });
    }

    // ----- Device Operations & Web Display/Control Stream (Owner Isolated) -----
    const devSettingsMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/settings$/i);
    if (devSettingsMatch && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const updated = store.updateDeviceSettingsForOwner(currentUser.id, devSettingsMatch[1], body);
      engine.reconcileDevice(updated.id);
      return sendJson(res, 200, {
        ok: true,
        device: { ...updated, runtime: engine.getRuntimeSnapshot(updated.id) },
      });
    }

    const devPowerMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/power$/i);
    if (devPowerMatch && req.method === 'POST') {
      const dev = store.getDeviceForOwner(currentUser.id, devPowerMatch[1]);
      if (!dev) return sendJson(res, 404, { ok: false, error: '未找到该云手机设备或无权访问' });
      const acc = store.getHydratedAccountForOwner(currentUser.id, dev.accountId);
      if (!acc) return sendJson(res, 404, { ok: false, error: '关联的移动账号不存在' });

      const body = await readJsonBody(req);
      let action = body.action;
      if (!['wakeup','reboot','shutdown'].includes(action)) return sendJson(res,400,{ok:false,error:'不支持的电源动作'});
      engine.pauseForPower(dev.id, 90000);
      if (action === 'wakeup') {
        await cmccClient.ensureDeviceReady(acc, dev.phoneId, dev.platformType, 45000);
        await cmccClient.waitForPowerState(acc, dev.phoneId, ['0'], 60000);
        // 开机只改电源态：静默打开保活会覆盖用户明确关闭的选择（并洗掉自动停用原因）。
        if (dev.keepaliveEnabled === false) {
          store.appendLog(currentUser.id, {
            level: 'info',
            deviceId: dev.id,
            phoneName: dev.phoneName,
            message: '已开机；保活开关保持关闭（如需保活请在面板打开）',
          });
        }
        engine.pauseForPower(dev.id, 0);
        store.appendLog(currentUser.id, {
          level: 'success',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: '云手机唤醒就绪成功',
        });
      } else if (action === 'reboot') {
        await cmccClient.rebootDevice(acc, dev.phoneId, dev.platformType);
        store.appendLog(currentUser.id, {
          level: 'info',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: '已下发重启指令，稍后保活引擎将自动重连',
        });
      } else if (action === 'shutdown') {
        // 关机必须同时暂停保活（否则下一轮循环会把机器开回来），但用 pausedReason
        // 记录成因，别让「用户主动关机」在面板上看起来像用户自己关掉了开关。
        store.pauseDeviceKeepalive(dev.id, '用户主动关机，保活已暂停（需在面板重新打开）');
        engine.reconcileDevice(dev.id);
        await cmccClient.shutdownDevice(acc, dev.phoneId, dev.platformType);
        await cmccClient.waitForPowerState(acc, dev.phoneId, ['31'], 60000);
        store.appendLog(currentUser.id, {
          level: 'info',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: '已下发关机指令并暂停自动保活唤醒',
        });
      } else {
        return sendJson(res, 400, { ok: false, error: '不支持的电源动作' });
      }
      const listed = await cmccClient.listDevices(acc);
      store.syncDevicesForAccount(currentUser.id, acc.id, listed, { complete: listed.complete !== false });
      engine.reconcileDevice(dev.id);
      return sendJson(res, 200, { ok: true, message: action === 'wakeup' ? '已确认云机开机就绪' : action === 'shutdown' ? '已确认云机关闭 (状态31)' : '官方已接受重启指令，最终状态稍后同步' });
    }

    const devShotMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/screenshot$/i);
    if (devShotMatch && req.method === 'POST') {
      const dev = store.getDeviceForOwner(currentUser.id, devShotMatch[1]);
      if (!dev) return sendJson(res, 404, { ok: false, error: '未找到该云手机设备或无权访问' });
      const acc = store.getHydratedAccountForOwner(currentUser.id, dev.accountId);
      if (!acc) return sendJson(res, 404, { ok: false, error: '关联的移动账号不存在' });

      const shot = await cmccClient.captureScreenshot(acc, dev.phoneId, dev.platformType);
      const imgUrl = typeof shot === 'string' ? shot : shot?.pictUrl || shot?.url || '';
      if (imgUrl) {
        store.updateDeviceScreenshot(dev.id, imgUrl);
      }
      return sendJson(res, 200, { ok: true, screenshot: imgUrl });
    }

    const streamOpenMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/stream\/open$/i);
    if (streamOpenMatch && req.method === 'POST') {
      const dev = store.getDeviceForOwner(currentUser.id, streamOpenMatch[1]);
      if (!dev) return sendJson(res, 404, { ok: false, error: '未找到该云手机设备或无权访问' });
      const acc = store.getHydratedAccountForOwner(currentUser.id, dev.accountId);
      if (!acc) return sendJson(res, 404, { ok: false, error: '关联的移动账号不存在' });

      const body = await readJsonBody(req);
      // Pause background keepalive worker first so browser WebRTC gets clean master session
      const sid = String(body.sid || body.clientId || '').trim().slice(0, 64) || 'web';
      engine.acquireWebControlLease(currentUser.id, dev.id, sid, 50000);
      try {
        await cmccClient.ensureDeviceReady(acc, dev.phoneId, dev.platformType, 45000);
        const streamConfig = await cmccClient.getStreamAuth(
          acc,
          dev.phoneId,
          dev.platformType,
          body.authId || ''
        );
        return sendJson(res, 200, {
          ok: true,
          device: {
            id: dev.id,
            phoneId: dev.phoneId,
            phoneName: dev.phoneName,
            platformType: dev.platformType,
          },
          stream: streamConfig,
        });
      } catch (err) {
        engine.releaseWebControlLease(currentUser.id, dev.id);
        throw err;
      }
    }

    const streamBeatMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/stream\/heartbeat$/i);
    if (streamBeatMatch && req.method === 'POST') {
      const lease = engine.renewWebControlLease(currentUser.id, streamBeatMatch[1], 50000);
      return sendJson(res, 200, { ok: true, ...lease });
    }

    const streamCloseMatch = pathname.match(/^\/api\/devices\/([a-f0-9-]+)\/stream\/close$/i);
    if (streamCloseMatch && req.method === 'POST') {
      const rel = engine.releaseWebControlLease(currentUser.id, streamCloseMatch[1]);
      return sendJson(res, 200, { ok: true, ...rel });
    }

    return sendJson(res, 404, { ok: false, error: '未知的 API 接口路径' });
  }

  function serveStatic(req, res, pathname) {
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(publicDir, safePath);
    if (!fullPath.startsWith(path.resolve(publicDir))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.js' && safePath.includes('vendor') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(fullPath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsed.pathname;
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
      } else {
        serveStatic(req, res, pathname);
      }
    } catch (err) {
      const status = err.code === 'CMCC_AUTH_EXPIRED' ? 401 : 400;
      sendJson(res, status, {
        ok: false,
        error: err.message || '服务器处理请求异常',
        code: err.code || undefined,
      });
    }
  });

  return { server, store, engine, cmccClient };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8680);
  const host = process.env.HOST || '0.0.0.0';
  const { server, engine } = createApp();
  engine.start();
  server.listen(port, host, () => {
    console.log(`[CMCC CloudPhone Manager] Listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
