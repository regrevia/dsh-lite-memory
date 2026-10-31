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

import { CARD, recallCards, recallRank } from './view.js';

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

/** 把任意 JSON 值折成与键序无关的稳定形状，摘要才不会被对象键序左右。 */
function stableOf(value) {
  if (Array.isArray(value)) return value.map(stableOf);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().map((key) => [key, stableOf(value[key])]);
  }
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 一条记忆里所有会影响评测的字段；顺序无意义的列表先排序，避免假变更。 */
function digestRecord(record) {
  const row = record && typeof record === 'object' ? record : {};
  const list = (value) => (Array.isArray(value) ? value : []).map((item) => String(item)).sort();
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    summary: String(row.summary || ''),
    when: String(row.when || ''),
    body: String(row.body || ''),
    kind: String(row.kind || ''),
    status: String(row.status || ''),
    applicability: String(row.applicability || ''),
    aliases: list(row.aliases),
    tags: list(row.tags),
    triggers: list(row.triggers),
    conditions: stableOf(row.conditions),
  };
}

/**
 * 回放集的摘要覆盖全部影响评测的输入：答题卡（查询/期望/禁止/上下文）、
 * 每条记忆的完整内容（正文、when、条件、触发词、标签、状态、适用性），以及当前参数。
 * 任何一处变了摘要就变，才谈得上「同一批题」。
 */
export function replayDigestOf(cases, params = DEFAULT_PARAMS) {
  const rows = (Array.isArray(cases) ? cases : []).map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    return {
      id: String(row.id || ''),
      query: String(row.query || ''),
      expect: (Array.isArray(row.expectIds) ? row.expectIds : []).map(String).sort(),
      forbid: (Array.isArray(row.forbidIds) ? row.forbidIds : []).map(String).sort(),
      context: stableOf(row.context && typeof row.context === 'object' ? row.context : {}),
      records: (Array.isArray(row.records) ? row.records : []).map(digestRecord),
    };
  });
  /** 参数也进摘要：同一批题换了参数，评测结果就不再可比。 */
  const payload = { params: normalizeParams(params), rows };
  /** 摘要是定长哈希：完整快照留在 replay.records 里，不能把摘要当正文写进文件。 */
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * 一条用例按参数跑一次：拿到前三与卡片字节成本，只回报答卡需要的数字。
 * 与生产召回的保留差异（有意，回放只求两轮可比）：
 * - 冻结快照里没有 runtime，重建不了 runtime 分支的资格门槛，只按 context 判适用性；
 * - 快照不带 scopeName，项目卡片标签的字节恢复不出来，卡片字节按全局形态计。
 */
export function runCase(item, params) {
  const records = (Array.isArray(item && item.records) ? item.records : []).slice(0, LIMITS.maxRecords);
  const task = item && item.task && typeof item.task === 'object' ? item.task : undefined;
  /** 与生产召回同一个排序入口：同样的适用性门槛、同样的参数，回放名次才可比。 */
  const rows = recallRank(records, String(item && item.query ? item.query : ''), {
    limit: LIMITS.topN,
    params: normalizeParams(params),
    context: item && item.context && typeof item.context === 'object' ? item.context : {},
    task,
  });
  const top = rows.slice(0, LIMITS.topN);
  /** 候选=排进前三的；真正给到模型的还要过装箱这一道闸。 */
  const candidateIds = top.map((row) => String(row.record.id));
  const expectIds = (Array.isArray(item && item.expectIds) ? item.expectIds : []).map(String);
  const forbidIds = (Array.isArray(item && item.forbidIds) ? item.forbidIds : []).map(String);
  /** 卡片字节也走生产那套「按最终渲染行计费」，不再拿内存对象估个近似值。 */
  const cards = recallCards(top, { max: CARD.max, bytes: CARD.bytes });
  const delivered = new Set(cards.cards.map((card) => String(card.id)));
  const deliveredIds = candidateIds.filter((id) => delivered.has(id));
  const budgetDropped = candidateIds.filter((id) => !delivered.has(id));
  /** 成绩只认最终投递：被预算淘汰的条目模型看不到，不能算命中。 */
  let position = 0;
  for (const id of expectIds) {
    const index = deliveredIds.indexOf(id);
    position += index === -1 ? LIMITS.topN + 1 : index + 1;
  }
  return {
    hit: expectIds.filter((id) => deliveredIds.includes(id)).length,
    expect: expectIds.length,
    position,
    falseHit: forbidIds.filter((id) => deliveredIds.includes(id)).length,
    bytes: cards.bytes,
    topIds: candidateIds,
    candidateIds,
    deliveredIds,
    budgetDropped,
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

/**
 * 沿着策略时间线单向往回找一组生效过的参数。
 * cursor 是下一次回滚的扫描上界（历史里已经走到哪）；只往回走、不写历史，
 * 所以「回滚过的档位」不会被下一次回滚又装回来。
 */
export function rollbackTarget(history = [], current = DEFAULT_PARAMS, cursor = null) {
  const rows = Array.isArray(history) ? history : [];
  const start = Number.isInteger(cursor) ? Math.min(Math.max(cursor, 0), rows.length) : rows.length;
  const now = normalizeParams(current);
  for (let index = start - 1; index >= 0; index -= 1) {
    const row = rows[index] && typeof rows[index] === 'object' ? rows[index] : {};
    const from = row.from && typeof row.from === 'object' ? row.from : row.to;
    const params = normalizeParams(from || {});
    if (sameParams(params, now)) continue;
    return { params, cursor: index, at: String(row.at || '') };
  }
  return null;
}
