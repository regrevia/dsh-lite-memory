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

const fileOf = (scope) => {
  const dir = scope && scope.dir ? scope.dir : path.join(memoryRoot(), 'global');
  return path.join(dir, 'evolve.json');
};

export function emptyEvolve() {
  return {
    version: EVOLVE_SCHEMA_VERSION,
    revision: 1,
    /** 快照放一次，多道题共用：60 条记忆不再按题复制，24 道题也不会把文件撑爆。 */
    replay: { digest: '', frozenAt: '', records: [], cases: [] },
    params: { ...evolve.DEFAULT_PARAMS },
    history: [],
    lastRunAt: '',
  };
}

function normalize(input) {
  const base = emptyEvolve();
  if (!input || typeof input !== 'object') return base;
  const replay = input.replay && typeof input.replay === 'object' ? input.replay : {};
  const records = Array.isArray(replay.records) ? replay.records.slice(0, evolve.LIMITS.maxRecords) : [];
  const cases = (Array.isArray(replay.cases) ? replay.cases : []).slice(0, evolve.LIMITS.maxCases)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const out = {
        id: String(row.id || ''), query: String(row.query || ''),
        expectIds: (Array.isArray(row.expectIds) ? row.expectIds : []).map(String),
        forbidIds: (Array.isArray(row.forbidIds) ? row.forbidIds : []).map(String),
        context: row.context && typeof row.context === 'object'
          ? { taskKind: String(row.context.taskKind || '').slice(0, 40) } : undefined,
      };
      /** 快照已经在顶层就不再逐题存一份；老文件没有顶层快照时原样保留。 */
      if (!records.length && Array.isArray(row.records)) out.records = row.records.slice(0, evolve.LIMITS.maxRecords);
      return out;
    });
  const history = Array.isArray(input.history) ? input.history.slice(-MAX_HISTORY) : [];
  /** 旧版把整份快照当摘要写进盘；读到时按现行算法重算一次，旧冻结集不用手动重建。 */
  if (typeof replay.digest === 'string' && replay.digest.startsWith('[')) {
    replay.digest = evolve.replayDigestOf(materializeCases({ replay: { records, cases } }));
  }
  return {
    version: EVOLVE_SCHEMA_VERSION,
    revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    replay: {
      digest: typeof replay.digest === 'string' ? replay.digest : '',
      frozenAt: typeof replay.frozenAt === 'string' ? replay.frozenAt : '',
      records,
      cases,
    },
    params: evolve.normalizeParams(input.params),
    history,
    lastRunAt: typeof input.lastRunAt === 'string' ? input.lastRunAt : '',
  };
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
  try {
    return { lab: normalize(JSON.parse(raw)), corrupt: false, missing: false };
  } catch {
    return { lab: emptyEvolve(), corrupt: true, missing: false };
  }
}

/** 回放题按现在的样子摊平：顶层快照补给每道题，回放/摘要都看同一份。 */
export function materializeCases(lab) {
  const replay = (lab && lab.replay) || {};
  const shared = Array.isArray(replay.records) ? replay.records : [];
  return (Array.isArray(replay.cases) ? replay.cases : []).map((item) => (
    shared.length ? { ...item, records: shared } : item
  ));
}

/** 超限时按固定顺序让路：先丢最老的题，再截断快照，最后丢最老的历史。 */
function fitEvolve(state) {
  if (Buffer.byteLength(JSON.stringify(state)) <= MAX_FILE_BYTES) return state;
  if (state.replay.cases.length > 1) return fitEvolve(normalize({ ...state, replay: { ...state.replay, cases: state.replay.cases.slice(1) } }));
  if (state.replay.records.length > 20) return fitEvolve(normalize({ ...state, replay: { ...state.replay, records: state.replay.records.slice(0, 20) } }));
  if (state.history.length > 1) return fitEvolve(normalize({ ...state, history: state.history.slice(-1) }));
  return null;
}

/**
 * 写盘先量体积：超限就按策略压缩，压不下去整笔拒绝并保住磁盘上的旧状态。
 * 绝不写出一份读回来就判坏的文件。
 */
function writeEvolve(scope, lab) {
  const state = fitEvolve(normalize(lab));
  if (!state) return { ok: false, reason: 'too_large', state: normalize(lab) };
  const file = fileOf(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, state };
}

/**
 * 冻结回放集。摘要变了就是新的一批题：参数回到默认、历史清空，
 * 免得拿上一批题的成绩去背书本轮的改动。
 */
export function freezeReplay(scope, cases, { now = Date.now(), records = [] } = {}) {
  const lab = readEvolve(scope).lab;
  const shared = (Array.isArray(records) ? records : [])
    .slice(0, evolve.LIMITS.maxRecords)
    .map((row) => ({ ...row, id: String((row && row.id) || '') }));
  const list = (Array.isArray(cases) ? cases : []).slice(0, evolve.LIMITS.maxCases).map((item) => {
    const row = { ...item };
    if (shared.length) delete row.records;
    return row;
  });
  const digest = evolve.replayDigestOf(shared.length ? list.map((item) => ({ ...item, records: shared })) : list);
  if (lab.replay.digest === digest) return { ok: true, changed: false, lab };
  const next = {
    ...lab,
    revision: lab.revision + 1,
    replay: { digest, frozenAt: new Date(now).toISOString(), records: shared, cases: list },
    params: { ...evolve.DEFAULT_PARAMS },
    history: [],
  };
  const written = writeEvolve(scope, next);
  if (!written.ok) return { ok: false, reason: written.reason, changed: false, lab };
  return { ok: true, changed: true, lab: written.state };
}

/**
 * 采纳一次改动：先核摘要（这一轮和冻结的那批题必须是同一批），
 * 再把参数与「从哪到哪、指标如何」写进历史，供回滚与解释。
 */
export function applyProposal(scope, proposal, { cases, now = Date.now() } = {}) {
  const lab = readEvolve(scope).lab;
  const digest = evolve.replayDigestOf(materializeCases({ replay: { records: lab.replay.records, cases } }));
  if (!lab.replay.digest) return { ok: false, reason: 'no_replay' };
  if (digest !== lab.replay.digest) return { ok: false, reason: 'replay_changed' };
  if (!proposal || !proposal.params) return { ok: false, reason: 'no_change' };
  const params = evolve.normalizeParams(proposal.params);
  if (evolve.sameParams(params, lab.params)) return { ok: false, reason: 'no_change' };
  const at = new Date(now).toISOString();
  const next = {
    ...lab,
    revision: lab.revision + 1,
    params,
    lastRunAt: at,
    history: [
      ...lab.history,
      {
        at,
        key: String(proposal.key || ''),
        from: { ...lab.params },
        to: params,
        metrics: proposal.metrics || null,
        improved: Array.isArray(proposal.improved) ? proposal.improved.slice(0, evolve.LIMITS.maxCases) : [],
        digest,
      },
    ].slice(-MAX_HISTORY),
  };
  const written = writeEvolve(scope, next);
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true, lab: written.state };
}

export function rollbackParams(scope, { now = Date.now() } = {}) {
  const lab = readEvolve(scope).lab;
  const target = evolve.rollbackTarget(lab.history);
  if (!target) return { ok: false, reason: 'nothing_to_rollback' };
  const at = new Date(now).toISOString();
  const next = {
    ...lab,
    revision: lab.revision + 1,
    params: target.params,
    lastRunAt: at,
    history: [
      ...lab.history,
      { at, key: 'rollback', from: { ...lab.params }, to: target.params, metrics: null, digest: lab.replay.digest },
    ].slice(-MAX_HISTORY),
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
    canRollback: Boolean(evolve.rollbackTarget(lab.history)),
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
