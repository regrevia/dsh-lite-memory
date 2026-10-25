import {
  scopeOf,
  globalScope,
  upsert,
  search,
  readEntry,
  readLinks,
  forget,
  undoChange,
  locate,
  findAnywhere,
  renderIndex,
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
  evolutionStatus,
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
  '不记：常识、一次性任务参数、能从文件直接读到的正文、任何凭据的值。',
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
              : pathname === REMOTE_PATH + '/move' ? 'move'
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
      if (!id) return sendJson(res, 400, { ok: false, reason: '缺少 id' });
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      let found;
      if (sessionId) {
        try {
          found = readCitationBody(sessionId, id);
        } catch {
          found = null;
        }
        /** 不在本会话引用里就当已消失：不给跨会话探正文，界面也只显示「已删除」。 */
        if (!found) return sendJson(res, 200, { ok: true, status: 'gone', id });
      } else if (cwd) {
        const located = locate(scopeOf(cwd), id);
        if (!located) return sendJson(res, 200, { ok: true, status: 'gone', id });
        found = {
          ...located.record,
          scope: located.scope.key === 'global' ? 'global' : 'project',
          scopeLabel: located.scope.key === 'global' ? '全局' : path.basename(located.scope.cwd || '') || located.scope.key,
          body: located.record.body,
        };
      } else {
        return sendJson(res, 400, { ok: false, reason: '缺少来源' });
      }
      if (!found) return sendJson(res, 200, { ok: true, status: 'gone', id });
      return sendJson(res, 200, {
        ok: true,
        id: found.id,
        status: found.status,
        title: found.title,
        when: found.when || '',
        scope: found.scope,
        scopeLabel: found.scopeLabel || '',
        revision: found.revision,
        body: found.body,
      });
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
          if (learningAction === 'snapshot') {
            try { expireLearning(scope, { operationId: `expire_${Date.now()}` }); } catch { /* 清理失败不影响查看 */ }
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
          if (learningAction === 'pause') {
            const ids = Array.isArray(body.ids) ? body.ids.filter((value) => typeof value === 'string').slice(0, 12) : [];
            const result = pauseLearningRules(scope, ids, { operationId: operationId || `pause_learn_${Date.now()}`, by: 'management', reason: 'paused_by_user' });
            return sendJson(res, result && result.ok !== false ? 200 : 409, { ...result });
          }
          if (learningAction === 'delete') {
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

    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    if (cwd.length === 0) return sendJson(res, 400, { ok: false, reason: '请求不完整' });
    const scope = scopeOf(cwd);
    const id = typeof body.id === 'string' ? body.id : '';
    const candidateId = typeof body.candidateId === 'string' && body.candidateId
      ? body.candidateId
      : typeof body.suggestionId === 'string' ? body.suggestionId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

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
      if (!id) return sendJson(res, 400, { ok: false, reason: '缺少 id' });
      if (!locate(scope, id)) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
      /** 撤销是精确动作：必须带当时看到的版本；缺版本就不猜，免得撤掉别人后来的修改。 */
      if (!Number.isInteger(body.revision) || body.revision < 1) {
        return sendJson(res, 400, { ok: false, reason: '缺少版本' });
      }
      try {
        const undone = undoChange(scope, id, { expectedRevision: body.revision });
        if (!undone) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
        return sendJson(res, 200, { ok: true, id: undone.id, mode: undone.mode });
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
function refsOf(hits) {
  return hits.map((item) => ({
    id: item.id,
    title: item.title || '',
    scope: item.scope || 'project',
    revision: item.revision || 1,
    status: item.status || 'ok',
    origin: item.origin === 'project_evolution' ? 'project_evolution' : 'user_explicit',
  }));
}

const SAVE_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '要更新的记忆 id（来自搜索结果或相近提示）。同一件事更新时用它，别另建一条' },
    title: { type: 'string', description: `标题：名词短语，用户一眼能认出是哪件事，不超过 ${LIMITS.titleChars} 字。它就是这条记忆的身份` },
    summary: { type: 'string', description: `一句话说清要记的内容本身——用户只看这一行决定留不留，名词短语，不超过 ${LIMITS.summaryChars} 字` },
    body: { type: 'string', description: `正文 markdown，整段替换旧正文，不超过 ${LIMITS.entryBytes} 字节。只写指针与要点，不抄录长文档` },
    when: { type: 'string', description: `前置条件或适用场景（「在哪台机器 / 哪个环境 / 什么情况下」），不超过 ${LIMITS.whenChars} 字。同一标题但前置条件不同，会存成两条，不合并；更新时不给就保留原值` },
    kind: { type: 'string', enum: ['preference', 'convention', 'procedure', 'pointer', 'pitfall', 'credential_hint', 'note'], description: '条目类型；更新时不给就保留原值' },
    tags: { type: 'array', items: { type: 'string' }, description: '最多 5 个标签；更新时不给就保留原值' },
    resolution: {
      type: 'string',
      enum: ['distinct'],
      description: '明确表示「这确实是另一条」。返回 needsResolution 时，只有确认不是同一件事才带上它再存一次',
    },
    scope: { type: 'string', enum: ['auto', 'project', 'global'], description: '存哪一层：auto 按记忆类别判定（默认）；用户明确说「以后所有项目都这样」用 global；明确说只在这个项目用 project' },
    memoryClass: { type: 'string', enum: ['personal_preference', 'project_fact', 'environment_fact', 'portable_procedure'], description: '归属提案：个人偏好 / 项目事实 / 设备事实 / 可搬流程。服务端据此判定存哪层；设备事实必须同时给设备条件' },
    durability: { type: 'string', enum: ['durable', 'task'], description: '一般认为 durable；只是一次性任务参数用 task，服务端会拒绝落盘' },
    evidenceRef: { type: 'string', description: '归属判定的依据（哪条消息、哪个文件、哪次观察）；用户没说范围时用来判断能不能存' },
    sameTopicAs: {
      type: 'object',
      description: '显式绑定到已有主题槽位：{scope, id, revision}。版本不符或目标不存在就报错，不写',
      properties: {
        scope: { type: 'string', enum: ['project', 'global'] },
        id: { type: 'string' },
        revision: { type: 'integer' },
      },
      required: ['scope', 'id', 'revision'],
      additionalProperties: false,
    },
    mode: {
      type: 'string',
      enum: ['patch', 'replace_current'],
      description: '默认 patch：没给的字段保持原值。要整条换掉时用 replace_current，并把 title/summary/when/body/kind/tags 全部显式给出（空值也要写），不继承旧值',
    },
    applicability: {
      type: 'string',
      enum: view.APPLICABILITY,
      description: '适用范围：all_in_scope 普遍适用；conditional 条件适用（必须给 conditions）；unresolved 还没定（有 when 但没结构化条件时默认这个）。不给就按字段推断',
    },
    conditions: {
      type: 'array',
      description: '条件适用的具体条件，最多 8 条；给了空数组就是清空',
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
      description: '只对某个产物成立的规则：complete 表示清单完整（必须给 artifactKey），examples 只是举例。null 表示清空',
      properties: {
        mode: { type: 'string', enum: view.SELECTION_MODES },
        artifactKey: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'examples 模式下的举例清单' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    links: {
      type: 'array',
      description: '相关记忆，最多 3 条，只表示同类相关；目标必须当前存在。给空数组就是清空',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: view.LINK_TYPES, description: '默认 related' },
          id: { type: 'string', pattern: '^mem_[a-z0-9]{6,}$' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    triggers: {
      type: 'array',
      items: { type: 'string' },
      description: '自动召回用的固定触发词，最多 4 个；给空数组就是清空',
    },
    topicKey: { type: ['string', 'null'], description: '主题槽位，用来判断同一件事避免重复；不给就保持原值，null 表示清空' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
};

const SUGGEST_PARAMS = {
  ...SAVE_PARAMS,
  properties: Object.fromEntries(Object.entries(SAVE_PARAMS.properties).filter(([key]) => !['scope', 'id', 'resolution', 'memoryClass', 'durability', 'evidenceRef', 'sameTopicAs'].includes(key))),
};

const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要查的主题；用用户原话里的词，长句也行' },
    limit: { type: 'integer', minimum: 1, maximum: 4, description: '最多返回几条，默认 3' },
    history: { type: 'boolean', description: '连已归档的旧记录一起找；默认只看当前有效的，旧修正不混进正常检索' },
    contextId: { type: 'string', description: '本请求已经给出的任务上下文 id；只有上一轮自动索引或工具结果里出现过才填' },
    bindForRequest: { type: 'boolean', description: '把这次选择绑定为本请求的任务；有 contextId 就带上。默认 false，只做普通检索' },
  },
  required: ['query'],
  additionalProperties: false,
};

const READ_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '记忆 id，来自搜索结果' },
    view: { type: 'string', enum: ['full', 'links'], description: '默认 full 读正文；links 只看直接相关的记忆清单，不取正文' },
    contextId: { type: 'string', description: '上一轮自动索引或工具结果给出的任务上下文 id；读实验规则时带上' },
  },
  required: ['id'],
  additionalProperties: false,
};

const FORGET_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '要忘掉的记忆 id' },
    mode: {
      type: 'string',
      enum: ['archive', 'purge'],
      description: 'archive 移入归档可找回（只是不想再提）；purge 彻底忘掉，正文与受管副本清除且不可复活。没点明是哪种就两种都别做，先问用户',
    },
  },
  required: ['id'],
  additionalProperties: false,
};

function scopeLabel(value) {
  return value.scope === 'global' ? ' [全局]' : '';
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
const RECALL_DEADLINE_MS = 150;
const RECALL_HEADER = '已有记忆可能相关（需要细节用 memory_read 取正文，别凭标题猜）：';

/** 卡片只放够判断要不要读的几行；必要前提整条在场，装不下就整卡省略。 */
function renderRecallCard(card) {
  const parts = [`- 「${card.title}」${card.scope === 'global' ? ' [全局]' : ''} · ${card.id} · 第 ${card.revision} 版`];
  if (card.summary) parts.push(`｜${card.summary}`);
  if (card.conditions && card.conditions.length) parts.push(`｜前提：${card.conditions.join('、')}`);
  if (card.selection) parts.push(`｜只适用于 ${card.selection}`);
  if (card.related) parts.push(`｜关联 ${card.related} 条`);
  return parts.join('');
}

export function apply(ctx, config) {
  const tools = ctx.tools;
  const getService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);

  /* ---------------- 自动召回：策略、冻结快照、任务窗口与请求预算 ---------------- */

  /** 升级不覆盖用户的选择：默认 adaptive，别的模式只由明确配置切换。 */
  const recallMode = () => (RECALL_MODES.includes(config?.mode) ? config.mode : 'adaptive');
  /** 已准备好的快照只挂在 Agent 上，弱引用随手回收，不跨会话串。 */
  const prepared = new WeakMap();
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
  /** 一个项目同一时间只整理一次；控制器放在模块级供开关路由中止。 */
  const learningJobs = new Map();

  const agentKey = (agent) => String(agent?.id ?? '');

  const clearPrepared = (agent) => {
    if (!agent) return;
    const state = prepared.get(agent);
    if (state && state.signal) signalAgents.delete(state.signal);
    prepared.delete(agent);
    const key = agentKey(agent);
    const cleanup = key ? abortCleanups.get(key) : null;
    if (cleanup) {
      abortCleanups.delete(key);
      try { cleanup(); } catch { /* listener already gone */ }
    }
  };

  const windowOf = (agent) => windows.get(agentKey(agent)) || null;

  /** 预算按规范化 JSON 字节算：转义、中文、换行都算进模型真正收到的内容。 */
  const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

  function affordable(win, bytes, bodies = 0) {
    if (!win) return true;
    if (win.reads >= view.REQUEST_LIMITS.reads) return false;
    if (bodies && win.bodies + bodies > view.REQUEST_LIMITS.bodies) return false;
    return win.bytes + bytes <= view.REQUEST_BYTES;
  }

  function openWindow(agent, { sessionId, turn, messageIds }) {
    const key = agentKey(agent);
    if (!key) return null;
    const signature = `${sessionId}\u0000${turn}\u0000${messageIds.join(',')}`;
    const existing = windows.get(key);
    if (existing && existing.signature === signature) return existing;
    const next = {
      signature, sessionId, turn, messageIds,
      bytes: 0, bodies: 0, reads: 0,
      provided: new Map(), readBodies: new Map(), at: Date.now(),
      experiment: null, contexts: new Map(),
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
  function fingerprintOf(scope) {
    try {
      return [scope, globalScopeView()].map((source) => {
        const index = loadIndex(source);
        const meta = index.__meta || {};
        const evolutionEpoch = index.__evolution && index.__evolution.epoch ? index.__evolution.epoch : '';
        return `${index.scope}:${meta.storeId || ''}:${index.generation}:${index.epoch}:${evolutionEpoch}`;
      }).join('|');
    } catch {
      return '';
    }
  }

  const globalScopeView = () => globalScope();

  /** 纯内存：读两层当前投影，先判适用再排序，整卡装预算。 */
  function projectRecall(scope, query, context, win) {
    const layers = { project: [], global: [] };
    const seen = new Set();
    for (const source of [scope, globalScope()]) {
      const layer = source.key === 'global' ? 'global' : 'project';
      let index;
      try { index = loadIndex(source); } catch { continue; }
      for (const item of index.entries) {
        if (!item || !item.title || item.status === 'archived') continue;
        /** 实验来源只走任务绑定后的专用读取，不混进普通自动召回。 */
        if (item.origin === 'project_evolution') continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        layers[layer].push(item);
      }
    }
    /** 同一槽位只让胜出的规范进去；冲突或条件未知的整组不进自动召回。 */
    const records = [];
    const layerOf = new Map();
    for (const group of view.resolveTopics(layers.project, layers.global, context).values()) {
      if (group.status !== 'ok' || !group.record) continue;
      records.push(group.record);
      layerOf.set(group.record.id, group.scope === 'global' ? 'global' : 'project');
    }
    const ranked = view.rank(records, query, { limit: 8, requireApplicable: true, context });
    const headerBytes = Buffer.byteLength(RECALL_HEADER);
    let used = headerBytes;
    /** 卡片上限含包装；共享请求账本也要把标题行算进去，不能只算卡片行。 */
    let headerCharged = win ? win.recallHeader === true : false;
    const lines = [];
    const cards = [];
    for (const row of ranked) {
      if (cards.length >= view.CARD.max) break;
      const card = view.cardOf(row.record, layerOf.get(row.record.id));
      const line = renderRecallCard(card);
      const size = Buffer.byteLength(`\n${line}`);
      if (used + size > view.CARD.bytes) continue;
      const revision = card.revision || 1;
      const already = win ? win.provided.get(card.id) === revision : false;
      if (win && !already) {
        const cost = size + (headerCharged ? 0 : headerBytes);
        if (!affordable(win, cost)) continue;
        win.bytes += cost;
        win.provided.set(card.id, revision);
        if (!headerCharged) {
          headerCharged = true;
          win.recallHeader = true;
        }
      }
      used += size;
      lines.push(line);
      cards.push({ id: card.id, revision, scope: card.scope, title: card.title });
    }
    if (!cards.length) return null;
    return { text: `${RECALL_HEADER}\n${lines.join('\n')}`, cards, bytes: used, query };
  }

  /* ---------------- 项目自进化：任务锚点、读取决策、上下文解析 ---------------- */

  const EXPERIMENT_INDEX_HEADER = '项目里有这些栏目（先问用户这期做哪个，再用 memory_search 带上 contextId 绑定）：';
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

  /** 实验内容单独记账：同一请求里再次渲染只补差额，不重复占满预算。 */
  function chargeExperiment(win, text) {
    if (!text) return '';
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

  /** 读决策 → 一段短提示：未绑定只给栏目索引，已绑定才给规则正文。 */
  function renderExperiment(scope, decision, context, held, win) {
    if (!decision || decision.kind === 'none') return '';
    if (decision.kind === 'conflict') {
      return chargeExperiment(win, '这些实验规则互相冲突，先按用户这次说的做，别叠加对立的规则。');
    }
    if (decision.kind === 'index' || decision.kind === 'clarify') {
      const names = Array.isArray(decision.ranges) ? decision.ranges.filter(Boolean).slice(0, 3) : [];
      const tail = held && held.contextId ? `\ncontextId=${held.contextId}` : '';
      if (!names.length) return chargeExperiment(win, `先问用户这期做什么栏目，别自己猜。${tail}`);
      return chargeExperiment(win, `${EXPERIMENT_INDEX_HEADER}\n${names.map((name) => `- ${name}`).join('\n')}${tail}`);
    }
    let index;
    try { index = loadIndex(scope); } catch { return ''; }
    const matched = [];
    const unknown = [];
    const byTopic = new Map();
    let conflict = false;
    for (const record of index.entries) {
      if (record.origin !== 'project_evolution') continue;
      if (record.reviewState === 'legacy_unreviewed') continue;
      const learning = record.learning && typeof record.learning === 'object' ? record.learning : {};
      if (learning.state !== 'active' && learning.state !== 'trial') continue;
      const status = view.statusOf(record, context);
      if (status === 'needs_context') { unknown.push(record); continue; }
      if (status !== 'ok') continue;
      const topic = record.topicKey || record.id;
      if (byTopic.has(topic) && byTopic.get(topic).body !== record.body) conflict = true;
      byTopic.set(topic, record);
      matched.push(record);
    }
    if (conflict) {
      return chargeExperiment(win, '这些实验规则互相冲突，先按用户这次说的做，别叠加对立的规则。');
    }
    const lines = [];
    const shown = [];
    let used = Buffer.byteLength(EXPERIMENT_RULES_HEADER) + 1;
    for (const record of matched.slice(0, 3)) {
      const body = String(record.body || '');
      const short = body && body.length <= EXPERIMENT_SHORT_CHARS && body.split('\n').length <= 4;
      const conditions = conditionLabel(record.conditions);
      const line = short
        ? `- 「${record.title}」${conditions ? `（${conditions}）` : ''} · ${record.id} · 第 ${record.revision || 1} 版：${body}`
        : `- 「${record.title}」 · ${record.id} · 第 ${record.revision || 1} 版（用途：${record.summary || record.title}；要用时 memory_read 取正文）`;
      const size = Buffer.byteLength(`\n${line}`);
      if (used + size > EXPERIMENT_BYTES) break;
      used += size;
      lines.push(line);
      shown.push(record.id);
    }
    if (held) held.injectedIds = shown;
    if (!lines.length && unknown.length) {
      const nameLine = unknown.slice(0, 3).map((record) => `- 「${record.title}」 · ${record.id}`).join('\n');
      return chargeExperiment(win, `有些实验规则的适用条件还没确认，先别当成本轮依据：\n${nameLine}`);
    }
    if (!lines.length) return '';
    const tail = held && held.contextId ? `\ncontextId=${held.contextId}` : '';
    return chargeExperiment(win, `${EXPERIMENT_RULES_HEADER}\n${lines.join('\n')}${tail}`);
  }

  /** 一次真人请求只路由一次；同一批次重试复用同一 transitionId。 */
  function experimentFor(scope, { sessionId, query, batchKey, messageIds, win }) {
    if (!win || !batchKey) return null;
    let status;
    try { status = evolutionStatus(scope); } catch { return null; }
    if (!status || status.enabled !== true || status.compatible === false) return null;
    if (scope.confirmed !== true) return null;
    let tasks;
    try { tasks = taskState(scope); } catch { return null; }
    const ranges = rangesOf(scope);
    const routed = anchor.routeTask(tasks, {
      projectId: scope.key,
      sessionId,
      batchKey,
      messageIds,
      query,
      registeredSeries: ranges.series,
      defaults: tasks.defaults,
      now: Date.now(),
    });
    if (routed.changed) {
      const saved = saveTaskState(scope, routed.tasks, { operationId: `task_${batchKey}` });
      if (!saved.ok) return null;
    }
    const context = view.trustedContext(scope, anchor.contextOfAnchor(routed.anchor, {}));
    const thanks = anchor.isThanks(query);
    const decision = anchor.decideRead({
      mode: recallMode(),
      enabled: true,
      identityConfirmed: true,
      anchor: routed.anchor,
      ranges: [...ranges.taskKinds, ...ranges.series],
      thanks,
      boundForRequest: false,
    });
    const contextId = anchor.contextIdFor(scope.key, batchKey, crypto.randomUUID().slice(0, 8));
    const episode = routed.tasks && routed.tasks.episodes ? routed.tasks.episodes[routed.anchor.episodeId] : null;
    const held = {
      contextId, projectKey: scope.key, sessionId, batchKey, messageIds,
      context, anchor: routed.anchor, ranges, decision,
      episodeUpdatedAt: episode ? episode.updatedAt : '', injectedIds: [],
      at: Date.now(),
    };
    win.experiment = held;
    win.contexts.set(contextId, held);
    return { text: renderExperiment(scope, decision, context, held, win), decision, held };
  }

  /** 自动路径与工具共用一次解析：没有本轮上下文就退回普通检索，绝不猜一个空上下文。 */
  function resolveRequestContext(execution, optionalContextId) {
    const scope = scopeOf(cwdOf(execution));
    const win = windowOf(execution && execution.agent);
    const contextId = typeof optionalContextId === 'string' ? optionalContextId.trim() : '';
    if (!contextId) {
      return { ok: true, scope, win, context: view.trustedContext(scope, {}), experimental: false };
    }
    /** 先认项目再找本地记录：别的项目的上下文要明确拒绝，不能只报过期。 */
    if (anchor.projectTagOf(contextId) !== anchor.projectTag(scope.key)) {
      return { ok: false, status: 'needs_context', reason: '这个上下文属于另一个项目' };
    }
    if (!win) return { ok: false, status: 'needs_context', reason: '这个请求的上下文已经过期，先重新问一次当前任务' };
    const held = win.contexts.get(contextId);
    if (!held) return { ok: false, status: 'needs_context', reason: '这个上下文已经过期，先重新问一次当前任务' };
    return { ok: true, scope, win, context: held.context, experimental: true, held, contextId };
  }

  /** 工具模式没有自动索引时，按本轮真人消息现开一个请求上下文，仍要前台点名栏目才绑定。 */
  function toolContextFor(execution) {
    const win = windowOf(execution && execution.agent);
    if (!win || !win.sessionId || !Array.isArray(win.messageIds) || win.messageIds.length === 0) return '';
    let status;
    try { status = evolutionStatus(scopeOf(cwdOf(execution))); } catch { return ''; }
    if (!status || status.enabled !== true || status.compatible === false) return '';
    const scope = scopeOf(cwdOf(execution));
    if (scope.confirmed !== true) return '';
    const batchKey = anchor.requestBatchKey(win.messageIds);
    const held = win.experiment && win.experiment.batchKey === batchKey ? win.experiment : null;
    if (held) return held.contextId;
    const contextId = anchor.contextIdFor(scope.key, batchKey, crypto.randomUUID().slice(0, 8));
    const created = {
      contextId, projectKey: scope.key, sessionId: win.sessionId, batchKey,
      messageIds: win.messageIds.slice(), context: view.trustedContext(scope, {}),
      anchor: null, ranges: rangesOf(scope), decision: { kind: 'none' }, at: Date.now(),
    };
    win.experiment = created;
    win.contexts.set(contextId, created);
    return contextId;
  }

  /** 前台绑定只升到 proposed：真正执行链还没发生，不冒充 active。 */
  function bindSelection(execution, resolved, query) {
    const held = resolved.held;
    const ranges = held.ranges || { series: [], taskKinds: [] };
    const hits = [];
    for (const value of ranges.series || []) if (query.includes(value)) hits.push({ seriesId: value });
    for (const value of ranges.taskKinds || []) if (query.includes(value)) hits.push({ taskKind: value });
    if (hits.length !== 1) {
      const names = [...(ranges.series || []), ...(ranges.taskKinds || [])].slice(0, 3);
      return { ok: false, status: 'needs_context', reason: names.length ? `先在问题里点名一个栏目：${names.join('、')}` : '先说要做的栏目' };
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
    if (preparedState) preparedState.experimentText = text;
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
      return [state.experimentText, state.text].filter(Boolean).join('\n\n');
    } catch {
      return '';
    }
  }


  ctx.effect(() => tools.register({
    name: 'memory_save',
    description: `保存一条记忆。用户明确说「记住」时直接调用；用户自己的话已经是长期规则（「以后都这样」「别再 X」）时也直接调用，不要先问。更新同一件事时带 id：身份只看标题、旧标题和前置条件，像不像不授权覆盖。文本相近但标题不同时先不写，返回 needsResolution 与 1–2 条相近条目：确实是同一条就用那个 id 更新，确实是另一条才带 resolution="distinct" 再存。带 id 更新时没给的字段保持原值，正文整段替换，旧版本留在 versions 里（每字都留，不截断）。条数到硬上限时把同层最久没被读的一条移进归档，结果里写明动了哪条，不拒绝新记忆；单条正文超限只报错、不截断。前置条件不同的同一标题是两条。${NOTES}`,
    parameters: SAVE_PARAMS,
    output: {
      presentationMeta: (_args, value) => ({
        kind: 'memory-save',
        id: value.id || '',
        title: value.title || '',
        scope: value.scope || '',
        revision: value.revision || 0,
        changed: value.changed === true,
        mode: value.needsScope ? 'needs_scope'
          : value.existingId ? 'duplicate'
            : value.needsResolution ? 'needs_resolution'
              : value.changed === false ? 'unchanged' : value.merged ? 'updated' : 'created',
      }),
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          when: { type: 'string' },
          revision: { type: 'integer' },
          merged: { type: 'boolean' },
          changed: { type: 'boolean' },
          scope: { type: 'string' },
          needsResolution: { type: 'boolean' },
          needsScope: { type: 'boolean' },
          reason: { type: 'string' },
          existingId: { type: 'string' },
          existingScope: { type: 'string' },
          crossLayer: { type: 'boolean' },
          sameTopic: { type: 'boolean' },
          similarIds: { type: 'string' },
          similar: { type: 'string' },
          archived: { type: 'string' },
        },
        required: ['id', 'title', 'summary', 'when', 'revision', 'merged', 'changed', 'scope', 'needsResolution', 'archived'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.needsScope
          ? value.reason === 'unconfirmed_project'
            ? `memory · 当前目录还不能确认属于哪个项目：「${value.title}」\n先确认项目根目录，或显式 scope="global"`
            : `memory · 归属还没定：「${value.title}」\n补 memoryClass（personal_preference / project_fact / environment_fact / portable_procedure）或显式 scope；设备事实还要给设备条件`
          : value.existingId
            ? `memory · 已有相同记忆：「${value.title}」 · ${value.existingId}（${value.existingScope}）第 ${value.revision} 版\n要改成另一条，加 resolution="distinct"`
            : value.needsResolution
          ? `memory · 需要确认：「${value.title}」与已有条目相近${value.crossLayer ? '（在另一层）' : ''}${value.sameTopic ? '（同一主题槽位）' : ''}\n${value.similar}\n要更新它，用 id 重存；确实是另一条，加 resolution="distinct"`
          : value.changed === false
            ? `memory · unchanged${scopeLabel(value)} "${value.title}" · ${value.id} · 第 ${value.revision} 版`
            : `memory · ${value.merged ? 'merged' : 'saved'}${scopeLabel(value)} "${value.title}"${value.when ? `（${value.when}）` : ''} · ${value.id} · 第 ${value.revision} 版${value.similar ? ` · 相近：${value.similar}` : ''}${value.archived ? ` · 已归档「${value.archived}」腾位` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const projectScope = scopeOf(cwdOf(execution));
      const saved = saveEntry(projectScope, { ...args, writeMode: args.mode || 'patch' });
      if (saved.needsScope) {
        return {
          id: '',
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
          similarIds: '',
          similar: '',
          archived: '',
        };
      }
      if (saved.existing) {
        return {
          id: saved.existing.id,
          title: saved.existing.title || saved.draft?.title || '',
          summary: '',
          when: '',
          revision: saved.existing.revision,
          merged: false,
          changed: false,
          scope: saved.existing.scope,
          needsScope: false,
          existingId: saved.existing.id,
          existingScope: saved.existing.scope,
          needsResolution: false,
          similarIds: '',
          similar: '',
          archived: '',
        };
      }
      const scope = saved.chosenScope === 'global' || (args.scope === 'global' && !saved.chosenScope) ? globalScope() : projectScope;
      if (saved.needsResolution) {
        return {
          id: '',
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
          sameTopic: Boolean(saved.sameTopic),
          similarIds: saved.similarList.map((item) => item.id).join('、'),
          similar: saved.similarList.map((item) => `${item.id}「${item.title}」${item.summary ? `｜${item.summary}` : ''}`).join('；'),
          archived: '',
        };
      }
      recordCitations(scope, sessionIdOf(execution), [saved.record]);
      return {
        id: saved.record.id,
        title: saved.record.title,
        summary: saved.record.summary,
        when: saved.record.when || '',
        revision: saved.record.revision || 1,
        merged: saved.merged,
        changed: !saved.noop,
        scope: scope.key === 'global' ? 'global' : 'project',
        needsScope: false,
        needsResolution: false,
        similarIds: saved.similarList.map((item) => item.id).join('、'),
        archived: (saved.archived || []).map((item) => item.title).join('、'),
        ...(saved.similar ? { similar: `${saved.similar.id}「${saved.similar.title}」` } : {}),
      };
    },
  }), 'lite-memory: memory_save');

  ctx.effect(() => tools.register({
    name: 'memory_suggest',
    description: `对一条用户没说、但跨会话还有用的经验提出保存建议。调用后对话里出现一个「保留」按钮，用户点了才进正式记忆。不要用问句征询「要不要记」，那要用户打字。一次对话最多建议一条，48 小时内每个项目一条。建议草稿与正式保存走同一套校验，凭据不会落盘；待确认草稿 48 小时过期，确认前就落盘所以撤回/过期都查得到。已有同一条时不再建议；相近的另一条会记成「更新候选」，保留后改的是那条，不会另建。${NOTES}`,
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
          targetId: { type: 'string' },
          targetTitle: { type: 'string' },
        },
        required: ['asked'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.asked
          ? `memory · suggested "${value.title}" · ${value.id}${value.targetId ? ` · 确认后更新 ${value.targetId}「${value.targetTitle}」` : ''}`
          : `memory · skipped${value.reason ? `\n${value.reason}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const gate = suggestionGate(scope, args);
      if (!gate.ok) return { asked: false, reason: gate.reason };
      const noted = noteSuggestion(scope, gate.target ? { ...args, targetId: gate.target.id } : args);
      return {
        asked: true,
        title: noted.title,
        id: noted.id,
        ...(noted.targetId ? { targetId: noted.targetId, targetTitle: noted.targetTitle } : {}),
      };
    },
  }), 'lite-memory: memory_suggest');

  ctx.effect(() => tools.register({
    name: 'memory_search',
    description: `按需检索已有记忆：先搜，命中再 memory_read 读正文。用户提到「记住了什么 / 上次 / 规范 / 约定 / 路径 / 凭据怎么取」，或者眼前反复出现的报错、弹窗、异常时，先查这里有没有记过解法。跨项目的通用条目以 [全局] 开头。中文长句可以直接当查询。每行带 id 与版次，更新时把 id 传回 memory_save。默认只列当前有效的；已经归档或被新版本替换的旧说法不混进来，要查历史就在参数里显式要 history。`,
    parameters: SEARCH_PARAMS,
    output: {
      presentationMeta: (_args, value) => ({ kind: 'memory-search', count: value.count, status: value.status || 'ok', refs: value.refs || [] }),
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          chars: { type: 'integer' },
          text: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'budget_exhausted', 'memory_disabled', 'needs_context'] },
          refs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                scope: { type: 'string' },
                revision: { type: 'integer' },
                status: { type: 'string' },
              },
              required: ['id', 'title', 'scope', 'revision', 'status'],
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
          ? 'memory · 本请求的记忆额度已用完'
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
      if (recallMode() === 'off') return { count: 0, chars: 0, text: '', status: 'memory_disabled', refs: [] };
      const agent = execution?.agent;
      const win = windowOf(agent);
      if (win && !affordable(win, 0)) return { count: 0, chars: 0, text: '', status: 'budget_exhausted', refs: [] };
      const wantsBind = args.bindForRequest === true;
      const contextId = wantsBind && !args.contextId ? toolContextFor(execution) : args.contextId;
      if (wantsBind && !contextId) {
        return { count: 0, chars: 0, text: '先带上当前任务的 contextId，再绑定这一期。', status: 'needs_context', refs: [] };
      }
      const resolved = resolveRequestContext(execution, contextId);
      if (!resolved.ok) return { count: 0, chars: 0, text: resolved.reason, status: resolved.status || 'needs_context', refs: [] };
      if (wantsBind) {
        const bound = bindSelection(execution, resolved, String(args.query || ''));
        if (!bound.ok) return { count: 0, chars: 0, text: bound.reason, status: bound.status || 'needs_context', refs: [] };
      }
      const scope = resolved.scope;
      const context = resolved.context;
      const hits = search(scope, args.query, args.limit ?? 3, {
        context,
        history: args.history === true,
        allowExperimental: resolved.experimental === true,
      });
      const shown = hits.map((item) => view.toModelView(item, 'search', { status: item.status || (item.archived ? 'archived' : 'ok') }));
      const valueOf = (kept) => {
        const rendered = renderIndex(shown.slice(0, kept));
        return { count: kept, chars: rendered.chars, text: rendered.text, status: 'ok', refs: refsOf(hits.slice(0, kept)) };
      };
      /** 没命中是正常结果，不是额度问题；空响应同样记一次本请求开销。 */
      if (!hits.length) {
        const empty = { count: 0, chars: 0, text: '', status: 'ok', refs: [] };
        if (win) {
          const bytes = jsonBytes(empty);
          if (!affordable(win, bytes)) return { ...empty, status: 'budget_exhausted' };
          win.bytes += bytes;
          win.reads += 1;
        }
        return empty;
      }
      if (win) {
        let kept = shown.length;
        while (kept > 0 && !affordable(win, jsonBytes(valueOf(kept)))) kept -= 1;
        if (kept === 0) return { count: 0, chars: 0, text: '', status: 'budget_exhausted', refs: [] };
        const value = valueOf(kept);
        win.bytes += jsonBytes(value);
        win.reads += 1;
        recordCitations(scope, sessionIdOf(execution), hits.slice(0, kept));
        return value;
      }
      const value = valueOf(shown.length);
      recordCitations(scope, sessionIdOf(execution), hits);
      return value;
    },
  }), 'lite-memory: memory_search');

  ctx.effect(() => tools.register({
    name: 'memory_read',
    description: '读一条记忆的正文。搜索结果里只有一行摘要，需要细节时按 id 读。索引里还有、正文文件丢了会直接报错，不会返回空正文。',
    parameters: READ_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          when: { type: 'string' },
          revision: { type: 'integer' },
          scope: { type: 'string' },
          origin: { type: 'string', enum: ['user_explicit', 'project_evolution'] },
          status: { type: 'string', enum: ['ok', 'archived', 'needs_context', 'not_applicable', 'gone', 'budget_exhausted', 'memory_disabled'] },
          body: { type: 'string' },
          links: { type: 'string' },
          repeat: { type: 'boolean' },
        },
        required: ['id', 'scope', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'budget_exhausted'
          ? 'memory · 本请求的记忆额度已用完'
          : value.status === 'memory_disabled'
            ? 'memory · 记忆检索已关闭'
            : value.repeat
              ? `memory · 本请求已读过「${value.title}」 · ${value.id} · 第 ${value.revision} 版`
              : value.body
                ? `memory · 「${value.title}」${value.when ? `（${value.when}）` : ''} · ${value.id} · 第 ${value.revision} 版${scopeLabel(value)}${statusLabel(value.status)}\n${value.body}`
                : `memory · 「${value.title}」的相关记忆\n${value.links || '(无)'}`,
      }],
      presentationMeta: (_args, value) => ({
        kind: 'memory-read',
        id: value.id || '',
        title: value.title || '',
        scope: value.scope || '',
        revision: value.revision || 0,
        origin: value.origin === 'project_evolution' ? 'project_evolution' : 'user_explicit',
        status: value.status || 'ok',
      }),
    },
    execute: async (args, execution) => {
      if (recallMode() === 'off') return { id: '', scope: '', status: 'memory_disabled' };
      const resolved = resolveRequestContext(execution, args.contextId);
      if (!resolved.ok) return { id: '', scope: '', status: resolved.status || 'needs_context' };
      const scope = resolved.scope;
      const context = resolved.context;
      const allowExperimental = resolved.experimental === true;
      const agent = execution?.agent;
      const win = windowOf(agent);
      if (args.view === 'links') {
        const found = readLinks(scope, args.id, { context, allowExperimental });
        if (!found) throw new Error(`没有 ${args.id} 这条记忆`);
        const rows = found.links.map((link) => (link.status === 'invalid'
          ? `- ${link.id} · 已失效`
          : `- 「${link.title}」${link.scope === 'global' ? ' [全局]' : ''} · ${link.id} · 第 ${link.revision} 版`));
        const text = rows.join('\n') || '(无)';
        const value = { id: found.id, scope: found.scope, status: found.status, links: text };
        if (win) {
          const bytes = jsonBytes(value);
          if (!affordable(win, bytes)) return { id: '', scope: '', status: 'budget_exhausted' };
          win.bytes += bytes;
          win.reads += 1;
        }
        return value;
      }
      const record = readEntry(scope, args.id, { context, allowExperimental });
      if (!record) throw new Error(`没有 ${args.id} 这条记忆`);
      if (record.origin === 'project_evolution' && !allowExperimental) {
        return { id: record.id, title: record.title, when: record.when || '', revision: record.revision || 1, scope: record.scope, status: 'needs_context', body: '' };
      }
      /** 暂停或条件不匹配的实验条目只给状态，不给正文。 */
      const learningState = record.learning && typeof record.learning === 'object' ? record.learning : {};
      if (record.origin === 'project_evolution' && (learningState.state === 'paused' || learningState.blockedReason)) {
        return { id: record.id, title: record.title, when: record.when || '', revision: record.revision || 1, scope: record.scope, status: 'needs_context', body: '' };
      }
      if (record.origin === 'project_evolution' && record.status !== 'ok') {
        return { id: record.id, title: record.title, when: record.when || '', revision: record.revision || 1, scope: record.scope, status: record.status === 'needs_context' ? 'needs_context' : 'not_applicable', body: '' };
      }
      const revision = record.revision || 1;
      const body = String(record.body ?? '');
      const value = {
        id: record.id,
        title: record.title,
        when: record.when || '',
        revision,
        scope: record.scope,
        status: record.status,
        body,
      };
      if (win) {
        if (!affordable(win, 0)) return { id: '', scope: '', status: 'budget_exhausted' };
        const seenRevision = win.readBodies.get(record.id);
        if (seenRevision === revision) {
          const receipt = { ...value, body: '', repeat: true };
          const bytes = jsonBytes(receipt);
          if (!affordable(win, bytes)) return { id: '', scope: '', status: 'budget_exhausted' };
          win.bytes += bytes;
          win.reads += 1;
          return receipt;
        }
        const bytes = jsonBytes(value);
        if (!affordable(win, bytes, 1)) return { id: '', scope: '', status: 'budget_exhausted' };
        win.bytes += bytes;
        win.bodies += 1;
        win.reads += 1;
        win.readBodies.set(record.id, revision);
      }
      recordCitations(scope, sessionIdOf(execution), [record]);
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
          id: { type: 'string' },
          title: { type: 'string' },
          scope: { type: 'string' },
          mode: { type: 'string', enum: ['archive', 'purged', 'needs_resolution', 'purge_pending'] },
        },
        required: ['id', 'mode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'purged'
          ? `memory · forgotten "${value.title}" · ${value.id}`
          : value.mode === 'purge_pending'
            ? `memory · 清除未完成 · ${value.id}，重启后会继续`
            : value.mode === 'needs_resolution'
              ? `memory · 先确认是归档还是彻底忘掉 · ${value.id}`
              : `memory · archived${scopeLabel(value)} "${value.title}" · ${value.id}，可找回`,
      }],
      presentationMeta: (_args, value) => ({
        kind: 'memory-forget',
        id: value.id || '',
        title: value.title || '',
        scope: value.scope || '',
        mode: value.mode,
      }),
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const located = locate(scope, args.id);
      if (!located && !args.mode) throw new Error(`没有 ${args.id} 这条记忆`);
      if (!args.mode) {
        return { id: args.id, mode: 'needs_resolution', scope: located.scope.key === 'global' ? 'global' : 'project' };
      }
      let dropped;
      try {
        dropped = forget(scope, args.id, { mode: args.mode });
      } catch (error) {
        if (error && error.code === 'purge_pending') {
          const layer = located ? located.scope : scope;
          try {
            state.resumePurge(layer);
            dropped = forget(scope, args.id, { mode: args.mode });
          } catch (again) {
            if (again && again.code === 'purge_pending') {
              return {
                id: args.id,
                title: located ? located.record.title : '',
                mode: 'purge_pending',
                scope: layer.key === 'global' ? 'global' : 'project',
              };
            }
            throw again;
          }
        } else {
          throw error;
        }
      }
      if (!dropped) throw new Error(`没有 ${args.id} 这条记忆`);
      const layerKey = dropped.scopeKey || (located ? located.scope.key : scope.key);
      return {
        id: dropped.id,
        title: dropped.title || (located ? located.record.title : ''),
        mode: dropped.mode,
        scope: layerKey === 'global' ? 'global' : 'project',
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

  if (typeof ctx.on === 'function') ctx.on('agent/pre-step', async (payload, next) => {
    const startedAt = Date.now();
    const agent = payload?.agent;
    let decision;
    try {
      decision = await next();
    } catch (error) {
      clearPrepared(agent);
      throw error;
    }
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
      const sameSession = previous && previous.sessionId === sessionId;

      if (fresh.length === 0) {
        /** 工具续步：内容冻结，只把快照绑到本步的 signal；盘上版本变了才重投影。 */
        const turnChanged = !!(turn && previous?.turn && turn !== previous.turn);
        if (!sameSession || turnChanged) {
          clearPrepared(agent);
          return decision;
        }
        previous.signal = signal;
        const scope = scopeOf(cwdOf({ agent }));
        const fingerprint = fingerprintOf(scope);
        /** 指纹拿不到就当作已失效：不拿旧任务内容硬撑这一步。 */
        if (!fingerprint) {
          clearPrepared(agent);
          return decision;
        }
        if (fingerprint !== previous.fingerprint) {
          const win = windowOf(agent);
          const snapshot = projectRecall(scope, previous.query, view.trustedContext(scope, {}), win);
          let experimentText = '';
          if (win && win.experiment) {
            experimentText = renderExperiment(scope, win.experiment.decision, win.experiment.context, win.experiment, win);
          }
          if (generation === generations.get(agent) && !signal?.aborted) {
            if (snapshot || experimentText) {
              previous.text = snapshot ? snapshot.text : '';
              previous.cards = snapshot ? snapshot.cards : [];
              previous.experimentText = experimentText;
              previous.fingerprint = fingerprint;
            } else {
              clearPrepared(agent);
            }
          }
        }
        return decision;
      }

      /** 工具模式也要开额度窗口：只是不自动注入，工具调用同样受每请求预算约束。 */
      const ids = fresh.map((message) => String(message?.id ?? '')).filter(Boolean).sort();
      const win = openWindow(agent, { sessionId, turn, messageIds: ids });

      if (recallMode() !== 'adaptive') {
        clearPrepared(agent);
        return decision;
      }

      const query = view.newestUserQuery(fresh).slice(0, RECALL_QUERY_CHARS);
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
      const context = view.trustedContext(scope, {});
      const fingerprint = fingerprintOf(scope);
      const experiment = experimentFor(scope, { sessionId, query, batchKey: anchor.requestBatchKey(ids), messageIds: ids, win });
      const remembered = experiment && experiment.held
        ? rememberFeedback(scope, sessionId, fresh, experiment.held)
        : null;
      if (remembered && remembered.paused) {
        clearPrepared(agent);
        return decision;
      }
      const snapshot = projectRecall(scope, query, context, win);
      if (generation !== generations.get(agent)) return decision;
      /** 超时或被取消：这一步不留半旧卡片，下一真人请求重新投影。 */
      if (signal?.aborted || Date.now() - startedAt > RECALL_DEADLINE_MS) {
        clearPrepared(agent);
        return decision;
      }
      if (!snapshot && !(experiment && experiment.text)) {
        clearPrepared(agent);
        return decision;
      }
      const state = {
        text: snapshot ? snapshot.text : '',
        experimentText: experiment ? experiment.text : '',
        cards: snapshot ? snapshot.cards : [],
        query,
        sessionId,
        turn,
        signal,
        fingerprint,
        at: Date.now(),
      };
      prepared.set(agent, state);
      payloadBytes.set(sessionId, win.bytes);
      while (payloadBytes.size > 64) payloadBytes.delete(payloadBytes.keys().next().value);
      if (signal) signalAgents.set(signal, agent);
      const key = agentKey(agent);
      if (key && signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => clearPrepared(agent);
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanups.set(key, () => signal.removeEventListener('abort', onAbort));
      }
    } catch {
      clearPrepared(agent);
    }
    return decision;
  });


  /* ---------------- 项目自进化：一次短整理，先扣频次，再走提交门禁 ---------------- */

  /** 反馈只来自本轮真人消息；初始任务、工具成功、沉默都不算。 */
  function rememberFeedback(scope, sessionId, messages, held) {
    let candidate;
    try {
      candidate = learning.candidateFrom({
        messages, anchor: held.anchor, sessionId, projectId: scope.key, now: Date.now(),
      });
    } catch { return null; }
    if (!candidate) return null;
    candidate.cwd = scope.cwd;
    candidate.episodeUpdatedAt = held.episodeUpdatedAt || '';
    let paused = false;
    const injected = Array.isArray(held.injectedIds) ? held.injectedIds.filter(Boolean).slice(0, 8) : [];
    if (candidate.cue.negative && injected.length) {
      try {
        const result = pauseLearningRules(scope, injected, {
          by: 'feedback',
          reason: 'feedback_pending',
          operationId: `pause_${candidate.episodeId}_${candidate.messageIds.join('_')}`.slice(0, 120),
        });
        paused = Boolean(result && result.ok && result.changed);
      } catch { paused = false; }
    }
    feedbackCandidates.set(sessionId, { scope, candidate, held, paused, at: Date.now() });
    while (feedbackCandidates.size > 8) feedbackCandidates.delete(feedbackCandidates.keys().next().value);
    return { candidate, paused };
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
    const operationId = `learn_${crypto.createHash('sha256')
      .update(`${scope.key}|${candidate.episodeId}|${candidate.messageIds.join(',')}`)
      .digest('hex').slice(0, 16)}`;
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
    const llm = getService('llm');
    if (!llm || typeof llm.prepareCall !== 'function') {
      recordLearningFailure(scope, { operationId: `${operationId}_fail`, episodeId: candidate.episodeId, reason: '宿主没有可用模型', epoch: begin.epoch });
      return;
    }
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
      const parsed = learning.parseOutput(text, { finish, refs: input.refs, rules: input.rules, ranges });
      if (!parsed.ok) throw new Error(parsed.reason);
      const commit = commitLearning(scope, {
        operationId,
        epoch: begin.epoch,
        episodeId: candidate.episodeId,
        episodeUpdatedAt: candidate.episodeUpdatedAt,
        projectId: scope.key,
        sessionId: candidate.sessionId,
        messageIds: candidate.messageIds,
        changes: parsed.changes,
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

  /** 只在正常完成的人类回合后调度，一次一个项目；永不阻塞事件派发。 */
  function scheduleOrganizer(session, event) {
    const reason = event && event.data ? event.data.reason : null;
    if (!reason || reason.kind !== 'completed') return;
    const sessionId = sessionIdOfSession(session);
    if (!sessionId) return;
    const pending = feedbackCandidates.get(sessionId);
    if (!pending) return;
    feedbackCandidates.delete(sessionId);
    const scope = pending.scope;
    if (learningJobs.has(scope.key)) return;
    const job = { controller: learningAborts.get(scope.key) || null };
    learningJobs.set(scope.key, job);
    void organize(scope, session, pending)
      .catch(() => { /* 整理失败不影响会话 */ })
      .finally(() => { if (learningJobs.get(scope.key) === job) learningJobs.delete(scope.key); });
  }

  if (typeof ctx.on === 'function') ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    clearPrepared(agent);
    windows.delete(agentKey(agent));
    const sessionId = String(agent?.session?.id ?? '');
    if (sessionId) seenHumans.delete(sessionId);
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
