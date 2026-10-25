import crypto from 'node:crypto';

/**
 * 任务锚点与请求快照的身份规则都在这里：纯函数，不摸盘、不调模型。
 * 无法确定时只留 unbound 作品壳；栏目默认必须由用户显式确认，不能按“只有一个”猜。
 */

export const ANCHOR_STATUSES = ['unbound', 'proposed', 'active', 'continuable', 'ambiguous', 'closed'];
export const TASK_LIMITS = { sessions: 8, episodes: 12, sourceMessages: 8, idleMs: 7 * 24 * 60 * 60 * 1000, indexBytes: 600 };

const SWITCH_WORDS = /(改做|换个|换一个|现在做|接下来做|新做|另做|开始做|去做|改成)/;
const CONTINUE_WORDS = /(再做一期|下一期|再来一期|再开一期|续一集|再拍一期)/;
const REVISE_WORDS = /(再改一下|改一版|再改改|调整一下|这版再|继续改)/;
const THANKS_WORDS = /^(谢谢|多谢|谢了|辛苦了|thanks|thank\s*you)[!！。.～~\s]*$/i;

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

function createEpisode(tasks, { taskKind, seriesId, phase, status, transitionId, previousEpisodeId, now }) {
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
  const changedSeries = registered.find((series) => series && series !== (current && current.seriesId) && query.includes(series));

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

  if (isContinuation(query) && current && currentEpisode) {
    const previousRevision = current.bindingRevision || 1;
    const transitionId = transitionIdFor(batchKey, previousRevision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    const episode = existing || createEpisode(tasks, {
      taskKind: currentEpisode.taskKind,
      seriesId: currentEpisode.seriesId,
      phase: 'brief',
      status: 'continuable',
      transitionId,
      previousEpisodeId: currentEpisode.episodeId,
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'continuable', bindingRevision: tasks.revision, now });
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
    /** 只有当前请求明确点到已登记的栏目才切过去；否则留无正文作品壳。 */
    const nextSeries = changedSeries || '';
    const transitionId = transitionIdFor(batchKey, tasks.revision);
    const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
    const episode = existing || createEpisode(tasks, {
      ...(nextSeries ? { seriesId: nextSeries } : {}),
      status: nextSeries ? 'proposed' : 'unbound',
      phase: 'brief',
      transitionId,
      previousEpisodeId: currentEpisode ? currentEpisode.episodeId : '',
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: episode.status, bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: nextSeries ? 'selected' : 'unbound', anchor, switched: true }, changed: true };
  }

  if (current && currentEpisode) {
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
      now,
    });
    const anchor = anchorOf(episode, { sessionId, batchKey, messageIds, status: 'active', bindingRevision: tasks.revision, now });
    tasks.sessions[sessionId] = anchor;
    return { tasks, anchor, episode, decision: { kind: 'default', anchor }, changed: true };
  }

  /** 新会话/新任务、无法确定栏目：只建无正文作品壳，不猜 taskKind/seriesId。 */
  const transitionId = transitionIdFor(batchKey, tasks.revision);
  const existing = Object.values(tasks.episodes).find((episode) => episode.transitionId === transitionId);
  const episode = existing || createEpisode(tasks, { status: 'unbound', phase: 'brief', transitionId, now });
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
      : { kind: 'clarify', reason: 'no_range' };
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
