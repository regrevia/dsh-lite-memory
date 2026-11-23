/**
 * 300 条加难样本的召回报表：只读，不进 test 链，不改检索行为。
 * 与 bench/recall-quality.mjs 的分工：那份量的是 39 条回归样本（已饱和），
 * 这份量的是换说法、近邻负例、跨项目、条件未知、新旧换代五类硬样本，用来量出差距。
 * 任何比例都带 N 与 95% 置信区间（Wilson）；0 命中时报的是上界。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-hard-'));
const view = await import('../view.js');
const {
  HARD_ALL, HARD_RECALL, HARD_REJECT, HARD_AWAIT, HARD_CROSS, HARD_UPDATE, HARD_COUNTS,
} = await import('../test/recall-eval-hard.mjs');

const titleOf = new Map(HARD_ALL.map((record) => [record.id, record.title]));
const idsOf = (query, context = {}, limit = 3) => view.rank(HARD_ALL, query, { limit, requireApplicable: true, context }).map((row) => row.record.id);
const delivered = (query, context = {}) => {
  const rows = view.rank(HARD_ALL, query, { limit: 12, requireApplicable: true, context });
  const bundle = view.selectCards(rows.map((row) => row.record), {});
  return { ids: rows.map((row) => row.record.id), titles: bundle.cards.map((card) => card.title), bytes: bundle.bytes };
};

const wilson = (k, n) => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
};
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const rate = (k, n) => {
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} = ${pct(k / n)}（95% CI ${pct(lo)}–${pct(hi)}）`;
};
const percentile = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

const timings = [];
const failures = [];
const rows = [];
/** 失败分成「词面根本对不上」和「词面对上了但没排进来」：前者是词面检索的能力边界，后者才是可修的排序/阈值问题。 */
const bigrams = (text) => {
  const plainText = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < plainText.length - 1; i += 1) set.add(plainText.slice(i, i + 2));
  return set;
};
const lexical = (query, id) => {
  const record = HARD_ALL.find((item) => item.id === id);
  const pool = bigrams([record.title, (record.aliases || []).join(' '), (record.tags || []).join(' '), (record.triggers || []).join(' '), record.summary].join(' '));
  let shared = 0;
  for (const gram of bigrams(query)) if (pool.has(gram)) shared += 1;
  return shared;
};
const classify = (query, want) => (want && lexical(query, want) === 0 ? '词面无重合' : '词面有重合未召回');

let hit = 0, hitTotal = 0;
for (const [query, want] of HARD_RECALL) {
  timings.push(time(() => idsOf(query)));
  const got = idsOf(query);
  const at = got.indexOf(want);
  if (at >= 0) { hit += 1; hitTotal += 1 / (at + 1); }
  if (at < 0) failures.push({ group: classify(query, want), query, want: titleOf.get(want), got: got.map((id) => titleOf.get(id)) });
  rows.push({ group: '该召回', query, ok: at >= 0 });
}
const recallAt3 = hit / HARD_RECALL.length;
const mrr = hitTotal / HARD_RECALL.length;

let injected = 0, injectedBytes = 0;
for (const query of HARD_REJECT) {
  timings.push(time(() => idsOf(query)));
  const got = delivered(query);
  if (got.ids.length > 0) { injected += 1; injectedBytes += got.bytes; }
  if (got.ids.length > 0) failures.push({ group: '该拒绝', query, got: got.titles });
  rows.push({ group: '该拒绝', query, ok: got.ids.length === 0 });
}
const falseInjection = injected / HARD_REJECT.length;

let leaked = 0, other = 0;
for (const [query, want] of HARD_AWAIT) {
  timings.push(time(() => idsOf(query)));
  const got = delivered(query);
  if (got.ids.includes(want)) { leaked += 1; failures.push({ group: '该等条件', query, want: titleOf.get(want), got: got.titles }); }
  else if (got.ids.length > 0) other += 1;
  rows.push({ group: '该等条件', query, ok: !got.ids.includes(want) });
}
const abstain = (HARD_AWAIT.length - leaked) / HARD_AWAIT.length;

let crossLeak = 0, crossDelivered = 0;
const beta = { projectRoot: '/work/beta' };
for (const [query, want] of HARD_CROSS) {
  timings.push(time(() => idsOf(query, beta)));
  const got = delivered(query, beta);
  if (got.ids.length > 0) crossDelivered += 1;
  if (got.ids.includes(want) || got.ids.some((id) => id.startsWith('a'))) { crossLeak += 1; failures.push({ group: '跨项目', query, want: titleOf.get(want), got: got.titles }); }
  rows.push({ group: '跨项目', query, ok: !got.ids.some((id) => id.startsWith('a')) });
}
const crossLeakRate = crossLeak / HARD_CROSS.length;

let updateOk = 0, oldShown = 0;
for (const [query, wantNew, wantOld] of HARD_UPDATE) {
  timings.push(time(() => idsOf(query)));
  const got = delivered(query);
  const hasNew = got.ids.includes(wantNew);
  const hasOld = got.ids.includes(wantOld);
  if (hasOld) oldShown += 1;
  if (hasNew && !hasOld) updateOk += 1;
  if (!(hasNew && !hasOld)) failures.push({ group: '新旧换代', query, want: titleOf.get(wantNew), got: got.titles });
  rows.push({ group: '新旧换代', query, ok: hasNew && !hasOld });
}
const updateAccuracy = updateOk / HARD_UPDATE.length;

const report = {
  corpus: { ...HARD_COUNTS },
  recallAt3: { value: recallAt3, ci: wilson(hit, HARD_RECALL.length) },
  mrrAt3: mrr,
  falseInjection: { value: falseInjection, ci: wilson(injected, HARD_REJECT.length) },
  abstainAccuracy: { value: abstain, ci: wilson(HARD_AWAIT.length - leaked, HARD_AWAIT.length) },
  crossProjectLeak: { value: crossLeakRate, ci: wilson(crossLeak, HARD_CROSS.length), deliveredAnyway: crossDelivered },
  updateAccuracy: { value: updateAccuracy, ci: wilson(updateOk, HARD_UPDATE.length) },
  awaitOtherDelivery: other,
  latencyMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95), max: Math.max(...timings) },
  failures: failures.length,
  failureMix: failures.reduce((out, item) => {
    out[item.group] = (out[item.group] || 0) + 1;
    return out;
  }, {}),
};
console.log(JSON.stringify(report));
console.log('');
console.log(`样本：${HARD_COUNTS.memories} 条记忆 / ${HARD_COUNTS.queries} 条查询`);
console.log(`Recall@3      ${rate(hit, HARD_RECALL.length)}   MRR@3 ${mrr.toFixed(3)}`);
console.log(`误注入率      ${rate(injected, HARD_REJECT.length)}`);
console.log(`条件未确认投递 ${rate(leaked, HARD_AWAIT.length)}  （另有投递 ${other} 条）`);
console.log(`跨项目泄漏    ${rate(crossLeak, HARD_CROSS.length)}  （无泄漏但投了别的 ${crossDelivered} 条）`);
console.log(`换代更新准确率 ${rate(updateOk, HARD_UPDATE.length)}  （旧版本被投递 ${oldShown} 条）`);
console.log(`条数：该召回 ${HARD_RECALL.length} / 该拒绝 ${HARD_REJECT.length} / 该等条件 ${HARD_AWAIT.length} / 跨项目 ${HARD_CROSS.length} / 换代 ${HARD_UPDATE.length}`);
console.log(`耗时：P50 ${percentile(timings, 0.5).toFixed(2)} ms / P95 ${percentile(timings, 0.95).toFixed(2)} ms / max ${Math.max(...timings).toFixed(2)} ms`);
console.log('');
for (const failure of failures.slice(0, 40)) console.log(`✗ ${failure.group}  ${failure.query}  →  ${JSON.stringify(failure.got)}${failure.want ? `（应为「${failure.want}」）` : ''}`);
if (failures.length > 40) console.log(`…… 另有 ${failures.length - 40} 条，见 JSON`);
