/**
 * 受限自进化：只调白名单里的检索参数，一回合只动一处，先过冻结回放集才准上。
 *
 * 设计边界（有意保守）：
 * - 参数是闭集，每一步只走相邻一档；不做梯度、不搜连续空间、不生成新规则。
 * - 回放集一旦冻结就带摘要；摘要对不上直接拒绝，避免「用新样本证明旧改动」。
 * - 只认真实漏报/误报的两类结果：该进前三的没进（漏）、不该出现的出现了（误）。
 * - 任何一条用例变差就不采纳；平手也不采纳，避免无收益漂移。
 * - 每次采纳都留参数差异与指标，可一键回滚；历史有上限，不会无限长。
 */
import { createHash } from 'node:crypto';

import { CARD, rank, selectCards } from './view.js';

export const EVOLVE_VERSION = 1;

/** 白名单参数与离散档位：每档之间一次只走一格。 */
export const PARAM_SPACE = {
  floor: [2.0, 2.2, 2.4, 2.6],
  summaryWeight: [1.0, 1.5, 2.5],
};

export const DEFAULT_PARAMS = { floor: 2.4, summaryWeight: 1.5 };

export const LIMITS = {
  maxCases: 24,
  maxHistory: 12,
  topN: 3,
  /** 单次回放最多扫这么多条记录，防止把大库整盘读进内存。 */
  maxRecords: 400,
};

export function normalizeParams(input = {}) {
  const out = { ...DEFAULT_PARAMS };
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    const value = input && input[key];
    if (Number.isFinite(value) && PARAM_SPACE[key].includes(value)) out[key] = value;
  }
  return out;
}

export function sameParams(a, b) {
  return Object.keys(DEFAULT_PARAMS).every((key) => normalizeParams(a)[key] === normalizeParams(b)[key]);
}

/**
 * 回放集的摘要只覆盖「答题卡」：记录 id/标题/摘要/条件与查询、期望 id。
 * 用例顺序也算：摘要一致意味着这一轮和上一轮看的是同一批题。
 */
export function replayDigestOf(cases) {
  const rows = (Array.isArray(cases) ? cases : []).map((item) => ({
    id: String(item && item.id ? item.id : ''),
    query: String(item && item.query ? item.query : ''),
    expect: (Array.isArray(item && item.expectIds) ? item.expectIds : []).map(String).sort(),
    forbid: (Array.isArray(item && item.forbidIds) ? item.forbidIds : []).map(String).sort(),
    records: (Array.isArray(item && item.records) ? item.records : []).map((record) => ({
      id: String(record && record.id ? record.id : ''),
      title: String(record && record.title ? record.title : ''),
      summary: String(record && record.summary ? record.summary : ''),
      when: String(record && record.when ? record.when : ''),
      aliases: (Array.isArray(record && record.aliases) ? record.aliases : []).map(String),
    })),
  }));
  /** 摘要是定长哈希：完整快照留在 replay.records 里，不能把摘要当正文写进文件。 */
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** 一条用例按参数跑一次：拿到前三与卡片字节成本，只回报答卡需要的数字。 */
export function runCase(item, params) {
  const records = (Array.isArray(item && item.records) ? item.records : []).slice(0, LIMITS.maxRecords);
  const rows = rank(records, String(item && item.query ? item.query : ''), {
    limit: LIMITS.topN,
    params: normalizeParams(params),
    task: item && item.task && typeof item.task === 'object' ? item.task : undefined,
  });
  const top = rows.slice(0, LIMITS.topN);
  const topIds = top.map((row) => String(row.record.id));
  const expectIds = (Array.isArray(item && item.expectIds) ? item.expectIds : []).map(String);
  const forbidIds = (Array.isArray(item && item.forbidIds) ? item.forbidIds : []).map(String);
  const cards = selectCards(top.map((row) => ({
    ...row.record,
    score: row.score,
    hints: row.hints,
    status: row.status,
    sameTask: row.sameTask,
    raw: row.raw,
  })), { maxItems: CARD.max, maxBytes: CARD.bytes });
  /** 位置分：期望项排第几就记几，没进前三记 topN+1；越小越好。 */
  let position = 0;
  for (const id of expectIds) {
    const index = topIds.indexOf(id);
    position += index === -1 ? LIMITS.topN + 1 : index + 1;
  }
  return {
    hit: expectIds.filter((id) => topIds.includes(id)).length,
    expect: expectIds.length,
    position,
    falseHit: forbidIds.filter((id) => topIds.includes(id)).length,
    bytes: cards.bytes,
    topIds,
  };
}

/** 整批回放：逐条跑、汇总，并把逐条结果留下来给「哪条变差」用。 */
export function replay(cases, params) {
  const rows = [];
  let hit = 0;
  let expect = 0;
  let position = 0;
  let falseHit = 0;
  let bytes = 0;
  for (const item of Array.isArray(cases) ? cases.slice(0, LIMITS.maxCases) : []) {
    const result = runCase(item, params);
    hit += result.hit;
    expect += result.expect;
    position += result.position;
    falseHit += result.falseHit;
    bytes += result.bytes;
    rows.push({ id: String(item && item.id ? item.id : ''), ...result });
  }
  return { cases: rows.length, hit, expect, position, falseHit, bytes, rows };
}

/** 比较两轮结果：没有一条变差、且至少一条严格变好，才算进步。 */
export function compareReplay(before, after) {
  const regressed = [];
  const improved = [];
  const beforeRows = new Map((before.rows || []).map((row) => [row.id, row]));
  for (const row of after.rows || []) {
    const prev = beforeRows.get(row.id);
    if (!prev) continue;
    if (row.hit < prev.hit || row.falseHit > prev.falseHit || row.position > prev.position) regressed.push(row.id);
    else if (row.hit > prev.hit || row.falseHit < prev.falseHit || row.position < prev.position) improved.push(row.id);
  }
  if (after.falseHit > before.falseHit) regressed.push('*false');
  if (after.hit < before.hit) regressed.push('*hit');
  if (after.position > before.position) regressed.push('*position');
  return { ok: regressed.length === 0 && improved.length > 0, regressed, improved };
}

/**
 * 提一个最小改动：只走一档，一次永远只动一个参数。
 * 先按「误报更少 → 漏报更少 → 字节更省」排序，再按档位距离近的优先，避免大跳。
 */
export function proposeChange(cases, current) {
  const base = normalizeParams(current);
  const baseline = replay(cases, base);
  const candidates = [];
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    const space = PARAM_SPACE[key];
    const index = space.indexOf(base[key]);
    for (const next of [space[index - 1], space[index + 1]]) {
      if (!Number.isFinite(next)) continue;
      const params = { ...base, [key]: next };
      const result = replay(cases, params);
      const verdict = compareReplay(baseline, result);
      if (!verdict.ok) continue;
      candidates.push({
        key,
        from: base[key],
        to: next,
        params,
        metrics: { hit: result.hit, expect: result.expect, position: result.position, falseHit: result.falseHit, bytes: result.bytes },
        improved: verdict.improved,
      });
    }
  }
  candidates.sort((a, b) => (a.metrics.falseHit - b.metrics.falseHit)
    || (b.metrics.hit - a.metrics.hit)
    || (a.metrics.position - b.metrics.position)
    || (a.metrics.bytes - b.metrics.bytes)
    || (Math.abs(a.to - a.from) - Math.abs(b.to - b.from))
    || String(a.key).localeCompare(String(b.key)));
  return { baseline, proposal: candidates[0] || null, tried: candidates.length };
}

/** 回滚只要把上一轮的参数取回来；历史里找最近一条有 from 的记录。 */
export function rollbackTarget(history = []) {
  const rows = Array.isArray(history) ? history.filter((row) => row && row.from) : [];
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return { params: normalizeParams(last.from), index: rows.length - 1, at: String(last.at || '') };
}
