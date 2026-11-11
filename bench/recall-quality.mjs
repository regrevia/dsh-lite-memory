/**
 * 39 条冻结样本的召回质量报表：只读，不改检索行为，不进 test 链。
 * 数字口径与 test/eval-seed.test.mjs 相同（同一份样本、同一套 rank 选项），
 * 区别是这里报「多少」，测试只报「过不过」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-rq-'));
const view = await import('../view.js');
const evolve = await import('../evolve.js');
const { MEM, RECALL, REJECT, AWAIT } = await import('../test/recall-eval-fixtures.mjs');

const titleOf = (row) => row.record.title;
const rank = (query, context = {}) => view.rank(MEM, query, { limit: 3, requireApplicable: true, context });
const delivered = (query, context = {}) => {
  const rows = view.rank(MEM, query, { limit: 12, requireApplicable: true, context });
  const bundle = view.selectCards(rows.map((row) => row.record), {});
  return { titles: bundle.cards.map((card) => card.title), bytes: bundle.bytes };
};

const percentile = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

const rows = [];
const timings = [];
const bytesList = [];

let hit = 0;
let mrr = 0;
for (const [query, want] of RECALL) {
  timings.push(time(() => rank(query)));
  const found = rank(query).map(titleOf);
  const at = found.indexOf(want);
  if (at >= 0) hit += 1;
  if (at >= 0) mrr += 1 / (at + 1);
  rows.push({ group: '该召回', query, want, got: found, ok: at >= 0 });
}
const recallAt3 = hit / RECALL.length;

let injected = 0;
for (const query of REJECT) {
  timings.push(time(() => rank(query)));
  const got = delivered(query).titles;
  if (got.length > 0) injected += 1;
  rows.push({ group: '该拒绝', query, want: '', got, ok: got.length === 0 });
}
const falseInjection = injected / REJECT.length;

let leaked = 0;
let other = 0;
for (const [query, want] of AWAIT) {
  timings.push(time(() => rank(query)));
  const got = delivered(query).titles;
  /** 口径同 test/eval-seed：未确认条件的那条不能出现；别的条目允许出现，单列计数。 */
  const exposed = got.includes(want);
  if (exposed) leaked += 1;
  else if (got.length > 0) other += 1;
  rows.push({ group: '该等条件', query, want, got, ok: !exposed });
}
const abstainAccuracy = (AWAIT.length - leaked) / AWAIT.length;

for (const [query] of RECALL) {
  const result = delivered(query);
  if (result.titles.length > 0) bytesList.push(result.bytes);
}
const avgBytes = bytesList.length ? Math.round(bytesList.reduce((a, b) => a + b, 0) / bytesList.length) : 0;

const print = (label, value) => console.log(`${label.padEnd(18, ' ')} ${value}`);
/**
 * 阈值档位对照：只量不采纳。自进化只能在白名单档位里走一格，
 * 这里把整张档位表放到同一批冻结样本上跑一遍，看「调阈值到底有没有用」。
 */
const grid = [];
for (const floor of evolve.PARAM_SPACE.floor) {
  for (const summaryWeight of evolve.PARAM_SPACE.summaryWeight) {
    const params = { floor, summaryWeight };
    let gHit = 0;
    let gMrr = 0;
    for (const [query, want] of RECALL) {
      const found = view.rank(MEM, query, { limit: 3, requireApplicable: true, context: {}, params }).map(titleOf);
      const at = found.indexOf(want);
      if (at >= 0) { gHit += 1; gMrr += 1 / (at + 1); }
    }
    let gLeak = 0;
    for (const query of AWAIT) {
      const got = view.selectCards(view.rank(MEM, query, { limit: 12, requireApplicable: true, context: {}, params }).map((row) => row.record), {}).cards;
      if (got.length > 0) gLeak += 1;
    }
    grid.push({ floor, summaryWeight, recallAt3: +(gHit / RECALL.length).toFixed(3), mrr: +(gMrr / RECALL.length).toFixed(3), awaitLeak: gLeak });
  }
}

console.log(`样本 ${MEM.length} 条记忆，${RECALL.length + REJECT.length + AWAIT.length} 条查询（该召回 ${RECALL.length} / 该拒绝 ${REJECT.length} / 该等条件 ${AWAIT.length}）`);
print('Recall@3', recallAt3.toFixed(3));
print('MRR@3', (mrr / RECALL.length).toFixed(3));
print('误注入率', falseInjection.toFixed(3));
print('拒答准确率', abstainAccuracy.toFixed(3));
print('  其中另有投递', `${other} 条（不违规，只记录）`);
print('平均注入字节', `${avgBytes} B`);
print('--- 阈值档位对照（只量不采纳）---');
for (const row of grid) {
  const mark = row.floor === evolve.DEFAULT_PARAMS.floor && row.summaryWeight === evolve.DEFAULT_PARAMS.summaryWeight ? ' ← 现行' : '';
  print(`${row.floor}/${row.summaryWeight}`, `Recall@3 ${row.recallAt3.toFixed(3)} · MRR@3 ${row.mrr.toFixed(3)} · 未知条件自动投递 ${row.awaitLeak}${mark}`);
}
print('P50 / P95', `${percentile(timings, 0.5).toFixed(2)} / ${percentile(timings, 0.95).toFixed(2)} ms`);

const wrong = rows.filter((row) => !row.ok);
if (wrong.length) {
  console.log('\n没过的样本：');
  for (const row of wrong) {
    console.log(`  [${row.group}] ${row.query}`);
    console.log(`    期望：${row.want || '不出现'}；实得：${row.got.join(' / ') || '空'}`);
  }
}

const failed = recallAt3 < 0.9 || falseInjection > 0 || leaked > 0;
console.log(failed ? '\nrecall-quality: 未达标（Recall@3 ≥ 0.9、误注入 0、条件未知不投递）' : '\nrecall-quality: 达标');
process.exit(failed ? 1 : 0);
