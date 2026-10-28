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
/** 真正把规则绑到「这一集任务」上的条件；其余条件只描述环境，不构成相关性。 */
export const TASK_CONDITION_KEYS = ['taskKind', 'seriesId', 'phase'];

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
    /** 宿主的真实平台是可信上下文：条件里写 targetOs 的规则本职就是按平台生效。 */
    targetOs: options.targetOs === undefined ? hostTargetOs() : options.targetOs,
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

/** 只报归一化后的平台名；未知平台不硬猜，留给条件判 unknown。 */
export function hostTargetOs() {
  const platform = typeof process !== 'undefined' && process ? process.platform : '';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return '';
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

/** 生命周期先于适用范围：归档、被取代、过期这三类都不该再算现行规则。 */
export function lifecycleStatusOf(record, now = Date.now()) {
  if (!record) return 'gone';
  if (record.status === 'archived') return 'archived';
  if (record.supersededBy) return 'superseded';
  const validUntil = Date.parse(record.validUntil || '');
  if (Number.isFinite(validUntil) && validUntil <= now) return 'expired';
  return '';
}

export function eligibility(record, runtime = {}, purpose = 'read', now = Date.now()) {
  const lifecycle = lifecycleStatusOf(record, now);
  if (lifecycle) return { ok: false, status: 'gone', reason: lifecycle };
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
  /** 本机 ICU 缺中文词典时中文会被切成单字；只在出现单字时才补中文二元组，别让二元组把查询的实词数量撑大。 */
  if (out.some((word) => [...word].length === 1 && /[\u4e00-\u9fff]/.test(word))) {
    for (const run of plainText.split(/[^\u4e00-\u9fff]+/)) {
      for (let i = 0; i + 1 < run.length; i += 1) {
        const gram = run.slice(i, i + 2);
        if (!STOPWORDS.has(gram)) out.push(gram);
      }
    }
  }
  return out.slice(0, 48);
}

/** 只取切词给出的多字实词：本机 ICU 切成单字时返回空，说明这句子没有可靠词边界。 */
function contentWordsOf(text) {
  const plainText = plain(text, 400).toLowerCase();
  const out = [];
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const part of segmenter.segment(plainText)) {
      const word = part.segment.trim();
      if ([...word].length < 2 || !/[\p{L}\p{N}]/u.test(word)) continue;
      if (!STOPWORDS.has(word)) out.push(word);
    }
  } catch {
    for (const word of plainText.split(/[^\p{L}\p{N}]+/u)) {
      if ([...word].length >= 2 && !STOPWORDS.has(word)) out.push(word);
    }
  }
  return out;
}

/** 纯英文查询按整词判断：git 不该命中 digital。自动召回和手动搜索共用这一条。 */
export const asciiWordsOf = (text) => plain(text, 400).toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [];
export const wordIn = (pool, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(pool);

const WEIGHT = { title: 3, keywords: 4, summary: 1.5, when: 1, coverage: 1.6 };

/** 最长公共连续片段：四个字以上连着重合，是「在说同一件事」的强证据。 */
function longestRun(text, raw) {
  /** 只比前 120 个字：够判断「是不是同一句话」，也把每次比对的代价压在常数级。 */
  const left = plain(text, 120).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const right = plain(raw, 120).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!left || !right) return 0;
  let best = 0;
  let prev = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const row = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue;
      row[j] = prev[j - 1] + 1;
      if (row[j] > best) best = row[j];
    }
    prev = row;
  }
  return best;
}

/**
 * 轻量匹配：标题 / 旧标题 / 关键词 / 摘要各算各的分，先过阈值再排序。
 * 排序固定用 id 兜底，同一批数据每次顺序一致。
 */
export function matchScore(record, query, corpus = null) {
  const raw = plain(query, 400);
  if (!raw) return { score: 0, hints: [] };
  if (new RegExp(`\\b${String(record.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(raw)) {
    return { score: 1000, hints: ['id'] };
  }
  const grams = gramsOf(raw);
  /** 本机切词会同时给出整词和补的二元组，去重后同一个词才只算一次。 */
  const words = [...new Set(wordsOf(raw))];
  const hints = [];
  let score = 0;
  /** 英文按整词比对：纯英文二元组只在该词整体出现时才计数，中英混排也一样。 */
  const ascii = asciiWordsOf(raw);
  const englishIn = (text) => ascii.some((word) => wordIn(plain(text, 400).toLowerCase(), word));
  const hit = (text, weight) => {
    if (!text) return 0;
    const pool = gramsOf(text);
    const wholeEnglish = englishIn(text);
    let shared = 0;
    for (const gram of grams) {
      if (/^[a-z0-9]+$/.test(gram) && !wholeEnglish) continue;
      if (pool.has(gram)) shared += 1;
    }
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
  /**
   * 整词命中按字段取一次最大值：一个字/一个词重合只说明沾边，
   * 每个词各加一次会把分数堆到阈值以上（「这」曾让无关记忆被自动召回）。
   */
  /**
   * 语料里到处都有的词（「触发」「文件」「项目」）只算沾边：
   * 一条记忆靠这种通用词挤进提示位，真相关的那条就被挤出去了。
   */
  const common = (text) => {
    if (!corpus || !corpus.df || !corpus.total) return false;
    const df = corpus.df.get(text) || 0;
    return df > Math.max(3, corpus.total * 0.15);
  };
  /**
   * 查询里有两个以上实词时，只沾上一个不算在说同一件事。
   * 「启动服务器」只碰到「启动失败」里的「启动」，不能把改包名的记忆带进自动提示。
   * 单实词查询（「发版」「样式」）不设这个门槛。
   */
  const distinctContent = [...new Set(contentWordsOf(raw).filter((word) => /[\u4e00-\u9fff]/.test(word) && !common(word)))];
  const keywordWords = new Set();
  const titleWords = new Set();
  for (const word of words) {
    if ([...word].length < 2) continue;
    const plainWord = word.toLowerCase();
    if (common(plainWord)) continue;
    if (keywordTexts.some((text) => plain(text, 400).toLowerCase().includes(plainWord))) {
      keywordWords.add(plainWord);
      continue;
    }
    if (plain(record.title, 400).toLowerCase().includes(plainWord)
      || (record.aliases || []).some((name) => plain(name, 400).toLowerCase().includes(plainWord))) {
      titleWords.add(plainWord);
    }
  }
  const wholeText = [record.title, (record.aliases || []).join(' '), (record.tags || []).join(' '),
    (record.triggers || []).join(' '), record.summary, record.when, record.body]
    .map((text) => plain(text, 400).toLowerCase()).filter(Boolean).join('\n');
  const matchedContent = distinctContent.filter((word) => wholeText.includes(word)).length;
  const enoughContent = distinctContent.length < 2 || matchedContent >= 2;
  if (!enoughContent) {
    keywordWords.clear();
    titleWords.clear();
  }
  const titleWordHit = titleWords.size > 0;
  const keywordWordHit = keywordWords.size > 0;
  if (!keywordWordHit && titleWordHit) { score += WEIGHT.title; hints.push('title'); }
  if (keywordWordHit) { score += WEIGHT.keywords; hints.push('keyword'); }
  if (titleWords.size >= 2) { score += WEIGHT.coverage; hints.push('coverage'); }
  /** 四字以上的连续重合直接算强命中：句子换了说法但词还连着，就该被想起。 */
  /** 分已经够的就不必算连续片段；这一步只是补「换了说法但词连着」的情况。 */
  const run = score >= MATCH_FLOOR ? 0 : Math.max(0, ...[record.title, (record.aliases || []).join(' '), record.summary, record.when]
    .filter(Boolean)
    .map((text) => longestRun(text, raw)));
  if (run >= 4) {
    score += WEIGHT.title;
    hints.push('phrase');
  }
  const summaryScore = hit(record.summary, WEIGHT.summary);
  if (summaryScore > 0) {
    score += summaryScore;
    hints.push('summary');
  }
  const whenScore = hit(record.when, WEIGHT.when);
  if (whenScore > 0) score += whenScore;
  /** 纯英文查询必须整词命中，别让语料里的字面巧合把不相关的记忆带进自动提示。 */
  if (ascii.length && !/[\u4e00-\u9fff]/.test(raw)) {
    const pool = [record.title, (record.aliases || []).join(' '), ...(record.tags || []), ...(record.triggers || []), record.summary, record.when]
      .filter(Boolean).join('\n').toLowerCase();
    if (!ascii.some((word) => wordIn(pool, word))) return { score: 0, hints: [] };
  }
  return { score, hints: [...new Set(hints)] };
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
  /** 先数一遍词出现在多少条记忆里：通用词降权，只在这批候选内统计，不额外读盘。 */
  const corpus = { df: new Map(), total: 0 };
  for (const record of records || []) {
    if (!record) continue;
    corpus.total += 1;
    const seen = new Set();
    for (const word of wordsOf([record.title, (record.aliases || []).join(' '), (record.tags || []).join(' '), (record.triggers || []).join(' '), record.summary, record.when].filter(Boolean).join(' '))) {
      seen.add(word.toLowerCase());
    }
    for (const word of seen) corpus.df.set(word, (corpus.df.get(word) || 0) + 1);
  }
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
    const matched = matchScore(record, query, corpus);
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
    if (record.origin === 'project_evolution' || record.origin === 'model_drafted') view.origin = record.origin;
    if (extra.status && extra.status !== 'ok') view.state = extra.status;
    return view;
  }
  if (purpose === 'read') {
    const view = pick(record, ['id', 'title', 'summary', 'when', 'kind', 'revision', 'body']);
    view.scope = scope;
    if (record.origin === 'project_evolution' || record.origin === 'model_drafted') view.origin = record.origin;
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
/** 续说一句（「继续」「然后呢」）本身没有检索线索：沿用上一轮原话，别让自动提醒在这一轮断掉。 */
export function isContinuationQuery(text) {
  const raw = plain(text, 40).trim().toLowerCase().replace(/[\s\u3002\uff01\uff1f?!\uff0c,\u3001\u2026~\uff5e]+/gu, '');
  if (!raw || [...raw].length > 8) return false;
  return /^(继续|接着|然后|然后呢|还有|还有呢|往下|说下去|goon|continue|next|more)$/.test(raw);
}

/**
 * 「继续优化收敛」这类短续句：句首是续说标记，剩下的只由通用动作词组成，
 * 没有点名新的对象。它本身检索不出上一轮的记忆，但仍属于当前任务，要沿用上一句原话。
 * 明确带对象（「继续优化数据库连接池」「继续优化轻量化记忆」）不算，交给换任务判断。
 */
const ELLIPTICAL_BODY = /^(?:把|将|再|接着|继续)?(?:优化|收敛|调整|完善|打磨|推进|处理|改|修|做|写|整理|检查|排查|测试|发布|跑|看看|看下|弄|试|收尾|统一|对齐|细化|补|过一遍|走一遍|一下|下)+[。.!！?？…]*$/u;
export function isEllipticalContinuation(text) {
  const raw = plain(text, 40).trim();
  const cut = raw.replace(/^[\s\u3002\uff01\uff1f?!\uff0c,\u3001\u2026~\uff5e]+/u, '');
  if (!cut || [...cut].length > 12) return false;
  const match = cut.match(/^(?:继续|接着|再接着|往下)[，,、\s]*(.+)$/u);
  if (!match) return false;
  return ELLIPTICAL_BODY.test(match[1].trim());
}

/** 这句话有没有具体动作：只用于判断要不要把上一轮的工具线索并进这次查询。 */
const CONCRETE_ACTION = /(改|写|修|做|建|删|新增|添加|移除|运行|跑|测试|发布|部署|提交|推送|安装|重载|重启|启动|停止|检查|排查|优化|收敛|处理|调整|配置|设置|替换|更换|上传|下载|生成|保存|读取|打开|关闭|合并|拆分|回滚|迁移|接入|修复|定位|复现)/u;
export function hasConcreteAction(text) {
  return CONCRETE_ACTION.test(plain(text, 400));
}

/**
 * 明确换任务：句子里有换做/改用/先别管这类词，或点了一个上一句没有的英文对象。
 * 认不出任务类型时，上一轮的动作线索只能靠这条规则隔开，不能因为类型为空就默认同任务。
 */
const SWITCH_MARK = /(换成|换个|换一个|改用|改做|改为|改到|转到|先不管|别管|先别|不弄这个|不看这个|另一个|新任务|换任务|先结束|结束刚才|结束上一个|去做|开始做)/u;
export function isExplicitSwitch(text, previousText = '') {
  const current = plain(text, 400);
  if (!current) return false;
  if (SWITCH_MARK.test(current)) return true;
  const previous = plain(previousText, 400).toLowerCase();
  const objects = current.match(/[A-Za-z][A-Za-z0-9_.-]{1,}|[0-9]{2,}/g) || [];
  return objects.some((token) => !previous.includes(token.toLowerCase()));
}

/**
 * 补查只有在「还是同一个任务」时才成立：任务类型或 episode 变了，上一轮的动作历史属于旧任务，
 * 不能拿它给新任务找记忆。类型缺失时保留补查，由调用方的明确换任务判断兜底。
 */
export function sameRecallTask(previous, current, options = {}) {
  if (!previous || !current) return false;
  const continuation = options.continuation === true;
  const kind = (value) => plain(value && value.kind, 40).trim().toLowerCase();
  const episode = (value) => plain(value && value.episodeId, 120).trim();
  const previousKind = kind(previous);
  const currentKind = kind(current);
  /** 两侧都认出了任务类型且不同：明确换任务，上一轮的动作历史不再属于当前请求。 */
  if (previousKind && currentKind && previousKind !== currentKind) return false;
  const previousEpisode = episode(previous);
  const currentEpisode = episode(current);
  if (previousEpisode && currentEpisode) {
    if (previousEpisode === currentEpisode) return true;
    /** 同一句追问又出现在下一轮：episode 只是平台切的新轮次，任务没有变。 */
    if (options.sameQuery === true && !previousKind && !currentKind) return true;
    /** 真正的续说可能新开 episode：只有明确续说才允许跨 episode 沿用上一任务。 */
    return continuation && (!previousKind || !currentKind || previousKind === currentKind);
  }
  /**
   * 认不出新任务类型时不能默认沿用旧任务：上一轮的动作线索只属于旧任务。
   * 只有明确续说、或真人原话与上一轮完全相同（同一条追问的下一步）才接着用。
   */
  if (!previousKind && !currentKind && options.sameQuery === true) return true;
  return continuation;
}

/**
 * 动作侧检索词：用户这句话没提，但「刚才在动什么」往往就写在上一轮助手的话和工具名里。
 * 预防型记忆（先重载再重启、改插件后别用 Cmd+R）约束的是下一步动作，
 * 只拿用户原话查，词面永远在错的一侧。这里只取少量最近的实词和工具名，避免长文稀释命中。
 */
const ACTION_NOISE = new Set(['const', 'function', 'return', 'import', 'export', 'from', 'async', 'await', 'true', 'false', 'null', 'undefined', 'string', 'number', 'object']);
const MEMORY_TOOL = /^memory(?:[_-]|$)/i;
const MEMORY_TEXT = /^(?:memory ·|已有记忆可能相关|这条记忆|有些实验规则)/u;
/** 记忆工具的调用与记忆自身的呈现文本不能充当新召回线索：否则记忆会自己触发自己。 */
function isMemoryNoise(name, text) {
  if (name && MEMORY_TOOL.test(String(name))) return true;
  return Boolean(text && MEMORY_TEXT.test(String(text).trimStart()));
}
/** 纯读取不会改变下一步动作：读 README / 搜索 / 记忆工具都不消耗唯一补查。 */
const PASSIVE_TOOL = /^(?:read|glob|grep|list|view|fetch|web_search|web_fetch|job_output|job_list|todo_write|question|ask|memory(?:[_-].*)?)$/i;
const EFFECTIVE_COMMAND = /(?:^|[\s;&|])(?:npm|npx|pnpm|yarn|git|gh|docker|kubectl|helm|systemctl|launchctl|make|cargo|go|python|node|curl|ssh|rsync|deploy|publish|install|test|build|migrate|reload)(?:[\s;&|]|$)/i;
/** 动作侧是否真的发生了一个会改变状态的动作；只有这种动作才允许补查一次。 */
export function hasEffectiveAction(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type !== 'tool-call' && part.type !== 'tool_call') continue;
      const name = String(part.name || '');
      if (isMemoryNoise(name, '')) continue;
      if (!PASSIVE_TOOL.test(name)) return true;
      const input = part.input || part.arguments || part.args;
      if (!input || typeof input !== 'object') continue;
      for (const value of Object.values(input)) {
        if (typeof value === 'string' && EFFECTIVE_COMMAND.test(value)) return true;
      }
    }
  }
  return false;
}

export function actionTerms(messages, options = {}) {
  if (!Array.isArray(messages)) return '';
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 16;
  const terms = [];
  const seen = new Set();
  const push = (word) => {
    const text = String(word || '').trim().toLowerCase();
    if ([...text].length < 2 || ACTION_NOISE.has(text) || seen.has(text)) return;
    seen.add(text);
    terms.push(text);
  };
  const scan = (message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool-call' || part.type === 'tool_call') {
        if (isMemoryNoise(part.name, '')) continue;
        if (typeof part.name === 'string') push(part.name);
        const input = part.input || part.arguments || part.args;
        if (input && typeof input === 'object') {
          for (const [key, value] of Object.entries(input)) {
            if (typeof value !== 'string' || value.length > 300) continue;
            /** 命令参数要按空格切词，否则 `npm whoami` 只剩工具名 bash，动作线索就丢了。 */
            const commandish = /^(?:command|cmd|script|args?|input|shell)$/i.test(key)
              || EFFECTIVE_COMMAND.test(value);
            if (commandish || /[./_-]/.test(value)) {
              for (const piece of value.split(/[^\p{L}\p{N}_.-]+/u)) push(piece);
            }
          }
        }
        continue;
      }
      if (part.type === 'text' && typeof part.text === 'string' && !isMemoryNoise('', part.text)) text += `${part.text}\n`;
    }
    return text;
  };
  let assistants = 0;
  let previousHuman = false;
  for (let i = messages.length - 1; i >= 0 && terms.length < limit; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'assistant') {
      const text = scan(message);
      if (!text) continue;
      assistants += 1;
      for (const word of contentWordsOf(text)) push(word);
      for (const word of asciiWordsOf(text)) push(word);
      if (assistants >= 2) break;
    } else if (message.role === 'user' && !previousHuman && message?.source?.kind !== 'goal') {
      const text = scan(message);
      if (!text) continue;
      previousHuman = true;
      for (const word of contentWordsOf(text)) push(word);
      for (const word of asciiWordsOf(text)) push(word);
    }
  }
  return terms.slice(0, limit).join(' ');
}

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
