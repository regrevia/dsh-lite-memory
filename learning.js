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
};

export const FEEDBACK_TYPES = ['spec_change', 'execution_miss', 'task_exception', 'aspect_accept', 'artifact_accept', 'unclear'];
export const LEARNING_STATES = ['pending', 'trial', 'active', 'paused'];
export const PHASES = ['brief', 'theme', 'outline', 'script', 'shoot', 'edit', 'publish'];
const ALLOWED_KEYS = new Set(['target', 'feedbackType', 'topicKey', 'currentText', 'title', 'summary', 'applicability', 'conditions', 'evidence', 'persistence']);

const LONG_TERM = /以后|今后|长期|默认|每次都|每次|一直|统一|永远|从现在起|记住/;
const EXPLICIT_ACCEPT = /可以了|就这样|这版|就用这版|用这版|挺好|满意|保留|沿用|继续用|定稿|通过/;
const ARTIFACT_ACCEPT = /这版可以|可以用这版|就这版|这版就用|定稿|这版通过/;
const DIMENSION = /字幕|开头|配色|节奏|配乐|镜头|标题|封面|结尾|转场|旁白|音效|画面/;
const EXCEPTION = /这次|这次就|本期|这期|这一期|这个作品|这一条|本篇|本视频/;
const NEGATIVE = /不要|不用|别用|别再|停用|取消这条|这条不要|不喜欢|去掉|删掉/;
const CORRECTION = /改成|改为|换成|重做|重来|再来|下次|不对|错了|不是这样|又没|怎么又|还是没|没按|不好|不行|不满意|不要|别/;
const EXECUTION_MISS = /之前说过|已经说过|不是说好|怎么又|又没|还是没|没按|又忘|重复/;
const UNCLEAR = /不太对|再想想|感觉不对|说不上|有点怪|不对劲/;

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

/** 只有已绑定作品的人类反馈才进入整理候选；初始任务要求本身不是纠正。 */
export function candidateFrom({ messages, anchor, sessionId, projectId, now } = {}) {
  if (!anchor || !anchor.episodeId) return null;
  if (!['active', 'continuable', 'proposed'].includes(anchor.status)) return null;
  const ids = [];
  const texts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.source?.kind !== 'user') continue;
    const text = view.messageText ? view.messageText(message) : messageText(message);
    if (!text) continue;
    ids.push(String(message.id ?? ''));
    texts.push(text);
  }
  if (!texts.length) return null;
  const text = texts.join('\n').slice(0, 1200);
  const cue = classifyFeedback(text);
  if (!cue.worth) return null;
  return {
    projectId,
    sessionId: String(sessionId || ''),
    episodeId: anchor.episodeId,
    taskKind: anchor.taskKind || '',
    seriesId: anchor.seriesId || '',
    phase: anchor.phase || '',
    messageIds: ids.filter(Boolean).slice(-8),
    text,
    cue,
    episodeUpdatedAt: anchor.updatedAt || '',
    at: now || Date.now(),
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

/** 构造一次受限调用输入：无工具、无前台历史，只有身份、少量规则和反馈映射。 */
export function buildCallInput({ projectId, episodeId, taskKind, seriesId, phase, feedback, rules, ranges, maxBytes = LIMITS.inputBytes } = {}) {
  const refs = { feedback: {}, rules: {} };
  const source = (Array.isArray(rules) ? rules : []).filter((record) => record && record.id);
  /** 用户这次纠正涉及的规则先入输入：固定取前 6 条会把真正相关的旧经验挤掉。 */
  const dimension = String(feedback?.cue?.dimension || '');
  const prioritized = dimension
    ? [...source.filter((record) => `${record.title || ''}${record.summary || ''}${record.body || ''}`.includes(dimension)),
      ...source.filter((record) => !`${record.title || ''}${record.summary || ''}${record.body || ''}`.includes(dimension))]
    : source;
  refs.feedback.u0 = feedback.messageIds[0] || '';
  const project = {
    projectId: bounded(projectId, 80),
    episodeId: bounded(episodeId, 80),
    ...(taskKind ? { taskKind } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(phase ? { phase } : {}),
  };
  const rangesInput = {
    taskKind: (ranges?.taskKinds || []).slice(0, 8),
    seriesId: (ranges?.series || []).slice(0, 8),
    phase: PHASES.slice(),
  };
  const system = '你是项目记忆整理器，只输出 JSON。只能依据给定反馈修改已有规则或新建一条项目规则；不得调用工具，不得输出 JSON 之外的文字。没有可确定的长期变化时输出 {"changes":[]}。';
  const feedbackHead = {
    type: feedback.cue?.type || 'unclear',
    longTerm: Boolean(feedback.cue?.explicitLongTerm),
  };
  const tail = {
    allowed: { conditions: view.CONDITION_KEYS, ranges: rangesInput, maxChanges: LIMITS.maxChanges, execution_miss: '仅已有规则，currentText 写检查点', artifact_accept: '仅已有规则，记验收样例' },
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
  return { system, prompt, messages: [{ role: 'user', content: prompt }], refs, rules: inputRules, bytes: Buffer.byteLength(system) + Buffer.byteLength(prompt) };
}
/** 严格解析：截断、工具调用、额外字段、超限都整批拒绝，不做第二次修复调用。 */
export function parseOutput(text, { finish, refs, rules, ranges } = {}) {
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
    const checked = validateChange(change, { refs, rules, ranges });
    if (!checked.ok) return checked;
    changes.push(checked.change);
  }
  return { ok: true, changes };
}

export function validateChange(change, { refs, rules, ranges } = {}) {
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
    for (const condition of conditions) {
      const allowed = conditionValueAllowed(condition, { ranges, existing });
      if (!allowed) return { ok: false, reason: '条件值不在本项目的栏目或阶段里' };
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

/** 状态只看证据强度：明确长期要求或两个独立作品才 active；条件不确定就 pending。 */
export function nextLearningState({ existing, change, evidence, now, specChanged = false } = {}) {
  const at = new Date(now || Date.now()).toISOString();
  const learning = existing?.learning ? JSON.parse(JSON.stringify(existing.learning)) : { state: 'pending', supportedEpisodeIds: [], evidence: [] };
  const priorState = LEARNING_STATES.includes(learning.state) ? learning.state : 'pending';
  /** 规范正文或适用条件变了：旧证据不再支持新规范，只保留本次这一条。 */
  const episodes = specChanged ? [] : (Array.isArray(learning.supportedEpisodeIds) ? learning.supportedEpisodeIds.slice() : []);
  if (evidence?.episodeId && !episodes.includes(evidence.episodeId)) episodes.push(evidence.episodeId);
  const anchors = specChanged ? [] : (Array.isArray(learning.evidence) ? learning.evidence.slice() : []);
  if (evidence?.episodeId && !anchors.some((row) => row.episodeId === evidence.episodeId)) anchors.push(evidence);
  learning.supportedEpisodeIds = episodes.slice(-LIMITS.evidence);
  learning.evidence = anchors.slice(-LIMITS.evidence).map((row) => ({ ...row }));
  learning.updatedAt = at;
  learning.lastFeedbackType = change?.feedbackType || learning.lastFeedbackType || '';
  if (change?.currentText) learning.lastText = change.currentText;
  if (priorState === 'paused' && !specChanged && !Boolean(evidence?.explicitLongTerm)) {
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
export function quota(learning, { episodeId, now } = {}) {
  const at = now || Date.now();
  const ledger = learning && typeof learning === 'object' ? learning : {};
  const attempts = ledger.attempts && typeof ledger.attempts === 'object' ? ledger.attempts : {};
  const recent = (Array.isArray(ledger.recent) ? ledger.recent : []).filter((value) => at - Date.parse(value) < LIMITS.windowMs);
  const episodeCount = Number(attempts[episodeId]?.count || 0);
  if (episodeCount >= LIMITS.attemptsPerEpisode) return { ok: false, reason: 'episode_limit', episodeCount, projectCount: recent.length };
  if (recent.length >= LIMITS.attemptsPerProject) return { ok: false, reason: 'project_limit', episodeCount, projectCount: recent.length };
  return { ok: true, episodeCount, projectCount: recent.length };
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

/** 到期的 trial/paused 按边界清理；active 与用户固定规范不走 TTL。 */
export function lifecycle(entries, now) {
  const at = now || Date.now();
  const purge = [];
  const paused = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const learning = entry?.learning;
    if (!learning || entry.origin !== 'project_evolution' || learning.pinned === true) continue;
    if (learning.state === 'pending' && learning.createdAt && at - Date.parse(learning.createdAt) > LIMITS.trialMs) purge.push(entry.id);
    else if (learning.state === 'trial' && learning.trialUntil && at - Date.parse(learning.trialUntil) > 0) paused.push(entry.id);
    else if (learning.state === 'paused' && learning.pausedAt && at - Date.parse(learning.pausedAt) > LIMITS.pausedMs) purge.push(entry.id);
  }
  return { purge, paused };
}
