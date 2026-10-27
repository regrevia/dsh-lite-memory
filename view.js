/**
 * 模型能看到什么、自动召回拿不拿得到：都在这一处定。
 * 投影只挑当前字段：历史版本、来源、回执、候选和维护计数永不进入模型视图。
 * 适用范围只有三档：普遍适用 / 带可核验条件 / 未解决；未解决不自动召回。
 */
import { LIMITS } from './state.js';

export const APPLICABILITY = ['all_in_scope', 'conditional', 'unresolved'];
export const SELECTION_MODES = ['complete', 'examples'];
export const LINK_TYPES = ['related'];
export const CONDITION_KEYS = ['targetOs', 'shell', 'runtime', 'machine', 'projectRoot', 'pathPrefix', 'artifactKey', 'taskKind', 'seriesId', 'phase'];

/** 卡片与单次请求的硬上限：整张卡要么进来，要么省略，不截半句前提。 */
export const CARD = { max: 3, bytes: 1200 };
export const TOOL_BYTES = 6144;
export const REQUEST_BYTES = 8192;
export const REQUEST_LIMITS = { bodies: 3, reads: 8 };

const MAX_CONDITIONS = 8;
const MAX_TRIGGERS = 4;
const MAX_LINKS = 3;
const MAX_SELECTION_ITEMS = 20;
const CONDITION_CHARS = 60;
const PATH_CHARS = 200;
const STOPWORDS = new Set([
  '这个', '那个', '一下', '什么', '怎么', '可以', '需要', '现在', '然后', '还是', '就是',
  '我们', '你们', '他们', '自己', '时候', '东西', '事情', '问题', '地方', '已经', '一个',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'have', 'not', 'but',
]);

function plain(value, max) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fail(message) {
  throw new Error(message);
}

function listOf(value) {
  return Array.isArray(value) ? value : null;
}

/** 条件只认固定键：等值比较，路径只认前缀。认识的键少，但每个都能核验。 */
export function normalizeConditions(input) {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const list = listOf(input);
  if (!list) fail('条件要写成 [{key, value}] 的数组');
  if (list.length > MAX_CONDITIONS) fail(`条件最多 ${MAX_CONDITIONS} 条`);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') fail('条件要写成 [{key, value}]');
    const key = plain(item.key, CONDITION_CHARS);
    if (!CONDITION_KEYS.includes(key)) fail(`不认这个条件键：${key || '空'}`);
    if (seen.has(key)) fail(`条件键重复：${key}`);
    seen.add(key);
    const max = key === 'pathPrefix' ? PATH_CHARS : CONDITION_CHARS;
    const value = plain(item.value, max);
    if (!value) fail(`条件 ${key} 缺少值`);
    out.push({ key, value });
  }
  return out;
}

/** 排除清单只对 complete 有意义：artifactKey 指向具体对象，清单是闭集。 */
export function normalizeSelection(input) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) fail('selection 要写成 {mode, artifactKey?, items?}');
  const mode = plain(input.mode, 20);
  if (!SELECTION_MODES.includes(mode)) fail(`selection.mode 只能是 ${SELECTION_MODES.join(' / ')}`);
  const artifactKey = plain(input.artifactKey, CONDITION_CHARS);
  const items = listOf(input.items) || [];
  if (items.length > MAX_SELECTION_ITEMS) fail(`清单最多 ${MAX_SELECTION_ITEMS} 条`);
  const clean = [];
  for (const item of items) {
    const text = plain(typeof item === 'string' ? item : item && item.value, CONDITION_CHARS);
    if (!text) fail('清单里有空项');
    if (!clean.includes(text)) clean.push(text);
  }
  if (mode === 'complete' && !artifactKey) fail('complete 要给 artifactKey，否则不知道排除的是哪个对象');
  return { mode, artifactKey, items: clean };
}

export function normalizeApplicability(value) {
  if (value === undefined) return undefined;
  const text = plain(value, 20);
  if (!APPLICABILITY.includes(text)) fail(`适用范围只能是 ${APPLICABILITY.join(' / ')}`);
  return text;
}

export function normalizeTriggers(input) {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const list = listOf(input);
  if (!list) fail('触发词要写成字符串数组');
  if (list.length > MAX_TRIGGERS) fail(`触发词最多 ${MAX_TRIGGERS} 个`);
  const out = [];
  for (const item of list) {
    const text = plain(item, CONDITION_CHARS);
    if (!text) fail('触发词里有空项');
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** related 只连当前库里真实存在的条目；自指、重复、第 4 条都拒绝，不自动挤掉旧的。 */
export function normalizeLinks(input, selfId = '') {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const list = listOf(input);
  if (!list) fail('关联要写成 [{type, id}] 的数组');
  if (list.length > MAX_LINKS) fail(`关联最多 ${MAX_LINKS} 条`);
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') fail('关联要写成 {type:"related", id}');
    const type = plain(item.type, 20) || 'related';
    if (!LINK_TYPES.includes(type)) fail(`关联类型只能是 ${LINK_TYPES.join(' / ')}`);
    const id = plain(item.id, 80);
    if (!/^mem_[a-z0-9]{6,}$/.test(id)) fail(`关联目标 id 不合法：${id || '空'}`);
    if (selfId && id === selfId) fail('不能关联自己');
    if (out.some((link) => link.id === id)) fail(`关联重复：${id}`);
    out.push({ type, id });
  }
  return out;
}

/**
 * 没给适用范围时按字段推断：有结构化条件才是 conditional；只有一句 when 的旧写法
 * 归 unresolved，宁可等用户确认，也不拿自然语言当条件。
 */
export function decideApplicability({ applicability, conditions, when } = {}) {
  if (applicability) return applicability;
  if (Array.isArray(conditions) && conditions.length > 0) return 'conditional';
  if (plain(when, LIMITS.whenChars)) return 'unresolved';
  return 'all_in_scope';
}

/** 三档之外再查一致性和来源：写进去之前就把自相矛盾的组合拒掉。 */
export function validateApplicability(applicability, conditions, selection, when) {
  const mode = decideApplicability({ applicability, conditions, when });
  const list = Array.isArray(conditions) ? conditions : [];
  if (mode === 'all_in_scope' && list.length > 0) fail('普遍适用不能带条件；要带条件就把适用范围写成 conditional');
  if (mode === 'conditional' && list.length === 0) fail('条件适用至少要给一个条件');
  if (selection && selection.mode === 'complete' && !selection.artifactKey) fail('complete 要给 artifactKey');
  return mode;
}

/** 已核验的上下文只来自任务配置，不从模型措辞里猜。 */
export function trustedContext(scope, options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : (scope && scope.cwd) || '';
  return {
    targetOs: options.targetOs,
    shell: options.shell,
    runtime: options.runtime,
    machine: options.machine,
    projectRoot: options.projectRoot || cwd,
    pathPrefix: options.pathPrefix === undefined ? cwd : options.pathPrefix,
    artifactKey: options.artifactKey,
    /** 任务键只接受已确认的项目默认或本轮请求绑定；自由措辞不能直接填进来。 */
    ...(options.taskKind ? { taskKind: String(options.taskKind) } : {}),
    ...(options.seriesId ? { seriesId: String(options.seriesId) } : {}),
    ...(options.phase ? { phase: String(options.phase) } : {}),
  };
}

function sameText(left, right) {
  return plain(left, PATH_CHARS).toLowerCase() === plain(right, PATH_CHARS).toLowerCase();
}

function compareOne(condition, context) {
  const value = context[condition.key];
  if (condition.key === 'pathPrefix') {
    if (!value) return 'unknown';
    const prefix = plain(condition.value, PATH_CHARS).replace(/\/+$/, '');
    const target = plain(value, PATH_CHARS);
    return target === prefix || target.startsWith(`${prefix}/`) ? 'match' : 'mismatch';
  }
  if (value === undefined || value === null || value === '') return 'unknown';
  return sameText(condition.value, value) ? 'match' : 'mismatch';
}

/**
 * 条件与 selection 一起裁决：任何一条 mismatch 就不适用；缺上下文算 unknown，
 * 不把「不知道」当「不存在」，也不把「未解决」当「普遍适用」。
 */
export function evaluate(record, context) {
  const applicability = record.applicability || 'all_in_scope';
  if (applicability === 'unresolved') return { state: 'unknown', missing: [], failed: [], reason: 'unresolved' };
  const missing = [];
  const failed = [];
  for (const condition of record.conditions || []) {
    const result = compareOne(condition, context || {});
    if (result === 'unknown') missing.push(condition.key);
    if (result === 'mismatch') failed.push(condition.key);
  }
  const selection = record.selection;
  if (selection && selection.mode === 'complete') {
    const artifactKey = (context || {}).artifactKey;
    if (!artifactKey) missing.push('artifactKey');
    else if (!sameText(selection.artifactKey, artifactKey)) failed.push('artifactKey');
  }
  if (failed.length) return { state: 'mismatch', missing, failed, reason: 'condition_mismatch' };
  if (missing.length) return { state: 'unknown', missing, failed, reason: 'needs_context' };
  return { state: 'match', missing, failed, reason: '' };
}

/** 自动召回只认 match；普通工具读可以带着 unknown 状态看正文，但不会当成已确认适用。 */
export function statusOf(record, context) {
  if (!record || record.status === 'archived') return 'gone';
  const result = evaluate(record, context);
  if (result.state === 'match') return 'ok';
  if (result.state === 'unknown') return 'needs_context';
  return 'not_applicable';
}

/**
 * 所有读入口只走这一处：项目归属、实验开关、学习状态、试用到期、暂停/冲突、复核状态、适用性。
 * auto 只放行完全匹配；search 允许条件未知（只给状态）；read 允许条件未知但要正文由调用方决定。
 */
/** 条件上下文与请求任务合并：普通记忆也按当前任务判适用，不要求实验先开。 */
export function contextWithTask(context = {}, task = {}) {
  const out = { ...(context || {}) };
  if (!task || typeof task !== 'object') return out;
  if (task.kind && !out.taskKind) out.taskKind = task.kind;
  if (task.seriesId && !out.seriesId) out.seriesId = task.seriesId;
  if (task.artifactKey && !out.artifactKey) out.artifactKey = task.artifactKey;
  if (task.phase && !out.phase) out.phase = task.phase;
  return out;
}

export function eligibility(record, runtime = {}, purpose = 'read', now = Date.now()) {
  if (!record) return { ok: false, status: 'gone', reason: 'gone' };
  if (record.status === 'archived') return { ok: false, status: 'gone', reason: 'archived' };
  const pid = runtime && runtime.projectId;
  if (pid && record.ownerProjectId && record.ownerProjectId !== pid) {
    return { ok: false, status: 'not_applicable', reason: 'owner_mismatch' };
  }
  const experimental = record.origin === 'project_evolution';
  if (experimental && runtime && runtime.experimental === false) {
    return { ok: false, status: 'needs_context', reason: 'experimental_disabled' };
  }
  const learning = record.learning && typeof record.learning === 'object' ? record.learning : null;
  if (experimental) {
    if (!experimentalUsable(record, now)) return { ok: false, status: 'needs_context', reason: 'learning_inactive' };
    if (learning && (learning.state === 'paused' || learning.blockedReason)) {
      return { ok: false, status: 'needs_context', reason: 'learning_paused' };
    }
  }
  if (purpose === 'auto' && record.reviewState === 'legacy_unreviewed') {
    return { ok: false, status: 'needs_context', reason: 'legacy_unreviewed' };
  }
  const status = statusOf(record, contextWithTask((runtime && runtime.context) || {}, (runtime && runtime.task) || {}));
  if (status === 'not_applicable') return { ok: false, status, reason: 'condition_mismatch' };
  if (purpose === 'auto' && status !== 'ok') return { ok: false, status, reason: 'needs_context' };
  return { ok: true, status, reason: '' };
}

/** 旧库迁过来的条目没复核过，先让人看见再决定，不自动注入。 */
export function canAutoRecall(record, context) {
  if (!record || record.reviewState === 'legacy_unreviewed') return false;
  return statusOf(record, context) === 'ok';
}

/**
 * 学习规则是否还在有效期内：paused/pending 和被时间淘汰的 trial 都不能当依据。
 * 只对实验来源生效；普通记忆不看这一层。
 */
export function experimentalUsable(record, now = Date.now()) {
  if (!record) return false;
  const learning = record.learning && typeof record.learning === 'object' ? record.learning : null;
  if (!learning && record.origin !== 'project_evolution') return true;
  if (!learning) return false;
  if (learning.state === 'active') return true;
  if (learning.state !== 'trial') return false;
  const until = Date.parse(String(learning.trialUntil || ''));
  return !Number.isFinite(until) || until > Number(now);
}

function gramsOf(text) {
  const plainText = plain(text, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const set = new Set();
  if (!plainText) return set;
  if (plainText.length === 1) {
    set.add(plainText);
    return set;
  }
  for (let i = 0; i + 1 < plainText.length; i += 1) set.add(plainText.slice(i, i + 2));
  return set;
}

function wordsOf(text) {
  const plainText = plain(text, 400).toLowerCase();
  const out = [];
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const part of segmenter.segment(plainText)) {
      const word = part.segment.trim();
      if (!word || !/[\p{L}\p{N}]/u.test(word)) continue;
      if (STOPWORDS.has(word)) continue;
      out.push(word);
    }
  } catch {
    for (const word of plainText.split(/[^\p{L}\p{N}]+/u)) if (word && !STOPWORDS.has(word)) out.push(word);
  }
  return out.slice(0, 24);
}

/** 纯英文查询按整词判断：git 不该命中 digital。自动召回和手动搜索共用这一条。 */
export const asciiWordsOf = (text) => plain(text, 400).toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [];
export const wordIn = (pool, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(pool);

const WEIGHT = { title: 3, keywords: 4, summary: 1.5, when: 1 };

/**
 * 轻量匹配：标题 / 旧标题 / 关键词 / 摘要各算各的分，先过阈值再排序。
 * 排序固定用 id 兜底，同一批数据每次顺序一致。
 */
export function matchScore(record, query) {
  const raw = plain(query, 400);
  if (!raw) return { score: 0, hints: [] };
  if (new RegExp(`\\b${String(record.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(raw)) {
    return { score: 1000, hints: ['id'] };
  }
  const grams = gramsOf(raw);
  const words = wordsOf(raw);
  const hints = [];
  let score = 0;
  const hit = (text, weight) => {
    if (!text) return 0;
    const pool = gramsOf(text);
    let shared = 0;
    for (const gram of grams) if (pool.has(gram)) shared += 1;
    if (shared === 0) return 0;
    return (shared / Math.max(1, Math.min(grams.size, 12))) * weight;
  };
  const titleScore = Math.max(hit(record.title, WEIGHT.title), hit((record.aliases || []).join(' '), 2));
  if (titleScore > 0) {
    score += titleScore;
    hints.push('title');
  }
  /** 标签和触发词都是关键词：触发词在查询里出现，就说明这条规则该被想起。 */
  const keywordTexts = [...(record.tags || []), ...(record.triggers || [])];
  const keywordScore = Math.max(0, ...keywordTexts.map((text) => hit(text, WEIGHT.keywords)));
  if (keywordScore > 0) {
    score += keywordScore;
    hints.push('keyword');
  }
  const loweredRaw = raw.toLowerCase();
  const triggerHit = (record.triggers || []).some((trigger) => {
    const text = plain(trigger, 400).toLowerCase();
    return Boolean(text) && loweredRaw.includes(text);
  });
  if (triggerHit) {
    score += WEIGHT.keywords;
    hints.push('trigger');
  }
  for (const word of words) {
    const plainWord = word.toLowerCase();
    const inTitle = plain(record.title, 400).toLowerCase().includes(plainWord)
      || (record.aliases || []).some((name) => plain(name, 400).toLowerCase().includes(plainWord));
    const inKeywords = keywordTexts.some((text) => plain(text, 400).toLowerCase().includes(plainWord));
    if (inTitle || inKeywords) {
      score += inKeywords ? WEIGHT.keywords : WEIGHT.title;
      hints.push(inKeywords ? 'keyword' : 'title');
    }
  }
  const summaryScore = hit(record.summary, WEIGHT.summary);
  if (summaryScore > 0) {
    score += summaryScore;
    hints.push('summary');
  }
  const whenScore = hit(record.when, WEIGHT.when);
  if (whenScore > 0) score += whenScore;
  /** 纯英文查询必须整词命中，别让语料里的字面巧合把不相关的记忆带进自动提示。 */
  const ascii = asciiWordsOf(raw);
  if (ascii.length && !/[\u4e00-\u9fff]/.test(raw)) {
    const pool = [record.title, (record.aliases || []).join(' '), ...(record.tags || []), ...(record.triggers || []), record.summary, record.when]
      .filter(Boolean).join('\n').toLowerCase();
    if (!ascii.some((word) => wordIn(pool, word))) return { score: 0, hints: [] };
  }
  return { score, hints };
}

export const MATCH_FLOOR = 2.4;

/**
 * 按需召回排序：只有真命中才进候选，不凑数；同分按最近使用、再按 id。
 * requireApplicable 打开时，条件未知或未解决的条目直接不参与自动召回。
 */
export function rank(records, query, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 4;
  const context = options.context || {};
  const rows = [];
  for (const record of records || []) {
    if (!record || record.status === 'archived') continue;
    if (options.requireApplicable && record.reviewState === 'legacy_unreviewed') continue;
    let status;
    if (options.runtime) {
      const gate = eligibility(record, options.runtime, options.requireApplicable ? 'auto' : 'search', options.now || Date.now());
      if (!gate.ok) continue;
      status = gate.status;
    } else {
      status = options.requireApplicable ? statusOf(record, context) : 'ok';
      if (options.requireApplicable && status !== 'ok') continue;
    }
    const matched = matchScore(record, query);
    if (matched.score < MATCH_FLOOR) continue;
    /** 当前任务明确的话题/工作类型优先，但不覆盖查询本身的字面命中。 */
    const task = options.task || {};
    const sameTask = (record.conditions || []).some((condition) => {
      if (condition.key === 'taskKind') return task.kind && sameText(condition.value, task.kind);
      if (condition.key === 'seriesId') return task.seriesId && sameText(condition.value, task.seriesId);
      if (condition.key === 'artifactKey') return task.artifactKey && sameText(condition.value, task.artifactKey);
      return false;
    });
    rows.push({ record, score: matched.score + (sameTask ? 1.5 : 0), hints: matched.hints, status });
  }
  rows.sort((a, b) => b.score - a.score
    || String(b.record.lastUsed || '').localeCompare(String(a.record.lastUsed || ''))
    || String(a.record.id).localeCompare(String(b.record.id)));
  return rows.slice(0, limit);
}

/** 卡片：只放够判断要不要读的那几行，必要前提完整在场，不截断。 */
export function cardOf(record, scope) {
  const conditions = (record.conditions || []).map((condition) => `${condition.key}=${condition.value}`);
  const card = {
    id: record.id,
    scope: scope === 'global' ? 'global' : 'project',
    revision: record.revision || 1,
    title: record.title || '',
    summary: record.summary || '',
  };
  if (conditions.length) card.conditions = conditions;
  if (record.selection && record.selection.mode === 'complete') card.selection = record.selection.artifactKey;
  const related = linksOf(record).length;
  if (related > 0) card.related = related;
  return card;
}

export function linksOf(record) {
  return Array.isArray(record && record.links) ? record.links : [];
}

export function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

/** 整卡装预算：单卡超预算就省略，装不下就停，不为了凑满 3 张截短任何一张。 */
export function selectCards(records, options = {}) {
  const max = Number.isInteger(options.max) ? options.max : CARD.max;
  const bytes = Number.isInteger(options.bytes) ? options.bytes : CARD.bytes;
  const scopeOf = typeof options.scopeOf === 'function' ? options.scopeOf : () => '';
  const cards = [];
  const omitted = [];
  let used = 0;
  for (const record of records) {
    if (cards.length >= max) {
      omitted.push(record.id);
      continue;
    }
    const card = cardOf(record, scopeOf(record));
    const size = bytesOf(card);
    if (used + size > bytes) {
      omitted.push(record.id);
      continue;
    }
    used += size;
    cards.push(card);
  }
  return { cards, omitted, bytes: used };
}

function pick(record, keys) {
  const out = {};
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== '') out[key] = record[key];
  return out;
}

/**
 * 模型投影：按用途挑当前字段，维护区一律不出现。
 * save / read / search / suggest / forget / links 各自一份白名单，新增字段必须显式加。
 */
export function toModelView(record, purpose, extra = {}) {
  if (!record) return null;
  const scope = extra.scope || record.scope || (record.storeScope === 'global' ? 'global' : 'project');
  if (purpose === 'search') {
    const view = pick(record, ['id', 'title', 'summary', 'when', 'revision']);
    view.scope = scope;
    if (record.origin === 'project_evolution') view.origin = 'project_evolution';
    if (extra.status && extra.status !== 'ok') view.state = extra.status;
    return view;
  }
  if (purpose === 'read') {
    const view = pick(record, ['id', 'title', 'summary', 'when', 'kind', 'revision', 'body']);
    view.scope = scope;
    if (record.origin === 'project_evolution') view.origin = 'project_evolution';
    if (Array.isArray(record.conditions) && record.conditions.length) view.conditions = record.conditions;
    if (record.selection && record.selection.mode === 'complete') view.selection = record.selection.artifactKey;
    const related = linksOf(record).length;
    if (related > 0) view.related = related;
    if (extra.status && extra.status !== 'ok') {
      view.state = extra.status;
      if (extra.missing && extra.missing.length) view.missing = extra.missing;
    }
    return view;
  }
  if (purpose === 'save') {
    const view = pick(record, ['id', 'title', 'summary', 'when', 'revision', 'topicKey']);
    view.scope = scope;
    if (record.applicability && record.applicability !== 'all_in_scope') view.applicability = record.applicability;
    return view;
  }
  if (purpose === 'suggest') {
    return pick(record, ['id', 'title', 'summary', 'targetId', 'targetTitle', 'expiresAt']);
  }
  if (purpose === 'forget') {
    const view = pick(record, ['id', 'title']);
    view.scope = scope;
    return view;
  }
  if (purpose === 'links') {
    const view = pick(record, ['id', 'title', 'revision']);
    view.scope = scope;
    view.links = (extra.links || []).map((link) => {
      const row = pick(link, ['id', 'title', 'revision']);
      row.status = link.status || 'ok';
      return row;
    });
    return view;
  }
  if (purpose === 'hint') {
    const card = cardOf(record, scope);
    return card;
  }
  return null;
}

/** 错误出口也只带状态与一句原因：不泄露路径、维护字段或正文。 */
export function errorView(code, message) {
  return {
    error: {
      code: plain(code, 40) || 'failed',
      message: plain(message, 120) || '操作没有完成',
    },
  };
}

/** 宿主合成的「用户消息」不是用户说的话：提示查询只认 source.kind === 'user'。 */
const SYNTHETIC_PREFIXES = [
  'Current runtime context',
  'This is an automatically generated checkpoint',
  'Fast mode reminder',
  '<system-reminder>',
  '<goal_round>',
  'Auto schedule:',
  'Time sampled while preparing',
  'background job ',
];

export function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool-result' || part.type === 'tool-call') return '';
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    text += `${part.text}\n`;
  }
  return text.trim();
}

/** 最后一句真人说的话；goal 轮次、压缩摘要、时间快照、后台任务回执都不算。 */
export function newestUserQuery(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const kind = message?.source?.kind;
    if (kind && kind !== 'user') continue;
    const text = textOfMessage(message);
    if (!text) continue;
    if (SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;
    return text;
  }
  return '';
}

export function projectionText(view) {
  if (!view) return '';
  const rows = [];
  rows.push(`${view.title || '这条记忆'}${view.when ? `（${view.when}）` : ''}`);
  if (view.conditions && view.conditions.length) rows.push(`条件：${view.conditions.map((item) => `${item.key}=${item.value}`).join('，')}`);
  if (view.selection) rows.push(`仅对 ${view.selection} 生效`);
  if (view.state === 'needs_context') rows.push('适用范围待确认');
  if (view.state === 'not_applicable') rows.push('当前条件不适用');
  return rows.join('\n');
}

/** 槽位 = 显式 topicKey；没有就退回条目自身身份，这样每条独立记录仍是自己的槽。 */
export function topicSlot(record) {
  if (!record) return '';
  const key = String(record.topicKey || '').trim();
  return key || String(record.id || '');
}

/** 适用条件归一成可比对字符串：顺序不同不算不同条件。 */
export function conditionsKey(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  return JSON.stringify([...list].map((item) => [String(item.key), String(item.value)]).sort((a, b) => a[0].localeCompare(b[0])));
}

/** 两条规则是否算同一条：正文、selection、关联和目标也不同就是冲突，不能悄悄挑一条。 */
function ruleFingerprint(record) {
  const selection = record.selection || null;
  return JSON.stringify([
    record.title || '',
    record.summary || '',
    record.when || '',
    record.topicKey || '',
    conditionsKey(record.conditions),
    record.applicability || '',
    record.kind || '',
    Array.isArray(record.tags) ? [...record.tags].map(String).sort() : [],
    Array.isArray(record.triggers) ? [...record.triggers].map(String).sort() : [],
    selection ? [selection.mode || '', selection.artifactKey || '', Array.isArray(selection.items) ? [...selection.items].map(String).sort() : []] : null,
    Array.isArray(record.links) ? record.links.map((link) => [String(link.type || 'related'), String(link.id)]).sort((a, b) => a[1].localeCompare(b[1])) : [],
    record.body || '',
  ]);
}

function classify(records, context) {
  const matches = [];
  const unknown = [];
  for (const record of records || []) {
    if (!record || record.status === 'archived') continue;
    const status = statusOf(record, context);
    if (status === 'ok') matches.push(record);
    else if (status === 'needs_context') unknown.push(record);
  }
  if (matches.length > 1) {
    const fingerprints = new Set(matches.map(ruleFingerprint));
    if (fingerprints.size > 1) return { status: 'conflict', records: matches, record: null };
    return { status: 'ok', records: matches, record: matches[0] };
  }
  if (matches.length === 1) return { status: 'ok', records: matches, record: matches[0] };
  if (unknown.length) return { status: 'needs_context', records: unknown, record: null };
  return { status: 'none', records: [], record: null };
}

/**
 * 同一个槽位只留一条现行规范：项目层命中就压过全局层；不命中才回落到全局；
 * 项目层条件未知时整组暂缓，不拿全局顶上，也不猜。
 */
export function resolveTopics(projectRecords, globalRecords, context = {}) {
  const groups = new Map();
  const groupOf = (record) => {
    const key = topicSlot(record);
    if (!groups.has(key)) groups.set(key, { key, project: [], global: [] });
    return groups.get(key);
  };
  for (const record of projectRecords || []) groupOf(record).project.push(record);
  for (const record of globalRecords || []) groupOf(record).global.push(record);
  const out = new Map();
  for (const group of groups.values()) {
    const project = classify(group.project, context);
    const global = classify(group.global, context);
    let resolved;
    if (project.status === 'conflict') resolved = { status: 'conflict', scope: 'project', record: null, records: project.records };
    else if (project.status === 'needs_context') resolved = { status: 'needs_context', scope: 'project', record: null, records: project.records };
    else if (project.status === 'ok') resolved = { status: 'ok', scope: 'project', record: project.record, records: [project.record] };
    else if (global.status === 'conflict') resolved = { status: 'conflict', scope: 'global', record: null, records: global.records };
    else if (global.status === 'needs_context') resolved = { status: 'needs_context', scope: 'global', record: null, records: global.records };
    else if (global.status === 'ok') resolved = { status: 'ok', scope: 'global', record: global.record, records: [global.record] };
    else resolved = { status: 'none', scope: '', record: null, records: [] };
    out.set(group.key, { key: group.key, project: group.project, global: group.global, ...resolved });
  }
  return out;
}
