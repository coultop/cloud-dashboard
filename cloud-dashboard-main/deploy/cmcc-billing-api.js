// 中国移动 App 凭证的存取与查询接口（只读）。凭证是 autoLogin 请求体，等同长期登录态：
// 落盘前用 AES-256-GCM 加密，密钥单独放 /data/cmcc/.billing.key（0600）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CmccBilling, parseCapture, phoneOf } = require('./cmcc_billing');

const DIR = process.env.CMCC_BILLING_DIR || '/data/cmcc';
const CRED_FILE = path.join(DIR, 'billing-credentials.json');
const KEY_FILE = path.join(DIR, '.billing.key');
const CACHE_MS = Math.max(60000, Number(process.env.CMCC_BILLING_CACHE_SEC || 1800) * 1000);
const LOGIN_SPACING_MS = 2000;
const MAX_ENVELOPE = 8000;

let lastLoginAt = 0;
const cache = new Map(); // phone -> { at, data }

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }

function key() {
  ensureDir();
  try { return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); }
  catch (e) {
    const k = crypto.randomBytes(32);
    try { fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 }); fs.chmodSync(KEY_FILE, 0o600); } catch (err) {}
    return k;
  }
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function open(sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 3) throw new Error('凭证密文损坏');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[0], 'base64'));
  d.setAuthTag(Buffer.from(parts[1], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8');
}

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function saveCreds(obj) {
  ensureDir();
  const tmp = CRED_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CRED_FILE);
  try { fs.chmodSync(CRED_FILE, 0o600); } catch (e) {}
}

function publicCred(phone, rec) {
  return { phone: phone, label: rec.label || '', savedAt: rec.savedAt || 0, lastOkAt: rec.lastOkAt || 0, lastError: rec.lastError || '' };
}

function maskPhone(p) { return /^1\d{10}$/.test(p) ? p.slice(0, 3) + '****' + p.slice(-4) : p; }

async function fetchOne(phone, rec, force) {
  const hit = cache.get(phone);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return Object.assign({ phone: phone, cached: true, ageSec: Math.round((Date.now() - hit.at) / 1000) }, hit.data);
  const wait = lastLoginAt + LOGIN_SPACING_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastLoginAt = Date.now();
  const client = new CmccBilling(open(rec.envelopeEnc));
  try {
    const data = await client.fetchAll();
    cache.set(phone, { at: Date.now(), data: data });
    rec.lastOkAt = Date.now();
    rec.lastError = '';
    return Object.assign({ phone: phone, cached: false, ageSec: 0 }, data);
  } catch (e) {
    rec.lastError = e.message || String(e);
    cache.delete(phone);
    return { phone: phone, cached: false, ageSec: 0, error: rec.lastError, rateLimited: !!e.rateLimited, errors: {} };
  }
}

function summarize(items) {
  let balance = 0, consumed = 0, points = 0, remainMb = 0, ok = 0;
  items.forEach(function (i) {
    if (i.error) return;
    ok += 1;
    if (typeof i.balance === 'number') balance += i.balance;
    if (typeof i.consumed === 'number') consumed += i.consumed;
    if (typeof i.points === 'number') points += i.points;
    if (i.flow && typeof i.flow.remainMb === 'number') remainMb += i.flow.remainMb;
  });
  return { count: items.length, ok: ok, balance: Math.round(balance * 100) / 100, consumed: Math.round(consumed * 100) / 100, points: points, remainMb: Math.round(remainMb) };
}

async function list(opts) {
  const force = !!(opts && opts.refresh);
  const creds = loadCreds();
  const phones = Object.keys(creds);
  const items = [];
  for (const phone of phones) {
    const rec = creds[phone];
    const out = await fetchOne(phone, rec, force);
    items.push(Object.assign({ label: rec.label || '', savedAt: rec.savedAt || 0, lastOkAt: rec.lastOkAt || 0, lastError: rec.lastError || '', masked: maskPhone(phone) }, out));
    creds[phone] = rec;
  }
  if (phones.length) saveCreds(creds);
  return { items: items, totals: summarize(items), fetchedAt: Date.now(), cacheSec: Math.round(CACHE_MS / 1000) };
}

function add(payload) {
  const raw = String((payload && (payload.envelope || payload.capture)) || '').trim();
  if (!raw) return { error: '请粘贴 autoLogin 的请求体' };
  if (raw.length > MAX_ENVELOPE) return { error: '请求体过长（超过 ' + MAX_ENVELOPE + ' 字符）' };
  let envelope, phone;
  try { envelope = parseCapture(raw); phone = phoneOf(envelope); }
  catch (e) { return { error: e.message }; }
  if (!/^1\d{10}$/.test(phone)) return { error: '请求体里的手机号不合法' };
  const creds = loadCreds();
  const existed = !!creds[phone];
  creds[phone] = { envelopeEnc: seal(envelope), label: String((payload && payload.label) || '').slice(0, 40), savedAt: Date.now(), lastOkAt: existed ? creds[phone].lastOkAt : 0, lastError: '' };
  saveCreds(creds);
  cache.delete(phone);
  return { ok: true, phone: phone, masked: maskPhone(phone), replaced: existed };
}

function remove(phone) {
  const creds = loadCreds();
  if (!creds[phone]) return { error: '没有该号码的凭证' };
  delete creds[phone];
  saveCreds(creds);
  cache.delete(phone);
  return { ok: true };
}

function hasAny() { return Object.keys(loadCreds()).length > 0; }

module.exports = { list, add, remove, hasAny, maskPhone, CRED_FILE, KEY_FILE };
