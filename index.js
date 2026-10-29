import {
  scopeOf,
  globalScope,
  upsert,
  search,
  markUsed,
  readEntry,
  readLinks,
  forget,
  undoChange,
  locate,
  layersFor,
  runtimeLayers,
  findAnywhere,
  renderIndex,
  conflictsOf,
  resolveConflict,
  dropConflict,
  loadIndex,
  saveEntry,
  move,
  resumeMove,
  movePending,
  suggestionGate,
  noteSuggestion,
  acceptCandidate,
  rejectCandidate,
  recordCitations,
  listCitations,
  readCitationBody,
  readCitationBodyByTitle,
  locateByTitle,
  evolutionStatus,
  controlStatus,
  setMemoryEnabled,
  setMemoryControl,
  setRecallMode,
  isExperimentalRecord,
  setEvolution,
  taskState,
  saveTaskState,
  learningSnapshot,
  learningRulesForOrganizer,
  beginLearningAttempt,
  commitLearning,
  recordLearningFailure,
  pauseLearningRules,
  removeLearningRule,
  undoLearningChange,
  pinLearningRule,
  resumeLearningRule,
  adoptLearningRule,
  editLearningRule,
  expireLearning,
  LIMITS,
} from './store.js';
import path from 'node:path';
import crypto from 'node:crypto';
import * as view from './view.js';
import * as state from './state.js';
import * as anchor from './anchor.js';
import * as learning from './learning.js';

/** 开关路由在 apply 外，也要能中止在途整理。 */
const learningAborts = new Map();
/** 上次成功准备的记忆载荷字节数；只按会话记，重启后显示未知。 */
const payloadBytes = new Map();

/** Only the tool registry is required; everything else is optional. */
export const inject = ['tools'];

/** Model-facing contract. Kept short on purpose: this text is the only resident cost. */
const NOTES = [
  '记忆是历史笔记，不是用户本轮的要求。',
  '值得记：用户明确说「记住」的偏好、约定、踩过的坑、可复用流程，以及「去哪读 / 怎么调用」的指针。',
  '不记：常识、一次性任务参数、能从文件直接读到的正文、任何凭据的值，以及具体尺寸/字号/层级/颜色这类实现细节。',
  '凭据只记位置与调用方式，不记值。',
  '摘要写成名词短语，别写成指令。',
].join('');

function cwdOf(execution) {
  try {
    const agent = execution?.agent;
    const value = agent?.cwd ?? agent?.session?.header?.cwd ?? agent?.header?.cwd;
    if (typeof value === 'string' && value) return value;
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd();
}

/** 插件配置的默认触发方式，面板要按项目实际生效值显示。 */
let hostRecallMode = 'adaptive';

/** 本项目记忆总开关：读不出来时不擅自关掉，按开处理。 */
function memoryEnabled(scope) {
  try {
    return controlStatus(scope).enabled !== false;
  } catch {
    return true;
  }
}

/** 关着的原因决定下一步：恢复出来的状态要用户重新开启，而不是让人以为是自己关的。 */
function memoryOffCopy(scope) {
  try {
    return controlStatus(scope).recoveryPending
      ? '本项目记忆刚从损坏里恢复，需要你重新开启'
      : '本项目记忆已关闭，先在面板打开';
  } catch {
    return '本项目记忆已关闭，先在面板打开';
  }
}

function memoryEnabledFor(execution) {
  return memoryEnabled(scopeOf(cwdOf(execution)));
}

/** 总开关关掉时这组工具对模型不可见，也不接受执行。 */
const MEMORY_TOOLS = ['memory_save', 'memory_suggest', 'memory_search', 'memory_read', 'memory_forget'];

const REMOTE_PATH = '/lite-memory';

/** 引用的归属会话：界面上那句「N 条记忆引用」按它分开存。 */
function sessionIdOf(execution) {
  try {
    const id = execution?.agent?.session?.id;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求无法解析'));
      }
    });
    req.on('error', reject);
  });
}

/** 每个会话最近一次自动召回的判断依据；只留判断，不留正文。 */
const recallReceipts = new Map();

function noteRecall(scope, sessionId, receipt) {
  if (!scope || typeof sessionId !== 'string' || !sessionId) return;
  recallReceipts.set(`${scope.key}\u0000${sessionId}`, {
    at: new Date().toISOString(),
    reason: String(receipt.reason || ''),
    matched: Number(receipt.matched) || 0,
    cards: Number(receipt.cards) || 0,
    chars: Number(receipt.chars) || 0,
    limit: view.CARD.max,
    bytes: view.CARD.bytes,
  });
  while (recallReceipts.size > 64) recallReceipts.delete(recallReceipts.keys().next().value);
}

/** 投影没发出去就撤销回执：面板不能显示一条模型从没见过的提醒。 */
function clearRecall(scope, sessionId) {
  if (!scope || typeof sessionId !== 'string' || !sessionId) return;
  recallReceipts.delete(`${scope.key}\u0000${sessionId}`);
}

function recallReceiptOf(scope, sessionId) {
  if (!scope || typeof sessionId !== 'string' || !sessionId) return null;
  return recallReceipts.get(`${scope.key}\u0000${sessionId}`) || null;
}

/**
 * 桌面壳与本地 Web 是同一个界面：认 host 自己的 origin，也认 app 内建协议。
 */
function sameSurface(origin, selfOrigin) {
  if (typeof origin !== 'string' || origin.length === 0) return true;
  if (origin === selfOrigin) return true;
  return /^dsh-app:\/\/[A-Za-z0-9.-]+$/.test(origin);
}

/**
 * 「保留」「✕」的唯一入口。定位只认 id / candidateId，作用域由服务端按 id 查，
 * 不再从展示文案里解析标题或 [全局]。已处理的候选重放返回原回执。
 */
function keepHandler(webServer, cwdForSession) {
  return async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: '只接受 POST' });
    const origin = req.headers.origin;
    if (!sameSurface(origin, webServer.getOrigin())) {
      return sendJson(res, 403, { ok: false, reason: '来源不符' });
    }
    const pathname = String(req.url || '').split('?')[0];
    const action = pathname === REMOTE_PATH + '/undo' ? 'undo'
      : pathname === REMOTE_PATH + '/reject' ? 'reject'
        : pathname === REMOTE_PATH + '/keep' ? 'keep'
          : pathname === REMOTE_PATH + '/citations' ? 'citations'
            : pathname === REMOTE_PATH + '/body' ? 'body'
              : pathname === REMOTE_PATH + '/entry' ? 'entry'
              : pathname === REMOTE_PATH + '/move' ? 'move'
                : pathname === REMOTE_PATH + '/overview' ? 'overview'
                  : pathname === REMOTE_PATH + '/conflict' ? 'conflict'
                  : pathname === REMOTE_PATH + '/control' ? 'control'
                  : pathname === REMOTE_PATH + '/evolution' ? 'evolution'
                  : pathname === REMOTE_PATH + '/resume-move' ? 'resume-move' : '';
    if (!action) return sendJson(res, 404, { ok: false, reason: '未知操作' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '请求无法解析' });
    }

    /**
     * 正文按 id 现查当前层：引用是历史事实，正文必须给当前版本，不能吃缓存。
     * 只认本会话引用过的那条，或本工作目录这一层的条目；否则任意 id 都能读到别人的正文。
     */
    if (action === 'body') {
      const id = typeof body.id === 'string' ? body.id : '';
      /** 界面只有标题：按标题照样能读，id 留着兼容旧引用文件。 */
      const titleRef = typeof body.title === 'string' ? body.title.trim() : '';
      const revisionRef = Number.isInteger(body.revision) ? body.revision : undefined;
      if (!id && !titleRef) return sendJson(res, 400, { ok: false, reason: '缺少标题' });
      /** 找不到时只回调用方给的那个句柄：按 id 问就回 id，按标题问就回标题。 */
      const goneReply = () => sendJson(res, 200, titleRef
        ? { ok: true, status: 'gone', title: titleRef }
        : { ok: true, status: 'gone', id });
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey : '';
      const scopeRef = body.scope === 'global' || body.scope === 'project' ? body.scope : '';
      let found;
      if (scopeKey) {
        /**
         * 面板可以读枚举出来的项目层，但键必须来自服务端列表；
         * 不接受客户端拼路径，会话也只用来确认当前身份。
         */
        if (!cwdForSession(sessionId)) return sendJson(res, 409, { ok: false, reason: '这个会话还没有项目目录' });
        const listed = state.knownProjectScopes().find((row) => row.key === scopeKey);
        const target = scopeKey === 'global' ? globalScope()
          : listed ? { key: listed.key, dir: listed.dir, cwd: listed.cwd || '', requestedCwd: listed.cwd || '', rootSource: 'configured', confirmed: true }
            : null;
        if (!target) return sendJson(res, 404, { ok: false, reason: '没有这个项目' });
        const located = id ? locate(target, id, { readOnly: true })
          : locateByTitle(target, titleRef, { readOnly: true, revision: revisionRef });
        if (!located) return goneReply();
        found = {
          ...located.record,
          scope: located.scope.key === 'global' ? 'global' : 'project',
          scopeLabel: located.scope.key === 'global' ? '全局' : path.basename(located.scope.cwd || '') || located.scope.key,
          body: located.record.body,
        };
      } else if (sessionId) {
        try {
          found = id ? readCitationBody(sessionId, id)
            : readCitationBodyByTitle(sessionId, titleRef, { revision: revisionRef, scope: scopeRef });
        } catch {
          found = null;
        }
        /** 不在本会话引用里就当已消失：不给跨会话探正文，界面也只显示「已删除」。 */
        if (!found) return goneReply();
      } else if (cwd) {
        const located = id ? locate(scopeOf(cwd), id, { readOnly: true })
          : locateByTitle(scopeOf(cwd), titleRef, { readOnly: true, revision: revisionRef });
        if (!located) return goneReply();
        found = {
          ...located.record,
          scope: located.scope.key === 'global' ? 'global' : 'project',
          scopeLabel: located.scope.key === 'global' ? '全局' : path.basename(located.scope.cwd || '') || located.scope.key,
          body: located.record.body,
        };
      } else {
        return sendJson(res, 400, { ok: false, reason: '缺少来源' });
      }
      if (!found) return goneReply();
      /** 面板要分开「当前规范」和旧版本；历史只作可折叠对照，不拼进正文。 */
      const versions = Array.isArray(found.versions) ? found.versions
        : Array.isArray(found.history) ? found.history : [];
      const learning = found.learning && typeof found.learning === 'object' ? found.learning : {};
      const enums = new Set(['applied', 'unchanged', 'superseded', 'failed']);
      const processingStatus = enums.has(found.processingStatus) ? found.processingStatus
        : enums.has(learning.lastStatus) ? learning.lastStatus : '';
      return sendJson(res, 200, {
        ok: true,
        status: found.status,
        title: found.title,
        when: found.when || '',
        scope: found.scope,
        scopeLabel: found.scopeLabel || '',
        revision: found.revision,
        applicability: found.applicability || 'all_in_scope',
        conditions: Array.isArray(found.conditions) ? found.conditions : [],
        body: found.body,
        currentBody: typeof found.currentBody === 'string' ? found.currentBody : found.body,
        versions,
        sourceExcerpt: found.sourceExcerpt || learning.sourceExcerpt || '',
        sourceRefs: Array.isArray(found.sourceRefs) ? found.sourceRefs : (Array.isArray(learning.sourceRefs) ? learning.sourceRefs : []),
        evidence: found.evidence || (found.evidenceRef ? [found.evidenceRef] : []),
        evidenceRef: found.evidenceRef || '',
        processingStatus,
      });
    }

    /**
     * 面板改一条普通记忆：只改当前项目里的标题与正文，别层只读。
     * 必须带读到的版本，写前再对一次；中间被别人改过就拒绝，不覆盖。
     */
    if (action === 'entry') {
      const edit = typeof body.edit === 'string' ? body.edit : '';
      if (edit && edit !== 'save') return sendJson(res, 400, { ok: false, reason: '不认识这个操作' });
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      const cwd = typeof cwdForSession === 'function' ? cwdForSession(sessionId) : '';
      if (!cwd) return sendJson(res, 409, { ok: false, reason: '这个会话还没有项目目录' });
      const scope = scopeOf(cwd);
      if (!scope.confirmed) return sendJson(res, 409, { ok: false, reason: '项目根还没确认，先重新打开这个项目' });
      const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey : '';
      if (scopeKey && scopeKey !== scope.key) {
        return sendJson(res, 409, { ok: false, reason: '别的项目只读，回到那个项目里再改' });
      }
      if (!memoryEnabled(scope)) return sendJson(res, 409, { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' });
      const id = typeof body.id === 'string' ? body.id : '';
      const title = typeof body.title === 'string' ? body.title : '';
      const text = typeof body.body === 'string' ? body.body : '';
      const expectedRevision = Number(body.expectedRevision);
      if (!id) return sendJson(res, 400, { ok: false, reason: '缺少这条记忆' });
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        return sendJson(res, 409, { ok: false, reason: '这条记忆的版本不清楚，先刷新再改' });
      }
      if (!title.trim()) return sendJson(res, 400, { ok: false, reason: '标题不能为空' });
      /** 面板只让人确认「适用范围」这一件事实，不开放条件编辑；取值由 view 再校验。 */
      const applicability = typeof body.applicability === 'string' ? body.applicability : undefined;
      const conditions = Array.isArray(body.conditions) ? body.conditions : undefined;
      try {
        const result = saveEntry(scope, {
          id, title, body: text, expectedRevision, scope: 'project', origin: 'user_explicit',
          ...(applicability !== undefined ? { applicability } : {}),
          ...(conditions !== undefined ? { conditions } : {}),
        });
        if (!result || !result.record) {
          const reason = result && result.reasonCode === 'memory_disabled' ? '本项目记忆已关闭'
            : result && result.needsResolution ? '改动和另一条太像，先去那条上改'
              : '这次没有改动';
          return sendJson(res, 409, { ok: false, reason });
        }
        return sendJson(res, 200, { ok: true, title: result.record.title, revision: result.record.revision, changed: result.noop !== true });
      } catch (error) {
        const conflict = error && error.code === 'conflict';
        return sendJson(res, conflict ? 409 : 400, {
          ok: false,
          retry: conflict,
          reason: error instanceof Error ? error.message : '这次没有改动',
        });
      }
    }

    /**
     * 面板总览：当前会话项目、可切换的项目层与全局层，都从服务端枚举。
     * 只读；正文不进列表，点开单条再按 scopeKey 取。
     */
    if (action === 'overview') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      const cwd = typeof cwdForSession === 'function' ? cwdForSession(sessionId) : '';
      if (!cwd) return sendJson(res, 409, { ok: false, reason: '这个会话还没有项目目录' });
      const scope = scopeOf(cwd);
      if (!scope.confirmed) return sendJson(res, 409, { ok: false, reason: '项目根还没确认，先重新打开这个项目' });
      let currentState;
      try {
        currentState = state.load(scope).state;
      } catch (error) {
        return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '这个项目的记忆读不出来' });
      }
      const currentEvolution = (() => {
        try {
          return learningSnapshot(scope, { readOnly: true });
        } catch {
          return null;
        }
      })();
      const labelOf = (target) => target.key === 'global' ? '全局' : (path.basename(target.cwd || '') || target.key);
      const listed = state.knownProjectScopes();
      const scopes = listed.map((row) => ({
        key: row.key,
        kind: 'project',
        label: path.basename(row.cwd || '') || row.key,
        entries: row.entries,
        archived: row.archived,
        experimental: row.experimental,
        enabled: row.enabled,
        updatedAt: row.updatedAt,
      }));
      if (!scopes.some((row) => row.key === scope.key)) {
        const active = currentState.entries.filter((entry) => entry.status !== 'archived');
        scopes.unshift({
          key: scope.key,
          kind: 'project',
          label: labelOf(scope),
          entries: active.length,
          archived: currentState.entries.length - active.length,
          experimental: active.filter((entry) => isExperimentalRecord(entry)).length,
          enabled: currentState.experimental?.projectEvolution?.enabled === true,
          updatedAt: currentState.updatedAt || '',
        });
      }
      let globalState = null;
      try {
        globalState = state.load(globalScope()).state;
      } catch {
        globalState = null;
      }
      if (globalState) {
        const active = globalState.entries.filter((entry) => entry.status !== 'archived');
        scopes.push({
          key: 'global',
          kind: 'global',
          label: '全局',
          entries: active.length,
          archived: globalState.entries.length - active.length,
          experimental: 0,
          enabled: false,
          updatedAt: globalState.updatedAt || '',
        });
      } else {
        scopes.push({ key: 'global', kind: 'global', label: '全局', entries: 0, archived: 0, experimental: 0, enabled: false, updatedAt: '' });
      }
      const requested = typeof body.scopeKey === 'string' ? body.scopeKey : '';
      let selectedScope = scope;
      if (requested === 'global') selectedScope = globalScope();
      else if (requested) {
        if (requested === scope.key) selectedScope = scope;
        else {
          const row = listed.find((item) => item.key === requested);
          if (!row) return sendJson(res, 404, { ok: false, reason: '没有这个项目' });
          selectedScope = { key: row.key, dir: row.dir, cwd: row.cwd || '', requestedCwd: row.cwd || '', rootSource: 'configured', confirmed: true };
        }
      }
      let index;
      try {
        index = loadIndex(selectedScope, { readOnly: true });
      } catch (error) {
        return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '这个项目的记忆读不出来' });
      }
      const records = index.entries.filter((entry) => entry.status !== 'archived').map((record) => ({
        id: record.id,
        title: record.title || '',
        summary: record.summary || '',
        kind: record.kind || 'note',
        when: record.when || '',
        tags: Array.isArray(record.tags) ? record.tags.slice(0, 12) : [],
        topicKey: record.topicKey || '',
        triggers: Array.isArray(record.triggers) ? record.triggers.slice(0, 8) : [],
        applicability: record.applicability || 'all_in_scope',
        conditions: Array.isArray(record.conditions) ? record.conditions.slice(0, 8) : [],
        selection: record.selection || null,
        links: Array.isArray(record.links) ? record.links.slice(0, 24).map((link) => ({ type: link.type || 'related', id: link.id })) : [],
        revision: Number(record.revision) || 1,
        origin: originOut(record.origin),
        updated: record.updated || '',
        lastUsed: record.lastUsed || '',
        used: record.used === true,
        bytes: Number(record.bytes) || 0,
        experimental: isExperimentalRecord(record),
        learning: record.learning ? {
          state: record.learning.state || '',
          pinned: record.learning.pinned === true,
          samples: Array.isArray(record.learning.samples) ? record.learning.samples.length : 0,
          checkpoints: Array.isArray(record.learning.checkpoints) ? record.learning.checkpoints.length : 0,
          evidence: Array.isArray(record.learning.evidence) ? record.learning.evidence.length : 0,
          versions: Array.isArray(record.learning.versions) ? record.learning.versions.length : 0,
        } : null,
      }));
      const archives = Array.isArray(index.archived) ? index.archived : [];
      const archived = archives.slice(0, 80).map((record) => ({
        id: record.id,
        title: record.title || '',
        revision: Number(record.revision) || 1,
        updated: record.updated || '',
      }));
      const tags = new Set();
      let links = 0;
      for (const record of records) {
        for (const tag of record.tags) tags.add(tag);
        links += record.links.length;
      }
      const currentControl = (() => {
        try { return controlStatus(scope); } catch { return { enabled: true, epoch: '' }; }
      })();
      const modeOf = (target) => {
        try { return { effectiveMode: controlStatus(target).mode || hostRecallMode }; } catch { return { effectiveMode: hostRecallMode }; }
      };
      currentControl.effectiveMode = modeOf(scope).effectiveMode;
      const selectedControl = selectedScope.key === scope.key
        ? currentControl
        : (() => {
          try { return { ...controlStatus(selectedScope), ...modeOf(selectedScope) }; } catch { return { enabled: true, epoch: '', effectiveMode: recallMode() }; }
        })();
      const selectedEvolution = selectedScope.key === scope.key
        ? currentEvolution
        : (() => {
          try {
            return learningSnapshot(selectedScope, { readOnly: true });
          } catch {
            return null;
          }
        })();
      return sendJson(res, 200, {
        ok: true,
        current: { key: scope.key, label: labelOf(scope), control: currentControl, evolution: currentEvolution, recall: recallReceiptOf(scope, sessionId) },
        scopes,
        selected: {
          key: selectedScope.key,
          kind: selectedScope.key === 'global' ? 'global' : 'project',
          label: labelOf(selectedScope),
          updatedAt: records.reduce((latest, record) => record.updated > latest ? record.updated : latest, ''),
          control: selectedControl,
          evolution: selectedEvolution,
          records,
          archived,
          conflicts: conflictsOf(selectedScope),
          stats: {
            total: records.length,
            experimental: records.filter((record) => record.experimental).length,
            links,
            tags: tags.size,
            archived: archives.length,
          },
        },
      });
    }

    /** 待裁决：用队列里留下的草稿另存，或删掉这条待办；不预写、不替用户合并。 */
    if (action === 'conflict') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      const cwd = typeof cwdForSession === 'function' ? cwdForSession(sessionId) : '';
      if (!cwd) return sendJson(res, 409, { ok: false, reason: '这个会话还没有项目目录' });
      const projectScope = scopeOf(cwd);
      if (!projectScope.confirmed) return sendJson(res, 409, { ok: false, reason: '项目根还没确认，先重新打开这个项目' });
      /** 请求里的目标必须与当前会话项目一致；别的项目只读，不能借面板改过去。 */
      const requested = typeof body.scopeKey === 'string' ? body.scopeKey : '';
      if (!requested) return sendJson(res, 400, { ok: false, reason: '缺少目标范围' });
      if (requested !== 'global' && requested !== projectScope.key) {
        return sendJson(res, 409, { ok: false, reason: '别的项目只读，回到那个项目里再改' });
      }
      const target = requested === 'global' ? globalScope() : projectScope;
      /** 关闭的项目记忆不能从这个入口绕过；选全局时全局总开关也必须开着。 */
      if (!memoryEnabled(projectScope)) {
        return sendJson(res, 409, { ok: false, code: 'memory_disabled', reason: memoryOffCopy(projectScope) });
      }
      if (target.key === 'global' && !memoryEnabled(target)) {
        return sendJson(res, 409, { ok: false, code: 'memory_disabled', reason: '总记忆已关闭，先在面板打开' });
      }
      const op = body.op;
      if (op !== 'keep' && op !== 'drop') return sendJson(res, 400, { ok: false, reason: '不认识这个操作' });
      const conflictId = typeof body.conflictId === 'string' ? body.conflictId.trim() : '';
      if (!conflictId) return sendJson(res, 400, { ok: false, reason: '缺少这条待裁决' });
      const expectedRevision = Number(body.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        return sendJson(res, 409, { ok: false, reason: '这条待裁决的版本不清楚，先刷新再处理' });
      }
      try {
        const ref = { id: conflictId, expectedRevision };
        const outcome = op === 'drop' ? dropConflict(target, ref) : resolveConflict(target, ref);
        if (!outcome.ok) {
          return sendJson(res, outcome.reasonCode === 'stale_draft' ? 409 : 409, {
            ok: false, code: outcome.reasonCode || '', reason: outcome.reason || '这条待裁决还没处理成',
          });
        }
        return sendJson(res, 200, {
          ok: true,
          remaining: conflictsOf(target).length,
          record: outcome.record ? { id: outcome.record.id, title: outcome.record.title, revision: outcome.record.revision } : null,
        });
      } catch (error) {
        return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '待裁决处理失败' });
      }
    }

    /**
     * 本项目记忆总开关：关闭后这层不再召回、检索、读写、学习，也不继承全局记忆。
     * 自进化设置原样保留，但有效状态随总开关暂停。
     */
    if (action === 'control') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      const cwd = typeof cwdForSession === 'function' ? cwdForSession(sessionId) : '';
      if (!cwd) return sendJson(res, 409, { ok: false, reason: '这个会话还没有项目目录' });
      const scope = scopeOf(cwd);
      if (!scope.confirmed) return sendJson(res, 409, { ok: false, reason: '项目根还没确认，先重新打开这个项目' });
      const operationId = typeof body.operationId === 'string' ? body.operationId : '';
      try {
        const result = typeof body.enabled === 'boolean' || typeof body.mode === 'string'
          ? setMemoryControl(scope, {
            ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
            ...(typeof body.mode === 'string' ? { mode: body.mode } : {}),
          }, { operationId })
          : { ok: true, ...controlStatus(scope) };
        if (typeof body.enabled === 'boolean' && result && result.ok !== false && body.enabled === false) {
          const controller = learningAborts.get(scope.key);
          if (controller) {
            try { controller.abort(); } catch { /* already gone */ }
            learningAborts.delete(scope.key);
          }
        }
        return sendJson(res, result.ok === false ? 409 : 200, {
          ...result,
          project: path.basename(scope.cwd || '') || scope.key,
        });
      } catch (error) {
        return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '记忆开关没有改动' });
      }
    }

    /**
     * 项目实验开关：作用域只由服务端按 cwd 判，身份不确定就不写。
     * 不传 enabled 是查状态；传布尔才是切换，切换在项目锁里旋转 epoch。
     */
    if (action === 'evolution') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      const cwd = typeof cwdForSession === 'function' ? cwdForSession(sessionId) : '';
      if (!cwd) return sendJson(res, 409, { ok: false, confirmed: false, reason: '这个会话还没有项目目录' });
      const scope = scopeOf(cwd);
      if (!scope.confirmed) {
        return sendJson(res, 409, { ok: false, confirmed: false, reason: '项目根还没确认，先重新打开这个项目' });
      }
      const operationId = typeof body.operationId === 'string' ? body.operationId : '';
      const learningAction = typeof body.learningAction === 'string' ? body.learningAction : '';
      if (learningAction) {
        try {
          if (learningAction !== 'snapshot' && !memoryEnabled(scope)) {
            return sendJson(res, 409, { ok: false, code: 'memory_disabled', reason: '本项目记忆已关闭' });
          }
          if (learningAction === 'snapshot') {
            /** 查看不改盘：到期状态在写入事务里清理，读路径不写文件。 */
            const request = typeof body.sessionId === 'string' ? body.sessionId : '';
            return sendJson(res, 200, {
              ok: true,
              ...learningSnapshot(scope),
              payload: { bytes: request && payloadBytes.has(request) ? payloadBytes.get(request) : null },
            });
          }
          const id = typeof body.id === 'string' ? body.id : '';
          if (learningAction === 'undo') {
            const result = undoLearningChange(scope, id, {
              expectedRevision: Number(body.expectedRevision || 0),
              operationId: operationId || `undo_learn_${id}_${Date.now()}`,
            });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'pin') {
            const result = pinLearningRule(scope, id, {
              pinned: body.pinned === true,
              expectedRevision: Number(body.expectedRevision || 0),
              operationId: operationId || `pin_learn_${id}_${Date.now()}`,
            });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'adopt') {
            const result = adoptLearningRule(scope, id, {
              expectedRevision: Number(body.expectedRevision || 0),
              title: typeof body.title === 'string' ? body.title : '',
              body: typeof body.body === 'string' ? body.body : '',
              operationId: operationId || `adopt_learn_${id}_${Date.now()}`,
            });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'edit') {
            const result = editLearningRule(scope, id, {
              expectedRevision: Number(body.expectedRevision || 0),
              title: typeof body.title === 'string' ? body.title : '',
              body: typeof body.body === 'string' ? body.body : '',
              operationId: operationId || `edit_learn_${id}_${Date.now()}`,
            });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'pause') {
            const ids = Array.isArray(body.ids) ? body.ids.filter((value) => typeof value === 'string').slice(0, 12) : [];
            const result = pauseLearningRules(scope, ids, { operationId: operationId || `pause_learn_${Date.now()}`, by: 'management', reason: 'paused_by_user' });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'delete' || learningAction === 'discard') {
            const result = removeLearningRule(scope, id, {
              expectedRevision: Number(body.expectedRevision || 0),
              operationId: operationId || `delete_learn_${id}_${Date.now()}`,
            });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'resume') {
            const result = resumeLearningRule(scope, id, { operationId: operationId || `resume_learn_${id}_${Date.now()}` });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          return sendJson(res, 400, { ok: false, reason: '不认识这个操作' });
        } catch (error) {
          return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '这次没有改动' });
        }
      }
      try {
        const result = typeof body.enabled === 'boolean'
          ? setEvolution(scope, body.enabled, { operationId })
          : { ok: true, ...evolutionStatus(scope) };
        if (typeof body.enabled === 'boolean' && result && result.ok !== false) {
          const controller = learningAborts.get(scope.key);
          if (controller) {
            try { controller.abort(); } catch { /* already gone */ }
            learningAborts.delete(scope.key);
          }
        }
        return sendJson(res, result.ok === false ? 409 : 200, {
          ...result,
          project: path.basename(scope.cwd || '') || scope.key,
        });
      } catch (error) {
        return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '实验开关没有改动' });
      }
    }

    if (action === 'citations') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      return sendJson(res, 200, { ok: true, ...listCitations(sessionId) });
    }

    /** 面板只带会话：工作目录由会话身份查，客户端不用抄路径。 */
    const cwd = typeof body.cwd === 'string' && body.cwd
      ? body.cwd
      : (typeof body.sessionId === 'string' ? cwdForSession(body.sessionId) || '' : '');
    if (cwd.length === 0) return sendJson(res, 400, { ok: false, reason: '请求不完整' });
    const scope = scopeOf(cwd);
    const id = typeof body.id === 'string' ? body.id : '';
    const candidateId = typeof body.candidateId === 'string' && body.candidateId
      ? body.candidateId
      : typeof body.suggestionId === 'string' ? body.suggestionId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

    /** 总开关关闭时面板只能看：保留、拒绝、搬移、撤销都不落盘。 */
    if (!controlStatus(scope).enabled) {
      return sendJson(res, 409, { ok: false, reason: memoryOffCopy(scope), code: 'memory_disabled' });
    }

    if (action === 'move' || action === 'resume-move') {
      const operationId = typeof body.operationId === 'string' ? body.operationId : '';
      try {
        const done = action === 'resume-move'
          ? resumeMove(scope, { operationId })
          : move(scope, id, { target: body.target === 'global' ? 'global' : 'project', operationId });
        return sendJson(res, done.status === 'move_pending' ? 202 : 200, { ok: true, ...done });
      } catch (error) {
        const pending = (() => { try { return movePending(); } catch { return null; } })();
        return sendJson(res, 409, {
          ok: false,
          reason: error instanceof Error ? error.message : '搬移失败',
          pending: pending ? { operationId: pending.operationId } : null,
        });
      }
    }

    if (action === 'undo') {
      const undoTitle = typeof body.title === 'string' ? body.title.trim() : '';
      if (!id && !undoTitle) return sendJson(res, 400, { ok: false, reason: '缺少标题' });
      const located = id ? locate(scope, id)
        : locateByTitle(scope, undoTitle, { revision: Number.isInteger(body.revision) ? body.revision : undefined });
      if (!located) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
      /** 撤销是精确动作：必须带当时看到的版本；缺版本就不猜，免得撤掉别人后来的修改。 */
      if (!Number.isInteger(body.revision) || body.revision < 1) {
        return sendJson(res, 400, { ok: false, reason: '缺少版本' });
      }
      try {
        const undone = undoChange(scope, located.record.id, { expectedRevision: body.revision });
        if (!undone) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
        return sendJson(res, 200, { ok: true, title: undone.title, revision: undone.revision, mode: undone.mode });
      } catch (error) {
        return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '撤销失败' });
      }
    }

    if (action === 'reject') {
      if (!candidateId) return sendJson(res, 400, { ok: false, reason: '缺少 candidateId' });
      const dropped = rejectCandidate(scope, candidateId);
      return sendJson(res, dropped.ok ? 200 : 404, dropped);
    }

    if (!candidateId) return sendJson(res, 400, { ok: false, reason: '缺少 candidateId' });
    const operationId = typeof body.operationId === 'string' ? body.operationId : '';
    try {
      const kept = acceptCandidate(scope, candidateId, operationId);
      if (!kept.ok) {
        return sendJson(res, kept.reason === '候选与已有条目相近，需要确认' ? 409 : 404, kept);
      }
      if (kept.id) recordCitations(scope, sessionId, [{ id: kept.id, title: kept.title }]);
      return sendJson(res, 200, kept);
    } catch (error) {
      return sendJson(res, 409, { ok: false, reason: error instanceof Error ? error.message : '保存失败' });
    }
  };
}

/** 给界面的事件引用：只有定位与版次，不带正文，避免把维护字段当内容画出来。 */
/** 保存失败的统一回执：字段与成功回执同形，渲染只报这一次没写成。 */
function saveFailure(message, args) {
  return {
    title: String(args && args.title || '').trim(), summary: '', when: '', revision: 0,
    merged: false, changed: false, scope: '', needsResolution: false, needsScope: false,
    archived: '', error: String(message || '').replace(/^memory · /, ''),
  };
}

function originOut(value) {
  return value === 'project_evolution' || value === 'model_drafted' ? value : 'user_explicit';
}

function refsOf(hits) {
  return hits.map((item) => ({
    title: item.title || '',
    scope: item.scope || 'project',
    revision: item.revision || 1,
    status: item.status || 'ok',
    origin: originOut(item.origin),
    /** 界面要按类型分开展示（偏好/约定/流程/资料），维护字段不进正文。 */
    kind: typeof item.kind === 'string' && item.kind ? item.kind : 'note',
    when: typeof item.when === 'string' ? item.when : '',
    /** 界面要能说「N 天前更新」，只给时间不给正文。 */
    updated: typeof item.updated === 'string' ? item.updated : '',
  }));
}

const SAVE_PARAMS = {
  type: 'object',
  properties: {
    updateTitle: { type: 'string', description: '要更新的已有条目标题，原样抄搜索结果；同一件事更新时用，不新建' },
    title: { type: 'string', description: `标题，名词短语，≤${LIMITS.titleChars} 字；就是条目身份` },
    summary: { type: 'string', description: '一句话说明记的是什么，名词短语；超长自动截断' },
    body: { type: 'string', description: `正文 markdown，≤${LIMITS.entryBytes} 字节；只写原则、判断规则、触发条件和边界` },
    when: { type: 'string', description: `适用场景（哪台机器/什么环境/什么情况），≤${LIMITS.whenChars} 字；同标题不同 when 存两条；更新不给则保留` },
    kind: { type: 'string', enum: ['preference', 'convention', 'procedure', 'pointer', 'pitfall', 'credential_hint', 'note'], description: '条目类型；更新不给则保留' },
    tags: { type: 'array', items: { type: 'string' }, description: '最多 5 个标签；更新不给则保留' },
    supersedes: {
      type: 'string',
      description: '被取代的旧条目标题，原样抄搜索结果；同层有效，旧条目保留在历史',
    },
    resolution: {
      type: 'string',
      enum: ['distinct'],
      description: '确认「不是同一条」；仅当返回 needsResolution 且核对后确实不同时带上',
    },
    scope: { type: 'string', enum: ['auto', 'project', 'global'], description: '存哪层：auto（默认，按类别判定）/ project / global。只有用户明确说「所有项目」才 global；本机路径、端口、项目事实会降为项目层；仅本机成立的流程声明 machine/runtime 条件后可进全局' },
    memoryClass: { type: 'string', enum: ['personal_preference', 'project_fact', 'environment_fact', 'portable_procedure'], description: '归属提案：个人偏好/项目事实/设备事实/可搬流程；设备事实须带条件' },
    durability: { type: 'string', enum: ['durable', 'task'], description: 'durable（默认）或 task（一次性参数，拒绝落盘）' },
    evidenceRef: { type: 'string', description: '归属依据：哪条消息/文件/观察' },
    sameTopicAs: {
      type: 'object',
      description: '绑定已有主题槽位；标题对不上则报错不写',
      properties: {
        scope: { type: 'string', enum: ['project', 'global'] },
        title: { type: 'string' },
      },
      required: ['scope', 'title'],
      additionalProperties: false,
    },
    mode: {
      type: 'string',
      enum: ['patch', 'replace_current'],
      description: 'patch（默认，未给字段保留）或 replace_current（整条替换，须显式给 title/summary/when/body/kind/tags）',
    },
    applicability: {
      type: 'string',
      enum: view.APPLICABILITY,
      description: 'all_in_scope 普遍适用；conditional 须给 conditions；unresolved 还没定（默认）',
    },
    conditions: {
      type: 'array',
      description: '条件，最多 8 条；空数组表示清空',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: view.CONDITION_KEYS },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
    selection: {
      type: ['object', 'null'],
      description: '只对某产物成立：complete 清单完整（须 artifactKey），examples 仅举例；null 清空',
      properties: {
        mode: { type: 'string', enum: view.SELECTION_MODES },
        artifactKey: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'examples 的举例清单' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    links: {
      type: 'array',
      description: '相关条目，最多 3 条；目标须存在；空数组清空',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: view.LINK_TYPES, description: '默认 related' },
          title: { type: 'string', description: '被关联条目标题，原样抄搜索结果' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    triggers: {
      type: 'array',
      items: { type: 'string' },
      description: '自动召回触发词，最多 4 个；空数组清空',
    },
    topicKey: { type: ['string', 'null'], description: '主题槽位，去重用；null 清空' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
};

const SUGGEST_PARAMS = {
  ...SAVE_PARAMS,
  properties: Object.fromEntries(Object.entries(SAVE_PARAMS.properties).filter(([key]) => !['scope', 'id', 'updateTitle', 'resolution', 'memoryClass', 'durability', 'evidenceRef', 'sameTopicAs', 'supersedes', 'mode'].includes(key))),
};

const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要查的主题；用用户原话里的词，长句也行' },
    limit: { type: 'integer', minimum: 1, maximum: 4, description: '最多返回几条，默认 3' },
    history: { type: 'boolean', description: '连已归档的旧记录一起找；默认只看当前有效' },
    contextId: { type: 'string', description: '上一轮索引或工具结果给的任务上下文 id' },
    bindForRequest: { type: 'boolean', description: '把这次选择绑定为本请求的任务；有 contextId 时带上' },
  },
  required: ['query'],
  additionalProperties: false,
};

const READ_PARAMS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '记忆标题，来自搜索结果或召回卡' },
    view: { type: 'string', enum: ['full', 'links'], description: '默认 full 读正文；links 只看直接相关的记忆清单，不取正文' },
    scope: { type: 'string', enum: ['project', 'global'], description: '只在指定层解析标题；默认先当前项目再全局' },
    contextId: { type: 'string', description: '上一轮自动索引或工具结果给出的任务上下文 id；读实验规则时带上' },
  },
  additionalProperties: false,
};

const FORGET_PARAMS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '要忘掉的那条记忆的标题' },
    scope: { type: 'string', enum: ['project', 'global'], description: '只在指定层解析标题；默认先当前项目再全局' },
    mode: {
      type: 'string',
      enum: ['archive', 'purge'],
      description: 'archive 移入归档可找回（只是不想再提）；purge 彻底忘掉，正文与受管副本清除且不可复活。没点明是哪种就两种都别做，先问用户',
    },
  },
  additionalProperties: false,
};

/**
 * 按标题解析内部身份。对外仍只显示标题，但解析必须能说明「唯一 / 同层歧义 / 不存在」：
 * 同层同名是正常情况（不同前置条件各一条），静默取第一条会读错、写错。
 */
function titleHitsIn(target, title, { includeArchived = false } = {}) {
  let index;
  try { index = loadIndex(target); } catch { return []; }
  const rows = includeArchived ? (index.archived || []) : (index.entries || []);
  return rows.filter((entry) => entry && (includeArchived || entry.status !== 'archived')
    && String(entry.title || '').trim() === title);
}

function candidateNote(entry) {
  const conditions = Array.isArray(entry.conditions) ? entry.conditions.filter((row) => row && row.key) : [];
  const parts = [];
  if (entry.when) parts.push(String(entry.when));
  if (conditions.length) parts.push(conditions.map((row) => `${row.key}=${row.value}`).join('·'));
  return parts.join('，');
}

/** 同层同名时把候选条件一起报出来，模型/用户才能决定改哪条或先归档哪条。 */
function ambiguousTitleError(title, hits, label) {
  const detail = hits.slice(0, 4).map((entry) => {
    const note = candidateNote(entry);
    return note ? `「${title}」（${note}）` : `「${title}」`;
  }).join('、');
  return `${label}「${title}」有 ${hits.length} 条同名，无法确定是哪一条：${detail}。先归档其中一条，或换一个能区分的标题再试`;
}

/**
 * 标题解析失败时给几条相近的完整标题：上下文里常只剩缩短的标题，
 * 精确匹配失败就地列出候选，比让模型再猜一次省一轮。
 */
function nearTitleHints(targets, title) {
  const out = [];
  const seen = new Set();
  for (const target of targets) {
    let index;
    try { index = loadIndex(target); } catch { continue; }
    for (const entry of [...(index.entries || []), ...(index.archived || [])]) {
      const current = String(entry && entry.title || '').trim();
      if (!current || current === title || seen.has(current)) continue;
      if (!current.includes(title) && !title.includes(current)) continue;
      seen.add(current);
      out.push(current);
      if (out.length >= 3) return out;
    }
  }
  return out;
}

/**
 * 返回 { id } 或抛出：显式层只查那一层；默认先项目后全局（别的项目不参与解析）。
 * 同一层出现多条同名一律报歧义，绝不取第一条。
 */
function refIdOf(scope, args, label = '记忆') {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id) return id;
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) throw new Error(`要读或要忘一条${label}，先给标题`);
  /** 显式指定层时只解析那一层：同名条目不会被顺手改掉，项目层也不会命中全局。 */
  const explicit = args && args.scope === 'global' ? globalScope() : args && args.scope === 'project' ? scope : null;
  const sources = explicit ? [explicit] : runtimeLayers(scope);
  let crossLayerHit = null;
  for (const target of sources) {
    const hits = titleHitsIn(target, title);
    if (hits.length > 1) throw new Error(ambiguousTitleError(title, hits, label));
    if (hits.length === 1 && !crossLayerHit) crossLayerHit = hits[0];
  }
  if (crossLayerHit) return crossLayerHit.id;
  /** 忘掉已归档的条目也要能按标题解析到；归档不会因此重新参与召回。 */
  for (const target of sources) {
    const hits = titleHitsIn(target, title, { includeArchived: true });
    if (hits.length > 1) throw new Error(ambiguousTitleError(title, hits, label));
    if (hits.length === 1) return hits[0].id;
  }
  const near = nearTitleHints(sources, title);
  if (near.length) {
    throw new Error(`没有「${title}」这条${label}。相近的里有：${near.map((item) => `「${item}」`).join('、')}；用完整标题或 id 再试`);
  }
  throw new Error(`没有「${title}」这条${label}；先用 memory_search 对一下标题`);
}

/** 同名条目可能分布在项目层和全局层：更新前先报候选，不能先匹配。 */
function titleCandidates(scope, title) {
  const out = [];
  for (const target of runtimeLayers(scope)) {
    const hits = titleHitsIn(target, title);
    if (!hits.length) continue;
    if (hits.length > 1) out.push({ ambiguous: true, title, hits, scope: target.key === 'global' ? 'global' : 'project' });
    else out.push({ id: hits[0].id, scope: target.key === 'global' ? 'global' : 'project', note: candidateNote(hits[0]) });
  }
  return out;
}

/** 记忆归属标记：全局 `[global]`，项目用项目目录名（如 `[DSH]`）。 */
function projectNameOf(scope) {
  const base = scope && scope.cwd ? path.basename(scope.cwd) : '';
  return String(base || '').replace(/[^\w.\-\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16);
}

function scopeTag(value) {
  if (value && value.scope === 'global') return '[global]';
  if (value && value.scopeName) return `[${value.scopeName}]`;
  return '';
}

function withTag(value, text) {
  const tag = scopeTag(value);
  return tag ? `${tag} ${text}` : text;
}

/** 候选要能自己解释「什么时候的、为什么像」，模型才好判断是更新还是另一条。 */
function humanAge(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function describeCandidate(item, options = {}) {
  const age = humanAge(item.updated);
  const why = options.sameTopic ? '' : item.reason === 'similar_summary' ? '摘要相近' : '标题相近';
  const parts = [`「${item.title}」`];
  if (age) parts.push(`${age}更新`);
  if (item.when) parts.push(item.when);
  if (why) parts.push(why);
  if (item.summary) parts.push(item.summary);
  return parts.join(' · ');
}

function statusLabel(status) {
  if (status === 'archived') return ' · 已归档';
  if (status === 'needs_context') return ' · 适用范围待确认';
  if (status === 'not_applicable') return ' · 当前条件不适用';
  if (status === 'gone') return ' · 已删除';
  if (status && status !== 'ok') return ` · ${status}`;
  return '';
}

/**
 * 自动召回：用户这句话真跟已有记忆有关才给一张短卡，整条索引不常驻。
 * 策略、预算与冻结快照都在 apply 内部，provider 只读内存。
 */
export const RECALL_MODES = ['adaptive', 'tool_only', 'off'];
const RECALL_QUERY_CHARS = 400;
/** 单轮投影的耗时上限：慢机器上宁可这轮不注入，也不把回合拖住。测试可临时放宽。 */
let recallDeadlineMs = 150;
const RECALL_HEADER = '已有记忆可能相关（需要细节用 memory_read 带标题取正文，别凭标题猜）：';

/** 卡片只放够判断要不要读的几行；必要前提整条在场，装不下就整卡省略。 */
function renderRecallCard(card) {
  const tag = card.scope === 'global' ? '[global]' : card.scopeName ? `[${card.scopeName}]` : '';
  const parts = [`- ${tag ? `${tag} ` : ''}「${card.title}」`];
  if (card.summary) parts.push(`｜${card.summary}`);
  if (card.conditions && card.conditions.length) parts.push(`｜前提：${card.conditions.join('、')}`);
  if (card.selection) parts.push(`｜只适用于 ${card.selection}`);
  if (card.related) parts.push(`｜关联 ${card.related} 条`);
  return parts.join('');
}

export function apply(ctx, config) {
  const tools = ctx.tools;
  const getService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);

  /** 关掉记忆的会话看不到这组工具；每次进入新步骤前按当前开关同步一次。 */
  const hiddenTools = new WeakMap();
  const memoryOnForAgent = (agent) => {
    try {
      return memoryEnabled(scopeOf(cwdOf({ agent })));
    } catch {
      return true;
    }
  };
  const syncMemoryTools = (agent) => {
    const scoped = agent?.ctx?.tools;
    if (!scoped) return;
    const dispose = hiddenTools.get(agent);
    if (memoryOnForAgent(agent)) {
      if (!dispose) return;
      hiddenTools.delete(agent);
      try { dispose(); } catch { /* scope already gone */ }
      return;
    }
    if (dispose) return;
    try { hiddenTools.set(agent, scoped.restrict({ deny: MEMORY_TOOLS })); } catch { /* no global tools to mask */ }
  };

  /* ---------------- 自动召回：策略、冻结快照、任务窗口与请求预算 ---------------- */

  /** 升级不覆盖用户的选择：默认 adaptive，别的模式只由明确配置切换。 */
  const recallMode = () => (RECALL_MODES.includes(config?.mode) ? config.mode : 'adaptive');
  hostRecallMode = recallMode();
  /** 项目自己的选择优先；没有写过就跟随插件配置，升级不改用户选择。 */
  const modeFor = (scope) => {
    try {
      const mode = controlStatus(scope).mode;
      return RECALL_MODES.includes(mode) ? mode : recallMode();
    } catch {
      return recallMode();
    }
  };
  /** 已准备好的快照只挂在 Agent 上，弱引用随手回收，不跨会话串。 */
  const prepared = new WeakMap();
  /** 最近一次请求的任务身份：本轮没注入任何内容时 prepared 会清掉，补查仍需要知道上一轮任务。 */
  const lastTask = new Map();
  /** 任务本身也要独立于 prepared：轮次收尾只清投影，不把「刚才在做什么」一起清掉。 */
  const recallTasks = new Map();
  /** turn-stopping 只回 signal，不带头 agent；这里记 signal → agent 供收尾清理。 */
  const signalAgents = new Map();
  const generations = new WeakMap();
  /** 同一真人请求共用一个额度窗口；provider 只读，不记账。 */
  const windows = new Map();
  const abortCleanups = new Map();
  /** 哪些用户消息已经建立过窗口；工具续步不重复开窗。 */
  const seenHumans = new Map();
  /** 本轮真人反馈先记在这里，等 turn/end 再决定要不要整理；不跨会话。 */
  const feedbackCandidates = new Map();
  /** 项目内反馈代次：每来一次新的可整理反馈就加一，旧整理结果必须作废。 */
  const feedbackRevisions = new Map();
  /** 一个项目同一时间只整理一次；控制器放在模块级供开关路由中止。 */
  const learningJobs = new Map();

  const agentKey = (agent) => String(agent?.id ?? '');

  /** 回合收尾/换请求时批量记账：一次锁，不在 provider 输出路径上。 */
  const flushUsage = (state) => {
    if (!state || !state.scope || !(state.deliveredIds instanceof Set) || state.deliveredIds.size === 0) return;
    const ids = [...state.deliveredIds].filter(Boolean);
    state.deliveredIds = new Set();
    if (!ids.length) return;
    try { markUsed(state.scope, ids); } catch { /* usage is best-effort */ }
  };

  const clearPrepared = (agent) => {
    if (!agent) return;
    const state = prepared.get(agent);
    if (state && state.signal) signalAgents.delete(state.signal);
    flushUsage(state);
    prepared.delete(agent);
    const key = agentKey(agent);
    const cleanup = key ? abortCleanups.get(key) : null;
    if (cleanup) {
      abortCleanups.delete(key);
      try { cleanup(); } catch { /* listener already gone */ }
    }
  };

  const windowOf = (agent) => windows.get(agentKey(agent)) || null;

  /** 自动注入账本：普通段与实验段共用 3 条 / 1200 字节，量的是拼接后的完整文本。 */
  const emptyAutoBudget = () => ({
    normalText: '', experimentText: '',
    normalCards: 0, experimentCards: 0,
    cards: 0, cardBytes: 0, experimentBytes: 0, totalBytes: 0,
  });


  /** 预算按规范化 JSON 字节算：转义、中文、换行都算进模型真正收到的内容。 */
  const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

  function affordable(win, bytes, bodies = 0) {
    if (!win) return true;
    if (win.reads >= view.REQUEST_LIMITS.reads) return false;
    if (bodies && win.bodies + bodies > view.REQUEST_LIMITS.bodies) return false;
    return win.bytes + bytes <= view.REQUEST_BYTES;
  }

  /**
   * 工具自己取的记忆另算一笔：自动注入已经用满时，模型按标题来读正文不该被连带挡掉，
   * 否则用户看到的就是「额度已用完」这种没法处理的死路。
   */
  function affordableTool(win, bytes, bodies = 0) {
    if (!win) return true;
    if (win.reads >= view.REQUEST_LIMITS.reads) return false;
    if (bodies && win.bodies + bodies > view.REQUEST_LIMITS.bodies) return false;
    return (win.toolBytes || 0) + bytes <= view.TOOL_BYTES;
  }

  /** 续写轮没有新消息：沿用上一次能核对的请求上下文。 */
  const lastRuntime = new Map();
  const rememberRuntime = (scope, sessionId, held) => {
    if (!held || !sessionId) return;
    const key = `${scope.key}\u0000${sessionId}`;
    lastRuntime.delete(key);
    lastRuntime.set(key, held);
    if (lastRuntime.size > 20) lastRuntime.delete(lastRuntime.keys().next().value);
  };

  function openWindow(agent, { sessionId, turn, messageIds }) {
    const key = agentKey(agent);
    if (!key) return null;
    const signature = `${sessionId}\u0000${turn}\u0000${messageIds.join(',')}`;
    const existing = windows.get(key);
    if (existing && existing.signature === signature) return existing;
    const next = {
      signature, sessionId, turn, messageIds,
      bytes: 0, bodies: 0, reads: 0, toolBytes: 0,
      provided: new Map(), readBodies: new Map(), at: Date.now(),
      experiment: null, contexts: new Map(), runtime: null, autoBudget: null,
    };
    windows.set(key, next);
    return next;
  }

  /** 新消息才会建立新窗口；同一批消息在同一 turn 里只开一次。 */
  function freshHumans(sessionId, humans) {
    if (!humans.length) return [];
    const seen = seenHumans.get(sessionId) || new Set();
    const fresh = humans.filter((message) => {
      const id = String(message?.id ?? '');
      return id && !seen.has(id);
    });
    for (const message of humans) {
      const id = String(message?.id ?? '');
      if (id) seen.add(id);
    }
    while (seen.size > 400) seen.delete(seen.values().next().value);
    seenHumans.set(sessionId, seen);
    while (seenHumans.size > 64) seenHumans.delete(seenHumans.keys().next().value);
    return fresh;
  }

  /** 两层都算：任何一层换库、换代或清空，之前准备的卡片都要失效。 */
  /**
   * 同一请求的召回快照只要内容没变就保持原样：命中次数、使用时间这类使用记录
   * 不参与指纹，否则模型多读一次就会触发重投影。真正改变应看条目内容版本、
   * 启停/控制代号与自进化代号。
   */
  function fingerprintOf(scope) {
    try {
      return [scope, globalScopeView()].map((source) => {
        const index = loadIndex(source);
        const meta = index.__meta || {};
        const evolutionEpoch = index.__evolution && index.__evolution.epoch ? index.__evolution.epoch : '';
        const controlEpoch = index.__control && index.__control.epoch ? index.__control.epoch : '';
        const content = (index.entries || [])
          .map((entry) => `${entry.id}:${entry.revision || 1}:${entry.status || 'active'}:${entry.updated || ''}:${entry.topicKey || ''}`)
          .sort()
          .join(',');
        return `${index.scope}:${meta.storeId || ''}:${evolutionEpoch}:${controlEpoch}:${content}`;
      }).join('|');
    } catch {
      return '';
    }
  }

  const globalScopeView = () => globalScope();

  /** 纯内存：读两层当前投影，先判适用再排序，整卡装预算。 */
  function projectRecall(scope, query, context, win, runtime) {
    context = view.contextWithTask(context, runtime && runtime.task);
    const layers = { project: [], global: [] };
    const seen = new Set();
    for (const source of [scope, globalScope()]) {
      const layer = source.key === 'global' ? 'global' : 'project';
      let index;
      try { index = loadIndex(source); } catch { continue; }
      for (const item of index.entries) {
        if (!item || !item.title || item.status === 'archived') continue;
        /** 生命周期先于主题裁决：过期/被取代的条目不再参与分组，不能把现行条目标成冲突。 */
        if (view.lifecycleStatusOf(item)) continue;
        /** 实验来源只走任务绑定后的专用读取，不混进普通自动召回。 */
        if (item.origin === 'project_evolution') continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        layers[layer].push(item);
      }
    }
    /** 同一槽位只让胜出的规范进去；冲突或条件未知的整组不进自动召回。 */
    const groups = [...view.resolveTopics(layers.project, layers.global, context).values()];
    const records = [];
    const layerOf = new Map();
    for (const group of groups) {
      if (group.status !== 'ok' || !group.record) continue;
      records.push(group.record);
      layerOf.set(group.record.id, group.scope === 'global' ? 'global' : 'project');
    }
    const gateRuntime = runtime || (win && win.runtime) || null;
    const task = runtime && runtime.task ? runtime.task : null;
    const ranked = view.rank(records, query, {
      limit: 8, requireApplicable: true, context, runtime: gateRuntime, task,
    });
    /** 普通记忆与实验规则共用一份自动注入预算：总条数和最终完整文本字节一起算。 */
    const auto = win && win.autoBudget ? win.autoBudget : null;
    /** 卡片上限含包装；共享请求账本也要把标题行算进去，不能只算卡片行。 */
    let headerCharged = win ? win.recallHeader === true : false;
    const lines = [];
    const linesMeta = [];
    const cards = [];
    for (const row of ranked) {
      const usedCards = cards.length + (auto ? (auto.experimentCards || 0) : 0);
      if (usedCards >= view.CARD.max) break;
      const card = view.cardOf(row.record, layerOf.get(row.record.id));
      if (card.scope === 'project') card.scopeName = projectNameOf(scope);
      const line = renderRecallCard(card);
      const nextText = `${RECALL_HEADER}\n${[...lines, line].join('\n')}`;
      if (auto) {
        /** 实验段可能先渲染：组装成最终两段再量，超了就跳过这张，不把标题留在模型侧。 */
        const admitted = admitAuto(win, {
          normal: nextText,
          experiment: auto.experimentText || '',
          normalCards: cards.length + 1,
          experimentCards: auto.experimentCards || 0,
        });
        if (!admitted.ok) continue;
      } else {
        const size = Buffer.byteLength(nextText);
        if (size > view.CARD.bytes) continue;
        const cost = Buffer.byteLength(`\n${line}`) + (headerCharged ? 0 : Buffer.byteLength(RECALL_HEADER));
        if (win && !affordable(win, cost)) continue;
        if (win) win.bytes += cost;
      }
      const revision = card.revision || 1;
      if (win) win.provided.set(card.id, revision);
      if (win && !headerCharged) {
        headerCharged = true;
        win.recallHeader = true;
      }
      lines.push(line);
      cards.push({ id: card.id, revision, scope: card.scope, title: card.title });
      /** 卡片行与到期时间一起留到最后输出：中间隔了系统提示组装，不能拿投影时的判断当现在。 */
      linesMeta.push({ id: card.id, line, validUntil: row.record.validUntil || '' });
    }
    const finalText = `${RECALL_HEADER}\n${lines.join('\n')}`;
    if (auto) {
      /** 没有任何普通卡片时也要把已有实验段记账成当前状态。 */
      admitAuto(win, {
        normal: lines.length ? finalText : (auto.normalText || ''),
        experiment: auto.experimentText || '',
        normalCards: cards.length,
        experimentCards: auto.experimentCards || 0,
      });
    }
    /** 没卡片也要给出判断依据：面板要能回答「为什么这次没提醒我」。 */
    let near = [];
    if (!cards.length && !ranked.length) {
      /** 自动召回只认完全适用；再放宽一层看有没有字面匹配，好把「条件未确认」和「没有匹配」分开。 */
      near = view.rank(records, query, {
        limit: 8, requireApplicable: false, context, runtime: gateRuntime, task,
      });
    }
    let waiting = near.some((row) => row.status !== 'ok' || row.record.reviewState === 'legacy_unreviewed');
    let nearMatched = near.length;
    /** 冲突与「条件未确认」是两种原因：前者要人先裁决，后者只差一句任务说明。 */
    let conflictNear = false;
    if (!cards.length && !ranked.length) {
      /** 整组被条件或冲突挡下的候选没进 records，单独按同一查询算；只计数，不投放。 */
      for (const group of groups) {
        if (group.status !== 'conflict' && group.status !== 'needs_context') continue;
        const hits = view.rank(group.records || [], query, {
          limit: 1, requireApplicable: false, context, runtime: gateRuntime, task,
        });
        if (!hits.length) continue;
        waiting = true;
        if (group.status === 'conflict') conflictNear = true;
        nearMatched += hits.length;
      }
    }
    const reason = cards.length ? 'hit'
      : ranked.length ? 'budget'
        : conflictNear ? 'conflict'
          : waiting ? 'needs_context'
            : (gateRuntime && gateRuntime.enabled ? 'no_overlap' : 'needs_context');
    const matched = ranked.length || nearMatched;
    const ids = cards.map((card) => card.id).filter(Boolean);
    if (!cards.length) return { text: '', cards: [], lines: [], ids, bytes: 0, query, reason, matched };
    return { text: finalText, cards, lines: linesMeta, ids, bytes: Buffer.byteLength(finalText), query, reason, matched };
  }

  /* ---------------- 项目自进化：任务锚点、读取决策、上下文解析 ---------------- */

  const EXPERIMENT_INDEX_HEADER = '项目里这些记忆范围可能适用当前任务（未绑定）；需要细节再用 memory_search 带上 contextId：';
  const EXPERIMENT_RULES_HEADER = '项目实验规则（只在当前任务条件匹配时适用；细节用 memory_read 取正文，别凭标题猜）：';
  const EXPERIMENT_BYTES = 1200;
  const EXPERIMENT_SHORT_CHARS = 240;

  /** 登记过的栏目只能来自项目里已有的条件、默认值和实验条目，不从自由措辞里新造。 */
  function rangesOf(scope) {
    let index;
    try { index = loadIndex(scope); } catch { return { series: [], taskKinds: [], taskKind: '', seriesId: '' }; }
    const series = [];
    const taskKinds = [];
    const add = (list, value) => {
      const text = typeof value === 'string' ? value.trim().slice(0, 40) : '';
      if (text && !list.includes(text) && list.length < 8) list.push(text);
    };
    for (const record of [...index.entries, ...index.archived]) {
      if (record.reviewState === 'legacy_unreviewed') continue;
      for (const condition of record.conditions || []) {
        if (condition.key === 'seriesId') add(series, condition.value);
        if (condition.key === 'taskKind') add(taskKinds, condition.value);
      }
      const learning = record.learning || {};
      if (learning.seriesId) add(series, learning.seriesId);
      if (learning.taskKind) add(taskKinds, learning.taskKind);
    }
    const defaults = index.__tasks && index.__tasks.defaults ? index.__tasks.defaults : null;
    if (defaults) {
      add(series, defaults.seriesId);
      add(taskKinds, defaults.taskKind);
    }
    return {
      series, taskKinds,
      seriesId: defaults && defaults.seriesId ? defaults.seriesId : '',
      taskKind: defaults && defaults.taskKind ? defaults.taskKind : '',
    };
  }

  function conditionLabel(conditions) {
    return (Array.isArray(conditions) ? conditions : [])
      .map((condition) => `${condition.key}=${condition.value}`)
      .join('、');
  }

  /**
   * 自动注入只有一份预算：普通卡片与实验规则合计最多 3 条 / 1200 字节。
   * 这里按 provider 最终会看到的完整文本量字节（含标题行、ID、换行和两段之间的空行），
   * 先组装再测量，不能只量卡片正文再拼。
   */
  function autoTextOf(win, normal, experiment) {
    const auto = win && win.autoBudget ? win.autoBudget : null;
    const n = normal === undefined ? String(auto?.normalText || '') : String(normal || '');
    const e = experiment === undefined ? String(auto?.experimentText || '') : String(experiment || '');
    return { normal: n, experiment: e, text: [e, n].filter(Boolean).join('\n\n') };
  }

  function autoBytesOf(win, normal, experiment) {
    return Buffer.byteLength(autoTextOf(win, normal, experiment).text);
  }

  /**
   * 原子准入：量的是最终完整文本和总条数；通过才写入预算账本。
   * 任何一段超限都整段回退，不截半句前提、不把标题留在模型侧。
   */
  function admitAuto(win, { normal, experiment, normalCards, experimentCards } = {}) {
    if (!win || !win.autoBudget) return { ok: false, bytes: 0 };
    const auto = win.autoBudget;
    const parts = autoTextOf(win, normal, experiment);
    const cards = (normalCards === undefined ? (auto.normalCards || 0) : normalCards)
      + (experimentCards === undefined ? (auto.experimentCards || 0) : experimentCards);
    const bytes = Buffer.byteLength(parts.text);
    if (cards > view.CARD.max || bytes > view.CARD.bytes) return { ok: false, bytes, cards };
    const previousTotal = Number(auto.totalBytes || 0);
    if (!affordable(win, bytes - previousTotal)) return { ok: false, bytes, cards };
    auto.normalText = parts.normal;
    auto.experimentText = parts.experiment;
    auto.normalCards = normalCards === undefined ? (auto.normalCards || 0) : normalCards;
    auto.experimentCards = experimentCards === undefined ? (auto.experimentCards || 0) : experimentCards;
    auto.cards = cards;
    auto.cardBytes = Buffer.byteLength(parts.normal);
    auto.experimentBytes = Buffer.byteLength(parts.experiment);
    auto.totalBytes = bytes;
    win.bytes += bytes - previousTotal;
    return { ok: true, bytes, cards };
  }

  /** 实验内容单独记账：同一请求里再次渲染替换旧段，只补差额。 */
  function chargeExperiment(win, text, cards = 1) {
    if (!text) return '';
    const auto = win && win.autoBudget ? win.autoBudget : null;
    if (auto) {
      const admitted = admitAuto(win, {
        normal: auto.normalText || '',
        experiment: text,
        normalCards: auto.normalCards || 0,
        experimentCards: cards,
      });
      if (!admitted.ok) return '';
      return text;
    }
    const bytes = Buffer.byteLength(`\n\n${text}`);
    const previous = win ? (win.experimentBytes || 0) : 0;
    if (bytes > EXPERIMENT_BYTES) return '';
    if (win) {
      if (!affordable(win, bytes - previous)) return '';
      win.bytes += bytes - previous;
      win.experimentBytes = bytes;
    }
    return text;
  }

  /** 实验正文按条目记有效期：一条到期只撤一条，不把同请求里其他规则一起清掉。 */
  function experimentTextFrom(parts, now = Date.now()) {
    if (!parts || !Array.isArray(parts.items)) return '';
    const items = parts.items.filter((item) => !item.validUntil || now <= Date.parse(String(item.validUntil)));
    if (!items.length) return '';
    return `${parts.header}\n${items.map((item) => item.line).join('\n')}${parts.tail || ''}`;
  }

  /** 本轮问题与栏目名的字面相关度：只展示有交集的栏目，交集为空就整段跳过。 */
  function relevantRanges(names, query) {
    const text = String(query || '').toLowerCase();
    if (!text) return [];
    const tokens = new Set();
    for (const word of text.match(/[a-z][a-z0-9_-]{2,}/g) || []) tokens.add(word);
    for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
      for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
    }
    if (!tokens.size) return [];
    return (Array.isArray(names) ? names : []).filter((name) => {
      const value = String(name || '').toLowerCase();
      if (!value) return false;
      if (text.includes(value)) return true;
      for (const token of tokens) if (value.includes(token)) return true;
      return false;
    });
  }

  /** 实验正文只在「自进化开着，且还是同一代」时可用；关掉再开不能复活旧正文。 */
  function experimentStillCurrent(scope, held) {
    let evolution;
    try { evolution = evolutionStatus(scope); } catch { return false; }
    if (!evolution || evolution.enabled !== true || evolution.compatible === false) return false;
    if (held && held.epoch && String(evolution.epoch || '') !== String(held.epoch)) return false;
    return true;
  }

  /** 读决策 → 一段短提示：未绑定只给栏目索引，已绑定才给规则正文。 */
  function renderExperiment(scope, decision, context, held, win) {
    if (held && typeof held === 'object') { held.validUntil = ''; held.experimentParts = null; held.injectedIds = []; }
    if (!experimentStillCurrent(scope, held)) return '';
    if (!decision || decision.kind === 'none') return '';
    if (decision.kind === 'conflict') {
      return chargeExperiment(win, '这些实验规则互相冲突，先按用户这次说的做，别叠加对立的规则。');
    }
    if (decision.kind === 'index' || decision.kind === 'clarify') {
      const names = relevantRanges(Array.isArray(decision.ranges) ? decision.ranges.filter(Boolean) : [], held && held.query).slice(0, 3);
      /** 没有适用栏目就什么也不注入：不拿无关范围冒充当前任务，也不催用户选栏目。 */
      if (!names.length) return '';
      const tail = held && held.contextId ? `\ncontextId=${held.contextId}` : '';
      return chargeExperiment(win, `${EXPERIMENT_INDEX_HEADER}\n${names.map((name) => `- ${name}`).join('\n')}${tail}`);
    }
    let index;
    try { index = loadIndex(scope); } catch { return ''; }
    const matched = [];
    const unknown = [];
    const byTopic = new Map();
    let conflict = false;
    const now = Date.now();
    const query = held && held.query ? String(held.query) : '';
    const runtime = { projectId: scope.key, experimental: true, context: context || {}, task: (held && held.task) || {} };
    for (const record of index.entries) {
      if (record.origin !== 'project_evolution') continue;
      if (record.ownerProjectId && record.ownerProjectId !== scope.key) continue;
      const score = query ? view.matchScore(record, query).score : 0;
      /** 生命周期、归属、学习状态、适用条件统一走 eligibility：被取代、过期、暂停都不该从实验通道溜进来。 */
      const usable = view.eligibility(record, runtime, 'auto', now);
      if (!usable.ok) {
        if (usable.status === 'needs_context' && usable.reason !== 'condition_mismatch'
          && score >= view.MATCH_FLOOR) unknown.push(record);
        continue;
      }
      /**
       * 只有任务范围条件（栏目/阶段/任务类型）才算相关度：环境条件（系统/机器/路径）人人都过，
       * 拿它当绑定条件会让一条宽泛规则出现在每个请求里。其余规则照旧过词面门。
       */
      const conditions = Array.isArray(record.conditions) ? record.conditions.filter((row) => row && row.key) : [];
      const bound = conditions.some((row) => view.TASK_CONDITION_KEYS.includes(row.key));
      if (!bound && score < view.MATCH_FLOOR) continue;
      const topic = record.topicKey || record.id;
      if (byTopic.has(topic) && byTopic.get(topic).body !== record.body) conflict = true;
      byTopic.set(topic, record);
      matched.push({ record, score: bound ? Math.max(score, view.MATCH_FLOOR) : score });
    }
    if (conflict) {
      return chargeExperiment(win, '这些实验规则互相冲突，先按用户这次说的做，别叠加对立的规则。');
    }
    const parts = { header: EXPERIMENT_RULES_HEADER, items: [], tail: held && held.contextId ? `\ncontextId=${held.contextId}` : '' };
    /** 与普通记忆共用 3 张卡片 / 1200 字节：普通卡片先占掉的位子和字节，实验规则不能再拿。 */
    const auto = win && win.autoBudget ? win.autoBudget : null;
    const cardCap = auto
      ? Math.max(0, view.CARD.max - (auto.normalCards || 0) - (auto.experimentCards || 0))
      : view.CARD.max;
    const autoCap = auto
      ? Math.max(0, view.CARD.bytes - Buffer.byteLength(auto.normalText || '') - 2)
      : EXPERIMENT_BYTES;
    let used = Buffer.byteLength(EXPERIMENT_RULES_HEADER) + 1;
    const relevant = matched
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((row) => row.record);
    for (const record of relevant.slice(0, cardCap)) {
      const body = String(record.body || '');
      const short = body && body.length <= EXPERIMENT_SHORT_CHARS && body.split('\n').length <= 4;
      const conditions = conditionLabel(record.conditions);
      const checkpoint = record.learning && Array.isArray(record.learning.checkpoints) ? record.learning.checkpoints[0] : null;
      const check = checkpoint && checkpoint.text
        ? `；核对：${String(checkpoint.text).slice(0, 40)}`
        : '';
      const line = short
        ? `- 「${record.title}」${conditions ? `（${conditions}）` : ''}：${body}${check}`
        : `- 「${record.title}」（用途：${record.summary || record.title}；要用时 memory_read 带标题取正文）`;
      const size = Buffer.byteLength(`\n${line}`);
      if (used + size > autoCap) break;
      used += size;
      const trialLearning = record.learning && typeof record.learning === 'object' ? record.learning : {};
      const trialUntil = trialLearning.state === 'trial' && Number.isFinite(Date.parse(String(trialLearning.trialUntil || '')))
        ? String(trialLearning.trialUntil) : '';
      parts.items.push({ id: record.id, line, validUntil: trialUntil });
    }
    if (held) held.injectedIds = parts.items.map((item) => item.id);
    if (!parts.items.length && unknown.length) {
      /** 条件没确认的条目只报数量，绝不在模型侧暴露标题。 */
      return chargeExperiment(win, '有些实验规则的适用条件还没确认，先按用户这次说的做，别把它们当本轮依据。');
    }
    if (!parts.items.length) return '';
    /** 先按最终整段文本过预算，再登记可发布内容；没通过就一条都不留。 */
    const admitted = chargeExperiment(win, experimentTextFrom(parts), parts.items.length);
    if (!admitted) {
      if (held) { held.experimentParts = null; held.injectedIds = []; held.validUntil = ''; }
      return '';
    }
    if (held) held.experimentParts = parts;
    /** 兼容旧读取点：整体最早到期只取本轮真正注入的条目，不再被无关试验拖下水。 */
    if (held) {
      const deadlines = parts.items.map((item) => Date.parse(String(item.validUntil))).filter(Number.isFinite);
      if (deadlines.length) held.validUntil = new Date(Math.min(...deadlines)).toISOString();
    }
    return admitted;
  }

  /**
   * 一次真人请求只路由一次：不管自进化开没开，都先建独立的任务上下文。
   * 普通记忆按这个上下文判适用；实验规则只是在这个上下文上再加一层可用性。
   */
  function runtimeFor(scope, { sessionId, query, batchKey, messageIds, autoRoute = true }) {
    if (!batchKey) return null;
    let status = null;
    try { status = evolutionStatus(scope); } catch { status = null; }
    const enabled = Boolean(status && status.enabled === true && status.compatible !== false && scope.confirmed === true);
    /** 任务上下文独立于自进化：项目状态读不出来也要按当前任务判普通记忆，不能整段取消召回。 */
    let tasks = null;
    try { tasks = taskState(scope); } catch { tasks = null; }
    tasks = tasks && typeof tasks === 'object' ? tasks : {};
    const ranges = rangesOf(scope);
    /**
     * 工具模式不自动路由：上下文照样要有，但不能因为一句点名就改任务状态；
     * 真正的绑定留给 memory_search bindForRequest，绑定后状态是 proposed。
     */
    const routed = autoRoute
      ? anchor.routeTask(tasks, {
        projectId: scope.key,
        sessionId,
        batchKey,
        messageIds,
        query,
        registeredSeries: ranges.series,
        defaults: tasks.defaults,
        now: Date.now(),
      })
      : (() => {
        const sessionAnchor = tasks.sessions && tasks.sessions[sessionId] ? tasks.sessions[sessionId] : null;
        const episode = sessionAnchor && sessionAnchor.episodeId && tasks.episodes
          ? tasks.episodes[sessionAnchor.episodeId] || null
          : null;
        return { tasks, anchor: sessionAnchor, episode, changed: false, decision: { kind: 'none', reason: 'tool_only' } };
      })();
    if (routed.changed) {
      /** 落盘失败也不能取消本轮任务判断：进程内上下文仍然有效，只是不留任务历史。 */
      saveTaskState(scope, routed.tasks, { operationId: `task_${batchKey}` });
    }
    const context = view.trustedContext(scope, anchor.contextOfAnchor(routed.anchor, {}));
    const thanks = anchor.isThanks(query);
    const decision = anchor.decideRead({
      mode: recallMode(),
      enabled,
      identityConfirmed: scope.confirmed === true,
      anchor: routed.anchor,
      ranges: [...ranges.taskKinds, ...ranges.series],
      thanks,
      boundForRequest: false,
    });
    const contextId = anchor.contextIdFor(scope.key, batchKey, crypto.randomUUID().slice(0, 8));
    const episode = routed.episode
      || (routed.anchor && routed.tasks && routed.tasks.episodes ? routed.tasks.episodes[routed.anchor.episodeId] : null);
    let epoch = '';
    try { epoch = String(status && status.epoch ? status.epoch : ''); } catch { epoch = ''; }
    const anchorTask = routed.anchor || {};
    /** 与自进化开关无关的请求上下文：普通记忆也靠它判断项目、任务与代号。 */
    const requestContext = anchor.buildRuntimeContext({
      projectId: scope.key,
      sessionId,
      batchKey,
      messageIds,
      controlEpoch: epoch,
      query,
      anchor: anchorTask,
      episode,
    });
    const task = {
      ...requestContext.task,
      kind: anchorTask.taskKind || requestContext.task.kind || context.taskKind || '',
      seriesId: anchorTask.seriesId || requestContext.task.seriesId || context.seriesId || '',
      artifactKey: requestContext.task.artifactKey || context.artifactKey || '',
      phase: requestContext.task.phase || context.phase || '',
    };
    const held = {
      contextId, requestId: requestContext.requestId, controlEpoch: epoch,
      projectKey: scope.key, sessionId, batchKey, messageIds, query,
      context, task, anchor: routed.anchor, ranges, decision, epoch,
      experimental: enabled,
      episodeId: (episode && episode.episodeId) || (routed.anchor && routed.anchor.episodeId) || '',
      episodeUpdatedAt: episode ? episode.updatedAt : '', injectedIds: [],
      at: Date.now(),
    };
    return { held, decision, ranges, enabled, status };
  }

  /** 实验正文只在自进化开着时登记；普通记忆共享同一个任务上下文。 */
  function experimentFor(scope, runtime, win) {
    if (!runtime || !runtime.held) return null;
    const held = runtime.held;
    if (win) win.runtime = held;
    if (!runtime.enabled) return null;
    if (!experimentStillCurrent(scope, held)) return { text: '', held, decision: held.decision };
    if (win) {
      win.experiment = held;
      win.contexts.set(held.contextId, held);
    }
    return { text: renderExperiment(scope, held.decision, held.context, held, win), decision: held.decision, held };
  }

  function resolveRequestContext(execution, optionalContextId) {
    const scope = scopeOf(cwdOf(execution));
    const win = windowOf(execution && execution.agent);
    const contextId = typeof optionalContextId === 'string' ? optionalContextId.trim() : '';
    if (!contextId) {
      /** 没有显式上下文时，用本请求已经路由出来的任务；这层不依赖自进化开关。 */
      const live = win && win.runtime ? win.runtime : null;
      const runtime = live
        || (win && win.sessionId ? lastRuntime.get(`${scope.key}\u0000${win.sessionId}`) : null);
      const sameRequest = runtime
        && runtime.projectKey === scope.key
        && (!runtime.sessionId || runtime.sessionId === String(win.sessionId || ''))
        && (runtime === live ? runtime.batchKey === anchor.requestBatchKey(win.messageIds || []) : true);
      if (sameRequest) {
        /** 普通记忆可以直接用本请求上下文；实验正文仍要求显式 contextId，不能顺手放行。 */
        return { ok: true, scope, win, context: runtime.context, held: runtime, experimental: false };
      }
      return { ok: true, scope, win, context: view.trustedContext(scope, {}), experimental: false };
    }
    /** 先认项目再找本地记录：别的项目的上下文要明确拒绝，不能只报过期。 */
    if (anchor.projectTagOf(contextId) !== anchor.projectTag(scope.key)) {
      return { ok: false, status: 'needs_context', reason: '这个上下文属于另一个项目' };
    }
    if (!win) return { ok: false, status: 'needs_context', reason: '这个请求的上下文已经过期，先重新问一次当前任务' };
    const held = win.contexts.get(contextId);
    if (!held) return { ok: false, status: 'needs_context', reason: '这个上下文已经过期，先重新问一次当前任务' };
    /** 凭据只在当轮、当次开关代次内有效：换轮、关闭、重开或过期都不再放行旧正文。 */
    const expired = (reason) => {
      win.contexts.delete(contextId);
      if (win.experiment && win.experiment.contextId === contextId) win.experiment = null;
      return { ok: false, status: 'needs_context', reason };
    };
    if (held.projectKey !== scope.key) return expired('这个上下文属于另一个项目');
    if (held.sessionId && held.sessionId !== String(win.sessionId || '')) return expired('这个上下文已经过期，先重新问一次当前任务');
    if (!held.batchKey || held.batchKey !== anchor.requestBatchKey(win.messageIds || [])) {
      return expired('这个上下文已经过期，先重新问一次当前任务');
    }
    let evolution;
    try { evolution = evolutionStatus(scope); } catch { return expired('当前项目状态读不出来，先重新问一次当前任务'); }
    if (!evolution || evolution.enabled !== true || evolution.compatible === false) {
      return expired('项目自进化已经关闭，先重新问一次当前任务');
    }
    if (held.epoch && evolution.epoch !== held.epoch) {
      return expired('项目自进化重新开过，先重新问一次当前任务');
    }
    return { ok: true, scope, win, context: held.context, experimental: true, held, contextId };
  }

  /** 工具模式没有自动索引时，按本轮真人消息现开一个请求上下文，只按问题与记忆范围的字面关系判断。 */
  function toolContextFor(execution) {
    const win = windowOf(execution && execution.agent);
    if (!win || !win.sessionId || !Array.isArray(win.messageIds) || win.messageIds.length === 0) return '';
    const scope = scopeOf(cwdOf(execution));
    if (scope.confirmed !== true) return '';
    let status;
    try { status = evolutionStatus(scope); } catch { return ''; }
    if (!status || status.enabled !== true || status.compatible === false) return '';
    const batchKey = anchor.requestBatchKey(win.messageIds);
    const held = win.experiment && win.experiment.batchKey === batchKey && win.experiment.epoch === status.epoch
      ? win.experiment
      : null;
    if (held) return held.contextId;
    const contextId = anchor.contextIdFor(scope.key, batchKey, crypto.randomUUID().slice(0, 8));
    const created = {
      contextId, projectKey: scope.key, sessionId: win.sessionId, batchKey,
      messageIds: win.messageIds.slice(), query: trustedQueryOf(win), context: view.trustedContext(scope, {}),
      anchor: null, ranges: rangesOf(scope), decision: { kind: 'none' }, epoch: status.epoch, at: Date.now(),
    };
    win.experiment = created;
    win.contexts.set(contextId, created);
    return contextId;
  }

  /** 本轮真人消息是唯一可信的任务依据；模型自己写的 query 只用于检索词，不能拿来建绑定。 */
  function trustedQueryOf(win) {
    return win && typeof win.query === 'string' ? win.query : '';
  }

  /** 前台绑定只升到 proposed：真正执行链还没发生，不冒充 active。 */
  function bindSelection(execution, resolved) {
    const held = resolved.held;
    if (!held || typeof held !== 'object') return { ok: false, status: 'needs_context', reason: '本轮还没有可核对的用户消息，先重新问一次当前任务' };
    const query = held.query || trustedQueryOf(resolved.win);
    if (!query) return { ok: false, status: 'needs_context', reason: '本轮还没有可核对的用户消息，先重新问一次当前任务' };
    const ranges = held.ranges || { series: [], taskKinds: [] };
    /** 自动路由已经选了范围就沿用同一个结果，工具绑定不重新猜一遍，避免两处给出不同任务。 */
    const routedAnchor = held.anchor && typeof held.anchor === 'object' ? held.anchor : null;
    const hits = [];
    if (routedAnchor && routedAnchor.seriesId) hits.push({ seriesId: routedAnchor.seriesId });
    else if (routedAnchor && routedAnchor.taskKind) hits.push({ taskKind: routedAnchor.taskKind });
    else {
      for (const value of ranges.series || []) if (anchor.seriesChosenBy(query, value)) hits.push({ seriesId: value });
      for (const value of ranges.taskKinds || []) if (anchor.seriesChosenBy(query, value)) hits.push({ taskKind: value });
    }
    if (hits.length !== 1) {
      const names = [...(ranges.series || []), ...(ranges.taskKinds || [])].slice(0, 3);
      return { ok: false, status: 'needs_context', reason: names.length ? '本轮没有匹配的记忆范围，按当前任务继续' : '本轮没有适用的记忆范围，按当前任务继续' };
    }
    let tasks;
    try { tasks = taskState(resolved.scope); } catch { return { ok: false, status: 'needs_context', reason: '任务状态还没读出来' }; }
    const applied = anchor.applySelection(tasks, {
      sessionId: held.sessionId,
      selection: hits[0],
      batchKey: held.batchKey,
      messageIds: held.messageIds,
      now: Date.now(),
    });
    const saved = saveTaskState(resolved.scope, applied.tasks, { operationId: `bind_${held.batchKey}` });
    if (!saved.ok) return { ok: false, status: 'needs_context', reason: saved.reason || '任务选择没有保存' };
    held.anchor = applied.anchor;
    held.context = view.trustedContext(resolved.scope, anchor.contextOfAnchor(applied.anchor, {}));
    held.decision = { kind: 'rules', reason: 'bound' };
    resolved.context = held.context;
    const text = renderExperiment(resolved.scope, held.decision, held.context, held, resolved.win);
    const preparedState = prepared.get(execution && execution.agent);
    if (preparedState) {
      preparedState.experimentText = text;
      preparedState.experimentParts = held.experimentParts || null;
      preparedState.validUntil = held.validUntil || '';
    }
    return { ok: true };
  }

  /** provider 只读内存快照：不查盘、不搜索、不写 hits、不动 lastUsed。 */
  function recallText(holder) {
    try {
      const agent = holder?.agent ?? getService('agents')?.currentInitiator?.();
      if (!agent) return '';
      const state = prepared.get(agent);
      if (!state) return '';
      const signal = holder?.signal;
      if (signal?.aborted) return '';
      if (state.signal && signal && state.signal !== signal) return '';
      const sessionId = agent?.session?.id;
      if (state.sessionId !== (typeof sessionId === 'string' ? sessionId : '')) return '';
      /** 开关/自进化换代后，关掉前准备好的正文一律不再输出。 */
      const scope = scopeOf(cwdOf({ agent }));
      if (!memoryEnabled(scope)) return '';
      const epoch = controlStatus(scope).epoch || '';
      if (state.controlEpoch && epoch && state.controlEpoch !== epoch) return '';
      /** 自进化关掉或换过代：关掉前的实验正文不再输出，重开也不复活。 */
      let evolutionText = state.experimentParts ? experimentTextFrom(state.experimentParts) : state.experimentText;
      if (evolutionText) {
        let evolution;
        try { evolution = evolutionStatus(scope); } catch { evolution = null; }
        if (!evolution || evolution.enabled !== true || evolution.compatible === false
          || (state.evolutionEpoch && String(evolution.epoch || '') !== state.evolutionEpoch)) evolutionText = '';
      }
      /** 没有逐条快照时才退回整段到期判断；有快照就只撤到期的那一条。 */
      if (evolutionText && !state.experimentParts && state.validUntil && Date.now() > Date.parse(String(state.validUntil))) evolutionText = '';
      /** 普通卡片也在输出前逐条复核到期：投影到真正发给模型之间可能已经过了 validUntil。 */
      let normalText = state.text;
      if (Array.isArray(state.lines)) {
        const now = Date.now();
        const live = state.lines.filter((row) => !row.validUntil || now <= Date.parse(String(row.validUntil)));
        normalText = live.length ? `${RECALL_HEADER}\n${live.map((row) => row.line).join('\n')}` : '';
        /** 真正交付的卡片才记使用；记账推迟到回合收尾，provider 不碰写锁。 */
        if (live.length && state.scope) {
          if (!(state.deliveredIds instanceof Set)) state.deliveredIds = new Set();
          for (const row of live) if (row.id) state.deliveredIds.add(row.id);
        }
        /** 投影时还在、发出时已过期：回执跟着真实输出改，别在面板上说「提醒了 2 条」而正文是空的。 */
        if (state.scope && live.length !== state.cards.length) {
          noteRecall(state.scope, state.sessionId, {
            reason: live.length ? 'hit' : 'expired',
            matched: state.matched || state.cards.length,
            cards: live.length,
            chars: live.length ? view.bytesOf(normalText) : 0,
          });
        }
      }
      return [evolutionText, normalText].filter(Boolean).join('\n\n');
    } catch {
      return '';
    }
  }


  ctx.effect(() => tools.register({
    name: 'memory_save',
    description: `保存一条跨会话有用的记忆。只在会改变以后判断时存；先搜，能更新就不新建。用户说「记住」或话已是长期规则（「以后都这样」「别再 X」）时直接调用，不要先问。文本相近但标题不同时先不写，返回 needsResolution 后核对：是同一件事就改成那个标题重存，确实是另一条才带 resolution="distinct"。按标题更新时未给字段保留，正文整段替换；旧正文只留作内部撤回，不展示不检索。前置条件不同同一标题可存两条。${NOTES}`,
    parameters: SAVE_PARAMS,
    output: {
      presentationMeta: (_args, value) => ({
        kind: 'memory-save',
        title: value.title || '',
        scope: value.scope || '',
        revision: value.revision || 0,
        changed: value.changed === true,
        recordKind: typeof value.kind === 'string' && value.kind ? value.kind : '',
        mode: value.error ? 'failed'
          : value.needsScope ? 'needs_scope'
          : value.existingTitle ? 'duplicate'
            : value.needsResolution ? 'needs_resolution'
              : value.changed === false ? 'unchanged' : value.merged ? 'updated' : 'created',
      }),
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          when: { type: 'string' },
          kind: { type: 'string' },
          summaryShortened: { type: 'boolean' },
          fullTextSaved: { type: 'boolean' },
          revision: { type: 'integer' },
          merged: { type: 'boolean' },
          changed: { type: 'boolean' },
          scope: { type: 'string' },
          scopeName: { type: 'string' },
          needsResolution: { type: 'boolean' },
          needsScope: { type: 'boolean' },
          reason: { type: 'string' },
          existingTitle: { type: 'string' },
          existingScope: { type: 'string' },
          crossLayer: { type: 'boolean' },
          crossScope: { type: 'string', enum: ['global', 'project'] },
          sameTopic: { type: 'boolean' },
          similarTitles: { type: 'string' },
          similar: { type: 'string' },
          scopeNote: { type: 'string' },
          supersededTitle: { type: 'string' },
          archived: { type: 'string' },
          pendingConflicts: { type: 'integer' },
          error: { type: 'string' },
          offCopy: { type: 'string' },
        },
        required: ['title', 'summary', 'when', 'revision', 'merged', 'changed', 'scope', 'needsResolution', 'archived'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.error
          ? `memory · ${value.error}`
          : value.needsScope
          ? value.reason === 'memory_disabled'
            ? `memory · ${value.offCopy || '本项目记忆已关闭，先在面板打开'}`
            : value.reason === 'unconfirmed_project'
            ? `memory · 当前目录还不能确认属于哪个项目：「${value.title}」\n先确认项目根目录，或显式 scope="global"`
            : `memory · 归属还没定：「${value.title}」\n补 memoryClass（personal_preference / project_fact / environment_fact / portable_procedure）或显式 scope；设备事实还要给设备条件`
          : value.existingTitle
            ? `memory · 已有相同记忆：「${value.title}」（${value.existingScope}）\n要改成另一条，加 resolution="distinct"`
            : value.needsResolution
          ? `memory · 需要确认：「${value.title}」与已有条目相近${value.crossLayer ? '（在另一层）' : ''}${value.sameTopic ? '（同一主题槽位）' : ''}\n${value.similar}\n要更新它：用同一个标题${value.crossScope === 'global' ? '、并带 scope="global"' : ''}再存一次；确实是另一条，加 resolution="distinct"`
          : value.changed === false
            ? `memory · unchanged ${withTag(value, `"${value.title}"`)}`
            : `memory · ${value.merged ? 'merged' : 'saved'} ${withTag(value, `"${value.title}"`)}${value.when ? `（${value.when}）` : ''}${value.similar ? ` · 相近：${value.similar}` : ''}${value.archived ? ` · 已归档「${value.archived}」腾位` : ''}${value.fullTextSaved ? ' · 完整原句已另存' : ''}${value.supersededTitle ? ` · 已取代「${value.supersededTitle}」` : ''}${value.scopeNote ? ` · ${value.scopeNote}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const projectScope = scopeOf(cwdOf(execution));
      const projectScopeName = projectNameOf(projectScope);
      if (!memoryEnabled(projectScope)) {
        return {
          title: String(args.title || ''), summary: '', when: '', revision: 0,
          merged: false, changed: false, scope: '', needsScope: true, reason: 'memory_disabled',
          needsResolution: false, similarTitles: '', similar: '', archived: '', offCopy: memoryOffCopy(projectScope),
        };
      }
      const supersedes = String(args.supersedes || '').trim();
      const supersedesId = supersedes && !/^mem_[a-z0-9]+$/.test(supersedes)
        ? (() => { try { return refIdOf(projectScope, { title: supersedes }, '记忆'); } catch { return ''; } })()
        : supersedes;
      /**
       * 模型写进参数里的 scope 只是提案：只有本轮真人原话明确说「所有项目/全局」，
       * 或面板直接确认过，才允许落到全局层。工具写入的正文由模型写，不能冒充用户原话。
       */
      const preparedState = prepared.get(execution && execution.agent);
      const humanSaid = String(preparedState && preparedState.saidOnly || '');
      const humanGlobal = humanAskedGlobal(humanSaid);
      const draft = {
        ...args,
        writeMode: args.mode || 'patch',
        origin: 'model_drafted',
        scopeConfirmed: humanGlobal,
        requestedScope: args.scope,
      };
      if (humanGlobal) draft.scope = 'global'; else delete draft.scope;
      if (supersedes) { if (supersedesId) draft.supersedes = supersedesId; else delete draft.supersedes; }
      /** 更新句柄也用标题：id 只是底层实现，模型抄标题就行。 */
      const updateTitle = String(args.updateTitle || '').trim();
      if (updateTitle) {
        const candidates = titleCandidates(projectScope, updateTitle);
        const ambiguous = candidates.find((row) => row.ambiguous);
        /** 同层同名是允许的（不同前置条件各一条），但不能替用户挑第一条改。 */
        if (ambiguous) return saveFailure(ambiguousTitleError(updateTitle, ambiguous.hits, '记忆'), args);
        if (!args.scope && candidates.length > 1) {
          return saveFailure(`「${updateTitle}」在项目层和全局层各有一条：改全局加 scope="global"，改项目加 scope="project"`, args);
        }
        const layer = args.scope === 'global' ? 'global' : args.scope === 'project' ? 'project' : '';
        const picked = layer ? candidates.find((row) => row.scope === layer) : candidates[0];
        if (!picked) {
          const near = nearTitleHints(runtimeLayers(projectScope), updateTitle);
          if (near.length) {
            return saveFailure(`没有「${updateTitle}」这条记忆。相近的里有：${near.map((item) => `「${item}」`).join('、')}；要新增就不用 updateTitle`, args);
          }
          return saveFailure(`没有「${updateTitle}」这条记忆；要新增就不用 updateTitle`, args);
        }
        draft.id = picked.id;
      }
      /** 关联目标同样按标题解析成内部 id 再落盘。 */
      if (Array.isArray(args.links) && args.links.length) {
        const resolved = [];
        for (const link of args.links) {
          const title = typeof link?.title === 'string' ? link.title.trim() : '';
          if (!title) return saveFailure('关联要写成 {type, title}：给被关联那条记忆的标题', args);
          let targetId = '';
          try { targetId = refIdOf(projectScope, { title }, '记忆'); } catch (error) {
            return saveFailure(String(error && error.message ? error.message : `没有「${title}」这条记忆`), args);
          }
          resolved.push({ type: link.type || 'related', id: targetId });
        }
        draft.links = resolved;
      }
      const saved = saveEntry(projectScope, draft);
      if (saved.needsScope) {
        return {
          title: saved.draft?.title || '',
          summary: saved.draft?.summary || '',
          when: saved.draft?.when || '',
          revision: 0,
          merged: false,
          changed: false,
          scope: '',
          needsScope: true,
          reason: saved.reasonCode,
          needsResolution: false,
          similarTitles: '',
          similar: '',
          archived: '',
        };
      }
      if (saved.existing) {
        return {
          title: saved.existing.title || saved.draft?.title || '',
          summary: '',
          when: '',
          revision: saved.existing.revision,
          merged: false,
          changed: false,
          scope: saved.existing.scope,
          scopeName: saved.existing.scope === 'global' ? '' : projectScopeName,
          needsScope: false,
          existingTitle: saved.existing.title || saved.draft?.title || '',
          existingScope: saved.existing.scope,
          needsResolution: false,
          similarTitles: '',
          similar: '',
          archived: '',
        };
      }
      const scope = saved.chosenScope === 'global' || (args.scope === 'global' && !saved.chosenScope) ? globalScope() : projectScope;
      /** 显式要了全局却被硬冲突挡回项目层时说清原因：否则模型只能看到 scope=project，无从纠。 */
      const scopeNote = (() => {
        if (args.scope !== 'global' || scope.key === 'global') return '';
        if (saved.reasonCode === 'machine_bound_scope' || saved.reasonCode === 'machine_bound_procedure') return '按本机痕迹留在项目层：正文或依据里写了本机路径/端口，改成别的项目仍成立的通用规则再存全局；只在本机适用的流程可补 machine 条件后存全局';
        if (saved.reasonCode === 'model_global_project_fact' || saved.reasonCode === 'class_project_fact') return '按项目事实留在项目层：换成别的项目就不成立；确实是通用流程就改 memoryClass';
        if (saved.reasonCode === 'model_class_project' || saved.reasonCode === 'unclassified_project') return '按当前项目保存：模型归类只是提案，要存全局得由用户明确说「所有项目都这样」';
        return '';
      })();
      if (saved.needsResolution) {
        return {
          title: saved.draft.title,
          summary: saved.draft.summary,
          when: saved.draft.when,
          revision: 0,
          merged: false,
          changed: false,
          scope: saved.chosenScope || (scope.key === 'global' ? 'global' : 'project'),
          needsScope: false,
          needsResolution: true,
          crossLayer: Boolean(saved.crossLayer),
          crossScope: saved.crossScope === 'global' ? 'global' : 'project',
          sameTopic: Boolean(saved.sameTopic),
          similarTitles: saved.similarList.map((item) => item.title).join('、'),
          similar: saved.similarList.map((item) => describeCandidate(item, { sameTopic: saved.sameTopic })).join('；'),
          archived: '',
          ...(scopeNote ? { scopeNote } : {}),
          pendingConflicts: Number(saved.pendingConflicts) || 0,
        };
      }
      recordCitations(scope, sessionIdOf(execution), [saved.record]);
      return {
        title: saved.record.title,
        summary: saved.record.summary,
        when: saved.record.when || '',
        kind: saved.record.kind || 'note',
        summaryShortened: Boolean(saved.draft?.summaryShortened),
        fullTextSaved: Boolean(saved.draft?.fullTextSaved ?? saved.draft?.fullTextInBody),
        revision: saved.record.revision || 1,
        merged: saved.merged,
        changed: !saved.noop,
        scope: scope.key === 'global' ? 'global' : 'project',
        scopeName: scope.key === 'global' ? '' : projectScopeName,
        needsScope: false,
        needsResolution: false,
        similarTitles: saved.similarList.map((item) => item.title).join('、'),
        ...(scopeNote ? { scopeNote } : {}),
        supersededTitle: supersedes && supersedesId ? supersedes : '',
        archived: (saved.archived || []).map((item) => item.title).join('、'),
        pendingConflicts: Number(saved.pendingConflicts) || 0,
        ...(saved.similar ? { similar: `「${saved.similar.title}」` } : {}),
      };
    },
  }), 'lite-memory: memory_save');

  ctx.effect(() => tools.register({
    name: 'memory_suggest',
    description: `对用户没说、但跨会话有用的经验提出保存建议。调用后出现「保留」按钮，用户点了才进正式记忆；不要用问句征询。一次对话最多一条，48 小时内每项目一条；相近条目记为「更新候选」，保留后更新那条，不新建。${NOTES}`,
    parameters: SUGGEST_PARAMS,
    output: {
      presentationMeta: (_args, value) => ({ kind: 'memory-suggest', id: value.id || '', asked: value.asked }),
      schema: {
        type: 'object',
        properties: {
          asked: { type: 'boolean' },
          title: { type: 'string' },
          id: { type: 'string' },
          reason: { type: 'string' },
          targetTitle: { type: 'string' },
        },
        required: ['asked'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.asked
          ? `memory · suggested "${value.title}"${value.targetTitle ? ` · 确认后更新「${value.targetTitle}」` : ''}`
          : `memory · skipped${value.reason ? `\n${value.reason}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      if (!memoryEnabled(scope)) return { asked: false, reason: '本项目记忆已关闭' };
      const gate = suggestionGate(scope, args);
      if (!gate.ok) return { asked: false, reason: gate.reason };
      const noted = noteSuggestion(scope, gate.target ? { ...args, targetId: gate.target.id } : args);
      return {
        asked: true,
        title: noted.title,
        id: noted.id,
        ...(noted.targetTitle ? { targetTitle: noted.targetTitle } : {}),
      };
    },
  }), 'lite-memory: memory_suggest');

  ctx.effect(() => tools.register({
    name: 'memory_search',
    description: `检索已有记忆；命中后 memory_read 带标题读正文。用户提到「记住了什么/上次/规范/约定/路径/凭据怎么取」，或眼前反复出现报错、弹窗、异常时先查这里。跨项目条目以 [global] 开头。要更新就按返回标题重存。默认只列当前有效的；查历史传 history。`,
    parameters: SEARCH_PARAMS,
    output: {
      presentationMeta: (_args, value) => ({
        kind: 'memory-search', count: value.count, status: value.status || 'ok', refs: value.refs || [],
        noTriggerReason: value.noTriggerReason || '',
      }),
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          chars: { type: 'integer' },
          text: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'budget_exhausted', 'memory_disabled', 'needs_context'] },
          reasonCode: { type: 'string' },
          noTriggerReason: { type: 'string' },
          refs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                scope: { type: 'string' },
                revision: { type: 'integer' },
                status: { type: 'string' },
                origin: { type: 'string' },
                kind: { type: 'string' },
                when: { type: 'string' },
                updated: { type: 'string' }, // ui-copy-ignore
              },
              required: ['title', 'scope', 'revision', 'status', 'origin', 'kind', 'when'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'chars', 'text', 'refs'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'budget_exhausted'
          ? 'memory · 这条消息已停止检索，下一条消息再查'
          : value.status === 'memory_disabled'
            ? 'memory · 记忆检索已关闭'
            : value.status === 'needs_context'
              ? `memory · 先确认当前任务\n${value.text}`
              : value.count > 0
              ? `memory · 命中 ${value.count} 条 · 引用 ${value.chars} 字\n${value.text}`
              : 'memory · 没有命中',
      }],
    },
    execute: async (args, execution) => {
      if (!memoryEnabledFor(execution) || modeFor(scopeOf(cwdOf(execution))) === 'off') return { count: 0, chars: 0, text: '', status: 'memory_disabled', refs: [] };
      const agent = execution?.agent;
      const win = windowOf(agent);
      if (win && !affordableTool(win, 0)) return { count: 0, chars: 0, text: '', status: 'budget_exhausted', refs: [] };
      const wantsBind = args.bindForRequest === true;
      const contextId = wantsBind && !args.contextId ? toolContextFor(execution) : args.contextId;
      if (wantsBind && !contextId) {
        return { count: 0, chars: 0, text: '先带上当前任务的 contextId，再绑定这一期。', status: 'needs_context', refs: [] };
      }
      const resolved = resolveRequestContext(execution, contextId);
      if (!resolved.ok) return { count: 0, chars: 0, text: resolved.reason, status: resolved.status || 'needs_context', refs: [] };
      if (wantsBind) {
        const bound = bindSelection(execution, resolved);
        if (!bound.ok) return { count: 0, chars: 0, text: bound.reason, status: bound.status || 'needs_context', refs: [] };
      }
      const scope = resolved.scope;
      const context = resolved.context;
      const gateRuntime = resolved.held || win?.runtime
        || { projectId: scope.key, context, experimental: resolved.experimental === true };
      /** 检索只列当前任务真能用的条目；先取全量候选，过滤后再截断，避免不可用条目挤掉后面的命中。 */
      const limit = args.limit ?? 3;
      const rawHits = search(scope, args.query, 50, {
        context,
        history: args.history === true,
        allowExperimental: resolved.experimental === true,
        /** 「用过」要等真正给了模型看再记：检索到的前 50 条不是交付。 */
        markUsed: false,
      }).filter((item) => !item.ownerProjectId || item.ownerProjectId === scope.key)
        .filter((item) => item.archived || view.eligibility(item, gateRuntime, 'search').ok);
      const hits = rawHits.filter((item) => item.archived || item.status === 'ok').slice(0, limit);
      const withheld = rawHits.filter((item) => !item.archived && item.status !== 'ok');
      const scopeName = scope.key === 'global' ? '' : projectNameOf(scope);
      const shown = hits.map((item) => ({
        ...view.toModelView(item, 'search', { status: item.status || (item.archived ? 'archived' : 'ok') }),
        scopeName: item.scope === 'global' ? '' : scopeName,
      }));
      const valueOf = (kept) => {
        const rendered = renderIndex(shown.slice(0, kept));
        return { count: kept, chars: rendered.chars, text: rendered.text, status: 'ok', refs: refsOf(hits.slice(0, kept)) };
      };
      /** 有匹配但当前用不上：只说状态，不把标题、编号或旧规则递给模型，避免它被这些字面带偏。 */
      if (!hits.length && withheld.length) {
        const unresolved = withheld.some((item) => item.status === 'needs_context');
        const value = {
          count: 0,
          chars: 0,
          text: unresolved
            ? '有相关的项目记忆，但适用条件还没确认。先说明当前任务，或确认这条记忆的适用范围。'
            : '有相关的项目记忆，但当前任务明确不适用。',
          status: unresolved ? 'needs_context' : 'ok',
          reasonCode: unresolved ? 'applicability_unresolved' : 'not_applicable',
          noTriggerReason: unresolved ? '适用条件未确认' : '当前任务不适用',
          refs: [],
        };
        if (win) {
          const bytes = jsonBytes(value);
          if (!affordableTool(win, bytes)) return { ...value, status: 'budget_exhausted', text: '' };
          win.bytes += bytes;
          win.toolBytes += bytes;
          win.reads += 1;
        }
        return value;
      }
      /** 没命中是正常结果，不是额度问题；空响应同样记一次本请求开销。 */
      if (!hits.length) {
        const empty = { count: 0, chars: 0, text: '', status: 'ok', reasonCode: 'no_match', noTriggerReason: '没有匹配的记忆', refs: [] };
        if (win) {
          const bytes = jsonBytes(empty);
          if (!affordableTool(win, bytes)) return { ...empty, status: 'budget_exhausted' };
          win.bytes += bytes;
          win.toolBytes += bytes;
          win.reads += 1;
        }
        return empty;
      }
      if (win) {
        let kept = shown.length;
        while (kept > 0 && !affordableTool(win, jsonBytes(valueOf(kept)))) kept -= 1;
        if (kept === 0) return { count: 0, chars: 0, text: '', status: 'budget_exhausted', refs: [] };
        const value = valueOf(kept);
        win.bytes += jsonBytes(value);
        win.toolBytes += jsonBytes(value);
        win.reads += 1;
        recordCitations(scope, sessionIdOf(execution), hits.slice(0, kept));
        markUsed(scope, hits.slice(0, kept).map((item) => item.id));
        return value;
      }
      const value = valueOf(shown.length);
      recordCitations(scope, sessionIdOf(execution), hits);
      markUsed(scope, hits.map((item) => item.id));
      return value;
    },
  }), 'lite-memory: memory_search');

  ctx.effect(() => tools.register({
    name: 'memory_read',
    description: '读一条记忆的正文。搜索结果里只有一行摘要，需要细节时按标题读。索引里还有、正文文件丢了会直接报错，不会返回空正文。',
    parameters: READ_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          when: { type: 'string' },
          revision: { type: 'integer' },
          scope: { type: 'string' },
          scopeName: { type: 'string' },
          origin: { type: 'string', enum: ['user_explicit', 'model_drafted', 'project_evolution'] },
          kind: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'archived', 'needs_context', 'not_applicable', 'gone', 'budget_exhausted', 'memory_disabled'] },
          body: { type: 'string' },
          links: { type: 'string' },
          repeat: { type: 'boolean' },
        },
        required: ['scope', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'budget_exhausted'
          ? 'memory · 这条消息已停止读记忆，下一条消息再读'
          : value.status === 'memory_disabled'
            ? 'memory · 记忆检索已关闭'
            : value.repeat
              ? 'memory · 本请求已读过这条记忆'
              : value.body
                ? `memory · ${withTag(value, `「${value.title}」`)}${value.when ? `（${value.when}）` : ''}${statusLabel(value.status)}\n${value.body}`
                : value.links !== undefined && value.status === 'ok'
                  ? `memory · 「${value.title}」的相关记忆\n${value.links || '(无)'}`
                  : value.status === 'needs_context'
                    ? 'memory · 这条记忆的适用条件还没确认，先说明当前任务再读'
                    : value.status === 'not_applicable'
                      ? 'memory · 这条记忆不适用于当前任务'
                      : value.status === 'archived'
                        ? 'memory · 这条记忆已归档'
                        : value.status === 'gone'
                          ? 'memory · 这条记忆已不存在'
                          : 'memory · 当前不能读这条记忆',
      }],
      presentationMeta: (_args, value) => ({
        kind: 'memory-read',
        title: value.title || '',
        scope: value.scope || '',
        revision: value.revision || 0,
        origin: originOut(value.origin),
        recordKind: typeof value.kind === 'string' && value.kind ? value.kind : '',
        status: value.status || 'ok',
      }),
    },
    execute: async (args, execution) => {
      if (!memoryEnabledFor(execution) || modeFor(scopeOf(cwdOf(execution))) === 'off') return { scope: '', status: 'memory_disabled' };
      const resolved = resolveRequestContext(execution, args.contextId);
      if (!resolved.ok) return { scope: '', status: resolved.status || 'needs_context' };
      const scope = resolved.scope;
      const scopeName = scope.key === 'global' ? '' : projectNameOf(scope);
      /** 明确指定层时只在那一层解析标题，同名条目不会串到别的层。 */
      const readScope = args.scope === 'global' ? globalScope() : scope;
      const context = resolved.context;
      const allowExperimental = resolved.experimental === true;
      const agent = execution?.agent;
      const win = windowOf(agent);
      const gateRuntime = resolved.held || win?.runtime
        || { projectId: scope.key, context, experimental: resolved.experimental === true };
      if (args.view === 'links') {
        const refId = refIdOf(readScope, args);
        const source = locate(readScope, refId);
        const gateOk = !source || view.eligibility(source.record, gateRuntime, 'read').ok;
        if (!gateOk) return { scope: '', status: 'needs_context', links: '' };
        const found = readLinks(readScope, refId, { context, allowExperimental, runtime: gateRuntime, now: Date.now() });
        if (!found) throw new Error(`没有「${String(args.title || args.id || '').trim()}」这条记忆`);
        if (found.status !== 'ok') {
          const withheld = { scope: '', status: found.status, links: '' };
          if (win) {
            const bytes = jsonBytes(withheld);
            if (!affordableTool(win, bytes)) return { scope: '', status: 'budget_exhausted' };
            win.bytes += bytes;
            win.toolBytes += bytes;
            win.reads += 1;
          }
          return withheld;
        }
        const rows = found.links.filter((link) => link.status === 'invalid' || link.status === 'ok')
          .map((link) => (link.status === 'invalid'
          ? '- 有一条已失效'
          : `- ${link.scope === 'global' ? '[global] ' : (scopeName ? `[${scopeName}] ` : '')}「${link.title}」`));
        const text = rows.join('\n') || '(无)';
        const value = { title: found.title || '', scope: found.scope, scopeName, status: found.status, links: text };
        if (win) {
          const bytes = jsonBytes(value);
          if (!affordableTool(win, bytes)) return { scope: '', status: 'budget_exhausted' };
          win.bytes += bytes;
          win.toolBytes += bytes;
          win.reads += 1;
        }
        return value;
      }
      const record = readEntry(readScope, refIdOf(readScope, args), {
        layers: args.scope ? [readScope] : undefined,
        context,
        allowExperimental,
        /** 只有真正把正文交出去的读取才算用过：条件未知/被取代/过期不更新使用记录。 */
        usage: (item) => view.eligibility(item, gateRuntime, 'read').ok,
      });
      if (!record) throw new Error(`没有「${String(args.title || args.id || '').trim()}」这条记忆`);
      /** 归档条目还能按标题找到：只回状态，不交正文，也不把它当成「不存在」。 */
      if (record.status === 'archived') return { title: record.title, scope: record.scope, status: 'archived', body: '' };
      const gate = view.eligibility(record, gateRuntime, 'read');
      if (!gate.ok) return { scope: record.scope, status: gate.status, body: '' };
      /** 条件未知或不适用的条目只报状态：标题只能定位，不能证明适用，正文一律不先返回。 */
      if (record.status !== 'ok' && record.status !== 'archived') {
        return { scope: record.scope, status: record.status === 'needs_context' ? 'needs_context' : 'not_applicable', body: '' };
      }
      const revision = record.revision || 1;
      const body = String(record.body ?? '');
      /** 空正文只回标题与状态：没有正文可交付，就不占正文额度、不算引用。 */
      const hasBody = body.trim() !== '';
      const value = {
        title: record.title,
        when: record.when || '',
        revision,
        scope: record.scope,
        scopeName,
        status: record.status,
        kind: record.kind || 'note',
        /** 来源随正文回执一起给：模型整理稿要能标出来，但不会因此变成全局。 */
        origin: originOut(record.origin),
        body,
      };
      if (win) {
        if (!affordableTool(win, 0)) return { scope: '', status: 'budget_exhausted' };
        const seenRevision = win.readBodies.get(record.id);
        if (seenRevision === revision) {
          const receipt = { ...value, body: '', repeat: true };
          const bytes = jsonBytes(receipt);
          if (!affordableTool(win, bytes)) return { scope: '', status: 'budget_exhausted' };
          win.bytes += bytes;
          win.toolBytes += bytes;
          win.reads += 1;
          return receipt;
        }
        const bytes = jsonBytes(value);
        if (!affordableTool(win, bytes, hasBody ? 1 : 0)) return { scope: '', status: 'budget_exhausted' };
        win.bytes += bytes;
        win.toolBytes += bytes;
        if (hasBody) win.bodies += 1;
        win.reads += 1;
        if (hasBody) win.readBodies.set(record.id, revision);
      }
      if (hasBody) recordCitations(scope, sessionIdOf(execution), [record]);
      return value;
    },
  }), 'lite-memory: memory_read');

  ctx.effect(() => tools.register({
    name: 'memory_forget',
    description: '把一条记忆移入归档（不是彻底删除，正文与记录都留在 archive/，可人工取回）。只在用户明确说「别记这个 / 删掉那条」时用。',
    parameters: FORGET_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          scope: { type: 'string' },
          scopeName: { type: 'string' },
          mode: { type: 'string', enum: ['archive', 'purged', 'needs_resolution', 'purge_pending', 'memory_disabled'] },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'memory_disabled'
          ? 'memory · 本项目记忆已关闭，先在面板打开'
          : value.mode === 'purged'
          ? `memory · forgotten "${value.title}"`
          : value.mode === 'purge_pending'
            ? `memory · 清除未完成 · 「${value.title || '这条记忆'}」，重启后会继续`
            : value.mode === 'needs_resolution'
              ? `memory · 先确认是归档还是彻底忘掉 · 「${value.title || '这条记忆'}」`
              : `memory · archived ${withTag(value, `"${value.title}"`)}，可找回`,
      }],
      presentationMeta: (_args, value) => ({
        kind: 'memory-forget',
        title: value.title || '',
        scope: value.scope || '',
        mode: value.mode,
      }),
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const projectScopeName = projectNameOf(scope);
      if (!memoryEnabled(scope)) return { title: '', scope: '', mode: 'memory_disabled' };
      const forgetTitle = String(args.title || args.id || '').trim();
      if (!args.scope && args.mode) {
        const candidates = titleCandidates(scope, forgetTitle);
        if (candidates.length > 1) {
          throw new Error(`「${forgetTitle}」在项目层和全局层各有一条：删全局加 scope="global"，删项目加 scope="project"`);
        }
      }
      const onlyLayer = args.scope === 'global' ? globalScope() : args.scope === 'project' ? scope : null;
      const refId = refIdOf(scope, args);
      const located = locate(scope, refId, onlyLayer ? { layers: [onlyLayer] } : {});
      if (!located && !args.mode) throw new Error(`没有「${String(args.title || args.id || '').trim()}」这条记忆`);
      if (!args.mode) {
        return { title: located.record.title || '', mode: 'needs_resolution', scope: located.scope.key === 'global' ? 'global' : 'project' };
      }
      let dropped;
      try {
        dropped = forget(scope, refId, onlyLayer ? { mode: args.mode, layers: [onlyLayer] } : { mode: args.mode });
      } catch (error) {
        if (error && error.code === 'purge_pending') {
          const layer = located ? located.scope : scope;
          try {
            state.resumePurge(layer);
            dropped = forget(scope, refId, onlyLayer ? { mode: args.mode, layers: [onlyLayer] } : { mode: args.mode });
          } catch (again) {
            if (again && again.code === 'purge_pending') {
              return {
                title: located ? located.record.title : '',
                mode: 'purge_pending',
                scope: layer.key === 'global' ? 'global' : 'project',
                scopeName: layer.key === 'global' ? '' : projectScopeName,
              };
            }
            throw again;
          }
        } else {
          throw error;
        }
      }
      if (!dropped) throw new Error(`没有「${String(args.title || args.id || '').trim()}」这条记忆`);
      const layerKey = dropped.scopeKey || (located ? located.scope.key : scope.key);
      if (dropped.mode === 'purged') revokeLearningUse(layerKey);
      return {
        title: dropped.title || (located ? located.record.title : ''),
        mode: dropped.mode,
        scope: layerKey === 'global' ? 'global' : 'project',
        scopeName: layerKey === 'global' ? '' : projectScopeName,
      };
    },
  }), 'lite-memory: memory_forget');

  /** 「保留」「✕」按钮与统计都挂在 WebServer 上；没有该服务时工具照常可用。 */
  const mountRoute = (holder) => {
    const webServer = holder.webServer ?? holder;
    if (!webServer || typeof webServer.register !== 'function' || typeof webServer.getOrigin !== 'function') return;
    const cwdForSession = (sessionId) => {
      const sessions = getService('sessions');
      if (!sessions || typeof sessions.get !== 'function') return '';
      try {
        const cwd = sessions.get(sessionId)?.header?.cwd;
        return typeof cwd === 'string' ? cwd : '';
      } catch {
        return '';
      }
    };
    holder.effect(() => webServer.register({ kind: 'prefix', path: REMOTE_PATH, handler: keepHandler(webServer, cwdForSession) }), 'lite-memory: keep route');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (scope) => mountRoute(scope));
  else mountRoute(ctx);

  /**
   * 自动召回：provider 在加载时注册一次，pre-step 拿到这次请求的准备结果后填充。
   * provider 只读内存快照；没准备好就返回空字符串，不注入任何东西。
   */
  const prompt = getService('systemPrompt');
  if (prompt && typeof prompt.context === 'function') {
    ctx.effect(() => prompt.context({
      name: 'lite-memory:recall',
      order: 60,
      interpolate: false,
      required: false,
      text: (holder) => recallText(holder),
    }), 'lite-memory: recall context');
  }

  /**
   * 只有人在这句话里明确要求「存到全局/所有项目」才算跨项目授权。
   * 不能因为句子里同时出现「全局」和「保存」就放行：那可能只是在说全局变量。
   */
  const humanAskedGlobal = (said) => {
    const text = String(said || '');
    return /(?:存|记|写|放|加|保存|放到|记到|写进).{0,10}(?:全局|所有项目|跨项目)/u.test(text)
      || /(?:全局|所有项目|跨项目).{0,10}(?:都|一律|通用|适用|记住)/u.test(text)
      || /(?:以后|今后).{0,16}(?:所有项目|每个项目|全局|跨项目)/u.test(text);
  };

  /**
   * npm 原生命令最容易把「没登录」误判成「没凭据」：whoami 报 ENEEDAUTH 之后，
   * 会话常会反复试 login/token，真正该走的 dsh-npm 反而没人提。
   * 这里只在动作发生前拦一次，把已有记忆正文直接交给模型；同一轮不重复，不产生循环。
   */
  const npmProbeHint = (agent, execution) => {
    try {
      const name = String(execution?.name || '');
      if (!/^(bash|run_command|shell|terminal|exec)$/.test(name)) return undefined;
      const command = String(execution?.arguments?.command || execution?.arguments?.cmd || execution?.arguments?.input || '');
      if (!command || command.length > 4000 || !/\bnpm\b/.test(command)) return undefined;
      if (/dsh-npm/.test(command)) return undefined;
      if (!/(^|[;&|]\s*)(?:sudo\s+)?npm\s+(?:whoami|publish|login|adduser|add-user|token|config\s+get)\b/.test(command)) return undefined;
      const held = prepared.get(agent);
      if (!held || held.npmHinted) return undefined;
      if (!memoryOnForAgent(agent)) return undefined;
      /** 本机流程按规矩留在项目层；全局层是兜底，先看当前项目再看全局。 */
      const scopes = [];
      try {
        const project = scopeOf(cwdOf({ agent }));
        if (project && project.confirmed !== false && project.key !== 'global') scopes.push(project);
      } catch { /* 项目根还没确认时只看全局 */ }
      scopes.push(globalScope());
      const row = scopes.flatMap((scope) => {
        try { return loadIndex(scope).entries || []; } catch { return []; }
      }).find((entry) => {
        if (!entry || entry.archived || entry.origin === 'project_evolution') return false;
        /** 过期/被取代的规则不能再在动作前拦人。 */
        if (view.lifecycleStatusOf(entry)) return false;
        if (held.deliveredIds instanceof Set && held.deliveredIds.has(entry.id)) return false;
        const head = `${entry.title || ''} ${entry.summary || ''} ${(entry.tags || []).join(' ')}`;
        const body = String(entry.body || '').slice(0, 800);
        return /npm|dsh-npm/i.test(head)
          && /(凭据|登录|token|whoami|发布|publish|ENEEDAUTH|Keychain)/i.test(`${head} ${body}`);
      });
      if (!row) return undefined;
      held.npmHinted = true;
      /** 这条正文真的交给模型了，按交付记使用。 */
      if (!(held.deliveredIds instanceof Set)) held.deliveredIds = new Set();
      if (row.id) held.deliveredIds.add(row.id);
      const body = String(row.body || row.summary || '').trim().slice(0, 600);
      return `[lite-memory] 这条 npm 命令先别执行：它容易被登录态误导。已有记忆「${row.title}」：${body}\n按记忆改用 dsh-npm；这条提示同一轮只出现一次，直接继续，不要重复探测凭据。`;
    } catch {
      return undefined;
    }
  };

  /** 执行入口再拦一次：工具若已出现在旧快照里，调用时也不放行。 */
  if (typeof ctx.on === 'function') ctx.on('agent/created', (payload) => {
    const agent = payload?.agent;
    if (!agent?.ctx?.tools) return;
    try {
      agent.ctx.effect(() => agent.ctx.tools.guard((execution) => {
        if (MEMORY_TOOLS.includes(execution?.name)) {
          return memoryOnForAgent(agent) ? undefined : '本项目记忆已关闭，先在面板打开';
        }
        return npmProbeHint(agent, execution);
      }), 'lite-memory: tool guard');
    } catch { /* older host without guards */ }
    syncMemoryTools(agent);
  });

  if (typeof ctx.on === 'function') ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent;
    syncMemoryTools(agent);
    let decision;
    try {
      decision = await next();
    } catch (error) {
      clearPrepared(agent);
      throw error;
    }
    /** 宿主等待不算本地召回时间：额度从拿到这一步的开始算。 */
    const startedAt = Date.now();
    try {
      if (!agent || decision?.kind !== 'enter') {
        clearPrepared(agent);
        return decision;
      }
      const signal = payload?.signal;
      if (signal?.aborted) {
        clearPrepared(agent);
        return decision;
      }
      const sessionId = String(agent?.session?.id ?? '');
      if (!sessionId) {
        clearPrepared(agent);
        return decision;
      }
      const generation = (generations.get(agent) || 0) + 1;
      generations.set(agent, generation);
      const turn = String(payload?.turn ?? payload?.step?.turn ?? payload?.turnIndex ?? '');
      const humans = (Array.isArray(decision.messages) ? decision.messages : [])
        .filter((message) => message?.source?.kind === 'user');
      const fresh = freshHumans(sessionId, humans);
      const previous = prepared.get(agent);
      if (fresh.length > 0 && previous) flushUsage(previous);
      const sameSession = Boolean(previous && previous.sessionId === sessionId);
      const sessionTask = recallTasks.get(sessionId) || null;

      if (fresh.length === 0) {
        /** 工具续步：内容冻结，只把快照绑到本步的 signal；盘上版本变了才重投影。 */
        const turnChanged = !!(turn && previous?.turn && turn !== previous.turn);
        if (!sameSession || turnChanged) {
          clearPrepared(agent);
          return decision;
        }
        previous.signal = signal;
        const scope = scopeOf(cwdOf({ agent }));
        if (!memoryEnabled(scope)) {
          clearPrepared(agent);
          return decision;
        }
        const fingerprint = fingerprintOf(scope);
        /** 指纹拿不到就当作已失效：不拿旧任务内容硬撑这一步。 */
        if (!fingerprint) {
          clearPrepared(agent);
          return decision;
        }
        if (fingerprint !== previous.fingerprint) {
          const win = windowOf(agent);
          if (win) win.autoBudget = emptyAutoBudget();
          const snapshot = projectRecall(scope, previous.query, win && win.runtime ? win.runtime.context : view.trustedContext(scope, {}), win, win && win.runtime ? win.runtime : null);
          let experimentText = '';
          if (win && win.experiment) {
            experimentText = renderExperiment(scope, win.experiment.decision, win.experiment.context, win.experiment, win);
          }
          if (generation === generations.get(agent) && !signal?.aborted) {
            if (snapshot || experimentText) {
              previous.text = snapshot ? snapshot.text : '';
              previous.cards = snapshot ? snapshot.cards : [];
              previous.lines = snapshot ? snapshot.lines : [];
              previous.experimentText = experimentText;
              previous.experimentParts = win && win.experiment ? (win.experiment.experimentParts || null) : null;
              previous.validUntil = win && win.experiment ? (win.experiment.validUntil || '') : '';
              previous.fingerprint = fingerprint;
            } else {
              clearPrepared(agent);
            }
          }
        }
        /**
         * 工具续步里没有新的真人原话，但刚执行的动作本身就是线索。
         * 只补一次、共用一个请求额度，补到的卡片追加到已发布快照，超出仍由预算挡。
         */
        const stepMessages = Array.isArray(decision.messages) ? decision.messages : [];
        const seenIds = previous.seenIds instanceof Set ? previous.seenIds : new Set(previous.seenIds || []);
        const stepActions = stepMessages.filter((message) => {
          const id = String(message?.id ?? '');
          return id ? !seenIds.has(id) : false;
        });
        previous.seenIds = new Set([...seenIds, ...stepMessages.map((message) => String(message?.id ?? '')).filter(Boolean)].slice(-64));
        previous.seenMessages = stepMessages.length;
        /** 只读文件、搜索、记忆工具都不算动作；一次请求最多补查一次。 */
        const actionQuery = previous.recalledContext && !previous.actionRetried
          && view.hasEffectiveAction(stepActions)
          ? view.actionTerms(stepActions, { limit: 10 }).slice(0, 240) : '';
        if (actionQuery) {
          previous.actionRetried = true;
          const win = windowOf(agent);
          if (win && generation === generations.get(agent) && !signal?.aborted) {
            const nextQuery = `${actionQuery} ${previous.query}`.trim().slice(0, RECALL_QUERY_CHARS);
            const retry = projectRecall(scope, nextQuery, previous.recalledContext, win, previous.runtimeHeld || null);
            if (retry.cards.length) {
              /** 补查结果整体替换展示快照；账本与正文来自同一次准入。 */
              previous.text = retry.text;
              previous.cards = retry.cards;
              previous.lines = retry.lines;
              previous.query = nextQuery;
              previous.matched = retry.matched || retry.cards.length;
              if (win) win.query = nextQuery;
            }
          }
        }
        return decision;
      }

      /** 工具模式也要开额度窗口：只是不自动注入，工具调用同样受每请求预算约束。 */
      const ids = fresh.map((message) => String(message?.id ?? '')).filter(Boolean).sort();
      const win = openWindow(agent, { sessionId, turn, messageIds: ids });
      const budgetBefore = win ? {
        bytes: win.bytes, bodies: win.bodies, reads: win.reads, toolBytes: win.toolBytes || 0,
        provided: new Map(win.provided), readBodies: new Map(win.readBodies),
        recallHeader: win.recallHeader, experimentBytes: win.experimentBytes,
        autoBudget: win.autoBudget ? JSON.parse(JSON.stringify(win.autoBudget)) : null,
      } : null;
      /** 工具模式也要记下本轮真人原话：只用于核对绑定，不自动注入。 */
      const said = view.newestUserQuery(fresh).slice(0, RECALL_QUERY_CHARS);
      const continuationHint = view.isContinuationQuery(said) || view.isEllipticalContinuation(said);
      /** 「继续」这类续说没有检索词：带上同会话上一轮原话，否则这一轮必然召回为空。 */
      const carried = continuationHint
        ? (sessionTask?.taskQuery || previous?.query || sessionTask?.query || '') : '';
      let query = (carried ? `${said} ${carried}` : said).trim().slice(0, RECALL_QUERY_CHARS);
      if (win && query) win.query = query;

      if (!query) {
        clearPrepared(agent);
        return decision;
      }
      const cwd = cwdOf({ agent });
      if (typeof cwd !== 'string' || !cwd) {
        clearPrepared(agent);
        return decision;
      }
      const scope = scopeOf(cwd);
      if (!memoryEnabled(scope)) {
        noteRecall(scope, sessionId, { reason: 'memory_off' });
        clearPrepared(agent);
        return decision;
      }
      const batchKey = anchor.requestBatchKey(ids);
      /**
       * 工具模式也必须先有本请求上下文：memory_search/read/links 靠同一个 contextId 判项目和任务，
       * 不能等到自动召回分支才建，否则工具模式永远拿不到可核对的任务。
       */
      const runtime = runtimeFor(scope, { sessionId, query, batchKey, messageIds: ids, autoRoute: modeFor(scope) === 'adaptive' });
      if (win && runtime) win.runtime = runtime.held;
      rememberRuntime(scope, sessionId, runtime && runtime.held);
      if (modeFor(scope) !== 'adaptive') {
        noteRecall(scope, sessionId, { reason: 'tools_only' });
        clearPrepared(agent);
        return decision;
      }
      const context = view.trustedContext(scope, {});
      const fingerprint = fingerprintOf(scope);
      const controlEpoch = controlStatus(scope).epoch || '';
      dropStaleCandidate(sessionId, batchKey);
      /** 任务上下文独立于自进化开关：普通记忆按当前任务判适用，实验规则再叠一层可用性。 */
      const auto = emptyAutoBudget();
      if (win) win.autoBudget = auto;
      const recalledContext = runtime ? runtime.held.context : context;
      const remembered = runtime && runtime.enabled
        ? rememberFeedback(scope, sessionId, fresh, runtime.held, turn)
        : null;
      const currentTask = {
        kind: (runtime && runtime.held && runtime.held.task && runtime.held.task.kind) || '',
        episodeId: (runtime && runtime.held && runtime.held.episodeId) || '',
      };
      const rememberedTask = lastTask.get(sessionId) || null;
      const previousTask = (previous && previous.task) || (sessionTask && sessionTask.task) || rememberedTask;
      const previousText = (previous && previous.query) || (sessionTask && sessionTask.query) || '';
      const previousSaid = (previous && previous.saidOnly) || (sessionTask && sessionTask.saidOnly) || '';
      const sameQuery = Boolean(previousSaid && said && previousSaid === said);
      const sameTask = Boolean(sameSession || sessionTask || rememberedTask)
        && !view.isExplicitSwitch(said, previousText)
        && view.sameRecallTask(previousTask, currentTask, { continuation: continuationHint, sameQuery });
      const taskStartMessageId = sameTask && sessionTask && sessionTask.startMessageId
        ? sessionTask.startMessageId : ids[0];
      lastTask.set(sessionId, currentTask);
      recallTasks.set(sessionId, {
        query,
        saidOnly: said,
        /** 当前任务的稳定原话：续说只拼这一份，不把上一轮的动作线索越滚越长。 */
        taskQuery: sameTask ? (sessionTask?.taskQuery || carried || said) : said,
        task: currentTask,
        startMessageId: taskStartMessageId,
        updatedAt: Date.now(),
      });
      while (lastTask.size > 64) lastTask.delete(lastTask.keys().next().value);
      while (recallTasks.size > 64) recallTasks.delete(recallTasks.keys().next().value);
      /**
       * 预防型记忆约束的是「下一步动作」，词面常写在上一轮助手的话和工具调用里，用户这句话反而没提。
       * 续句或没有具体动作的短问句，直接把最近的动作线索并进同一份查询：只查一次，不额外占预算。
       * 明确换任务时不并，旧任务的动作历史不能给新任务找记忆。
       */
      const humanTail = (() => {
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i]?.source?.kind === 'user') return messages.slice(0, i);
        }
        return messages;
      })();
      /** 只拿当前任务开始之后的消息，旧任务的工具痕迹不能混进新任务。 */
      const taskStart = taskStartMessageId
        ? decision.messages.findIndex((message) => String(message?.id ?? '') === taskStartMessageId) : -1;
      const tailMessages = sameTask && taskStart >= 0 ? decision.messages.slice(taskStart + 1) : humanTail;
      const trail = sameTask ? view.actionTerms(tailMessages, { limit: 12 }).slice(0, 240) : '';
      const trailInQuery = Boolean(trail) && (Boolean(carried) || !view.hasConcreteAction(said));
      if (trailInQuery) {
        query = `${query} ${trail}`.trim().slice(0, RECALL_QUERY_CHARS);
        if (win) win.query = query;
      }
      let snapshot = projectRecall(scope, query, recalledContext, win, runtime ? runtime.held : null);
      /**
       * 并了动作线索仍一张卡都没有，才补一次有界查询。
       * 补到就用补查结果整体替换：两批卡片各量一次会绕过 3 条 / 1200 字节的共用额度。
       */
      if (!snapshot.cards.length && !carried && sameTask && trail && !trailInQuery) {
        const actionQuery = `${trail} ${query}`.trim().slice(0, RECALL_QUERY_CHARS);
        const retry = projectRecall(scope, actionQuery, recalledContext, win, runtime ? runtime.held : null);
        if (retry.cards.length) {
          snapshot = retry;
          query = actionQuery;
          if (win) win.query = actionQuery;
        }
      }
      /** 实验规则最后才取预算：普通卡片先占，弱相关实验不能把强相关项目规则挤出去。 */
      const experiment = runtime ? experimentFor(scope, runtime, win) : null;
      noteRecall(scope, sessionId, {
        reason: snapshot.reason, matched: snapshot.matched, cards: snapshot.cards.length, chars: snapshot.bytes,
      });
      /** 没发布出去的投影要退还额度：不能因为一次超时把本请求的召回额度耗掉。 */
      const rollbackBudget = () => {
        if (!win || !budgetBefore) return;
        win.bytes = budgetBefore.bytes;
        win.bodies = budgetBefore.bodies;
        win.reads = budgetBefore.reads;
        win.toolBytes = budgetBefore.toolBytes;
        win.provided = budgetBefore.provided;
        win.readBodies = budgetBefore.readBodies;
        win.recallHeader = budgetBefore.recallHeader;
        win.experimentBytes = budgetBefore.experimentBytes;
        win.autoBudget = budgetBefore.autoBudget || emptyAutoBudget();
        win.experiment = null;
        win.contexts.clear();
      };
      if (generation !== generations.get(agent)) { rollbackBudget(); if (snapshot.cards.length) clearRecall(scope, sessionId); return decision; }
      /** 投影期间开关被改过：丢弃这批内容，不把关闭前的记忆交给当前请求。 */
      if (!memoryEnabled(scope) || (controlStatus(scope).epoch || '') !== controlEpoch) {
        rollbackBudget();
        if (snapshot.cards.length) clearRecall(scope, sessionId);
        clearPrepared(agent);
        return decision;
      }
      /** 超时或被取消：这一步不留半旧卡片，下一真人请求重新投影。 */
      if (signal?.aborted || Date.now() - startedAt > recallDeadlineMs) {
        rollbackBudget();
        if (snapshot.cards.length) clearRecall(scope, sessionId);
        clearPrepared(agent);
        return decision;
      }
      /**
       * 零命中也要保留请求状态：这一轮第一步没命中，下一步的动作仍可能触发一次补查。
       * 展示快照为空即可，不把任务身份和额度窗口一起丢掉。
       */
      let evolutionEpoch = '';
      try { evolutionEpoch = String(evolutionStatus(scope).epoch || ''); } catch { evolutionEpoch = ''; }
      const state = {
        text: snapshot && snapshot.cards.length ? snapshot.text : '',
        experimentText: experiment ? experiment.text : '',
        experimentParts: experiment && experiment.held ? (experiment.held.experimentParts || null) : null,
        validUntil: experiment && experiment.held ? (experiment.held.validUntil || '') : '',
        cards: snapshot ? snapshot.cards : [],
        lines: snapshot ? snapshot.lines : [],
        matched: snapshot ? snapshot.matched : 0,
        task: currentTask,
        scope,
        query,
        saidOnly: said,
        sessionId,
        turn,
        signal,
        fingerprint,
        controlEpoch,
        evolutionEpoch,
        recalledContext,
        runtimeHeld: runtime && runtime.held ? runtime.held : null,
        seenMessages: Array.isArray(decision.messages) ? decision.messages.length : 0,
        seenIds: Array.isArray(decision.messages) ? decision.messages.map((message) => String(message?.id ?? '')).filter(Boolean).slice(-64) : [],
        actionRetried: false,
        deliveredIds: new Set(),
        at: Date.now(),
      };
      prepared.set(agent, state);
      /** 真正输出给模型时才算使用；准备阶段被丢弃/中止的快照不能改 lastUsed。 */
      payloadBytes.set(sessionId, win.bytes);
      while (payloadBytes.size > 64) payloadBytes.delete(payloadBytes.keys().next().value);
      if (signal) signalAgents.set(signal, agent);
      const key = agentKey(agent);
      if (key && signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => { clearPrepared(agent); clearRecall(scope, sessionId); };
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanups.set(key, () => signal.removeEventListener('abort', onAbort));
      }
    } catch {
      clearPrepared(agent);
    }
    return decision;
  });


  /* ---------------- 项目自进化：一次短整理，先扣频次，再走提交门禁 ---------------- */

  /** 只清不属于当前这批人类消息的旧候选：新一轮开始后，上一轮没整理完的反馈不能再落盘。 */
  function dropStaleCandidate(sessionId, batchKey) {
    const prior = feedbackCandidates.get(sessionId);
    if (prior && prior.candidate && prior.candidate.batchKey !== batchKey) {
      feedbackCandidates.delete(sessionId);
    }
  }

  /**
   * 反馈只来自本轮真人消息；初始任务、工具成功、沉默都不算。
   * 解析目标由整理器完成：不在这里暂停所有已注入规则，避免一次 BGM 纠正打掉开头和字幕。
   */
  function rememberFeedback(scope, sessionId, messages, held, turn) {
    let candidate;
    try {
      candidate = learning.candidateFrom({
        messages, anchor: held.anchor, sessionId, projectId: scope.key, now: Date.now(),
      });
    } catch { return null; }
    if (!candidate) return null;
    candidate.cwd = scope.cwd;
    candidate.episodeUpdatedAt = held.episodeUpdatedAt || '';
    candidate.batchKey = held.batchKey || '';
    candidate.turn = String(turn || '');
    const revision = (feedbackRevisions.get(scope.key) || 0) + 1;
    feedbackRevisions.set(scope.key, revision);
    candidate.feedbackRevision = revision;
    const prior = feedbackCandidates.get(sessionId);
    feedbackCandidates.set(sessionId, {
      scope,
      candidate,
      held,
      session: prior && prior.session ? prior.session : null,
      queued: Boolean(prior && prior.queued),
      at: Date.now(),
    });
    while (feedbackCandidates.size > 8) feedbackCandidates.delete(feedbackCandidates.keys().next().value);
    return { candidate };
  }

  /** 只认前台最近一次真实请求的路线；拿不到就宁可这次不整理。 */
  function routeForSession(session) {
    let config;
    try { config = session && typeof session.requestHeader === 'function' ? session.requestHeader()?.config : null; } catch { config = null; }
    const provider = config && typeof config.provider === 'string' ? config.provider : '';
    const model = config && typeof config.model === 'string' ? config.model : '';
    return provider && model ? { provider, model } : null;
  }

  function sessionIdOfSession(session) {
    try { return String(session?.header?.id ?? session?.id ?? ''); } catch { return ''; }
  }

  function scopeOfSession(session) {
    let cwd = '';
    try { cwd = String(session?.header?.cwd ?? ''); } catch { cwd = ''; }
    if (!cwd) return null;
    const scope = scopeOf(cwd);
    return scope && scope.confirmed ? scope : null;
  }

  /** 有配额才调用；输出整批校验，提交门禁再复核开关、版本、来源与目标。 */
  async function organize(scope, session, pending) {
    const status = evolutionStatus(scope);
    if (!status || status.enabled !== true || status.compatible === false) return;
    if (status.policyVersion !== learning.POLICY_VERSION) return;
    const route = routeForSession(session);
    if (!route) return;
    const candidate = pending.candidate;
    /** 候选进入整理前再走一次统一准入：项目/作品身份、作用域与反馈类型都对上才花配额。 */
    const admission = learning.admissionOf(candidate, {
      projectId: scope.key,
      sessionId: candidate.sessionId,
      anchor: pending.held?.anchor || null,
    }, 'collect');
    if (!admission || admission.ok !== true) return;
    const operationId = `learn_${crypto.createHash('sha256')
      .update(`${scope.key}|${candidate.episodeId}|${candidate.messageIds.join(',')}`)
      .digest('hex').slice(0, 16)}`;
    /** 没有可用模型就别先扣滚动额度：扣了却发不出调用，额度会白烧一整窗口。 */
    const llm = getService('llm');
    if (!llm || typeof llm.prepareCall !== 'function') return;
    const begin = beginLearningAttempt(scope, { episodeId: candidate.episodeId, operationId: `${operationId}_start`, now: Date.now() });
    if (!begin || begin.ok !== true || begin.replayed) return;
    const ranges = rangesOf(scope);
    const input = learning.buildCallInput({
      projectId: scope.key,
      episodeId: candidate.episodeId,
      taskKind: candidate.taskKind,
      seriesId: candidate.seriesId,
      phase: candidate.phase,
      feedback: candidate,
      rules: begin.rules,
      ranges,
    });
    const preparedTargets = (begin.rules || []).map((record) => ({
      id: record.id,
      revision: record.revision || 1,
      specDigest: learning.specDigestOf(record),
    }));
    const controller = new AbortController();
    learningAborts.set(scope.key, controller);
    const deadline = setTimeout(() => { try { controller.abort(); } catch { /* already aborted */ } }, learning.LIMITS.timeoutMs);
    const chunks = [];
    let text = '';
    let sawTool = false;
    let finish = { kind: 'stop' };
    try {
      const call = await llm.prepareCall({ ...route, maxTokens: learning.LIMITS.maxTokens }, controller.signal);
      const options = {
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
        system: input.system,
        sessionId: sessionIdOfSession(session),
        purpose: 'project-evolution',
        signal: controller.signal,
      };
      for await (const chunk of call.stream(options)) {
        if (controller.signal.aborted) throw new Error('整理已取消');
        chunks.push(chunk);
        if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '');
        else if (chunk && chunk.type === 'tool-call-delta') sawTool = true;
        else if (chunk && chunk.type === 'block-start' && chunk.blockType === 'tool-call') sawTool = true;
        else if (chunk && chunk.type === 'finish' && chunk.reason) finish = chunk.reason;
      }
      if (sawTool) throw new Error('整理返回了工具调用');
      /** 运行期间用户又给了新反馈：旧结果不能覆盖新纠正，直接作废，等排队的下一次整理。 */
      if ((feedbackRevisions.get(scope.key) || 0) !== candidate.feedbackRevision) {
        throw new Error('反馈已更新，这轮结果没采用');
      }
      const parsed = learning.parseOutput(text, { finish, refs: input.refs, rules: input.rules, ranges, expectedTarget: candidate.expectedTarget });
      if (!parsed.ok) throw new Error(parsed.reason);
      /** 用户已经把要求说成长期规则，模型仍返回空时至少留一条规则，不让这条反馈无声消失。 */
      const changes = parsed.changes.length
        ? parsed.changes
        : (candidate.cue?.explicitLongTerm && candidate.cue?.type === 'spec_change'
          ? [learning.pendingChangeFrom(candidate)].filter(Boolean)
          : []);
      const commit = commitLearning(scope, {
        operationId,
        epoch: begin.epoch,
        episodeId: candidate.episodeId,
        episodeUpdatedAt: candidate.episodeUpdatedAt,
        projectId: scope.key,
        sessionId: candidate.sessionId,
        messageIds: candidate.messageIds,
        feedbackText: candidate.text,
        sourceExcerpt: candidate.sourceExcerpt || learning.sourceExcerptOf(candidate.text),
        dimension: candidate.cue?.dimension || '',
        changes,
        preparedTargets,
        usage: learning.usageOf(chunks),
        explicitLongTerm: Boolean(candidate.cue.explicitLongTerm),
        now: Date.now(),
      });
      if (commit && commit.ok === false) {
        recordLearningFailure(scope, {
          operationId: `${operationId}_fail`,
          episodeId: candidate.episodeId,
          reason: commit.reason,
          usage: learning.usageOf(chunks),
          epoch: begin.epoch,
        });
      }
    } catch (error) {
      const reason = controller.signal.aborted ? '整理已取消' : (error instanceof Error ? error.message : '整理没有完成');
      recordLearningFailure(scope, {
        operationId: `${operationId}_fail`,
        episodeId: candidate.episodeId,
        reason,
        usage: learning.usageOf(chunks),
        epoch: begin.epoch,
      });
    } finally {
      clearTimeout(deadline);
      if (learningAborts.get(scope.key) === controller) learningAborts.delete(scope.key);
    }
  }

  /** 启动一次整理；结束后再看同项目是否还排着一条候选。 */
  function startOrganizer(scope, session, pending) {
    const job = { controller: learningAborts.get(scope.key) || null };
    learningJobs.set(scope.key, job);
    void organize(scope, session, pending)
      .catch(() => { /* 整理失败不影响会话 */ })
      .finally(() => {
        if (learningJobs.get(scope.key) === job) learningJobs.delete(scope.key);
        drainOrganizer(scope.key);
      });
  }

  /** 彻底删除后中止该层在途整理并丢掉候选：不让旧结果复活已删规则。 */
  function revokeLearningUse(layerKey) {
    for (const [scopeKey, controller] of learningAborts) {
      if (layerKey !== 'global' && scopeKey !== layerKey) continue;
      try { controller.abort(); } catch { /* already settled */ }
    }
    for (const [sessionId, pending] of feedbackCandidates) {
      if (layerKey !== 'global' && pending?.scope?.key !== layerKey) continue;
      feedbackCandidates.delete(sessionId);
    }
  }

  /** 忙碌时保留一条最新候选，不丢用户刚说的纠正；同一项目仍只跑一个整理。 */
  function drainOrganizer(scopeKey) {
    if (learningJobs.has(scopeKey)) return;
    for (const [sessionId, pending] of feedbackCandidates) {
      if (!pending || !pending.scope || pending.scope.key !== scopeKey) continue;
      feedbackCandidates.delete(sessionId);
      if (!pending.session) return;
      startOrganizer(pending.scope, pending.session, pending);
      return;
    }
  }

  /** 只在正常完成的人类回合后调度，一次一个项目；永不阻塞事件派发。 */
  function scheduleOrganizer(session, event) {
    const reason = event && event.data ? event.data.reason : null;
    if (!reason || reason.kind !== 'completed') return;
    const sessionId = sessionIdOfSession(session);
    if (!sessionId) return;
    const pending = feedbackCandidates.get(sessionId);
    if (!pending) return;
    const eventTurn = event.data && event.data.turn !== undefined ? String(event.data.turn) : '';
    if (eventTurn && pending.candidate && pending.candidate.turn && eventTurn !== pending.candidate.turn) {
      feedbackCandidates.delete(sessionId);
      return;
    }
    pending.session = session;
    if (learningJobs.has(pending.scope.key)) {
      pending.queued = true;
      return;
    }
    feedbackCandidates.delete(sessionId);
    startOrganizer(pending.scope, session, pending);
  }

  if (typeof ctx.on === 'function') ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    clearPrepared(agent);
    windows.delete(agentKey(agent));
    const sessionId = String(agent?.session?.id ?? '');
    if (sessionId) { seenHumans.delete(sessionId); recallTasks.delete(sessionId); }
  });

  /**
   * 宿主没有 agent/turn-end 这个派发；真正的轮次收尾是 agent/turn-stopping，
   * 载荷只有 {turn, signal}。按 signal 找回对应 agent，只清这一轮的准备结果。
   */
  if (typeof ctx.on === 'function') ctx.on('agent/turn-stopping', (payload) => {
    const signal = payload?.signal;
    if (!signal) return;
    const agent = signalAgents.get(signal);
    if (agent) clearPrepared(agent);
    /** 被取消或被中断的回合不保留反馈候选，下一句「谢谢」不能把没说完的纠正写进去。 */
    if (signal.aborted === true && agent) {
      const sessionId = String(agent?.session?.id ?? '');
      if (sessionId) feedbackCandidates.delete(sessionId);
    }
    signalAgents.delete(signal);
  });

  /** 正常完成的人类回合才整理；失败、取消、被打断都不改写规则。 */
  if (typeof ctx.on === 'function') ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/end') return;
    scheduleOrganizer(session, event);
  });

  /** 插件卸载时中止在途整理；提交门禁仍会拒绝过期结果。 */
  ctx.effect(() => () => {
    for (const controller of learningAborts.values()) {
      try { controller.abort(); } catch { /* already gone */ }
    }
    learningAborts.clear();
    feedbackCandidates.clear();
    learningJobs.clear();
  }, 'lite-memory: learning jobs');

  /** 测试与排查用：只暴露只读查询，不提供改状态入口。 */
  ctx.effect(() => {
    globalThis.__liteMemoryRecall = {
      mode: recallMode,
      preparedOf: (agent) => prepared.get(agent) || null,
      windowOf: (agent) => windowOf(agent),
      /** 测试专用：CI 冷启动偶尔超过 150ms，逻辑测试不该被耗时上限判失败。 */
      setDeadlineMs: (ms) => { if (Number.isFinite(ms) && ms > 0) recallDeadlineMs = ms; },
      humanAskedGlobal,
    };
    return () => {
      delete globalThis.__liteMemoryRecall;
    };
  }, 'lite-memory: recall debug');

  /** Read-only summary for the Client row: how big the store already is. */
  ctx.effect(() => {
    globalThis.__liteMemoryStats = (cwd) => {
      try {
        const scope = scopeOf(cwd ?? process.cwd());
        const index = loadIndex(scope);
        return { scope: scope.key, count: index.entries.length, bytes: index.totalBytes ?? 0 };
      } catch {
        return { scope: '', count: 0, bytes: 0 };
      }
    };
    return () => {
      delete globalThis.__liteMemoryStats;
    };
  }, 'lite-memory: stats');
}
