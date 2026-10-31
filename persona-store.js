/**
 * 「记住我」持久化：画像单独一份文件，不进项目枚举、不进 memory_search / memory_read / 链接与搬层。
 * 这里只管「能不能落盘」：开关代次、版本号、证据代次、事件编号四道在提交时再核验一次，
 * 入口检查过不算数——模型跑十秒后用户关了开关，结果不得写入。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as persona from './persona.js';
import { memoryRoot } from './state.js';

export const PERSONA_SCHEMA_VERSION = 1;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_EVIDENCE = 200;
export const MAX_PENDING = 32;
export const MAX_CHANGES = 20;
export const MAX_FORMED_DIMENSIONS = 8;
export const PENDING_MIN = 6;
/** 一次真的给模型看几段：结算只认这份名单，控制在 token 预算内。 */
export const SHOWN_MAX = 12;
export const SHOWN_PROMPT = 6;
export const PASS_GAP_HOURS = 24;
/** 待查片段只在这段时间内有效：太久没人管的旧片段不该继续占着队列。 */
export const PENDING_TTL_DAYS = 14;
export const MAX_ATTEMPTS = 4;

const DIMENSIONS = persona.DIMENSION_NAMES;

function personaFile() {
  return path.join(memoryRoot(), 'persona.json');
}

function nowIso(now) {
  const date = now ? new Date(now) : new Date();
  return date.toISOString();
}

function token() {
  return crypto.randomBytes(8).toString('hex');
}

export function emptyPersona() {
  return {
    schemaVersion: PERSONA_SCHEMA_VERSION,
    owner: '',
    control: { enabled: false, consentEpoch: token(), updatedAt: '' },
    revision: 1,
    /** 只随「用户能看到的选择」轮换：开关、人工改/暂停、清空。攒队列、写证据都不动它。 */
    preferenceEpoch: token(),
    evidenceGeneration: token(),
    learning: { lastPassAt: '', attempts: [], lastResult: null },
    preferences: {},
    evidence: [],
    pending: [],
    recentChanges: [],
    blockedDimensions: [],
  };
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 最近一次整理的结果是闭集枚举，面板据此说人话，不展示模型原文。 */
const RESULT_OUTCOMES = ['added', 'no_change', 'duplicate', 'invalid', 'no_observation', 'blocked', 'off', 'stale'];

/** 取值票只保留本维闭集里的键，最多 8 个取值，票上的日期/情境同样有上限。 */
function normalizeTallies(raw, dimension) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = persona.PREFERENCE_DIMENSIONS[dimension] || [];
  for (const value of allowed.slice(0, 8)) {
    const row = raw[value];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    out[value] = {
      support: Math.max(0, Number(row.support) | 0),
      dayKeys: (Array.isArray(row.dayKeys) ? row.dayKeys : []).slice(-64).map((day) => text(day, 12)),
      contextKeys: (Array.isArray(row.contextKeys) ? row.contextKeys : []).slice(-16).map((key) => text(key, 80)),
      firstSeenAt: text(row.firstSeenAt, 40), lastSupportedAt: text(row.lastSupportedAt, 40),
    };
  }
  return out;
}

/** 读盘后整份收敛到闭集与上限，坏字段丢掉而不是信任。 */
export function normalizePersona(raw) {
  const base = emptyPersona();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = { ...base };
  out.owner = text(raw.owner, 80);
  if (raw.control && typeof raw.control === 'object') {
    out.control = {
      enabled: raw.control.enabled === true,
      consentEpoch: text(raw.control.consentEpoch, 40) || base.control.consentEpoch,
      updatedAt: text(raw.control.updatedAt, 40),
    };
  }
  out.revision = Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
  out.preferenceEpoch = text(raw.preferenceEpoch, 40) || base.preferenceEpoch;
  out.evidenceGeneration = text(raw.evidenceGeneration, 40) || base.evidenceGeneration;
  if (raw.learning && typeof raw.learning === 'object') {
    out.learning.lastPassAt = text(raw.learning.lastPassAt, 40);
    const last = raw.learning.lastResult;
    if (last && typeof last === 'object' && RESULT_OUTCOMES.includes(last.outcome)) {
      out.learning.lastResult = {
        outcome: last.outcome, dimension: text(last.dimension, 40), reason: text(last.reason, 40), at: text(last.at, 40),
      };
    }
    out.learning.attempts = (Array.isArray(raw.learning.attempts) ? raw.learning.attempts : [])
      .filter((item) => item && typeof item.eventId === 'string')
      .slice(-MAX_ATTEMPTS)
      .map((item) => ({
        attemptId: text(item.attemptId, 40), eventId: text(item.eventId, 40), at: text(item.at, 40),
        consentEpoch: text(item.consentEpoch, 40), revision: Number.isInteger(item.revision) ? item.revision : 1,
        preferenceEpoch: text(item.preferenceEpoch, 40),
        evidenceGeneration: text(item.evidenceGeneration, 40), snippetIds: (Array.isArray(item.snippetIds) ? item.snippetIds : []).slice(0, PENDING_MIN * 2).map((id) => text(id, 60)),
        /** 本次真正展示给模型的片段：结算只认这份名单，新入队的片段不会被老批次消费。 */
        shownIds: (Array.isArray(item.shownIds) ? item.shownIds : []).slice(0, SHOWN_MAX).map((id) => text(id, 60)),
        observation: item.observation && typeof item.observation === 'object' ? item.observation : null,
      }));
  }
  if (raw.preferences && typeof raw.preferences === 'object') {
    let formed = 0;
    for (const dimension of DIMENSIONS) {
      const row = raw.preferences[dimension];
      if (!row || typeof row !== 'object') continue;
      const value = row.value === null || row.value === undefined ? null : text(row.value, 40);
      if (value && !persona.PREFERENCE_DIMENSIONS[dimension].includes(value)) continue;
      const state = ['formed', 'observing', 'paused'].includes(row.state) ? row.state : 'observing';
      if (state === 'formed') {
        if (formed >= MAX_FORMED_DIMENSIONS || !value) continue;
        formed += 1;
      }
      out.preferences[dimension] = {
        value, state,
        source: ['inferred', 'manual'].includes(row.source) ? row.source : 'inferred',
        support: Math.max(0, Number(row.support) | 0), opposition: Math.max(0, Number(row.opposition) | 0),
        distinctDays: Math.max(0, Number(row.distinctDays) | 0), contexts: Math.max(0, Number(row.contexts) | 0),
        firstSeenAt: text(row.firstSeenAt, 40), lastSupportedAt: text(row.lastSupportedAt, 40),
        lockedByUser: row.lockedByUser === true, pausedByUser: row.pausedByUser === true,
        dayKeys: (Array.isArray(row.dayKeys) ? row.dayKeys : []).slice(-64).map((day) => text(day, 12)),
        contextKeys: (Array.isArray(row.contextKeys) ? row.contextKeys : []).slice(-16).map((key) => text(key, 80)),
        /** 每个取值各记一份票：跨批次累计必须落盘，否则每次读回都从头攒。 */
        valueTallies: normalizeTallies(row.valueTallies, dimension),
      };
    }
  }
  out.evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter((row) => row && DIMENSIONS.includes(row.dimension))
    .slice(-MAX_EVIDENCE)
    .map((row) => ({
      dedupeKey: text(row.dedupeKey, 200), dimension: row.dimension,
      polarity: row.polarity === 'oppose' ? 'oppose' : 'support',
      value: row.value === null || row.value === undefined ? null : text(row.value, 40),
      userId: text(row.userId, 80), sessionId: text(row.sessionId, 80), taskId: text(row.taskId, 80),
      projectId: text(row.projectId, 120), date: text(row.date, 12), at: text(row.at, 40),
      eventId: text(row.eventId, 60), basis: persona.BASIS_VALUES.includes(row.basis) ? row.basis : 'explicit_feedback',
    }));
  out.pending = (Array.isArray(raw.pending) ? raw.pending : [])
    .filter((row) => row && typeof row.id === 'string')
    .slice(-MAX_PENDING)
    .map((row) => ({
      id: text(row.id, 60), at: text(row.at, 40), sessionId: text(row.sessionId, 80),
      taskId: text(row.taskId, 80), projectId: text(row.projectId, 120), date: text(row.date, 12),
      dimension: DIMENSIONS.includes(row.dimension) ? row.dimension : '',
      polarity: row.polarity === 'oppose' ? 'oppose' : 'support',
      value: row.value === null || row.value === undefined ? null : text(row.value, 40),
      basis: persona.BASIS_VALUES.includes(row.basis) ? row.basis : 'explicit_feedback',
      text: text(row.text, 400),
    }));
  out.recentChanges = (Array.isArray(raw.recentChanges) ? raw.recentChanges : [])
    .filter((row) => row && DIMENSIONS.includes(row.dimension))
    .slice(-MAX_CHANGES)
    .map((row) => ({
      dimension: row.dimension, at: text(row.at, 40),
      kind: ['formed', 'changed', 'paused', 'cleared', 'manual'].includes(row.kind) ? row.kind : 'changed',
      automatic: row.automatic === true, used: row.used === true, reason: text(row.reason, 40),
    }));
  out.blockedDimensions = (Array.isArray(raw.blockedDimensions) ? raw.blockedDimensions : [])
    .filter((dimension) => DIMENSIONS.includes(dimension));
  return out;
}

/** 读：坏文件不覆盖，返回空画像并标记 corrupt，等用户处理；也不让一次坏盘变成永久失效。 */
export function readPersona(options = {}) {
  const file = personaFile();
  let raw;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return { persona: emptyPersona(), corrupt: true, reason: 'too_large' };
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { persona: emptyPersona(), corrupt: false, reason: 'missing' };
    return { persona: emptyPersona(), corrupt: true, reason: 'unreadable' };
  }
  try {
    const data = normalizePersona(JSON.parse(raw));
    if (options.userId && data.owner && data.owner !== options.userId) {
      return { persona: emptyPersona(), corrupt: false, reason: 'other_user' };
    }
    return { persona: data, corrupt: false, reason: 'ok' };
  } catch {
    return { persona: emptyPersona(), corrupt: true, reason: 'parse' };
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { ok: true };
}

/** 容量吃紧时的让路顺序：先丢最老的证据，再丢最老的待查、在途与改动记录。 */
const PRESSURE = { evidence: 100, pending: 8, attempts: 1, changes: 6 };

function fitPersona(data) {
  if (!data || typeof data !== 'object') return null;
  /** 盘上旧文件可能缺字段：先兜成数组，缺一个字段不该让整个画像写不进去。 */
  if (!Array.isArray(data.evidence)) data.evidence = [];
  if (!Array.isArray(data.pending)) data.pending = [];
  if (!Array.isArray(data.recentChanges)) data.recentChanges = [];
  if (!data.learning || typeof data.learning !== 'object') data.learning = {};
  if (!Array.isArray(data.learning.attempts)) data.learning.attempts = [];
  if (Buffer.byteLength(JSON.stringify(data)) <= MAX_FILE_BYTES) return data;
  const steps = [];
  if (data.evidence.length > PRESSURE.evidence) steps.push(() => { trimEvidence(data, PRESSURE.evidence); });
  if (data.pending.length > PRESSURE.pending) steps.push(() => { data.pending = data.pending.slice(-PRESSURE.pending); });
  if (data.learning.attempts.length > PRESSURE.attempts) steps.push(() => { data.learning.attempts = data.learning.attempts.slice(-PRESSURE.attempts); });
  if (data.recentChanges.length > PRESSURE.changes) steps.push(() => { data.recentChanges = data.recentChanges.slice(-PRESSURE.changes); });
  for (const step of steps) {
    step();
    if (Buffer.byteLength(JSON.stringify(data)) <= MAX_FILE_BYTES) return data;
  }
  if (data.evidence.length > 1) { trimEvidence(data, 1); }
  if (data.pending.length > 1) { data.pending = data.pending.slice(-1); }
  return Buffer.byteLength(JSON.stringify(data)) <= MAX_FILE_BYTES ? data : null;
}

/** 单点写入：所有变更都走这里，写完回执带上新版本号，调用方不用自己再读一次。 */
export function writePersona(next, options = {}) {
  const raw = normalizePersona(next);
  if (options.userId) raw.owner = options.userId;
  raw.revision = (Number(options.revision) || raw.revision) + 1;
  const data = fitPersona(raw);
  if (!data) return { ok: false, reason: 'too_large', persona: normalizePersona(next) };
  const written = writeAtomic(personaFile(), data);
  if (!written.ok) return { ok: false, reason: written.reason, persona: data };
  return { ok: true, persona: data };
}

function pushChange(list, change) {
  list.push(change);
  while (list.length > MAX_CHANGES) list.shift();
  return list;
}

/**
 * 开关：默认关闭。每次切换都轮换同意代次，关掉时在途任务立即作废；重开不补跑旧的待查片段。
 */
export function setPersonaEnabled(input = {}) {
  const enabled = input.enabled === true;
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  data.preferenceEpoch = token();
  if (data.control.enabled === enabled) {
    return { ok: true, changed: false, persona: data, reason: read.reason };
  }
  data.control.enabled = enabled;
  data.control.consentEpoch = token();
  data.control.updatedAt = nowIso(input.now);
  if (!enabled) {
    /** 关掉时取消在途任务、丢弃未确认片段：这些片段属于旧同意，不能留着下次偷偷学。 */
    data.learning.attempts = [];
    data.pending = [];
  }
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, changed: written.ok, persona: written.persona, reason: read.reason };
}

/** 本地筛出的一条待查片段：只有闭集枚举与一句原话，最多 400 字。 */
function freshPending(rows, at) {
  const base = new Date(at).getTime();
  if (!Number.isFinite(base)) return Array.isArray(rows) ? rows : [];
  const keep = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const when = new Date(row && row.at).getTime();
    if (!Number.isFinite(when) || base - when <= PENDING_TTL_DAYS * 86400000) keep.push(row);
  }
  return keep;
}

export function queuePersonaPending(input = {}) {
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  if (!data.control.enabled) return { ok: false, reason: 'off' };
  const snippet = input.snippet || {};
  const observation = persona.detectPreferenceSignal({ text: snippet.text });
  if (!observation) return { ok: false, reason: 'no_signal' };
  const row = {
    id: token(), at: nowIso(input.now), sessionId: text(snippet.sessionId, 80), taskId: text(snippet.taskId, 80),
    projectId: text(snippet.projectId, 120), date: String(nowIso(input.now)).slice(0, 10),
    dimension: observation.dimension, polarity: observation.polarity, value: observation.value,
    basis: observation.basis, text: text(snippet.text, 400),
  };
  data.pending = [...freshPending(data.pending, row.at), row].slice(-MAX_PENDING);
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, reason: written.reason || '', persona: written.persona, snippet: row };
}

/**
 * 项目关掉记忆后，它还没整理完的片段一并撤掉：用户级画像可以跨项目汇总，
 * 但不该在别的项目里替一个已经关掉的来源继续学习。
 */
export function dropPersonaPendingForProject(input = {}) {
  const projectId = text(input.projectId, 120);
  if (!projectId) return { ok: false, reason: 'missing_project', dropped: 0 };
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  const before = data.pending.length;
  data.pending = data.pending.filter((row) => row && row.projectId !== projectId);
  if (data.pending.length === before) return { ok: true, changed: false, dropped: 0, persona: data };
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, changed: true, dropped: before - data.pending.length, persona: written.persona };
}

/**
 * 开始一次抽取：≥6 条待查、距上次 ≥24h、开关仍开、有预算才允许。
 * 返回的代次/版本/证据代次必须在提交时原样带回，否则结果丢弃。
 */
export function beginPersonaAttempt(input = {}) {
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  if (!data.control.enabled) return { ok: false, reason: 'off' };
  const at = nowIso(input.now);
  const fresh = freshPending(data.pending, at);
  if (fresh.length !== data.pending.length) data.pending = fresh;
  /**
   * 来源项目已经关掉的片段不再展示：不占名单、不花这次窗口。
   * 来源不明或当前不开放的片段顺手从待整理里撤掉，下一次也不会带进来。
   */
  if (typeof input.allowSource === 'function') {
    const opened = data.pending.filter((row) => {
      try { return input.allowSource(row) === true; } catch { return false; }
    });
    if (opened.length !== data.pending.length) {
      data.pending = opened;
      const pruned = writePersona(data, { userId: input.userId, revision: data.revision });
      if (!pruned.ok) return { ok: false, reason: pruned.reason };
    }
  }
  if (data.pending.length < PENDING_MIN) return { ok: false, reason: 'not_enough', pending: data.pending.length };
  const last = data.learning.lastPassAt ? new Date(data.learning.lastPassAt).getTime() : 0;
  if (last && new Date(at).getTime() - last < PASS_GAP_HOURS * 3600000) return { ok: false, reason: 'budget' };
  /** 真给模型看的名单在开工时定死：结算只认它，期间新入队的片段不会被这次消费掉。 */
  const shownIds = data.pending.slice(-SHOWN_PROMPT).map((row) => row.id);
  const attempt = {
    attemptId: token(), eventId: token(), at,
    consentEpoch: data.control.consentEpoch, revision: data.revision, preferenceEpoch: data.preferenceEpoch,
    evidenceGeneration: data.evidenceGeneration,
    snippetIds: shownIds,
    shownIds,
    observation: null,
  };
  data.learning.lastPassAt = at;
  data.learning.attempts = [...data.learning.attempts, attempt].slice(-MAX_ATTEMPTS);
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  if (!written.ok) return { ok: false, reason: written.reason };
  return {
    ok: true, persona: written.persona,
    attempt: {
      attemptId: attempt.attemptId, eventId: attempt.eventId,
      consentEpoch: attempt.consentEpoch, revision: written.persona.revision, preferenceEpoch: attempt.preferenceEpoch,
      evidenceGeneration: attempt.evidenceGeneration, snippetIds: attempt.snippetIds, shownIds: attempt.shownIds,
      snippets: data.pending.filter((row) => attempt.snippetIds.includes(row.id)),
    },
  };
}

/** 证据集合变了，各维度的计数与状态都从证据整份重算；人工确认的取值保留，只刷新关联条数。 */
function resettleFromEvidence(data) {
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  const lastFormationAt = lastFormation(data);
  for (const dimension of Object.keys(data.preferences || {})) {
    const rows = evidence.filter((row) => row && row.dimension === dimension);
    const next = persona.rebuildPreference(data.preferences[dimension], rows, { dimension });
    if (next.lockedByUser === true || next.source === 'manual') {
      data.preferences[dimension] = next;
      continue;
    }
    const verdict = persona.decideMaturity(next, { now: nowIso(), lastFormationAt });
    data.preferences[dimension] = { ...next, state: verdict.state };
  }
}

/** 证据裁到上限：条数一变，计数/状态跟着重算，同时让正在跑的结果失效。 */
function trimEvidence(data, limit) {
  if (!Array.isArray(data.evidence) || data.evidence.length <= limit) return false;
  data.evidence = data.evidence.slice(-limit);
  data.evidenceGeneration = token();
  resettleFromEvidence(data);
  return true;
}

/** 最近一次整理的结果留痕：面板据此说「已整理 / 格式无效 / 依据已撤回」，不展示模型原文。 */
function recordResult(data, input = {}) {
  if (!data.learning || typeof data.learning !== 'object') data.learning = { lastPassAt: '', attempts: [], lastResult: null };
  data.learning.lastResult = {
    outcome: RESULT_OUTCOMES.includes(input.outcome) ? input.outcome : 'stale',
    dimension: text(input.dimension, 40), reason: text(input.reason, 40), at: nowIso(input.at),
  };
}

/** 模型回执不能解析时也留痕：面板要说「结果格式无效」，而不是永远停在上一轮。 */
export function recordPersonaOutcome(input = {}) {
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  recordResult(data, input);
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, lastResult: data.learning.lastResult };
}

/**
 * 提交一次抽取结果：四道核验全部通过才落盘。
 * 关掉开关、改过面板、删过证据、同一事件已提交过——任一条命中就整份丢弃，不做部分写入。
 */
export function commitPersonaObservation(input = {}) {
  const attempt = input.attempt || {};
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  if (!data.control.enabled) return { ok: false, reason: 'off' };
  if (!attempt.eventId || data.learning.attempts.some((row) => row.eventId === attempt.eventId && row.observation)) {
    return { ok: false, reason: 'replayed' };
  }
  if (data.control.consentEpoch !== attempt.consentEpoch) return { ok: false, reason: 'consent_changed' };
  /** 先判证据代次：删过证据要报「证据变了」，而不是笼统的版本变了。 */
  if (data.evidenceGeneration !== attempt.evidenceGeneration) return { ok: false, reason: 'evidence_changed' };
  /** 只认用户改过的选择；期间只是又攒了几条片段，不该把已经跑完的结果作废。 */
  if ((attempt.preferenceEpoch || '') && data.preferenceEpoch !== attempt.preferenceEpoch) return { ok: false, reason: 'revision_changed' };
  /** 模型点名的是哪一段：只认本次真展示过的编号，编出来的编号整条作废。 */
  const citedId = text(input.snippetId || (observations[0] && observations[0].snippetId) || '', 80);
  const shown = (data.pending || []).filter((row) => (attempt.shownIds || []).includes(row.id));
  const pool = shown.length ? shown : (data.pending || []).filter((row) => (attempt.snippetIds || []).includes(row.id));
  if (citedId && !pool.some((row) => row.id === citedId)) return { ok: false, reason: 'citation_invalid' };
  /** 已展示的整批都算核验过：有偏好、没偏好、同一条重复，这批都不会明天再被抽到同一次。 */
  const consumed = pool.map((row) => row.id);
  const outcome = input.outcome === 'no_change' ? 'no_change' : '';
  if (outcome === 'no_change') {
    /** 有效但没发现偏好：这批看过就算处理完，明天不再重复抽样；新入队的片段不在名单里。 */
    data.pending = (data.pending || []).filter((row) => !consumed.includes(row.id));
    recordResult(data, { outcome: 'no_change', reason: citedId ? 'cited' : 'batch', at: input.now });
    finalizeAttempt(data, attempt, null);
    const written = writePersona(data, { userId: input.userId, revision: data.revision });
    return { ok: written.ok, reason: 'no_change', persona: written.persona, consumed: consumed.length };
  }
  const accepted = [];
  for (const observation of observations) {
    const valid = persona.validateObservation(observation);
    if (!valid.ok) continue;
    if (accepted.length >= 1) break;
    accepted.push(observation);
  }
  if (!accepted.length) return { ok: false, reason: 'no_observation' };
  const snippet = pool.find((row) => row.id === citedId) || pool[0] || {};
  const evidenceRow = {
    dimension: accepted[0].dimension, polarity: accepted[0].polarity, value: accepted[0].value || null,
    userId: text(input.userId, 80), sessionId: snippet.sessionId || '', taskId: snippet.taskId || '',
    projectId: snippet.projectId || '', date: String(nowIso(input.now)).slice(0, 10),
    at: nowIso(input.now), eventId: attempt.eventId, basis: accepted[0].basis,
  };
  const next = data.evidence ? [...data.evidence, evidenceRow] : [evidenceRow];
  const deduped = persona.deduplicateEvidence(next);
  if (deduped.length === data.evidence.length) {
    /** 去重后没有新增：这次反馈只算同一份证据，不改计数，也不消耗下一次预算。 */
    data.pending = (data.pending || []).filter((row) => !consumed.includes(row.id));
    recordResult(data, { outcome: 'duplicate', dimension: accepted[0].dimension, reason: 'same_evidence', at: input.now });
    finalizeAttempt(data, attempt, null);
    const written = writePersona(data, { userId: input.userId, revision: data.revision });
    return { ok: written.ok, reason: 'duplicate', persona: written.persona };
  }
  data.evidence = deduped;
  data.evidenceGeneration = token();
  const dimension = accepted[0].dimension;
  const blocked = data.blockedDimensions.includes(dimension)
    || (data.preferences[dimension] && data.preferences[dimension].pausedByUser);
  if (blocked) {
    data.pending = (data.pending || []).filter((row) => !consumed.includes(row.id));
    recordResult(data, { outcome: 'blocked', dimension, reason: 'dimension_blocked', at: input.now });
    finalizeAttempt(data, attempt, accepted[0]);
    const written = writePersona(data, { userId: input.userId, revision: data.revision });
    return { ok: written.ok, reason: 'dimension_blocked', persona: written.persona };
  }
  const previous = data.preferences[dimension] || null;
  const updated = persona.updateEvidence(previous, accepted[0], evidenceRow, {
    blockedDimensions: data.blockedDimensions,
    days: previous && previous.dayKeys,
    contexts: previous && previous.contextKeys,
  });
  const verdict = persona.decideMaturity(updated, { now: nowIso(input.now), lastFormationAt: lastFormation(data) });
  data.preferences[dimension] = { ...updated, state: verdict.state };
  if (verdict.state === 'formed' && (!previous || previous.state !== 'formed')) {
    data.recentChanges = pushChange(data.recentChanges, {
      dimension, at: nowIso(input.now), kind: previous ? 'changed' : 'formed', automatic: true, used: false, reason: verdict.reason,
    });
  }
  data.pending = (data.pending || []).filter((row) => !consumed.includes(row.id));
  /** 证据到上限后自动裁到 200 条：裁掉的如果是别维的依据，那些维度的计数也要跟着重算。 */
  if (trimEvidence(data, MAX_EVIDENCE)) {
    data.preferences[dimension] = {
      ...data.preferences[dimension],
      state: persona.decideMaturity(data.preferences[dimension], { now: nowIso(input.now), lastFormationAt: lastFormation(data) }).state,
    };
  }
  recordResult(data, { outcome: 'added', dimension, reason: verdict.state, at: input.now });
  finalizeAttempt(data, attempt, accepted[0]);
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, reason: written.ok ? 'committed' : written.reason, persona: written.persona, verdict, dimension, consumed: consumed.length };
}

/** 最近一次「形成 / 改变」的时间：形成速率限制用它，不用别的维度凑。 */
function lastFormation(data) {
  return (data.recentChanges || [])
    .filter((row) => row.kind === 'formed' || row.kind === 'changed')
    .map((row) => row.at)
    .sort()
    .pop();
}

function finalizeAttempt(data, attempt, observation) {
  data.learning.attempts = (data.learning.attempts || []).map((row) => (
    row.eventId === attempt.eventId ? { ...row, observation: observation || row.observation || null } : row
  ));
}

/**
 * 人工修改：来源标记 manual、立即形成并锁定，之后推断不再覆盖，直到用户再改或删除。
 */
export function editPersonaPreference(input = {}) {
  const dimension = input.dimension;
  if (!DIMENSIONS.includes(dimension)) return { ok: false, reason: 'unknown_dimension' };
  if (!persona.PREFERENCE_DIMENSIONS[dimension].includes(input.value)) return { ok: false, reason: 'value_not_in_dimension' };
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  const previous = data.preferences[dimension] || null;
  data.preferenceEpoch = token();
  data.preferences[dimension] = {
    ...(previous || {}), value: input.value, state: 'formed', source: 'manual', lockedByUser: true,
    pausedByUser: false, support: (previous && previous.support) || 0,
    dayKeys: (previous && previous.dayKeys) || [], contextKeys: (previous && previous.contextKeys) || [],
  };
  data.blockedDimensions = data.blockedDimensions.filter((item) => item !== dimension);
  data.recentChanges = pushChange(data.recentChanges, { dimension, at: nowIso(input.now), kind: 'manual', automatic: false, used: false, reason: 'user_edit' });
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, persona: written.persona };
}

/** 不符合我 / 暂停使用：立刻停用这一维，并挡住之后的证据队列与回放，不再自动形成。 */
export function rejectPersonaPreference(input = {}) {
  const dimension = input.dimension;
  if (!DIMENSIONS.includes(dimension)) return { ok: false, reason: 'unknown_dimension' };
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  const previous = data.preferences[dimension] || {};
  data.preferenceEpoch = token();
  data.preferences[dimension] = {
    ...previous, state: 'paused', pausedByUser: true, lockedByUser: false,
    opposition: (previous.opposition || 0) + 1,
  };
  data.blockedDimensions = [...new Set([...data.blockedDimensions, dimension])];
  data.recentChanges = pushChange(data.recentChanges, { dimension, at: nowIso(input.now), kind: 'paused', automatic: false, used: false, reason: 'user_reject' });
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, persona: written.persona };
}

/** 删掉某条证据：删完刷新证据代次，让正在跑的抽取结果直接失效。 */
/** 证据删掉后，条数/天数/情境数要跟着重算，否则面板会显示「已形成 · 依据 0」。 */
function recountDimension(data, dimension) {
  const preference = data.preferences[dimension];
  if (!preference) return;
  const previousState = preference.state;
  const rows = (data.evidence || []).filter((row) => row && row.dimension === dimension);
  /** 人工确认的取值不被推断覆盖：只把关联依据数刷新，状态与来源保持用户的选择。 */
  const next = persona.rebuildPreference(preference, rows, { dimension });
  data.preferences[dimension] = next;
  if (next.lockedByUser === true || next.source === 'manual') return;
  const lastFormationAt = lastFormation(data);
  const verdict = persona.decideMaturity(next, { now: nowIso(), lastFormationAt });
  next.state = verdict.state;
  if (verdict.state !== 'formed' && previousState === 'formed') {
    data.recentChanges.push({ dimension, at: nowIso(), kind: 'cleared', automatic: false, used: false, reason: 'evidence_removed' });
  }
}

export function retractPersonaEvidence(input = {}) {
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  const before = data.evidence.length + data.pending.length;
  const touched = new Set();
  if (input.eventId) {
    for (const row of data.evidence) if (row.eventId === input.eventId) touched.add(row.dimension);
    for (const row of data.pending) if (row.id === input.eventId) touched.add(row.dimension);
    data.evidence = data.evidence.filter((row) => row.eventId !== input.eventId);
    data.pending = data.pending.filter((row) => row.id !== input.eventId);
  } else if (input.dimension) {
    touched.add(input.dimension);
    data.evidence = data.evidence.filter((row) => row.dimension !== input.dimension);
    data.pending = data.pending.filter((row) => row.dimension !== input.dimension);
  } else {
    return { ok: false, reason: 'missing_selector' };
  }
  if (data.evidence.length + data.pending.length === before) return { ok: false, reason: 'not_found' };
  for (const dimension of touched) recountDimension(data, dimension);
  trimEvidence(data, MAX_EVIDENCE);
  data.evidenceGeneration = token();
  recordResult(data, { outcome: 'stale', reason: 'evidence_removed', at: input.now });
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, persona: written.persona };
}

/** 删除画像：清空全部偏好与证据，开关保持原状，仍然轮换代次，删过的不会复活。 */
export function clearPersona(input = {}) {
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  data.preferences = {};
  data.evidence = [];
  data.pending = [];
  data.recentChanges = [];
  data.blockedDimensions = [];
  data.learning = { lastPassAt: '', attempts: [], lastResult: null };
  data.evidenceGeneration = token();
  data.preferenceEpoch = token();
  data.control.consentEpoch = token();
  data.control.updatedAt = nowIso(input.now);
  const written = writePersona(data, { userId: input.userId, revision: data.revision });
  return { ok: written.ok, persona: written.persona };
}

/** 面板读取：已形成 / 观察中 / 最近变化，只给枚举与计数，不拼自由文本。 */
export function describePersona(input = {}) {
  const read = readPersona({ userId: input.userId });
  const data = read.persona;
  const formed = [];
  const observing = [];
  for (const dimension of DIMENSIONS) {
    const row = data.preferences[dimension];
    if (!row) continue;
    if (row.state === 'paused') continue;
    if (row.state === 'formed' && row.value) {
      formed.push({ dimension, value: row.value, source: row.source, support: row.support, lockedByUser: row.lockedByUser });
    } else if (row.state === 'observing') {
      observing.push({ dimension, ...persona.describeObserving(row) });
    }
  }
  /** 证据按维度给出最近几条，面板据此能说清「凭什么」并能逐条撤掉。 */
  const evidence = data.evidence.slice(-40).map((row) => ({
    dimension: row.dimension, eventId: row.eventId || '', at: row.at || '', date: row.date || '',
    basis: row.basis || 'explicit_feedback', polarity: row.polarity === 'oppose' ? 'oppose' : 'support',
    value: row.value || '',
  }));
  return {
    enabled: data.control.enabled, corrupt: read.corrupt, reason: read.reason,
    /** 队列长度只给数字：面板用它说明「为什么还没形成」，不暴露片段内容。 */
    pending: Array.isArray(data.pending) ? data.pending.length : 0,
    formed, observing, evidence, recentChanges: data.recentChanges.slice(-5), revision: data.revision,
    /** 最近一次整理的结果：面板说「已整理，无新偏好 / 结果格式无效」靠它。 */
    lastResult: data.learning.lastResult || null,
  };
}
