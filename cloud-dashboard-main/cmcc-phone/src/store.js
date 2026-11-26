'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MultiTenantStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.keyPath = path.join(this.dataDir, '.master.key');
    this.dbPath = path.join(this.dataDir, 'store.json');
    this.masterKey = this._loadOrCreateMasterKey();
    this.state = {
      users: [],
      sessions: [],
      accounts: [],
      devices: [],
    };
    this.logsByUser = new Map(); // userId -> array of log items (ring buffer)
    this.lockPath = path.join(this.dataDir, 'keepalive-engine.lock');
    // Coalesced persistence: runtime counters must never write synchronously in a loop.
    this._saveMinIntervalMs = Number(process.env.PHONE_SAVE_MIN_INTERVAL_MS) > 0
      ? Number(process.env.PHONE_SAVE_MIN_INTERVAL_MS)
      : 10000;
    this._lastSaveAt = 0;
    this._pendingSaveTimer = null;
    this._load();
  }

  _loadOrCreateMasterKey() {
    if (fs.existsSync(this.keyPath)) {
      const hex = fs.readFileSync(this.keyPath, 'utf8').trim();
      if (hex.length === 64) {
        return Buffer.from(hex, 'hex');
      }
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  encryptSecret(plain) {
    if (!plain) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decryptSecret(packed) {
    if (!packed) return '';
    const parts = String(packed).split(':');
    if (parts.length !== 3) return '';
    const [ivHex, tagHex, encHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  }

  _load() {
    if (!fs.existsSync(this.dbPath)) {
      this._save();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      this.state.users = Array.isArray(raw.users) ? raw.users : [];
      this.state.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
      this.state.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      this.state.devices = Array.isArray(raw.devices) ? raw.devices : [];
      // Backfill runtime state fields for stores written by older versions.
      this.state.devices = this.state.devices.map((d) => this.normalizeDevice(d));
    } catch (err) {
      const backup = `${this.dbPath}.corrupt.${Date.now()}`;
      fs.copyFileSync(this.dbPath, backup);
      this._save();
    }
  }

  _save() {
    this._clearPendingSave();
    this._lastSaveAt = Date.now();
    const tmp = `${this.dbPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.dbPath);
  }

  _clearPendingSave() {
    if (this._pendingSaveTimer) {
      clearTimeout(this._pendingSaveTimer);
      this._pendingSaveTimer = null;
    }
  }

  /**
   * Coalesced save: at most one write per this._saveMinIntervalMs.
   * Used for high-frequency runtime counters (failCount / nextRunAt / lastErrorAt).
   */
  _saveSoon() {
    const waitMs = this._saveMinIntervalMs - (Date.now() - this._lastSaveAt);
    if (waitMs <= 0) {
      this._save();
      return;
    }
    if (this._pendingSaveTimer) return;
    this._pendingSaveTimer = setTimeout(() => {
      this._pendingSaveTimer = null;
      try {
        this._save();
      } catch (err) {
        // Persisting a throttle flush must not take the server down.
        console.error('[store] throttled save failed:', err.message);
      }
    }, waitMs);
    this._pendingSaveTimer.unref?.();
  }

  /** Force any coalesced write to disk (shutdown / tests). */
  flush() {
    if (this._pendingSaveTimer) this._save();
  }

  normalizeDevice(dev) {
    if (!dev || typeof dev !== 'object') return dev;
    dev.failCount = Number.isFinite(Number(dev.failCount)) ? Number(dev.failCount) : 0;
    if (dev.lastSuccessAt === undefined) dev.lastSuccessAt = null;
    if (dev.lastErrorAt === undefined) dev.lastErrorAt = null;
    if (dev.lastErrorCode === undefined) dev.lastErrorCode = '';
    if (dev.lastError === undefined) dev.lastError = '';
    if (dev.nextRunAt === undefined) dev.nextRunAt = null;
    if (dev.pausedReason === undefined) dev.pausedReason = '';
    if (dev.synced === undefined) dev.synced = true;
    if (dev.staleAt === undefined) dev.staleAt = null;
    return dev;
  }

  // ===== Cross-process keepalive lock (pid file, O_EXCL) =====

  static isPidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
      process.kill(n, 0);
      return true;
    } catch (err) {
      return err && err.code === 'EPERM'; // exists but owned by another user
    }
  }

  readKeepaliveLock() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
    } catch (err) {
      return null;
    }
  }

  /**
   * Take the single-instance keepalive lock. Returns { acquired, pid?, stale? }.
   * A lock whose pid is gone is treated as stale and reclaimed once.
   */
  acquireKeepaliveLock() {
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      host: require('os').hostname(),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeSync(fd, payload);
        } finally {
          fs.closeSync(fd);
        }
        return { acquired: true, pid: process.pid };
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        const holder = this.readKeepaliveLock();
        const holderPid = holder && holder.pid;
        // A pid only means something on the host that wrote it: the data volume is
        // shared across containers, so a lock left by another host (or an earlier
        // container boot reusing the same pid) must not block this process forever.
        const sameHost = !holder || !holder.host || holder.host === require('os').hostname();
        if (holderPid && sameHost && MultiTenantStore.isPidAlive(holderPid)) {
          return { acquired: false, pid: holderPid, holder };
        }
        // Stale or unreadable lock: remove and retry once.
        try {
          fs.unlinkSync(this.lockPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
        }
      }
    }
    const holder = this.readKeepaliveLock();
    return { acquired: false, pid: holder && holder.pid, holder };
  }

  releaseKeepaliveLock() {
    const holder = this.readKeepaliveLock();
    if (!holder || Number(holder.pid) !== process.pid) return false;
    if (holder.host && holder.host !== require('os').hostname()) return false;
    try {
      fs.unlinkSync(this.lockPath);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Engine-level log line (no owner scope), e.g. lock refusal notices. */
  appendEngineLog(level, message) {
    const logRecord = { ts: Date.now(), level, ownerId: '', deviceId: '', phoneName: '', message: String(message || '').slice(0, 1500) };
    try {
      fs.appendFileSync(path.join(this.dataDir, 'runtime.jsonl'), JSON.stringify(logRecord) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('[store] engine log write failed:', err.message);
    }
  }

  static hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
  }

  static verifyPassword(password, stored) {
    const [salt, expectedHex] = String(stored || '').split(':');
    if (!salt || !expectedHex) return false;
    const actualHex = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  }

  // ===== User & Auth Isolation =====

  hasAnyUser() {
    return this.state.users.length > 0;
  }

  /**
   * 内网免登录模式使用：复用已有的首个管理员，没有就建一个不可登录的本地管理员。
   * 复用而非新建，是为了让此前注册账号下已绑定的云手机数据仍然可见。
   */
  ensureLocalAdmin() {
    let user = this.state.users.find((u) => u.role === 'admin' && !u.disabled);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        username: 'localadmin',
        passwordHash: MultiTenantStore.hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'admin',
        disabled: false,
        maxAccounts: 100,
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
      };
      this.state.users.push(user);
      this._save();
    }
    return this.sanitizeUser(user);
  }

  /**
   * 单用户模式（2026-11-25）：整块面板只有一个固定 owner，id 恒为 'local'。
   * 与 ensureLocalAdmin 的差别：id 固定（迁移脚本把历史数据 ownerId 改成 'local'），
   * 不在运行时"复用第一个 admin"，避免重启后 ownerId 漂移导致账号/设备看不见。
   */
  ensureLocalOwner() {
    let user = this.state.users.find((u) => u.id === 'local');
    if (!user) {
      user = {
        id: 'local',
        username: 'local',
        passwordHash: MultiTenantStore.hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'admin',
        disabled: false,
        maxAccounts: 100,
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
      };
      this.state.users.push(user);
      this._save();
    }
    return this.sanitizeUser(user);
  }

  registerUser({ username, password, role, maxAccounts }) {
    const cleanName = String(username || '').trim();
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5.-]{2,32}$/.test(cleanName)) {
      throw new Error('用户名需为 2~32 位字母、数字、中文或下划线');
    }
    if (!password || String(password).length < 6) {
      throw new Error('密码长度至少为 6 位');
    }
    const exists = this.state.users.find((u) => u.username.toLowerCase() === cleanName.toLowerCase());
    if (exists) {
      throw new Error('该用户名已被注册');
    }
    const isFirst = this.state.users.length === 0;
    const user = {
      id: crypto.randomUUID(),
      username: cleanName,
      passwordHash: MultiTenantStore.hashPassword(password),
      role: role || (isFirst ? 'admin' : 'user'),
      disabled: false,
      maxAccounts: Number.isFinite(Number(maxAccounts)) ? Number(maxAccounts) : (isFirst ? 100 : 10),
      createdAt: Date.now(),
      lastLoginAt: null,
    };
    this.state.users.push(user);
    this._save();
    return this.sanitizeUser(user);
  }

  authenticateUser(username, password) {
    const cleanName = String(username || '').trim().toLowerCase();
    const user = this.state.users.find((u) => u.username.toLowerCase() === cleanName);
    if (!user || !MultiTenantStore.verifyPassword(password, user.passwordHash)) {
      throw new Error('用户名或密码错误');
    }
    if (user.disabled) {
      throw new Error('当前账户已被管理员禁用');
    }
    user.lastLoginAt = Date.now();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    // Prune expired sessions
    this.state.sessions = this.state.sessions.filter((s) => s.expiresAt > now);
    this.state.sessions.push({
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      userId: user.id,
      createdAt: now,
      expiresAt: now + 30 * 24 * 3600 * 1000, // 30 days
    });
    this._save();
    return { token, user: this.sanitizeUser(user) };
  }

  getUserBySessionToken(token) {
    if (!token) return null;
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const now = Date.now();
    const session = this.state.sessions.find((s) => s.tokenHash === tokenHash && s.expiresAt > now);
    if (!session) return null;
    const user = this.state.users.find((u) => u.id === session.userId && !u.disabled);
    return user ? this.sanitizeUser(user) : null;
  }

  revokeSession(token) {
    if (!token) return;
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    this.state.sessions = this.state.sessions.filter((s) => s.tokenHash !== tokenHash);
    this._save();
  }

  sanitizeUser(u) {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      disabled: Boolean(u.disabled),
      maxAccounts: u.maxAccounts,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }

  listUsersForAdmin() {
    return this.state.users.map((u) => {
      const accCount = this.state.accounts.filter((a) => a.ownerId === u.id).length;
      const devCount = this.state.devices.filter((d) => d.ownerId === u.id).length;
      return {
        ...this.sanitizeUser(u),
        accountCount: accCount,
        deviceCount: devCount,
      };
    });
  }

  updateUserByAdmin(targetUserId, patch = {}) {
    const user = this.state.users.find((u) => u.id === targetUserId);
    if (!user) throw new Error('目标用户不存在');
    if (patch.disabled !== undefined) {
      user.disabled = Boolean(patch.disabled);
      if (user.disabled) {
        this.state.sessions = this.state.sessions.filter((s) => s.userId !== user.id);
      }
    }
    if (patch.maxAccounts !== undefined) {
      const m = Number(patch.maxAccounts);
      if (Number.isFinite(m) && m >= 1 && m <= 500) {
        user.maxAccounts = Math.floor(m);
      }
    }
    if (patch.newPassword) {
      if (String(patch.newPassword).length < 6) {
        throw new Error('新密码长度至少 6 位');
      }
      user.passwordHash = MultiTenantStore.hashPassword(patch.newPassword);
      this.state.sessions = this.state.sessions.filter((s) => s.userId !== user.id);
    }
    this._save();
    return this.sanitizeUser(user);
  }

  deleteUserByAdmin(targetUserId) {
    const idx = this.state.users.findIndex((u) => u.id === targetUserId);
    if (idx === -1) throw new Error('目标用户不存在');
    const removedAccountIds = this.state.accounts
      .filter((a) => a.ownerId === targetUserId)
      .map((a) => a.id);
    const removedDeviceIds = this.state.devices
      .filter((d) => d.ownerId === targetUserId)
      .map((d) => d.id);
    this.state.users.splice(idx, 1);
    this.state.sessions = this.state.sessions.filter((s) => s.userId !== targetUserId);
    this.state.accounts = this.state.accounts.filter((a) => a.ownerId !== targetUserId);
    this.state.devices = this.state.devices.filter((d) => d.ownerId !== targetUserId);
    this.logsByUser.delete(targetUserId);
    this._save();
    return { removedAccountIds, removedDeviceIds };
  }

  // ===== CMCC Accounts (Strictly Scoped to ownerId) =====

  upsertCmccAccount(ownerId, { mobile, remark, token, hwToken, cmccUserId, province, fingerprint }) {
    const user = this.state.users.find((u) => u.id === ownerId);
    if (!user) throw new Error('所属平台用户不存在');

    let acc = this.state.accounts.find((a) => a.ownerId === ownerId && a.mobile === mobile);
    if (!acc) {
      const currentCount = this.state.accounts.filter((a) => a.ownerId === ownerId).length;
      if (currentCount >= user.maxAccounts) {
        throw new Error(`已达到当前用户可绑定移动账号上限 (${user.maxAccounts} 个)`);
      }
      acc = {
        id: crypto.randomUUID(),
        ownerId,
        mobile,
        remark: remark || '',
        tokenEnc: this.encryptSecret(token),
        hwTokenEnc: this.encryptSecret(hwToken || ''),
        cmccUserId: cmccUserId || '',
        province: province || '',
        fingerprint,
        authStatus: 'valid',
        lastCheckAt: Date.now(),
        createdAt: Date.now(),
      };
      this.state.accounts.push(acc);
    } else {
      if (remark !== undefined && remark !== '') acc.remark = remark;
      acc.tokenEnc = this.encryptSecret(token);
      if (hwToken) acc.hwTokenEnc = this.encryptSecret(hwToken);
      if (cmccUserId) acc.cmccUserId = cmccUserId;
      if (province) acc.province = province;
      if (fingerprint) acc.fingerprint = fingerprint;
      acc.authStatus = 'valid';
      acc.lastCheckAt = Date.now();
    }
    this._save();
    return this.hydrateAccount(acc);
  }

  updateAccountTokens(accountId, { token, hwToken, authStatus }) {
    const acc = this.state.accounts.find((a) => a.id === accountId);
    if (!acc) return null;
    if (token) acc.tokenEnc = this.encryptSecret(token);
    if (hwToken !== undefined && hwToken !== '') acc.hwTokenEnc = this.encryptSecret(hwToken);
    if (authStatus) acc.authStatus = authStatus;
    acc.lastCheckAt = Date.now();
    this._save();
    return this.hydrateAccount(acc);
  }

  hydrateAccount(acc) {
    if (!acc) return null;
    return {
      id: acc.id,
      ownerId: acc.ownerId,
      mobile: acc.mobile,
      remark: acc.remark || '',
      token: this.decryptSecret(acc.tokenEnc),
      hwToken: this.decryptSecret(acc.hwTokenEnc),
      cmccUserId: acc.cmccUserId || '',
      province: acc.province || '',
      fingerprint: acc.fingerprint,
      authStatus: acc.authStatus || 'valid',
      lastCheckAt: acc.lastCheckAt,
      createdAt: acc.createdAt,
    };
  }

  sanitizeAccount(acc) {
    return {
      id: acc.id,
      ownerId: acc.ownerId,
      mobile: acc.mobile,
      remark: acc.remark || '',
      cmccUserId: acc.cmccUserId || '',
      province: acc.province || '',
      authStatus: acc.authStatus || 'valid',
      lastCheckAt: acc.lastCheckAt,
      createdAt: acc.createdAt,
    };
  }

  listAccountsByOwner(ownerId) {
    return this.state.accounts.filter((a) => a.ownerId === ownerId).map((a) => this.sanitizeAccount(a));
  }

  getHydratedAccountForOwner(ownerId, accountId) {
    const acc = this.state.accounts.find((a) => a.id === accountId && a.ownerId === ownerId);
    return acc ? this.hydrateAccount(acc) : null;
  }

  getHydratedAccountInternal(accountId) {
    const acc = this.state.accounts.find((a) => a.id === accountId);
    return acc ? this.hydrateAccount(acc) : null;
  }

  getAllHydratedAccounts() {
    return this.state.accounts.map((a) => this.hydrateAccount(a));
  }

  deleteAccountForOwner(ownerId, accountId) {
    const idx = this.state.accounts.findIndex((a) => a.id === accountId && a.ownerId === ownerId);
    if (idx === -1) throw new Error('未找到该移动账号或无权操作');
    const removedDeviceIds = this.state.devices
      .filter((d) => d.accountId === accountId && d.ownerId === ownerId)
      .map((d) => d.id);
    this.state.accounts.splice(idx, 1);
    this.state.devices = this.state.devices.filter((d) => !(d.accountId === accountId && d.ownerId === ownerId));
    this._save();
    return { removedDeviceIds };
  }

  // ===== CloudPhone Devices (Strictly Scoped to ownerId) =====

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.complete=true] false when the remote list may be partial
   *   (pagination aborted); unseen devices are then left untouched.
   */
  syncDevicesForAccount(ownerId, accountId, remoteDevices, opts = {}) {
    const complete = opts.complete !== false;
    const now = Date.now();
    const seenIds = new Set();
    const updated = [];

    for (const rd of remoteDevices || []) {
      seenIds.add(rd.phoneId);
      let dev = this.state.devices.find(
        (d) => d.ownerId === ownerId && d.accountId === accountId && d.phoneId === rd.phoneId
      );
      if (!dev) {
        dev = {
          id: crypto.randomUUID(),
          ownerId,
          accountId,
          phoneId: rd.phoneId,
          phoneName: rd.phoneName,
          platformType: rd.platformType || '1',
          instanceStatus: rd.instanceStatus,
          validStatus: rd.validStatus,
          lockStatus: rd.lockStatus || 0,
          isExpired: Boolean(rd.isExpired),
          expireStr: rd.expireStr || '',
          endTime: rd.endTime || '',
          specName: rd.specName || '',
          keepaliveEnabled: true, // Default enable keepalive on newly synced cloud phones
          keepaliveMode: 'cycle',
          autoWakeup: true,
          screenshotCache: '',
          screenshotUpdatedAt: null,
          failCount: 0,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorCode: '',
          lastError: '',
          nextRunAt: null,
          pausedReason: '',
          synced: true,
          staleAt: null,
          updatedAt: now,
        };
        this.state.devices.push(dev);
      } else {
        dev.phoneName = rd.phoneName || dev.phoneName;
        dev.platformType = rd.platformType || dev.platformType || '1';
        dev.instanceStatus = rd.instanceStatus;
        dev.validStatus = rd.validStatus;
        dev.lockStatus = rd.lockStatus || 0;
        dev.isExpired = Boolean(rd.isExpired);
        dev.expireStr = rd.expireStr || dev.expireStr;
        dev.endTime = rd.endTime || dev.endTime;
        dev.specName = rd.specName || dev.specName;
        dev.updatedAt = now;
      }
      dev.synced = true;
      dev.staleAt = null;
      updated.push(dev);
    }

    // Never physically delete on a sync: a partial/aborted remote list would
    // otherwise wipe real devices. Mark them stale and stop keeping them alive.
    if (complete) {
      for (const dev of this.state.devices) {
        if (dev.ownerId === ownerId && dev.accountId === accountId && !seenIds.has(dev.phoneId)) {
          if (dev.synced !== false) {
            dev.synced = false;
            dev.staleAt = now;
          }
        }
      }
    }
    this._save();
    return updated;
  }

  listDevicesByOwner(ownerId) {
    return this.state.devices.filter((d) => d.ownerId === ownerId).map((d) => ({ ...d }));
  }

  listAllDevicesInternal() {
    return this.state.devices.map((d) => ({ ...d }));
  }

  getDeviceForOwner(ownerId, deviceId) {
    const dev = this.state.devices.find((d) => d.id === deviceId && d.ownerId === ownerId);
    return dev ? { ...dev } : null;
  }

  getDeviceInternal(deviceId) {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    return dev ? { ...dev } : null;
  }

  updateDeviceSettingsForOwner(ownerId, deviceId, patch = {}) {
    const dev = this.state.devices.find((d) => d.id === deviceId && d.ownerId === ownerId);
    if (!dev) throw new Error('未找到该云手机设备或无权操作');
    if (patch.keepaliveEnabled !== undefined) {
      dev.keepaliveEnabled = Boolean(patch.keepaliveEnabled);
      if (dev.keepaliveEnabled) {
        // A manual re-enable always clears an automatic pause.
        dev.pausedReason = '';
        dev.failCount = 0;
        dev.nextRunAt = null;
      }
    }
    if (patch.autoWakeup !== undefined) dev.autoWakeup = Boolean(patch.autoWakeup);
    if (patch.keepaliveMode !== undefined) {
      if (!['continuous', 'cycle'].includes(patch.keepaliveMode)) throw new Error('无效保活模式');
      dev.keepaliveMode = patch.keepaliveMode;
    }
    for (const field of ['waitMinutes', 'connectMinutes']) {
      if (patch[field] !== undefined) {
        const value = Number(patch[field]);
        if (!Number.isFinite(value) || value < 1 || value > 10080) throw new Error('分钟数必须为 1~10080');
        dev[field] = value;
      }
    }
    if (['keepaliveMode','waitMinutes','connectMinutes','keepaliveEnabled'].some(k => patch[k] !== undefined)) dev.scheduleStartedAt = Date.now();
    dev.updatedAt = Date.now();
    this._save();
    return { ...dev };
  }

  /**
   * Persist keepalive runtime counters (high frequency -> coalesced write).
   */
  updateDeviceRuntimeState(deviceId, patch = {}) {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    if (!dev) return null;
    const fields = ['failCount', 'lastSuccessAt', 'lastErrorAt', 'lastErrorCode', 'lastError', 'nextRunAt', 'pausedReason'];
    for (const key of fields) {
      if (patch[key] !== undefined) dev[key] = patch[key];
    }
    this._saveSoon();
    return { ...dev };
  }

  /** Disable keepalive for a device and record why (re-enabling clears it). */
  pauseDeviceKeepalive(deviceId, reason) {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    if (!dev) return null;
    dev.keepaliveEnabled = false;
    dev.pausedReason = String(reason || '连续失败已自动停用');
    dev.nextRunAt = null;
    // A pause is rare and is the exact state a crash must not lose: write it now
    // instead of riding the 10s throttle, or a SIGKILL reopens keepalive on a
    // device that just exhausted its retries.
    this._save();
    return { ...dev };
  }

  /**
   * Phase anchor for periodic keepalive.
   * updatedAt is rewritten on every cloud sync, so it cannot be the anchor:
   * elapsed would restart each sync and the cycle phase would never advance.
   */
  ensureScheduleStartedAt(deviceId) {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    if (!dev) return Date.now();
    if (!Number(dev.scheduleStartedAt)) {
      dev.scheduleStartedAt = Date.now();
      this._save();
    }
    return dev.scheduleStartedAt;
  }

  updateDeviceScreenshot(deviceId, screenshotUrlOrData) {
    const dev = this.state.devices.find((d) => d.id === deviceId);
    if (!dev) return null;
    dev.screenshotCache = screenshotUrlOrData || '';
    dev.screenshotUpdatedAt = Date.now();
    this._save();
    return { ...dev };
  }

  // ===== Per-User Isolated Logs =====

  appendLog(ownerId, { level = 'info', deviceId = '', phoneName = '', message }) {
    if (!ownerId) return;
    const logRecord = { ts: Date.now(), level, ownerId, deviceId, phoneName, message: String(message || '').slice(0,1500) };
    fs.appendFileSync(path.join(this.dataDir, 'runtime.jsonl'), JSON.stringify(logRecord) + '\n', { mode: 0o600 });
    let list = this.logsByUser.get(ownerId);
    if (!list) {
      list = [];
      this.logsByUser.set(ownerId, list);
    }
    list.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      level,
      deviceId,
      phoneName,
      message,
    });
    if (list.length > 400) {
      list.splice(0, list.length - 400);
    }
  }

  getLogsForOwner(ownerId, limit = 120) {
    const list = this.logsByUser.get(ownerId) || [];
    return list.slice(-limit).reverse();
  }
}

module.exports = { MultiTenantStore };
