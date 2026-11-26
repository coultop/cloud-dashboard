'use strict';

const crypto = require('crypto');
const { RawWebSocket, EngineIoV3Socket } = require('./wsClient');

const CMD_ACTION_PREPARE_CONNECT = 6056;
const CMD_ACTION_HEART = 100022;

// Server codes that mean "this phone was taken over / logged in elsewhere".
const TAKEOVER_CODES = new Set([19009, 6105]);

const envInt = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

class KeepaliveEngine {
  constructor({ store, cmccClient, options = {} }) {
    this.store = store;
    this.cmcc = cmccClient;
    this.tokenCheckIntervalMs = options.tokenCheckIntervalMs || 20 * 60 * 1000;
    this.leaseSweepIntervalMs = options.leaseSweepIntervalMs || 5000;
    this.yunRefreshPulseMs = options.yunRefreshPulseMs || 4 * 60 * 1000;
    this.socketFactory = options.socketFactory || null; // optional injection for unit tests

    // Tunables (all overridable via env, defaults documented in the README block below).
    this.failSoft = options.failSoft || envInt('PHONE_FAIL_SOFT', 3);
    this.failPause = options.failPause || envInt('PHONE_FAIL_PAUSE', 5);
    this.backoffMaxMs = options.backoffMaxMs || envInt('PHONE_BACKOFF_MAX_MS', 15 * 60 * 1000);
    this.takeoverBackoffMs = options.takeoverBackoffMs || envInt('PHONE_TAKEOVER_BACKOFF_MS', 5 * 60 * 1000);
    this.authorizeTimeoutMs = options.authorizeTimeoutMs || envInt('PHONE_AUTHORIZE_TIMEOUT_MS', 15000);
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs || envInt('PHONE_FIRST_FRAME_TIMEOUT_MS', 15000);
    this.baseBackoffMs = options.baseBackoffMs || 3000;

    // deviceId -> runtime session state
    this.sessions = new Map();
    // deviceId -> { ownerId, clientSessionId, expiresAt }
    this.webLeases = new Map();

    this._tokenTimer = null;
    this._leaseTimer = null;
    this._running = false;
    this._lockHeld = false;
    this._exitHookBound = false;
    // accountId -> consecutive inspection failure count (in-memory)
    this.accountFailures = new Map();
  }

  /**
   * @returns {boolean} true when this process owns the keepalive lock and started.
   */
  start() {
    if (this._running) return true;
    const lock = this.store.acquireKeepaliveLock
      ? this.store.acquireKeepaliveLock()
      : { acquired: true };
    if (!lock.acquired) {
      const pidText = lock.pid ? `pid ${lock.pid}` : 'unknown pid';
      const msg = `检测到另一个进程（${pidText}）已持有保活锁，本进程跳过保活引擎启动（Web 服务继续运行）`;
      console.warn(`[keepalive] ${msg}`);
      if (this.store.appendEngineLog) this.store.appendEngineLog('warn', msg);
      return false;
    }
    this._lockHeld = true;
    this._bindExitHook();
    this._running = true;

    this._tokenTimer = setInterval(() => {
      this.checkAllAccountTokens().catch((err) => {
        // Last-resort guard: a bug here must not become an unhandled rejection.
        console.warn('[keepalive] token check loop failed:', (err && err.message) || err);
      });
    }, this.tokenCheckIntervalMs);
    this._tokenTimer.unref?.();

    this._leaseTimer = setInterval(() => {
      this._sweepExpiredWebLeases();
      this.reconcileAllDevices();
    }, this.leaseSweepIntervalMs);
    this._leaseTimer.unref?.();

    // Reconcile all devices on startup
    this.reconcileAllDevices();
    // 启动即对齐上游：原来第一次巡检要等满 tokenCheckIntervalMs（20 分钟），
    // 这段时间里新买/已过期的设备在面板上都看不见，用户会以为同步坏了。
    this.checkAllAccountTokens().catch((err) => {
      const msg = `启动巡检失败：${(err && err.message) || err}`;
      console.warn('[keepalive] ' + msg);
      if (this.store.appendEngineLog) this.store.appendEngineLog('warn', msg);
    });
    return true;
  }

  stop() {
    this._running = false;
    if (this._tokenTimer) {
      clearInterval(this._tokenTimer);
      this._tokenTimer = null;
    }
    if (this._leaseTimer) {
      clearInterval(this._leaseTimer);
      this._leaseTimer = null;
    }
    for (const deviceId of this.sessions.keys()) {
      this._stopDeviceWorker(deviceId, '服务停止');
    }
    this.webLeases.clear();
    if (this.store.flush) this.store.flush();
    if (this._lockHeld) {
      this.store.releaseKeepaliveLock?.();
      this._lockHeld = false;
    }
  }

  _bindExitHook() {
    if (this._exitHookBound) return;
    this._exitHookBound = true;
    process.once('exit', () => {
      try {
        if (this._lockHeld) this.store.releaseKeepaliveLock?.();
      } catch (exitErr) {
        // Nothing useful left to do while exiting; stale-pid reclaim covers it.
        if (process.env.PHONE_DEBUG) console.warn('[keepalive] lock release on exit failed:', exitErr.message);
      }
    });
  }

  reconcileAllDevices() {
    if (!this._running) return;
    const allDevices = this.store.listAllDevicesInternal();
    const validIds = new Set(allDevices.map((d) => d.id));

    for (const existingId of Array.from(this.sessions.keys())) {
      if (!validIds.has(existingId)) {
        this._stopDeviceWorker(existingId, '设备已移除');
        this.sessions.delete(existingId);
      }
    }

    for (const dev of allDevices) {
      this.reconcileDevice(dev.id);
    }
  }

  reconcileDevice(deviceId) {
    if (!this._running) return;
    const dev = this.store.getDeviceInternal(deviceId);
    if (!dev) {
      this._stopDeviceWorker(deviceId, '设备不存在');
      this.sessions.delete(deviceId);
      return;
    }

    const acc = this.store.getHydratedAccountInternal(dev.accountId);
    if (!acc || acc.authStatus === 'expired' || dev.isExpired) {
      this._stopDeviceWorker(deviceId, acc?.authStatus === 'expired' ? '账号登录态已过期' : '云手机套餐已到期');
      return;
    }

    const lease = this.webLeases.get(deviceId);
    if (lease && lease.expiresAt > Date.now()) {
      this._pauseForWebControl(dev);
      return;
    }

    if (!dev.keepaliveEnabled || dev.pausedReason) {
      this._stopDeviceWorker(deviceId, dev.pausedReason ? `保活已自动停用：${dev.pausedReason}` : '用户已关闭保活');
      return;
    }

    if (dev.synced === false) {
      this._stopDeviceWorker(deviceId, '云端同步未返回该设备（已标记 stale），暂停保活');
      return;
    }

    const rt = this._ensureRuntime(dev);
    if (rt.powerHoldUntil > Date.now()) return;
    // Persisted backoff survives restarts; the 5s sweep restarts once it elapses.
    if (dev.nextRunAt && dev.nextRunAt > Date.now()) return;
    if (rt.retryTimer) return;
    if (dev.keepaliveMode !== 'continuous') {
      const wait = (dev.waitMinutes || 5) * 60000;
      const connect = (dev.connectMinutes || 5) * 60000;
      const anchor = this.store.ensureScheduleStartedAt
        ? this.store.ensureScheduleStartedAt(dev.id)
        : (Number(dev.scheduleStartedAt) || Date.now());
      const elapsed = Math.max(0, Date.now() - anchor);
      const phase = elapsed % (wait + connect);
      if (phase < wait) {
        this._stopDeviceWorker(dev.id);
        rt.state = 'SCHEDULE_WAIT';
        rt.nextConnectAt = Date.now() + wait - phase;
        return;
      }
      rt.nextConnectAt = null;
    }
    if (['PREPARING', 'CONNECTING', 'KEEPING', 'RECONNECTING'].includes(rt.state) && rt.active) {
      return;
    }
    this._startDeviceWorker(dev, acc);
  }

  getRuntimeSnapshot(deviceId) {
    const rt = this.sessions.get(deviceId);
    const device = this.store.getDeviceInternal ? this.store.getDeviceInternal(deviceId) : null;
    const lease = this.webLeases.get(deviceId);
    const webControlled = Boolean(lease && lease.expiresAt > Date.now());
    if (!rt) {
      return {
        state: webControlled ? 'WEB_CONTROL' : 'IDLE',
        stateText: webControlled ? 'Web 实时控制中' : '未启动保活',
        connectedSince: null,
        uptimeSeconds: 0,
        heartbeatCount: 0,
        reconnectCount: 0,
        lastHeartbeatAt: null,
        lastError: '',
        lastErrorAt: null,
        lastErrorCode: '',
        failCount: Number(device && device.failCount) || 0,
        lastSuccessAt: (device && device.lastSuccessAt) || null,
        nextRunAt: (device && device.nextRunAt) || null,
        pausedReason: (device && device.pausedReason) || '',
        webControlled,
      };
    }
    const uptimeSeconds =
      rt.connectedSince && rt.state === 'KEEPING'
        ? Math.max(0, Math.floor((Date.now() - rt.connectedSince) / 1000))
        : 0;
    const stateLabels = {
      IDLE: '未启动保活',
      SCHEDULE_WAIT: '按计划等待连接',
      PREPARING: '唤醒与环境准备中',
      CONNECTING: '正在建立长连接',
      KEEPING: '长期连接保活中',
      RECONNECTING: '断线重连等待中',
      WEB_CONTROL: 'Web 实时控制接管中',
      ERROR: '连接异常',
    };
    return {
      state: webControlled ? 'WEB_CONTROL' : rt.state,
      stateText: webControlled ? stateLabels.WEB_CONTROL : stateLabels[rt.state] || rt.state,
      connectedSince: rt.connectedSince,
      uptimeSeconds,
      heartbeatCount: rt.heartbeatCount,
      reconnectCount: rt.reconnectCount,
      lastHeartbeatAt: rt.lastHeartbeatAt,
      lastError: rt.lastError || '',
      lastErrorAt: rt.lastErrorAt || null,
      lastErrorCode: rt.lastErrorCode || '',
      failCount: rt.failCount || 0,
      lastSuccessAt: rt.lastSuccessAt || null,
      nextRunAt: rt.nextRunAt || null,
      pausedReason: (device && device.pausedReason) || '',
      nextConnectAt: rt.nextConnectAt || null,
      webControlled,
    };
  }

  acquireWebControlLease(ownerId, deviceId, clientSessionId = 'web', ttlMs = 45000) {
    const dev = this.store.getDeviceForOwner(ownerId, deviceId);
    if (!dev) {
      throw new Error('未找到该云手机设备或无权访问');
    }
    this.webLeases.set(deviceId, {
      ownerId,
      clientSessionId,
      expiresAt: Date.now() + ttlMs,
    });
    this._pauseForWebControl(dev);
    return { leased: true, expiresAt: Date.now() + ttlMs };
  }

  renewWebControlLease(ownerId, deviceId, ttlMs = 45000) {
    const dev = this.store.getDeviceForOwner(ownerId, deviceId);
    if (!dev) {
      throw new Error('未找到该云手机设备或无权访问');
    }
    const existing = this.webLeases.get(deviceId);
    const expiresAt = Date.now() + ttlMs;
    this.webLeases.set(deviceId, {
      ownerId,
      clientSessionId: existing?.clientSessionId || 'web',
      expiresAt,
    });
    return { leased: true, expiresAt };
  }

  releaseWebControlLease(ownerId, deviceId) {
    const dev = this.store.getDeviceForOwner(ownerId, deviceId);
    if (!dev) {
      throw new Error('未找到该云手机设备或无权访问');
    }
    const hadLease = this.webLeases.delete(deviceId);
    const rt = this.sessions.get(deviceId);
    if (rt && rt.state === 'WEB_CONTROL') {
      rt.state = 'IDLE';
      rt.active = false;
    }
    if (hadLease) {
      this.store.appendLog(ownerId, {
        level: 'info',
        deviceId: dev.id,
        phoneName: dev.phoneName,
        message: '已退出 Web 实时控制，恢复后台长期保活守护',
      });
    }
    this.reconcileDevice(deviceId);
    return { released: true };
  }

  _sweepExpiredWebLeases() {
    const now = Date.now();
    for (const [deviceId, lease] of Array.from(this.webLeases.entries())) {
      if (lease.expiresAt <= now) {
        this.webLeases.delete(deviceId);
        const dev = this.store.getDeviceInternal(deviceId);
        const rt = this.sessions.get(deviceId);
        if (rt && rt.state === 'WEB_CONTROL') {
          rt.state = 'IDLE';
          rt.active = false;
        }
        if (dev) {
          this.store.appendLog(dev.ownerId, {
            level: 'info',
            deviceId: dev.id,
            phoneName: dev.phoneName,
            message: 'Web 控制窗口租约已结束，自动恢复后台长期保活',
          });
          this.reconcileDevice(deviceId);
        }
      }
    }
  }

  _ensureRuntime(dev) {
    let rt = this.sessions.get(dev.id);
    if (!rt) {
      rt = {
        deviceId: dev.id,
        ownerId: dev.ownerId,
        state: 'IDLE',
        active: false,
        generation: 0,
        socket: null,
        pulseTimer: null,
        retryTimer: null,
        consecutiveFailures: 0,
        connectedSince: null,
        heartbeatCount: 0,
        reconnectCount: 0,
        lastHeartbeatAt: null,
        lastError: '',
        lastErrorAt: null,
        lastErrorCode: '',
        failCount: Number(dev.failCount || 0),
        lastSuccessAt: dev.lastSuccessAt || null,
        nextRunAt: dev.nextRunAt || null,
        authorizeTimer: null,
        confirmed: false,
        reqSeq: 1,
      };
      this.sessions.set(dev.id, rt);
    }
    return rt;
  }

  _pauseForWebControl(dev) {
    const rt = this._ensureRuntime(dev);
    if (rt.state === 'WEB_CONTROL') return;
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    rt.active = false;
    rt.state = 'WEB_CONTROL';
    this.store.appendLog(dev.ownerId, {
      level: 'info',
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: 'Web 实时显示与控制已接管，后台长连接暂时让位防互踢',
    });
  }

  pauseForPower(deviceId, holdMs = 90000) {
    this._stopDeviceWorker(deviceId);
    const dev = this.store.getDeviceInternal(deviceId);
    if (dev) this._ensureRuntime(dev).powerHoldUntil = Date.now() + holdMs;
  }

  _stopDeviceWorker(deviceId, reason = '') {
    const rt = this.sessions.get(deviceId);
    if (!rt) return;
    const wasActive = rt.active || rt.state === 'KEEPING' || rt.state === 'RECONNECTING';
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    rt.active = false;
    rt.state = 'IDLE';
    rt.connectedSince = null;
    if (wasActive && reason) {
      const dev = this.store.getDeviceInternal(deviceId);
      if (dev) {
        this.store.appendLog(dev.ownerId, {
          level: 'info',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: `长期保活已停止：${reason}`,
        });
      }
    }
  }

  _cleanupSocketAndTimers(rt) {
    if (rt.authorizeTimer) {
      clearTimeout(rt.authorizeTimer);
      rt.authorizeTimer = null;
    }
    if (rt.pulseTimer) {
      clearInterval(rt.pulseTimer);
      rt.pulseTimer = null;
    }
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer);
      rt.retryTimer = null;
    }
    if (rt.socket) {
      const s = rt.socket;
      rt.socket = null;
      try {
        s.removeAllListeners?.();
        s.close();
      } catch (closeErr) {
        // Best-effort teardown of an already-broken socket; the generation
        // bump makes the old socket's late events harmless either way.
        if (process.env.PHONE_DEBUG) console.warn('[keepalive] socket close failed:', closeErr.message);
      }
    }
  }

  async _startDeviceWorker(dev, account) {
    const rt = this._ensureRuntime(dev);
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    const gen = rt.generation;
    rt.active = true;
    rt.state = 'PREPARING';
    rt.lastError = '';

    try {
      if (dev.autoWakeup !== false) {
        await this.cmcc.ensureDeviceReady(account, dev.phoneId, dev.platformType, 40000);
      }
      if (gen !== rt.generation || !this._running) return;

      rt.state = 'CONNECTING';
      const auth = await this.cmcc.getStreamAuth(account, dev.phoneId, dev.platformType);
      if (gen !== rt.generation || !this._running) return;

      if (String(dev.platformType) === '2') {
        this._connectTCloudKeepalive(dev, account, rt, gen, auth);
      } else {
        this._connectYunKeepalive(dev, account, rt, gen, auth);
      }
    } catch (err) {
      if (gen !== rt.generation) return;
      if (err && err.code === 'CMCC_AUTH_EXPIRED') {
        this.store.updateAccountTokens(account.id, { authStatus: 'expired' });
        rt.active = false;
        rt.state = 'ERROR';
        rt.lastError = err.message;
        this.store.appendLog(dev.ownerId, {
          level: 'error',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: `账号 ${account.mobile} 登录态已失效，请重新使用手机验证码登录`,
        });
        return;
      }
      this._scheduleReconnect(dev, rt, gen, err.message || '保活初始化失败');
    }
  }

  _connectYunKeepalive(dev, account, rt, gen, auth) {
    const query = {
      authtype: 'token',
      boxid: auth.boxid,
      token: auth.token,
      platform: auth.platform || 'cloudphone',
      env: auth.env || 'phone580',
      sessionid: auth.sessionid || auth.token,
      streamingid: crypto.randomUUID(),
    };

    const sock = this.socketFactory
      ? this.socketFactory('yun', auth.signaling_url, query)
      : new EngineIoV3Socket(auth.signaling_url, query);

    rt.socket = sock;
    rt.confirmed = false;
    let authorized = false;

    // Transport-level failure helper: one place that tears down + schedules retry,
    // so a timeout and a socket close can never both count as one failure.
    const failConnection = (reason, failureCode, takeover = false) => {
      if (gen !== rt.generation) return;
      authorized = false;
      this._cleanupSocketAndTimers(rt);
      this._scheduleReconnect(dev, rt, gen, reason, { failureCode, takeover });
    };

    sock.on('connect', () => {
      if (gen !== rt.generation) return;
      // Socket.IO "connect" only proves the transport is up. The keepalive is
      // NOT healthy until the gateway answers `authorize`; without it the UI
      // would claim KEEPING while no usable session exists.
      if (rt.authorizeTimer) clearTimeout(rt.authorizeTimer);
      rt.authorizeTimer = setTimeout(() => {
        rt.authorizeTimer = null;
        if (gen !== rt.generation || authorized) return;
        failConnection(`云版信令鉴权超时：${this.authorizeTimeoutMs}ms 内未收到 authorize`, 'CMCC_AUTHORIZE_TIMEOUT');
      }, this.authorizeTimeoutMs);
      rt.authorizeTimer.unref?.();
    });

    sock.on('event', (eventName, payload) => {
      if (gen !== rt.generation) return;
      if (eventName !== 'authorize') return;
      if (rt.authorizeTimer) {
        clearTimeout(rt.authorizeTimer);
        rt.authorizeTimer = null;
      }
      if (payload && payload.authorized) {
        authorized = true;
        this._markKeeping(dev, rt, `云版信令鉴权成功 (boxId: ${auth.boxid})`);
        // Send initial room touch pulse to reset cloud phone idle timer
        sock.sendEvent('start', { room: auth.boxid, times: 1 });
      } else {
        const code = payload?.code;
        const takeover = TAKEOVER_CODES.has(Number(code));
        failConnection(
          `云版信令鉴权未通过 (code: ${code})`,
          code ? `CMCC_AUTHORIZE_${code}` : 'CMCC_AUTHORIZE_DENIED',
          takeover
        );
      }
    });

    sock.on('pong', () => {
      if (gen !== rt.generation) return;
      rt.heartbeatCount += 1;
      rt.lastHeartbeatAt = Date.now();
    });

    sock.on('error', (err) => {
      if (gen !== rt.generation) return;
      rt.lastError = err.message || '信令通道错误';
      rt.lastErrorCode = err.code || 'CMCC_SIGNAL_ERROR';
      rt.lastErrorAt = Date.now();
    });

    sock.on('close', (code, reason) => {
      if (gen !== rt.generation) return;
      this._cleanupSocketAndTimers(rt);
      // Session rotation after being authorized is normal in CMCC signaling; reconnect smoothly
      const smoothRotate = authorized && rt.consecutiveFailures === 0;
      this._scheduleReconnect(
        dev,
        rt,
        gen,
        smoothRotate ? '信令会话周期轮转续接' : `信令通道断开 (${code} ${reason || ''})`.trim(),
        {
          customDelayMs: smoothRotate ? 1500 : undefined,
          keepConnectedSince: smoothRotate,
          failureCode: smoothRotate ? '' : `CMCC_SIGNAL_CLOSE_${code}`,
        }
      );
    });

    // Periodic activity pulse so both signaling & cloud instance stay awake.
    // A thrown error is a real failure: no heartbeat credit, and it counts.
    rt.pulseTimer = setInterval(async () => {
      if (gen !== rt.generation || !this._running) return;
      try {
        if (sock.connected) {
          const sent = sock.sendEvent('start', { room: auth.boxid, times: 1 });
          if (sent === false) {
            // sendEvent reports false when the channel is not writable: that is a
            // failed pulse, not a delivered one.
            const sendErr = new Error('活跃脉冲发送失败：信令通道不可写');
            sendErr.code = 'CMCC_PULSE_SEND_FAILED';
            throw sendErr;
          }
        }
        const freshAcc = this.store.getHydratedAccountInternal(account.id) || account;
        await this.cmcc.prepareDeviceV2(freshAcc, dev.phoneId, dev.platformType);
        if (gen !== rt.generation) return;
        rt.heartbeatCount += 1;
        rt.lastHeartbeatAt = Date.now();
        this._markPulseSuccess(dev, rt);
      } catch (pulseErr) {
        if (gen !== rt.generation) return;
        const message = `活跃脉冲失败：${(pulseErr && pulseErr.message) || pulseErr}`;
        rt.lastError = message;
        rt.lastErrorCode = (pulseErr && pulseErr.code) || 'CMCC_PULSE_FAILED';
        rt.lastErrorAt = Date.now();
        const failCount = this._recordFailure(dev, rt, message, rt.lastErrorCode);
        this.store.appendLog(dev.ownerId, {
          level: failCount >= this.failSoft ? 'error' : 'warn',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: `${message}（连续失败 ${failCount}/${this.failPause}）`,
        });
        if (this._pauseDeviceIfExhausted(dev, rt, message)) return;
        if (!sock.connected) {
          this._cleanupSocketAndTimers(rt);
          this._scheduleReconnect(dev, rt, gen, message, { failureCode: rt.lastErrorCode });
        }
      }
    }, this.yunRefreshPulseMs);
    rt.pulseTimer.unref?.();

    sock.open();
  }

  _connectTCloudKeepalive(dev, account, rt, gen, auth) {
    const connToken = auth.tokenQueue[0];
    const ws = this.socketFactory
      ? this.socketFactory('tcloud', auth.cmdUrl, { token: connToken })
      : new RawWebSocket(auth.cmdUrl);

    rt.socket = ws;
    rt.confirmed = false;
    let firstFrameTimer = null;
    let closed = false;

    const sendCmd = (code, innerObj) => {
      if (ws.readyState !== RawWebSocket.OPEN) return false;
      try {
        ws.send(
          JSON.stringify({
            code,
            msg: JSON.stringify(innerObj),
          })
        );
        return true;
      } catch (sendErr) {
        rt.lastError = `T版命令发送失败：${(sendErr && sendErr.message) || sendErr}`;
        rt.lastErrorCode = 'CMCC_T_SEND_FAILED';
        rt.lastErrorAt = Date.now();
        return false;
      }
    };

    // Single teardown path for this connection: avoids double-counting a
    // failure through both the timeout and the resulting close event.
    const failConnection = (reason, failureCode, takeover = false) => {
      if (gen !== rt.generation || closed) return;
      closed = true;
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
      this._cleanupSocketAndTimers(rt);
      this._scheduleReconnect(dev, rt, gen, reason, { failureCode, takeover });
    };

    const markConfirmed = (frameLabel) => {
      if (rt.confirmed) return;
      rt.confirmed = true;
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
      this._markKeeping(dev, rt, `T版命令通道已确认可用（${frameLabel}）`);
    };

    ws.on('open', () => {
      if (gen !== rt.generation) return;
      // 'open' only means the upgrade finished. Sending a prepare frame that
      // nobody accepts is still a failed keepalive, so never mark KEEPING here.
      rt.reqSeq += 1;
      const prepareSent = sendCmd(10013, {
        type: CMD_ACTION_PREPARE_CONNECT,
        reqid: rt.reqSeq,
        time: Date.now(),
        message: JSON.stringify({
          packageName: '',
          capbility: 7,
          definition: 1,
          density: 320,
          width: 720,
          height: 1280,
          machineType: 0,
          userToken: auth.userToken || '',
          cloudId: auth.cloudId,
          phoneId: auth.internalPhoneId,
          isMqttFailed: auth.isMqttFailed,
        }),
        device: 6,
        t: connToken,
        version: 0,
      });

      if (!prepareSent) {
        failConnection('T版通道已打开但 prepare 帧发送失败', 'CMCC_T_PREPARE_SEND_FAILED');
        return;
      }

      // No frame at all means the gateway never accepted us: fail instead of
      // sitting in CONNECTING forever.
      firstFrameTimer = setTimeout(() => {
        firstFrameTimer = null;
        if (gen !== rt.generation || rt.confirmed) return;
        failConnection(`T版命令通道未确认：${this.firstFrameTimeoutMs}ms 内未收到服务端任何帧`, 'CMCC_T_FIRST_FRAME_TIMEOUT');
      }, this.firstFrameTimeoutMs);
      firstFrameTimer.unref?.();

      const sendHeartbeats = () => {
        if (gen !== rt.generation || ws.readyState !== RawWebSocket.OPEN) return;
        rt.reqSeq += 1;
        const heartSent = sendCmd(10013, {
          type: CMD_ACTION_HEART,
          reqid: rt.reqSeq,
          time: Date.now(),
          message: '',
          device: 6,
          t: connToken,
          version: 0,
        });
        rt.reqSeq += 1;
        const ackSent = sendCmd(10014, {
          cmdType: CMD_ACTION_HEART,
          reqid: rt.reqSeq,
          data: '""',
          device: 6,
          t: connToken,
          version: 0,
          time: Date.now(),
        });
        if (!heartSent || !ackSent) {
          const message = 'T版心跳帧发送失败';
          rt.lastError = message;
          rt.lastErrorCode = 'CMCC_T_HEART_SEND_FAILED';
          rt.lastErrorAt = Date.now();
          const failCount = this._recordFailure(dev, rt, message, rt.lastErrorCode);
          this.store.appendLog(dev.ownerId, {
            level: failCount >= this.failSoft ? 'error' : 'warn',
            deviceId: dev.id,
            phoneName: dev.phoneName,
            message: `${message}（连续失败 ${failCount}/${this.failPause}）`,
          });
          if (this._pauseDeviceIfExhausted(dev, rt, message)) closed = true;
          return;
        }
        // Heartbeat credit only exists once the gateway answered us.
        if (rt.confirmed) {
          rt.heartbeatCount += 1;
          rt.lastHeartbeatAt = Date.now();
        }
      };

      sendHeartbeats();
      rt.pulseTimer = setInterval(sendHeartbeats, 15000);
      rt.pulseTimer.unref?.();
    });

    ws.on('message', (data) => {
      if (gen !== rt.generation) return;
      let parsed = null;
      if (typeof data === 'string') {
        try {
          parsed = JSON.parse(data);
        } catch (parseErr) {
          // Non-JSON frames still prove the channel is alive; trace under debug.
          if (process.env.PHONE_DEBUG) {
            console.warn('[keepalive] T版非 JSON 帧:', String(data).slice(0, 120), parseErr.message);
          }
        }
      }
      const codeNum = parsed ? Number(parsed.code) : NaN;
      const typeNum = parsed ? Number(parsed.type) : NaN;
      if (TAKEOVER_CODES.has(codeNum) || TAKEOVER_CODES.has(typeNum)) {
        const msg = `云机在其他终端登录或被服务端断开 (code: ${codeNum || typeNum})`;
        rt.lastError = msg;
        rt.lastErrorCode = 'CMCC_TAKEOVER';
        rt.lastErrorAt = Date.now();
        this.store.appendLog(dev.ownerId, {
          level: 'warn',
          deviceId: dev.id,
          phoneName: dev.phoneName,
          message: `${msg}，退避至少 ${Math.round(this.takeoverBackoffMs / 60000)} 分钟以避免双端互踢`,
        });
        failConnection(msg, 'CMCC_TAKEOVER', true);
        return;
      }
      // Any other server frame is the confirmation that the channel is usable.
      markConfirmed(parsed ? `首帧 code=${parsed.code ?? '-'}` : '首帧');
    });

    ws.on('error', (err) => {
      if (gen !== rt.generation) return;
      rt.lastError = err.message || 'T版命令通道异常';
      rt.lastErrorCode = err.code || 'CMCC_T_CHANNEL_ERROR';
      rt.lastErrorAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      if (gen !== rt.generation || closed) return;
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
      this._cleanupSocketAndTimers(rt);
      this._scheduleReconnect(dev, rt, gen, `T版通道断开 (${code} ${reason || ''})`.trim(), {
        failureCode: `CMCC_T_CLOSE_${code}`,
      });
    });
  }

  /** Only called after a verified success frame / authorisation, never on open. */
  _markKeeping(dev, rt, logMsg) {
    rt.state = 'KEEPING';
    rt.consecutiveFailures = 0;
    rt.failCount = 0;
    rt.softFailCount = 0;
    rt.lastError = '';
    rt.lastErrorCode = '';
    rt.confirmed = true;
    if (!rt.connectedSince) {
      rt.connectedSince = Date.now();
    }
    rt.lastHeartbeatAt = Date.now();
    rt.lastSuccessAt = Date.now();
    rt.nextRunAt = null;
    this.store.updateDeviceRuntimeState(dev.id, {
      failCount: 0,
      lastSuccessAt: rt.lastSuccessAt,
      lastError: '',
      lastErrorCode: '',
      lastErrorAt: null,
      nextRunAt: null,
    });
    this.store.appendLog(dev.ownerId, {
      level: 'success',
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: logMsg,
    });
  }

  /** A successful activity pulse proves the session still works. */
  _markPulseSuccess(dev, rt) {
    rt.lastSuccessAt = Date.now();
    rt.failCount = 0;
    rt.softFailCount = 0;
    rt.nextRunAt = null;
    this.store.updateDeviceRuntimeState(dev.id, {
      failCount: 0,
      lastSuccessAt: rt.lastSuccessAt,
      nextRunAt: null,
    });
  }

  /**
   * 只有在「容器/本机出网」这一层坏的错误才算瞬时错误：面板重建容器的那几十秒里 DNS 还没通，
   * 云手机会连着失败 5 次，然后被判「连续失败」永久停用——机器就这么静默掉保活了。
   * 这类错误单独计数，不参与停用阈值（另有更高的软阈值兜底），成功后一起清零。
   */
  _isTransportError(reason, failureCode) {
    const s = String(reason || '') + ' ' + String(failureCode || '');
    return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|NetworkError|UND_ERR|network/i.test(s);
  }

  /** Count one consecutive failure and persist it (coalesced write). */
  _recordFailure(dev, rt, reason, failureCode = '') {
    const transient = this._isTransportError(reason, failureCode);
    if (transient) {
      rt.softFailCount = Number(rt.softFailCount || 0) + 1;
    } else {
      rt.softFailCount = 0;
      rt.failCount = Number(rt.failCount || 0) + 1;
      rt.consecutiveFailures = rt.failCount;
    }
    rt.lastError = reason;
    if (failureCode) rt.lastErrorCode = failureCode;
    rt.lastErrorAt = Date.now();
    this.store.updateDeviceRuntimeState(dev.id, {
      failCount: rt.failCount,
      lastError: rt.lastError,
      lastErrorCode: rt.lastErrorCode || '',
      lastErrorAt: rt.lastErrorAt,
    });
    return rt.failCount;
  }

  /** Stop keeping a device alive once consecutive failures hit the cap. */
  _pauseDeviceIfExhausted(dev, rt, reason) {
    const softCap = this.failPause * 6;
    if (rt.failCount < this.failPause && Number(rt.softFailCount || 0) < softCap) return false;
    this._cleanupSocketAndTimers(rt);
    rt.generation += 1;
    rt.active = false;
    rt.state = 'ERROR';
    rt.connectedSince = null;
    rt.nextRunAt = null;
    const pauseReason = rt.failCount >= this.failPause
      ? `连续 ${rt.failCount} 次保活失败（最近：${reason}）`
      : `网络持续不通，${rt.softFailCount} 次重连均失败（最近：${reason}）`;
    this.store.pauseDeviceKeepalive(dev.id, pauseReason);
    this.store.appendLog(dev.ownerId, {
      level: 'error',
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: `保活已自动停用（阈值 ${this.failPause} 次），需手动重新开启保活：${pauseReason}`,
    });
    return true;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.customDelayMs] fixed delay (e.g. smooth rotation)
   * @param {boolean} [options.keepConnectedSince] normal session rotation: not a failure
   * @param {string} [options.failureCode] code persisted as lastErrorCode
   * @param {boolean} [options.takeover] 19009/6105 style kick: long backoff
   */
  _scheduleReconnect(dev, rt, gen, reason, options = {}) {
    if (!this._running || gen !== rt.generation) return;
    const { customDelayMs, keepConnectedSince = false, failureCode = '', takeover = false } = options;
    const latestDev = this.store.getDeviceInternal(dev.id);
    if (!latestDev || !latestDev.keepaliveEnabled || latestDev.pausedReason) {
      rt.active = false;
      rt.state = 'IDLE';
      rt.connectedSince = null;
      return;
    }
    const lease = this.webLeases.get(dev.id);
    if (lease && lease.expiresAt > Date.now()) {
      this._pauseForWebControl(latestDev);
      return;
    }

    if (!keepConnectedSince) {
      this._recordFailure(dev, rt, reason, failureCode);
      rt.reconnectCount += 1;
      rt.connectedSince = null;
      if (this._pauseDeviceIfExhausted(dev, rt, reason)) return;
    }
    rt.state = 'RECONNECTING';
    rt.lastError = reason;

    const failures = Math.max(1, (rt.failCount || 0) + Math.min(6, Math.floor(Number(rt.softFailCount || 0) / 2)));
    let delayMs;
    if (customDelayMs !== undefined) {
      delayMs = customDelayMs;
    } else if (takeover) {
      // Being kicked by another terminal: back off far enough that the two
      // clients stop trading the session every few seconds.
      delayMs = Math.min(this.backoffMaxMs, this.takeoverBackoffMs * Math.pow(2, Math.min(failures - 1, 4)));
    } else {
      delayMs = Math.min(this.backoffMaxMs, this.baseBackoffMs * Math.pow(1.8, Math.min(failures - 1, 12)));
    }
    delayMs = Math.max(1000, Math.round(delayMs));

    if (!keepConnectedSince) {
      rt.nextRunAt = Date.now() + delayMs;
      this.store.updateDeviceRuntimeState(dev.id, { nextRunAt: rt.nextRunAt });
    }

    this.store.appendLog(dev.ownerId, {
      level: keepConnectedSince ? 'info' : (failures >= this.failSoft ? 'error' : 'warn'),
      deviceId: dev.id,
      phoneName: dev.phoneName,
      message: `${reason}，将在 ${Math.round(delayMs / 1000)}s 后自动重连保活（${this._isTransportError(reason, failureCode) ? `网络瞬时错误 ${rt.softFailCount || 0}/${this.failPause * 6}` : `连续失败 ${keepConnectedSince ? 0 : failures}/${this.failPause}`}）`,
    });

    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      if (gen !== rt.generation || !this._running) return;
      const freshDev = this.store.getDeviceInternal(dev.id);
      const freshAcc = freshDev ? this.store.getHydratedAccountInternal(freshDev.accountId) : null;
      if (!freshDev || !freshAcc || !freshDev.keepaliveEnabled || freshDev.pausedReason) return;
      rt.active = false; rt.state = 'IDLE';
      this.reconcileDevice(freshDev.id);
    }, delayMs);
    rt.retryTimer.unref?.();
  }

  async checkAllAccountTokens() {
    const accounts = this.store.getAllHydratedAccounts();
    for (const acc of accounts) {
      if (!acc || acc.authStatus === 'expired') continue;
      try {
        const res = await this.cmcc.checkAndRefreshToken(acc);
        if (res.refreshed) {
          this.store.updateAccountTokens(acc.id, {
            token: res.token,
            hwToken: res.hwToken,
            authStatus: 'valid',
          });
          this.store.appendLog(acc.ownerId, {
            level: 'info',
            message: `账号 ${acc.mobile} 官方 Token 已自动无感续期`,
          });
        } else {
          this.store.updateAccountTokens(acc.id, { authStatus: 'valid' });
        }
        const freshAcc = this.store.getHydratedAccountInternal(acc.id);
        const remoteDevs = await this.cmcc.listDevices(freshAcc);
        this.store.syncDevicesForAccount(acc.ownerId, acc.id, remoteDevs, {
          complete: remoteDevs.complete !== false,
        });
        this.accountFailures.set(acc.id, 0);
      } catch (err) {
        const code = (err && err.code) || '';
        const message = (err && err.message) || String(err);
        // Every inspection failure is logged and counted, not only auth expiry.
        const fails = (this.accountFailures.get(acc.id) || 0) + 1;
        this.accountFailures.set(acc.id, fails);
        if (code === 'CMCC_AUTH_EXPIRED') {
          this.store.updateAccountTokens(acc.id, { authStatus: 'expired' });
          this.store.appendLog(acc.ownerId, {
            level: 'error',
            message: `账号 ${acc.mobile} 登录态已过期，请重新获取短信验证码登录`,
          });
          this.reconcileAllDevices();
        } else {
          this.store.appendLog(acc.ownerId, {
            level: fails >= this.failSoft ? 'error' : 'warn',
            message: `账号 ${acc.mobile} 巡检失败（连续 ${fails} 次）${code ? `[${code}]` : ''}：${message}`,
          });
        }
      }
    }
  }
}

module.exports = { KeepaliveEngine };
