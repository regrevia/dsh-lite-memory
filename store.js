import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as state from './state.js';
import * as view from './view.js';
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
const IMPERATIVE = /^(?:你要|你得|你必须|请|务必|必须|记得|记住|别忘了|do not|don't|please|you (?:must|should|need))/i;

const SUGGESTION_ID = /^sug_[a-z0-9]{6,}$/;

/** 正文缓存：一次读到的正文先放这里，saveIndex 落盘后清掉。 */
const bodyCache = new Map();

function cacheBodies(scope, entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.id, entry.current && entry.current.body);
  bodyCache.set(scope.dir, map);
}

function cachedBody(scope, id) {
  const map = bodyCache.get(scope.dir);
  if (!map || !map.has(id)) return undefined;
  return map.get(id);
}

/** v2 条目 → 旧扁平记录：业务层只认这一种形状。 */
function toFlat(entry) {
  const current = entry.current || {};
  const maintenance = entry.maintenance || {};
  return {
    id: entry.id,
    title: current.title || '',
    summary: current.summary || '',
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
    lastUsed: maintenance.lastUsed || entry.updatedAt || entry.createdAt || '',
    revision: Number(entry.revision) || 1,
    status: entry.status === 'archived' ? 'archived' : 'active',
    origin: entry.origin || 'user_explicit',
    hits: Number(maintenance.hits) || 0,
    merges: Number(maintenance.merges) || 0,
    versions: Array.isArray(maintenance.versions) ? JSON.parse(JSON.stringify(maintenance.versions)) : [],
    bytes: entrySize({ title: current.title, summary: current.summary, when: current.when, tags: current.keywords, triggers: current.triggers, topicKey: current.topicKey, applicability: current.applicability, conditions: current.conditions, selection: current.selection, links: current.links }, current.body || ''),
  };
}

function fromFlat(record, status) {
  const at = record.updated || record.created || new Date().toISOString();
  return {
    id: record.id,
    revision: Number(record.revision) || 1,
    status: status || (record.status === 'archived' ? 'archived' : 'active'),
    origin: record.origin === 'observed' ? 'observed' : 'user_explicit',
    createdAt: record.created || at,
    updatedAt: at,
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
      reviewState: record.reviewState === 'legacy_unreviewed' ? 'legacy_unreviewed' : 'active',
      sourceRefs: [],
      retiredNames: Array.isArray(record.aliases) ? [...record.aliases] : [],
      versions: Array.isArray(record.versions) ? JSON.parse(JSON.stringify(record.versions)) : [],
      checks: [],
      hits: Number(record.hits) || 0,
      merges: Number(record.merges) || 0,
      lastUsed: record.lastUsed || at,
    },
  };
}

/**
 * 读一层：v2 状态是唯一权威。旧 index.json 只在迁移时读，读不到正文的旧条目
 * 由 state.js 拦成报告，这里不猜、不补空正文。
 */
export function loadIndex(scope, options = {}) {
  if (!fs.existsSync(path.join(scope.dir, 'state.json'))) {
    const report = state.migrationReport(scope);
    if (report.required || report.adoptable.length) state.migrateLegacy(scope);
  }
  const loaded = state.load(scope, options);
  const entries = loaded.state.entries.filter((entry) => entry.status === 'active').map(toFlat);
  const archived = loaded.state.entries.filter((entry) => entry.status === 'archived').map(toFlat);
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
  };
  index.__meta = { exists: loaded.exists, generation: loaded.state.generation, epoch: loaded.state.epoch };
  return index;
}

/** 扁平索引 → v2 状态：整层重写，条目、候选、回执一次换完。 */
function applyFlat(draft, index) {
  const next = [];
  for (const record of index.entries) next.push(fromFlat(record));
  for (const record of index.archived || []) next.push(fromFlat(record, 'archived'));
  draft.entries = next;
  draft.candidates = Array.isArray(index.suggestions) ? JSON.parse(JSON.stringify(index.suggestions)) : [];
  draft.receipts = Array.isArray(index.receipts) ? JSON.parse(JSON.stringify(index.receipts)) : [];
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
    const before = JSON.stringify([draft.entries, draft.candidates, draft.receipts, draft.lastSuggestedAt]);
    applyFlat(draft, index);
    const after = JSON.stringify([draft.entries, draft.candidates, draft.receipts, draft.lastSuggestedAt]);
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
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: '摘要为空' };
  if (text.length > LIMITS.summaryChars) return { ok: false, reason: `摘要超过 ${LIMITS.summaryChars} 字，先写短些` };
  if (IMPERATIVE.test(text)) return { ok: false, reason: '摘要必须写成名词短语，不能写成指令' };
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
  const when = has('when') ? textField(draft.when, LIMITS.whenChars, '前置条件') : '';
  const title = textField(cleanTitle(draft.title), LIMITS.titleChars, '标题');
  /** 带 id 是更新：省略的字段保持原值，标题也一样。 */
  const mayOmitTitle = Boolean(id);
  if (!title && !mayOmitTitle) throw new Error('标题为空');
  let summary = '';
  const rawSummary = String(draft.summary ?? '').replace(/\s+/g, ' ').trim();
  if (rawSummary) {
    const check = validSummary(rawSummary);
    if (!check.ok) throw new Error(check.reason);
    summary = check.text;
  } else if (has('summary')) {
    throw new Error('摘要为空');
  }
  /** 更新（带 id）与候选草稿允许省略摘要；省略表示保持原值，不拿标题补。 */
  const mayOmitSummary = options.requireSummary === false || Boolean(id);
  if (!summary && !mayOmitSummary) throw new Error('摘要为空');
  const body = String(draft.body ?? '').trim();
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > LIMITS.entryBytes) {
    throw new Error(`正文 ${bodyBytes} 字节，超过单条 ${LIMITS.entryBytes} 字节；先精简，别让尾部条件被截掉`);
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
  const secret = detectSecret([title, summary, when, body, tags.join(' '), topicKey || ''].join('\n'));
  if (secret) throw new Error(`疑似凭据（${secret}），只记位置，不记值`);
  return {
    id,
    title,
    summary,
    when,
    body,
    kind: kind || 'note',
    tags,
    triggers,
    conditions,
    selection,
    links,
    applicability,
    topicKey,
    has: {
      title: has('title') && Boolean(title),
      summary: has('summary'),
      when: has('when'),
      body: has('body'),
      kind: has('kind'),
      tags: has('tags'),
      triggers: triggers !== undefined,
      conditions: conditions !== undefined,
      selection: selection !== undefined,
      links: links !== undefined,
      applicability: applicability !== undefined,
      topicKey: topicKey !== undefined,
    },
  };
}

function newId() {
  return `mem_${crypto.randomBytes(6).toString('hex')}`;
}

/** 正文就在状态里；缓存只是省一次读盘，得手时一律回状态读。 */
function readBody(scope, id) {
  const cached = cachedBody(scope, id);
  if (typeof cached === 'string') return cached;
  const found = state.readEntryBody(scope, id);
  if (!found) throw new Error(`记忆正文缺失：${id} 在索引里，但正文文件不在了`);
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
    item.summary,
    item.when,
  ].map(fieldText).join('\n');
  let qualified = 0;
  let substantial = 0;
  for (const run of runs) {
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

/**
 * 身份只由「标题 / 用过的旧标题 + 前置条件」决定，相似度不授权覆盖。
 * 精确同名同条件才算同一条；相近只作为候选返回，让调用方决定。
 */
export function resolveTarget(entries, draft, whenArg) {
  const title = typeof draft === 'string' ? normalizeText(draft, LIMITS.titleChars) : draft.title;
  const when = typeof draft === 'string' ? normalizeText(whenArg, LIMITS.whenChars) : draft.when || '';
  const plain = normalizeText(title, LIMITS.titleChars).toLowerCase();
  for (const item of entries) {
    if ((item.when || '') !== when) continue;
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
    if (score >= MERGE.near) rows.push({ id: item.id, title: item.title, summary: item.summary, when: item.when || '', score });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

/** 没有合并时，把最接近的那条报出来：看得到，才有可能纠正。 */
export function nearestEntry(entries, title, summary) {
  return similarEntries(entries, title, summary, 1)[0] || null;
}

/** 旧版本整段保留，字段齐全，恢复时可以连标题与条件一起还原。 */
function snapshot(record, body) {
  if (!body) return record.versions || [];
  const version = {
    at: record.updated || record.created || new Date().toISOString(),
    title: record.title,
    summary: record.summary,
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
      body: draft.body,
    };
    next.applicability = view.validateApplicability(draft.has.applicability ? draft.applicability : undefined,
      next.conditions, next.selection, next.when);
    assertLinksVisible(next.links, index, foreign);
    return next;
  }
  /** 没显式给适用范围就按合并后的字段重算：清掉条件就回到普遍适用，不留悬空 conditional。 */
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
  next.applicability = view.validateApplicability(requested, next.conditions, next.selection, next.when);
  assertLinksVisible(next.links, index, foreign);
  return next;
}

/**
 * 一次写入的纯业务部分：校验、身份、字节预算、版本。不改盘（正文写入由调用方在同一把锁里做）。
 */
function applyDraft(scope, index, source, now, options = {}) {
  const draft = normalizeDraft(source);
  const foreign = options.foreignEntries || [];
  const distinct = source && source.resolution === 'distinct';
  let record = draft.id ? index.entries.find((item) => item.id === draft.id) : null;
  if (draft.id && !record) throw new Error('没有这条记忆，改用新增');
  let mergedFrom = null;
  let similarList = [];
  if (!record) {
    /** distinct 是用户明确说的「这是另一条」：同名也另起一条，不被规范化后的精确同名吞掉。 */
    const hit = distinct ? null : resolveTarget(index.entries, draft);
    if (hit) {
      record = hit.target;
      mergedFrom = hit.target.title === draft.title ? null : hit.target.title;
    } else if (draft.has.topicKey && draft.topicKey && !distinct) {
      /** 同一槽位只留一条现行规范：同层同 topicKey + 同条件必须确认是更新还是另一条。 */
      const slot = index.entries.find((item) => (item.topicKey || '') === draft.topicKey
        && view.conditionsKey(item.conditions) === view.conditionsKey(draft.conditions));
      if (slot) {
        const row = { id: slot.id, title: slot.title, summary: slot.summary || '', revision: slot.revision || 1 };
        return { needsResolution: true, sameTopic: true, similarList: [row], similar: row, draft, record: null, merged: false, previousBody: null, archived: [] };
      }
      similarList = similarEntries(index.entries, draft.title, draft.summary, 2);
    } else {
      similarList = similarEntries(index.entries, draft.title, draft.summary, 2);
      /** 同名不同前置条件是用户明确表达的另一条，不走确认；只有换个说法的相近标题才拦。 */
      const sameName = index.entries.some((item) => [item.title, ...(item.aliases || [])]
        .some((name) => String(name || '').toLowerCase() === draft.title.toLowerCase()));
      if (similarList.length > 0 && !distinct && !sameName) {
        return { needsResolution: true, similarList, similar: similarList[0], draft, record: null, merged: false, previousBody: null, archived: [] };
      }
    }
  }
  const writeMode = source && source.writeMode === 'replace_current' ? 'replace_current' : 'patch';
  if (record && writeMode === 'replace_current') {
    for (const key of ['title', 'summary', 'when', 'body', 'kind', 'tags']) {
      if (!draft.has[key]) throw new Error(`整份替换要给出 ${key}，空值也要显式写`);
    }
  }
  if (record) {
    const oldBody = readBody(scope, record.id);
    const next = mergedFields(draft, record, oldBody, index, writeMode, foreign);
    const noop = next.title === record.title && next.summary === record.summary
      && next.when === (record.when || '') && next.kind === (record.kind || 'note')
      && JSON.stringify(next.tags) === JSON.stringify(record.tags || [])
      && JSON.stringify(next.triggers) === JSON.stringify(record.triggers || [])
      && JSON.stringify(next.conditions) === JSON.stringify(record.conditions || [])
      && JSON.stringify(next.selection) === JSON.stringify(record.selection || null)
      && JSON.stringify(next.links) === JSON.stringify(record.links || [])
      && (next.topicKey || '') === (record.topicKey || '')
      && next.applicability === (record.applicability || 'all_in_scope')
      && next.body === oldBody;
    if (noop) {
      return { record, merged: true, mergedFrom: null, similar: null, similarList, draft, noop: true, previousBody: oldBody, archived: [] };
    }
    const versions = snapshot(record, oldBody);
    const titles = [...new Set([...(record.aliases || []), record.title].map((name) => cleanTitle(name)).filter(Boolean))].slice(-5);
    const nextRecord = {
      ...record,
      ...next,
      aliases: titles,
      versions,
      revision: (record.revision || 1) + 1,
      updated: now,
      lastUsed: now,
      merges: (record.merges || 0) + 1,
      status: 'active',
      source: record.source || (source && source.source) || 'user_explicit',
    };
    nextRecord.bytes = entrySize(nextRecord, next.body);
    const archived = assertFits(scope, index, nextRecord);
    writeBody(scope, record.id, next.body);
    Object.assign(record, nextRecord);
    return { record, merged: true, mergedFrom, similar: null, similarList, draft, noop: false, previousBody: oldBody, archived };
  }
  if (writeMode === 'replace_current') throw new Error('整份替换要先指明是哪条，不能用来新增');
  const rules = rulesOf(draft, draft.body, index, foreign);
  const created = {
    id: newId(),
    title: draft.title,
    summary: draft.summary,
    when: draft.when,
    kind: draft.kind,
    tags: draft.tags,
    triggers: rules.triggers,
    applicability: rules.applicability,
    conditions: rules.conditions,
    selection: rules.selection,
    links: rules.links,
    topicKey: rules.topicKey,
    body: draft.body,
    aliases: [],
    created: now,
    updated: now,
    lastUsed: now,
    revision: 1,
    status: 'active',
    source: source && source.source === 'observed' ? 'observed' : 'user_explicit',
    hits: 0,
    merges: 0,
    versions: [],
    bytes: 0,
  };
  created.bytes = entrySize(created, created.body);
  const archived = assertFits(scope, index, created);
  writeBody(scope, created.id, created.body);
  index.entries.push(created);
  return { record: created, merged: false, mergedFrom: null, similar: similarList[0] || null, similarList, draft, noop: false, previousBody: null, archived };
}

/**
 * 单条与记录序列化两档预算：新增与更新走同一套。
 * 整层条数/正文预算由 state.transact 在发布前裁决（腾最久没读的那条，不拒绝新记忆），
 * 结果经 index.__archived 回填，调用方在工具结果里点名。
 */
function assertFits(scope, index, record) {
  if (record.bytes > LIMITS.entryBytes) {
    throw new Error(`这一条 ${record.bytes} 字节，超过单条 ${LIMITS.entryBytes} 字节；先精简正文`);
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
  ];
  let score = 0;
  for (const [text, weight] of fields) {
    if (!text) continue;
    const pool = bigrams(text);
    let shared = 0;
    for (const gram of grams) if (pool.has(gram)) shared += 1;
    score += shared * weight;
  }
  const plain = normalizeText(raw, 200).toLowerCase().replace(/\s+/g, '');
  if (plain && normalizeText(item.title, 200).toLowerCase().replace(/\s+/g, '').includes(plain)) score += 5;
  return score;
}

/**
 * 按需检索：项目层 + 全局层，最多 limit 条。
 * 空格/标点分开的查询按关键词处理：一段都没过半命中就不进结果，避免只沾了个常用词也挤进来。
 * 返回的记录带着「本次检索之前」的 lastUsed，给 renderIndex 判断陈旧用；
 * 命中计数在返回前写入，所以同一次调用既改盘又不污染展示。
 */
export function search(scope, query, limit = 4, options = {}) {
  return withLocks([scope, globalScope()], () => {
    const grams = bigrams(query);
    if (grams.size === 0) return [];
    const runs = queryRuns(query);
    const keywordMode = runs.length >= 2;
    const rows = [];
    const layers = { project: [], global: [] };
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const layer = source.key === 'global' ? 'global' : 'project';
      layers[layer].push(...index.entries);
      const collect = (pool, archived) => {
        for (const item of pool) {
          const score = scoreQuery(item, grams, query);
          if (score <= 0) continue;
          if (keywordMode && !matchesRun(item, runs)) continue;
          rows.push({ source, index, item, score, archived });
        }
      };
      collect(index.entries, false);
      /** 归档不等于失声：真匹配上就返回，标成已归档，别让用户以为记忆丢了。 */
      collect(index.archived, true);
    }
    /** 被项目层压过的全局条目不再作为检索结果出现；冲突/条件未知的仍保留，便于人工处理。 */
    const resolved = view.resolveTopics(layers.project, layers.global, options.context || {});
    const shadowed = (item) => {
      const group = resolved.get(view.topicSlot(item));
      return Boolean(group && group.status === 'ok' && group.record && group.record.id !== item.id);
    };
    const visible = rows.filter((row) => row.archived || !shadowed(row.item));
    visible.sort((a, b) => b.score - a.score
      || Number(a.archived) - Number(b.archived)
      || String(b.item.lastUsed).localeCompare(String(a.item.lastUsed)));
    const chosen = visible.slice(0, limit);
    /** 检索不改盘：hits/lastUsed 只在用户真的处理过结果时才算数。 */
    return chosen.map((row) => ({
      ...row.item,
      scope: row.source.key === 'global' ? 'global' : 'project',
      status: row.archived ? 'archived' : view.statusOf(row.item, options.context || {}),
      archived: Boolean(row.archived),
    }));
  });
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
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      const archived = record ? null : index.archived.find((item) => item.id === id);
      if (!record && !archived) continue;
      const body = readBody(source, id);
      return {
        ...(record || archived),
        scope: source.key === 'global' ? 'global' : 'project',
        body,
        status: archived ? 'archived' : view.statusOf(record, options.context || {}),
      };
    }
    return null;
  });
}

/**
 * 忘掉一条：archive 或 purge 是两种不同承诺，没点明就不动盘，交给界面问一次。
 * purge 走 state 的屏障事务：锁内落 intent、旋转 epoch、清受管副本，完成才回成功。
 */
export function forget(scope, id, options = {}) {
  const mode = options.mode;
  if (mode !== 'archive' && mode !== 'purge') return { id, mode: 'needs_resolution' };
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (mode === 'archive') {
        if (!record) continue;
        archiveEntry(source, index, record);
        saveIndex(source, index);
        return { id: record.id, title: record.title, mode: 'archive' };
      }
      if (!record) continue;
      const result = state.purge(source, { ids: [id], operationId: options.operationId });
      removeBody(source, id);
      return { id, mode: 'purged', operationId: result.operationId, epoch: result.epoch };
    }
    return null;
  });
}

/** 直接读邻居：只给当前投影，不缓存目标正文；目标不在了就标 invalid，不拿旧版本顶上。 */
export function readLinks(scope, id, options = {}) {
  return withLocks([scope, globalScope()], () => {
    for (const source of [scope, globalScope()]) {
      const index = loadIndex(source);
      const record = index.entries.find((item) => item.id === id);
      if (!record) continue;
      const links = [];
      for (const link of view.linksOf(record)) {
        const target = findCurrent(link.id, scope);
        if (target) links.push({ type: link.type || 'related', ...target });
        else links.push({ type: link.type || 'related', id: link.id, status: 'invalid' });
      }
      return { id, links, scope: source.key === 'global' ? 'global' : 'project', status: view.statusOf(record, options.context || {}) };
    }
    return null;
  });
}

/** 关联目标按当前投影现场解引用：先项目层再全局层，归档和删除都算不存在。 */
function findCurrent(id, scope) {
  for (const source of [scope, globalScope()]) {
    let index;
    try {
      index = loadIndex(source);
    } catch {
      continue;
    }
    const record = index.entries.find((item) => item.id === id && item.status !== 'archived');
    if (!record) continue;
    return {
      id: record.id,
      title: record.title,
      summary: record.summary || '',
      scope: source.key === 'global' ? 'global' : 'project',
      revision: record.revision || 1,
      status: view.statusOf(record, {}),
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
        throw new state.StateError('conflict', `这条记忆已经更新到第 ${record.revision} 版`);
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

/** 按 id 在项目层与全局层里找位置，不靠文案猜作用域。 */
export function locate(scope, id) {
  for (const source of [scope, globalScope()]) {
    const record = loadIndex(source).entries.find((item) => item.id === id);
    if (record) return { scope: source, record };
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
  const rows = (index.suppressions || []).filter((row) => row.fingerprint !== fingerprint || row.reason !== reason);
  rows.push({ fingerprint, sourceIds: [...sourceIds].filter((id) => typeof id === 'string'), reason, at, expiresAt });
  index.suppressions = rows;
}

function suppressed(index, fingerprint) {
  return forgottenFingerprints(index).has(fingerprint);
}

function pruneReceipts(index) {
  const now = Date.now();
  index.receipts = (index.receipts || []).filter((item) => {
    const at = Date.parse(item.at || '');
    return Number.isFinite(at) && now - at < LIMITS.receiptTtlMs;
  }).slice(-LIMITS.receipts);
  return index.receipts;
}

/**
 * 建议门限：已有同一条就不再建议；相近的另一条可以建议，但必须带着 targetId
 * 走候选确认，不能直接改正式条目。
 */
export function suggestionGate(scope, source) {
  return withLock(scope, () => {
    const index = loadIndex(scope);
    pruneSuggestions(index);
    const title = normalizeText(source?.title, LIMITS.titleChars);
    if (!title) return { ok: false, reason: '没有标题' };
    const summary = normalizeText(source?.summary, LIMITS.summaryChars);
    const when = normalizeText(source?.when, LIMITS.whenChars);
    if (suppressed(index, state.fingerprintOf({ title, when }))) {
      return { ok: false, reason: '这个来源你已经明确忘掉了，不再自动建议' };
    }
    const hit = resolveTarget(index.entries, { title, summary, when });
    if (hit) return { ok: false, reason: `已有「${hit.target.title}」，这次不重复建议` };
    const near = similarEntries(index.entries, title, summary, 1)[0];
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
    const target = draft.targetId ? index.entries.find((entry) => entry.id === draft.targetId) : null;
    if (draft.targetId && !target) return { ok: false, reason: '候选要更新的那条记忆已不在了' };
    if (target && draft.targetRevision && (target.revision || 1) !== draft.targetRevision) {
      return { ok: false, reason: '那条记忆在你确认前改过了，重新建议一次' };
    }
    /** 只把建议里真有的字段交给写入：省略表示保持，显式空正文清空；旧候选没有 has 时按有没有值回退。 */
    const source = { title: draft.title };
    const has = draft.has && typeof draft.has === 'object' ? draft.has : null;
    if (has) {
      if (has.summary) source.summary = draft.summary;
      if (has.when) source.when = draft.when;
      if (has.kind) source.kind = draft.kind;
      if (has.tags) source.tags = Array.isArray(draft.tags) ? draft.tags : [];
      if (has.body) source.body = draft.body;
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
    const head = `${item.scope === 'global' ? '[全局] ' : ''}${item.id} ${item.title}${item.when ? `（${item.when}）` : ''} · 第 ${item.revision || 1} 版${stateTag}`;
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
    entry = (loadIndex(scope).entries || []).find((item) => item && item.id === row.id) || null;
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
  return { ...found.row, body: body.slice(0, LIMITS.entryBytes) };
}

/* ------------------------------------------------------------------ *
 * 跨层：范围路由、两层去重、槽位、搬移。这些规则只在服务端判定，*
 * 模型给的是提案（memoryClass / durability / evidenceRef），不是命令。*
 * ------------------------------------------------------------------ */

export const MEMORY_CLASSES = ['personal_preference', 'project_fact', 'environment_fact', 'portable_procedure'];
export const DURABILITIES = ['durable', 'task'];

const ENVIRONMENT_KEYS = ['machine', 'targetOs', 'runtime', 'shell'];

/**
 * 范围路由：用户明确说的范围最高；没有就按记忆类别提案，设备事实必须带设备条件。
 * 判不出来就返回 needsScope，让调用方问一句，而不是默默写进某一层。
 */
export function routeScope(draft, options = {}) {
  const source = draft || {};
  const explicit = source.scope === 'global' || source.scope === 'project' ? source.scope : '';
  const hasProject = Boolean(options.project);
  const cls = typeof source.memoryClass === 'string' ? source.memoryClass : '';
  const durability = typeof source.durability === 'string' ? source.durability : 'durable';
  const base = { chosenScope: '', reasonCode: '', requiredConditions: [], needsScope: false, explicit };
  if (durability === 'task') return { ...base, needsScope: true, reasonCode: 'task_state' };
  if (explicit) {
    if (explicit === 'project' && !hasProject) {
      return { ...base, needsScope: true, reasonCode: 'no_project', requiredConditions: [{ key: 'projectRoot', value: '' }] };
    }
    return { ...base, chosenScope: explicit, reasonCode: 'explicit' };
  }
  if (!cls) return { ...base, chosenScope: 'project', reasonCode: 'unclassified_project' };
  if (!MEMORY_CLASSES.includes(cls)) return { ...base, needsScope: true, reasonCode: 'unknown_class' };
  if (cls === 'project_fact') {
    if (!hasProject) return { ...base, needsScope: true, reasonCode: 'no_project', requiredConditions: [{ key: 'projectRoot', value: '' }] };
    return { ...base, chosenScope: 'project', reasonCode: 'class_project_fact' };
  }
  if (cls === 'personal_preference') return { ...base, chosenScope: 'global', reasonCode: 'class_personal_preference' };
  if (cls === 'portable_procedure') return { ...base, chosenScope: 'global', reasonCode: 'class_portable_procedure' };
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
  return { ...base, chosenScope: 'global', reasonCode: 'class_environment_fact' };
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

const visibleContent = (row) => JSON.stringify([
  row.title || '',
  row.summary || '',
  row.when || '',
  row.kind || 'note',
  view.conditionsKey(row.conditions),
  row.applicability || 'all_in_scope',
  row.topicKey || '',
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
    revision: item.revision || 1,
    scope: other.key === 'global' ? 'global' : 'project',
  }));
}

function bindSameTopic(projectScope, ref) {
  if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') return { error: 'sameTopicAs 要写成 {scope, id, revision}' };
  const source = ref.scope === 'global' ? globalScope() : projectScope;
  const record = loadIndex(source).entries.find((item) => item.id === ref.id);
  if (!record) return { error: `sameTopicAs 指向的记忆不存在：${ref.id}` };
  if (Number(ref.revision) !== Number(record.revision || 1)) {
    return { error: `sameTopicAs 的版本不对：${ref.id} 当前是第 ${record.revision || 1} 版` };
  }
  return { topicKey: view.topicSlot(record) };
}

/**
 * 保存的唯一入口：先路由，再在两层里查重（完全相同 → existing_ref；只是相近 → 只给候选），
 * 最后才写。写之前判不出来的范围返回 needsScope，不替用户选。
 */
export function saveEntry(projectScope, source) {
  return withLocks([projectScope, globalScope()], () => {
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
      targetScope = found.scope;
    } else if (draft && source.resolution !== 'distinct') {
      const duplicate = exactDuplicate(projectScope, targetScope, draft);
      if (duplicate) {
        return { existing: duplicate, needsResolution: false, needsScope: false, similarList: [], draft, changed: false, merged: false, chosenScope: duplicate.scope };
      }
      const near = crossLayerSimilar(projectScope, targetScope, draft);
      if (near.length) {
        return {
          needsResolution: true,
          crossLayer: true,
          similarList: near,
          similar: near[0],
          draft,
          needsScope: false,
          chosenScope: targetScope.key === 'global' ? 'global' : 'project',
        };
      }
    }
    const foreign = targetScope.key === 'global' ? [] : loadIndex(globalScope()).entries;
    const result = upsertLocked(targetScope, next, { foreignEntries: foreign });
    return { ...result, chosenScope: targetScope.key === 'global' ? 'global' : 'project', needsScope: false, reasonCode: routed.reasonCode };
  });
}

/** 两层合并后的现行规范：同槽位只给胜出的那条；冲突或条件未知的不进自动召回。 */
export function visibleRules(projectScope, context = {}) {
  return withLocks([projectScope, globalScope()], () => {
    const project = loadIndex(projectScope).entries;
    const global = loadIndex(globalScope()).entries;
    const resolved = view.resolveTopics(project, global, context);
    const winners = [];
    for (const row of resolved.values()) {
      if (row.status === 'ok' && row.record) winners.push({ record: row.record, scope: row.scope, key: row.key });
    }
    return { winners, resolved };
  });
}

/* --------------------------- 跨层搬移 --------------------------- */

const moveTargetOf = (projectScope, intent) => (intent.target.scopeKey === globalScope().key ? globalScope() : projectScope);
const moveSourceOf = (projectScope, intent) => (intent.source.scopeKey === globalScope().key ? globalScope() : projectScope);

function entryOf(scope, id) {
  return state.load(scope, { allowMove: true, allowPurge: true }).state.entries.find((row) => row.id === id) || null;
}

/** 目标库可能还不存在：不存在时不带 CAS 期望值；刚被别处写入就重读一次再试。 */
function transactWithRetry(scope, base, work) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = state.load(scope, { allowMove: true, allowPurge: true });
    const options = loaded.exists
      ? { ...base, expected: { generation: loaded.state.generation, epoch: loaded.state.epoch } }
      : { ...base };
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
  transactWithRetry(scope, {
    operationId: `${intent.operationId}:in`,
    payloadDigest: `${intent.source.id}->${intent.target.newId}`,
    allowMove: true,
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
  state.sealPrev(scope);
}

function cleanSource(scope, intent) {
  transactWithRetry(scope, {
    operationId: `${intent.operationId}:out`,
    payloadDigest: intent.source.id,
    allowMove: true,
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
  state.sealPrev(scope);
  removeBody(scope, intent.source.id);
}

function driveMove(projectScope, intent, options = {}) {
  const sourceScope = moveSourceOf(projectScope, intent);
  const targetScope = moveTargetOf(projectScope, intent);
  let targetHas = entryOf(targetScope, intent.target.newId);
  if (!targetHas) {
    const record = entryOf(sourceScope, intent.source.id);
    if (!record) throw new state.StateError('recover_failed', `移动中断且源与目标都找不到这条记忆；协调文件保留：${intent.operationId}`);
    commitTarget(targetScope, record, intent);
    if (options.stopAfter === 'target') {
      return { status: 'move_pending', stage: 'target_committed', operationId: intent.operationId, id: intent.target.newId };
    }
  }
  if (entryOf(sourceScope, intent.source.id)) {
    cleanSource(sourceScope, intent);
    if (options.stopAfter === 'source') {
      return { status: 'move_pending', stage: 'source_cleaned', operationId: intent.operationId, id: intent.target.newId };
    }
  }
  if (!entryOf(targetScope, intent.target.newId)) {
    throw new state.StateError('recover_failed', `移动恢复后目标层仍没有这条记忆；协调文件保留：${intent.operationId}`);
  }
  if (entryOf(sourceScope, intent.source.id)) {
    throw new state.StateError('recover_failed', `移动恢复后源层仍留着旧条目；协调文件保留：${intent.operationId}`);
  }
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
 */
export function move(projectScope, id, options = {}) {
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
    const intent = state.writeMoveIntent({
      operationId,
      source: { scopeKey: sourceScope.key, id, revision: record.revision || 1, epoch: sourceIndex.epoch },
      target: { scopeKey: targetScope.key, newId, epoch: targetIndex.epoch },
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
