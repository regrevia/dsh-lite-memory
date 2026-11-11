/**
 * 纯召回规模基准：只在内存里放 N 条记忆，量 `view.rank` 一次召回耗时（毫秒）。
 * 和 bench/bench.mjs 的端到端数字（含读盘、归档闸门、pre-step 全流程）分开记，
 * 两个数不能混在一起当同一个目标。只读、不写盘、不联网、不调用模型。
 *
 *   node bench/scale.mjs                 400 / 1000 / 2000 / 5000 各跑一遍
 *   LITE_MEMORY_SCALE=2000 node bench/scale.mjs   只跑一档；LITE_MEMORY_SCALE_REPS 调重复次数（默认 3）
 */
import { MEM, RECALL, AWAIT } from '../test/recall-eval-fixtures.mjs';
import * as view from '../view.js';

const base = (extra) => ({
  status: 'active', applicability: 'all_in_scope', conditions: [], selection: null,
  aliases: [], tags: [], triggers: [], when: '', lastUsed: '', ...extra,
});

/** 填充条目用互不相同的词，避免把冻结样本的命中率稀释掉，也避免生成时撞词。 */
const filler = (i) => base({
  id: `mem_fill_${String(i).padStart(6, '0')}`,
  title: `填充分区 ${i} 的例行流程`,
  summary: `第 ${i} 号填充分区的常规做法`,
  when: `场景 ${i}`,
  body: `填充正文 ${i}`,
});

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

const sizes = process.env.LITE_MEMORY_SCALE
  ? [Math.max(1, Number(process.env.LITE_MEMORY_SCALE) || 0)]
  : [400, 1000, 2000, 5000];
const queries = [...RECALL.map(([query]) => query), ...AWAIT.map(([query]) => query)];
const reps = Math.max(1, Number(process.env.LITE_MEMORY_SCALE_REPS || 3) || 3);
const report = { node: process.version, platform: `${process.platform}/${process.arch}`, queries: queries.length, sizes: [] };

for (const size of sizes) {
  const records = [...MEM];
  for (let i = records.length; i < size; i += 1) records.push(filler(i));
  const timings = [];
  let bytes = 0;
  let hits = 0;
  let cards = 0;
  for (const query of queries) {
    let rows = [];
    for (let rep = 0; rep < reps; rep += 1) {
      const t = process.hrtime.bigint();
      rows = view.rank(records, query, { limit: 3, requireApplicable: true, context: {} });
      timings.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    hits += rows.length;
    const pack = view.selectCards(rows.map((row) => row.record), { max: 3, bytes: view.CARD.bytes });
    bytes += pack.bytes;
    cards += pack.cards.length;
  }
  report.sizes.push({
    records: records.length,
    runs: timings.length,
    p50: Math.round(pct(timings, 50) * 100) / 100,
    p95: Math.round(pct(timings, 95) * 100) / 100,
    max: Math.round(Math.max(...timings) * 100) / 100,
    avgCards: Math.round((cards / queries.length) * 100) / 100,
    avgHits: Math.round((hits / queries.length) * 100) / 100,
    avgBytes: Math.round(bytes / queries.length),
  });
}

console.log(JSON.stringify(report, null, 2));
