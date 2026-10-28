import crypto from 'node:crypto';
import * as view from './view.js';

/** 一期固定策略版本：版本不认就停止整理，不猜兼容。 */
export const POLICY_VERSION = 1;

export const LIMITS = {
  inputBytes: 8192,
  maxChanges: 2,
  maxTokens: 768,
  outputBytes: 2048,
  timeoutMs: 15000,
  attemptsPerEpisode: 2,
  attemptsPerProject: 6,
  windowMs: 24 * 60 * 60 * 1000,
  trialMs: 30 * 24 * 60 * 60 * 1000,
  pausedMs: 30 * 24 * 60 * 60 * 1000,
  rules: 32,
  pending: 12,
  evidence: 3,
  versions: 2,
  receipts: 64,
  samples: 4,
  checkpoints: 3,
  callRules: 6,
  organizerRules: 8,
};

export const FEEDBACK_TYPES = ['spec_change', 'execution_miss', 'task_exception', 'aspect_accept', 'artifact_accept', 'unclear'];
export const LEARNING_STATES = ['pending', 'trial', 'active', 'paused'];
export const PHASES = ['brief', 'theme', 'outline', 'script', 'shoot', 'edit', 'publish'];
const ALLOWED_KEYS = new Set(['target', 'feedbackType', 'topicKey', 'currentText', 'title', 'summary', 'applicability', 'conditions', 'evidence', 'persistence', 'sourceExcerpt']);

const LONG_TERM = /以后|今后|长期|默认|每次都|每次|一直|统一|永远|从现在起|记住/;
const EXPLICIT_ACCEPT = /可以了|就这样|这版|就用这版|用这版|挺好|满意|保留|沿用|继续用|定稿|通过/;
const ARTIFACT_ACCEPT = /这版可以|可以用这版|就这版|这版就用|定稿|这版通过/;
const DIMENSION = /字幕|开头|配色|节奏|配乐|镜头|标题|封面|结尾|转场|旁白|音效|画面/;
const EXCEPTION = /这次|这次就|本期|这期|这一期|这个作品|这一条|本篇|本视频/;
const NEGATIVE = /不要|不用|别用|别再|停用|取消这条|这条不要|不喜欢|去掉|删掉/;
const CORRECTION = /改成|改为|换成|重做|重来|再来|下次|不对|错了|不是这样|又没|怎么又|还是没|没按|不好|不行|不满意|不要|别/;
const EXECUTION_MISS = /之前说过|已经说过|不是说好|怎么又|又没|还是没|没按|又忘|重复/;
const UNCLEAR = /不太对|再想想|感觉不对|说不上|有点怪|不对劲/;
/**
 * 点名项目范围才算全项目授权；「以后都」不等于「所有项目」。
 * 「所有口播」「一律」这种覆盖全部对象的说法也算，但只限当前项目层。
 */
const PROJECT_WIDE = /(这个项目|本项目|所有项目|全项目|整个项目|全库|每个项目)/;
/** 「所有口播」「一律」限定的是对象，不是整个项目：没有可信范围时只算待确认。 */

const has = (pattern, text) => pattern.test(text);

/** 从反馈里取一个可命名的验收维度；没有就记为作品整体。 */
export function dimensionOf(input) {
  const text = String(input || '');
  const match = text.match(DIMENSION);
  return match ? match[0] : '作品';
}

/** 只判断“值得检查”，不把正则命中直接当长期规则。 */
export function classifyFeedback(input) {
  const text = String(input || '').trim();
  if (!text) return { worth: false, type: 'unclear', longTerm: false, explicitLongTerm: false, exception: false, negative: false, dimension: '' };
  const longTerm = has(LONG_TERM, text);
  const exception = has(EXCEPTION, text);
  const negative = has(NEGATIVE, text);
  const dimensionMatch = text.match(DIMENSION);
  const dimension = dimensionMatch ? dimensionMatch[0] : '';
  if (has(ARTIFACT_ACCEPT, text) && !longTerm) {
    return { worth: true, type: 'artifact_accept', longTerm: false, explicitLongTerm: false, exception, negative: false, dimension };
  }
  if (has(EXECUTION_MISS, text) && !has(/改成|改为|换成/, text)) {
    return { worth: true, type: 'execution_miss', longTerm, explicitLongTerm: longTerm, exception, negative, dimension };
  }
  if (has(UNCLEAR, text) && !has(CORRECTION, text)) {
    return { worth: true, type: 'unclear', longTerm, explicitLongTerm: false, exception, negative: false, dimension };
  }
  if (has(EXPLICIT_ACCEPT, text) && !has(CORRECTION, text)) {
    return { worth: true, type: dimension ? 'aspect_accept' : 'artifact_accept', longTerm, explicitLongTerm: longTerm, exception, negative: false, dimension };
  }
  /** 不是纠正句也可以立规范：“这个项目默认用 pnpm”这类声明本身就是长期要求。 */
  if (longTerm && !exception) {
    return { worth: true, type: 'spec_change', longTerm: true, explicitLongTerm: true, exception: false, negative, dimension };
  }
  if (exception && has(CORRECTION, text)) {
    return { worth: true, type: 'task_exception', longTerm: false, explicitLongTerm: false, exception: true, negative, dimension };
  }
  if (has(CORRECTION, text)) {
    return { worth: true, type: 'spec_change', longTerm, explicitLongTerm: longTerm && !exception, exception, negative, dimension };
  }
  return { worth: false, type: 'unclear', longTerm, explicitLongTerm: false, exception, negative: false, dimension };
}

export function isLongTerm(text) {
  return has(LONG_TERM, String(text || ''));
}

const BOUND_STATUSES = ['active', 'continuable', 'proposed'];

/**
 * 一次整理运行能用到的身份只从调用方传入的上下文取：项目、会话、请求、作品、任务。
 * 未绑定但带着 episodeId 的任务是「项目层候选」，不是「已绑定但作品失效」。
 */
export function runtimeContextOf(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : null;
  const episodeId = String(anchor?.episodeId ?? raw.episodeId ?? '');
  const status = String(anchor ? (anchor.status ?? '') : (raw.status ?? ''));
  return {
    projectId: String(raw.projectId ?? ''),
    sessionId: String(raw.sessionId ?? ''),
    requestId: String(raw.requestId ?? ''),
    episodeId,
    status,
    bound: Boolean(episodeId) && BOUND_STATUSES.includes(status),
    taskKind: String(anchor?.taskKind ?? raw.taskKind ?? ''),
    seriesId: String(anchor?.seriesId ?? raw.seriesId ?? ''),
    phase: String(anchor?.phase ?? raw.phase ?? ''),
    anchorProjectId: String(anchor?.projectId ?? ''),
    episodeUpdatedAt: String(anchor?.updatedAt ?? ''),
  };
}

/** 人类反馈原文的短摘录；来源是历史消息，不重写。 */
export function sourceExcerptOf(input, { max = 160 } = {}) {
  const clean = String(input || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function humanFeedback(messages) {
  const ids = [];
  const texts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.source?.kind !== 'user') continue;
    const text = view.messageText ? view.messageText(message) : messageText(message);
    if (!text) continue;
    ids.push(String(message.id ?? ''));
    texts.push(text);
  }
  return { ids: ids.filter(Boolean), text: texts.join('\n').slice(0, 1200) };
}

/**
 * 有作品绑定就走作品候选；没有绑定、但属于同一项目的规范纠正或长期要求，
 * 仍可形成 project 作用域的 pending 候选。跨项目一律不接收，也不把整个项目绑到单条栏目。
 */
export function candidateFrom({ messages, anchor, sessionId, projectId, now } = {}) {
  /**
   * 只有仍可用的作品绑定才算作品候选。任务状态里常常保留一个 unbound 的 episodeId，
   * 旧逻辑见到 episodeId 就直接拒绝，导致这类项目永远走不到项目层候选。
   */
  const context = runtimeContextOf({ projectId, sessionId, anchor });
  const bound = context.bound;
  if (context.anchorProjectId && context.projectId && context.anchorProjectId !== context.projectId) return null;
  const { ids, text } = humanFeedback(messages);
  if (!text) return null;
  const cue = classifyFeedback(text);
  if (!cue.worth) return null;
  const at = now || Date.now();
  const messageIds = ids.slice(-8);
  const sourceExcerpt = sourceExcerptOf(text);
  if (bound) {
    return {
      projectId: context.projectId,
      sessionId: context.sessionId,
      scope: 'episode',
      state: 'pending',
      episodeId: context.episodeId,
      taskKind: context.taskKind,
      seriesId: context.seriesId,
      phase: context.phase,
      messageIds,
      text,
      sourceExcerpt,
      cue,
      expectedTarget: {
        scope: 'episode',
        projectId: context.projectId,
        episodeId: context.episodeId,
        ...(context.taskKind ? { taskKind: context.taskKind } : {}),
        ...(context.seriesId ? { seriesId: context.seriesId } : {}),
        ...(context.phase ? { phase: context.phase } : {}),
      },
      episodeUpdatedAt: context.episodeUpdatedAt,
      at,
    };
  }
  if (!context.projectId) return null;
  /** 没有作品绑定时，规范纠正同样按项目候选收集；单次局部改动交给整理器判空，不再用电平词一刀切。 */
  if (cue.type !== 'spec_change') return null;
  /** 作用域在收集时就固定：只有原句点名项目范围才给全项目，否则先待确认。 */
  const applicability = PROJECT_WIDE.test(text) ? 'all_in_scope' : 'unresolved';
  return {
    projectId: context.projectId,
    sessionId: context.sessionId,
    scope: 'project',
    state: 'pending',
    episodeId: '',
    taskKind: '',
    seriesId: '',
    phase: '',
    messageIds,
    text,
    sourceExcerpt,
    cue,
    expectedTarget: { scope: 'project', projectId, applicability },
    episodeUpdatedAt: '',
    at,
  };
}

function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

const bounded = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
};

export function specDigestOf(record) {
  const current = record || {};
  const material = JSON.stringify({
    topicKey: current.topicKey || '',
    body: current.body || current.currentText || '',
    applicability: current.applicability || '',
    conditions: normalizeConditions(current.conditions),
  });
  return `sd_${crypto.createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

export function normalizeConditions(conditions) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(conditions) ? conditions : []) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.key || '').trim();
    const value = String(row.value || '').trim();
    if (!view.CONDITION_KEYS.includes(key) || !value) continue;
    const signature = `${key}\u0000${value}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({ key, value });
  }
  return out.slice(0, 8);
}

const STATE_WEIGHT = { active: 3, trial: 2, pending: 1, paused: 0 };

function gramsOf(input) {
  const text = String(input || '').toLowerCase();
  const out = new Set();
  for (const word of text.match(/[a-z0-9_]+/g) || []) if (word.length >= 2) out.add(word);
  for (const run of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) out.add(run.slice(index, index + 2));
  }
  return out;
}

function relevanceOf(record, context) {
  const query = String(context.query || '').toLowerCase();
  const dimensions = (Array.isArray(context.dimensions) ? context.dimensions : [])
    .map((value) => String(value || '').toLowerCase()).filter(Boolean);
  const topicKey = String(record.topicKey || '').toLowerCase();
  const conditions = normalizeConditions(record.conditions);
  const hay = [
    topicKey,
    record.title || '',
    record.summary || '',
    record.body || '',
    conditions.map((row) => `${row.key}=${row.value}`).join(' '),
  ].join(' ').toLowerCase();
  let score = 0;
  if (topicKey && query) {
    if (query.includes(topicKey)) score += 150;
    else {
      const shared = [...gramsOf(topicKey)].filter((gram) => query.includes(gram)).length;
      if (shared) score += 90;
    }
  }
  for (const dimension of dimensions) if (hay.includes(dimension)) score += 80;
  const queryGrams = gramsOf(query);
  const fieldWeights = [[record.title, 10], [record.summary, 6], [record.body, 4]];
  for (const [text, weight] of fieldWeights) {
    let hits = 0;
    for (const gram of gramsOf(text)) if (queryGrams.has(gram)) hits += 1;
    score += Math.min(hits, 6) * weight;
  }
  for (const row of conditions) {
    if (row.key === 'taskKind' && context.taskKind && row.value === context.taskKind) score += 15;
    else if (row.key === 'seriesId' && context.seriesId && row.value === context.seriesId) score += 15;
    else if (row.key === 'phase' && context.phase && row.value === context.phase) score += 15;
  }
  return score;
}

/** 先按相关性和可用性排序，再截断；排序稳定可复现，不依赖输入顺序。 */
export function rankRules(rules, context = {}) {
  const rows = (Array.isArray(rules) ? rules : [])
    .filter((record) => record && record.id)
    .map((record, index) => ({
      record,
      index,
      relevance: relevanceOf(record, context),
      stateWeight: STATE_WEIGHT[record.learning?.state || record.state] ?? 1,
      updated: String(record.updated || record.updatedAt || record.created || ''),
      id: String(record.id),
    }));
  rows.sort((a, b) => b.relevance - a.relevance
    || b.stateWeight - a.stateWeight
    || b.updated.localeCompare(a.updated)
    || a.id.localeCompare(b.id)
    || a.index - b.index);
  return rows.map((row) => row.record);
}

export function selectRules(rules, context = {}) {
  const limit = Number(context.limit || LIMITS.organizerRules);
  return rankRules(rules, context).slice(0, Math.max(1, limit));
}

/**
 * 整理器可见规则：先按状态、最近使用、更新时间稳定排序，再取上限；
 * 不能先 slice 再排序，否则真正可用的旧经验会被输入顺序挤掉。
 */
export function orderOrganizerRules(rules, { limit = LIMITS.organizerRules } = {}) {
  const cap = Math.max(1, Number(limit) || LIMITS.organizerRules);
  const rows = (Array.isArray(rules) ? rules : [])
    .filter((record) => record && record.id)
    .map((record, index) => {
      const lastUsed = Date.parse(record.lastUsedAt || record.learning?.lastUsedAt || record.learning?.usedAt || '');
      const updated = Date.parse(record.learning?.updatedAt || record.updatedAt || record.updated || '');
      return {
        record,
        index,
        stateWeight: STATE_WEIGHT[record.learning?.state || record.state] ?? 1,
        lastUsed: Number.isFinite(lastUsed) ? lastUsed : 0,
        updated: Number.isFinite(updated) ? updated : 0,
        id: String(record.id),
      };
    });
  rows.sort((a, b) => b.stateWeight - a.stateWeight
    || b.lastUsed - a.lastUsed
    || b.updated - a.updated
    || a.id.localeCompare(b.id)
    || a.index - b.index);
  return rows.slice(0, cap).map((row) => row.record);
}

/** 构造一次受限调用输入：无工具、无前台历史，只有身份、少量规则和反馈映射。 */
/** 明确长期要求本身就是可信收集信号：整理器返回空时至少落一条规则，不让它无声消失。 */
export function pendingChangeFrom(feedback = {}) {
  const text = String(feedback.text || '').replace(/\r/g, '').trim();
  if (!text) return null;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 6);
  const currentText = lines.join('\n').slice(0, 240);
  if (!currentText) return null;
  const first = (lines[0] || currentText).split(/[，。！？；]/)[0].trim();
  const topicKey = String(feedback.cue?.dimension || first || currentText).slice(0, 60);
  /**
   * 兜底不是授权：只在文本自己说到全项目时才按全项目收，否则保留它原本的适用范围
   * （有任务种类就挂条件，没有就待确认），不能让一句「以后开头先给结论」变成全库规则。
   */
  const expected = feedback.expectedTarget && typeof feedback.expectedTarget === 'object' ? feedback.expectedTarget : null;
  const taskKind = String(feedback.cue?.taskKind || expected?.taskKind || '').trim();
  /** 采集阶段是「在哪儿学到」的证据，不是长期适用范围：只把任务身份与系列带进条件。 */
  const collectedConditions = ['taskKind', 'seriesId']
    .filter((key) => String(expected?.[key] || '').trim())
    .map((key) => ({ key, value: String(expected[key]).trim() }));
  const expectedConditions = collectedConditions;
  /**
   * 兜底不重新推导作用域：候选收集时已经固定 expectedTarget 就照抄（只能沿用或收窄），
   * 没有 expectedTarget 的旧调用才退回原句判断。
   */
  const applicability = expected
    ? (expected.applicability === 'all_in_scope'
      ? 'all_in_scope'
      : expectedConditions.length ? 'conditional' : 'unresolved')
    : /(这个项目|本项目|所有项目|全项目|整个项目|全库|每个项目)/.test(currentText)
      ? 'all_in_scope'
      : taskKind ? 'conditional' : 'unresolved';
  const conditions = expected
    ? (applicability === 'conditional' ? expectedConditions : [])
    : applicability === 'conditional' ? [{ key: 'taskKind', value: taskKind }] : [];
  return {
    target: 'new',
    feedbackType: 'spec_change',
    topicKey,
    currentText,
    applicability,
    conditions,
    evidence: ['u0'],
    persistence: 'project_candidate',
    /** 摘录从候选一路带到提交路径，模型返回空时也不丢来源。 */
    sourceExcerpt: String(feedback.sourceExcerpt || sourceExcerptOf(text)).slice(0, 160),
  };
}

/**
 * 收集与展示共用的准入判断；启发式推断只能得到「待确认候选」，
 * 不会因为写进存储就变成用户确认，除非候选本身带着明确的确认标记。
 */
export function admissionOf(candidate, runtime = {}, purpose = 'collect') {
  const mode = String(purpose || 'collect');
  if (!['collect', 'display'].includes(mode)) return { ok: false, reason: '用途不认' };
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: '没有候选' };
  const context = runtimeContextOf({ ...(runtime || {}), projectId: runtime?.projectId ?? candidate.projectId, sessionId: runtime?.sessionId ?? candidate.sessionId });
  if (!context.projectId) return { ok: false, reason: '缺少项目身份' };
  if (candidate.projectId && String(candidate.projectId) !== context.projectId) return { ok: false, reason: '候选不属于这个项目' };
  const cue = candidate.cue && typeof candidate.cue === 'object' ? candidate.cue : classifyFeedback(candidate.text);
  if (!cue?.worth) return { ok: false, reason: '反馈不值得检查' };
  const scope = candidate.scope === 'project' ? 'project' : 'episode';
  if (scope === 'episode') {
    if (!context.bound) return { ok: false, reason: '作品绑定已经失效', scope };
    if (candidate.episodeId && String(candidate.episodeId) !== context.episodeId) return { ok: false, reason: '候选不属于这期作品', scope };
  } else {
    if (context.bound) return { ok: false, reason: '有作品绑定时不走项目候选', scope };
    if (cue.type !== 'spec_change') return { ok: false, reason: '项目候选只收规范纠正', scope };
  }
  const confirmed = candidate.confirmed === true || runtime?.confirmed === true;
  return {
    ok: true,
    purpose: mode,
    scope,
    projectId: context.projectId,
    episodeId: scope === 'episode' ? context.episodeId : '',
    cueType: cue.type,
    longTerm: Boolean(cue.explicitLongTerm),
    confirmed,
    requiresUserConfirmation: !confirmed,
    /** 写入后仍是待确认候选，不冒充已确认的长期规则。 */
    persistence: 'project_candidate',
    visibility: 'candidate',
  };
}

export function buildCallInput({ projectId, episodeId, taskKind, seriesId, phase, feedback, rules, ranges, maxBytes = LIMITS.inputBytes } = {}) {
  const context = runtimeContextOf({ projectId, episodeId, taskKind, seriesId, phase });
  const refs = { feedback: {}, rules: {} };
  const source = (Array.isArray(rules) ? rules : []).filter((record) => record && record.id);
  /** 先按本次反馈的相关性排序，再取前几条：固定取前 6 条会把真正相关的旧经验挤掉。 */
  const dimension = String(feedback?.cue?.dimension || '');
  const prioritized = selectRules(source, {
    query: feedback?.text || '',
    dimensions: dimension ? [dimension] : [],
    taskKind: context.taskKind,
    seriesId: context.seriesId,
    phase: context.phase,
    limit: LIMITS.callRules,
  });
  const messageIds = (Array.isArray(feedback?.messageIds) ? feedback.messageIds : [])
    .map((id) => String(id || '')).filter(Boolean).slice(-8);
  const sourceExcerpt = String(feedback?.sourceExcerpt || sourceExcerptOf(feedback?.text || '')).slice(0, 160);
  refs.feedback.u0 = messageIds[0] || '';
  const project = {
    projectId: bounded(context.projectId, 80),
    ...(context.episodeId ? { episodeId: bounded(context.episodeId, 80) } : { scope: 'project' }),
    ...(context.taskKind ? { taskKind: context.taskKind } : {}),
    ...(context.seriesId ? { seriesId: context.seriesId } : {}),
    ...(context.phase ? { phase: context.phase } : {}),
  };
  const rangesInput = {
    taskKind: (ranges?.taskKinds || []).slice(0, 8),
    seriesId: (ranges?.series || []).slice(0, 8),
    phase: PHASES.slice(),
  };
  const system = '你是项目记忆整理器，只输出 JSON。只能依据给定反馈修改已有规则或新建一条项目规则；不得调用工具，不得输出 JSON 之外的文字。'
    + '可复用的做法、偏好、禁止项，或对作品的可迁移纠正，都应落成规则；反馈没有说“以后”也可以新建，保存为待确认候选，由用户决定。'
    + '同一主题已有规则时更新那条，不要新建重复规则；验收和执行检查点只能挂到已有规则。'
    + '只改某一处文案、换一次值这类单次局部改动不建规则。'
    + '只有明确仅限这一次、没有可执行内容、或无法判断时才输出 {"changes":[]}。';
  const feedbackHead = {
    type: feedback?.cue?.type || 'unclear',
    longTerm: Boolean(feedback?.cue?.explicitLongTerm),
    scope: feedback?.scope === 'project' ? 'project' : 'episode',
    ...(feedback?.cue?.dimension ? { dimension: feedback.cue.dimension } : {}),
    ...(sourceExcerpt ? { sourceExcerpt } : {}),
    ...(messageIds.length ? { messageIds } : {}),
  };
  const tail = {
    allowed: {
      conditions: view.CONDITION_KEYS,
      ranges: rangesInput,
      maxChanges: LIMITS.maxChanges,
      execution_miss: '仅已有规则，currentText 写检查点',
      artifact_accept: '仅已有规则，记验收样例',
      existing: '同主题改 r0，不新建重复规则',
    },
    output: {
      changes: [{
        target: 'r0 或 new', feedbackType: FEEDBACK_TYPES, topicKey: '短主题键', currentText: '当前可执行规范', applicability: 'all_in_scope|conditional|unresolved', conditions: [{ key: 'taskKind', value: 'video' }], evidence: ['u0'], persistence: 'project_candidate',
      }],
    },
  };
  const render = (selected, feedbackText) => JSON.stringify({
    project,
    feedback: { ...feedbackHead, refs: [['u0', feedbackText]] },
    rules: selected,
    ...tail,
  });
  /** 反馈正文按整段回退，不切开 JSON；仍放不下就是本次调用不可行。 */
  let feedbackText = bounded(feedback.text, 600);
  let prompt = render([], feedbackText);
  while (Buffer.byteLength(system) + Buffer.byteLength(prompt) > maxBytes && feedbackText.length > 0) {
    feedbackText = feedbackText.slice(0, Math.floor(feedbackText.length * 0.6));
    prompt = render([], feedbackText);
  }
  if (Buffer.byteLength(system) + Buffer.byteLength(prompt) > maxBytes) {
    return { system, prompt: '', messages: [], refs, rules: [], bytes: Buffer.byteLength(system), overLimit: true };
  }
  const inputRules = [];
  for (const record of prioritized.slice(0, 6)) {
    const ref = `r${inputRules.length}`;
    refs.rules[ref] = record.id;
    const row = {
      ref,
      revision: record.revision || 1,
      title: bounded(record.title, 60),
      summary: bounded(record.summary, 120),
      body: bounded(record.body, 360),
      applicability: record.applicability || 'unresolved',
      conditions: normalizeConditions(record.conditions),
      state: record.learning?.state || record.state || 'trial',
    };
    const next = render([...inputRules, row], feedbackText);
    if (Buffer.byteLength(system) + Buffer.byteLength(next) > maxBytes) break;
    inputRules.push(row);
    prompt = next;
  }
  return { system, prompt, messages: [{ role: 'user', content: prompt }], refs, rules: inputRules, bytes: Buffer.byteLength(system) + Buffer.byteLength(prompt), sourceExcerpt, messageIds };
}
/** 严格解析：截断、工具调用、额外字段、超限都整批拒绝，不做第二次修复调用。 */
export function parseOutput(text, { finish, refs, rules, ranges, expectedTarget } = {}) {
  if (finish && finish.kind !== 'stop' && finish.kind !== 'completed') return { ok: false, reason: '整理没有正常结束' };
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: '整理没有返回内容' };
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.outputBytes) return { ok: false, reason: '整理输出太长' };
  if (/<[^>]+>/.test(raw) && !raw.startsWith('{')) return { ok: false, reason: '整理返回了工具调用' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '整理 JSON 不完整' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: '整理结果不是对象' };
  for (const key of Object.keys(data)) if (key !== 'changes') return { ok: false, reason: '整理结果有未知字段' };
  if (!Array.isArray(data.changes)) return { ok: false, reason: '整理结果缺少变化列表' };
  if (data.changes.length > LIMITS.maxChanges) return { ok: false, reason: '一次改动太多' };
  const changes = [];
  for (const change of data.changes) {
    const checked = validateChange(change, { refs, rules, ranges, expectedTarget });
    if (!checked.ok) return checked;
    changes.push(checked.change);
  }
  return { ok: true, changes };
}

export function validateChange(change, { refs, rules, ranges, expectedTarget } = {}) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return { ok: false, reason: '变化不是对象' };
  for (const key of Object.keys(change)) if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `变化里有未知字段：${key}` };
  const byRef = new Map((Array.isArray(rules) ? rules : []).map((row) => [row.ref, row]));
  const target = String(change.target || '').trim();
  if (!target) return { ok: false, reason: '变化缺少目标' };
  if (target !== 'new' && !byRef.has(target)) return { ok: false, reason: '变化目标不在本次输入里' };
  if (!FEEDBACK_TYPES.includes(change.feedbackType)) return { ok: false, reason: '反馈类型不认' };
  if (change.feedbackType === 'task_exception' || change.feedbackType === 'unclear') {
    return { ok: false, reason: '这类反馈不直接形成长期规则' };
  }
  const sampleOnly = change.feedbackType === 'artifact_accept';
  const checkpointOnly = change.feedbackType === 'execution_miss';
  if ((sampleOnly || checkpointOnly) && target === 'new') {
    return { ok: false, reason: sampleOnly ? '验收依据只能挂到已有规则' : '执行检查点只能挂到已有规则' };
  }
  const existing = target === 'new' ? null : {
    id: refs?.rules?.[target] || '',
    revision: byRef.get(target).revision,
    conditions: byRef.get(target).conditions,
  };
  /** 反馈类型决定能改什么：例外、检查点、认可都不能借机重写规范。 */
  if (checkpointOnly && (change.topicKey !== undefined || change.title !== undefined
    || change.summary !== undefined || change.applicability !== undefined || change.conditions !== undefined)) {
    return { ok: false, reason: '执行检查点只记录检查点，不改规范' };
  }
  if (change.feedbackType === 'aspect_accept') {
    if (target === 'new') return { ok: false, reason: '认可只能挂到匹配的已有规则' };
    if (change.currentText !== undefined || change.topicKey !== undefined || change.title !== undefined
      || change.summary !== undefined || change.applicability !== undefined) {
      return { ok: false, reason: '认可只记录验收，不改规范' };
    }
    if (change.conditions !== undefined
      && JSON.stringify(normalizeConditions(change.conditions)) !== JSON.stringify(normalizeConditions(existing?.conditions))) {
      return { ok: false, reason: '认可条件与目标规则不一致' };
    }
  }
  if (change.persistence !== undefined && change.persistence !== 'project_candidate') return { ok: false, reason: '持久化方式不认' };
  const topicKey = change.topicKey === undefined ? (existing || sampleOnly ? undefined : '') : String(change.topicKey || '').trim();
  if (!existing && !sampleOnly && !topicKey) return { ok: false, reason: '新规则缺少主题键' };
  if (topicKey !== undefined && (!topicKey || topicKey.length > 60)) return { ok: false, reason: '主题键不合法' };
  const currentText = change.currentText === undefined ? (existing || sampleOnly ? undefined : '') : String(change.currentText || '').trim();
  if (!existing && !sampleOnly && !currentText) return { ok: false, reason: '新规则缺少当前规范' };
  if (currentText !== undefined && (!currentText || currentText.length > 240 || currentText.split('\n').length > 6)) {
    return { ok: false, reason: '当前规范不合法' };
  }
  let applicability;
  if (change.applicability !== undefined) {
    if (!['all_in_scope', 'conditional', 'unresolved'].includes(change.applicability)) return { ok: false, reason: '适用范围不认' };
    applicability = change.applicability;
  }
  let conditions;
  if (change.conditions !== undefined) {
    if (!Array.isArray(change.conditions)) return { ok: false, reason: '条件不是列表' };
    conditions = normalizeConditions(change.conditions);
    if (conditions.length !== change.conditions.length) return { ok: false, reason: '条件里有不认的键或空值' };
  }
  /** 收集时固定的作用域只能沿用或收窄：整理器不能把待确认候选抬成全项目规则。 */
  const expected = expectedTarget && typeof expectedTarget === 'object' ? expectedTarget : null;
  /** 采集阶段是「在哪儿学到」的证据，不是长期适用范围：只把任务身份与系列带进条件。 */
  const collectedConditions = ['taskKind', 'seriesId']
    .filter((key) => String(expected?.[key] || '').trim())
    .map((key) => ({ key, value: String(expected[key]).trim() }));
  const expectedConditions = collectedConditions;
  /** 作品里学到的规范必须带上当时的任务范围：模型想写成全项目时收窄成条件规则，而不是丢掉这条反馈。 */
  const narrowToEpisode = target === 'new' && expected?.scope === 'episode' && expectedConditions.length > 0;
  if (narrowToEpisode) {
    if (applicability === undefined || applicability === 'all_in_scope') applicability = 'conditional';
    const merged = conditions !== undefined ? [...conditions] : [];
    for (const row of expectedConditions) {
      const sameKey = merged.find((item) => item.key === row.key);
      if (sameKey) {
        if (sameKey.value !== row.value) return { ok: false, reason: '条件与收集时的任务范围冲突' };
        continue;
      }
      /** 采集条件来自已绑定的真实任务，不要求它先出现在历史规则里；模型新提的条件仍走范围校验。 */
      merged.push(row);
    }
    const keys = new Set();
    for (const row of merged) {
      if (keys.has(row.key)) return { ok: false, reason: '同一条件键给了两个值' };
      keys.add(row.key);
    }
    conditions = merged;
  }
  const expectedApplicability = expected
    ? (expected.applicability === 'all_in_scope'
      ? 'all_in_scope'
      : expectedConditions.length ? 'conditional' : 'unresolved')
    : '';
  if (expectedApplicability && applicability === 'all_in_scope' && expectedApplicability !== 'all_in_scope') {
    return { ok: false, reason: '适用范围不能从待确认抬成全项目' };
  }
  if (expected && expected.scope === 'episode' && applicability === 'all_in_scope') {
    return { ok: false, reason: '作品规则不能抬成全项目' };
  }
  const effectiveConditions = conditions !== undefined ? conditions : normalizeConditions(existing?.conditions);
  /** 条件键必须唯一：phase=script 与 phase=brief 同时存在，规则会显示生效却永远不适用。 */
  const conditionKeys = new Set();
  for (const row of effectiveConditions) {
    if (conditionKeys.has(row.key)) return { ok: false, reason: '同一条件键给了两个值' };
    conditionKeys.add(row.key);
  }
  /**
   * 统一校验最终条件：收集阶段带进来的 taskKind/seriesId 是可信范围，历史范围里没有也允许；
   * 模型新提的条件仍必须落在本项目已有栏目或阶段里。
   */
  for (const condition of effectiveConditions) {
    const fromCollected = expectedConditions.some((row) => row.key === condition.key && row.value === condition.value);
    if (fromCollected) continue;
    if (!conditionValueAllowed(condition, { ranges, existing })) {
      return { ok: false, reason: '条件值不在本项目的栏目或阶段里' };
    }
  }
  if (applicability === 'all_in_scope' && effectiveConditions.length) {
    return { ok: false, reason: '全项目规则不能带条件' };
  }
  if (applicability === 'conditional' && !conditions && !existing && !sampleOnly) {
    return { ok: false, reason: '条件适用必须给出条件' };
  }
  if (conditions && expectedConditions.length) {
    const has = new Set(conditions.map((row) => `${row.key}=${row.value}`));
    if (expectedConditions.some((row) => !has.has(`${row.key}=${row.value}`))) {
      return { ok: false, reason: '条件不能删掉收集时的任务范围' };
    }
  }
  const evidence = Array.isArray(change.evidence) ? change.evidence.map((value) => String(value)) : [];
  if (!evidence.length || evidence.length > LIMITS.evidence) return { ok: false, reason: '证据数量不对' };
  for (const ref of evidence) if (!refs?.feedback?.[ref]) return { ok: false, reason: '证据不在本次反馈里' };
  const title = change.title === undefined ? undefined : String(change.title || '').trim().slice(0, 40);
  const summary = change.summary === undefined ? undefined : String(change.summary || '').trim().slice(0, 80);
  return {
    ok: true,
    change: {
      target,
      id: existing?.id || '',
      feedbackType: change.feedbackType,
      ...(topicKey !== undefined ? { topicKey } : {}),
      ...(currentText !== undefined ? { currentText } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(applicability !== undefined ? { applicability } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
      evidence,
      ...(change.sourceExcerpt !== undefined ? { sourceExcerpt: bounded(change.sourceExcerpt, 160) } : {}),
    },
  };
}

function conditionValueAllowed(condition, { ranges, existing }) {
  if (condition.key === 'seriesId') return Boolean(ranges?.series?.includes(condition.value) || (existing?.conditions || []).some((row) => row.key === 'seriesId' && row.value === condition.value));
  if (condition.key === 'taskKind') return Boolean(ranges?.taskKinds?.includes(condition.value) || (existing?.conditions || []).some((row) => row.key === 'taskKind' && row.value === condition.value));
  if (condition.key === 'phase') return PHASES.includes(condition.value) || (existing?.conditions || []).some((row) => row.key === 'phase' && row.value === condition.value);
  return true;
}

function titleFrom(text, topicKey) {
  const clean = String(text || '').replace(/^[「『"']|[」』"']$/g, '').split(/[。！？；;\n]/)[0].trim();
  return (clean || topicKey || '项目实验规则').slice(0, 18);
}

/** 把通过校验的变化并进现有条目；新条目从不冒充全项目规则。 */
export function mergeChange(existing, change, { now } = {}) {
  const at = new Date(now || Date.now()).toISOString();
  const body = change.currentText !== undefined ? change.currentText : existing?.body || '';
  const conditions = change.conditions !== undefined ? change.conditions : normalizeConditions(existing?.conditions);
  const topicKey = change.topicKey !== undefined ? change.topicKey : existing?.topicKey || '';
  const applicability = change.applicability !== undefined
    ? change.applicability
    : existing?.applicability || (conditions.length ? 'conditional' : 'unresolved');
  const current = {
    topicKey,
    title: change.title || existing?.title || titleFrom(body, topicKey),
    summary: change.summary || existing?.summary || `项目经验：${topicKey || titleFrom(body, topicKey)}`,
    body,
    applicability,
    conditions,
    when: conditions.length ? conditions.map((row) => `${row.key}=${row.value}`).join('、') : (existing?.when || ''),
  };
  const previousDigest = existing ? (existing.learning?.specDigest || specDigestOf(existing)) : '';
  const digest = specDigestOf(current);
  const specChanged = !existing || previousDigest !== digest;
  const learning = existing?.learning ? JSON.parse(JSON.stringify(existing.learning)) : {
    state: 'pending',
    supportedEpisodeIds: [],
    evidence: [],
    versions: [],
    createdAt: at,
  };
  if (specChanged && existing) {
    if (learning.specDigest) {
      learning.versions = [...(learning.versions || []), { digest: learning.specDigest, body: existing.body, at }].slice(-LIMITS.versions);
    }
    learning.supportedEpisodeIds = [];
    learning.evidence = [];
  }
  learning.specDigest = digest;
  learning.updatedAt = at;
  return { current, learning, specChanged, digest };
}

/** 认可样例只记作品版本与验收维度，不抬规则证据；路径未校验就标未验证。 */
export function addSample(learning, sample = {}) {
  const next = learning ? JSON.parse(JSON.stringify(learning)) : {};
  const rows = (Array.isArray(next.samples) ? next.samples : []).filter((row) => row && row.episodeId && row.dimension);
  const row = {
    episodeId: bounded(sample.episodeId, 80),
    artifactVersion: bounded(sample.artifactVersion || '', 40),
    dimension: bounded(sample.dimension || '作品', 20),
    messageIds: (Array.isArray(sample.messageIds) ? sample.messageIds : []).slice(-3).map((id) => bounded(id, 80)),
    verified: sample.verified === true,
    at: new Date(sample.at || Date.now()).toISOString(),
  };
  const kept = rows.filter((item) => !(item.episodeId === row.episodeId && item.dimension === row.dimension));
  next.samples = [...kept, row].slice(-LIMITS.samples);
  return next;
}

/** 执行没做到时补检查点：不改规范正文，也不加同义禁令。 */
export function addCheckpoint(learning, checkpoint = {}) {
  const next = learning ? JSON.parse(JSON.stringify(learning)) : {};
  const text = bounded(String(checkpoint.text || '').trim(), 160);
  if (!text) return next;
  const rows = (Array.isArray(next.checkpoints) ? next.checkpoints : []).filter((row) => row && row.text);
  next.checkpoints = [...rows.filter((row) => row.text !== text), {
    text,
    messageIds: (Array.isArray(checkpoint.messageIds) ? checkpoint.messageIds : []).slice(-3).map((id) => bounded(id, 80)),
    at: new Date(checkpoint.at || Date.now()).toISOString(),
  }].slice(-LIMITS.checkpoints);
  return next;
}

const NON_NORM_TYPES = new Set(['execution_miss', 'artifact_accept', 'aspect_accept']);

/**
 * 状态只看证据强度：明确长期要求或两个独立作品才 active；条件不确定就 pending。
 * 例外/含糊/验收/执行检查点不形成长期规范；目标或规范变了，旧证据立即失效。
 */
export function nextLearningState({ existing, change, evidence, now, specChanged = false } = {}) {
  const at = new Date(now || Date.now()).toISOString();
  const learning = existing?.learning ? JSON.parse(JSON.stringify(existing.learning)) : { state: 'pending', supportedEpisodeIds: [], evidence: [] };
  const priorState = LEARNING_STATES.includes(learning.state) ? learning.state : 'pending';
  const feedbackType = change?.feedbackType || '';
  learning.updatedAt = at;
  learning.lastFeedbackType = feedbackType || learning.lastFeedbackType || '';
  /** 这些反馈只补充验收或检查点，不抬升状态，也不产生长期规范。 */
  if (NON_NORM_TYPES.has(feedbackType) || feedbackType === 'task_exception' || feedbackType === 'unclear') {
    if (!existing) learning.state = 'pending';
    return learning;
  }
  const targetChanged = Boolean(change?.id && existing?.id && String(change.id) !== String(existing.id));
  /** 规范正文、适用条件或目标对象变了：旧证据不再支持新规范，只保留本次这一条。 */
  const reset = specChanged === true || targetChanged;
  const episodes = reset ? [] : (Array.isArray(learning.supportedEpisodeIds) ? learning.supportedEpisodeIds.slice() : []);
  if (evidence?.episodeId && !episodes.includes(evidence.episodeId)) episodes.push(evidence.episodeId);
  const anchors = reset ? [] : (Array.isArray(learning.evidence) ? learning.evidence.slice() : []);
  if (evidence?.episodeId && !anchors.some((row) => row.episodeId === evidence.episodeId)) anchors.push(evidence);
  learning.supportedEpisodeIds = episodes.slice(-LIMITS.evidence);
  learning.evidence = anchors.slice(-LIMITS.evidence).map((row) => ({ ...row }));
  if (reset) {
    learning.evidenceResetAt = at;
    learning.evidenceResetReason = targetChanged ? 'target_changed' : 'spec_changed';
    delete learning.samples;
  }
  const sourceRefs = Array.isArray(evidence?.messageIds) ? evidence.messageIds : [];
  if (evidence?.episodeId || evidence?.sourceExcerpt || sourceRefs.length) {
    const excerpt = bounded(evidence?.sourceExcerpt || evidence?.excerpt || '', 160);
    const messageIds = (Array.isArray(evidence?.messageIds) ? evidence.messageIds : []).slice(-3).map((id) => bounded(id, 80));
    if (excerpt) learning.sourceExcerpt = excerpt;
    learning.sourceRefs = [...(Array.isArray(learning.sourceRefs) ? learning.sourceRefs : []), {
      excerpt,
      messageIds,
      episodeId: String(evidence?.episodeId || ''),
      feedbackType,
      at,
    }].slice(-LIMITS.evidence);
    learning.binding = {
      targetId: String(change?.id || existing?.id || 'new'),
      baseRevision: Number(existing?.revision || 0),
      messageIds,
      at,
    };
  }
  if (change?.currentText) learning.lastText = change.currentText;
  if (priorState === 'paused' && !reset && !Boolean(evidence?.explicitLongTerm)) {
    learning.state = 'paused';
    return learning;
  }
  if (priorState === 'paused') {
    delete learning.blockedReason;
    delete learning.pausedAt;
    delete learning.pausedBy;
  }
  const conditions = normalizeConditions(change?.conditions !== undefined ? change.conditions : existing?.conditions);
  const determinate = (change?.applicability || existing?.applicability) === 'conditional' && conditions.length > 0;
  const explicit = Boolean(evidence?.explicitLongTerm);
  if (explicit) learning.state = 'active';
  else if (priorState === 'active' && existing?.learning?.specDigest === specDigestOf({
    topicKey: change?.topicKey !== undefined ? change.topicKey : existing?.topicKey,
    body: change?.currentText !== undefined ? change.currentText : existing?.body,
    applicability: change?.applicability !== undefined ? change.applicability : existing?.applicability,
    conditions: change?.conditions !== undefined ? change.conditions : existing?.conditions,
  })) learning.state = 'active';
  else if (episodes.length >= 2) learning.state = 'active';
  else if (determinate && change?.feedbackType !== 'execution_miss') learning.state = 'trial';
  else if (priorState === 'trial' && existing?.learning?.specDigest === specDigestOf({
    topicKey: change?.topicKey !== undefined ? change.topicKey : existing?.topicKey,
    body: change?.currentText !== undefined ? change.currentText : existing?.body,
    applicability: change?.applicability !== undefined ? change.applicability : existing?.applicability,
    conditions: change?.conditions !== undefined ? change.conditions : existing?.conditions,
  })) learning.state = 'trial';
  else learning.state = 'pending';
  if (learning.state === 'trial') learning.trialUntil = new Date((now || Date.now()) + LIMITS.trialMs).toISOString();
  else delete learning.trialUntil;
  if (learning.state === 'active') {
    learning.acceptedAt = learning.acceptedAt || at;
    delete learning.trialUntil;
  }
  return learning;
}

/** 过期 pending 只是待复核失效，不销毁候选内容；可重新唤起。 */
export function candidateExpired(learning, now) {
  const at = now || Date.now();
  if (!learning || learning.state !== 'pending' || !learning.createdAt) return false;
  return at - Date.parse(learning.createdAt) > LIMITS.trialMs;
}

/** 只数还有效的 pending；过期候选不占名额。 */
export function pendingCount(entries, now) {
  const at = now || Date.now();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const learning = entry && entry.learning ? entry.learning : entry;
    return learning && learning.state === 'pending' && !candidateExpired(learning, at);
  }).length;
}

/** 重新唤起过期候选：换新的待确认窗口，但不伪造新的证据。 */
export function reviveCandidate(learning, { now } = {}) {
  if (!learning) return learning;
  const at = now || Date.now();
  const next = JSON.parse(JSON.stringify(learning));
  next.state = 'pending';
  next.createdAt = new Date(at).toISOString();
  next.updatedAt = next.createdAt;
  next.recoveredAt = next.createdAt;
  delete next.trialUntil;
  delete next.blockedReason;
  delete next.pausedAt;
  delete next.pausedBy;
  return next;
}

/**
 * 准入顺序：先算目标状态，再看上限。pending 满了不能挡住会直接变成 trial/active 的更新，
 * 已有规则的修订也永不因配额被挡。
 */
export function admitChange({ existing, change, evidence, now, explicitLongTerm = false, pending = 0, rules = 0 } = {}) {
  const merged = mergeChange(existing || null, change, { now });
  const learning = nextLearningState({
    existing: existing || { learning: merged.learning },
    change,
    evidence: { ...evidence, explicitLongTerm },
    specChanged: merged.specChanged === true,
    now,
  });
  const next = { merged, learning };
  if (existing) return { ok: true, ...next };
  if (Number(rules) + 1 > LIMITS.rules) return { ok: false, reason: '项目实验规则已经到上限' };
  if (learning.state === 'pending' && Number(pending) >= LIMITS.pending) return { ok: false, reason: '待确认候选已经到上限' };
  return { ok: true, ...next };
}

export function pauseLearning(learning, { by = 'feedback', reason = 'feedback_pending', now } = {}) {
  const next = learning ? JSON.parse(JSON.stringify(learning)) : { supportedEpisodeIds: [], evidence: [] };
  next.state = 'paused';
  next.blockedReason = reason;
  next.pausedBy = by;
  next.pausedAt = new Date(now || Date.now()).toISOString();
  return next;
}

export function resumeLearning(learning, { by = 'management', now } = {}) {
  const next = learning ? JSON.parse(JSON.stringify(learning)) : {};
  next.state = 'trial';
  delete next.blockedReason;
  delete next.pausedAt;
  delete next.pausedBy;
  next.revalidatedBy = by;
  next.updatedAt = new Date(now || Date.now()).toISOString();
  next.trialUntil = new Date((now || Date.now()) + LIMITS.trialMs).toISOString();
  return next;
}

/** 频次先在项目锁内扣，失败也计数；超限返回延后原因。 */
/**
 * 滚动窗口内的调用次数：以最近一次调用时间判断，不依赖 recent 数组；
 * 关开实验只清在途观察（recent），attempts 里的已用额度不会被开关重置。
 */
export function attemptWindowOf(learning, { now } = {}) {
  const at = now || Date.now();
  const ledger = learning && typeof learning === 'object' ? learning : {};
  const attempts = ledger.attempts && typeof ledger.attempts === 'object' ? ledger.attempts : {};
  const recent = (Array.isArray(ledger.recent) ? ledger.recent : [])
    .filter((value) => Number.isFinite(Date.parse(value)) && at - Date.parse(value) < LIMITS.windowMs);
  let calls = 0;
  let rows = 0;
  for (const row of Object.values(attempts)) {
    if (!row || typeof row !== 'object') continue;
    const lastAt = Date.parse(row.lastAt || '');
    /** 老数据没有时间戳时按仍在窗口内算，宁可少放一次也不放宽额度。 */
    if (Number.isFinite(lastAt) && at - lastAt >= LIMITS.windowMs) continue;
    calls += Number(row.count || 0);
    rows += 1;
  }
  return { at, recent: recent.length, rows, calls, projectCount: Math.max(recent.length, calls) };
}

export function quota(learning, { episodeId, now } = {}) {
  const window = attemptWindowOf(learning, { now });
  const attempts = learning && learning.attempts && typeof learning.attempts === 'object' ? learning.attempts : {};
  /** 项目层候选没有作品身份，store 用 project:<key> 记账：只受项目滚动额度约束。
   *  同一批反馈只算一次的职责在调用方（operationId 重放），不能拿“每期两次”把整个项目卡死。 */
  const projectScoped = !episodeId || String(episodeId).startsWith('project:');
  const episodeCount = projectScoped ? 0 : Number(attempts[episodeId]?.count || 0);
  if (!projectScoped && episodeCount >= LIMITS.attemptsPerEpisode) {
    return { ok: false, reason: 'episode_limit', episodeCount, projectCount: window.projectCount };
  }
  if (window.projectCount >= LIMITS.attemptsPerProject) {
    return { ok: false, reason: 'project_limit', episodeCount, projectCount: window.projectCount };
  }
  return { ok: true, episodeCount, projectCount: window.projectCount };
}

export function recordAttempt(learning, { episodeId, now } = {}) {
  const at = now || Date.now();
  const iso = new Date(at).toISOString();
  const next = learning ? JSON.parse(JSON.stringify(learning)) : { attempts: {}, recent: [], receipts: [] };
  next.attempts = next.attempts && typeof next.attempts === 'object' ? next.attempts : {};
  const row = next.attempts[episodeId] && typeof next.attempts[episodeId] === 'object' ? next.attempts[episodeId] : { count: 0 };
  row.count = Math.min(LIMITS.attemptsPerEpisode, Number(row.count || 0) + 1);
  row.lastAt = iso;
  next.attempts[episodeId] = row;
  next.recent = [...(Array.isArray(next.recent) ? next.recent : []), iso].filter((value) => at - Date.parse(value) < LIMITS.windowMs).slice(-32);
  next.receipts = Array.isArray(next.receipts) ? next.receipts.slice(-LIMITS.receipts) : [];
  return next;
}

/** usage 缺失就是未知，不补零；缓存与 reasoning 不机械相加。 */
export function usageOf(chunks) {
  let input = 0;
  let output = 0;
  let cached = 0;
  let known = false;
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const usage = chunk && chunk.type === 'usage' ? chunk.usage || chunk : null;
    if (!usage || typeof usage !== 'object') continue;
    const inputTokens = usage.inputTokens ?? usage.promptTokens;
    const outputTokens = usage.outputTokens ?? usage.completionTokens;
    if (typeof inputTokens === 'number') { input = inputTokens; known = true; }
    if (typeof outputTokens === 'number') { output = outputTokens; known = true; }
    if (usage.cachedInputTokens !== undefined) cached = Number(usage.cachedInputTokens) || 0;
  }
  return known ? { known: true, inputTokens: input, outputTokens: output, cachedInputTokens: cached } : { known: false };
}

export function receiptOf({ operationId, episodeId, status, changes, usage, at, reason } = {}) {
  return {
    operationId: String(operationId || ''),
    episodeId: String(episodeId || ''),
    status: String(status || ''),
    ...(reason ? { reason: String(reason) } : {}),
    changes: Number(changes || 0),
    ...(usage ? { usage } : {}),
    at: new Date(at || Date.now()).toISOString(),
  };
}

/** 最近回执就是效果摘要的来源；只报发生过的次数，未知用量不补零。 */
export function effectSummary(learning) {
  const rows = (Array.isArray(learning?.receipts) ? learning.receipts : []).slice(-LIMITS.receipts);
  const episodes = new Set();
  let applied = 0;
  let noChange = 0;
  let failed = 0;
  let knownCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    if (!row) continue;
    if (row.episodeId) episodes.add(row.episodeId);
    if (row.status === 'applied' || row.status === 'deleted' || row.status === 'undone') applied += 1;
    else if (row.status === 'no_change') noChange += 1;
    else failed += 1;
    if (row.usage && row.usage.known === true) {
      knownCalls += 1;
      inputTokens += Number(row.usage.inputTokens || 0);
      outputTokens += Number(row.usage.outputTokens || 0);
    }
  }
  return {
    window: rows.length,
    applied,
    noChange,
    failed,
    episodes: episodes.size,
    knownCalls,
    inputTokens: knownCalls ? inputTokens : null,
    outputTokens: knownCalls ? outputTokens : null,
  };
}

/** 到期的 trial/paused 按边界清理；过期 pending 只标可恢复，不销毁；active 与用户固定规范不走 TTL。 */
export function lifecycle(entries, now) {
  const at = now || Date.now();
  const purge = [];
  const paused = [];
  const recoverable = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const learning = entry?.learning;
    if (!learning || entry.origin !== 'project_evolution' || learning.pinned === true) continue;
    if (learning.state === 'pending' && candidateExpired(learning, at)) recoverable.push(entry.id);
    else if (learning.state === 'trial' && learning.trialUntil && at - Date.parse(learning.trialUntil) > 0) paused.push(entry.id);
    else if (learning.state === 'paused' && learning.pausedAt && at - Date.parse(learning.pausedAt) > LIMITS.pausedMs) purge.push(entry.id);
  }
  return { purge, paused, recoverable };
}
