import crypto from 'node:crypto';

/**
 * 任务锚点与请求快照的身份规则都在这里：纯函数，不摸盘、不调模型。
 * 无法确定时只留 unbound 作品壳；栏目默认必须由用户显式确认，不能按“只有一个”猜。
 */

export const ANCHOR_STATUSES = ['unbound', 'proposed', 'active', 'continuable', 'ambiguous', 'closed'];
export const TASK_LIMITS = { sessions: 8, episodes: 12, sourceMessages: 8, idleMs: 7 * 24 * 60 * 60 * 1000, indexBytes: 600 };

const SWITCH_WORDS = /(改做|改为|改到|改成|换个|换一个|换成|转到|现在做|接下来做|新做|另做|开始做|去做)/;
const CONTINUE_WORDS = /(继续|再做一期|下一期|再来一期|再开一期|续一集|再拍一期)/;
const REVISE_WORDS = /(再改一下|改一版|再改改|调整一下|这版再|继续改)/;
const THANKS_WORDS = /^(谢谢|多谢|谢了|辛苦了|thanks|thank\s*you)[!！。.～~\s]*$/i;
const REFERENCE_WORDS = /(这个|这条|这次|上次|之前|刚才|上面|前面|它|这里|继续|接着|还是|同样|再改)/;
const TASK_STOP = new Set(['一个','一下','这个','那个','我们','你们','他们','什么','怎么','可以','需要','帮我','帮忙','请问','然后','现在','还是','就是','没有','不是','以及','关于','进行','使用','问题','任务','内容','时候','已经','如果','因为','所以','但是','而且','或者','这些','那些','这样','那样','一下','一点','一些']);
/** 判断任务是否换了对象时，这些词只表示动作或指代，不算对象证据。 */
const TASK_NOISE = /(继续|再做一期|下一期|再来一期|再开一期|续一集|再拍一期|接着|然后|接下来|现在|帮我|帮忙|这个|这条|这次|上次|之前|刚才|上面|前面|下面|后面|这里|还是|同样|再改|排查|处理|检查|看看|看一下|看下|修复|解决|优化|调整|修改|分析|研究|对比|评估|调研|测试|设计|实现|开发|搭建|部署|定位|复现|查一下|找一下|问题|任务|内容|一下)/g;
/** 续接词后面还得跟一个动作，才算真正在改旧稿；单说「继续 / 这个 / 之前」不构成复用依据。 */
const CONTINUATION_ACTION = /(继续|接着|然后|再|还是|同样)\s*(做|改|调|弄|看|写|处理|优化|调整|检查|完成)/;
/** 明确指向刚才那一版作品的说法，是沿用旧范围的正面证据；「这版/那版」只是指示，不算旧稿。 */
const OLD_WORK_REFERENCE = /(刚才那版|之前那版|上一版|原稿|旧稿)/;
/** 旧稿被放下、否定或只作为话题提起时，不能因为它出现就恢复旧范围。 */
const OLD_WORK_PAUSE = /(先放着|放着|放一边|先不|先别|别管|不用管|搁置|暂停|不做了|先不做|不用了)/;
const OLD_WORK_ACTION = /(继续|接着|再改|改成|改一下|调整|优化|改改|开头|结尾|结构|节奏|语气|口吻|文案|措辞|细节|版本)/;
/** 创作类与工程类任务的默认判断不同；同一主题从写口播切到排查代码，不能沿用旧栏目。 */
const CONTENT_INTENT = /(口播|拍摄|录制|剪辑|文案|封面|字幕|直播|视频|选题|脚本|一期|栏目)/;
const ENGINEERING_INTENT = /(代码|排查|故障|部署|调试|重构|接口|数据库|查询|报错|日志|服务|环境|依赖|测试|配置|修复)/;
/** 这些词描述的是旧稿的某个方面，不是新对象；不该因为它们出现就撤销旧范围。 */
const ASPECT_NOISE = /(节奏|速度|风格|语气|口吻|结构|长度|时长|篇幅|配色|字号|字体|标题|文案|措辞|逻辑|细节|开头|结尾|过渡|画面|镜头|音乐|音效|字幕|参数|格式|排版)/g;
/** 程度、指代和虚词组成的二字片段不是对象证据。 */
const GENERIC_CHARS = /[再更稍很太挺点些快慢多少好坏大小高低长短早晚新旧一二三四五六七八九十百千万个把的得地了着过吗呢吧啊]/;
function taskTerms(value) {
  const plain = text(value, 200).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(ASPECT_NOISE, ' ').replace(TASK_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const terms = new Set();
  for (const word of plain.match(/[a-z][a-z0-9_-]{2,}/g) || []) terms.add(word);
  const runs = plain.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    if (TASK_STOP.has(run)) continue;
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (TASK_STOP.has(gram) || GENERIC_CHARS.test(gram)) continue;
      terms.add(gram);
    }
  }
  return terms;
}
/** 继承旧任务要有正面证据：新要求与本轮任务没有实质对象交集时，先按新任务处理。 */
export function looksLikeNewTask(query, previousText) {
  const current = text(query, 200);
  if (!current || isThanks(current)) return false;
  const next = taskTerms(current);
  const previous = taskTerms(previousText);
  const cue = isContinuation(current) || REFERENCE_WORDS.test(current);
  /** 只剩指代或续接词时，必须另有动作才算续接；否则宁可换任务也不沿用旧范围。 */
  if (!next.size) return cue ? !CONTINUATION_ACTION.test(current) : false;
  if (!previous.size) return false;
  /** 同一主题换了工作类型（口播 → 排查代码）是新任务，不靠对象词重叠判续作。 */
  const nextKind = CONTENT_INTENT.test(current) ? (ENGINEERING_INTENT.test(current) ? '' : 'content')
    : (ENGINEERING_INTENT.test(current) ? 'engineering' : '');
  const previousKind = CONTENT_INTENT.test(previousText) ? (ENGINEERING_INTENT.test(previousText) ? '' : 'content')
    : (ENGINEERING_INTENT.test(previousText) ? 'engineering' : '');
  if (nextKind && previousKind && nextKind !== previousKind) return true;
  for (const term of next) if (previous.has(term)) return false;
  /** 指向旧稿还要有继续改它的动作；「旧稿先放着」「这版数据库配置怎么改」都算新任务。 */
  if (OLD_WORK_REFERENCE.test(current) && !OLD_WORK_PAUSE.test(current) && OLD_WORK_ACTION.test(current)) return false;
  /**
   * 有实质对象词却跟旧任务没有任何交集：这就是新任务，不因为句首带了
   * 「继续」「这个」就把旧范围连同正文一起搬过来。继承只认对象交集、
   * 明确的旧稿指代，或者除动作/指代外没有新对象（上面两条）。
   */
  return true;
}

export function emptyTasks() {
  return { revision: 0, defaults: null, sessions: {}, episodes: {} };
}

function text(value, max = 120) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function isThanks(query) {
  return THANKS_WORDS.test(text(query, 40));
}

export function isContinuation(query) {
  return CONTINUE_WORDS.test(text(query, 160));
}

export function isRevision(query) {
  return REVISE_WORDS.test(text(query, 160));
}

const NEGATED_SERIES = /(不要|不用|别|不按|不照|不是|并非|先不|不做|不搞|忽略|跳过|不管|别提)[^，。；！？\n]{0,10}$/;
const MENTION_SERIES = /(日志|报错|错误|信息|提到|说到|包含|关键词|这个词|源码|代码|插件|文档|规则名|栏目名|分析)[^，。；！？\n]{0,10}$/;
const PAUSED_SERIES = /^(先放着|先放|放一边|先不做|不做了|不用了|暂停)/;
const PAUSED_BEFORE = /(先放着|先放|放一边|先不做|不做了|不用了|暂停)[^，。；！？\n]{0,4}$/;
/** 提到栏目名不等于选中它：否定、引用、看源码或「先放着」都只是话题，不能建绑定。 */
export function seriesChosenBy(query, series) {
  const value = text(query, 400);
  const name = text(series, 40);
  if (!value || !name) return false;
  let from = 0;
  while (from <= value.length) {
    const at = value.indexOf(name, from);
    if (at < 0) return false;
    const before = value.slice(Math.max(0, at - 14), at);
    const after = value.slice(at + name.length);
    if (!NEGATED_SERIES.test(before) && !MENTION_SERIES.test(before) && !PAUSED_BEFORE.test(before) && !PAUSED_SERIES.test(after)) return true;
    from = at + name.length;
  }
  return false;
}

export function requestBatchKey(messageIds) {
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map((id) => String(id || '')).filter(Boolean))].sort();
  if (!ids.length) return '';
  return `rb_${crypto.createHash('sha256').update(ids.join('\u0000')).digest('hex').slice(0, 16)}`;
}

function hash(value, chars = 12) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, chars);
}

export function transitionIdFor(batchKey, previousRevision = 0) {
  return `tr_${hash(`${batchKey}\u0000${Number(previousRevision) || 0}`)}`;
}

export function episodeIdFor(transitionId) {
  return `ep_${hash(`episode\u0000${transitionId}`)}`;
}

/** contextId 只在本请求内有效；前缀带项目摘要，跨项目一眼就能拒绝。 */
export function contextIdFor(projectId, batchKey, nonce) {
  return `ctx_${hash(`project\u0000${projectId}`, 8)}_${hash(`request\u0000${batchKey}\u0000${nonce || ''}`, 8)}`;
}

export function projectTagOf(contextId) {
  const match = /^ctx_([a-f0-9]{8})_/.exec(String(contextId || ''));
  return match ? match[1] : '';
}

export function projectTag(projectId) {
  return hash(`project\u0000${projectId}`, 8);
}

export function normalizeTasks(raw) {
  const base = emptyTasks();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const output = base;
  output.revision = Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
  if (raw.defaults && typeof raw.defaults === 'object') {
    const taskKind = text(raw.defaults.taskKind, 40);
    const seriesId = text(raw.defaults.seriesId, 40);
    const phase = text(raw.defaults.phase, 40);
    if (taskKind || seriesId || phase) {
      output.defaults = {
        ...(taskKind ? { taskKind } : {}),
        ...(seriesId ? { seriesId } : {}),
        ...(phase ? { phase } : {}),
        confirmedBy: 'user',
        confirmedAt: text(raw.defaults.confirmedAt, 40),
      };
    }
  }
  const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [sessionId, anchor] of Object.entries(sessions)) {
    if (!sessionId || !anchor || typeof anchor !== 'object') continue;
    const status = ANCHOR_STATUSES.includes(anchor.status) ? anchor.status : 'unbound';
    output.sessions[sessionId] = {
      episodeId: text(anchor.episodeId, 80),
      batchKey: text(anchor.batchKey, 40),
      ...(text(anchor.taskKind, 40) ? { taskKind: text(anchor.taskKind, 40) } : {}),
      ...(text(anchor.seriesId, 40) ? { seriesId: text(anchor.seriesId, 40) } : {}),
      ...(text(anchor.phase, 40) ? { phase: text(anchor.phase, 40) } : {}),
      status,
      bindingRevision: Number.isInteger(anchor.bindingRevision) && anchor.bindingRevision > 0 ? anchor.bindingRevision : 1,
      sourceMessageIds: (Array.isArray(anchor.sourceMessageIds) ? anchor.sourceMessageIds : []).map((id) => text(id, 120)).filter(Boolean).slice(0, TASK_LIMITS.sourceMessages),
      updatedAt: text(anchor.updatedAt, 40),
    };
  }
  const episodes = raw.episodes && typeof raw.episodes === 'object' ? raw.episodes : {};
  for (const [episodeId, episode] of Object.entries(episodes)) {
    if (!episodeId || !episode || typeof episode !== 'object') continue;
    output.episodes[episodeId] = {
      episodeId,
      ...(text(episode.taskKind, 40) ? { taskKind: text(episode.taskKind, 40) } : {}),
      ...(text(episode.seriesId, 40) ? { seriesId: text(episode.seriesId, 40) } : {}),
      ...(text(episode.phase, 40) ? { phase: text(episode.phase, 40) } : {}),
      status: ANCHOR_STATUSES.includes(episode.status) ? episode.status : 'unbound',
      transitionId: text(episode.transitionId, 80),
      previousEpisodeId: text(episode.previousEpisodeId, 80),
      ...(text(episode.taskText, 200) ? { taskText: text(episode.taskText, 200) } : {}),
      createdAt: text(episode.createdAt, 40),
      updatedAt: text(episode.updatedAt, 40),
    };
  }
  return pruneTasks(output);
}

/** 只保留最近的表和作品壳：项目状态有硬上限，读路径不能越用越肥。 */
export function pruneTasks(tasks, now = Date.now()) {
  const out = normalizeTasksShallow(tasks);
  const sessions = Object.entries(out.sessions)
    .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
    .slice(0, TASK_LIMITS.sessions);
  out.sessions = Object.fromEntries(sessions);
  const live = new Set(Object.values(out.sessions).map((anchor) => anchor.episodeId).filter(Boolean));
  const episodes = Object.entries(out.episodes)
    .filter(([id, episode]) => live.has(id) || now - Date.parse(episode.updatedAt || episode.createdAt || 0) < TASK_LIMITS.idleMs)
    .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
    .slice(0, TASK_LIMITS.episodes);
  out.episodes = Object.fromEntries(episodes);
  return out;
}

/** 防止 prune 调 normalize 无限递归；这里只做浅层结构复制。 */
function normalizeTasksShallow(raw) {
  const base = emptyTasks();
  if (!raw || typeof raw !== 'object') return base;
  base.revision = Number.isInteger(raw.revision) ? raw.revision : 0;
  base.defaults = raw.defaults && typeof raw.defaults === 'object' ? clone(raw.defaults) : null;
  base.sessions = raw.sessions && typeof raw.sessions === 'object' ? clone(raw.sessions) : {};
  base.episodes = raw.episodes && typeof raw.episodes === 'object' ? clone(raw.episodes) : {};
  return base;
}

export function focusOf(tasks, sessionId) {
  const normalized = normalizeTasks(tasks);
  return normalized.sessions[String(sessionId || '')] || null;
}

function episodeOf(tasks, episodeId) {
  return episodeId ? tasks.episodes[episodeId] || null : null;
}

function anchorOf(episode, { sessionId, batchKey, messageIds, status, bindingRevision, now }) {
  return {
    episodeId: episode.episodeId,
    ...(episode.taskKind ? { taskKind: episode.taskKind } : {}),
    ...(episode.seriesId ? { seriesId: episode.seriesId } : {}),
    ...(episode.phase ? { phase: episode.phase } : {}),
    status,
    bindingRevision,
    batchKey,
    sessionId,
    sourceMessageIds: [...messageIds].slice(0, TASK_LIMITS.sourceMessages),
    updatedAt: new Date(now).toISOString(),
  };
}

function createEpisode(tasks, { taskKind, seriesId, phase, status, transitionId, previousEpisodeId, taskText, now }) {
  const episodeId = episodeIdFor(transitionId);
  const at = new Date(now).toISOString();
  const episode = {
    episodeId,
    ...(taskKind ? { taskKind } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(phase ? { phase } : {}),
    status,
    transitionId,
    ...(previousEpisodeId ? { previousEpisodeId } : {}),
    ...(text(taskText, 200) ? { taskText: text(taskText, 200) } : {}),
    createdAt: at,
    updatedAt: at,
  };
  tasks.episodes[episodeId] = episode;
  tasks.revision += 1;
  return episode;
}

function touch(tasks, episode, patch, now) {
  const at = new Date(now).toISOString();
  Object.assign(episode, patch, { updatedAt: at });
  tasks.episodes[episode.episodeId] = episode;
  tasks.revision += 1;
}

/**
 * 依据可信批次与焦点决定本轮锚点。这里不读自由文本里的“可能栏目”，
 * 只认明确切换、已确认延续、已确认项目默认和前台选择过的 proposed。
 */
export function routeTask(tasksInput, input = {}) {
  const tasks = normalizeTasks(tasksInput);
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const sessionId = text(input.sessionId, 120);
  const query = text(input.query, 400);
  const messageIds = (Array.isArray(input.messageIds) ? input.messageIds : []).map((id) => text(id, 120)).filter(Boolean);
  const batchKey = input.batchKey || requestBatchKey(messageIds);
  const projectId = text(input.projectId, 240);
  if (!sessionId || !batchKey) return { tasks, anchor: null, episode: null, decision: { kind: 'none', reason: 'no_batch' }, changed: false };

  const current = tasks.sessions[sessionId] || null;
  const currentEpisode = episodeOf(tasks, current && current.episodeId);
  /** 同一批人类消息重试/重放：已有本轮结果就原样返回，不重复建 episode。 */
  if (current && current.batchKey === batchKey) {
    if (currentEpisode && currentEpisode.status !== 'unbound' && !input.selection) {
      return { tasks, anchor: current, episode: currentEpisode, decision: { kind: 'focus', anchor: current }, changed: false };
    }
    if (currentEpisode && currentEpisode.status !== 'unbound' && input.selection
      && (!input.selection.seriesId || currentEpisode.seriesId === input.selection.seriesId)) {
      return { tasks, anchor: current, episode: currentEpisode, decision: { kind: 'selected', anchor: current }, changed: false };
    }
    if (currentEpisode && currentEpisode.status === 'unbound' && !input.selection) {
      return { tasks, anchor: current, episode: currentEpisode, decision: { kind: 'unbound', anchor: current }, changed: false };
    }
  }
  const registered = (Array.isArray(input.registeredSeries) ? input.registeredSeries : []).map((item) => text(item, 40)).filter(Boolean);
  /** 用户在这句话里点名的栏目优先于旧栏目和项目默认值。 */
  const namedSeries = registered.find((series) => seriesChosenBy(query, series)) || '';
  const changedSeries = current && namedSeries && namedSeries !== (current.seriesId || '') ? namedSeries : '';
  const fallbackKind = (currentEpisode && currentEpisode.taskKind)
    || (input.defaults && input.defaults.taskKind) || '';

  if ((!current || current.status === 'unbound' || current.status === 'proposed') && input.selection && (input.selection.seriesId || input.selection.taskKind)) {
    const transitionId = transitionIdFor(batchKey, current ? current.bindingRevision || 0 : 0);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    /** 已有无正文作品壳时原地升级，不额外留一个作废的空集。 */
    const shell = !existing && current && currentEpisode && currentEpisode.status === 'unbound' && !currentEpisode.seriesId && !currentEpisode.taskKind;
    let episode;
    if (shell) {
      episode = currentEpisode;
      Object.assign(episode, {
        ...(input.selection.taskKind ? { taskKind: input.selection.taskKind } : {}),
        ...(input.selection.seriesId ? { seriesId: input.selection.seriesId } : {}),
        phase: input.selection.phase || 'brief',
      });
      touch(tasks, episode, { status: 'proposed' }, now);
    } else {
      episode = existing || createEpisode(tasks, {
        taskKind: input.selection.taskKind,
        seriesId: input.selection.seriesId,
        phase: input.selection.phase || 'brief',
        status: 'proposed',
        transitionId,
        taskText: query,
        now,
      });
    }
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'proposed', bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: 'selected', anchor }, changed: true };
  }

  if (isThanks(query)) {
    if (!current) return { tasks, anchor: null, episode: null, decision: { kind: 'none', reason: 'thanks' }, changed: false };
    return { tasks, anchor: current, episode: currentEpisode, decision: { kind: 'none', reason: 'thanks', pointer: true }, changed: false };
  }

  /** 先认新对象，再认续作：带「继续 / 这个」但换了对象，也必须撤销旧范围。
   *  本句点名了已登记栏目（「再做一期口播」）就是明确的对象证据，不算换任务。 */
  if (current && currentEpisode && currentEpisode.status !== 'unbound'
    && !SWITCH_WORDS.test(query) && !changedSeries && !namedSeries
    && looksLikeNewTask(query, currentEpisode.taskText || '')) {
    const transitionId = transitionIdFor(batchKey, tasks.revision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    const episode = existing || createEpisode(tasks, {
      status: 'unbound',
      phase: 'brief',
      transitionId,
      previousEpisodeId: currentEpisode.episodeId,
      taskText: query,
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'unbound', bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: 'unbound', anchor, reason: 'new_task' }, changed: true };
  }

  if (isContinuation(query) && current && currentEpisode) {
    const previousRevision = current.bindingRevision || 1;
    const transitionId = transitionIdFor(batchKey, previousRevision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    /** 「再做一期 Vlog」：继承上一期的任务类型，但栏目换成本句点名的那个。 */
    const seriesId = changedSeries || currentEpisode.seriesId || '';
    const status = changedSeries ? 'active' : 'continuable';
    const episode = existing || createEpisode(tasks, {
      ...(fallbackKind ? { taskKind: fallbackKind } : {}),
      ...(seriesId ? { seriesId } : {}),
      phase: 'brief',
      status,
      transitionId,
      previousEpisodeId: currentEpisode.episodeId,
      taskText: query,
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status, bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: 'continuation', anchor, inherited: currentEpisode }, changed: true };
  }

  if (isRevision(query) && current && currentEpisode) {
    touch(tasks, currentEpisode, { status: currentEpisode.status === 'proposed' ? 'proposed' : 'continuable' }, now);
    const anchor = anchorOf(currentEpisode, { sessionId, batchKey, messageIds, status: currentEpisode.status === 'proposed' ? 'proposed' : 'continuable', bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode: currentEpisode, decision: { kind: 'revision', anchor }, changed: true };
  }

  if (current && (SWITCH_WORDS.test(query) || changedSeries)) {
    /** 明确点到已登记的栏目就切过去并立即生效；只说「换个」没点栏目才留无正文作品壳。 */
    const nextSeries = changedSeries || '';
    const transitionId = transitionIdFor(batchKey, tasks.revision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    const status = nextSeries ? 'active' : 'unbound';
    const episode = existing || createEpisode(tasks, {
      ...(fallbackKind ? { taskKind: fallbackKind } : {}),
      ...(nextSeries ? { seriesId: nextSeries } : {}),
      status,
      phase: 'brief',
      transitionId,
      previousEpisodeId: currentEpisode ? currentEpisode.episodeId : '',
      taskText: query,
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status, bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: nextSeries ? 'selected' : 'unbound', anchor, switched: true }, changed: true };
  }

  /** 新会话或尚无有效栏目时，本句点名的已登记栏目直接生效，不被项目默认值覆盖。 */
  if (namedSeries && !changedSeries && (!current || current.status === 'unbound' || current.status === 'proposed')) {
    const transitionId = transitionIdFor(batchKey, tasks.revision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    const episode = existing || createEpisode(tasks, {
      ...(fallbackKind ? { taskKind: fallbackKind } : {}),
      seriesId: namedSeries,
      status: 'active',
      phase: 'brief',
      transitionId,
      taskText: query,
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'active', bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: 'selected', anchor, explicit: true }, changed: true };
  }

  if (current && currentEpisode) {
    /** 任务文本只作后续「是否换任务」的比对材料，不改锚点时间，免得把正在整理的这期作废。 */
    const nextTaskText = text(query, 200);
    if (nextTaskText && currentEpisode.taskText !== nextTaskText) {
      currentEpisode.taskText = nextTaskText;
      tasks.episodes[currentEpisode.episodeId] = currentEpisode;
    }
    const anchor = anchorOf(currentEpisode, {
      sessionId, batchKey, messageIds,
      status: currentEpisode.status,
      bindingRevision: current.bindingRevision || tasks.revision,
      now,
    });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode: currentEpisode, decision: { kind: 'focus', anchor }, changed: false };
  }

  const defaults = input.defaults || tasks.defaults;
  if (defaults && (defaults.seriesId || defaults.taskKind)) {
    const transitionId = transitionIdFor(batchKey, tasks.revision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    const episode = existing || createEpisode(tasks, {
      taskKind: defaults.taskKind,
      seriesId: defaults.seriesId,
      phase: 'brief',
      status: 'active',
      transitionId,
      taskText: query,
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'active', bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: 'default', anchor }, changed: true };
  }

  /** 新会话/新任务、无法确定栏目：只建无正文作品壳，不猜 taskKind/seriesId。 */
  const transitionId = transitionIdFor(batchKey, tasks.revision);
  const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
  const episode = existing || createEpisode(tasks, { status: 'unbound', phase: 'brief', transitionId, taskText: query, now });
  const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'unbound', bindingRevision: tasks.revision, now });
  tasks.sessions[sessionId] = anchor;
  return { tasks, anchor, episode, decision: { kind: 'unbound', anchor }, changed: true };
}

export function contextOfAnchor(anchor, base = {}) {
  return {
    ...base,
    ...(anchor && anchor.taskKind ? { taskKind: anchor.taskKind } : {}),
    ...(anchor && anchor.seriesId ? { seriesId: anchor.seriesId } : {}),
    ...(anchor && anchor.phase ? { phase: anchor.phase } : {}),
  };
}

/** 自动读取决策表：只有明确绑定才给正文；未绑定只给栏目索引。 */
export function decideRead(input = {}) {
  if (input.mode === 'off') return { kind: 'none', reason: 'mode_off' };
  if (input.enabled !== true) return { kind: 'none', reason: 'experiment_off' };
  if (input.identityConfirmed !== true) return { kind: 'none', reason: 'identity_unknown' };
  if (input.thanks) return { kind: 'none', reason: 'thanks', pointerOnly: true };
  if (input.conflict) return { kind: 'conflict', reason: 'conflict' };
  const anchor = input.anchor;
  if (!anchor || anchor.status === 'unbound') {
    const ranges = (Array.isArray(input.ranges) ? input.ranges : []).filter(Boolean).slice(0, 3);
    return ranges.length
      ? { kind: 'index', ranges, reason: 'unbound' }
      : { kind: 'none', reason: 'no_range' };
  }
  if (anchor.status === 'ambiguous') {
    const ranges = (Array.isArray(input.ranges) ? input.ranges : []).filter(Boolean).slice(0, 3);
    return { kind: 'index', ranges, reason: 'ambiguous' };
  }
  if (anchor.status === 'proposed' && input.boundForRequest !== true) {
    return { kind: 'index', ranges: (Array.isArray(input.ranges) ? input.ranges : []).filter(Boolean).slice(0, 3), reason: 'proposed' };
  }
  return { kind: 'rules', reason: 'bound' };
}

export function applySelection(tasksInput, { sessionId, selection, batchKey, messageIds, now = Date.now() }) {
  return routeTask(tasksInput, {
    sessionId,
    batchKey,
    messageIds,
    query: '',
    selection,
    now,
  });
}

export function setDefault(tasksInput, input = {}) {
  const tasks = normalizeTasks(tasksInput);
  const taskKind = text(input.taskKind, 40);
  const seriesId = text(input.seriesId, 40);
  const phase = text(input.phase, 40);
  if (!taskKind && !seriesId && !phase) {
    tasks.defaults = null;
    tasks.revision += 1;
    return tasks;
  }
  tasks.defaults = {
    ...(taskKind ? { taskKind } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(phase ? { phase } : {}),
    confirmedBy: 'user',
    confirmedAt: new Date(input.now || Date.now()).toISOString(),
  };
  tasks.revision += 1;
  return tasks;
}

export function closeSession(tasksInput, sessionId) {
  const tasks = normalizeTasks(tasksInput);
  const anchor = tasks.sessions[String(sessionId || '')];
  if (!anchor) return { tasks, changed: false };
  anchor.status = 'closed';
  anchor.updatedAt = new Date().toISOString();
  tasks.revision += 1;
  return { tasks, changed: true };
}
