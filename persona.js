/**
 * 「记住我」纯逻辑：只有闭集枚举与计数，没有自由文本，不读写文件、不联网。
 * 三层信息严格分开：项目记忆说这个项目怎么做，全局记忆说哪些经验跨项目成立，
 * 这里只说「怎样和这个人协作更顺」，且必须慢、少、抽象。
 */

/** 首版固定 8 维闭集；每维都允许 unknown / insufficient / contextual，不猜也不补默认值。 */
export const PREFERENCE_DIMENSIONS = {
  answer_order: ['conclusion_first', 'background_first'],
  explanation_depth: ['brief', 'detailed', 'layered'],
  example_use: ['with_examples', 'without_examples', 'only_on_request'],
  option_presentation: ['single_recommendation', 'multiple_options', 'tradeoff_table'],
  tone: ['plain', 'warm', 'direct', 'playful'],
  progress_updates: ['announce_before_steps', 'report_on_completion', 'silent_until_done'],
  option_count: ['one', 'two_to_three', 'many'],
  comparison_format: ['table', 'bullet_list', 'prose'],
};

export const DIMENSION_NAMES = Object.keys(PREFERENCE_DIMENSIONS);
export const MAX_DIMENSIONS = 12;
export const NEUTRAL_VALUES = ['unknown', 'insufficient', 'contextual'];
export const BASIS_VALUES = ['explicit_feedback', 'repeat_choice', 'manual_edit'];

/** 成熟度硬门槛：任何一项不够就继续「观察中」，不给「大概喜欢」这种半成品。 */
export const MATURITY = Object.freeze({
  minSpanDays: 14,
  minObservations: 8,
  minDistinctDays: 4,
  minContexts: 2,
  minFormationGapHours: 72,
});

import { selectContextBundle } from './view.js';

export const PROJECTION_LIMIT_BYTES = 200;
export const PROJECTION_MAX_DIMENSIONS = 2;

/**
 * 每轮本地筛信号，不调模型：只认对「表达/协作方式」的明确反馈或选择。
 * 说的是项目内容、技术路线、业务目标的一律不算偏好；情绪强度不加票。
 */
const SIGNAL_RULES = [
  { dimension: 'answer_order', value: 'conclusion_first', polarity: 'support', re: /(先给结论|结论先行|先说结果|直接给答案|别铺垫)/u },
  { dimension: 'answer_order', value: 'background_first', polarity: 'support', re: /(先说背景|背景讲清楚再|先铺垫再)/u },
  { dimension: 'explanation_depth', value: 'brief', polarity: 'support', re: /(说得太长了|太长|简短点|简单说|别展开|少说两句)/u },
  { dimension: 'explanation_depth', value: 'detailed', polarity: 'support', re: /(讲细一点|详细说|说透|展开讲|多解释)/u },
  { dimension: 'explanation_depth', value: 'layered', polarity: 'support', re: /(先概览再细节|分层解释|先总后分)/u },
  { dimension: 'example_use', value: 'with_examples', polarity: 'support', re: /(举个例子|给个例子|配例子|举例说明)/u },
  { dimension: 'example_use', value: 'without_examples', polarity: 'support', re: /(不用举例|别举例子|不要示例)/u },
  { dimension: 'option_presentation', value: 'multiple_options', polarity: 'support', re: /(给几个方案|列几个选项|多个方案|三选一|给选项)/u },
  { dimension: 'option_presentation', value: 'single_recommendation', polarity: 'support', re: /(直接推荐一个|别给选项|给我一个就行|你定)/u },
  { dimension: 'option_presentation', value: 'tradeoff_table', polarity: 'support', re: /(列个对比表|用表格对比|对比着说)/u },
  { dimension: 'option_count', value: 'two_to_three', polarity: 'support', re: /(两三个方案|最多三个|别超过三个)/u },
  { dimension: 'option_count', value: 'one', polarity: 'support', re: /(只要一个方案|一个方案就够)/u },
  { dimension: 'tone', value: 'direct', polarity: 'support', re: /(直接说|别绕|说重点|别客气)/u },
  { dimension: 'tone', value: 'warm', polarity: 'support', re: /(语气柔和点|别那么冷|温和一点)/u },
  { dimension: 'tone', value: 'plain', polarity: 'support', re: /(正常说就行|别加修饰|平实一点)/u },
  { dimension: 'progress_updates', value: 'announce_before_steps', polarity: 'support', re: /(先说要做什么|动手前说一声|开始前告诉我)/u },
  { dimension: 'progress_updates', value: 'report_on_completion', polarity: 'support', re: /(做完再说|别边做边说|完成后汇报)/u },
  { dimension: 'progress_updates', value: 'silent_until_done', polarity: 'support', re: /(不用汇报|别中途汇报|安静做完)/u },
  { dimension: 'comparison_format', value: 'table', polarity: 'support', re: /(表格对比|对比表)/u },
  { dimension: 'comparison_format', value: 'bullet_list', polarity: 'support', re: /(分条列|列点说|bullet)/iu },
  { dimension: 'comparison_format', value: 'prose', polarity: 'support', re: /(用一段话说|别列表|别用条目)/u },
];

/** 明确反对：说「别这样 / 不用这样 / 以后别」时立刻停用该维，不需要再攒证据。 */
const OPPOSITION_RULES = [
  { dimension: 'answer_order', re: /(别先给结论|不要结论先行)/u },
  { dimension: 'explanation_depth', re: /(别展开|不要讲太细)/u },
  { dimension: 'example_use', re: /(别举例|不要例子)/u },
  { dimension: 'option_presentation', re: /(别给选项|不要多个方案|别让我选)/u },
  { dimension: 'tone', re: /(别用那种语气|不要这么客气)/u },
  { dimension: 'progress_updates', re: /(别中途汇报|不要边做边说)/u },
  { dimension: 'comparison_format', re: /(别用表格|不要列表)/u },
];

/** 引号里的原文、别人说的话、项目内容里的说法，都不是对这个人的偏好描述。 */
export function stripQuoted(text) {
  return String(text || '')
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|`[^`]*`/gu, ' ')
    .replace(/别人说|他说|她说|文档里写|需求里写/gu, ' ');
}

/**
 * 单轮本地检测：返回 0–1 条候选，不做跨轮推断。
 * 只有对表达方式的明确反馈才算；项目内容、技术路线、一次催促都不进来。
 */
export function detectPreferenceSignal(input) {
  const raw = String((input && input.text) || '');
  /** 引述别人的话、文档里的写法，不是这个人的偏好，整句直接不算。 */
  if (/(别人说|他说|她说|同事说|客户说|文档里写|需求里写)/u.test(raw)) return null;
  const text = stripQuoted(raw).trim();
  if (!text || text.length > 400) return null;
  for (const rule of OPPOSITION_RULES) {
    if (rule.re.test(text)) return { dimension: rule.dimension, value: null, polarity: 'oppose', basis: 'explicit_feedback' };
  }
  for (const rule of SIGNAL_RULES) {
    if (rule.re.test(text)) {
      return { dimension: rule.dimension, value: rule.value, polarity: rule.polarity, basis: 'explicit_feedback' };
    }
  }
  return null;
}

/** 结构化观察校验：维度、取值、极性、依据、证据编号都必须落在闭集里。 */
export function validateObservation(observation, options = {}) {
  const errors = [];
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return { ok: false, errors: ['observation_not_object'] };
  const allowed = new Set(Array.isArray(options.allowedKeys) ? options.allowedKeys : ['dimension', 'value', 'polarity', 'evidenceIds', 'basis']);
  for (const key of Object.keys(observation)) if (!allowed.has(key)) errors.push(`unexpected_field:${key}`);
  const dimension = observation.dimension;
  if (!DIMENSION_NAMES.includes(dimension)) errors.push('unknown_dimension');
  const value = observation.value;
  if (observation.polarity === 'oppose') {
    if (value !== null && value !== undefined) errors.push('oppose_value_must_be_null');
  } else if (observation.polarity === 'support') {
    if (!DIMENSION_NAMES.includes(dimension)) errors.push('support_missing_dimension');
    else if (!PREFERENCE_DIMENSIONS[dimension].includes(value)) errors.push('value_not_in_dimension');
  } else {
    errors.push('unknown_polarity');
  }
  if (!BASIS_VALUES.includes(observation.basis)) errors.push('unknown_basis');
  const ids = observation.evidenceIds;
  if (!Array.isArray(ids) || ids.length === 0) errors.push('missing_evidence');
  else if (ids.some((id) => typeof id !== 'string' || !id.trim())) errors.push('bad_evidence_id');
  return { ok: errors.length === 0, errors };
}

/**
 * 证据去重键：用户 × 会话/任务 × 维度 × 取值/极性。
 * 同一任务里反复催同一句属于同一份反馈，只算一次；跨任务、跨天才是新的一次。
 * 日期与事件编号都不参与去重：前者让同一件事拖几天就刷票，后者换编号就能刷票。
 */
export function evidenceKeyOf(row) {
  const user = String((row && row.userId) || 'local');
  const context = String((row && (row.taskId || row.sessionId)) || 'none');
  const dimension = String((row && row.dimension) || '');
  const shape = [String((row && row.polarity) || 'support'), String((row && row.value) || '')].join('/');
  return [user, context, dimension, shape].join('|');
}

export function deduplicateEvidence(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = evidenceKeyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...row, dedupeKey: key });
  }
  return unique;
}

const emptyCounts = () => ({
  value: null, state: 'observing', source: 'inferred', support: 0, opposition: 0,
  distinctDays: 0, contexts: 0, firstSeenAt: '', lastSupportedAt: '', lockedByUser: false, pausedByUser: false,
});

function dayKey(instant) {
  const text = String(instant || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/**
 * 追加一份已去重证据后的计数。集合类字段有上限，不让长期使用把存储拖成无界增长。
 * 被用户暂停、删除或明确反对过的维度不会被队列、回放或票据复活。
 */
export function updateEvidence(preference, observation, evidence, options = {}) {
  const state = { ...emptyCounts(), ...(preference || {}) };
  const seedDays = Array.isArray(options.days) ? options.days : state.dayKeys;
  const seedContexts = Array.isArray(options.contexts) ? options.contexts : state.contextKeys;
  const days = new Set(Array.isArray(seedDays) ? seedDays : []);
  const contexts = new Set(Array.isArray(seedContexts) ? seedContexts : []);
  const blocked = new Set(Array.isArray(options.blockedDimensions) ? options.blockedDimensions : []);
  const dimension = observation && observation.dimension;
  if (!dimension || blocked.has(dimension)) return { ...state, dayKeys: [...days], contextKeys: [...contexts], skipped: 'blocked' };
  if (state.lockedByUser && options.allowUserEdit !== true) return { ...state, dayKeys: [...days], contextKeys: [...contexts], skipped: 'locked' };
  if (state.pausedByUser && options.allowUserEdit !== true) return { ...state, dayKeys: [...days], contextKeys: [...contexts], skipped: 'paused' };
  const date = dayKey(evidence && (evidence.date || evidence.at));
  if (date) days.add(date);
  const contextId = String((evidence && (evidence.taskId || evidence.projectId || evidence.sessionId)) || 'none');
  contexts.add(contextId);
  if (observation.polarity === 'oppose') {
    state.opposition += 1;
    state.state = 'paused';
    state.pausedByUser = state.pausedByUser || Boolean(evidence && evidence.byUser);
  } else {
    state.support += 1;
    state.value = observation.value || state.value;
    state.lastSupportedAt = String((evidence && (evidence.at || evidence.date)) || state.lastSupportedAt || '');
    if (!state.firstSeenAt) state.firstSeenAt = state.lastSupportedAt;
  }
  state.distinctDays = days.size;
  state.contexts = contexts.size;
  return { ...state, dayKeys: [...days].sort().slice(-64), contextKeys: [...contexts].slice(-16) };
}

/**
 * 保守后验 + 硬门槛：跨度、独立观察数、覆盖日期、情境类数全部达标才算形成。
 * 最近明确反对、被暂停、72h 内已形成/改变过一维，都不形成。
 */
export function decideMaturity(preference, options = {}) {
  const state = { ...emptyCounts(), ...(preference || {}) };
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const first = state.firstSeenAt ? new Date(state.firstSeenAt).getTime() : 0;
  const last = state.lastSupportedAt ? new Date(state.lastSupportedAt).getTime() : 0;
  const spanDays = first && last ? Math.floor((now - first) / 86400000) : 0;
  const progress = {
    support: state.support, opposition: state.opposition, spanDays,
    distinctDays: state.distinctDays || 0, contexts: state.contexts || 0,
  };
  if (state.lockedByUser) return { state: 'formed', progress, reason: 'manual' };
  if (state.pausedByUser) return { state: 'paused', progress, reason: 'user_paused' };
  if (state.opposition > 0) return { state: 'paused', progress, reason: 'recent_opposition' };
  if (options.blocked) return { state: 'observing', progress, reason: 'blocked' };
  if (now - last > 1000 * 86400 * (options.maxIdleDays || 180)) return { state: 'observing', progress, reason: 'stale' };
  const rateBlocked = options.lastFormationAt
    && now - new Date(options.lastFormationAt).getTime() < MATURITY.minFormationGapHours * 3600000;
  const enough = spanDays >= MATURITY.minSpanDays
    && state.support >= MATURITY.minObservations
    && progress.distinctDays >= MATURITY.minDistinctDays
    && progress.contexts >= MATURITY.minContexts;
  if (!enough) return { state: 'observing', progress, reason: 'thresholds' };
  if (rateBlocked) return { state: 'observing', progress, reason: 'rate_limited' };
  if (!state.value) return { state: 'observing', progress, reason: 'no_value' };
  return { state: 'formed', progress, reason: 'thresholds_met' };
}

/** 交付形式与维度的相关性：只按本轮要交付的形态取，不做全量注入。 */
const DELIVERY_CUES = [
  { dimensions: ['comparison_format', 'option_presentation'], re: /(对比|比较|选型|方案|选项|哪个好)/u },
  { dimensions: ['answer_order', 'explanation_depth'], re: /(解释|为什么|讲讲|说明|分析)/u },
  { dimensions: ['progress_updates'], re: /(进度|过程|步骤|跑起来|执行)/u },
  { dimensions: ['example_use'], re: /(示例|例子|demo|样例)/iu },
  { dimensions: ['tone'], re: /(写|文案|回复|语气|口吻)/u },
];

const NO_PROJECTION_MODES = new Set(['strict_json', 'fixed_template', 'verbatim_translation']);

export function projectionModeOf(outputMode) {
  const text = String(outputMode || '').toLowerCase();
  if (NO_PROJECTION_MODES.has(text)) return 'skip';
  return 'normal';
}

/**
 * 投影选择：只取本轮交付形式相关、已形成且未暂停 1–2 维；本轮明确要求压过历史偏好。
 * 严格 JSON / 固定模板 / 逐字翻译不投影。
 */
export function selectPreferenceProjection(input) {
  const request = String((input && input.currentRequest) || '');
  const formed = input && input.formed && typeof input.formed === 'object' ? input.formed : {};
  if (projectionModeOf(input && input.outputMode) === 'skip') return { dimensions: [], block: null };
  /** 本轮用户的原话本身就是最明确的要求，和历史偏好冲突时以它为准。 */
  const explicit = [input && input.explicitRequirements, request].filter(Boolean).join(' ');
  const wanted = new Set();
  for (const cue of DELIVERY_CUES) if (cue.re.test(request)) for (const dimension of cue.dimensions) wanted.add(dimension);
  const rows = [];
  for (const dimension of DIMENSION_NAMES) {
    if (!wanted.has(dimension)) continue;
    const preference = formed[dimension];
    if (!preference || preference.state !== 'formed' || preference.pausedByUser || !preference.value) continue;
    if (NEUTRAL_VALUES.includes(preference.value)) continue;
    if (explicit && conflictsWithExplicit(preference, explicit)) continue;
    rows.push({ dimension, value: preference.value });
  }
  /**
   * 跟进化规则共用同一套预算选件：装不下两条就退一条，不因为超字节整段丢弃，
   * 也不截短任何一句偏好。
   */
  const sized = rows
    .map((row) => ({ dimension: row.dimension, value: row.value, text: (RENDER_TEXT[row.dimension] || {})[row.value] || '' }))
    .filter((row) => row.text);
  const bundle = selectContextBundle(sized, {
    maxItems: PROJECTION_MAX_DIMENSIONS,
    maxBytes: PROJECTION_LIMIT_BYTES - Buffer.byteLength('表达偏好：') - Buffer.byteLength('。'),
    allowEmpty: true,
    sizeOf: (row) => Buffer.byteLength(row.text) + Buffer.byteLength('；'),
  });
  const picked = bundle.items.map((row) => ({ dimension: row.dimension, value: row.value }));
  const block = picked.length ? renderPreferenceProjection(picked) : null;
  if (!block || Buffer.byteLength(block) > PROJECTION_LIMIT_BYTES) return { dimensions: [], block: null };
  return { dimensions: picked, block };
}

/** 本轮明确要求与历史偏好冲突时以本轮为准：宁可这一维不投影，也不跟用户当前的话打架。 */
export function conflictsWithExplicit(preference, explicit) {
  const text = String(explicit || '');
  if (!text) return false;
  const value = String(preference.value || '');
  const pairs = [
    ['brief', /(详细|展开|说透|多说)/u],
    ['detailed', /(简短|少说|别展开|简单点)/u],
    ['conclusion_first', /(先说背景|从头说)/u],
    ['background_first', /(先说结论|结论先行)/u],
    ['without_examples', /(举几个例子|举例)/u],
    ['with_examples', /(不用举例|别举例)/u],
    ['single_recommendation', /(给几个方案|列选项|对比|比较|选型)/u],
    ['multiple_options', /(直接定|只要一个)/u],
    ['table', /(别用表格|用一段话)/u],
    ['prose', /(用表格|列点)/u],
  ];
  return pairs.some(([target, re]) => target === value && re.test(text));
}

const RENDER_TEXT = {
  answer_order: { conclusion_first: '先给结论', background_first: '先说背景' },
  explanation_depth: { brief: '简短说', detailed: '讲详细', layered: '先总后分' },
  example_use: { with_examples: '带例子', without_examples: '不举例', only_on_request: '要例子才给' },
  option_presentation: { single_recommendation: '直接给建议', multiple_options: '给几个选项', tradeoff_table: '给对比表' },
  tone: { plain: '平实说', warm: '温和些', direct: '直接说', playful: '轻松些' },
  progress_updates: { announce_before_steps: '动手前先说', report_on_completion: '做完再说', silent_until_done: '安静做完' },
  option_count: { one: '一个方案', two_to_three: '两三个方案', many: '多列几个' },
  comparison_format: { table: '用表格', bullet_list: '分条列', prose: '一段话说' },
};

/** 一个块、一句话，渲染后 ≤200 字节；整维渲染，不截半句。 */
export function renderPreferenceProjection(rows) {
  const parts = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.dimension) continue;
    const text = RENDER_TEXT[row.dimension] && RENDER_TEXT[row.dimension][row.value];
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (!parts.length) return null;
  const block = `表达偏好：${parts.join('；')}。`;
  return Buffer.byteLength(block) > PROJECTION_LIMIT_BYTES ? null : block;
}

/** 面板「观察中」的真实进度：给次数与还差什么，不说「大概喜欢」。 */
export function describeObserving(preference) {
  const state = { ...emptyCounts(), ...(preference || {}) };
  const missing = [];
  if (state.support < MATURITY.minObservations) missing.push('次数');
  if (state.distinctDays < MATURITY.minDistinctDays) missing.push('天数');
  if (state.contexts < MATURITY.minContexts) missing.push('情境');
  return {
    text: state.support > 0 ? `已观察到 ${state.support} 次，仍不足以判断是否长期` : '还没有足够观察',
    support: state.support,
    missing,
  };
}
