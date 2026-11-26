'use strict';
/**
 * 资费参考：把公开资费库（rdtscx/tariff，四家运营商官网公示价）里的「云电脑 / 云手机」条目
 * 与面板上的实例名对齐。数据由 tariff-sync.js 落成快照，本模块只读快照、不联网。
 * 原则：宁可显示「未收录 / 多档」，也不替用户猜一个价——猜出来的数字会直接进「月资费合计」。
 */
const fs = require('fs');

const SNAPSHOT = process.env.TARIFF_SNAPSHOT || '/data/tariff-snapshot.json';

const UNIT_WORDS = ['连续包月', '趸付方案', '一次性', '月包', '月卡', '季卡', '年卡', '年包', '天卡', '周卡'];
const BRACKET = /[（(]([^）)]*)[）)]/g;
const PRICE_PREFIX = /^\d+(?:\.\d+)?元/;
const PROVINCE_ALIAS = { 广州: '广东', 深圳: '广东', 北京: '北京', 上海: '上海' };

function norm(s) {
  return String(s || '').replace(PRICE_PREFIX, '').replace(/[\s·・/\\|]+/g, '').replace(/️/g, '').trim();
}

/** 名字 → { key: 去括号去计费词的核心名, tags: 括号里的规格标记（4C8G 之类） } */
function parseName(name) {
  const n = norm(name);
  const tags = [];
  let rest = n;
  let m;
  BRACKET.lastIndex = 0;
  while ((m = BRACKET.exec(n))) {
    for (const tok of String(m[1] || '').split(/[+＋、,，]/)) {
      const t = tok.replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '');
      if (t && /[0-9]/.test(t)) tags.push(t);
    }
  }
  rest = n.replace(BRACKET, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of UNIT_WORDS) {
      if (rest.length > w.length && rest.endsWith(w)) { rest = rest.slice(0, -w.length); changed = true; }
    }
  }
  return { key: rest, tags: tags };
}

let cache = { mtimeMs: 0, data: null };

function load() {
  try {
    const st = fs.statSync(SNAPSHOT);
    if (cache.data && cache.mtimeMs === st.mtimeMs) return cache.data;
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const plans = (Array.isArray(raw.plans) ? raw.plans : []).filter((p) => p && p.name).map((p) => {
      const parsed = parseName(p.name);
      return Object.assign({}, p, { key: parsed.key, tags: parsed.tags, bracketText: norm(p.name) });
    });
    const index = new Map();
    for (const p of plans) {
      if (!p.key) continue;
      if (!index.has(p.key)) index.set(p.key, []);
      index.get(p.key).push(p);
    }
    cache = { mtimeMs: st.mtimeMs, data: { raw: raw, plans: plans, index: index } };
    return cache.data;
  } catch (err) {
    cache = { mtimeMs: 0, data: { raw: null, plans: [], index: new Map(), error: (err && (err.code || err.message)) || 'load failed' } };
    return cache.data;
  }
}

function priceOf(plan) {
  const m = /^(\d+(?:\.\d+)?)元\/(.+)$/.exec(String(plan.price || '').replace(/\s+/g, ''));
  if (!m) return null;
  const months = { 月: 1, 季: 3, 年: 12, 三年: 36 }[m[2]];
  return { value: Number(m[1]), unit: m[2], months: months || 0 };
}

/**
 * hint.province：账号归属省份（"北京" / "广州" 之类），先按省份收窄再加规格标记过滤。
 * 只在「唯一月价」时返回 ok；两档以上如实回 ambiguous。
 */
function match(name, hint) {
  const db = load();
  const parsed = parseName(name);
  const meta = { snapshot: db.raw ? db.raw.updated : '', plans: db.plans.length };
  if (!parsed.key) return Object.assign({ status: 'unknown' }, meta);
  let hits = (db.index.get(parsed.key) || []).slice();
  if (!hits.length) return Object.assign({ status: 'unknown', core: parsed.key }, meta);

  const province = hint && hint.province ? String(hint.province) : '';
  const want = PROVINCE_ALIAS[province] || province.replace(/[省市]$/, '');
  if (want) {
    const local = hits.filter((p) => p.province && p.province.indexOf(want) >= 0);
    if (local.length) hits = local;
  }
  if (parsed.tags.length) {
    const tagged = hits.filter((p) => parsed.tags.every((t) => p.bracketText.indexOf(t) >= 0));
    if (tagged.length) hits = tagged;
  }

  const priced = hits.map((p) => ({ plan: p, price: priceOf(p) })).filter((x) => x.price);
  if (!priced.length) return Object.assign({ status: 'unknown', core: parsed.key }, meta);
  const monthly = priced.filter((x) => x.price.unit === '月');
  const unique = new Map();
  for (const x of monthly) if (!unique.has(x.price.value)) unique.set(x.price.value, x);
  if (unique.size === 1) {
    const only = monthly[0];
    return Object.assign({
      status: 'ok',
      core: parsed.key,
      monthly: only.price.value,
      planName: only.plan.name,
      code: only.plan.code || '',
      province: only.plan.province || '',
      from: only.plan.from || '',
      to: only.plan.to || '',
    }, meta);
  }
  return Object.assign({
    status: 'ambiguous',
    core: parsed.key,
    candidates: priced.slice(0, 4).map((x) => ({
      planName: x.plan.name, price: x.plan.price, code: x.plan.code || '', province: x.plan.province || '',
    })),
  }, meta);
}


/* ---------------- 业务开通通道（怎么买 / 去哪办 / 怎么退） ----------------
 * 公示资费库只给「能办什么、多少钱、给什么」，不给办理入口。这里按公示文案里真实出现过的
 * 渠道词做识别（10086 703 次、移动爱家APP 119 次、中国移动APP 87 次、营业厅 72 次），
 * 识别不到的给通用三通道，绝不编造专属链接。 */
const CHANNEL_RULES = [
  { key: '10086', label: '拨打 10086 或发短信 10086', hint: '人工客服可查该方案编号是否仍可办；短信营业厅发 10086 到 10086。', re: /10086|短信营业厅/ },
  { key: 'aijia', label: '移动爱家 App', hint: '爱家 App → 我的 → 我的业务 / 云电脑，云电脑与云手机基本都在这里办。', re: /移动爱家\s*APP|和家亲/i },
  { key: 'app', label: '中国移动 App / 网上营业厅', hint: '中国移动 App 搜方案编号，或在 10086.cn 网上营业厅搜「资费公示」。', re: /中国移动\s*APP|掌上营业厅|网上营业厅/i },
  { key: 'hall', label: '线下营业厅', hint: '涉及终端归还、合约解除、副卡绑定的一般只能到厅办。', re: /营业厅|实体厅|自营厅/ },
  { key: 'sms', label: '按短信里的领取链接领取', hint: '公示文案写明通过短信链接领取，注意链接只发到你本人号码。', re: /短信中的领取链接|领取链接/ },
];

function channelsOf(text) {
  const s = String(text || '');
  const out = [];
  CHANNEL_RULES.forEach((r) => { if (r.re.test(s)) out.push({ key: r.key, label: r.label, hint: r.hint, quoted: true }); });
  if (!out.length) {
    CHANNEL_RULES.slice(0, 4).forEach((r) => out.push({ key: r.key, label: r.label, hint: r.hint, quoted: false }));
  }
  return out;
}

// 公示文案里真实出现的办理/退订线索：短信指令、官方链接、原句。抽不到就返回空数组，绝不补编。
const SMS_CODE_RE = /(?:发送|编辑短信|回复|上行|发短信)[^0-9A-Za-z\u4e00-\u9fa5]{0,6}[「“"']?([A-Za-z0-9]{2,16})[」”"']?\s*(?:到|至|发送到)\s*10086/i;
const SMS_ANY_RE = /发送|编辑短信|回复|上行/;

function sentencesOf(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .split(/[。；;！!\n]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3);
}

function smsOf(text) {
  const out = [];
  const seen = {};
  sentencesOf(text).forEach((s) => {
    if (!/10086/.test(s) || !SMS_ANY_RE.test(s)) return;
    const m = s.match(SMS_CODE_RE);
    if (!m) return;
    const code = m[1];
    if (seen[code]) return;
    const kind = /退订|取消|关闭|解除/.test(s) ? 'cancel' : /开通|订购|办理|订阅/.test(s) ? 'order' : 'other';
    seen[code] = true;
    out.push({ code: code, kind: kind, to: '10086', sentence: s.slice(0, 200) });
  });
  return out;
}

function linksOf(text) {
  const out = [];
  const seen = {};
  const m = String(text || '').match(/https?:\/\/[^\s"'<>）)，,。；;]+/g) || [];
  m.forEach((u) => {
    const url = u.replace(/[。，,；;]+$/, '');
    if (seen[url]) return;
    seen[url] = true;
    out.push({ url: url, label: (url.match(/^https?:\/\/([^\/]+)/) || [])[1] || url });
  });
  return out.slice(0, 5);
}

function quotesOf(text, withSms) {
  const out = [];
  sentencesOf(text).forEach((s) => {
    if (out.length >= 4) return;
    if (!/办理|订购|开通|退订|取消|领取|预约/.test(s)) return;
    if (!/发送|APP|App|app|营业厅|10086|链接|扫码|公众号|短信/.test(s)) return;
    out.push(s.slice(0, 220));
  });
  return out;
}

/** 面上统一的「开通指导」结构化输出，前端只负责排版 */
function guideOf(item, isCloud) {
  const it = item || {};
  const text = [it.name, it.note, it.benefit, it.scope].filter(Boolean).join(' ');
  const channels = isCloud
    ? [
        { key: 'aijia', label: '移动爱家 App', hint: '爱家 App → 我的 → 云电脑 / 云手机：开通、续费、改套餐都在这里。', quoted: true },
        { key: '10086', label: '拨打 10086', hint: '报方案编号让客服查是否可办；云电脑退订也可走 10086。', quoted: true },
        { key: 'app', label: '中国移动 App', hint: '搜方案编号或「云电脑」专区。', quoted: false },
        { key: 'hall', label: '线下营业厅', hint: '涉及终端/权益包退订时只能到厅。', quoted: false },
      ]
    : channelsOf(text);
  const sms = isCloud ? [] : smsOf(text);
  const links = linksOf(text);
  const quotes = quotesOf(text);
  return {
    channels: channels,
    sms: sms,
    links: links,
    quotes: quotes,
    smsGap: sms.length || isCloud
      ? ''
      : '这条方案的公示文案里没有写短信指令（发送什么码到 10086），面板不编造指令；开通/退订请走上面的 App 或 10086 人工。',
    steps: [
      '先确认方案编号（' + String(it.code || '未提供') + '）与价格口径（' + String(it.price || '未提供') + '）——公示价不等于你的账单，最终以办理页面的实收为准。',
      '办理前问清三件事：是否合约期、到期是否自动续订、退订要不要到营业厅（公示文案里通常写在「其他服务内容」）。',
      '办完回面板「资源」页看这台机器是否出现在账号下；云电脑类还要确认「保活开关」是否打开。',
    ],
    cancel: String(it.note || '') || (isCloud
      ? '云电脑/云手机的退订走「移动爱家 App → 我的 → 云电脑 → 退订」，或拨打 10086 报方案编号；合约期内的终端/权益包需到营业厅解除。公示文案未给出该方案的单独退订条款。'
      : '公示文案未提供退订条款，办理时请向客服确认。'),
  };
}

/**
 * 资费浏览：面板「💰 资费」页用。只读本地快照，服务端过滤 + 分页。
 * kind：pc=云电脑 / phone=云手机 / 空=全部（按 name 里是否含"云手机"区分）
 */
function list(opts) {
  const db = load();
  const raw = opts || {};
  // 兼容 URLSearchParams（.get）与普通对象（直接取属性）——两者混用会让筛选静默失效
  const pick = (k) => (typeof raw.get === 'function' ? raw.get(k) : raw[k]);
  const o = { q: pick('q'), province: pick('province'), kind: pick('kind'), type: pick('type'), limit: pick('limit'), offset: pick('offset') };
  const q = String(o.q || '').trim().toLowerCase();
  const province = String(o.province || '').trim();
  const kind = String(o.kind || '').trim();
  const type = String(o.type || '').trim();
  let rows = db.plans || [];
  if (q) rows = rows.filter((p) => String(p.name).toLowerCase().indexOf(q) >= 0 || String(p.code || '').toLowerCase().indexOf(q) >= 0);
  if (province) rows = rows.filter((p) => String(p.province || '').indexOf(province) >= 0);
  if (type) rows = rows.filter((p) => String(p.type || '') === type);
  if (kind === 'pc') rows = rows.filter((p) => String(p.name).indexOf('云手机') < 0);
  if (kind === 'phone') rows = rows.filter((p) => String(p.name).indexOf('云手机') >= 0);
  const total = rows.length;
  const limit = Math.min(200, Math.max(10, Number(o.limit) || 50));
  const offset = Math.max(0, Number(o.offset) || 0);
  const page = rows.slice(offset, offset + limit).map((p) => ({
    name: p.name, price: p.price, type: p.type, code: p.code || '',
    province: p.province || '', validFrom: p.from || '', validTo: p.to || '',
    guide: guideOf(p, true),
  }));
  const provinces = Array.from(new Set((db.plans || []).map((p) => p.province).filter(Boolean))).sort();
  const types = Array.from(new Set((db.plans || []).map((p) => p.type).filter(Boolean))).sort();
  return {
    updated: db.raw ? db.raw.updated : '',
    source: db.raw ? db.raw.source : '',
    plans: (db.plans || []).length,
    total: total, limit: limit, offset: offset,
    items: page, provinces: provinces, types: types,
  };
}

/* ---------------- 号卡资费目录（本省全量：套餐 / 加装包 / 营销活动 / 流量包） ---------------- */

const CATALOG = process.env.TARIFF_CATALOG || '/data/tariff-catalog.json';
let catCache = { mtimeMs: 0, data: null };

function loadCatalog() {
  try {
    const st = fs.statSync(CATALOG);
    if (catCache.data && catCache.mtimeMs === st.mtimeMs) return catCache.data;
    const raw = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    const items = (Array.isArray(raw.items) ? raw.items : []).filter((p) => p && p.name);
    catCache = { mtimeMs: st.mtimeMs, data: { raw: raw, items: items } };
    return catCache.data;
  } catch (err) {
    return { raw: null, items: [], error: (err && (err.code || err.message)) || 'load failed' };
  }
}

/** 「是不是优惠」：营销活动一律算；价格 0 元 / 名字带减免、赠送、免费、赠送也算 */
function isPromo(p) {
  if (String(p.kind || '') === '营销活动') return true;
  const text = String(p.name || '') + ' ' + String(p.price || '');
  return /^0元|减免|赠送|免费|特惠|折扣|优惠/.test(String(p.price || '')) || /减免|赠送|免费|特惠|折扣|优惠|0元/.test(String(p.name || '')) || !!text && /^0元/.test(String(p.price || ''));
}

/**
 * 号卡资费浏览：面板「💰 资费」页第二个子页签。
 * province 支持「北京」「广东」「全网」；promo=1 只看优惠；kind=资费类型；sort=price|name|new
 */
function catalog(opts) {
  const db = loadCatalog();
  const raw = opts || {};
  const pick = (k) => (typeof raw.get === 'function' ? raw.get(k) : raw[k]);
  const q = String(pick('q') || '').trim().toLowerCase();
  const province = String(pick('province') || '').trim();
  const kind = String(pick('kind') || '').trim();
  const promo = String(pick('promo') || '') === '1';
  const only = String(pick('only') || '').trim();
  const sort = String(pick('sort') || 'price').trim();
  const limit = Math.min(200, Math.max(10, Number(pick('limit')) || 50));
  const offset = Math.max(0, Number(pick('offset')) || 0);

  let rows = db.items || [];
  if (q) rows = rows.filter((p) => (String(p.name) + ' ' + String(p.code || '') + ' ' + String(p.note || '') + ' ' + String(p.benefit || '')).toLowerCase().indexOf(q) >= 0);
  if (province) rows = rows.filter((p) => String(p.province || '').indexOf(province) >= 0);
  if (kind) rows = rows.filter((p) => String(p.kind || '') === kind);
  if (promo) rows = rows.filter((p) => isPromo(p));
  // only=plan：只要真正的在售主套餐（排除"XX活动/折扣/赠送"这类营销条目，否则按价格排序第一名永远是 0 元活动）
  if (only === 'plan') {
    rows = rows.filter((p) => String(p.kind || '') === '套餐' && !/活动|优惠|减免|赠送|折扣|礼包|抽奖|体验|特惠/.test(String(p.name || '')));
  }

  const num = (v) => { const m = String(v || '').match(/([0-9]+(?:\.[0-9]+)?)\s*元/); return m ? Number(m[1]) : Number.POSITIVE_INFINITY; };
  if (sort === 'price') rows = rows.slice().sort((a, b) => num(a.price) - num(b.price));
  else if (sort === 'name') rows = rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  else rows = rows.slice().sort((a, b) => String(b.from || '').localeCompare(String(a.from || '')));

  const total = rows.length;
  const items = rows.slice(offset, offset + limit).map((p) => ({
    name: p.name, price: p.price, kind: p.kind || '', code: p.code || '', province: p.province || '',
    validFrom: p.from || '', validTo: p.to || '', term: p.term || '',
    data: p.data || '', call: p.call || '', direct: p.direct || '', benefit: p.benefit || '',
    scope: p.scope || '', note: p.note || '', promo: isPromo(p), guide: guideOf(p, false),
  }));
  const all = db.items || [];
  const provinceSet = Array.from(new Set(all.map((p) => p.province).filter(Boolean)));
  const kindSet = Array.from(new Set(all.map((p) => p.kind).filter(Boolean))).sort();
  return {
    updated: db.raw ? db.raw.updated : '',
    source: db.raw ? db.raw.source : '',
    entries: all.length,
    promoCount: all.filter((p) => isPromo(p)).length,
    changes: db.raw && db.raw.changes ? db.raw.changes : null,
    history: db.raw && Array.isArray(db.raw.history) ? db.raw.history.slice(-20) : [],
    error: db.error || '',
    total: total, limit: limit, offset: offset, items: items,
    provinces: provinceSet, kinds: kindSet,
  };
}

module.exports = { load: load, match: match, parseName: parseName, priceOf: priceOf, list: list, catalog: catalog };
