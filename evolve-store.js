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
    replay: { digest: '', frozenAt: '', cases: [] },
    params: { ...evolve.DEFAULT_PARAMS },
    history: [],
    lastRunAt: '',
  };
}

function normalize(input) {
  const base = emptyEvolve();
  if (!input || typeof input !== 'object') return base;
  const replay = input.replay && typeof input.replay === 'object' ? input.replay : {};
  const cases = Array.isArray(replay.cases) ? replay.cases.slice(0, evolve.LIMITS.maxCases) : [];
  const history = Array.isArray(input.history) ? input.history.slice(-MAX_HISTORY) : [];
  return {
    version: EVOLVE_SCHEMA_VERSION,
    revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
    replay: {
      digest: typeof replay.digest === 'string' ? replay.digest : '',
      frozenAt: typeof replay.frozenAt === 'string' ? replay.frozenAt : '',
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

function writeEvolve(scope, lab) {
  const state = normalize(lab);
  const file = fileOf(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, file);
  return state;
}

/**
 * 冻结回放集。摘要变了就是新的一批题：参数回到默认、历史清空，
 * 免得拿上一批题的成绩去背书本轮的改动。
 */
export function freezeReplay(scope, cases, { now = Date.now() } = {}) {
  const lab = readEvolve(scope).lab;
  const list = (Array.isArray(cases) ? cases : []).slice(0, evolve.LIMITS.maxCases);
  const digest = evolve.replayDigestOf(list);
  if (lab.replay.digest === digest) return { ok: true, changed: false, lab };
  const next = {
    ...lab,
    revision: lab.revision + 1,
    replay: { digest, frozenAt: new Date(now).toISOString(), cases: list },
    params: { ...evolve.DEFAULT_PARAMS },
    history: [],
  };
  return { ok: true, changed: true, lab: writeEvolve(scope, next) };
}

/**
 * 采纳一次改动：先核摘要（这一轮和冻结的那批题必须是同一批），
 * 再把参数与「从哪到哪、指标如何」写进历史，供回滚与解释。
 */
export function applyProposal(scope, proposal, { cases, now = Date.now() } = {}) {
  const lab = readEvolve(scope).lab;
  const digest = evolve.replayDigestOf(cases);
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
  return { ok: true, lab: writeEvolve(scope, next) };
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
  return { ok: true, lab: writeEvolve(scope, next), rolledBackTo: target.params };
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
