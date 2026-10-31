/**
 * 自进化实验室的持久层：每个项目层一份 evolve.json。
 *
 * 存的东西只有三样：冻结的回放集（含摘要）、当前参数、改动历史。
 * 没有后台任务、没有定时器；所有读写都是同步小文件，调用方自己兜异常。
 * 文件坏了就当没做过实验，重新冻结一份即可，绝不覆盖用户记忆。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as evolve from './evolve.js';
import { memoryRoot } from './state.js';

export const EVOLVE_SCHEMA_VERSION = 1;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_HISTORY = evolve.LIMITS.maxHistory;

/** 摘要算法版本：从 2 起覆盖正文/条件/触发词/参数；旧文件读到时按新算法重算一次。 */
const REPLAY_DIGEST_VERSION = 2;

const fileOf = (scope) => {
  const dir = scope && scope.dir ? scope.dir : path.join(memoryRoot(), 'global');
  return path.join(dir, 'evolve.json');
};

export function emptyEvolve() {
  return {
    version: EVOLVE_SCHEMA_VERSION,
    revision: 1,
    /** 快照放一次，多道题共用：60 条记忆不再按题复制，24 道题也不会把文件撑爆。 */
    replay: {
      digest: '',
      digestVersion: REPLAY_DIGEST_VERSION,
      frozenAt: '',
      records: [],
      cases: [],
      /** 证据集版本：只有回放集（题目或快照）变了才 +1。 */
      evidenceRevision: 0,
      /** 落盘时裁剪过数据，或换了新一批题：当前参数还没在这份数据上评测过。 */
      needsReeval: false,
    },
    params: { ...evolve.DEFAULT_PARAMS },
    /** 生效策略版本与策略时间线游标，和证据集版本各走各的。 */
    policy: { revision: 0, cursor: 0 },
    history: [],
    lastRunAt: '',
  };
}

const idOf = (row) => String((row && row.id) || '');
const isHexDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

const normalizeHistoryRow = (item) => {
  const row = item && typeof item === 'object' ? item : {};
  return {
    at: String(row.at || ''),
    key: String(row.key || ''),
    from: row.from && typeof row.from === 'object' ? { ...row.from } : null,
    to: row.to && typeof row.to === 'object' ? { ...row.to } : null,
    metrics: row.metrics || null,
    improved: Array.isArray(row.improved) ? row.improved.slice(0, evolve.LIMITS.maxCases) : [],
    digest: String(row.digest || ''),
  };
};

function normalize(input) {
  const base = emptyEvolve();
  if (!input || typeof input !== 'object') return base;
  const replay = input.replay && typeof input.replay === 'object' ? input.replay : {};
  const rawRecords = Array.isArray(replay.records) ? replay.records : [];
  const records = rawRecords.slice(0, evolve.LIMITS.maxRecords).map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    return { ...row, id: idOf(row) };
  });
  const rawCases = Array.isArray(replay.cases) ? replay.cases : [];
  const cases = rawCases.slice(0, evolve.LIMITS.maxCases).map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    const out = {
      id: String(row.id || ''),
      query: String(row.query || ''),
      expectIds: (Array.isArray(row.expectIds) ? row.expectIds : []).map(String),
      forbidIds: (Array.isArray(row.forbidIds) ? row.forbidIds : []).map(String),
      context: row.context && typeof row.context === 'object'
        ? { taskKind: String(row.context.taskKind || '').slice(0, 40) } : undefined,
    };
    /** 快照已经在顶层就不再逐题存一份；老文件没有顶层快照时原样保留。 */
    if (!records.length && Array.isArray(row.records)) out.records = row.records.slice(0, evolve.LIMITS.maxRecords);
    return out;
  });
  const legacyDigest = typeof replay.digest === 'string' && replay.digest.startsWith('[');
  const legacyPolicy = !input.policy || typeof input.policy !== 'object';
  let history = (Array.isArray(input.history) ? input.history : []).slice(-MAX_HISTORY).map(normalizeHistoryRow);
  /** 旧版把回滚也当一条改动写进历史；迁移时剔除，否则回滚会沿着这些行来回弹。 */
  if (legacyPolicy) history = history.filter((row) => row.key !== 'rollback');
  /** 老文件没有 params 时，按历史最后一笔的落点恢复，避免「新反馈把参数打回默认」。 */
  const params = evolve.normalizeParams(input.params && typeof input.params === 'object'
    ? input.params
    : (history.length && history[history.length - 1].to ? history[history.length - 1].to : {}));
  const policyInput = legacyPolicy ? {} : input.policy;
  const cursorInput = Number.isInteger(policyInput.cursor) ? policyInput.cursor : history.length;
  const state = {
    version: EVOLVE_SCHEMA_VERSION,
    revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    replay: {
      digest: typeof replay.digest === 'string' && !legacyDigest ? replay.digest : '',
      digestVersion: REPLAY_DIGEST_VERSION,
      frozenAt: typeof replay.frozenAt === 'string' ? replay.frozenAt : '',
      records,
      cases,
      evidenceRevision: Number.isInteger(replay.evidenceRevision) && replay.evidenceRevision >= 0
        ? replay.evidenceRevision
        : (cases.length ? 1 : 0),
      needsReeval: replay.needsReeval === true,
    },
    params,
    policy: {
      revision: Number.isInteger(policyInput.revision) && policyInput.revision >= 0
        ? policyInput.revision : history.length,
      cursor: Math.min(Math.max(cursorInput, 0), history.length),
    },
    history,
    lastRunAt: typeof input.lastRunAt === 'string' ? input.lastRunAt : '',
  };
  /** 旧摘要算法只盖住一部分输入：读到时按现行算法重算，旧冻结集不用手动重建。 */
  const stale = replay.digestVersion !== REPLAY_DIGEST_VERSION
    || legacyDigest
    || records.length !== rawRecords.length
    || cases.length !== rawCases.length
    || !evolve.sameParams(params, input.params);
  if (stale) state.replay.digest = evolve.replayDigestOf(materializeCases(state), params);
  else if (!isHexDigest(state.replay.digest)) state.replay.digest = '';
  return state;
}

export function readEvolve(scope) {
  const file = fileOf(scope);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { lab: emptyEvolve(), corrupt: false, missing: true };
  }
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return { lab: emptyEvolve(), corrupt: true, missing: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { lab: emptyEvolve(), corrupt: true, missing: false };
  }
  const lab = normalize(parsed);
  /** 摘要算法换代后顺手回写一次，之后读盘不再重算哈希。 */
  if (parsed && parsed.replay && parsed.replay.digestVersion !== REPLAY_DIGEST_VERSION) {
    try {
      writeEvolve(scope, lab);
    } catch {
      /** 只读/写失败时继续用内存里的新摘要，不影响本次评测。 */
    }
  }
  return { lab, corrupt: false, missing: false };
}

const refsOf = (cases) => {
  const ids = new Set();
  for (const item of cases) {
    for (const id of item.expectIds) ids.add(String(id));
    for (const id of item.forbidIds) ids.add(String(id));
  }
  return ids;
};

/** 裁剪时先保住被用例引用的记忆，剩下的名额再按原顺序补齐，读回来的顺序不变。 */
function selectRecords(records, cases, cap) {
  const refs = refsOf(cases);
  const chosen = new Set();
  for (const row of records) if (refs.has(idOf(row))) chosen.add(idOf(row));
  const floor = Math.max(cap, chosen.size);
  if (chosen.size < floor) {
    for (const row of records) {
      if (chosen.size >= floor) break;
      chosen.add(idOf(row));
    }
  }
  return records.filter((row) => chosen.has(idOf(row)));
}

/** 引用对不上的题直接作废：宁可少一道题，也不留一条指向已删记忆的答题卡。 */
function dropDanglingCases(records, cases) {
  if (!records.length) return cases;
  const ids = new Set(records.map(idOf));
  const out = [];
  for (const item of cases) {
    const expectIds = item.expectIds.filter((id) => ids.has(id));
    const forbidIds = item.forbidIds.filter((id) => ids.has(id));
    if (item.expectIds.length && !expectIds.length) continue;
    out.push({ ...item, expectIds, forbidIds });
  }
  return out;
}

/**
 * 超限时按固定顺序让路：先只留被引用的记忆，再减少题量并同步放掉它引用的记忆，
 * 最后才丢历史。每一步都从同一份数据重新量体积，不会留下悬空引用。
 */
function fitEvolve(input) {
  let state = normalize(input);
  const trimmed = { records: 0, cases: 0, history: 0 };
  /** 体积已经超限才动数据：装得下的冻结集原样保留，包括调用方给的题面。 */
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_FILE_BYTES) {
    const sanitized = dropDanglingCases(state.replay.records, state.replay.cases);
    if (sanitized.length !== state.replay.cases.length) {
      trimmed.cases += state.replay.cases.length - sanitized.length;
      state = { ...state, replay: { ...state.replay, cases: sanitized } };
    }
  }
  let cap = 20;
  for (let round = 0; round < 512; round += 1) {
    if (Buffer.byteLength(JSON.stringify(state)) <= MAX_FILE_BYTES) {
      return { state, trimmed: trimmed.records + trimmed.cases + trimmed.history > 0 };
    }
    const rows = state.replay.records;
    const kept = selectRecords(rows, state.replay.cases, cap);
    if (kept.length < rows.length) {
      trimmed.records += rows.length - kept.length;
      state = { ...state, replay: { ...state.replay, records: kept } };
      continue;
    }
    if (cap > 0 && refsOf(state.replay.cases).size > 0) {
      cap = 0;
      continue;
    }
    if (state.replay.cases.length > 1) {
      trimmed.cases += 1;
      state = { ...state, replay: { ...state.replay, cases: state.replay.cases.slice(1) } };
      continue;
    }
    if (state.history.length > 1) {
      const drop = state.history.length - 1;
      trimmed.history += drop;
      state = {
        ...state,
        history: state.history.slice(-1),
        policy: { ...state.policy, cursor: Math.max(0, Math.min(state.policy.cursor - drop, 1)) },
      };
      continue;
    }
    return null;
  }
  return null;
}

/**
 * 写盘先量体积：超限就按策略压缩，压不下去整笔拒绝并保住磁盘上的旧状态。
 * 摘要永远从「最终要写到盘上的数据 + 当前参数」重算，不拿裁剪前的旧摘要充数。
 */
function writeEvolve(scope, lab) {
  const fitted = fitEvolve(lab);
  if (!fitted) return { ok: false, reason: 'too_large', state: normalize(lab) };
  const state = fitted.state;
  state.replay.digest = evolve.replayDigestOf(materializeCases(state), state.params);
  state.replay.digestVersion = REPLAY_DIGEST_VERSION;
  /** 裁剪动了评测样本：明说需要重评，不静默改数据。 */
  if (fitted.trimmed) state.replay.needsReeval = true;
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_FILE_BYTES) {
    return { ok: false, reason: 'too_large', state: normalize(lab) };
  }
  const file = fileOf(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, state };
}

/**
 * 冻结回放集：只换证据，不动生效参数、不动策略历史。
 * 摘要变了才推进证据集版本，并标记「需要重评」；同一批题重冻结仍然是 changed:false。
 */
export function freezeReplay(scope, cases, { now = Date.now(), records = [] } = {}) {
  const current = readEvolve(scope).lab;
  const shared = (Array.isArray(records) ? records : [])
    .slice(0, evolve.LIMITS.maxRecords)
    .map((row) => ({ ...row, id: idOf(row) }));
  const list = (Array.isArray(cases) ? cases : []).slice(0, evolve.LIMITS.maxCases).map((item) => {
    const row = { ...item };
    if (shared.length) delete row.records;
    return row;
  });
  const draft = {
    ...current,
    replay: {
      ...current.replay,
      frozenAt: new Date(now).toISOString(),
      records: shared,
      cases: list,
    },
  };
  const fitted = fitEvolve(draft);
  if (!fitted) return { ok: false, changed: false, reason: 'too_large', lab: current };
  const next = fitted.state;
  next.replay.digest = evolve.replayDigestOf(materializeCases(next), next.params);
  next.replay.digestVersion = REPLAY_DIGEST_VERSION;
  const changed = next.replay.digest !== current.replay.digest;
  if (!changed) return { ok: true, changed: false, lab: current };
  next.revision = current.revision + 1;
  next.replay.evidenceRevision = current.replay.evidenceRevision + 1;
  next.replay.needsReeval = next.replay.cases.length > 0;
  const written = writeEvolve(scope, next);
  if (!written.ok) return { ok: false, changed: false, reason: written.reason, lab: current };
  return { ok: true, changed: true, lab: written.state };
}

/**
 * 采纳一次改动：先核摘要（这一轮和冻结的那批题必须是同一批），
 * 再把参数与「从哪到哪、指标如何」写进历史，供回滚与解释。
 * 采纳只写策略历史与策略版本，证据集版本不动。
 */
export function applyProposal(scope, proposal, { cases, now = Date.now() } = {}) {
  const lab = readEvolve(scope).lab;
  if (!lab.replay.digest || !lab.replay.cases.length) return { ok: false, reason: 'no_replay' };
  const dynamic = evolve.replayDigestOf(
    materializeCases({ replay: { records: lab.replay.records, cases } }),
    lab.params,
  );
  if (dynamic !== lab.replay.digest) return { ok: false, reason: 'replay_changed' };
  if (!proposal || !proposal.params) return { ok: false, reason: 'no_change' };
  const params = evolve.normalizeParams(proposal.params);
  if (evolve.sameParams(params, lab.params)) return { ok: false, reason: 'no_change' };
  /** 采纳前按服务端最终证据重跑一遍：指标与「哪条变好」以重跑为准，不信调用方带进来的数字。 */
  const rerun = Array.isArray(cases) && cases.length ? evolve.replay(cases, params) : null;
  const baseline = rerun ? evolve.replay(cases, lab.params) : null;
  const verdict = rerun ? evolve.compareReplay(baseline, rerun) : null;
  const at = new Date(now).toISOString();
  const history = [
    ...lab.history,
    {
      at,
      key: String(proposal.key || ''),
      from: { ...lab.params },
      to: params,
      metrics: rerun
        ? { hit: rerun.hit, expect: rerun.expect, position: rerun.position, falseHit: rerun.falseHit, bytes: rerun.bytes }
        : proposal.metrics || null,
      improved: (verdict ? verdict.improved : (Array.isArray(proposal.improved) ? proposal.improved : [])).slice(0, evolve.LIMITS.maxCases),
      digest: lab.replay.digest,
    },
  ].slice(-MAX_HISTORY);
  const next = {
    ...lab,
    revision: lab.revision + 1,
    params,
    lastRunAt: at,
    history,
    /** 时间线走到最新一笔；下次回滚从这里往回找。 */
    policy: { revision: lab.policy.revision + 1, cursor: history.length },
    /** 采纳后拿当前参数在这份证据上跑过一次，待重评标记清掉。 */
    replay: { ...lab.replay, needsReeval: false },
  };
  const written = writeEvolve(scope, next);
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true, lab: written.state };
}

/** 回滚只沿着策略时间线单向往回退，不写新历史，所以不会弹回刚退掉的档位。 */
export function rollbackParams(scope, { now = Date.now() } = {}) {
  const lab = readEvolve(scope).lab;
  const target = evolve.rollbackTarget(lab.history, lab.params, lab.policy.cursor);
  if (!target) return { ok: false, reason: 'nothing_to_rollback' };
  const at = new Date(now).toISOString();
  const next = {
    ...lab,
    revision: lab.revision + 1,
    params: target.params,
    lastRunAt: at,
    policy: { ...lab.policy, cursor: target.cursor },
    replay: { ...lab.replay, needsReeval: true },
  };
  const written = writeEvolve(scope, next);
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true, lab: written.state, rolledBackTo: target.params };
}

/** 面板要的那点东西：当前参数、有没有冻结回放、最后一次改了什么、能否回滚。 */
export function describeEvolve(scope) {
  const { lab, corrupt } = readEvolve(scope);
  const last = lab.history.length ? lab.history[lab.history.length - 1] : null;
  return {
    corrupt,
    revision: lab.revision,
    params: lab.params,
    defaults: { ...evolve.DEFAULT_PARAMS },
    replayCases: lab.replay.cases.length,
    replayDigest: lab.replay.digest,
    frozenAt: lab.replay.frozenAt,
    /** 证据集走到第几版、待不待重评，和下面的生效策略版本分开看。 */
    evidenceRevision: lab.replay.evidenceRevision,
    needsReeval: lab.replay.needsReeval === true,
    policyRevision: lab.policy.revision,
    canRollback: Boolean(evolve.rollbackTarget(lab.history, lab.params, lab.policy.cursor)),
    lastChange: last
      ? {
        at: last.at,
        key: last.key,
        from: Number(last.from ? last.from[last.key] : NaN),
        to: Number(last.to ? last.to[last.key] : NaN),
        metrics: last.metrics,
      }
      : null,
    history: lab.history.length,
  };
}

/** 回放题按现在的样子摊平：顶层快照补给每道题，回放/摘要都看同一份。 */
export function materializeCases(lab) {
  const replay = (lab && lab.replay) || {};
  const shared = Array.isArray(replay.records) ? replay.records : [];
  return (Array.isArray(replay.cases) ? replay.cases : []).map((item) => (
    shared.length ? { ...item, records: shared } : item
  ));
}
