import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as state from './state.js';
import * as view from './view.js';
import * as anchor from './anchor.js';
import * as learning from './learning.js';
import { LIMITS, memoryRoot, scopeOf, globalScope } from './state.js';

/**
 * 落盘格式与预算归 state.js 管；这里只保留条目的业务规则。
 * 条数 200 是提示线，硬上限 1000 条或整层正文 512 KB；到顶把最久没读的移进归档，
 * 不拒绝新记忆（保存结果里写明动了哪条，正文保留）。单条超预算才报错。
 */
export { LIMITS, memoryRoot, scopeOf, globalScope };
/** Record types the model may pick. Anything else is a schema error, not a guess. */
export const KINDS = ['preference', 'convention', 'procedure', 'pointer', 'pitfall', 'credential_hint', 'note'];

/** Strings that mean "this is a credential", never a memory. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S{6,}/i,
  /[A-Za-z0-9+/]{60,}={0,2}/,
];

/** A summary is a noun phrase. An imperative turns a note into an instruction. */

const SUGGESTION_ID = /^sug_[a-z0-9]{6,}$/;

/**
 * 旧版把超长摘要的原文托管在正文末尾，用这个标记分隔。
 * 现在只拿它做保守识别：旧正文可以标记待整理，但绝不改写；新写入也不再产生尾巴。
 */
const LEGACY_SUMMARY_TAIL = '摘要原文：';

/**
 * 实验来源的条目默认不属于普通记忆读取面：开关关闭、暂停或身份未知时，
 * 老 ID、病史查询和关联跳转都不能把正文带出来。管理面显式传 allowExperimental。
 */
export const EXPERIMENTAL_ORIGIN = 'project_evolution';
/** 谁写下当前这版正文：只有这几种，别把猜测当事实。 */
export const ORIGINS = ['user_explicit', 'model_drafted', EXPERIMENTAL_ORIGIN];

function originOf(source) {
  const value = source && (source.origin || source.source);
  return ORIGINS.includes(value) ? value : 'user_explicit';
}

export function isExperimentalRecord(record) {
  if (!record) return false;
  return record.origin === EXPERIMENTAL_ORIGIN
    || record.source === EXPERIMENTAL_ORIGIN
    || Boolean(record.learning);
}

function readableRecord(record, options, index) {
  if (!isExperimentalRecord(record)) return true;
  /** 实验来源只在带本请求上下文时放行；开关打开不等于全局可见。 */
  return !!(options && options.allowExperimental === true);
}

/** 正文缓存：一次读到的正文先放这里，saveIndex 落盘后清掉。 */
const bodyCache = new Map();

function cacheBodies(scope, entries) {
  const map = new Map();
  for (const entry of entries) {
    const body = entry.current && entry.current.body;
    /** 空正文不进缓存：归档条目的正文可能冷存，读取时要能回冷存兜底。 */
    if (typeof body === 'string' && body !== '') map.set(entry.id, body);
  }
  bodyCache.set(scope.dir, map);
}

function cachedBody(scope, id) {
  const map = bodyCache.get(scope.dir);
  if (!map || !map.has(id)) return undefined;
  return map.get(id);
}

/** 深拷贝 JSON 形状，避免扁平记录和权威条目共享引用。 */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** v2 条目 → 旧扁平记录：业务层只认这一种形状。 */
function toFlat(entry) {
  const current = entry.current || {};
  const maintenance = entry.maintenance || {};
  return {
    id: entry.id,
    title: current.title || '',
    summary: current.summary || '',
    /** 超长摘要的完整原句单独托管，不进正文；平铺出来供保存路径与回执核对。 */
    summaryFull: typeof maintenance.summaryFull === 'string' ? maintenance.summaryFull : '',
    when: current.when || '',
    body: typeof current.body === 'string' ? current.body : '',
    kind: current.kind || 'note',
    tags: Array.isArray(current.keywords) ? [...current.keywords] : [],
    topicKey: current.topicKey || '',
    aliases: Array.isArray(maintenance.retiredNames) ? [...maintenance.retiredNames] : [],
    triggers: Array.isArray(current.triggers) ? [...current.triggers] : [],
    applicability: current.applicability || 'all_in_scope',
    conditions: Array.isArray(current.conditions) ? JSON.parse(JSON.stringify(current.conditions)) : [],
    selection: current.selection ? JSON.parse(JSON.stringify(current.selection)) : null,
    links: Array.isArray(current.links) ? current.links.map((link) => ({ type: link.type || 'related', id: link.id })) : [],
    reviewState: maintenance.reviewState || 'active',
    created: entry.createdAt || '',
    updated: entry.updatedAt || '',
    validFrom: typeof entry.validFrom === 'string' && entry.validFrom ? entry.validFrom : (entry.createdAt || ''),
    validUntil: typeof entry.validUntil === 'string' ? entry.validUntil : '',
    supersededBy: typeof entry.supersededBy === 'string' ? entry.supersededBy : '',
    supersedeReason: typeof entry.supersedeReason === 'string' ? entry.supersedeReason : '',
    lastUsed: maintenance.lastUsed || entry.updatedAt || entry.createdAt || '',
    /** 是否真被用过（送达模型并记账过）；`lastUsed` 有创建/更新时间回退值，不能拿它判断「从未读过」。 */
    used: maintenance.everUsed === true
      || Boolean(maintenance.lastUsed && maintenance.lastUsed !== entry.createdAt && maintenance.lastUsed !== entry.updatedAt),
    revision: Number(entry.revision) || 1,
    status: entry.status === 'archived' ? 'archived' : 'active',
    origin: ORIGINS.includes(entry.origin) ? entry.origin : 'user_explicit',
    ownerProjectId: typeof entry.ownerProjectId === 'string' ? entry.ownerProjectId : '',
    hits: Number(maintenance.hits) || 0,
    merges: Number(maintenance.merges) || 0,
    versions: Array.isArray(maintenance.versions) ? cloneJson(maintenance.versions) : [],
    sourceRefs: Array.isArray(maintenance.sourceRefs) ? cloneJson(maintenance.sourceRefs) : [],
    checks: Array.isArray(maintenance.checks) ? cloneJson(maintenance.checks) : [],
    learning: cloneJson(maintenance.learning) || null,
    /** 权威 maintenance 的完整副本：整层写回时不能只按白名单重建。 */
    maintenance: cloneJson(maintenance) || {},
    bytes: entrySize({ title: current.title, summary: current.summary, when: current.when, tags: current.keywords, triggers: current.triggers, topicKey: current.topicKey, applicability: current.applicability, conditions: current.conditions, selection: current.selection, links: current.links }, current.body || ''),
  };
}

function fromFlat(record, status) {
  const at = record.updated || record.created || new Date().toISOString();
  const entry = {
    id: record.id,
    revision: Number(record.revision) || 1,
    status: status || (record.status === 'archived' ? 'archived' : 'active'),
    origin: ORIGINS.includes(record.origin) ? record.origin : 'user_explicit',
    ownerProjectId: record.ownerProjectId || '',
    createdAt: record.created || at,
    updatedAt: at,
    validFrom: typeof record.validFrom === 'string' && record.validFrom ? record.validFrom : (record.created || at),
    validUntil: typeof record.validUntil === 'string' ? record.validUntil : '',
    supersededBy: typeof record.supersededBy === 'string' ? record.supersededBy : '',
    supersedeReason: typeof record.supersedeReason === 'string' ? record.supersedeReason : '',
    current: {
      title: record.title || '',
      summary: record.summary || '',
      body: typeof record.body === 'string' ? record.body : '',
      kind: record.kind || 'note',
      when: record.when || '',
      keywords: Array.isArray(record.tags) ? [...record.tags] : [],
      topicKey: record.topicKey || '',
      triggers: Array.isArray(record.triggers) ? [...record.triggers] : [],
      applicability: record.applicability || 'all_in_scope',
      conditions: Array.isArray(record.conditions) ? JSON.parse(JSON.stringify(record.conditions)) : [],
      selection: record.selection ? JSON.parse(JSON.stringify(record.selection)) : null,
      links: Array.isArray(record.links) ? record.links.map((link) => ({ type: link.type || 'related', id: link.id })) : [],
      aliases: [],
    },
    maintenance: {
      ...(cloneJson(record.maintenance) || {}),
      reviewState: record.reviewState === 'legacy_unreviewed' ? 'legacy_unreviewed' : 'active',
      sourceRefs: Array.isArray(record.sourceRefs) ? cloneJson(record.sourceRefs)
        : Array.isArray(record.maintenance?.sourceRefs) ? cloneJson(record.maintenance.sourceRefs) : [],
      retiredNames: Array.isArray(record.aliases) ? [...record.aliases] : [],
      versions: Array.isArray(record.versions) ? cloneJson(record.versions) : [],
      checks: Array.isArray(record.checks) ? cloneJson(record.checks)
        : Array.isArray(record.maintenance?.checks) ? cloneJson(record.maintenance.checks) : [],
      learning: cloneJson(record.learning) || cloneJson(record.maintenance?.learning) || undefined,
      hits: Number(record.hits) || 0,
      merges: Number(record.merges) || 0,
      everUsed: record.everUsed === true || (record.maintenance && record.maintenance.everUsed === true),
      lastUsed: record.lastUsed || at,
    },
  };
  /** 完整摘要是维护区字段：显式给了就覆盖，给了空串就清掉，不给则沿用旧值。 */
  if (Object.prototype.hasOwnProperty.call(record, 'summaryFull')) {
    const full = typeof record.summaryFull === 'string' ? record.summaryFull : '';
    if (full) entry.maintenance.summaryFull = full;
    else delete entry.maintenance.summaryFull;
  }
  return entry;
}

/**
 * 读一层：v2 状态是唯一权威。旧 index.json 只在迁移时读，读不到正文的旧条目
 * 由 state.js 拦成报告，这里不猜、不补空正文。
 */
export function loadIndex(scope, options = {}) {
  if (!options.readOnly && !fs.existsSync(path.join(scope.dir, 'state.json'))) {
    const report = state.migrationReport(scope);
    if (report.required || report.adoptable.length) state.migrateLegacy(scope);
  }
  const loaded = state.load(scope, options);
  const entries = loaded.state.entries.filter((entry) => entry.status === 'active').map(toFlat);
  /**
   * 归档条目只加载元数据，正文留在冷存里按需读：列表、图谱、宫殿、snapshot 都
   * 不该为了显示标题去读归档正文，更不能因为某个旧归档缺冷存就把整层读失败。
   */
  const archived = loaded.state.entries.filter((entry) => entry.status === 'archived').map((entry) => {
    const record = toFlat(entry);
    record.cold = Boolean(entry.maintenance && entry.maintenance[COLD_MARK]);
    record.coldBody = '';
    return record;
  });
  cacheBodies(scope, loaded.state.entries);
  const index = {
    version: 2,
    scope: loaded.state.scopeKey,
    cwd: typeof loaded.state.cwd === 'string' ? loaded.state.cwd : '',
    generation: loaded.state.generation,
    epoch: loaded.state.epoch,
    entries,
    archived,
    suggestions: JSON.parse(JSON.stringify(loaded.state.candidates || [])),
    receipts: JSON.parse(JSON.stringify(loaded.state.receipts || [])),
    lastSuggestedAt: loaded.state.lastSuggestedAt || '',
    suppressions: JSON.parse(JSON.stringify(loaded.state.suppressions || [])),
    conflicts: JSON.parse(JSON.stringify(loaded.state.conflicts || [])),
    __evolution: state.evolutionOf(loaded.state),
    __tasks: anchor.normalizeTasks(state.evolutionOf(loaded.state).tasks),
    __control: state.controlOf(loaded.state),
    __exists: loaded.exists === true,
    __recovery: loaded.recovery || null,
  };
  index.__meta = {
    exists: loaded.exists,
    generation: loaded.state.generation,
    epoch: loaded.state.epoch,
    storeId: loaded.state.storeId || '',
  };
  return index;
}

/** 扁平索引 → v2 状态：整层重写，条目、候选、回执一次换完。 */
function applyFlat(scope, draft, index) {
  const next = [];
  for (const record of index.entries) next.push(fromFlat(record));
  /** 归档正文不写回热状态：先落冷存再摘空，冷存写失败就整次保存失败，不丢正文。 */
  for (const record of index.archived || []) next.push(fromFlat(coldStored(scope, record), 'archived'));
  draft.entries = next;
  draft.candidates = Array.isArray(index.suggestions) ? JSON.parse(JSON.stringify(index.suggestions)) : [];
  /** 每次写入顺手清过期回执：只有接受候选才清的话，不产候选的层会一直留着过期的。 */
  draft.receipts = pruneReceiptList(Array.isArray(index.receipts) ? JSON.parse(JSON.stringify(index.receipts)) : []);
  draft.suppressions = Array.isArray(index.suppressions) ? JSON.parse(JSON.stringify(index.suppressions)) : [];
  draft.conflicts = Array.isArray(index.conflicts) ? JSON.parse(JSON.stringify(index.conflicts)) : [];
  draft.lastSuggestedAt = typeof index.lastSuggestedAt === 'string' ? index.lastSuggestedAt : draft.lastSuggestedAt || '';
  draft.scopeKey = draft.scopeKey || index.scope;
}

/**
 * 写一层：一个事务发布整份状态。容量在事务里裁决，腾位结果回填到 index.archived，
 * 调用方据此在结果里点名。
 */
export function saveIndex(scope, index) {
  const meta = index.__meta || { exists: false };
  const expected = meta.exists ? { generation: meta.generation, epoch: meta.epoch } : null;
  const result = state.transact(scope, { expected, expectCreate: !meta.exists }, (draft) => {
    const stamp = () => JSON.stringify([draft.entries, draft.candidates, draft.receipts, draft.suppressions, draft.conflicts, draft.lastSuggestedAt]);
    const before = stamp();
    applyFlat(scope, draft, index);
    const after = stamp();
    return { changed: before !== after };
  });
  const published = result.state;
  const byId = new Map(published.entries.map((entry) => [entry.id, entry]));
  index.entries = index.entries.filter((record) => {
    const entry = byId.get(record.id);
    return entry && entry.status === 'active';
  });
  index.archived = index.archived || [];
  for (const evicted of result.archived) {
    const record = index.entries.find((item) => item.id === evicted.id);
    if (record) index.entries = index.entries.filter((item) => item.id !== record.id);
    if (!index.archived.some((item) => item.id === evicted.id)) index.archived.push({ id: evicted.id, title: evicted.title, status: 'archived' });
  }
  index.generation = published.generation;
  index.epoch = published.epoch;
  index.__archived = result.archived;
  index.__meta = { exists: true, generation: published.generation, epoch: published.epoch };
  cacheBodies(scope, published.entries);
  return index;
}

function withLock(scope, fn) {
  return state.withScopeLock(scope, fn);
}

/** Locks several scopes in a stable order, so search across layers cannot deadlock. */
function withLocks(scopes, fn) {
  const unique = [];
  for (const scope of scopes) if (!unique.some((item) => item.dir === scope.dir)) unique.push(scope);
  unique.sort((a, b) => a.dir.localeCompare(b.dir));
  const run = (index) => (index === unique.length ? fn() : withLock(unique[index], () => run(index + 1)));
  return run(0);
}

export function detectSecret(text) {
  const hit = SECRET_PATTERNS.find((re) => re.test(String(text || '')));
  return hit ? hit.source : null;
}

export function normalizeText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 超限就报错，不 slice：写的人要自己决定删哪句，存进来的东西要完整。 */
function textField(value, max, label) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new Error(`${label}超过 ${max} 字，先写短些`);
  return text;
}

/**
 * 标题就是身份，只做无损空白规范化：不切分隔符、不剥条件、不去标点。
 * 超长在 textField 里直接报错，不截断；标题写坏了是调用方的输入问题，不能靠改名字掩盖。
 */
function cleanTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function validSummary(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.summaryChars);
  if (!text) return { ok: false, reason: '摘要为空' };
  return { ok: true, text };
}

/**
 * 所有落盘入口共用的唯一草稿结构与校验：直接保存、提出建议、点 keep 都从这里过。
 * 凭据检查覆盖全部文本字段；正文按 UTF-8 字节检查，不做语义截断。
 * `has` 记录调用方到底提供了哪些字段，更新时没提供的保持原值。
 */
export function normalizeDraft(source, options = {}) {
  const draft = typeof source === 'string' ? { title: source } : source && typeof source === 'object' ? source : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(draft, key) && draft[key] !== undefined;
  const id = typeof draft.id === 'string' && /^mem_[a-z0-9]+$/.test(draft.id) ? draft.id : '';
  if (has('id') && !id) throw new Error('id 格式不对');
  if (has('supersedes') && !/^mem_[a-z0-9]+$/.test(String(draft.supersedes ?? ''))) throw new Error('supersedes 要给被取代的 id');
  const when = has('when') ? textField(draft.when, LIMITS.whenChars, '前置条件') : '';
  const title = textField(cleanTitle(draft.title), LIMITS.titleChars, '标题');
  /** 带 id 是更新：省略的字段保持原值，标题也一样。 */
  const mayOmitTitle = Boolean(id);
  if (!title && !mayOmitTitle) throw new Error('标题为空');
  let summary = '';
  let summaryShortened = false;
  const rawSummary = String(draft.summary ?? '').replace(/\s+/g, ' ').trim();
  if (rawSummary) {
    const check = validSummary(rawSummary);
    if (!check.ok) throw new Error(check.reason);
    summary = check.text;
    summaryShortened = summary.length < rawSummary.length;
  } else if (has('summary')) {
    throw new Error('摘要为空');
  }
  /** 更新（带 id）与候选草稿允许省略摘要；省略表示保持原值，不拿标题补。 */
  const mayOmitSummary = options.requireSummary === false || Boolean(id);
  if (!summary && !mayOmitSummary) throw new Error('摘要为空');
  /**
   * 正文只属于调用方显式给出的内容：摘要超长时不再往正文里塞托管尾巴，
   * 完整原句单独进维护区（maintenance.summaryFull），正文保持原样。
   */
  const bodyExplicit = has('body');
  const body = bodyExplicit ? String(draft.body ?? '').trim() : '';
  const summaryFull = summaryShortened ? rawSummary : '';
  const bodyBytes = Buffer.byteLength(body);
  /** 预算按真正会存进去的正文 + 完整摘要算：超限就报错，不截断后谎报成功。 */
  const storedBytes = bodyBytes + Buffer.byteLength(summaryFull);
  if (storedBytes > LIMITS.entryBytes) {
    throw new Error(summaryFull
      ? `正文 ${bodyBytes} 字节加完整摘要 ${Buffer.byteLength(summaryFull)} 字节，超过单条 ${LIMITS.entryBytes} 字节；先拆成两条写，别丢后半段`
      : `正文 ${bodyBytes} 字节，超过单条 ${LIMITS.entryBytes} 字节；只留原则、判断规则和触发条件`);
  }
  const kind = has('kind') ? textField(draft.kind, 20, '类型') : 'note';
  if (kind && !KINDS.includes(kind)) throw new Error(`类型只能是 ${KINDS.join(' / ')}`);
  const rawTags = has('tags') ? draft.tags : [];
  if (!Array.isArray(rawTags)) throw new Error('标签必须是数组');
  if (rawTags.length > LIMITS.tags) throw new Error(`标签最多 ${LIMITS.tags} 个`);
  const tags = [...new Set(rawTags.map((tag) => textField(tag, LIMITS.tagChars, '标签')).filter(Boolean))];
  /** 结构化字段只走白名单：模型给什么就校验什么，绝不从措辞里推断。 */
  const triggers = view.normalizeTriggers(draft.triggers);
  const conditions = view.normalizeConditions(draft.conditions);
  const selection = view.normalizeSelection(draft.selection);
  const links = view.normalizeLinks(draft.links, id);
  const applicability = view.normalizeApplicability(draft.applicability);
  const topicKey = has('topicKey') ? textField(draft.topicKey, LIMITS.tagChars, '主题') : undefined;
  /** 凭据扫描必须覆盖完整原文：截短后的摘要看不出凭据，原文里有也不行。 */
  const secret = detectSecret([title, summary, rawSummary, when, body, tags.join(' '), topicKey || ''].join('\n'));
  if (secret) throw new state.StateError('unsafe', `疑似凭据（${secret}），只记位置，不记值：正文里写「去哪取、怎么取」，不抄值`);
  return {
    id,
    title,
    summary,
    when,
    body,
    summaryShortened,
    summaryRaw: rawSummary,
    summaryFull,
    /** 回执字段：完整原句已另存维护区（不是塞进正文）。 */
    fullTextSaved: Boolean(summaryFull),
    /** 兼容旧回执：正文里从来没有托管尾巴，这个字段恒为 false。 */
    fullTextInBody: false,
    kind: kind || 'note',
    tags,
    triggers,
    conditions,
    selection,
    links,
    applicability,
    topicKey,
    /** 显式取代：新记录写好后再给旧记录打 supersededBy/validUntil。 */
    supersedes: has('supersedes') ? textField(draft.supersedes, 60, '取代目标') : '',
    has: {
      title: has('title') && Boolean(title),
      summary: has('summary'),
      when: has('when'),
      body: bodyExplicit,
      kind: has('kind'),
      tags: has('tags'),
      triggers: triggers !== undefined,
      conditions: conditions !== undefined,
      selection: selection !== undefined,
      links: links !== undefined,
      applicability: applicability !== undefined,
      topicKey: topicKey !== undefined,
      supersedes: has('supersedes'),
    },
  };
}

function newId() {
  return `mem_${crypto.randomBytes(6).toString('hex')}`;
}

/** 正文就在状态里；缓存只是省一次读盘，得手时一律回状态读。 */
function readBody(scope, id) {
  const cached = cachedBody(scope, id);
  if (typeof cached === 'string' && cached !== '') return cached;
  const found = state.readEntryBody(scope, id);
  if (!found) throw new Error(`记忆正文缺失：${id} 在索引里，但正文文件不在了`);
  /**
   * 归档正文不在热状态里：只有真要读这一条正文时才回冷存取，
   * 缺文件/坏文件都报明确错误，不拿空正文冒充「这条没有正文」。
   */
  if (!found.body && found.entry && found.entry.status === 'archived') {
    let payload = null;
    try {
      payload = readCold(scope, id, { required: true });
    } catch (error) {
      /** 旧版归档在正文为空时可能没写过冷存：这类老记录按空正文读回，不改写也不再报错。 */
      const legacy = !(found.entry.maintenance && found.entry.maintenance.coldSaved === true);
      if (!(legacy && error && error.code === 'cold_missing')) throw error;
    }
    if (payload && typeof payload.body === 'string' && payload.body) {
      writeBody(scope, id, payload.body);
      return payload.body;
    }
  }
  return found.body;
}

function writeBody(scope, id, body) {
  const map = bodyCache.get(scope.dir) || new Map();
  map.set(id, body);
  bodyCache.set(scope.dir, map);
}

function removeBody(scope, id) {
  const map = bodyCache.get(scope.dir);
  if (map) map.delete(id);
}

/**
 * 归档正文冷存：热状态只留元数据，正文和旧版本正文放 scope.dir/cold/<id>.json。
 * 五百条归档 ≈ 2 MiB 时，只有真看过的那几条会回到内存，保存不再被整层预算卡死。
 */
const COLD_DIR = 'cold';
const COLD_MARK = 'coldBody';

function coldDirOf(scope) {
  return path.join(scope.dir, COLD_DIR);
}

function coldFileOf(scope, id) {
  return path.join(coldDirOf(scope), `${id}.json`);
}

function coldPayload(scope, record) {
  return {
    /** 冷存文件自带身份：读回来先核对是不是这一条、这一层，不靠文件名猜。 */
    id: record.id,
    scope: scope.key,
    revision: Number(record.revision) || 1,
    at: new Date().toISOString(),
    body: typeof record.body === 'string' ? record.body : '',
    versions: (Array.isArray(record.versions) ? record.versions : [])
      .map((version) => ({ at: String((version && version.at) || ''), body: typeof (version && version.body) === 'string' ? version.body : '' }))
      .filter((version) => version.body),
  };
}

/**
 * 冷存写失败就报错：宁可整次保存失败，也不能把正文悄悄丢掉。
 * 落盘序列与 state.json 一致（fsync 文件 → rename → fsync 目录）：归档正文只在这里，
 * 少一步 fsync，崩溃后就是「热状态说有归档、冷存文件是空的」。
 */
function writeCold(scope, record) {
  const file = coldFileOf(scope, record.id);
  try {
    state.writeDurable(file, `${JSON.stringify(coldPayload(scope, record))}\n`);
  } catch (error) {
    throw new state.StateError('unavailable', `归档正文没写进冷存（${path.basename(file)}）：${(error && error.message) || 'IO 错误'}`);
  }
}

/**
 * 读冷存：文件缺失时按 required 决定返回 null 还是报错；JSON 损坏、身份不符
 * 一律抛明确错误，绝不静默返回空正文冒充「这条没有正文」。
 */
function readCold(scope, id, options = {}) {
  const required = options.required === true;
  const file = coldFileOf(scope, id);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (!required) return null;
      throw new state.StateError('cold_missing', `冷存里没有这条的正文备份（${file}）；先修复冷存再读，不拿空正文顶上`);
    }
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new state.StateError('cold_corrupt', `冷存文件不是合法 JSON（${file}）；先修复再读，不拿空正文顶上`);
  }
  if (!payload || typeof payload !== 'object' || payload.id !== id || payload.scope !== scope.key || typeof payload.body !== 'string') {
    throw new state.StateError('cold_corrupt', `冷存文件记录的条目不匹配这一条或这一层（${file}）；先修复再读，不拿空正文顶上`);
  }
  return payload;
}

/** 写回状态前把归档正文摘出去：只有正文/旧版本真变了才重写冷存文件。 */
function coldStored(scope, record) {
  if (record.status !== 'archived') return record;
  const versions = Array.isArray(record.versions) ? record.versions : [];
  const hasVersionBodies = versions.some((version) => typeof (version && version.body) === 'string' && version.body);
  /** 内存记录的正文可能已经是空串（占位/摘过）：先按 coldBody、冷存文件、热状态顺序找回。 */
  let body = typeof record.body === 'string' ? record.body : '';
  const known = typeof record.coldBody === 'string' ? record.coldBody : null;
  if (body || known !== null) {
    body = body || known;
  } else {
    /** 冷存是唯一权威副本；它坏了先退回热状态里的正文（保存时会重写成好文件），两处都没有才报错。 */
    let coldError = null;
    try {
      const payload = readCold(scope, record.id);
      if (payload && typeof payload.body === 'string' && payload.body) body = payload.body;
    } catch (error) {
      coldError = error;
    }
    if (!body) {
      const found = state.readEntryBody(scope, record.id);
      if (found && typeof found.body === 'string') body = found.body;
    }
    if (coldError && !body) throw coldError;
  }
  /** 正文和冷存里的一致就不重写：五百条归档每次保存只动真变过的那几条。 */
  const cached = record.cold === true && known !== null && known === body;
  /** 空正文也要落一份冷存：只要标了 coldBody，就必须有自证身份的文件可读回。 */
  if (!cached) writeCold(scope, { ...record, body });
  return {
    ...record,
    body: '',
    cold: true,
    coldBody: body,
    versions: versions.map((version) => ({ ...(version || {}), body: '' })),
    maintenance: { ...(record.maintenance || {}), [COLD_MARK]: true, coldSaved: true },
  };
}

/**
 * 彻底删除是一个事务：先把要删的冷存文件按 id 精确移到层外的隔离区
 * （state.purge 只扫 scope.dir，所以隔离区必须在层外），state.purge 成功后才丢弃隔离副本；
 * 失败按错误类型恢复或留待重放收尾。绝不按标题/正文片段扫描别人的冷存文件。
 */
const PURGE_TRASH_DIR = '.purge-trash';

function trashDirOf(scope) {
  const safe = String(scope.key || '').replace(/[^A-Za-z0-9._-]/g, '_') || '_';
  return path.join(memoryRoot(), PURGE_TRASH_DIR, safe);
}

/** 只搬走 ids 对应的 <id>.json；别的条目一个字节都不动。 */
function isolateCold(scope, ids, operationId) {
  const token = String(operationId || '').replace(/[^A-Za-z0-9._-]/g, '_') || crypto.randomBytes(8).toString('hex');
  const dir = path.join(trashDirOf(scope), token);
  const moved = [];
  for (const id of ids || []) {
    const from = coldFileOf(scope, id);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(dir, { recursive: true });
    const to = path.join(dir, `${id}.json`);
    fs.renameSync(from, to);
    moved.push({ from, to });
  }
  return { dir, moved };
}

function restoreCold(isolated) {
  let restored = true;
  for (const row of isolated.moved) {
    try {
      fs.renameSync(row.to, row.from);
    } catch {
      /** 恢复失败就保留整个隔离区：副本还在，重放/人工都能取回，不能顺手删掉。 */
      restored = false;
    }
  }
  if (restored) dropColdQuarantine(isolated);
}

function dropColdQuarantine(isolated) {
  try {
    fs.rmSync(isolated.dir, { recursive: true, force: true });
  } catch {
    /** 删不掉隔离目录不影响删除结果，下次收尾再清。 */
  }
}

/** 删除确认后的收尾：清掉这一层隔离区里残留的副本（上一次做到一半留下的）。 */
function cleanColdQuarantine(scope) {
  try {
    fs.rmSync(trashDirOf(scope), { recursive: true, force: true });
  } catch {
    /** 收尾清不掉不影响数据正确性。 */
  }
}

/**
 * 删除与冷存的一致顺序：隔离 → 发布删除 → 丢弃隔离副本。
 * 发布失败（例如 purge_pending）时保留隔离副本，留给重放路径收尾。
 */
function purgeWithCold(scope, ids, run) {
  const isolated = isolateCold(scope, ids);
  try {
    const result = run();
    dropColdQuarantine(isolated);
    return result;
  } catch (error) {
    if (error && error.code === 'purge_pending') throw error;
    restoreCold(isolated);
    throw error;
  }
}

function entrySize(record, body) {
  const meta = [record.title || '', record.summary || '', record.when || '', (record.tags || []).join(',')].join('\n');
  return Buffer.byteLength(meta) + Buffer.byteLength(body || '') + Buffer.byteLength(state.fieldsBytesOf(record));
}

function recordSize(record) {
  return Buffer.byteLength(JSON.stringify({ ...record, versions: [] }));
}

function activeBytes(index, skipId) {
  return index.entries.reduce((sum, item) => (item.id === skipId ? sum : sum + (item.bytes || 0)), 0);
}

/** 归档不是删除：条目标成 archived，正文与旧版本原样留在状态里，检索与提示不再返回。 */
function archiveEntry(scope, index, entry) {
  const body = readBody(scope, entry.id);
  entry.status = 'archived';
  entry.body = body;
  index.entries = index.entries.filter((item) => item.id !== entry.id);
  index.archived = [...(index.archived || []), entry];
  writeBody(scope, entry.id, body);
}

/**
 * 条数 200 是提示线，不是墙：到 1000 条或正文预算将满时才腾位置。
 * capacityOf 同时给出字节余量，调用方能说清是条数还是正文先到顶。
 */
export function capacityOf(scope, index) {
  const cap = scope.key === 'global' ? LIMITS.globalEntries : LIMITS.entries;
  const used = index.entries.length;
  const bytes = index.entries.reduce((sum, item) => sum + (item.bytes || 0), 0);
  return {
    cap,
    hard: LIMITS.hardEntries,
    used,
    remaining: Math.max(0, cap - used),
    bytes,
    bytesLeft: Math.max(0, LIMITS.totalBytes - bytes),
  };
}

/** 相邻两字为一组：中文没有空格，按词切分永远对不上，按字片才认得出改写的同一件事。 */
function bigrams(text) {
  const plain = normalizeText(text, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!plain) return new Set();
  if (plain.length < 2) return new Set([plain]);
  const out = new Set();
  for (let i = 0; i + 1 < plain.length; i += 1) out.add(plain.slice(i, i + 2));
  return out;
}

/** 只靠这类高频两字词重合不算相关：查询里的实词必须自己命中。 */
const STOP_GRAMS = new Set([
  '这个', '那个', '怎么', '什么', '可以', '需要', '我们', '你们', '一下', '现在',
  '然后', '还是', '就是', '已经', '没有', '不是', '要是', '如果', '因为', '所以',
  '的话', '这里', '那里', '一个', '一些', '这样', '那样', '看看', '帮我看', '继续',
]);

/** 英文整词规则只有一份，放在 view：自动召回和手动搜索必须同一个判断。 */
const asciiWordsOf = view.asciiWordsOf;
const wordIn = view.wordIn;

/** 查询按空格/标点切成段：多段按关键词处理，整句仍按相关度处理。 */
function queryRuns(query) {
  return normalizeText(query, 400)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
}

function fieldText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 多段查询里，条目至少要在一段上过半命中，且命中段不能只是孤零零一个两字词；
 * 否则「插件市场」这种东西只要沾了个「插件」就会挤进结果。
 */
function matchesRun(item, runs) {
  const pool = [
    item.title,
    (item.aliases || []).join(' '),
    (item.tags || []).join(' '),
    (item.triggers || []).join(' '),
    item.summary,
    item.when,
  ].map(fieldText).join('\n');
  let qualified = 0;
  let substantial = 0;
  for (const run of runs) {
    /** 英文按整词匹配：git 不能因为共享 gi/it 就命中 digital。 */
    if (/^[a-z][a-z0-9_-]+$/.test(run)) {
      if (!wordIn(pool, run)) continue;
      qualified += 1;
      substantial += 1;
      continue;
    }
    const grams = bigrams(run);
    if (grams.size === 0) continue;
    let hit = 0;
    for (const gram of grams) if (pool.includes(gram)) hit += 1;
    if (hit === 0) continue;
    const full = hit === grams.size;
    const half = hit >= 2 && hit * 2 >= grams.size;
    if (!full && !half) continue;
    qualified += 1;
    if (hit >= 2) substantial += 1;
  }
  return substantial >= 1 || qualified >= 2;
}

export function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** 身份比较只认给定的语义字段：没给的字段不参与，不拿默认值把两条规则并成一条。 */
const hasField = (draft, key) => (draft && draft.has && typeof draft.has === 'object'
  ? draft.has[key] === true
  : Boolean(draft) && draft[key] !== undefined);

const selectionKeyOf = (selection) => {
  if (!selection) return '';
  const items = Array.isArray(selection.items) ? [...selection.items].map(String).sort() : [];
  return JSON.stringify([selection.mode || '', selection.artifactKey || '', items]);
};

const triggerKeyOf = (row) => JSON.stringify([...(row.triggers || [])].map(String).sort());

const linkKeyOf = (row) => JSON.stringify([...(row.links || [])]
  .map((link) => [String(link.type || 'related'), String(link.id)])
  .sort((a, b) => a[1].localeCompare(b[1])));

/** 适用范围仍是推断出来的值也算数：显式写 conditional 与靠条件推出来的是同一档。 */
function applicabilityOf(row) {
  return view.validateApplicability(row.applicability, row.conditions || [], row.selection || null, row.when || '');
}

/**
 * 身份 = 标题/旧标题 + 前置条件 + 这次真正给出的适用范围字段。
 * 不同机器、不同运行时的规则即使同名也是两条；没给的字段保持兼容，不误判成另一条。
 */
export function resolveTarget(entries, draft, whenArg) {
  const source = typeof draft === 'string' ? { title: draft, when: whenArg } : draft || {};
  const title = normalizeText(source.title, LIMITS.titleChars);
  const when = normalizeText(source.when, LIMITS.whenChars);
  const plain = title.toLowerCase();
  for (const item of entries) {
    if ((item.when || '') !== when) continue;
    if (hasField(source, 'conditions') && view.conditionsKey(item.conditions) !== view.conditionsKey(source.conditions)) continue;
    if (hasField(source, 'selection') && selectionKeyOf(item.selection) !== selectionKeyOf(source.selection)) continue;
    if (hasField(source, 'triggers') && triggerKeyOf(item) !== triggerKeyOf(source)) continue;
    if (hasField(source, 'applicability') && applicabilityOf(item) !== applicabilityOf(source)) continue;
    const names = [item.title, ...(item.aliases || [])].map((name) => String(name || '').toLowerCase());
    if (names.includes(plain)) return { target: item, score: 1 };
  }
  return null;
}

/** 相近线只用于「提示 / 候选」，与合并无关。 */
export const MERGE = { near: 0.3 };

/** 最多两条最接近的条目：看得到具体 id 和标题，才有可能选对。 */
export function similarEntries(entries, title, summary, limit = 2) {
  const rows = [];
  for (const item of entries) {
    const names = [item.title, ...(item.aliases || [])];
    const titleScore = Math.max(0, ...names.map((name) => similarity(name, title)));
    const summaryScore = similarity(item.summary, summary);
    const score = Math.max(titleScore, summaryScore);
    if (score >= MERGE.near) rows.push({
      id: item.id,
      title: item.title,
      summary: item.summary,
      when: item.when || '',
      /** 候选要能自己解释「为什么像」：标题相近，还是同一主题槽位。 */
      updated: item.updated || item.created || '',
      reason: titleScore >= MERGE.near ? 'similar_title' : 'similar_summary',
      score,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

/** 候选更新目标：标题相近还不够，应用范围和条件也必须一致，否则保留会改错条目。 */
export function similarTarget(entries, draft) {
  const rows = similarEntries(entries, draft.title, draft.summary, 2);
  const compatible = rows.filter((row) => {
    const item = entries.find((entry) => entry.id === row.id);
    if (!item) return false;
    if (hasField(draft, 'conditions') && view.conditionsKey(item.conditions) !== view.conditionsKey(draft.conditions)) return false;
    if (hasField(draft, 'selection') && selectionKeyOf(item.selection) !== selectionKeyOf(draft.selection)) return false;
    if (hasField(draft, 'applicability') && applicabilityOf(item) !== applicabilityOf(draft)) return false;
    if (hasField(draft, 'triggers') && triggerKeyOf(item) !== triggerKeyOf(draft)) return false;
    if (hasField(draft, 'topicKey') && (item.topicKey || '') !== (draft.topicKey || '')) return false;
    return true;
  });
  return compatible[0] || null;
}

/** 没有合并时，把最接近的那条报出来：看得到，才有可能纠正。 */
export function nearestEntry(entries, title, summary) {
  return similarEntries(entries, title, summary, 1)[0] || null;
}

/** 旧版本整段保留，字段齐全，恢复时可以连标题与条件一起还原。
 *  空正文也是合法版本：从空正文改成有正文，撤销必须回到空，而不是当成新建去归档。 */
function snapshot(record, body) {
  const version = {
    at: record.updated || record.created || new Date().toISOString(),
    title: record.title,
    summary: record.summary,
    summaryFull: typeof record.summaryFull === 'string' ? record.summaryFull : '',
    when: record.when || '',
    kind: record.kind || 'note',
    tags: [...(record.tags || [])],
    triggers: [...(record.triggers || [])],
    applicability: record.applicability || 'all_in_scope',
    conditions: JSON.parse(JSON.stringify(record.conditions || [])),
    selection: record.selection ? JSON.parse(JSON.stringify(record.selection)) : null,
    links: (record.links || []).map((link) => ({ type: link.type || 'related', id: link.id })),
    topicKey: record.topicKey || '',
    body,
  };
  let kept = [...(record.versions || []), version].slice(-2);
  while (kept.length > 1 && kept.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0) > LIMITS.historyBytes) {
    kept = kept.slice(1);
  }
  return kept;
}

/**
 * 适用规则的合并：只认显式给过的字段，没给的保持原值；老条目的默认档位重新推断。
 * 关联目标必须当前存在，缺了就是错，不静默丢掉一条关联。
 */
function assertLinksVisible(links, index, foreign) {
  const visible = foreign && foreign.length ? [...index.entries, ...foreign] : index.entries;
  for (const link of links) {
    if (!visible.some((item) => item.id === link.id)) throw new Error(`关联目标不存在：${link.id}`);
  }
}

function rulesOf(draft, body, index, foreign) {
  const rules = {
    triggers: draft.has.triggers ? draft.triggers : [],
    conditions: draft.has.conditions ? draft.conditions : [],
    selection: draft.has.selection ? draft.selection : null,
    links: draft.has.links ? draft.links : [],
    topicKey: draft.has.topicKey ? draft.topicKey : '',
  };
  rules.applicability = view.validateApplicability(draft.has.applicability ? draft.applicability : undefined,
    rules.conditions, rules.selection, draft.when);
  assertLinksVisible(rules.links, index, foreign);
  void body;
  return rules;
}

/**
 * 旧正文里可能留着「摘要原文：」尾巴：只识别、做标记，绝不改写。
 * 猜不出来哪一段是托管内容，删错就是把用户原话删了。
 */
function hasLegacySummaryTail(text) {
  return typeof text === 'string' && text.includes(LEGACY_SUMMARY_TAIL);
}

function mergedFields(draft, record, oldBody, index, writeMode = 'patch', foreign) {
  if (writeMode === 'replace_current') {
    const next = {
      title: draft.title,
      summary: draft.summary,
      when: draft.when,
      kind: draft.kind || 'note',
      tags: draft.tags,
      triggers: draft.has.triggers ? draft.triggers : [],
      conditions: draft.has.conditions ? draft.conditions : [],
      selection: draft.has.selection ? draft.selection : null,
      links: draft.has.links ? draft.links : [],
      topicKey: draft.has.topicKey ? draft.topicKey : '',
      body: String(draft.body || ''),
    };
    next.applicability = view.validateApplicability(draft.has.applicability ? draft.applicability : undefined,
      next.conditions, next.selection, next.when);
    assertLinksVisible(next.links, index, foreign);
    return next;
  }
  /**
   * 只有范围字段变了才校验或重算。只改标题/摘要/正文/标签时保留原适用范围，
   * 否则一条 unresolved 会因无关 patch 被悄悄放宽成 all_in_scope。
   */
  const scopeTouched = draft.has.applicability || draft.has.when
    || draft.has.conditions || draft.has.selection;
  const requested = draft.has.applicability ? draft.applicability : undefined;
  const next = {
    title: draft.has.title ? draft.title : record.title,
    summary: draft.has.summary ? draft.summary : record.summary || '',
    when: draft.has.when ? draft.when : record.when || '',
    kind: draft.has.kind ? draft.kind || 'note' : record.kind || 'note',
    tags: draft.has.tags ? draft.tags : record.tags || [],
    triggers: draft.has.triggers ? draft.triggers : (record.triggers || []),
    conditions: draft.has.conditions ? draft.conditions : (record.conditions || []),
    selection: draft.has.selection ? draft.selection : (record.selection || null),
    links: draft.has.links ? draft.links : (record.links || []),
    topicKey: draft.has.topicKey ? draft.topicKey : (record.topicKey || ''),
    body: draft.has.body ? draft.body : oldBody,
  };
  next.applicability = scopeTouched
    ? view.validateApplicability(requested, next.conditions, next.selection, next.when)
    : (record.applicability || 'all_in_scope');
  assertLinksVisible(next.links, index, foreign);
  return next;
}

/** 已被取代或过了有效期：默认检索看不见，明确要 history 时仍可查到并读正文。 */
function staleRecord(record, now = Date.now()) {
  if (record.supersededBy) return true;
  const until = Date.parse(record.validUntil || '');
  return Number.isFinite(until) && until <= now;
}

/** 给旧记录打上取代链：正文快照交回调用方，放进新记录的 versions 链头。 */
function stampSupersede(scope, target, nextId, now) {
  if (target.supersededBy) {
    throw new state.StateError('conflict', `这条记忆已经被 ${target.supersededBy} 取代，不能再取代一次`);
  }
  if (target.id === nextId) throw new Error('不能取代自己');
  const versions = snapshot(target, readBody(scope, target.id));
  target.validUntil = now;
  target.supersededBy = nextId;
  target.supersedeReason = 'user_replaced';
  return versions;
}

/**
 * 一次写入的纯业务部分：校验、身份、字节预算、版本。不改盘（正文写入由调用方在同一把锁里做）。
 */
function applyDraft(scope, index, source, now, options = {}) {
  const draft = normalizeDraft(source);
  scanUnsafe(draft);
  const foreign = options.foreignEntries || [];
  const distinct = source && source.resolution === 'distinct';
  /** 取代/过期记录不参与合并判断：新内容不该再合进一条已经不是现行的记录。 */
  const live = index.entries.filter((item) => !staleRecord(item));
  const supersedeTarget = (selfId) => {
    if (!draft.supersedes) return null;
    const target = index.entries.find((item) => item.id === draft.supersedes);
    if (!target) throw new Error(`要取代的记忆不在这一层：${draft.supersedes}`);
    if (target.id === selfId) throw new Error('不能取代自己');
    return target;
  };
  let record = draft.id ? index.entries.find((item) => item.id === draft.id) : null;
  if (draft.id && !record) throw new Error('没有这条记忆，改用新增');
  let mergedFrom = null;
  let similarList = [];
  /**
   * 同名就是同一条：标题是唯一句柄，重复存同一个标题必须是更新，不能悄悄另建一条
   * （否则按标题读、按标题忘都会撞上两条）。前置条件明确不同的同名才允许是另一条。
   */
  if (!record && !distinct) {
    const wantedConditions = view.conditionsKey(draft.conditions || []);
    /** 只改摘要/正文时没重写适用条件，别因此把有条件的那条挤成另一条。 */
    const statedConditions = Boolean(draft.has.when || draft.has.conditions || draft.has.applicability);
    const named = live.find((item) => [item.title, ...(item.aliases || [])]
      .some((name) => String(name || '').trim().toLowerCase() === String(draft.title || '').trim().toLowerCase())
      && (!statedConditions || view.conditionsKey(item.conditions || []) === wantedConditions)
      /** 同名但两边都明确写了不同的 when，是用户表达的另一种情况，算另一条。 */
      && !(draft.has.when && String(item.when || '') && String(item.when || '') !== String(draft.when || '')));
    if (named) {
      record = named;
      mergedFrom = named.title === draft.title ? null : named.title;
    }
  }
  if (!record) {
    /** distinct 是用户明确说的「这是另一条」：同名也另起一条，不被规范化后的精确同名吞掉。 */
    const hit = distinct ? null : resolveTarget(live, draft);
    if (hit) {
      record = hit.target;
      mergedFrom = hit.target.title === draft.title ? null : hit.target.title;
    } else if (draft.has.topicKey && draft.topicKey && !distinct) {
      /** 同一槽位只留一条现行规范：同层同 topicKey + 同条件必须确认是更新还是另一条。 */
      const slot = live.find((item) => (item.topicKey || '') === draft.topicKey
        && view.conditionsKey(item.conditions) === view.conditionsKey(draft.conditions));
      if (slot) {
        const row = {
          id: slot.id,
          title: slot.title,
          summary: slot.summary || '',
          when: slot.when || '',
          updated: slot.updated || slot.created || '',
          reason: 'same_topic',
          revision: slot.revision || 1,
        };
        return { needsResolution: true, sameTopic: true, similarList: [row], similar: row, draft, record: null, merged: false, previousBody: null, archived: [] };
      }
      similarList = similarEntries(live, draft.title, draft.summary, 2);
    } else {
      similarList = similarEntries(live, draft.title, draft.summary, 2);
      /** 同名不同前置条件是用户明确表达的另一条，不走确认；只有换个说法的相近标题才拦。 */
      const sameName = live.some((item) => [item.title, ...(item.aliases || [])]
        .some((name) => String(name || '').toLowerCase() === draft.title.toLowerCase()));
      if (similarList.length > 0 && !distinct && !sameName) {
        return { needsResolution: true, similarList, similar: similarList[0], draft, record: null, merged: false, previousBody: null, archived: [] };
      }
    }
  }
  const writeMode = source && source.writeMode === 'replace_current' ? 'replace_current' : 'patch';
  /** 改名不能撞上另一条现行记忆：标题是唯一句柄，撞了以后按标题读会分不清。 */
  if (record && draft.has.title && cleanTitle(draft.title) !== record.title) {
    const wanted = cleanTitle(draft.title).toLowerCase();
    const clash = live.find((item) => item.id !== record.id
      && [item.title, ...(item.aliases || [])].some((name) => String(name || '').trim().toLowerCase() === wanted));
    if (clash) throw new Error(`已经有同名记忆「${clash.title}」，先改那一条的标题`);
  }
  if (record && writeMode === 'replace_current') {
    for (const key of ['title', 'summary', 'when', 'body', 'kind', 'tags']) {
      if (!draft.has[key]) throw new Error(`整份替换要给出 ${key}，空值也要显式写`);
    }
  }
  if (record) {
    const target = supersedeTarget(record.id);
    const oldBody = readBody(scope, record.id);
    const next = mergedFields(draft, record, oldBody, index, writeMode, foreign);
    /** 正文原样保存：摘要再长也不往正文里补尾巴；完整原句进维护区。 */
    draft.fullTextInBody = false;
    /** 摘要这次被改过就按本次结果落 summaryFull：改短即清空，没改则保持原值。 */
    const summaryFull = draft.has.summary
      ? (draft.summaryShortened ? String(draft.summaryRaw || '') : '')
      : (typeof record.summaryFull === 'string' ? record.summaryFull : '');
    draft.fullTextSaved = Boolean(summaryFull);
    const noop = next.title === record.title && next.summary === record.summary
      && next.when === (record.when || '') && next.kind === (record.kind || 'note')
      && JSON.stringify(next.tags) === JSON.stringify(record.tags || [])
      && JSON.stringify(next.triggers) === JSON.stringify(record.triggers || [])
      && JSON.stringify(next.conditions) === JSON.stringify(record.conditions || [])
      && JSON.stringify(next.selection) === JSON.stringify(record.selection || null)
      && JSON.stringify(next.links) === JSON.stringify(record.links || [])
      && (next.topicKey || '') === (record.topicKey || '')
      && next.applicability === (record.applicability || 'all_in_scope')
      && next.body === oldBody
      && summaryFull === (typeof record.summaryFull === 'string' ? record.summaryFull : '');
    if (noop && !target) {
      return { record, merged: true, mergedFrom: null, similar: null, similarList, draft, noop: true, previousBody: oldBody, archived: [] };
    }
    const versions = snapshot(record, oldBody);
    const titles = [...new Set([...(record.aliases || []), record.title].map((name) => cleanTitle(name)).filter(Boolean))].slice(-5);
    const nextRecord = {
      ...record,
      ...next,
      summaryFull,
      aliases: titles,
      versions,
      revision: (record.revision || 1) + 1,
      updated: now,
      lastUsed: now,
      merges: (record.merges || 0) + 1,
      status: 'active',
      origin: originOf(source) === 'user_explicit' ? (ORIGINS.includes(record.origin) ? record.origin : 'user_explicit') : originOf(source),
    };
    nextRecord.maintenance = { ...(record.maintenance || {}) };
    if (summaryFull) nextRecord.maintenance.summaryFull = summaryFull;
    else delete nextRecord.maintenance.summaryFull;
    /** 旧正文里的托管尾巴只标记待整理，绝不在这里改写用户正文。 */
    if (hasLegacySummaryTail(next.body)) nextRecord.maintenance.legacySummaryTail = true;
    nextRecord.bytes = entrySize(nextRecord, next.body);
    const archived = assertFits(scope, index, nextRecord);
    writeBody(scope, record.id, next.body);
    Object.assign(record, nextRecord);
    /** 更新让这条重新成为现行版本：旧的取代链标记要摘掉。 */
    delete record.supersededBy;
    record.validUntil = '';
    if (target) {
      const chain = stampSupersede(scope, target, record.id, now);
      record.versions = [...chain, ...(record.versions || [])].slice(0, 2);
    }
    return { record, merged: true, mergedFrom, similar: null, similarList, draft, noop: Boolean(noop), previousBody: oldBody, archived };
  }
  if (writeMode === 'replace_current') throw new Error('整份替换要先指明是哪条，不能用来新增');
  /** 新建也只用调用方给的正文：超长摘要的完整原句进维护区，不混进正文。 */
  const target = supersedeTarget('');
  const createdBody = draft.body;
  draft.fullTextInBody = false;
  draft.fullTextSaved = Boolean(draft.summaryFull);
  const rules = rulesOf(draft, createdBody, index, foreign);
  const created = {
    id: newId(),
    title: draft.title,
    summary: draft.summary,
    summaryFull: draft.summaryFull,
    when: draft.when,
    kind: draft.kind,
    tags: draft.tags,
    triggers: rules.triggers,
    applicability: rules.applicability,
    conditions: rules.conditions,
    selection: rules.selection,
    links: rules.links,
    topicKey: rules.topicKey,
    body: createdBody,
    aliases: [],
    created: now,
    updated: now,
    validFrom: now,
    validUntil: '',
    supersededBy: '',
    supersedeReason: '',
    lastUsed: now,
    revision: 1,
    status: 'active',
    origin: originOf(source),
    hits: 0,
    merges: 0,
    versions: [],
    maintenance: {},
    bytes: 0,
  };
  if (draft.summaryFull) created.maintenance.summaryFull = draft.summaryFull;
  /** 旧正文里的托管尾巴只标记待整理，绝不改写用户正文。 */
  if (hasLegacySummaryTail(createdBody)) created.maintenance.legacySummaryTail = true;
  created.bytes = entrySize(created, created.body);
  const archived = assertFits(scope, index, created);
  writeBody(scope, created.id, created.body);
  index.entries.push(created);
  if (target) created.versions = stampSupersede(scope, target, created.id, now);
  return { record: created, merged: false, mergedFrom: null, similar: similarList[0] || null, similarList, draft, noop: false, previousBody: null, archived };
}

/**
 * 写入前兜底扫描：记忆会被 memory_read 原样喂回模型，所以只拦形状明确的三类——
 * 提示注入指令、凭据原文、不可见 Unicode；提到「凭据 / 指令」的正文不算。
 */
const UNSAFE_TEXT = [
  { code: 'injection', why: '像提示注入的指令', fix: '把「指令」改成对规则的描述', test: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)/i },
  { code: 'injection', why: '像提示注入的指令', fix: '把「指令」改成对规则的描述', test: /忽略(?:上面|以上|此前|之前)?(?:的)?(?:所有)?(?:指令|指示|要求|规则)/ },
  { code: 'injection', why: '像提示注入的指令', fix: '把「指令」改成对规则的描述', test: /<\/?(?:system|instructions?|prompt|tool_call)[^>]*>/i },
  { code: 'injection', why: '像提示注入的指令', fix: '把「指令」改成对规则的描述', test: /(?:^|\n)\s*(?:system|assistant)\s*[:：]/i },
];
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const SCAN_FIELD_NAMES = { title: '标题', summary: '摘要', when: '适用场景', body: '正文', tags: '标签', triggers: '触发词', conditions: '条件', selection: '适用范围' };

function scanUnsafe(draft) {
  const fields = [
    ['title', draft.title], ['summary', draft.summary], ['when', draft.when], ['body', draft.body],
    ['tags', (draft.tags || []).join('\n')], ['triggers', (draft.triggers || []).join('\n')],
    ['conditions', JSON.stringify(draft.conditions || [])], ['selection', JSON.stringify(draft.selection || null)],
  ];
  for (const [field, raw] of fields) {
    const text = typeof raw === 'string' ? raw : '';
    if (!text) continue;
    const name = SCAN_FIELD_NAMES[field] || field;
    if (INVISIBLE.test(text)) {
      throw new state.StateError('unsafe', `${name}里有看不见的字符（零宽或方向控制）；它们会跟着记忆原样回到模型，删掉再存`);
    }
    for (const rule of UNSAFE_TEXT) {
      if (rule.test.test(text)) throw new state.StateError('unsafe', `${name}${rule.why}；${rule.fix}`);
    }
  }
}

/**
 * 单条与记录序列化两档预算：新增与更新走同一套。
 * 整层条数/正文预算由 state.transact 在发布前裁决（腾最久没读的那条，不拒绝新记忆），
 * 结果经 index.__archived 回填，调用方在工具结果里点名。
 */
function assertFits(scope, index, record) {
  const bodyBytes = Buffer.byteLength(record.body || '');
  if (bodyBytes > LIMITS.entryBytes) {
    throw new Error(`正文 ${bodyBytes} 字节，超过单条 ${LIMITS.entryBytes} 字节；先精简正文`);
  }
  const size = recordSize(record);
  if (size > LIMITS.recordBytes) {
    throw new Error(`这一条序列化后 ${size} 字节，超过 ${LIMITS.recordBytes} 字节；减少字段或换更短的标签`);
  }
  return [];
}

/**
 * 保存。带 id 就是明确更新那条（没给的字段保持原值）；不带 id 时只认标题 / 旧标题 + 同一前置条件。
 * 文本相近不授权覆盖，也不先写一条再更新：返回 needsResolution，调用方决定 distinct 还是按 id 更新。
 */
export function upsert(scope, source) {
  return withLock(scope, () => upsertLocked(scope, source));
}

/** 已经持锁的保存：saveEntry 用它把两层去重和写入放进同一个锁窗口。 */
function upsertLocked(scope, source, options = {}) {
  {
    const index = loadIndex(scope, options.allowMove ? { allowMove: true } : {});
    const now = new Date().toISOString();
    const result = applyDraft(scope, index, source, now, options);
    if (!('needsResolution' in result)) result.needsResolution = false;
    if (result.needsResolution) return result;
    try {
      saveIndex(scope, index);
    } catch (error) {
      if (result.record && result.previousBody !== null) {
        try {
          writeBody(scope, result.record.id, result.previousBody);
        } catch {
          /* keep the original error */
        }
      } else if (result.record) {
        removeBody(scope, result.record.id);
      }
      throw error;
    }
    const evicted = index.__archived || [];
    if (evicted.length) result.archived = [...(result.archived || []), ...evicted];
    return result;
  }
}

const MATCH_WEIGHT = { title: 3, alias: 2, summary: 2, tags: 1.5 };

function scoreQuery(item, grams, raw) {
  const fields = [
    [item.title, MATCH_WEIGHT.title],
    [(item.aliases || []).join(' '), MATCH_WEIGHT.alias],
    [item.summary, MATCH_WEIGHT.summary],
    [item.when, MATCH_WEIGHT.alias],
    [(item.tags || []).join(' '), MATCH_WEIGHT.tags],
    [(item.triggers || []).join(' '), MATCH_WEIGHT.tags],
  ];
  let score = 0;
  let substantive = 0;
  for (const [text, weight] of fields) {
    if (!text) continue;
    const pool = bigrams(text);
    let shared = 0;
    for (const gram of grams) {
      if (!pool.has(gram)) continue;
      shared += 1;
      if (!STOP_GRAMS.has(gram)) substantive += 1;
    }
    score += shared * weight;
  }
  const plain = normalizeText(raw, 200).toLowerCase().replace(/\s+/g, '');
  if (plain && normalizeText(item.title, 200).toLowerCase().replace(/\s+/g, '').includes(plain)) score += 5;
  /** 触发词命中按整词算：用户说的那句话里带着它，就该搜得到。 */
  const triggerHit = Boolean(plain) && (item.triggers || []).some((trigger) => {
    const text = normalizeText(trigger, 200).toLowerCase().replace(/\s+/g, '');
    return Boolean(text) && plain.includes(text);
  });
  if (triggerHit) score += 4;
  /** 纯英文查询必须按整词命中，避免 git 命中 digital 这种字面巧合；混合查询仍按中文实词判断。 */
  const words = asciiWordsOf(raw);
  const hasCjk = /[\u4e00-\u9fff]/.test(String(raw || ''));
  if (words.length && !hasCjk) {
    const pool = fields.map(([text]) => fieldText(text)).join('\n');
    if (!words.some((word) => wordIn(pool, word))) return 0;
  }
  /** 只重合了「这个」「怎么」这类词，不算命中；触发词命中仍算。 */
  if (substantive === 0 && !triggerHit && words.length === 0) return 0;
  return score;
}

/** 项目记忆总开关：读当前层，缺字段按开启。 */
export function controlStatus(scope) {
  const index = loadIndex(scope);
  return index.__control ? state.controlOf({ control: index.__control }) : state.controlOf(null);
}

export function setMemoryEnabled(scope, enabled, options = {}) {
  return withLock(scope, () => {
    const before = loadIndex(scope);
    const operationId = typeof options.operationId === 'string' ? options.operationId : '';
    let applied = null;
    try {
      state.transact(scope, {
        operationId,
        expectCreate: !before.__exists,
        expected: before.__exists ? { generation: before.generation, epoch: before.epoch } : null,
      }, (draft) => {
        applied = state.applyControl(draft, enabled);
        return applied.changed ? { changed: true } : { changed: false };
      });
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '记忆开关没有改动' };
    }
    return { ok: true, changed: Boolean(applied && applied.changed), ...controlStatus(scope) };
  });
}

/** 面板一次改开关和触发方式：同一把锁里落盘，不会只改一半。 */
export function setMemoryControl(scope, options = {}, meta = {}) {
  return withLock(scope, () => {
    const before = loadIndex(scope);
    const operationId = typeof meta.operationId === 'string' ? meta.operationId : '';
    let applied = null;
    try {
      state.transact(scope, {
        operationId,
        expectCreate: !before.__exists,
        expected: before.__exists ? { generation: before.generation, epoch: before.epoch } : null,
      }, (draft) => {
        applied = state.applyControl(draft, options.enabled, options.mode);
        return applied.changed ? { changed: true } : { changed: false };
      });
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '记忆设置没有改动' };
    }
    return { ok: true, changed: Boolean(applied && applied.changed), ...controlStatus(scope) };
  });
}

/** 项目的触发方式：自适应 / 仅搜索 / 关闭；空值跟随插件配置，不改全局默认。 */
export function setRecallMode(scope, mode, options = {}) {
  if (mode !== 'adaptive' && mode !== 'tool_only' && mode !== 'off') return { ok: false, reason: '不认识这个触发方式' };
  return withLock(scope, () => {
    const before = loadIndex(scope);
    const operationId = typeof options.operationId === 'string' ? options.operationId : '';
    let applied = null;
    try {
      state.transact(scope, {
        operationId,
        expectCreate: !before.__exists,
        expected: before.__exists ? { generation: before.generation, epoch: before.epoch } : null,
      }, (draft) => {
        applied = state.applyControl(draft, undefined, mode);
        return applied.changed ? { changed: true } : { changed: false };
      });
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '触发方式没有改动' };
    }
    return { ok: true, changed: Boolean(applied && applied.changed), ...controlStatus(scope) };
  });
}

/**
 * 项目实验开关：权威状态里缺字段即关闭。状态只回可核验事实，不编学习分数。
 * 关闭时保留已完成成果；试用条目暂停，等新的有效反馈或明确管理动作再复核。
 */
export function evolutionStatus(scope) {
  const index = loadIndex(scope);
  const config = index.__evolution || { enabled: false, epoch: '', policyVersion: 0, feedbackGeneration: 0, compatible: true };
  const counts = { active: 0, trial: 0, paused: 0 };
  for (const record of index.entries) {
    if (!isExperimentalRecord(record)) continue;
    const phase = record.learning && typeof record.learning === 'object' ? record.learning.state : '';
    if (phase === 'active' || phase === 'trial' || phase === 'paused') counts[phase] += 1;
  }
  const control = index.__control || state.controlOf(null);
  return {
    ...config,
    /** 模型可见的 enabled 是有效值：总开关关掉时，自进化一律不运行。 */
    enabled: config.enabled === true && control.enabled === true,
    configuredEnabled: config.enabled === true,
    memoryEnabled: control.enabled === true,
    ownerProject: config.ownerProject || '',
    counts,
  };
}

export function setEvolution(scope, enabled, options = {}) {
  return withLock(scope, () => {
    const before = loadIndex(scope);
    const config = before.__evolution || {};
    /** 总开关关掉后，自进化开关也不能改：先恢复本项目记忆。 */
    if (!(before.__control || state.controlOf(null)).enabled) {
      return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    }
    if (config.compatible === false) {
      return { ok: false, reason: '实验配置版本不认，先不要改动开关', compatible: false };
    }
    const operationId = typeof options.operationId === 'string' ? options.operationId : '';
    let applied = null;
    try {
      state.transact(scope, {
        operationId,
        expectCreate: !before.__exists,
        expected: before.__exists ? { generation: before.generation, epoch: before.epoch } : null,
      }, (draft) => {
        applied = state.applyEvolution(draft, enabled);
        return applied.changed ? { changed: true } : { changed: false };
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '开关没有改动';
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason };
    }
    const after = evolutionStatus(scope);
    return { ok: true, changed: Boolean(applied && applied.changed), ...after };
  });
}


/** 任务锚点只从实验状态里进出：实验关闭时不给写，避免留下无法解释的焦点。 */
export function taskState(scope) {
  const index = loadIndex(scope);
  return anchor.normalizeTasks(index.__tasks);
}

export function saveTaskState(scope, tasks, options = {}) {
  return withLock(scope, () => {
    const before = loadIndex(scope);
    if (!(before.__control || state.controlOf(null)).enabled) return { ok: false, reason: '本项目记忆已关闭' };
    if (!before.__evolution.enabled) return { ok: false, reason: '实验还没开启' };
    const next = anchor.normalizeTasks(tasks);
    const operationId = typeof options.operationId === 'string' ? options.operationId : '';
    let changed = false;
    try {
      const result = state.transact(scope, {
        operationId,
        expected: before.__exists ? { generation: before.generation, epoch: before.epoch } : null,
        expectCreate: !before.__exists,
      }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (!evolution || evolution.enabled !== true) return { changed: false };
        changed = JSON.stringify(evolution.tasks || {}) !== JSON.stringify(next);
        if (changed) evolution.tasks = JSON.parse(JSON.stringify(next));
        return changed ? { changed: true } : { changed: false };
      });
      return { ok: true, changed, tasks: next, replayed: Boolean(result && result.replayed) };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '任务锚点没有保存' };
    }
  });
}

export function setTaskDefault(scope, defaults, options = {}) {
  const before = taskState(scope);
  return saveTaskState(scope, anchor.setDefault(before, { ...defaults, now: options.now }), options);
}

/**
 * 按需检索：项目层 + 全局层，最多 limit 条。
 * 空格/标点分开的查询按关键词处理：一段都没过半命中就不进结果，避免只沾了个常用词也挤进来。
 * 返回的记录带着「本次检索之前」的 lastUsed，给 renderIndex 判断陈旧用；
 * 命中计数在返回前写入，所以同一次调用既改盘又不污染展示。
 */
/** 「用过」的判定门槛：lastUsed 超过这么久才回写，检索不至于每次都抢锁落盘。 */
const USED_TOUCH_MS = 10 * 60 * 1000;

function usedStale(record, now) {
  const at = Date.parse(String((record && (record.lastUsed || record.updated)) || ''));
  return !Number.isFinite(at) || now - at >= USED_TOUCH_MS;
}

/**
 * 真正被搜到/读过才算用过：只回写 lastUsed，不动 hits，也不改正文。
 * 抢不到锁或并发冲突都吞掉——这个是提示字段，不该让检索/阅读失败。
 */
function touchUsed(scope, ids, countHit = false) {
  const wanted = new Set((ids || []).filter((id) => typeof id === 'string' && id));
  if (wanted.size === 0) return;
  try {
    withLock(scope, () => {
      const index = loadIndex(scope);
      const now = Date.now();
      const stamp = new Date(now).toISOString();
      let changed = false;
      for (const record of index.entries) {
        if (!wanted.has(record.id)) continue;
        /** 检索/阅读只补 lastUsed，不记 hits：只有真正交付给模型的记账才算一次使用。 */
        if (countHit) {
          record.hits = (Number(record.hits) || 0) + 1;
          changed = true;
        }
        /** 第一次被真用到必须记下来，哪怕刚创建、还没过 lastUsed 的防抖门槛。 */
        if (record.everUsed !== true) {
          record.everUsed = true;
          changed = true;
        }
        if (!usedStale(record, now)) continue;
        record.lastUsed = stamp;
        changed = true;
      }
      if (changed) saveIndex(scope, index);
    });
  } catch {
    /* lastUsed 只是提示：失败不影响这次检索/阅读的结果。 */
  }
}

export function search(scope, query, limit = 4, options = {}) {
  const found = withLocks([scope, globalScope()], () => {
    const grams = bigrams(query);
    if (grams.size === 0) return [];
    const runs = queryRuns(query);
    const keywordMode = runs.length >= 2;
    const rows = [];
    const layers = { project: [], global: [] };
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const layer = source.key === 'global' ? 'global' : 'project';
      const owned = index.entries.filter((item) => readableRecord(item, options, index));
      layers[layer].push(...owned);
      const collect = (pool, archived) => {
        for (const item of pool) {
          if (!readableRecord(item, options, index)) continue;
          /** 被取代/过期待记录默认不出现；history:true 才列出，供模型看演化。 */
          if (options.history !== true && staleRecord(item, options.now || Date.now())) continue;
          /** 已暂停、已过期或待确认的学习规则不进入检索结果，除非明确要病史。 */
          if (options.allowExperimental === true && options.history !== true
            && isExperimentalRecord(item) && !view.experimentalUsable(item, options.now)) continue;
          const score = scoreQuery(item, grams, query);
          if (score <= 0) continue;
          if (keywordMode && !matchesRun(item, runs)) continue;
          rows.push({ source, index, item, score, archived });
        }
      };
      collect(index.entries, false);
      /** 正常检索只看当前有效的；归档的旧记录只在明确要求病史时列出。 */
      if (options.history === true) collect(index.archived, true);
    }
    /** 被项目层压过的全局条目不再作为检索结果出现；冲突/条件未知的仍保留，便于人工处理。 */
    const resolved = view.resolveTopics(layers.project, layers.global, options.context || {});
    const shadowed = (item) => {
      const group = resolved.get(view.topicSlot(item));
      return Boolean(group && group.status === 'ok' && group.record && group.record.id !== item.id);
    };
    const visible = rows.filter((row) => row.archived || !shadowed(row.item))
      .map((row) => ({ ...row, usable: row.archived || view.statusOf(row.item, options.context || {}) === 'ok' }));
    /** 先按「本轮能不能用」分组再按相关度：高相关但当前不适用的条目不能挤掉后面真正能用的。 */
    visible.sort((a, b) => Number(b.usable) - Number(a.usable)
      || b.score - a.score
      || Number(a.archived) - Number(b.archived)
      || String(b.item.lastUsed).localeCompare(String(a.item.lastUsed)));
    const chosen = visible.slice(0, limit);
    /** hits 不在检索里记，lastUsed 也只在锁外补写；这里先把层信息和结果一起带出去。 */
    return chosen.map((row) => ({
      record: {
        ...row.item,
        scope: row.source.key === 'global' ? 'global' : 'project',
        status: row.archived ? 'archived' : view.statusOf(row.item, options.context || {}),
        archived: Boolean(row.archived),
      },
      source: row.source,
      archived: Boolean(row.archived),
    }));
  });
  /** 锁外回写：在层锁里再抢同一层的锁会死锁；只给真正会交付给调用方的检索默认记账。 */
  if (options.markUsed !== false) {
    for (const row of found) {
      if (!row.archived) touchUsed(row.source, [row.record.id]);
    }
  }
  return found.map((row) => row.record);
}

/** 交付后再记账：调用方只把最终真给模型看过的条目交回来。 */
export function markUsed(scope, ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id);
  if (!wanted.length) return;
  for (const source of [scope, globalScope()]) {
    try { touchUsed(source, wanted, true); } catch { /* lastUsed 只是提示 */ }
  }
}

/**
 * 只读命中：给自动提示用。不改 hits / lastUsed，不落盘。
 * 标题（含旧标题）必须真跟查询有交集，否则长句里零星重合也会冒出提示。
 */
export function peek(scope, query, limit = 3, options = {}) {
  const grams = bigrams(query);
  if (grams.size === 0) return [];
  const rows = [];
  for (const source of [scope, globalScope()]) {
    let index;
    try {
      index = loadIndex(source);
    } catch {
      continue;
    }
    for (const item of index.entries) {
      if (!item || !item.title) continue;
      const pool = bigrams(`${item.title} ${(item.aliases || []).join(' ')}`);
      let shared = 0;
      for (const gram of grams) if (pool.has(gram)) shared += 1;
      if (shared === 0) continue;
      if (options.requireApplicable !== false && !view.canAutoRecall(item, options.context || {})) continue;
      const score = scoreQuery(item, grams, query);
      if (score < 6) continue;
      rows.push({ item, source, score });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit).map(({ item, source }) => ({
    id: item.id,
    title: item.title,
    summary: item.summary || '',
    scope: source.key === 'global' ? 'global' : 'project',
    status: 'ok',
  }));
}

export function readEntry(scope, id, options = {}) {
  /** 显式指定层时只读那一层；默认仍只读当前项目和全局。 */
  const sources = Array.isArray(options.layers) && options.layers.length ? options.layers : runtimeLayers(scope);
  const found = withLocks(sources, () => {
    for (const source of sources) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      const archived = record ? null : index.archived.find((item) => item.id === id);
      if (!record && !archived) continue;
      if (!readableRecord(record || archived, options, index)) continue;
      const body = readBody(source, id);
      /** 生命周期先判定：过期/被取代的条目不能再报成现行规则。 */
      const lifecycle = view.lifecycleStatusOf(record || archived, options.now || Date.now());
      return {
        source,
        archived: Boolean(archived),
        lifecycle,
        record: {
          ...(record || archived),
          scope: source.key === 'global' ? 'global' : 'project',
          body,
          status: lifecycle || view.statusOf(record, options.context || {}),
        },
      };
    }
    return null;
  });
  if (!found) return null;
  /** 读过才算用过；归档、被取代、过期、空正文或条件不匹配的读取都不算「在用」。 */
  const countsAsUsage = typeof options.usage !== 'function' || options.usage(found.record) !== false;
  const hasBody = typeof found.record.body === 'string' && found.record.body.trim() !== '';
  if (!found.archived && !found.lifecycle && hasBody && countsAsUsage) touchUsed(found.source, [id]);
  return found.record;
}

/**
 * 忘掉一条：archive 或 purge 是两种不同承诺，没点明就不动盘，交给界面问一次。
 * purge 走 state 的屏障事务：锁内落 intent、旋转 epoch、清受管副本，完成才回成功。
 */
export function forget(scope, id, options = {}) {
  const mode = options.mode;
  if (mode !== 'archive' && mode !== 'purge') return { id, mode: 'needs_resolution' };
  /** 显式指定的层就是唯一范围；不然才按运行时「当前项目 + 全局」找。 */
  const sources = Array.isArray(options.layers) && options.layers.length ? options.layers : null;
  const scopeList = sources || [scope, globalScope()];
  return withLocks(scopeList, () => {
    /** 屏障优先：上次彻底删除没做完时，先按原层 + 原 operationId 收尾，再决定这条在哪。 */
    let replayed = null;
    if (mode === 'purge') {
      for (const source of scopeList) {
        const pending = state.purgeIntent(source);
        if (!pending) continue;
        /** 冷存里有待删条目的正文副本：先隔离，state.purge 的残留扫描才收得干净。 */
        const result = purgeWithCold(source, pending.ids, () => state.purge(source, { resume: true }));
        cleanColdQuarantine(source);
        removeBody(source, id);
        if (pending.ids.includes(id)) {
          replayed = {
            id,
            mode: 'purged',
            operationId: result.operationId,
            epoch: result.epoch,
            generation: result.generation,
            scopeKey: source.key,
            replay: true,
          };
        }
      }
      if (replayed) return replayed;
    }
    for (const source of scopeList) {
      const index = loadIndex(source);
      const active = index.entries.find((item) => item.id === id);
      const archived = active ? null : index.archived.find((item) => item.id === id);
      const record = active || archived;
      if (!record) continue;
      if (mode === 'archive') {
        if (archived) return { id: record.id, title: record.title, mode: 'archive', already: true, scopeKey: source.key };
        archiveEntry(source, index, record);
        /** 「别记」也要挡住以后的自动建议，不能过几天又从同一个来源冒出来。 */
        addSuppression(index, {
          fingerprint: state.fingerprintOf({ title: record.title, when: record.when }),
          sourceIds: [],
          reason: 'forgotten_source',
          at: new Date().toISOString(),
          expiresAt: null,
        });
        saveIndex(source, index);
        return { id: record.id, title: record.title, mode: 'archive', scopeKey: source.key };
      }
      if (archived) {
        /** 归档条目也能彻底删除：state.purge 本来就按 id 清整份状态，只是以前没走到这里。 */
        const result = purgeWithCold(source, [id], () => state.purge(source, { ids: [id], operationId: options.operationId }));
        cleanColdQuarantine(source);
        removeBody(source, id);
        return {
          id,
          mode: 'purged',
          operationId: result.operationId,
          epoch: result.epoch,
          generation: result.generation,
          scopeKey: source.key,
        };
      }
      const result = purgeWithCold(source, [id], () => state.purge(source, { ids: [id], operationId: options.operationId }));
      cleanColdQuarantine(source);
      removeBody(source, id);
      return {
        id,
        mode: 'purged',
        operationId: result.operationId,
        epoch: result.epoch,
        generation: result.generation,
        scopeKey: source.key,
      };
    }
    return null;
  });
}

/** 直接读邻居：只给当前投影，不缓存目标正文；目标不在了就标 invalid，不拿旧版本顶上。 */
export function readLinks(scope, id, options = {}) {
  return withLocks(runtimeLayers(scope), () => {
    for (const source of runtimeLayers(scope)) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (!record) continue;
      if (!readableRecord(record, options, index)) continue;
      const links = [];
      for (const link of view.linksOf(record)) {
        const target = findCurrent(link.id, scope, options);
        if (target) links.push({ type: link.type || 'related', ...target });
        else links.push({ type: link.type || 'related', id: link.id, status: 'invalid' });
      }
      return { id, title: record.title || '', links, scope: source.key === 'global' ? 'global' : 'project', status: view.statusOf(record, options.context || {}) };
    }
    return null;
  });
}

/** 关联目标按当前投影现场解引用：先项目层再全局层，归档和删除都算不存在。 */
function findCurrent(id, scope, options = {}) {
  for (const source of runtimeLayers(scope)) {
    let index;
    try {
      index = loadIndex(source);
    } catch {
      continue;
    }
    const record = index.entries.find((item) => item.id === id && item.status !== 'archived');
    if (!record) continue;
    if (!readableRecord(record, options, index)) continue;
    /** 关联目标与来源走同一资格门槛：项目归属、学习状态、条件适用缺一不可。 */
    const gate = view.eligibility(record, options.runtime || {}, 'read', options.now || Date.now());
    if (!gate.ok || gate.status !== 'ok') continue;
    if (isExperimentalRecord(record) && !view.experimentalUsable(record, options.now)) continue;
    return {
      id: record.id,
      title: record.title,
      summary: record.summary || '',
      scope: source.key === 'global' ? 'global' : 'project',
      revision: record.revision || 1,
      validUntil: record.validUntil || '',
      supersededBy: record.supersededBy || '',
      status: 'ok',
    };
  }
  return null;
}


/** 撤销一次修改：有旧版本就整条还原成新 revision；没有旧版本（新建的）就归档。 */
export function undoChange(scope, id, options = {}) {
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (!record) continue;
      /** 旧回执不能撤掉别人后来的修改：版本对不上就明确拒绝。 */
      if (options.expectedRevision !== undefined && Number(record.revision) !== Number(options.expectedRevision)) {
        throw new state.StateError('conflict', '这条记忆已经被更新过，刷新后再改');
      }
      const versions = record.versions || [];
      const last = versions[versions.length - 1];
      if (!last) {
        archiveEntry(source, index, record);
        saveIndex(source, index);
        return { id: record.id, title: record.title, mode: 'archived' };
      }
      const currentBody = readBody(source, record.id);
      const restored = {
        ...record,
        title: last.title || record.title,
        summary: last.summary || record.summary,
        summaryFull: typeof last.summaryFull === 'string' ? last.summaryFull : '',
        when: last.when || '',
        kind: last.kind || record.kind,
        tags: Array.isArray(last.tags) ? last.tags : record.tags,
        triggers: Array.isArray(last.triggers) ? last.triggers : record.triggers || [],
        applicability: last.applicability || record.applicability || 'all_in_scope',
        conditions: Array.isArray(last.conditions) ? last.conditions : record.conditions || [],
        selection: last.selection === undefined ? record.selection || null : last.selection,
        links: Array.isArray(last.links) ? last.links : record.links || [],
        topicKey: last.topicKey === undefined ? record.topicKey || '' : last.topicKey,
        body: last.body,
        versions: versions.slice(0, -1),
        revision: (record.revision || 1) + 1,
        updated: new Date().toISOString(),
      };
      writeBody(source, record.id, last.body);
      Object.assign(record, restored);
      record.maintenance = { ...(record.maintenance || {}) };
      if (record.summaryFull) record.maintenance.summaryFull = record.summaryFull;
      else delete record.maintenance.summaryFull;
      record.bytes = entrySize(record, last.body);
      try {
        saveIndex(source, index);
      } catch (error) {
        writeBody(source, record.id, currentBody);
        throw error;
      }
      return { id: record.id, title: record.title, mode: 'restored' };
    }
    return null;
  });
}

/**
 * 按 id 在所有已知层里找：界面上的引用是历史事实，当前正文可能已经不在原来那层了。
 * 只读，不做任何写回；找不到就返回 null，调用方据此显示「已失效」。
 */
export function findAnywhere(id) {
  if (!/^mem_[a-z0-9]{6,}$/.test(String(id || ''))) return null;
  let names;
  try {
    names = fs.readdirSync(memoryRoot(), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    const scope = {
      key: dirent.name,
      dir: path.join(memoryRoot(), dirent.name),
      cwd: '',
      requestedCwd: '',
      rootSource: 'scan',
      confirmed: true,
    };
    if (!fs.existsSync(path.join(scope.dir, 'state.json'))) continue;
    let index;
    try {
      index = loadIndex(scope);
    } catch {
      continue;
    }
    const record = index.entries.find((item) => item.id === id);
    const archived = record ? null : index.archived.find((item) => item.id === id);
    if (!record && !archived) continue;
    let body = '';
    try {
      body = readBody(scope, id) || '';
    } catch {
      body = '';
    }
    const current = record || archived;
    return {
      id,
      title: current.title || '',
      when: current.when || '',
      scope: scope.key === 'global' ? 'global' : 'project',
      scopeKey: scope.key,
      scopeLabel: scope.key === 'global' ? '全局' : path.basename(index.cwd || '') || scope.key,
      revision: current.revision || 1,
      status: archived ? 'archived' : 'ok',
      body,
    };
  }
  return null;
}

/** 运行时只允许当前项目和全局层：别的项目仅供人类管理面只读枚举。 */
export function runtimeLayers(scope) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.dir || seen.has(item.dir)) return;
    seen.add(item.dir);
    out.push(item);
  };
  push(scope);
  push(globalScope());
  return out;
}

/** 按 id 在项目层与全局层里找位置，不靠文案猜作用域；管理动作也要看得见已归档的条目。 */
/**
 * 标题是唯一对外的句柄：当前项目找不到，就去全局和别的项目层找。
 * 只用于读路径（读正文、查关联、解析标题）；写入仍然只动自己那层。
 */
export function layersFor(scope) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.dir || seen.has(item.dir)) return;
    seen.add(item.dir);
    out.push(item);
  };
  push(scope);
  push(globalScope());
  try {
    for (const row of state.knownProjectScopes()) push({ key: row.key, dir: row.dir, cwd: row.cwd });
  } catch { /* 层列表读不出来就只查当前层和全局，不影响读取 */ }
  return out;
}

export function locate(scope, id, options = {}) {
  /**
   * 默认只看当前层和全局：面板/HTTP 用 id 探正文时跨层就是越权。
   * 工具侧按标题读，明确传 crossLayer 才跨层（标题是用户给的句柄）；
   * 显式指定某一层时只给那一层，绝不拿项目层去命中全局条目。
   */
  const sources = Array.isArray(options.layers) && options.layers.length
    ? options.layers
    : options.crossLayer ? layersFor(scope) : runtimeLayers(scope);
  for (const source of sources) {
    const index = loadIndex(source, options);
    const active = index.entries.find((item) => item.id === id);
    if (active) return { scope: source, record: active, archived: false };
    const archived = index.archived.find((item) => item.id === id);
    if (archived) return { scope: source, record: archived, archived: true };
  }
  return null;
}

/**
 * 标题是界面和模型唯一的句柄：在给定范围里按标题（含别名）找那一条。
 * 同层可能同名但适用条件不同，所以带了版次就先按版次收敛，再退回第一条。
 */
export function locateByTitle(scope, title, options = {}) {
  const wanted = normalizeText(title, 120).toLowerCase();
  if (!wanted) return null;
  const sources = options.crossLayer ? layersFor(scope) : runtimeLayers(scope);
  const want = Number.isInteger(options.revision) ? options.revision : null;
  for (const source of sources) {
    const index = loadIndex(source, options);
    const pick = (list) => {
      const rows = list.filter((item) => [item.title, ...(Array.isArray(item.aliases) ? item.aliases : [])]
        .some((name) => normalizeText(name, 120).toLowerCase() === wanted));
      if (rows.length === 0) return null;
      if (want !== null) {
        const exact = rows.find((item) => (Number(item.revision) || 1) === want);
        if (exact) return exact;
      }
      return rows[0];
    };
    const active = pick(index.entries);
    if (active) return { scope: source, record: active, archived: false };
    const archived = pick(index.archived);
    if (archived) return { scope: source, record: archived, archived: true };
  }
  return null;
}

function forgottenFingerprints(index) {
  const out = new Set();
  for (const row of index.suppressions || []) {
    if (row && row.reason === 'forgotten_source' && typeof row.fingerprint === 'string') out.add(row.fingerprint);
  }
  return out;
}

/** 过期候选清掉；被明确忘掉的来源自动学回来的候选也清掉，不再出现在保留队列。 */
function pruneSuggestions(index) {
  const now = Date.now();
  const forgotten = forgottenFingerprints(index);
  index.suggestions = (index.suggestions || []).filter((item) => {
    const expires = Date.parse(item.expiresAt || '');
    if (!Number.isFinite(expires) || expires <= now) return false;
    const draft = item.draft || {};
    const fingerprint = state.fingerprintOf({ title: draft.title || item.title, when: draft.when || item.when });
    return !forgotten.has(fingerprint);
  });
}

/** 抑制规则：忘掉的来源永久挡，候选被拒只挡一段时间。只存指纹，不存原文。 */
function addSuppression(index, { fingerprint, sourceIds = [], reason, at, expiresAt }) {
  if (!fingerprint) return;
  const now = Date.now();
  const rows = (index.suppressions || []).filter((row) => {
    if (row.fingerprint === fingerprint && row.reason === reason) return false;
    if (!row || row.reason === 'forgotten_source') return true;
    const expires = Date.parse(row.expiresAt || '');
    return Number.isFinite(expires) && expires > now;
  });
  rows.push({ fingerprint, sourceIds: [...sourceIds].filter((id) => typeof id === 'string'), reason, at, expiresAt });
  index.suppressions = rows;
}

/** 命中哪种抑制：永久忘掉 / 一段时间内不重复建议；过期的不算。 */
function suppressionOf(index, fingerprint) {
  for (const row of index.suppressions || []) {
    if (!row || row.fingerprint !== fingerprint) continue;
    if (row.reason === 'forgotten_source') return 'forgotten_source';
    const expires = Date.parse(row.expiresAt || '');
    if (Number.isFinite(expires) && expires > Date.now()) return 'candidate_rejected';
  }
  return '';
}

function pruneReceiptList(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : []).filter((item) => {
    const at = Date.parse(item && item.at ? item.at : '');
    return Number.isFinite(at) && now - at < LIMITS.receiptTtlMs;
  }).slice(-LIMITS.receipts);
}

function pruneReceipts(index) {
  index.receipts = pruneReceiptList(index.receipts);
  return index.receipts;
}

/**
 * 建议门限：已有同一条就不再建议；相近的另一条可以建议，但必须带着 targetId
 * 走候选确认，不能直接改正式条目。
 */
export function suggestionGate(scope, source) {
  if (scope && scope.confirmed === false) {
    return { ok: false, reason: '当前目录还不能确认属于哪个项目，先确认项目根目录再建议' };
  }
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const title = normalizeText(source?.title, LIMITS.titleChars);
    if (!title) return { ok: false, reason: '没有标题' };
    const summary = normalizeText(source?.summary, LIMITS.summaryChars);
    const when = normalizeText(source?.when, LIMITS.whenChars);
    const blocked = suppressionOf(index, state.fingerprintOf({ title, when }));
    if (blocked === 'forgotten_source') {
      return { ok: false, reason: '这个来源你已经明确忘掉了，不再自动建议' };
    }
    if (blocked === 'candidate_rejected') {
      return { ok: false, reason: '这个来源刚被拒绝过，过几天再说' };
    }
    const hit = resolveTarget(index.entries, { title, summary, when });
    if (hit) return { ok: false, reason: `已有「${hit.target.title}」，这次不重复建议` };
    const wanted = { title, summary, when };
    for (const key of ['triggers', 'conditions', 'selection', 'applicability']) {
      if (source && source[key] !== undefined) wanted[key] = source[key];
      if (source && source.has && typeof source.has === 'object') wanted.has = source.has;
    }
    const near = similarTarget(index.entries, wanted);
    if (near) return { ok: true, target: { id: near.id, title: near.title, revision: near.revision || 1 } };
    const last = Date.parse(index.lastSuggestedAt || '');
    if (Number.isFinite(last) && Date.now() - last < LIMITS.suggestionWindowMs) {
      return { ok: false, reason: '48 小时内已经建议过一条' };
    }
    return { ok: true };
  });
}

/**
 * 待确认草稿与正式条目走同一个校验器：凭据、大小、必填都在这里拦住。
 * 草稿在确认前就落盘（本地待确认区），所以撤回/过期都要能查到。
 */
export function noteSuggestion(scope, source, decision = 'asked') {
  return withLock(scope, () => {
    const draft = normalizeDraft(source, { requireSummary: false });
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const at = new Date();
    const targetId = typeof source?.targetId === 'string' ? source.targetId : '';
    const target = targetId ? index.entries.find((item) => item.id === targetId) : null;
    if (targetId && !target) throw new Error('候选指向的条目不存在');
    const record = {
      id: `sug_${crypto.randomBytes(4).toString('hex')}`,
      title: draft.title,
      at: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.suggestionTtlMs).toISOString(),
      decision,
      draft: {
        title: draft.title,
        summary: draft.summary,
        when: draft.when,
        body: draft.body,
        kind: draft.kind,
        tags: draft.tags,
        /** 语义字段整份带走：确认前后不能因为过了一道待确认区就换一套适用范围。 */
        ...(draft.triggers !== undefined ? { triggers: draft.triggers } : {}),
        ...(draft.conditions !== undefined ? { conditions: draft.conditions } : {}),
        ...(draft.selection !== undefined ? { selection: draft.selection } : {}),
        ...(draft.links !== undefined ? { links: draft.links } : {}),
        ...(draft.applicability !== undefined ? { applicability: draft.applicability } : {}),
        ...(draft.topicKey !== undefined ? { topicKey: draft.topicKey } : {}),
        /** 字段「有」和「空」不是一回事：确认时只写真正给过的字段。 */
        has: { ...draft.has },
        targetId: target ? target.id : '',
        targetRevision: target ? target.revision || 1 : 0,
      },
    };
    const next = [...(index.suggestions || []), record];
    const bytes = next.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.draft || {})), 0);
    if (bytes > LIMITS.pendingBytes || next.length > LIMITS.pending) {
      throw new Error('待确认的候选已满，先处理旧的');
    }
    index.suggestions = next;
    index.lastSuggestedAt = at.toISOString();
    saveIndex(scope, index);
    return {
      id: record.id,
      title: draft.title,
      expiresAt: record.expiresAt,
      targetId: record.draft.targetId,
      targetTitle: target ? target.title : '',
    };
  });
}

/** 待保留的那条建议：按 id 取，过期/已存下的不再返回。 */
export function findSuggestion(scope, key) {
  const index = loadIndex(scope);
  pruneSuggestions(index);
  const item = (index.suggestions || []).find((entry) => entry.id === key && entry.decision === 'asked');
  if (!item) return null;
  return { ...item.draft, suggestionId: item.id };
}

/**
 * 旧候选或损坏候选的字段自检：has 说给了某个结构化字段，值就必须是合法形状。
 * 不猜、不补默认值；不合格的候选直接失效，要求重新建立。
 */
export function candidateProblem(draft) {
  const has = draft && draft.has && typeof draft.has === 'object' ? draft.has : null;
  if (!has) return '';
  if (has.conditions && !Array.isArray(draft.conditions)) return '候选的条件缺失';
  if (has.selection && draft.selection !== null && (typeof draft.selection !== 'object' || Array.isArray(draft.selection))) return '候选的产物范围缺失';
  if (has.links && !Array.isArray(draft.links)) return '候选的关联缺失';
  if (has.triggers && !Array.isArray(draft.triggers)) return '候选的触发词缺失';
  if (has.applicability && view.normalizeApplicability(draft.applicability) !== draft.applicability) return '候选的适用范围不合法';
  if (has.topicKey && typeof draft.topicKey !== 'string') return '候选的主题缺失';
  return '';
}

/**
 * 点「保留」：在同一个锁窗口里按 candidateId 确认、消费候选、写回执。
 * 已消费的候选不再写第二条；旧的 keep 重放返回原回执。
 */
export function acceptCandidate(scope, key, operationId = '') {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    pruneReceipts(index);
    const replay = (index.receipts || []).find((item) => (operationId && item.operationId === operationId)
      || (!operationId && item.candidateId === key && item.status === 'accepted'));
    if (replay) return { ok: true, replay: true, id: replay.entryId || '', title: replay.title || '', reason: '这条候选已经处理过' };
    const item = (index.suggestions || []).find((entry) => entry.id === key && entry.decision === 'asked');
    if (!item) return { ok: false, reason: '候选不存在或已过期' };
    const draft = item.draft || {};
    const incomplete = candidateProblem(draft);
    if (incomplete) {
      index.suggestions = (index.suggestions || []).filter((entry) => entry.id !== item.id);
      saveIndex(scope, index);
      return { ok: false, invalid: true, reason: `${incomplete}，重新建议一次` };
    }
    const target = draft.targetId ? index.entries.find((entry) => entry.id === draft.targetId) : null;
    if (draft.targetId && !target) return { ok: false, reason: '候选要更新的那条记忆已不在了' };
    if (target && draft.targetRevision && (target.revision || 1) !== draft.targetRevision) {
      return { ok: false, reason: '那条记忆在你确认前改过了，重新建议一次' };
    }
    /** 只把建议里真有的字段交给写入：省略表示保持，显式空正文清空；旧候选没有 has 时按有没有值回退。 */
    /** 候选正文是模型起草的，人只确认要不要留；来源照实记。 */
    const source = { title: draft.title, origin: 'model_drafted' };
    const has = draft.has && typeof draft.has === 'object' ? draft.has : null;
    if (has) {
      if (has.summary) source.summary = draft.summary;
      if (has.when) source.when = draft.when;
      if (has.kind) source.kind = draft.kind;
      if (has.tags) source.tags = Array.isArray(draft.tags) ? draft.tags : [];
      if (has.body) source.body = draft.body;
      if (has.triggers) source.triggers = draft.triggers;
      if (has.conditions) source.conditions = draft.conditions;
      if (has.selection) source.selection = draft.selection;
      if (has.links) source.links = draft.links;
      if (has.applicability) source.applicability = draft.applicability;
      if (has.topicKey) source.topicKey = draft.topicKey;
    } else {
      if (draft.summary) source.summary = draft.summary;
      if (draft.when) source.when = draft.when;
      if (draft.kind) source.kind = draft.kind;
      if (Array.isArray(draft.tags)) source.tags = draft.tags;
      if (draft.body) source.body = draft.body;
    }
    if (target) source.id = target.id;
    const now = new Date().toISOString();
    try {
      const result = applyDraft(scope, index, source, now);
      if (result.needsResolution) return { ok: false, reason: '候选与已有条目相近，需要确认', similar: result.similarList };
      index.suggestions = (index.suggestions || []).filter((entry) => entry.id !== item.id);
      index.receipts = [...(index.receipts || []), {
        operationId: operationId || `op_${crypto.randomBytes(6).toString('hex')}`,
        candidateId: item.id,
        entryId: result.record.id,
        title: result.record.title,
        status: 'accepted',
        at: now,
      }].slice(-LIMITS.receipts);
      saveIndex(scope, index);
      return { ok: true, replay: false, id: result.record.id, title: result.record.title, mode: result.merged ? 'updated' : 'created' };
    } catch (error) {
      throw error;
    }
  });
}

/** 拒绝一个候选：消费草稿，同时按指纹挡一段时间，避免同一句反复冒出来。 */
export function rejectCandidate(scope, key) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    const item = (index.suggestions || []).find((entry) => entry.id === key);
    if (!item) return { ok: false, reason: '候选不存在或已过期' };
    const draft = item.draft || {};
    const at = new Date();
    addSuppression(index, {
      fingerprint: state.fingerprintOf({ title: draft.title || item.title, when: draft.when }),
      sourceIds: Array.isArray(draft.sourceIds) ? draft.sourceIds : [],
      reason: 'candidate_rejected',
      at: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.suppressionTtlMs).toISOString(),
    });
    index.suggestions = (index.suggestions || []).filter((entry) => entry.id !== key);
    saveIndex(scope, index);
    return { ok: true };
  });
}

/** The compact index handed to the model: one noun-phrase line per entry, hard capped. */
export function renderIndex(entries, budget = 400) {
  const staleMs = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const lines = [];
  let used = 0;
  for (const item of entries) {
    const last = Date.parse(item.lastUsed || item.updated || item.created || '') || now;
    const stale = now - last > staleMs;
    const stateTag = item.state === 'archived' ? ' · 已归档' : item.state === 'needs_context' ? ' · 适用范围待确认' : item.state === 'not_applicable' ? ' · 当前条件不适用' : '';
    const originTag = item.origin === 'project_evolution' ? ' · 实验' : '';
    const tag = item.scope === 'global' ? '[global]' : item.scopeName ? `[${item.scopeName}]` : '';
    const head = `${tag ? `${tag} ` : ''}「${item.title}」${item.when ? `（${item.when}）` : ''}${originTag}${stateTag}`;
    const line = stale ? `- ${head}` : `- ${head}｜${item.summary}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), chars: used };
}

/**
 * 会话引用：界面「N 条记忆引用」用的派生缓存，不是记忆本体。
 * 每个会话一个小文件，坏了就整份丢掉重来；记忆本身不受影响。
 */
const SESSION_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** 会话引用文件独立于记忆库状态，简单原子替换就够。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function sessionsDir() {
  return path.join(memoryRoot(), 'sessions');
}

function citationFile(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function readSessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(citationFile(sessionId), 'utf8'));
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}

/** 只留最近用过的若干个会话文件，旧的按上限与时间清掉。 */
function pruneSessions(keep) {
  const dir = sessionsDir();
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  const rows = names.map((name) => {
    const file = path.join(dir, name);
    let time = 0;
    try {
      time = fs.statSync(file).mtimeMs;
    } catch {
      /* gone already */
    }
    return { file, name, time };
  }).sort((a, b) => b.time - a.time);
  const now = Date.now();
  rows.forEach((row, index) => {
    if (row.name === `${keep}.json`) return;
    if (index < LIMITS.citationSessions && now - row.time <= LIMITS.citationTtlMs) return;
    try {
      fs.rmSync(row.file, { force: true });
    } catch {
      /* best effort */
    }
  });
}

/**
 * 记下「这些条目这次真的被读进了上下文」。同一 id 只留一条，最近的排前面。
 * 参数里的 scope 是读取时用的项目作用域；正文路径按条目自己的层算。
 */
export function recordCitations(scope, sessionId, items) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return [];
  const incoming = (Array.isArray(items) ? items : []).filter((item) => item && /^mem_[a-z0-9]{6,}$/.test(String(item.id || '')));
  const previous = readSessionFile(sessionId);
  const rows = new Map();
  const now = new Date().toISOString();
  for (const item of incoming) {
    const key = item.scope === 'global' ? 'global' : (typeof item.scopeKey === 'string' && item.scopeKey ? item.scopeKey : scope.key);
    rows.set(item.id, {
      id: item.id,
      scope: key === 'global' ? 'global' : 'project',
      key,
      at: now,
    });
  }
  for (const item of (previous && previous.items) || []) {
    if (!item || typeof item.id !== 'string' || rows.has(item.id)) continue;
    rows.set(item.id, item);
  }
  let next = [...rows.values()];
  while (next.length > 1 && Buffer.byteLength(JSON.stringify(next)) > LIMITS.citationBytes) next = next.slice(0, -1);
  next = next.slice(0, LIMITS.citations);
  const text = `${JSON.stringify({ sessionId, cwd: scope.cwd, updatedAt: now, items: next })}\n`;
  try {
    writeAtomic(citationFile(sessionId), text);
  } catch {
    return next;
  }
  pruneSessions(sessionId);
  return next;
}

const SCOPE_KEY = /^[A-Za-z0-9._-]{1,80}$/;

/** 引用的身份是「哪个 scope 的哪个 id」；旧文件里只有 path 时从目录名推回来。 */
function citationKey(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.key === 'string' && SCOPE_KEY.test(row.key)) return row.key;
  if (typeof row.path !== 'string') return '';
  const scopeDir = path.dirname(path.dirname(path.resolve(row.path)));
  if (path.dirname(scopeDir) !== memoryRoot()) return '';
  const key = path.basename(scopeDir);
  return SCOPE_KEY.test(key) ? key : '';
}

function scopeForKey(key) {
  if (key === 'global') return globalScope();
  if (!SCOPE_KEY.test(key)) return null;
  const dir = path.join(memoryRoot(), key);
  if (!path.resolve(dir).startsWith(memoryRoot() + path.sep)) return null;
  return { key, dir, cwd: '' };
}

/**
 * 引用只存身份，不存标题和正文：解析时一律读当前索引。
 * 目标不在了就整行失效，不回退旧缓存，也不按旧名字重建。
 */
function resolveCitation(row) {
  const key = citationKey(row);
  if (!key) return null;
  const scope = scopeForKey(key);
  if (!scope) return null;
  let entry = null;
  try {
    const index = loadIndex(scope);
    scope.cwd = index.cwd || '';
    entry = (index.entries || []).find((item) => item && item.id === row.id) || null;
  } catch {
    return null;
  }
  if (!entry) return null;
  return {
    key,
    scope,
    entry,
    row: {
      id: row.id,
      title: entry.title || '',
      scope: key === 'global' ? 'global' : 'project',
      revision: Number(entry.revision) || 1,
      when: entry.when || '',
      at: row.at,
    },
  };
}

/** 界面要的那几列：不返回正文，也不返回磁盘路径。 */
export function listCitations(sessionId) {
  const data = readSessionFile(sessionId);
  const items = ((data && data.items) || []).map(resolveCitation).filter(Boolean).map((item) => item.row);
  return { items, updatedAt: (data && data.updatedAt) || '' };
}

/** 点开一条时读当前正文；目标已删/已移出记忆根目录就返回空。 */
export function readCitationBody(sessionId, id) {
  const data = readSessionFile(sessionId);
  const row = ((data && data.items) || []).find((item) => item && item.id === id);
  if (!row) return null;
  return readCitationRow(sessionId, row);
}

/** 按标题读引用正文：界面手里只有标题，id 留在引用文件里。 */
export function readCitationBodyByTitle(sessionId, title, options = {}) {
  const wanted = normalizeText(title, 120).toLowerCase();
  if (!wanted) return null;
  const data = readSessionFile(sessionId);
  const want = Number.isInteger(options.revision) ? options.revision : null;
  const scopeWanted = options.scope === 'global' || options.scope === 'project' ? options.scope : '';
  /** 引用行只存身份，标题要从当前索引解析出来再比；行上没有 title 字段。 */
  const matches = ((data && data.items) || [])
    .map((row) => ({ row, found: resolveCitation(row) }))
    .filter((item) => item.found
      && (!scopeWanted || (item.found.scope.key === 'global' ? 'global' : 'project') === scopeWanted)
      && normalizeText(item.found.row.title || '', 120).toLowerCase() === wanted);
  if (matches.length === 0) return null;
  const chosen = (want !== null
    && matches.find((item) => (Number(item.found.entry.revision) || 1) === want)) || matches[0];
  return readCitationRow(sessionId, chosen.row);
}

function readCitationRow(sessionId, row) {
  const id = row.id;
  const found = resolveCitation(row);
  if (!found) return null;
  let body;
  try {
    const current = state.readEntryBody(found.scope, id);
    if (!current) return null;
    body = current.body;
  } catch {
    return null;
  }
  return {
    ...found.row,
    status: found.entry.status || 'active',
    scopeLabel: found.scope.key === 'global' ? '全局' : path.basename(found.scope.cwd || '') || found.scope.key,
    body: body.slice(0, LIMITS.entryBytes),
  };
}

/* ------------------------------------------------------------------ *
 * 跨层：范围路由、两层去重、槽位、搬移。这些规则只在服务端判定，*
 * 模型给的是提案（memoryClass / durability / evidenceRef），不是命令。*
 * ------------------------------------------------------------------ */

export const MEMORY_CLASSES = ['personal_preference', 'project_fact', 'environment_fact', 'portable_procedure'];
export const DURABILITIES = ['durable', 'task'];

const ENVIRONMENT_KEYS = ['machine', 'targetOs', 'runtime', 'shell'];
/** 一台机器/一次运行才算收住本机痕迹；只写操作系统名（targetOs）换台机器照样不成立。 */
const MACHINE_SCOPE_KEYS = ['machine', 'runtime'];

/**
 * 范围路由：用户明确说的范围最高；没有就按记忆类别提案，设备事实必须带设备条件。
 * 判不出来就返回 needsScope，让调用方问一句，而不是默默写进某一层。
 */
/** 本机痕迹：路径、回环地址、端口。带这些字样的「通用」规则换个项目就用不了。 */
const MACHINE_BOUND_PATTERNS = [
  /(?:^|[\s(（'"`])(?:\/tmp|\/Users|\/home|\/opt|\/private|\/var|\/etc)(?:[\/]|$)/m,
  /(?:^|[\s(（'"`])~\//m,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:\\/,
  /(?:^|[^0-9])127\.0\.0\.1(?::\d+)?/,
  /(?:^|[^A-Za-z0-9.])localhost(?::\d+)?/,
  /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/,
];

function contentText(source) {
  return [source?.title, source?.summary, source?.when, source?.body, source?.topicKey]
    .filter((value) => typeof value === 'string' && value)
    .join('\n');
}

function machineBoundText(source) {
  return MACHINE_BOUND_PATTERNS.some((re) => re.test(contentText(source)));
}

/** 内容自己说了「本项目 / 这个仓库」：模型给的类别标签不能把它抬到全局层。 */
const PROJECT_BOUND_PATTERNS = [
  /本项目|这个项目|当前项目|该项目/,
  /本仓库|这个仓库|当前仓库/,
  /本工程|这个工程|当前工程/,
  /本目录|当前目录/,
  /本项目里|我们项目/,
];

function projectBoundText(source) {
  return PROJECT_BOUND_PATTERNS.some((re) => re.test(contentText(source)));
}

/**
 * 适用范围判定：内容/依据的普适性优先，模型声明的 scope 只是提案。
 * 写死了本机路径/端口又没有声明适用环境时留在项目层；声明了机器/系统条件的
 * 本机流程可以进全局层——换台机器条件不成立，自然不会拿出来用。
 */
export function routeScope(draft, options = {}) {
  const source = draft || {};
  const explicit = source.scope === 'global' || source.scope === 'project' ? source.scope : '';
  /** 根目录没确认就还没有项目层身份：不能凭 cwd 新建一个命名空间。 */
  const projectReady = Boolean(options.project) && options.project.confirmed !== false;
  const cls = typeof source.memoryClass === 'string' ? source.memoryClass : '';
  const durability = typeof source.durability === 'string' ? source.durability : 'durable';
  const evidence = typeof source.evidenceRef === 'string' ? source.evidenceRef.trim() : '';
  /** 依据本身是本机文件/路径的，不能算通用流程；正文里带本机痕迹同理。 */
  const machineBound = machineBoundText(source) || (evidence ? machineBoundText({ title: evidence }) : false);
  /** 声明了机器/系统条件，本机痕迹就被这条条件收住：规则仍可搬到所有满足条件的机器上。 */
  const envScoped = (() => {
    try {
      return (view.normalizeConditions(source.conditions) || []).some((item) => ENVIRONMENT_KEYS.includes(item.key));
    } catch {
      return false;
    }
  })();
  /** 本机痕迹只被「本机/运行时」条件收住；targetOs 是平台，不是这台机器。 */
  const machineScoped = (() => {
    try {
      return (view.normalizeConditions(source.conditions) || []).some((item) => MACHINE_SCOPE_KEYS.includes(item.key));
    } catch {
      return false;
    }
  })();
  /** 真正挡回项目层的只有「本机痕迹 + 没有声明适用环境」；只写命令名不算本机痕迹。 */
  const machineConflict = machineBound && !machineScoped;
  const base = { chosenScope: '', reasonCode: '', requiredConditions: [], needsScope: false, explicit };
  /** 通用层拿不出普适证据时：有项目就留在项目层，没有就问一次运行环境。 */
  const fallbackToProject = (reasonCode) => {
    if (projectReady) return { ...base, chosenScope: 'project', reasonCode };
    return {
      ...base,
      needsScope: true,
      reasonCode: 'needs_environment',
      requiredConditions: [{ key: 'machine', value: '' }, { key: 'runtime', value: '' }],
    };
  };
  /** 人明确点过「就存全局」才算数；模型自己提的 scope 只是提案。 */
  const humanConfirmed = options.humanScope === true || source.scopeConfirmed === true;
  /** 实验/自动整理的产物永远留在项目层：它们没有「用户要求跨项目」这层依据。 */
  const autoOrigin = source.origin === 'project_evolution' || source.origin === 'model_drafted';
  /** 「本项目里…」是项目事实的措辞，类别写成偏好/流程也不能这样进通用层。 */
  const projectBound = projectBoundText(source);
  if (durability === 'task') return { ...base, needsScope: true, reasonCode: 'task_state' };
  if (explicit && (humanConfirmed || !autoOrigin)) {
    /**
     * 只有人确认过的 scope 才代表「用户这个消息里要的那一层」；模型写进参数的 scope 只是提案。
     */
    if (explicit === 'global' && !humanConfirmed) {
      if (machineConflict) return fallbackToProject('machine_bound_scope');
      if (cls === 'project_fact') return fallbackToProject('model_global_project_fact');
      if (projectBound) return fallbackToProject('project_bound_scope');
    }
    if (explicit === 'project' && !projectReady) {
      const reasonCode = options.project && options.project.confirmed === false ? 'unconfirmed_project' : 'no_project';
      return { ...base, needsScope: true, reasonCode, requiredConditions: [{ key: 'projectRoot', value: '' }] };
    }
    return { ...base, chosenScope: explicit, reasonCode: 'explicit' };
  }
  if (!cls) {
    if (!projectReady) {
      return { ...base, needsScope: true, reasonCode: 'unconfirmed_project', requiredConditions: [{ key: 'projectRoot', value: '' }] };
    }
    return { ...base, chosenScope: 'project', reasonCode: 'unclassified_project' };
  }
  if (!MEMORY_CLASSES.includes(cls)) return { ...base, needsScope: true, reasonCode: 'unknown_class' };
  if (cls === 'project_fact') {
    if (!projectReady) {
      const reasonCode = options.project && options.project.confirmed === false ? 'unconfirmed_project' : 'no_project';
      return { ...base, needsScope: true, reasonCode, requiredConditions: [{ key: 'projectRoot', value: '' }] };
    }
    return { ...base, chosenScope: 'project', reasonCode: 'class_project_fact' };
  }
  /**
   * 自动归类只能决定「它像哪类」，不能决定跨项目；默认落点一律是当前项目。
   * 具体冲突（本机痕迹、「本项目」措辞）仍按原原因报告，其余全局结论统一降级。
   */
  const globalOutcome = (reasonCode) => (humanConfirmed
    ? { ...base, chosenScope: 'global', reasonCode }
    : fallbackToProject('model_class_project'));
  if (cls === 'personal_preference') {
    /** 偏好也分「我的习惯」和「这台机器上的习惯」：后者绑机器，不进通用层。 */
    if (machineConflict) return fallbackToProject('machine_bound_preference');
    /** 说了「本项目」的偏好其实是项目约定，类别写错也不能跨项目。 */
    if (projectBound) return fallbackToProject('project_bound_preference');
    return globalOutcome('class_personal_preference');
  }
  if (cls === 'portable_procedure') {
    if (machineConflict) return fallbackToProject('machine_bound_procedure');
    if (projectBound) return fallbackToProject('project_bound_procedure');
    /** 带适用环境条件的本机流程：条件成立时才用，换台机器自然不生效。 */
    if (envScoped) return globalOutcome('machine_scoped_procedure');
    /** 说能搬去别的项目，就要有能搬的依据；没有就先留在本项目。 */
    if (!evidence) return fallbackToProject('unbound_evidence');
    return globalOutcome('class_portable_procedure');
  }
  if (projectBound) return fallbackToProject('project_bound_environment');
  const conditions = view.normalizeConditions(source.conditions) || [];
  const scoped = conditions.some((item) => ENVIRONMENT_KEYS.includes(item.key));
  if (!scoped) {
    return {
      ...base,
      needsScope: true,
      reasonCode: 'needs_environment',
      requiredConditions: [{ key: 'machine', value: '' }, { key: 'runtime', value: '' }],
    };
  }
  return globalOutcome('class_environment_fact');
}

function locateInLayers(projectScope, id) {
  for (const source of [projectScope, globalScope()]) {
    try {
      const record = loadIndex(source).entries.find((item) => item.id === id);
      if (record) return { scope: source, record };
    } catch {
      /* 一层不可用不影响另一层 */
    }
  }
  return null;
}

/** 完全重复的判据：内容、适用范围、结构化条件、只对某个产物成立的规则、关联都算。 */
const visibleContent = (row) => JSON.stringify([
  row.title || '',
  row.summary || '',
  row.when || '',
  row.kind || 'note',
  view.conditionsKey(row.conditions),
  row.applicability || 'all_in_scope',
  row.topicKey || '',
  Array.isArray(row.tags) ? [...row.tags].map(String).sort() : [],
  Array.isArray(row.triggers) ? [...row.triggers].map(String).sort() : [],
  row.selection ? [row.selection.mode || '', row.selection.artifactKey || '', Array.isArray(row.selection.items) ? [...row.selection.items].map(String).sort() : []] : null,
  Array.isArray(row.links) ? row.links.map((link) => [String(link.type || 'related'), String(link.id)]).sort((a, b) => a[1].localeCompare(b[1])) : [],
  row.body || '',
]);

function exactDuplicate(projectScope, targetScope, draft) {
  const layers = targetScope.key === 'global' ? [globalScope()] : [projectScope, globalScope()];
  const wanted = visibleContent(draft);
  for (const source of layers) {
    const index = loadIndex(source);
    for (const item of index.entries) {
      if (visibleContent(item) === wanted) {
        return { id: item.id, title: item.title, scope: source.key === 'global' ? 'global' : 'project', revision: item.revision || 1 };
      }
    }
  }
  return null;
}

function crossLayerSimilar(projectScope, targetScope, draft) {
  const other = targetScope.key === 'global' ? projectScope : globalScope();
  const index = loadIndex(other);
  const rows = similarEntries(index.entries, draft.title, draft.summary, 2);
  return rows.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary || '',
    when: item.when || '',
    updated: item.updated || '',
    reason: item.reason || 'similar_title',
    revision: item.revision || 1,
    scope: other.key === 'global' ? 'global' : 'project',
  }));
}

function bindSameTopic(projectScope, ref) {
  if (!ref || typeof ref !== 'object') return { error: 'sameTopicAs 要写成 {scope, title}' };
  const source = ref.scope === 'global' ? globalScope() : projectScope;
  /** 句柄统一用标题：id 是底层实现，模型手里不该出现；老调用传 id 仍认。 */
  const byTitle = typeof ref.title === 'string' ? normalizeText(ref.title, 120).toLowerCase() : '';
  const record = loadIndex(source).entries.find((item) => (typeof ref.id === 'string' && item.id === ref.id)
    || (byTitle && [item.title, ...(item.aliases || [])].some((name) => normalizeText(name, 120).toLowerCase() === byTitle)));
  if (!record) return { error: `sameTopicAs 指向的记忆不存在：${ref.title || ref.id || ''}` };
  if (ref.revision !== undefined && Number(ref.revision) !== Number(record.revision || 1)) {
    return { error: `sameTopicAs 的目标已经改过：「${record.title}」` };
  }
  return { topicKey: view.topicSlot(record) };
}


/** 冲突队列：只记待办，不预写记忆；最多 20 条。 */
const CONFLICT_LIMIT = 20;

/** 待办里留一份可重放的草稿：面板能直接另存，不用用户回忆刚才想记什么。 */
const CONFLICT_DRAFT_KEYS = ['title', 'summary', 'body', 'when', 'kind', 'tags', 'conditions', 'applicability', 'selection', 'triggers', 'links', 'topicKey', 'source', 'origin', 'supersedes', 'updateTitle'];
function conflictDraftOf(draft) {
  const out = {};
  if (!draft || typeof draft !== 'object') return out;
  for (const key of CONFLICT_DRAFT_KEYS) {
    const value = draft[key];
    if (value === undefined || value === null) continue;
    if (key === 'title') out.title = normalizeText(value, 120);
    else if (key === 'summary') out.summary = normalizeText(value, 400);
    else if (key === 'body') out.body = typeof value === 'string' ? value.slice(0, 8000) : '';
    else if (key === 'when') out.when = normalizeText(value, 160);
    else if (key === 'kind') { if (KINDS.includes(value)) out.kind = value; }
    else if (key === 'tags') out.tags = Array.isArray(value) ? value.slice(0, 5) : undefined;
    else if (key === 'conditions') out.conditions = Array.isArray(value) ? value.slice(0, 8) : undefined;
    else if (key === 'applicability') out.applicability = value;
    else if (key === 'topicKey') out.topicKey = normalizeText(value, 80);
    /** 适用范围、召回触发词与关联整份重放：经过待裁决不能改变语义。 */
    else if (key === 'selection') out.selection = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
    else if (key === 'triggers') out.triggers = Array.isArray(value) ? value.slice(0, 8).map((item) => normalizeText(item, 40)).filter(Boolean) : [];
    else if (key === 'links') out.links = Array.isArray(value) ? value.slice(0, 3).map((item) => (item && typeof item === 'object' ? { ...item } : null)).filter(Boolean) : [];
    else if (key === 'source') out.source = value;
    else if (key === 'origin') out.origin = value;
    /** 被取代的那条与要改的标题必须整份重放：批准后也是「替换旧规范」，不是另加一条。 */
    else if (key === 'supersedes') { const ref = typeof value === 'string' ? value.trim() : ''; if (ref) out.supersedes = ref.slice(0, 160); }
    else if (key === 'updateTitle') { const title = normalizeText(value, 120); if (title) out.updateTitle = title; }
  }
  return out;
}

function queueConflictLocked(scope, draft, candidates) {
  const index = loadIndex(scope);
  const title = normalizeText(draft && draft.title, 120);
  if (!title) return Array.isArray(index.conflicts) ? index.conflicts.length : 0;
  const scopeKey = scope.key === 'global' ? 'global' : 'project';
  const now = new Date().toISOString();
  const rows = Array.isArray(index.conflicts) ? index.conflicts : [];
  const view = candidates.slice(0, 2).map((item) => ({
    id: item.id, title: item.title || '', when: item.when || '', reason: item.reason || 'similar_title',
  }));
  const hit = rows.find((row) => row.title === title && row.scope === scopeKey);
  const replay = conflictDraftOf(draft);
  if (hit) {
    hit.candidates = view;
    hit.draft = replay;
    /** 草稿被后来的反馈替换过：版本必须涨，旧面板不能拿旧版直接批准。 */
    hit.revision = (Number(hit.revision) || 1) + 1;
    hit.updatedAt = now;
  } else {
    rows.push({ id: `cf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, title, scope: scopeKey, candidates: view, draft: replay, revision: 1, createdAt: now, updatedAt: now });
  }
  index.conflicts = rows.slice(-CONFLICT_LIMIT);
  saveIndex(scope, index);
  return index.conflicts.length;
}

/** 按稳定 id 找；旧调用还传标题，只为兼容已有数据与测试。 */
function conflictRowLocked(scope, ref) {
  const rows = Array.isArray(loadIndex(scope).conflicts) ? loadIndex(scope).conflicts : [];
  const layer = scope.key === 'global' ? 'global' : 'project';
  if (ref && typeof ref === 'object' && ref.id) return rows.find((row) => row.id === ref.id && row.scope === layer) || null;
  const norm = normalizeText(typeof ref === 'string' ? ref : '', 120);
  return rows.find((row) => row.title === norm && row.scope === layer) || null;
}

function clearConflictLocked(scope, ref) {
  const index = loadIndex(scope);
  const rows = Array.isArray(index.conflicts) ? index.conflicts : [];
  const id = ref && typeof ref === 'object' && ref.id ? ref.id : '';
  const norm = id ? '' : normalizeText(typeof ref === 'string' ? ref : '', 120);
  const next = rows.filter((row) => (id ? row.id !== id : !(row.title === norm && row.scope === (scope.key === 'global' ? 'global' : 'project'))));
  const removed = rows.length - next.length;
  /** 说清删掉了几条：删 0 条却回成功，面板会以为处理完了，下次点还是这行。 */
  if (removed > 0) {
    index.conflicts = next;
    saveIndex(scope, index);
  }
  return { removed, left: next.length };
}

/** 面板待裁决列表：只给可重放草稿与候选，不预写记忆。 */
export function conflictsOf(scope) {
  const rows = loadIndex(scope).conflicts;
  return Array.isArray(rows) ? JSON.parse(JSON.stringify(rows)) : [];
}

/** 版本对不上就拒绝：用户看到的草稿和现在这条不是同一版。 */
function staleDraft(row, ref) {
  if (!ref || typeof ref !== 'object' || ref.expectedRevision === undefined) return false;
  return Number(ref.expectedRevision) !== (Number(row.revision) || 1);
}

/** 确认另存：用队列里的草稿按 distinct 重放一次，成功后按 id 出队。 */
export function resolveConflict(scope, ref, options = {}) {
  /** 版本检查、另存和出队必须在同一临界区：中间被新反馈改写时，旧面板不能批准新草稿。 */
  return withLocks([scope, globalScope()], () => {
    const row = conflictRowLocked(scope, ref);
    if (!row) return { ok: false, reasonCode: 'gone', reason: '这条待裁决已经不在了，刷新面板看看' };
    if (staleDraft(row, ref)) return { ok: false, reasonCode: 'stale_draft', reason: '这条待裁决又更新了，刷新后再处理' };
    const draft = { ...(row.draft || {}), resolution: 'distinct', writeMode: options.writeMode === 'append' ? 'append' : 'patch' };
    if (scope.key === 'global') draft.scope = 'global';
    else draft.scope = 'project';
    if (!draft.title) draft.title = row.title;
    const result = saveEntry(scope, draft);
    if (result && result.needsResolution) return { ok: false, reason: '还是相近：换一个标题或等确认', result };
    if (result && result.needsScope) {
      const reason = result.reasonCode === 'memory_disabled' ? '这层记忆已关闭' : '这条记忆的适用范围还没定，先说明当前环境';
      return { ok: false, reason, result };
    }
    /** 存成功时 saveEntry 已经按标题把这条出队，这里再按 id 清一次是兜底，删 0 条也算成功。 */
    clearConflictLocked(scope, { id: row.id });
    return { ok: true, result, record: result && result.record };
  });
}

/** 删掉待裁决：用户决定不再另存。 */
export function dropConflict(scope, ref) {
  return withLocks([scope, globalScope()], () => {
    const row = conflictRowLocked(scope, ref);
    if (!row) return { ok: false, reasonCode: 'gone', reason: '这条待裁决已经不在了，刷新面板看看' };
    if (staleDraft(row, ref)) return { ok: false, reasonCode: 'stale_draft', reason: '这条待裁决又更新了，刷新后再处理' };
    if (clearConflictLocked(scope, { id: row.id }).removed === 0) return { ok: false, reasonCode: 'gone', reason: '这条待裁决已经不在了，刷新面板看看' };
    return { ok: true };
  });
}

/** 当前层还有几条没处理的冲突。 */
export function pendingConflictsOf(scope) {
  const rows = loadIndex(scope).conflicts;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * 保存的唯一入口：先路由，再在两层里查重（完全相同 → existing_ref；只是相近 → 只给候选），
 * 最后才写。写之前判不出来的范围返回 needsScope，不替用户选。
 */
function saveTargetOf(projectScope, source) {
  /** 更新已有条目：先按 id 认出它到底在哪一层，只锁那一层。 */
  const id = source && typeof source.id === 'string' ? source.id.trim() : '';
  if (id) {
    const found = locateInLayers(projectScope, id);
    if (found) return found.scope;
  }
  /** 新增条目：归属由路由定，写全局就不该占住项目锁，反之亦然。 */
  const routed = routeScope(source, { project: projectScope });
  return routed.chosenScope === 'global' ? globalScope() : projectScope;
}

export function saveEntry(projectScope, source) {
  /** 只锁真正要写的那一层：别的项目写它自己的条目时，不会因为共享全局锁互相等待。 */
  return withLocks([saveTargetOf(projectScope, source)], () => {
    const control = loadIndex(projectScope).__control || state.controlOf(null);
    if (!control.enabled) {
      return { needsScope: true, chosenScope: '', reasonCode: 'memory_disabled', requiredConditions: [], needsResolution: false, similarList: [], draft: null };
    }
    const routed = routeScope(source, { project: projectScope });
    const draft = (() => {
      try { return normalizeDraft({ ...source, title: source && source.title }); } catch { return null; }
    })();
    if (routed.needsScope) {
      return { needsScope: true, chosenScope: '', reasonCode: routed.reasonCode, requiredConditions: routed.requiredConditions, needsResolution: false, similarList: [], draft };
    }
    let next = source;
    if (source.sameTopicAs) {
      const bound = bindSameTopic(projectScope, source.sameTopicAs);
      if (bound.error) throw new Error(bound.error);
      next = { ...source, topicKey: bound.topicKey };
    }
    let targetScope = routed.chosenScope === 'global' ? globalScope() : projectScope;
    if (next.id) {
      const found = locateInLayers(projectScope, next.id);
      if (!found) throw new Error('没有这条记忆，改用新增');
      /** 写了 scope 就只改那一层：同名条目在别层时不能悄悄改到别处。 */
      const explicitScope = String(source.scope || '').trim();
      if (explicitScope === 'global' && found.scope.key !== 'global') {
        throw new Error('这条记忆在项目层；scope="global" 只改全局同名条目');
      }
      if (explicitScope === 'project' && found.scope.key === 'global') {
        throw new Error('这条记忆在全局层；只有明确说「所有项目都这样」才改它');
      }
      targetScope = found.scope;
      /** 面板拿旧版本改正文：中间被别处改过就拒绝，不覆盖别人的修改。 */
      if (source.expectedRevision !== undefined) {
        const current = loadIndex(targetScope).entries.find((item) => item.id === next.id && item.status !== 'archived');
        if (!current) throw new Error('没有这条记忆，改用新增');
        if (!Number.isInteger(Number(source.expectedRevision)) || Number(current.revision) !== Number(source.expectedRevision)) {
          throw new state.StateError('conflict', '这条记忆已经被更新过，刷新后再改');
        }
      }
    }
    /** 更新已有项目条目也必须落在确认过的根目录里。 */
    if (targetScope.key !== 'global' && targetScope.confirmed === false) {
      return {
        needsScope: true, chosenScope: '', reasonCode: 'unconfirmed_project',
        requiredConditions: [{ key: 'projectRoot', value: '' }], needsResolution: false, similarList: [], draft,
      };
    }
    if (!next.id && draft && source.resolution !== 'distinct') {
      const duplicate = exactDuplicate(projectScope, targetScope, draft);
      if (duplicate) {
        return { existing: duplicate, needsResolution: false, needsScope: false, similarList: [], draft, changed: false, merged: false, chosenScope: duplicate.scope };
      }
      const near = crossLayerSimilar(projectScope, targetScope, draft);
      if (near.length) {
        const pendingConflicts = queueConflictLocked(targetScope, draft, near);
        return {
          needsResolution: true,
          crossLayer: true,
          /** 相近那条在哪一层：跨层「用同一个标题再存一次」得落在它那层，否则会另建一条。 */
          crossScope: near[0] && near[0].scope === 'global' ? 'global' : 'project',
          similarList: near,
          similar: near[0],
          draft,
          needsScope: false,
          pendingConflicts,
          chosenScope: targetScope.key === 'global' ? 'global' : 'project',
        };
      }
    }
    const foreign = targetScope.key === 'global' ? [] : loadIndex(globalScope()).entries;
    const result = upsertLocked(targetScope, next, { foreignEntries: foreign });
    if (!result.needsResolution) clearConflictLocked(targetScope, draft ? draft.title : next.title);
    if (result.needsResolution) {
      const rows = Array.isArray(result.similarList) ? result.similarList : [];
      const pendingConflicts = queueConflictLocked(targetScope, result.draft || draft, rows);
      return { ...result, chosenScope: targetScope.key === 'global' ? 'global' : 'project', needsScope: false, reasonCode: routed.reasonCode, pendingConflicts };
    }
    return { ...result, chosenScope: targetScope.key === 'global' ? 'global' : 'project', needsScope: false, reasonCode: routed.reasonCode };
  });
}

/** 两层合并后的现行规范：同槽位只给胜出的那条；冲突或条件未知的不进自动召回。 */
export function visibleRules(projectScope, context = {}, options = {}) {
  return withLocks([projectScope, globalScope()], () => {
    const projectIndex = loadIndex(projectScope);
    const globalIndex = loadIndex(globalScope());
    const project = projectIndex.entries.filter((item) => readableRecord(item, options, projectIndex));
    const global = globalIndex.entries.filter((item) => readableRecord(item, options, globalIndex));
    const resolved = view.resolveTopics(project, global, context);
    const winners = [];
    for (const row of resolved.values()) {
      if (row.status === 'ok' && row.record) winners.push({ record: row.record, scope: row.scope, key: row.key });
    }
    return { winners, resolved };
  });
}

/* --------------------------- 跨层搬移 --------------------------- */

/** 搬移两侧都从协调文件里的身份还原：不拿调用方项目顶替另一层的 scope。 */
function moveProjectOf(intent) {
  const side = intent.source.scopeKey === globalScope().key ? intent.target : intent.source;
  return {
    key: side.scopeKey,
    dir: path.join(state.memoryRoot(), side.scopeKey),
    cwd: typeof side.cwd === 'string' ? side.cwd : '',
    requestedCwd: typeof side.cwd === 'string' ? side.cwd : '',
    rootSource: 'move-intent',
    confirmed: true,
  };
}

const moveTargetOf = (intent) => (intent.target.scopeKey === globalScope().key ? globalScope() : moveProjectOf(intent));
const moveSourceOf = (intent) => (intent.source.scopeKey === globalScope().key ? globalScope() : moveProjectOf(intent));

/** A 项目发起的搬移只能在 A 项目里续跑：换项目续跑会把它解释成另一层，必须先挡住。 */
function assertMoveCaller(projectScope, intent) {
  const owner = intent.source.scopeKey === globalScope().key ? intent.target : intent.source;
  if (projectScope.key !== owner.scopeKey) {
    throw new state.StateError('conflict', `这笔搬移属于另一个项目（${owner.scopeKey}），不能在当前项目续跑；回到原项目再调用 resumeMove`);
  }
  if (owner.cwd && projectScope.cwd) {
    let left = owner.cwd;
    let right = projectScope.cwd;
    try {
      left = fs.realpathSync(left);
    } catch {
      /* 旧目录可能已不在，按原样比较 */
    }
    try {
      right = fs.realpathSync(right);
    } catch {
      /* 同上 */
    }
    if (path.resolve(left) !== path.resolve(right)) {
      throw new state.StateError('conflict', '这笔搬移属于另一个项目，不能在当前项目续跑；回到原项目再调用 resumeMove');
    }
  }
}

function entryOf(scope, id) {
  return state.load(scope, { allowMove: true, allowPurge: true }).state.entries.find((row) => row.id === id) || null;
}

function stageOf(scope) {
  const loaded = state.load(scope, { allowMove: true, allowPurge: true });
  return { state: loaded.state, exists: loaded.exists };
}

/** 目标库可能还不存在：不存在时不带 CAS 期望值；刚被别处写入就重读一次再试。 */
function transactWithRetry(scope, base, work) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = state.load(scope, { allowMove: true, allowPurge: true });
    const expectedEpoch = base.expectedEpoch || loaded.state.epoch;
    const options = loaded.exists
      ? { ...base, expected: { generation: loaded.state.generation, epoch: expectedEpoch } }
      : { ...base, expected: null };
    delete options.expectedEpoch;
    try {
      return state.transact(scope, options, work);
    } catch (error) {
      const retryable = error instanceof state.StateError && error.code === 'conflict' && /重读后再写/.test(error.message);
      if (attempt === 0 && retryable) continue;
      throw error;
    }
  }
  throw new state.StateError('recover_failed', '写入重试后仍冲突');
}

function commitTarget(scope, record, intent) {
  const toEpoch = typeof intent.target.toEpoch === 'string' ? intent.target.toEpoch : '';
  transactWithRetry(scope, {
    operationId: `${intent.operationId}:in`,
    payloadDigest: `${intent.source.id}->${intent.target.newId}`,
    allowMove: true,
    expectedEpoch: typeof intent.target.epoch === 'string' ? intent.target.epoch : '',
    nextEpoch: toEpoch,
  }, (draft) => {
    if (draft.entries.some((row) => row.id === intent.target.newId)) return { changed: false };
    const next = JSON.parse(JSON.stringify(record));
    next.id = intent.target.newId;
    next.status = 'active';
    next.revision = 1;
    next.updated = new Date().toISOString();
    next.current.topicKey = intent.topicKey || next.current.topicKey || intent.source.id;
    next.maintenance = next.maintenance || {};
    next.maintenance.lastUsed = next.updated;
    next.current.body = record.current.body;
    draft.entries.push(next);
    return {
      changed: true,
      kind: 'moveIn',
      receipt: { moveId: intent.operationId, entryId: intent.target.newId, from: intent.source.scopeKey },
    };
  });
}

function cleanSource(scope, intent) {
  const toEpoch = typeof intent.source.toEpoch === 'string' ? intent.source.toEpoch : '';
  transactWithRetry(scope, {
    operationId: `${intent.operationId}:out`,
    payloadDigest: intent.source.id,
    allowMove: true,
    expectedEpoch: typeof intent.source.epoch === 'string' ? intent.source.epoch : '',
    nextEpoch: toEpoch,
  }, (draft) => {
    const before = draft.entries.length;
    draft.entries = draft.entries.filter((row) => row.id !== intent.source.id);
    draft.candidates = draft.candidates.filter((row) => row.sourceId !== intent.source.id
      && !(Array.isArray(row.sourceIds) && row.sourceIds.includes(intent.source.id)));
    draft.receipts = draft.receipts.filter((row) => row.moveId !== intent.operationId || row.kind === 'moveOut');
    return {
      changed: draft.entries.length !== before,
      kind: 'moveOut',
      receipt: { moveId: intent.operationId, entryId: intent.source.id, to: intent.target.scopeKey },
    };
  });
}

/** 完成条件只看身份与 epoch：current、prev、回执、两侧 epoch 都到位才算搬完。 */
function verifyMove(sourceScope, targetScope, intent) {
  const problems = [];
  const target = stageOf(targetScope);
  const source = stageOf(sourceScope);
  if (intent.target.toEpoch && target.state.epoch !== intent.target.toEpoch) problems.push('目标层 epoch 不是这一步该到的值');
  if (intent.source.toEpoch && source.state.epoch !== intent.source.toEpoch) problems.push('源层 epoch 不是这一步该到的值');
  if (!target.state.entries.some((row) => row.id === intent.target.newId && row.status === 'active')) problems.push('目标层没有这条记忆');
  if (source.state.entries.some((row) => row.id === intent.source.id)) problems.push('源层还留着旧条目');
  if (!target.state.receipts.some((row) => row.operationId === `${intent.operationId}:in`)) problems.push('目标层缺少写入回执');
  if (!source.state.receipts.some((row) => row.operationId === `${intent.operationId}:out`)) problems.push('源层缺少删除回执');
  const prev = (scope) => {
    try {
      return JSON.parse(fs.readFileSync(state.stateFiles(scope).prev, 'utf8')).payload;
    } catch {
      return null;
    }
  };
  const targetPrev = prev(targetScope);
  if (!targetPrev) problems.push('目标层缺少可恢复的上一步');
  else if (!(targetPrev.entries || []).some((row) => row.id === intent.target.newId)) problems.push('目标层上一步里没有这条记忆');
  const sourcePrev = prev(sourceScope);
  if (!sourcePrev) problems.push('源层缺少可恢复的上一步');
  else if ((sourcePrev.entries || []).some((row) => row.id === intent.source.id)) problems.push('源层上一步里还留着旧条目');
  if (problems.length) {
    throw new state.StateError('recover_failed', `移动恢复没通过校验（${problems.join('；')}）；协调文件保留：${intent.operationId}`);
  }
}

function driveMove(projectScope, intent, options = {}) {
  assertMoveCaller(projectScope, intent);
  const sourceScope = moveSourceOf(intent);
  const targetScope = moveTargetOf(intent);
  const target = stageOf(targetScope);
  const source = stageOf(sourceScope);
  const targetHas = target.state.entries.find((row) => row.id === intent.target.newId) || null;
  if (targetHas && intent.target.toEpoch && target.state.epoch !== intent.target.toEpoch) {
    throw new state.StateError('conflict', `目标层在搬移期间被改过（epoch 变了），先人工确认；协调文件保留：${intent.operationId}`);
  }
  if (!targetHas) {
    if (target.exists && intent.target.epoch && target.state.epoch !== intent.target.epoch) {
      throw new state.StateError('conflict', `目标层在搬移期间被改过（epoch 变了），先人工确认；协调文件保留：${intent.operationId}`);
    }
    const record = source.state.entries.find((row) => row.id === intent.source.id) || null;
    if (!record) throw new state.StateError('recover_failed', `移动中断且源与目标都找不到这条记忆；协调文件保留：${intent.operationId}`);
    commitTarget(targetScope, record, intent);
    if (options.stopAfter === 'target') {
      return { status: 'move_pending', stage: 'target_committed', operationId: intent.operationId, id: intent.target.newId };
    }
  }
  const sourceEntry = source.state.entries.find((row) => row.id === intent.source.id) || null;
  if (sourceEntry) {
    if (intent.source.epoch && source.state.epoch !== intent.source.epoch) {
      throw new state.StateError('conflict', `源层在搬移期间被改过（epoch 变了），先人工确认；协调文件保留：${intent.operationId}`);
    }
    cleanSource(sourceScope, intent);
    removeBody(sourceScope, intent.source.id);
    if (options.stopAfter === 'source') {
      return { status: 'move_pending', stage: 'source_cleaned', operationId: intent.operationId, id: intent.target.newId };
    }
  }
  // 收尾也重放：先把两侧 prev 封成新状态，再逐项校验，最后才清协调文件。
  state.sealPrev(targetScope);
  state.sealPrev(sourceScope);
  removeBody(sourceScope, intent.source.id);
  state.cleanStateResidue(targetScope);
  state.cleanStateResidue(sourceScope);
  verifyMove(sourceScope, targetScope, intent);
  state.clearMoveIntent();
  return {
    status: 'moved',
    id: intent.target.newId,
    previousId: intent.source.id,
    from: sourceScope.key === 'global' ? 'global' : 'project',
    to: targetScope.key === 'global' ? 'global' : 'project',
    operationId: intent.operationId,
    revision: 1,
  };
}
/**
 * §13.6 五步：根锁 → 协调文件 → 目标写入（moveIn + target.prev）→ 源删除（moveOut + source.prev）→ 校验后清协调文件。
 * 每一步都可按 operationId 重放；协调文件在 = 屏障，两层读写都先收尾。
 * 协调文件里带项目身份与两侧 epoch：换项目续跑会被拒绝，续跑也不再靠猜。
 */
export function move(projectScope, id, options = {}) {
  if (!(loadIndex(projectScope).__control || state.controlOf(null)).enabled) {
    throw new state.StateError('conflict', '本项目记忆已关闭，先开启再整理');
  }
  return state.withRootLock(() => {
    const existing = state.readMoveIntent();
    if (existing) {
      const operationId = options.operationId || existing.operationId;
      if (operationId !== existing.operationId) {
        throw new state.StateError('conflict', `另一笔移动还没收尾（${existing.operationId}），先调用 resumeMove`);
      }
      return driveMove(projectScope, existing, options);
    }
    const projectIndex = loadIndex(projectScope);
    const projectRecord = projectIndex.entries.find((row) => row.id === id);
    const globalIndex = projectRecord ? null : loadIndex(globalScope());
    const globalRecord = globalIndex ? globalIndex.entries.find((row) => row.id === id) : null;
    if (!projectRecord && !globalRecord) throw new state.StateError('conflict', `没有这条记忆：${id}`);
    const sourceScope = projectRecord ? projectScope : globalScope();
    const sourceIndex = projectRecord ? projectIndex : globalIndex;
    const record = projectRecord || globalRecord;
    /** 实验记录只能在原项目内用：普通移动不能把它带进全局层。 */
    if (record.origin === EXPERIMENTAL_ORIGIN && options.target === 'global') {
      throw new state.StateError('conflict', '实验规则不能直接搬到全局，先采纳为普通项目规范');
    }
    const targetScope = options.target === 'global' ? globalScope() : projectScope;
    if (targetScope.dir === sourceScope.dir) throw new state.StateError('conflict', '源和目标在同一层');
    const targetIndex = loadIndex(targetScope);
    const duplicate = targetIndex.entries.find((row) => visibleContent(row) === visibleContent(record));
    if (duplicate) throw new state.StateError('conflict', `目标层已有相同内容（${duplicate.id}），不搬`);
    if (view.topicSlot(record).trim()) {
      const slot = targetIndex.entries.find((row) => (row.topicKey || '') && row.topicKey === record.topicKey
        && view.conditionsKey(row.conditions) === view.conditionsKey(record.conditions) && row.id !== record.id);
      if (slot) throw new state.StateError('conflict', `目标层已有同一槽位（${slot.id}），不搬`);
    }
    /** 入边不重写：搬走前先证明这条记录自己的出边在目标层仍可见。 */
    for (const link of view.linksOf(record)) {
      const visible = targetIndex.entries.some((row) => row.id === link.id)
        || (targetScope.key !== 'global' && sourceIndex.entries.some((row) => row.id === link.id));
      if (!visible) throw new state.StateError('conflict', `关联目标 ${link.id} 在目标层不可见，先解除关联再搬`);
    }
    const operationId = typeof options.operationId === 'string' && options.operationId ? options.operationId : `mov_${crypto.randomBytes(6).toString('hex')}`;
    const newId = `mem_${crypto.createHash('sha256').update(`${operationId}:${id}`).digest('hex').slice(0, 12)}`;
    /** 目标 epoch 由 operationId 决定：续跑时不需要再猜「现在应该是第几代」。 */
    const epochOf = (side) => `e${crypto.createHash('sha256').update(`${operationId}:${side}`).digest('hex').slice(0, 20)}`;
    const identity = (scope, index) => ({
      scopeKey: scope.key,
      cwd: typeof scope.cwd === 'string' ? scope.cwd : '',
      storeId: (index.__meta && index.__meta.storeId) || '',
    });
    const intent = state.writeMoveIntent({
      operationId,
      source: {
        ...identity(sourceScope, sourceIndex),
        id,
        revision: record.revision || 1,
        epoch: sourceIndex.epoch,
        toEpoch: epochOf('out'),
      },
      target: {
        ...identity(targetScope, targetIndex),
        newId,
        epoch: targetIndex.epoch,
        toEpoch: epochOf('in'),
      },
      topicKey: view.topicSlot(record),
    });
    return driveMove(projectScope, intent, options);
  });
}

/** 恢复入口：只认根目录的协调文件；没有就什么都不做。 */
export function resumeMove(projectScope, options = {}) {
  return state.withRootLock(() => {
    const intent = state.readMoveIntent();
    if (!intent) return { status: 'clean' };
    return driveMove(projectScope, intent, options);
  });
}

export function movePending() {
  return state.readMoveIntent();
}


// ── 项目实验：少量规则、候选与整理回执 ────────────────────────────────

const EXPERIMENT_RULE_STATES = new Set(['pending', 'trial', 'active', 'paused']);

function learningRulesOf(index) {
  return index.entries.filter((record) => isExperimentalRecord(record) && record.status !== 'archived');
}

function visibleLearningRule(record) {
  const state = record.learning?.state;
  return EXPERIMENT_RULE_STATES.has(state) && state !== 'paused';
}

function learningRuleView(record) {
  return {
    id: record.id,
    revision: Number(record.revision) || 1,
    title: record.title,
    summary: record.summary || '',
    body: record.body || '',
    applicability: record.applicability || 'unresolved',
    conditions: Array.isArray(record.conditions) ? record.conditions : [],
    topicKey: record.topicKey || '',
    origin: record.origin,
    reviewState: record.reviewState === 'legacy_unreviewed' ? 'legacy_unreviewed' : 'active',
    state: record.learning?.state || 'pending',
    samples: (Array.isArray(record.learning?.samples) ? record.learning.samples : []).slice(-4).map((row) => ({
      dimension: row.dimension || '作品',
      artifactVersion: row.artifactVersion || '',
      verified: row.verified === true,
      at: row.at || '',
    })),
    checkpoints: (Array.isArray(record.learning?.checkpoints) ? record.learning.checkpoints : []).slice(-3).map((row) => ({
      text: row.text || '',
      at: row.at || '',
    })),
    learning: JSON.parse(JSON.stringify(record.learning || {})),
    updated: record.updated || '',
    created: record.created || '',
  };
}

/**
 * 管理面读取：候选、试用、已生效与暂停都在同一处，正文与来源只给管理面；
 * 普通记忆读取面不会调用这个入口。
 */
export function learningSnapshot(scope, options = {}) {
  const index = loadIndex(scope, options);
  const evolution = index.__evolution;
  const rules = learningRulesOf(index).map(learningRuleView);
  return {
    evolution,
    enabled: evolution.enabled === true,
    compatible: evolution.compatible !== false,
    rules,
    counts: {
      pending: rules.filter((row) => row.state === 'pending').length,
      trial: rules.filter((row) => row.state === 'trial').length,
      active: rules.filter((row) => row.state === 'active').length,
      paused: rules.filter((row) => row.state === 'paused').length,
    },
    economy: economyOf(evolution.learning),
    effect: learning.effectSummary(evolution.learning),
  };
}

/** 用量只报真实已知；缺字段时标未知，不补零。 */
function economyOf(ledger) {
  const rows = Array.isArray(ledger?.receipts) ? ledger.receipts : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let knownCalls = 0;
  for (const row of rows) {
    if (row.status !== 'applied' && row.status !== 'no_change' && row.status !== 'failed') continue;
    calls += 1;
    if (row.usage && row.usage.known === true) {
      knownCalls += 1;
      inputTokens += Number(row.usage.inputTokens) || 0;
      outputTokens += Number(row.usage.outputTokens) || 0;
    }
  }
  return { calls, knownCalls, inputTokens: knownCalls ? inputTokens : null, outputTokens: knownCalls ? outputTokens : null, recent: rows.slice(-8).reverse() };
}

/** 给整理器的候选规则：只读、有限，不跨项目。 */
/** 整理器看到的规则顺序与扣尝试时一致：按状态/最近使用排序，不靠插入顺序。 */
function orderedLearningRules(index) {
  const visible = learningRulesOf(index).filter(visibleLearningRule);
  return learning.orderOrganizerRules(visible, { limit: learning.LIMITS.organizerRules });
}

export function learningRulesForOrganizer(scope) {
  const index = loadIndex(scope);
  return orderedLearningRules(index).map(learningRuleView);
}

/**
 * 整理前扣一次尝试：开关、身份与限额都在项目锁内再确认。
 * 失败也计数，所以模型超时/调用失败不能靠重试绕开限额。
 */
export function beginLearningAttempt(scope, options = {}) {
  const episodeId = String(options.episodeId || '');
  /** 项目层候选没有作品绑定：按项目身份记一次尝试，限额照样生效，不编造作品 id。 */
  const attemptKey = episodeId || `project:${scope.key}`;
  const now = options.now || Date.now();
  return withLock(scope, () => {
    const index = loadIndex(scope);
    const evolution = index.__evolution;
    if (!evolution.enabled || evolution.compatible === false) return { ok: false, reason: '实验没有开启' };
    if (evolution.policyVersion !== learning.POLICY_VERSION) return { ok: false, reason: '实验策略版本不认' };
    const check = learning.quota(evolution.learning, { episodeId: attemptKey, now });
    if (!check.ok) return { ...check, learning: evolution.learning };
    const next = learning.recordAttempt(evolution.learning, { episodeId: attemptKey, now });
    try {
      const result = state.transact(scope, {
        operationId: options.operationId || '',
        expected: { generation: index.generation, epoch: index.epoch },
      }, (draft) => {
        const evo = draft.experimental && draft.experimental.projectEvolution;
        if (!evo || evo.enabled !== true) return { changed: false };
        evo.learning = next;
        return { changed: true };
      });
      return {
        ok: true,
        epoch: evolution.epoch,
        generation: index.generation,
        episodeId,
        learning: next,
        rules: orderedLearningRules(index).map(learningRuleView),
        replayed: result.replayed === true,
      };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '整理没有开始' };
    }
  });
}

function episodeOfEvolution(evolution, episodeId) {
  return evolution?.tasks?.episodes && typeof evolution.tasks.episodes === 'object'
    ? evolution.tasks.episodes[episodeId] || null
    : null;
}

function addLearningReceipt(evolution, row) {
  evolution.learning = evolution.learning && typeof evolution.learning === 'object'
    ? evolution.learning
    : state.emptyLearning();
  evolution.learning.receipts = [...(Array.isArray(evolution.learning.receipts) ? evolution.learning.receipts : []), row]
    .slice(-learning.LIMITS.receipts);
}

/**
 * 提交门：锁内重查开关、epoch、作品版本、目标版本与来源；任何一项变了整批不写。
 * 旧提案可以留下一次调用用量，但不能靠重放把旧正文写进新状态。
 */
export function commitLearning(scope, batch = {}) {
  const changes = Array.isArray(batch.changes) ? batch.changes : [];
  const episodeId = String(batch.episodeId || '');
  const operationId = String(batch.operationId || '');
  const now = batch.now || Date.now();
  const at = new Date(now).toISOString();
  /**
   * 没绑作品的候选（learning.candidateFrom 在项目层给的空 episodeId）按项目身份提交：
   * 不编造作品 id，但必须由本项目发起；规则版本、epoch 与目标版本照旧要对得上。
   */
  if (!episodeId && String(batch.projectId || '') !== scope.key) return { ok: false, reason: '缺少作品标识' };
  if (!operationId) return { ok: false, reason: '缺少提交标识' };
  if (changes.length > learning.LIMITS.maxChanges) return { ok: false, reason: '一次改动太多' };
  return withLock(scope, () => {
    if (!(loadIndex(scope).__control || state.controlOf(null)).enabled) return { ok: false, reason: '本项目记忆已关闭' };
    let receipt = null;
    try {
      const result = state.transact(scope, {
        operationId,
        payloadDigest: crypto.createHash('sha256').update(JSON.stringify(changes)).digest('hex'),
      }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (!evolution || evolution.enabled !== true) throw new Error('实验没有开启，这次整理作废');
        if (evolution.policyVersion !== learning.POLICY_VERSION) throw new Error('实验策略版本不认');
        if (batch.epoch && evolution.epoch !== batch.epoch) throw new Error('实验已经重新开启过，这次整理作废');
        const episode = episodeId ? episodeOfEvolution(evolution, episodeId) : null;
        if (episodeId && !episode) throw new Error('作品已经失效，这次整理作废');
        if (episodeId && batch.sessionId) {
          const focus = evolution.tasks?.sessions?.[batch.sessionId];
          if (!focus || focus.episodeId !== episodeId) throw new Error('这期已经换到别的作品，这轮结果没采用');
        }
        if (episode && batch.episodeUpdatedAt && episode.updatedAt !== batch.episodeUpdatedAt) throw new Error('用户又改过这期，这次整理作废');
        const prepared = new Map((Array.isArray(batch.preparedTargets) ? batch.preparedTargets : []).map((row) => [row.id, row]));
        /** 本批已经校验并并过的目标：同一批里再并一次不用重新对整理前的版本。 */
        const mergedInBatch = new Set();
        /** 并进已有条目等于改它：整理前没固定版本、版本或摘要对不上的，和显式目标一样整批作废。 */
        const assertPreparedTarget = (entry) => {
          if (mergedInBatch.has(entry.id)) return;
          const expected = prepared.get(entry.id);
          /**
           * 整批没带整理前快照的调用（模型新建规则那条老路）不做版本比对，否则合并会整批失败；
           * 带了快照却查不到这一条，说明它在整理前不在场，按没固定版本处理。
           */
          if (!expected) {
            if (prepared.size > 0) throw new Error('目标规则没有在整理前固定版本');
            return;
          }
          if (Number(entry.revision) !== Number(expected.revision)) throw new Error('目标规则刚被改过，这次整理作废');
          if (expected.specDigest && learning.specDigestOf(toFlat(entry)) !== expected.specDigest) throw new Error('目标规则已经变过，这次整理作废');
          mergedInBatch.add(entry.id);
        };
        let touched = 0;
        const currentRules = draft.entries.filter((entry) => entry.status === 'active' && isExperimentalRecord(toFlat(entry)));
        for (const change of changes) {
          if (change.target !== 'new') {
            const entry = draft.entries.find((row) => row.id === change.id && row.status === 'active');
            if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('目标规则已经不存在，这次整理作废');
            const expected = prepared.get(change.id);
            if (!expected) throw new Error('目标规则没有在整理前固定版本');
            if (Number(entry.revision) !== Number(expected.revision)) throw new Error('目标规则刚被改过，这次整理作废');
            const flat = toFlat(entry);
            if (expected.specDigest && learning.specDigestOf(flat) !== expected.specDigest) throw new Error('目标规则已经变过，这次整理作废');
            if (change.feedbackType === 'artifact_accept' || change.feedbackType === 'execution_miss') {
              const next = change.feedbackType === 'artifact_accept'
                ? learning.addSample(flat.learning, {
                  episodeId,
                  artifactVersion: batch.episodeUpdatedAt || '',
                  dimension: batch.dimension || learning.dimensionOf(batch.feedbackText),
                  messageIds: batch.messageIds || [],
                  at,
                })
                : learning.addCheckpoint(flat.learning, {
                  text: change.currentText || `交付前核对：${flat.title}`,
                  messageIds: batch.messageIds || [],
                  at,
                });
              next.updatedAt = at;
              entry.revision = Number(entry.revision) + 1;
              entry.updatedAt = at;
              entry.maintenance = { ...(entry.maintenance || {}), learning: next };
              touched += 1;
              continue;
            }
            const merged = learning.mergeChange(flat, change, { now });
            const evidence = {
              sourceType: 'human_feedback',
              feedbackType: change.feedbackType,
              sessionId: String(batch.sessionId || ''),
              episodeId,
              messageIds: (batch.messageIds || []).slice(-3),
              at,
            };
            /** 用户原句优先取本次改动带的摘录，其次取整批的：四处回执都能看到原话。 */
            const excerpt = typeof change.sourceExcerpt === 'string'
              ? change.sourceExcerpt
              : (typeof batch.sourceExcerpt === 'string' ? batch.sourceExcerpt : '');
            if (excerpt) evidence.sourceExcerpt = excerpt;
            merged.learning = {
              ...learning.nextLearningState({
                existing: flat,
                change,
                evidence: { ...evidence, explicitLongTerm: Boolean(batch.explicitLongTerm) },
                specChanged: merged.specChanged === true,
                now,
              }),
              specDigest: merged.digest,
              versions: merged.learning.versions,
            };
            entry.current = {
              ...entry.current,
              title: merged.current.title,
              summary: merged.current.summary,
              body: merged.current.body,
              when: merged.current.when,
              applicability: merged.current.applicability,
              conditions: merged.current.conditions,
              topicKey: merged.current.topicKey,
            };
            entry.revision = Number(entry.revision) + 1;
            entry.updatedAt = at;
            entry.maintenance = { ...(entry.maintenance || {}), learning: merged.learning };
          } else {
            const evidence = {
              sourceType: 'human_feedback',
              feedbackType: change.feedbackType,
              sessionId: String(batch.sessionId || ''),
              episodeId,
              messageIds: (batch.messageIds || []).slice(-3),
              at,
            };
            /** 用户原句优先取本次改动带的摘录，其次取整批的：四处回执都能看到原话。 */
            const excerpt = typeof change.sourceExcerpt === 'string'
              ? change.sourceExcerpt
              : (typeof batch.sourceExcerpt === 'string' ? batch.sourceExcerpt : '');
            if (excerpt) evidence.sourceExcerpt = excerpt;
            const merged = learning.mergeChange(null, change, { now });
            /** 同主题、同条件的新规则并进已有条目：整理器换个措辞不该长出第二条。 */
            const signature = (list) => (Array.isArray(list) ? list : [])
              .map((row) => `${row.key}=${row.value}`).sort().join('\u0000');
            const duplicate = merged.current.topicKey
              ? currentRules.find((row) => {
                const flat = toFlat(row);
                return flat.topicKey === merged.current.topicKey
                  && signature(flat.conditions) === signature(merged.current.conditions)
                  && flat.applicability === merged.current.applicability;
              })
              : null;
            if (duplicate) {
              assertPreparedTarget(duplicate);
              const flat = toFlat(duplicate);
              const rem = learning.mergeChange(flat, change, { now });
              rem.learning = {
                ...learning.nextLearningState({
                  existing: flat,
                  change,
                  evidence: { ...evidence, explicitLongTerm: Boolean(batch.explicitLongTerm) },
                  specChanged: rem.specChanged === true,
                  now,
                }),
                specDigest: rem.digest,
                versions: rem.learning.versions,
              };
              duplicate.current = {
                ...duplicate.current,
                title: rem.current.title,
                summary: rem.current.summary,
                body: rem.current.body,
                when: rem.current.when,
                applicability: rem.current.applicability,
                conditions: rem.current.conditions,
                topicKey: rem.current.topicKey,
              };
              duplicate.revision = Number(duplicate.revision) + 1;
              duplicate.updatedAt = at;
              duplicate.maintenance = { ...(duplicate.maintenance || {}), learning: rem.learning };
              touched += 1;
              continue;
            }
            if (currentRules.length + 1 > learning.LIMITS.rules) throw new Error('项目实验规则已经到上限');
            const pending = currentRules.filter((entry) => toFlat(entry).learning?.state === 'pending').length;
            if (pending >= learning.LIMITS.pending) throw new Error('待确认候选已经到上限');
            merged.learning = {
              ...learning.nextLearningState({
                existing: { learning: merged.learning },
                change,
                evidence: { ...evidence, explicitLongTerm: Boolean(batch.explicitLongTerm) },
                specChanged: merged.specChanged === true,
                now,
              }),
              specDigest: merged.digest,
              versions: merged.learning.versions,
            };
            const id = `mem_${crypto.createHash('sha256').update(`${operationId}:${touched}:${merged.current.topicKey}:${at}`).digest('hex').slice(0, 12)}`;
            const flat = {
              id,
              title: merged.current.title,
              summary: merged.current.summary,
              body: merged.current.body,
              kind: 'convention',
              tags: [],
              topicKey: merged.current.topicKey,
              triggers: [],
              applicability: merged.current.applicability,
              conditions: merged.current.conditions,
              selection: null,
              links: [],
              origin: EXPERIMENTAL_ORIGIN,
              ownerProjectId: scope.key,
              reviewState: 'active',
              created: at,
              updated: at,
              lastUsed: at,
              revision: 1,
              status: 'active',
              hits: 0,
              merges: 0,
              versions: [],
              sourceRefs: [evidence],
              checks: [],
              learning: merged.learning,
            };
            const created = fromFlat(flat);
            draft.entries.push(created);
            currentRules.push(created);
            touched += 1;
            continue;
          }
          touched += 1;
        }
        receipt = learning.receiptOf({
          operationId,
          episodeId,
          status: touched > 0 ? 'applied' : 'no_change',
          changes: touched,
          usage: batch.usage,
          at,
        });
        addLearningReceipt(evolution, receipt);
        return {
          changed: true,
          kind: 'learning',
          receipt: { learning: receipt },
          result: { receipt, touched },
        };
      });
      if (result.replayed === true) {
        const prior = result.receipt && result.receipt.learning ? result.receipt.learning : null;
        return { ok: true, replayed: true, receipt: prior, touched: prior ? prior.changes : null };
      }
      const out = result.result || { receipt, touched: changes.length };
      return { ok: true, ...out, replayed: false };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '整理结果没有写入' };
    }
  });
}

/** 用一次未通过校验或失败的调用留回执：不写正文，但保留真实用量。 */
export function recordLearningFailure(scope, options = {}) {
  const now = options.now || Date.now();
  const at = new Date(now).toISOString();
  const receipt = learning.receiptOf({
    operationId: options.operationId,
    episodeId: options.episodeId,
    status: 'failed',
    changes: 0,
    reason: options.reason,
    usage: options.usage,
    at,
  });
  return withLock(scope, () => {
    try {
      const result = state.transact(scope, {
        operationId: options.operationId || '',
      }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (!evolution || evolution.enabled !== true) return { changed: false };
        if (options.epoch && evolution.epoch !== options.epoch) throw new Error('实验已经重新开启过，这次回执作废');
        addLearningReceipt(evolution, receipt);
        return { changed: true, kind: 'learning_failed' };
      });
      return { ok: true, receipt, replayed: result.replayed === true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '回执没有写入' };
    }
  });
}

/** 管理面写操作的统一闸门：总开关关掉时服务端直接拒绝，不写盘也不返回旧正文。 */
function managementClosed(scope) {
  const index = loadIndex(scope);
  return !(index.__control || state.controlOf(null)).enabled;
}

/** 删除：仍按管理面看到的版本比对，删掉正文与旧版本，只留审计回执。 */
export function removeLearningRule(scope, id, options = {}) {
  const expectedRevision = Number(options.expectedRevision);
  const operationId = String(options.operationId || '');
  const at = new Date(options.now || Date.now()).toISOString();
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (!evolution) throw new Error('没有实验记录');
        if (options.epoch && evolution.epoch !== options.epoch) throw new Error('实验已经重新开启过，先刷新');
        const entry = draft.entries.find((row) => row.id === id && row.status === 'active');
        if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('没有这条实验规则');
        if (!Number.isInteger(expectedRevision) || Number(entry.revision) !== expectedRevision) throw new Error('这条规则刚被改过，先刷新再删除');
        const flat = toFlat(entry);
        entry.status = 'archived';
        entry.updatedAt = at;
        entry.current = { ...entry.current, body: '', summary: '' };
        const deletedLearning = {
          ...(flat.learning || {}),
          state: 'paused',
          blockedReason: 'deleted',
          pausedBy: 'management',
          pausedAt: at,
          versions: [],
          specDigest: '',
        };
        /** 删掉的规范正文不能再从 lastText 里漏出来。 */
        delete deletedLearning.lastText;
        delete deletedLearning.trialUntil;
        entry.maintenance = { ...(entry.maintenance || {}), learning: deletedLearning };
        addLearningReceipt(evolution, learning.receiptOf({ operationId, episodeId: flat.learning?.evidence?.[0]?.episodeId || '', status: 'deleted', changes: 1, at }));
        return { changed: true, kind: 'learning_delete' };
      });
      return { ok: true, replayed: result.replayed === true };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '没有删除' };
    }
  });
}

/** 撤回：目标版本对不上就拒绝，不能把更新的版本退回旧正文。 */
export function undoLearningChange(scope, id, options = {}) {
  const expectedRevision = Number(options.expectedRevision);
  const operationId = String(options.operationId || '');
  const now = options.now || Date.now();
  const at = new Date(now).toISOString();
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (!evolution) throw new Error('没有实验记录');
        if (options.epoch && evolution.epoch !== options.epoch) throw new Error('实验已经重新开启过，先刷新');
        const entry = draft.entries.find((row) => row.id === id && row.status === 'active');
        if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('没有这条实验规则');
        if (!Number.isInteger(expectedRevision) || Number(entry.revision) !== expectedRevision) throw new Error('这条规则刚被改过，先刷新再撤回');
        const flat = toFlat(entry);
        const versions = Array.isArray(flat.learning?.versions) ? flat.learning.versions : [];
        const previous = versions[versions.length - 1];
        if (!previous) throw new Error('没有可撤回的上一版');
        entry.current = { ...entry.current, body: previous.body || entry.current.body };
        entry.revision = Number(entry.revision) + 1;
        entry.updatedAt = at;
        entry.maintenance = {
          ...(entry.maintenance || {}),
          learning: {
            ...(flat.learning || {}),
            state: 'paused',
            blockedReason: 'undone',
            pausedBy: 'management',
            pausedAt: at,
            versions: versions.slice(0, -1),
            specDigest: learning.specDigestOf({ ...flat, body: previous.body || flat.body }),
          },
        };
        addLearningReceipt(evolution, learning.receiptOf({ operationId, episodeId: flat.learning?.evidence?.[0]?.episodeId || '', status: 'undone', changes: 1, at }));
        return { changed: true, kind: 'learning_undo' };
      });
      return { ok: true, replayed: result.replayed === true };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '没有撤回' };
    }
  });
}

/** 固定/取消固定只改管理状态；取消固定不会自动恢复生效。 */
export function pinLearningRule(scope, id, options = {}) {
  const pinned = options.pinned === true;
  const expectedRevision = Number(options.expectedRevision);
  const operationId = String(options.operationId || '');
  const at = new Date(options.now || Date.now()).toISOString();
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (options.epoch && evolution && evolution.epoch !== options.epoch) throw new Error('实验已经重新开启过，先刷新');
        const entry = draft.entries.find((row) => row.id === id && row.status === 'active');
        if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('没有这条实验规则');
        if (Number(entry.revision) !== expectedRevision) throw new Error('这条规则刚被改过，先刷新');
        const learningState = toFlat(entry).learning || {};
        entry.maintenance = {
          ...(entry.maintenance || {}),
          learning: { ...learningState, pinned, updatedAt: at },
        };
        entry.revision = Number(entry.revision) + 1;
        entry.updatedAt = at;
        return { changed: true, kind: 'learning_pin' };
      });
      return { ok: true, replayed: result.replayed === true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '没有改动' };
    }
  });
}

/**
 * 管理面编辑：只保存内容，不改变学习状态；正文变了就清掉旧证据并留上一版。
 * 已生效规则改写后降回试用，避免拿新正文沿用旧证据直接当默认。
 */
export function editLearningRule(scope, id, options = {}) {
  const expectedRevision = Number(options.expectedRevision);
  const operationId = String(options.operationId || '');
  const now = options.now || Date.now();
  const at = new Date(now).toISOString();
  const title = typeof options.title === 'string' ? options.title.trim() : '';
  const body = typeof options.body === 'string' ? options.body.trim() : '';
  if (!title && !body) throw new Error('没有要保存的内容');
  if (title && title.length > LIMITS.titleChars) throw new Error(`标题超过 ${LIMITS.titleChars} 字`);
  if (body && Buffer.byteLength(body) > LIMITS.entryBytes) throw new Error(`正文超过单条 ${LIMITS.entryBytes} 字节`);
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId }, (draft) => {
        const entry = draft.entries.find((row) => row.id === id && row.status === 'active');
        if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('没有这条实验规则');
        if (!Number.isInteger(expectedRevision) || Number(entry.revision) !== expectedRevision) throw new Error('这条规则刚被改过，先刷新再保存');
        const flat = toFlat(entry);
        const nextTitle = title || flat.title;
        const nextBody = body || flat.body;
        if (nextTitle === flat.title && nextBody === flat.body) return { changed: false };
        const nextCurrent = { ...entry.current, title: nextTitle, body: nextBody };
        const bodyChanged = nextBody !== flat.body;
        const learningState = { ...(flat.learning || {}) };
        if (!learningState.specDigest) learningState.specDigest = learning.specDigestOf(flat);
        if (bodyChanged) {
          learningState.versions = [...(Array.isArray(learningState.versions) ? learningState.versions : []),
            { digest: learningState.specDigest, body: flat.body, at }].slice(-learning.LIMITS.versions);
          learningState.supportedEpisodeIds = [];
          learningState.evidence = [];
        }
        learningState.specDigest = learning.specDigestOf(nextCurrent);
        learningState.updatedAt = at;
        if (bodyChanged && learningState.state === 'active') {
          learningState.state = 'trial';
          learningState.trialUntil = new Date(now + learning.LIMITS.trialMs).toISOString();
        }
        if (learningState.state === 'paused') {
          learningState.blockedReason = 'edited';
          learningState.pausedAt = at;
          learningState.pausedBy = 'management';
        }
        entry.current = nextCurrent;
        entry.maintenance = { ...(entry.maintenance || {}), learning: learningState };
        entry.revision = Number(entry.revision) + 1;
        entry.updatedAt = at;
        return { changed: true, kind: 'learning_edit' };
      });
      return { ok: true, changed: result.changed === true, replayed: result.replayed === true };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '没有保存' };
    }
  });
}

/** 采纳：候选/试用转为生效，默认在适用任务中参与召回；可选同时保存改过的标题或正文。 */
export function adoptLearningRule(scope, id, options = {}) {
  const expectedRevision = Number(options.expectedRevision);
  const operationId = String(options.operationId || '');
  const now = options.now || Date.now();
  const at = new Date(now).toISOString();
  const title = typeof options.title === 'string' ? options.title.trim() : '';
  const body = typeof options.body === 'string' ? options.body.trim() : '';
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('缺少版本，先刷新');
  if (title && title.length > LIMITS.titleChars) throw new Error(`标题超过 ${LIMITS.titleChars} 字`);
  if (body && Buffer.byteLength(body) > LIMITS.entryBytes) throw new Error(`正文超过单条 ${LIMITS.entryBytes} 字节`);
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId }, (draft) => {
        const entry = draft.entries.find((row) => row.id === id && row.status === 'active');
        if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('没有这条实验规则');
        if (Number(entry.revision) !== expectedRevision) throw new Error('这条规则刚被改过，先刷新再采纳');
        const flat = toFlat(entry);
        const learningState = { ...(flat.learning || {}) };
        if (learningState.state === 'active' && !title && !body) return { changed: false };
        const nextTitle = title || flat.title;
        const nextBody = body || flat.body;
        const nextCurrent = { ...entry.current, title: nextTitle, body: nextBody };
        if (!learningState.specDigest) learningState.specDigest = learning.specDigestOf(flat);
        if (nextBody !== flat.body || nextTitle !== flat.title) {
          learningState.versions = [...(Array.isArray(learningState.versions) ? learningState.versions : []),
            { digest: learningState.specDigest, body: flat.body, at }].slice(-learning.LIMITS.versions);
          learningState.specDigest = learning.specDigestOf(nextCurrent);
          learningState.supportedEpisodeIds = [];
          learningState.evidence = [];
        }
        learningState.state = 'active';
        delete learningState.trialUntil;
        delete learningState.blockedReason;
        delete learningState.pausedAt;
        delete learningState.pausedBy;
        learningState.updatedAt = at;
        entry.current = nextCurrent;
        entry.maintenance = { ...(entry.maintenance || {}), learning: learningState };
        entry.revision = Number(entry.revision) + 1;
        entry.updatedAt = at;
        return { changed: true, kind: 'learning_adopt' };
      });
      return { ok: true, changed: result.changed === true, replayed: result.replayed === true };
    } catch (error) {
      if (error && error.code === 'conflict') return { ok: false, reason: '项目状态刚被改过，重试一次', retry: true };
      return { ok: false, reason: error instanceof Error ? error.message : '没有采纳' };
    }
  });
}

/** 结构化负反馈先在本地暂停命中的试用规则，再决定是否调用整理器。 */
export function pauseLearningRules(scope, ids, options = {}) {
  const targets = Array.isArray(ids) ? ids.filter(Boolean).slice(0, 12) : [];
  if (!targets.length) return { ok: true, changed: 0 };
  const at = new Date(options.now || Date.now()).toISOString();
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId: options.operationId || '' }, (draft) => {
        let changed = 0;
        for (const entry of draft.entries) {
          if (!targets.includes(entry.id) || entry.status !== 'active' || !isExperimentalRecord(toFlat(entry))) continue;
          const flat = toFlat(entry);
          if (flat.learning?.state === 'paused') continue;
          entry.maintenance = {
            ...(entry.maintenance || {}),
            learning: learning.pauseLearning(flat.learning, { by: options.by || 'feedback', reason: options.reason || 'feedback_pending', now: options.now }),
          };
          entry.revision = Number(entry.revision) + 1;
          entry.updatedAt = at;
          changed += 1;
        }
        return changed ? { changed: true, kind: 'learning_pause' } : { changed: false };
      });
      return { ok: true, changed: result.changed === true, replayed: result.replayed === true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '没有暂停' };
    }
  });
}

/** 管理面恢复试用：用户明确复核后从暂停回到试用，不会直接升为已生效。 */
export function resumeLearningRule(scope, id, options = {}) {
  const operationId = String(options.operationId || '');
  const at = new Date(options.now || Date.now()).toISOString();
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId }, (draft) => {
        const entry = draft.entries.find((row) => row.id === id && row.status === 'active');
        if (!entry || !isExperimentalRecord(toFlat(entry))) throw new Error('没有这条实验规则');
        const flat = toFlat(entry);
        if (flat.learning?.state !== 'paused') throw new Error('这条规则没有暂停');
        entry.maintenance = {
          ...(entry.maintenance || {}),
          learning: learning.resumeLearning(flat.learning, { by: 'management', now: options.now }),
        };
        entry.revision = Number(entry.revision) + 1;
        entry.updatedAt = at;
        return { changed: true, kind: 'learning_resume' };
      });
      return { ok: true, replayed: result.replayed === true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '没有恢复' };
    }
  });
}

/** 到期的试用转暂停、过期候选清掉；只在已有管理边界的写事务里调用。 */
export function expireLearning(scope, options = {}) {
  const now = options.now || Date.now();
  const at = new Date(now).toISOString();
  return withLock(scope, () => {
    if (managementClosed(scope)) return { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' };
    try {
      const result = state.transact(scope, { operationId: options.operationId || '' }, (draft) => {
        const evolution = draft.experimental && draft.experimental.projectEvolution;
        if (!evolution || evolution.enabled !== true) return { changed: false };
        const flat = draft.entries.filter((entry) => entry.status === 'active').map(toFlat);
        const plan = learning.lifecycle(flat, now);
        let changed = 0;
        draft.entries = draft.entries.filter((entry) => !(entry.status === 'active' && plan.purge.includes(entry.id)));
        changed += plan.purge.length;
        for (const entry of draft.entries) {
          if (entry.status !== 'active' || !plan.paused.includes(entry.id)) continue;
          const current = toFlat(entry);
          entry.maintenance = {
            ...(entry.maintenance || {}),
            learning: learning.pauseLearning(current.learning, { by: 'ttl', reason: 'trial_expired', now }),
          };
          entry.updatedAt = at;
          changed += 1;
        }
        return changed ? { changed: true, kind: 'learning_expire' } : { changed: false };
      });
      return { ok: true, changed: result.changed === true, replayed: result.replayed === true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '没有清理' };
    }
  });
}
