// 中国移动 App 凭证只读客户端（协议移植自 margrop/ha-china-mobile, MIT；上游 MaYIHEI/paperclip）。
// 只做查询：话费余额 / 本月消费 / 套餐流量 / 积分。不签到、不办理、不改账号数据。
const crypto = require('crypto');
const https = require('https');

const HOST_LOGIN = 'client.app.coc.10086.cn';
const HOST_BIZ = 'clientaccess.10086.cn';
const PATH_AUTOLOGIN = '/biz-orange/LN/uamrandcodelogin/autoLogin';
const PATHS = {
  points: '/biz-orange/BN/scoreQueryService/getScoreQuery',
  fee: '/biz-orange/BN/payFeesQuery/getPayFeesQueryInfo',
  flow: '/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry',
  user: '/biz-orange/BN/userInformationService/getUserInformation',
};
const USER_AGENT = 'ChinaMobile/12.5.5 (iPhone; iOS 26.1; Scale/3.00)';
const SALT = 'Leadeon/SecurityOrganization';
const LOGIN_KEYS = ['tVkdaRWRY0ZkV1Vr', 'RYV0hCV1lV25KYVJ', 'VjFSQ1ZtVkQxRTlQ'];
const BIZ_KEYS = ['bAIgvwAuA4tbDr9d', 'GS7VelkJl5IT1uwQ', '9791027341711819'];
const TOKEN_KEY = 'bAIgvwAuA4tbDr9d';
const TOKEN_IV = '9791027341711819';
const OK = '000000';
const SESSION_EXPIRED = '410000';
const LEGACY_OPTS = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0x4;
const TIMEOUT_MS = 20000;

function md5(text) { return crypto.createHash('md5').update(text, 'utf8').digest('hex'); }

function encrypt(plain, key, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([c.update(String(plain), 'utf8'), c.final()]).toString('base64');
}

function decrypt(text, key, iv) {
  const cleaned = String(text || '').replace(/[^A-Za-z0-9+/]/g, '');
  const raw = Buffer.from(cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4), 'base64');
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([d.update(raw), d.final()]).toString('utf8');
}

function parseCapture(text) {
  let t = String(text || '').trim();
  if (!t.startsWith('{')) {
    try { t = decrypt(t, LOGIN_KEYS[0], LOGIN_KEYS[2]).trim(); }
    catch (e) { throw new Error('这不是 autoLogin 的请求体'); }
  }
  let env;
  try { env = JSON.parse(t); } catch (e) { throw new Error('这不是 autoLogin 的请求体'); }
  if (!env || typeof env !== 'object' || !env.tel) throw new Error('请求体里没有手机号');
  return t;
}

function phoneOf(envelope) { return String(JSON.parse(envelope).tel); }

function bizEnvelope(envelope) {
  const login = JSON.parse(envelope);
  const copy = Object.assign({}, login, { reqBody: { cellNum: login.tel } });
  return JSON.stringify(copy);
}

function signedHeaders(host, path, envelope, sid, qen, now, nonce) {
  const ts = now || String(Date.now());
  const n = nonce || String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const xk = JSON.parse(envelope).xk || '';
  const token = encrypt(xk + '_' + path + '_' + ts + '_' + n, TOKEN_KEY, TOKEN_IV);
  return {
    'Content-Type': 'application/Json',
    'User-Agent': USER_AGENT,
    'x-qen': qen,
    'x-time': ts,
    'x-nonce': n,
    xs: md5('https://' + host + path + '_' + envelope + '_' + SALT),
    'x-token': token,
    'x-sign': md5(token + '_' + ts + '_' + n + '_' + sid),
  };
}

function sessionCookie(setCookies) {
  const raw = (setCookies || []).join('; ');
  const found = [];
  ['JSESSIONID', 'UID', 'ticketID'].forEach(function (name) {
    const m = raw.match(new RegExp(name + '=([^;,\\s]+)'));
    if (m) found.push(name + '=' + m[1]);
  });
  return found.join('; ');
}

function post(host, path, headers, body) {
  return new Promise(function (resolve, reject) {
    const req = https.request({
      host: host, path: path, method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
      secureOptions: LEGACY_OPTS, timeout: TIMEOUT_MS,
    }, function (res) {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { s += d; });
      res.on('end', function () { resolve({ status: res.statusCode, text: s, cookies: res.headers['set-cookie'] || [] }); });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('请求超时')); });
    req.end(body);
  });
}

function decodeBody(text, key, iv) {
  const plain = decrypt(text || '', key, iv);
  return plain ? JSON.parse(plain) : {};
}

class CmccBilling {
  constructor(envelope) {
    this.envelope = parseCapture(envelope);
    this.phone = phoneOf(this.envelope);
    this._biz = bizEnvelope(this.envelope);
  }

  async refresh() {
    const headers = signedHeaders(HOST_LOGIN, PATH_AUTOLOGIN, this.envelope, 'null', '14');
    const r = await post(HOST_LOGIN, PATH_AUTOLOGIN, headers, encrypt(this.envelope, LOGIN_KEYS[0], LOGIN_KEYS[2]));
    let out;
    try { out = decodeBody(r.text, LOGIN_KEYS[1], LOGIN_KEYS[2]); }
    catch (e) {
      if (r.status && r.status !== 200) throw new Error('autoLogin 被网关拒绝 HTTP ' + r.status + '（凭证或网络环境不对）');
      throw new Error('autoLogin 响应不是预期密文：' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 100));
    }
    if (out.retCode !== OK) {
      const err = new Error('autoLogin ' + out.retCode + ' ' + (out.retDesc || ''));
      err.code = out.retCode;
      err.rateLimited = /频繁|繁忙|稍后|超时|限制|风控/.test(String(out.retDesc || '')) || out.retCode === '233031';
      throw err;
    }
    const cookie = sessionCookie(r.cookies);
    if (!cookie) throw new Error('autoLogin 没有返回会话 Cookie');
    return cookie;
  }

  async query(key, cookie) {
    const path = PATHS[key];
    const sid = (cookie.match(/JSESSIONID=([^;]+)/) || [null, ''])[1];
    const headers = signedHeaders(HOST_BIZ, path, this._biz, sid, '2');
    headers.Cookie = cookie;
    const r = await post(HOST_BIZ, path, headers, encrypt(this._biz, BIZ_KEYS[0], BIZ_KEYS[2]));
    let out;
    try { out = decodeBody(r.text, BIZ_KEYS[1], BIZ_KEYS[2]); }
    catch (e) { throw new Error(key + ': 响应不是预期密文 HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 80)); }
    if (out.retCode === SESSION_EXPIRED) throw new Error(key + ': session expired');
    if (out.retCode !== OK) throw new Error(key + ': ' + out.retCode + ' ' + (out.retDesc || ''));
    return out.rspBody || {};
  }

  async fetchAll() {
    const cookie = await this.refresh();
    const raw = {}, errors = {};
    for (const key of Object.keys(PATHS)) {
      try { raw[key] = await this.query(key, cookie); }
      catch (e) { raw[key] = null; errors[key] = e.message; }
    }
    const fee = raw.fee || {}, points = raw.points || {}, user = raw.user || {};
    const rows = ((raw.flow || {}).newPlanRemainQryRes || {}).planRemianFlowListRes;
    const list = (rows && rows.planRemianFlowRes) || [];
    const packages = (Array.isArray(list) ? list : [list]).map(function (row) {
      const total = Number(row.flowSumNum || 0), used = Number(row.flowUsdNum || 0);
      return { type: String(row.flowtype || ''), totalMb: total, usedMb: used, remainMb: Math.max(0, total - used) };
    });
    const main = packages[0] || null;
    return {
      phone: this.phone,
      balance: numberOrNull(fee.balance),
      consumed: numberOrNull(fee.payAmount),
      feeTime: fee.oprTime || '',
      points: numberOrNull(points.pointValue),
      packages: packages,
      flow: main ? { totalMb: main.totalMb, usedMb: main.usedMb, remainMb: main.remainMb } : null,
      user: user.userInfo || user,
      errors: errors,
    };
  }
}

function numberOrNull(v) { const n = Number(v); return v === undefined || v === null || v === '' || !isFinite(n) ? null : n; }

module.exports = { CmccBilling, parseCapture, phoneOf, encrypt, decrypt, signedHeaders, bizEnvelope, sessionCookie };
