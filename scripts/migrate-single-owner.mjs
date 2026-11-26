#!/usr/bin/env node
/**
 * 阶段 1 数据迁移：多用户 → 单用户（ownerId 统一为 'local'）
 *
 * 依据：用户 2026-11-25 批准的 auth 路由表（固定 owner id 字符串 'local'）。
 * 顺序要求（m00848）：停旧容器 → 跑本脚本 → 改代码 → 起新容器；绝不能让旧容器读迁移后数据。
 *
 * 做的事：
 *   1. 备份 data/ctyun/app_config.json 与 data/cmcc/store.json 为 <file>.bak.<ts>（同目录）
 *   2. ctyun：把主管理员 users[i].id 改名为 'local'（username/role/maxQuota/passwordHash 原样保留，
 *      因为 getUserById('local') 在加账号配额路径上被调用），accounts[].ownerId 改成 'local'
 *   3. cmcc：users[0].id 改名为 'local'，accounts[]/devices[].ownerId 改成 'local'，sessions 清空
 *   4. 迁移前后打印计数与备份 sha256；计数不符立即退出码 1
 *
 * 可重复执行（幂等）。回滚：cp <file>.bak.<ts> <file> 后重启旧镜像。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.DATA_ROOT || path.resolve(HERE, '..', 'data');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const LOCAL = 'local';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const backup = (p) => {
  const dst = p + '.bak.' + TS;
  fs.copyFileSync(p, dst);
  return dst;
};
const problems = [];

// ---------------------------------------------------------------- ctyun
const ctyunFile = path.join(DATA_ROOT, 'ctyun', 'app_config.json');
let ctyunReport = { skipped: true, missing: true };
if (fs.existsSync(ctyunFile)) {
  const cfg = readJson(ctyunFile);
  const users = Array.isArray(cfg.users) ? cfg.users : [];
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const desktopsBefore = accounts.reduce((n, a) => n + ((a.desktops || []).length), 0);
  const ownerIdsBefore = [...new Set(accounts.map((a) => a.ownerId))];
  const primary = users.find((u) => u.role === 'admin') || users[0];
  const usersSnapshotBefore = users.map((u) => ({ id: u.id, username: u.username, role: u.role }));
  const alreadyLocal = !!users.find((u) => u.id === LOCAL) && ownerIdsBefore.length === 1 && ownerIdsBefore[0] === LOCAL;

  const bak = backup(ctyunFile);
  if (!alreadyLocal) {
    if (!primary) {
      problems.push('ctyun: users 表为空，无法确定主管理员');
    } else {
      const oldId = primary.id;
      primary.id = LOCAL;
      primary.username = primary.username || 'local';
      for (const u of users) if (u !== primary && u.role === 'admin') u.disabled = true;
      for (const a of accounts) if (a.ownerId === oldId || !a.ownerId) a.ownerId = LOCAL;
      writeJsonAtomic(ctyunFile, cfg);
    }
  }
  const after = readJson(ctyunFile);
  const accAfter = Array.isArray(after.accounts) ? after.accounts : [];
  const ownerIdsAfter = [...new Set(accAfter.map((a) => a.ownerId))];
  ctyunReport = {
    skipped: alreadyLocal,
    file: ctyunFile,
    backup: bak,
    backupSha256_16: sha256(bak),
    usersBefore: usersSnapshotBefore,
    usersAfter: (after.users || []).map((u) => ({ id: u.id, username: u.username, role: u.role, maxQuota: u.maxQuota })),
    ownerIdsBefore,
    ownerIdsAfter,
    accounts: accAfter.length,
    desktops: desktopsBefore,
    desktopsAfter: accAfter.reduce((n, a) => n + ((a.desktops || []).length), 0),
    accountsWithPassword: accAfter.filter((a) => a.password && String(a.password).length > 0).length,
  };
  if (ownerIdsAfter.some((id) => id !== LOCAL)) problems.push('ctyun: 迁移后仍存在非 local 的 ownerId: ' + ownerIdsAfter.join(','));
  if (ctyunReport.accounts !== accounts.length) problems.push('ctyun: 账号数量发生变化');
  if (ctyunReport.desktopsAfter !== desktopsBefore) problems.push('ctyun: 云电脑数量发生变化');
}

// ---------------------------------------------------------------- cmcc
const cmccFile = path.join(DATA_ROOT, 'cmcc', 'store.json');
let cmccReport = { skipped: true, missing: true };
if (fs.existsSync(cmccFile)) {
  const st = readJson(cmccFile);
  const users = Array.isArray(st.users) ? st.users : [];
  const accounts = Array.isArray(st.accounts) ? st.accounts : [];
  const devices = Array.isArray(st.devices) ? st.devices : [];
  const ownerIdsBefore = [...new Set([...accounts.map((a) => a.ownerId), ...devices.map((d) => d.ownerId)])];
  const primary = users.find((u) => u.role === 'admin') || users[0];
  const usersSnapshotBefore = users.map((u) => ({ id: u.id, username: u.username, role: u.role }));
  const alreadyLocal = !!users.find((u) => u.id === LOCAL) && ownerIdsBefore.every((id) => id === LOCAL);

  const bak = backup(cmccFile);
  if (!alreadyLocal) {
    if (!primary) {
      problems.push('cmcc: users 表为空，无法确定主管理员');
    } else {
      const oldId = primary.id;
      primary.id = LOCAL;
      primary.username = primary.username || 'local';
      for (const a of accounts) if (a.ownerId === oldId || !a.ownerId) a.ownerId = LOCAL;
      for (const d of devices) if (d.ownerId === oldId || !d.ownerId) d.ownerId = LOCAL;
      st.sessions = [];
      writeJsonAtomic(cmccFile, st);
    }
  }
  const after = readJson(cmccFile);
  const ownerIdsAfter = [...new Set([...(after.accounts || []).map((a) => a.ownerId), ...(after.devices || []).map((d) => d.ownerId)])];
  cmccReport = {
    skipped: alreadyLocal,
    file: cmccFile,
    backup: bak,
    backupSha256_16: sha256(bak),
    usersBefore: usersSnapshotBefore,
    usersAfter: (after.users || []).map((u) => ({ id: u.id, username: u.username, role: u.role })),
    ownerIdsBefore,
    ownerIdsAfter,
    accounts: (after.accounts || []).length,
    devices: (after.devices || []).length,
    devicesKeepaliveEnabled: (after.devices || []).filter((d) => d.keepaliveEnabled).length,
    accountsWithToken: (after.accounts || []).filter((a) => a.tokenEnc).length,
    sessionsCleared: (after.sessions || []).length === 0,
  };
  if (ownerIdsAfter.some((id) => id !== LOCAL)) problems.push('cmcc: 迁移后仍存在非 local 的 ownerId: ' + ownerIdsAfter.join(','));
  if (cmccReport.accounts !== accounts.length) problems.push('cmcc: 账号数量发生变化');
  if (cmccReport.devices !== devices.length) problems.push('cmcc: 设备数量发生变化');
}

console.log(JSON.stringify({ ts: TS, dataRoot: DATA_ROOT, ctyun: ctyunReport, cmcc: cmccReport, problems }, null, 2));
if (problems.length) {
  console.error('MIGRATION FAILED: ' + problems.join(' | '));
  process.exit(1);
}
console.error('MIGRATION OK');
