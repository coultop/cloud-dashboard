'use strict';
/**
 * 抓取公开资费库（rdtscx/tariff，四家运营商官网公示价，GitHub Actions 每 2 小时更新），
 * 只留「云电脑 / 云手机」条目，落成面板用的紧凑快照。不联网时面板只读旧快照，功能不依赖它。
 *
 * 用法（容器内，写 /data 需要 root）：docker exec cloud-dashboard node /opt/tariff-sync.js
 */
const fs = require('fs');

const BASE = process.env.TARIFF_BASE || 'https://rdtscx.github.io/tariff';
const OUT = process.env.TARIFF_SNAPSHOT || '/data/tariff-snapshot.json';
const CONCURRENCY = Number(process.env.TARIFF_CONCURRENCY || 4);
const KEEP = /云电脑|云手机/;
// 号卡资费目录：本省全量条目（套餐/加装包/营销活动/流量包）。默认只存用户用得上的两个省 + 全网，
// 全存 31 省会是十几 MB，面板每次翻页都要扫一遍，不划算。改 env TARIFF_FULL_SECTIONS 可加。
const FULL_SECTIONS = String(process.env.TARIFF_FULL_SECTIONS || 'beijing,guangdong,quanguo')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CATALOG_OUT = process.env.TARIFF_CATALOG || '/data/tariff-catalog.json';
const TIMEOUT_MS = Number(process.env.TARIFF_TIMEOUT_MS || 60000);

async function getJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), {
      signal: ac.signal, headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function planKey(p) {
  return String(p.name || '') + '@' + String(p.province || '') + '#' + String(p.code || '');
}

/** 新增 / 下架 / 调价：键含方案编号，避免同名跨省串味 */
function diff(prevPlans, nextPlans) {
  if (!Array.isArray(prevPlans) || !prevPlans.length) return { at: Date.now(), first: true, added: [], removed: [], priceChanged: [] };
  const before = new Map(prevPlans.map((p) => [planKey(p), p]));
  const after = new Map(nextPlans.map((p) => [planKey(p), p]));
  const added = [];
  const removed = [];
  const priceChanged = [];
  for (const [k, p] of after) {
    const old = before.get(k);
    if (!old) { added.push({ name: p.name, price: p.price, province: p.province, code: p.code }); continue; }
    if (String(old.price || '') !== String(p.price || '')) {
      priceChanged.push({ name: p.name, province: p.province, code: p.code, from: old.price, to: p.price });
    }
  }
  for (const [k, p] of before) {
    if (!after.has(k)) removed.push({ name: p.name, price: p.price, province: p.province, code: p.code });
  }
  const cap = (arr) => arr.slice(0, 40);
  return { at: Date.now(), first: false, added: cap(added), removed: cap(removed), priceChanged: cap(priceChanged),
    counts: { added: added.length, removed: removed.length, priceChanged: priceChanged.length } };
}

async function pool(items, worker, limit) {
  const out = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

(async () => {
  const latest = await getJson(BASE + '/data/latest.json');
  const sections = Array.isArray(latest.sections) ? latest.sections : [];
  console.log('sections: ' + sections.length + ' ｜ 数据更新于 ' + (latest.updated || '-'));

  const plans = [];
  const catalog = [];
  const failed = [];
  let index = 0;
  await pool(sections, async (sec) => {
    const n = ++index;
    try {
      const d = await getJson(BASE + '/data/' + sec.section + '.json');
      let kept = 0;
      for (const item of Array.isArray(d.items) ? d.items : []) {
        const name = String(item && item.name || '').trim();
        if (!name || !KEEP.test(name)) continue;
        const f = (item && item.fields) || {};
        plans.push({
          name: name,
          price: String(f['资费标准'] || '').trim(),
          type: String(f['资费类型'] || '').trim(),
          code: String(f['方案编号'] || '').trim(),
          scope: String(f['归属'] || '').trim(),
          province: String(sec.name || ''),
          section: String(sec.section || ''),
          from: String(f['上线日期'] || '').trim(),
          to: String(f['下线日期'] || '').trim(),
        });
        kept += 1;
      }
      // 号卡目录：只对指定省份留全量（含套餐、加装包、营销活动），字段裁到"能不能办、多少钱、给什么"
      if (FULL_SECTIONS.indexOf(String(sec.section || '')) >= 0) {
        for (const item of Array.isArray(d.items) ? d.items : []) {
          const name = String(item && item.name || '').trim();
          if (!name) continue;
          const f = (item && item.fields) || {};
          const short = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max || 120);
          catalog.push({
            name: name,
            price: short(f['资费标准'], 40),
            kind: short(f['资费类型'], 20),
            code: short(f['方案编号'], 32),
            province: String(sec.name || ''),
            from: short(f['上线日期'], 24),
            to: short(f['下线日期'], 24),
            term: short(f['有效期限'], 60),
            data: short(f['国内通用流量'], 24),
            call: short(f['国内通话'], 24),
            direct: short(f['定向流量'], 24),
            benefit: short(f['权益'], 40),
            scope: short(f['适用范围'], 60),
            note: short(f['其他服务内容'], 420),
          });
        }
      }
      console.log('  [' + n + '/' + sections.length + '] ' + sec.name + ' 命中 ' + kept);
    } catch (err) {
      failed.push(sec.section + ': ' + err.message);
      console.log('  [' + n + '/' + sections.length + '] ' + sec.name + ' 失败 ' + err.message);
    }
  }, CONCURRENCY);

  // 与上一份快照比对：只关心"我们关心的商品"新增/下架/调价，供面板提示
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (err) { prev = null; }
  const changes = diff(prev && prev.plans, plans);

  const snapshot = {
    updated: latest.updated || '',
    fetchedAt: Date.now(),
    source: BASE + '/',
    sections: sections.length - failed.length,
    failed: failed,
    changes: changes,
    plans: plans,
  };
  fs.writeFileSync(OUT, JSON.stringify(snapshot));

  // 号卡目录快照 + 与上一份比对（新增/下架/调价 = "有新优惠或旧优惠结束"）
  let prevCatalog = null;
  try { prevCatalog = JSON.parse(fs.readFileSync(CATALOG_OUT, 'utf8')); } catch (err) { prevCatalog = null; }
  const catalogChanges = diff(prevCatalog && prevCatalog.items, catalog);
  // 变更留档：单次同步会覆盖 changes，用户两小时后才来看就丢了；留最近 20 批，页面取最近一次非空
  const prevHistory = (prevCatalog && Array.isArray(prevCatalog.history)) ? prevCatalog.history : [];
  const history = prevHistory.concat([catalogChanges]).slice(-20);
  const catalogSnap = {
    updated: latest.updated || '',
    fetchedAt: Date.now(),
    source: BASE + '/',
    provinces: Array.from(new Set(catalog.map((c) => c.province))),
    changes: catalogChanges,
    history: history,
    items: catalog,
  };
  fs.writeFileSync(CATALOG_OUT, JSON.stringify(catalogSnap));
  const cc = catalogChanges.counts;
  console.log('写入 ' + CATALOG_OUT + '：' + catalog.length + ' 条，' + Math.round(JSON.stringify(catalogSnap).length / 1024) + ' KB' +
    (cc ? ('；号卡较上次 新增 ' + cc.added + ' / 下架 ' + cc.removed + ' / 调价 ' + cc.priceChanged) : '；号卡首次快照'));

  const c = snapshot.changes.counts;
  console.log('写入 ' + OUT + '：' + plans.length + ' 条，' + Math.round(JSON.stringify(snapshot).length / 1024) + ' KB' +
    (c ? ('；较上次 新增 ' + c.added + ' / 下架 ' + c.removed + ' / 调价 ' + c.priceChanged) : '；首次快照，无基线可比'));
})().catch((err) => { console.error('同步失败: ' + err.message); process.exit(1); });
