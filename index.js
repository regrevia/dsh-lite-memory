import {
  scopeOf,
  globalScope,
  upsert,
  peek,
  search,
  readEntry,
  forget,
  undoChange,
  locate,
  renderIndex,
  loadIndex,
  suggestionGate,
  noteSuggestion,
  acceptCandidate,
  rejectCandidate,
  recordCitations,
  listCitations,
  readCitationBody,
  LIMITS,
} from './store.js';

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
function keepHandler(webServer) {
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
            : pathname === REMOTE_PATH + '/body' ? 'body' : '';
    if (!action) return sendJson(res, 404, { ok: false, reason: '未知操作' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '请求无法解析' });
    }

    /** 引用列表与正文都按会话查，不需要项目路径。 */
    if (action === 'citations' || action === 'body') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) return sendJson(res, 400, { ok: false, reason: '缺少 sessionId' });
      if (action === 'citations') return sendJson(res, 200, { ok: true, ...listCitations(sessionId) });
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) return sendJson(res, 400, { ok: false, reason: '缺少 id' });
      const found = readCitationBody(sessionId, id);
      if (!found) return sendJson(res, 404, { ok: false, reason: '没有这条引用的正文' });
      return sendJson(res, 200, {
        ok: true,
        id: found.id,
        title: found.title,
        when: found.when || '',
        scope: found.scope,
        revision: found.revision,
        body: found.body,
      });
    }

    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    if (cwd.length === 0) return sendJson(res, 400, { ok: false, reason: '请求不完整' });
    const scope = scopeOf(cwd);
    const id = typeof body.id === 'string' ? body.id : '';
    const candidateId = typeof body.candidateId === 'string' && body.candidateId
      ? body.candidateId
      : typeof body.suggestionId === 'string' ? body.suggestionId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

    if (action === 'undo') {
      if (!id) return sendJson(res, 400, { ok: false, reason: '缺少 id' });
      if (!locate(scope, id)) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
      try {
        const undone = undoChange(scope, id);
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
    scope: { type: 'string', enum: ['project', 'global'], description: '存哪一层：默认 project（只在这个项目生效）；用户说「以后所有项目都这样」才用 global' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
};

const SUGGEST_PARAMS = {
  ...SAVE_PARAMS,
  properties: Object.fromEntries(Object.entries(SAVE_PARAMS.properties).filter(([key]) => key !== 'scope' && key !== 'id' && key !== 'resolution')),
};

const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要查的主题；用用户原话里的词，长句也行' },
    limit: { type: 'integer', minimum: 1, maximum: 6, description: '最多返回几条，默认 4' },
  },
  required: ['query'],
  additionalProperties: false,
};

const READ_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', description: '记忆 id，来自搜索结果' } },
  required: ['id'],
  additionalProperties: false,
};

const FORGET_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '要移入归档的记忆 id' },
  },
  required: ['id'],
  additionalProperties: false,
};

function scopeLabel(value) {
  return value.scope === 'global' ? ' [全局]' : '';
}

/** 自动提示只在用户这句话跟已有记忆真有关时出现；整条索引不常驻。 */
const HINT_QUERY_CHARS = 400;
const hintState = new Map();

function textOfMessage(message) {
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

function newestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const text = textOfMessage(message);
    if (text) return text;
  }
  return '';
}

function renderHint(items) {
  const rows = items.slice(0, 3).map((item) => `- 「${item.title}」${item.scope === 'global' ? ' [全局]' : ''} · ${item.id}`);
  return `已有记忆可能相关（需要细节用 memory_read 取正文，别凭标题猜）：\n${rows.join('\n')}`;
}

export function apply(ctx) {
  const tools = ctx.tools;

  ctx.effect(() => tools.register({
    name: 'memory_save',
    description: `保存一条记忆。用户明确说「记住」时直接调用；用户自己的话已经是长期规则（「以后都这样」「别再 X」）时也直接调用，不要先问。更新同一件事时带 id：身份只看标题、旧标题和前置条件，像不像不授权覆盖。文本相近但标题不同时先不写，返回 needsResolution 与 1–2 条相近条目：确实是同一条就用那个 id 更新，确实是另一条才带 resolution="distinct" 再存。带 id 更新时没给的字段保持原值，正文整段替换，旧版本留在 versions 里（每字都留，不截断）。超限直接报错，不悄悄截断。前置条件不同的同一标题是两条。${NOTES}`,
    parameters: SAVE_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          when: { type: 'string' },
          revision: { type: 'integer' },
          merged: { type: 'boolean' },
          scope: { type: 'string' },
          needsResolution: { type: 'boolean' },
          similarIds: { type: 'string' },
          similar: { type: 'string' },
        },
        required: ['id', 'title', 'summary', 'when', 'revision', 'merged', 'scope', 'needsResolution'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.needsResolution
          ? `memory · 需要确认：「${value.title}」与已有条目相近\n${value.similar}\n要更新它，用 id 重存；确实是另一条，加 resolution="distinct"`
          : `memory · ${value.merged ? 'merged' : 'saved'}${scopeLabel(value)} "${value.title}"${value.when ? `（${value.when}）` : ''} · ${value.id} · 第 ${value.revision} 版${value.similar ? ` · 相近：${value.similar}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = args.scope === 'global' ? globalScope() : scopeOf(cwdOf(execution));
      const saved = upsert(scope, args);
      if (saved.needsResolution) {
        return {
          id: '',
          title: saved.draft.title,
          summary: saved.draft.summary,
          when: saved.draft.when,
          revision: 0,
          merged: false,
          scope: scope.key === 'global' ? 'global' : 'project',
          needsResolution: true,
          similarIds: saved.similarList.map((item) => item.id).join('、'),
          similar: saved.similarList.map((item) => `${item.id}「${item.title}」${item.summary ? `｜${item.summary}` : ''}`).join('；'),
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
        scope: scope.key === 'global' ? 'global' : 'project',
        needsResolution: false,
        similarIds: saved.similarList.map((item) => item.id).join('、'),
        ...(saved.similar ? { similar: `${saved.similar.id}「${saved.similar.title}」` } : {}),
      };
    },
  }), 'lite-memory: memory_save');

  ctx.effect(() => tools.register({
    name: 'memory_suggest',
    description: `对一条用户没说、但跨会话还有用的经验提出保存建议。调用后对话里出现一个「保留」按钮，用户点了才进正式记忆。不要用问句征询「要不要记」，那要用户打字。一次对话最多建议一条，48 小时内每个项目一条。建议草稿与正式保存走同一套校验，凭据不会落盘；待确认草稿 48 小时过期，确认前就落盘所以撤回/过期都查得到。已有同一条时不再建议；相近的另一条会记成「更新候选」，保留后改的是那条，不会另建。${NOTES}`,
    parameters: SUGGEST_PARAMS,
    output: {
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
    description: `按需检索已有记忆：先搜，命中再 memory_read 读正文。用户提到「记住了什么 / 上次 / 规范 / 约定 / 路径 / 凭据怎么取」，或者眼前反复出现的报错、弹窗、异常时，先查这里有没有记过解法。跨项目的通用条目以 [全局] 开头。中文长句可以直接当查询。每行带 id 与版次，更新时把 id 传回 memory_save。`,
    parameters: SEARCH_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          chars: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['count', 'chars', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count > 0
          ? `memory · 命中 ${value.count} 条 · 引用 ${value.chars} 字\n${value.text}`
          : 'memory · 没有命中',
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const hits = search(scope, args.query, args.limit ?? 4);
      recordCitations(scope, sessionIdOf(execution), hits);
      const rendered = renderIndex(hits);
      return { count: hits.length, chars: rendered.chars, text: rendered.text };
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
          body: { type: 'string' },
        },
        required: ['id', 'title', 'when', 'revision', 'scope', 'body'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `memory · 「${value.title}」${value.when ? `（${value.when}）` : ''} · ${value.id} · 第 ${value.revision} 版${scopeLabel(value)}\n${value.body}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const record = readEntry(scope, args.id);
      if (!record) throw new Error(`没有 ${args.id} 这条记忆`);
      recordCitations(scope, sessionIdOf(execution), [record]);
      return {
        id: record.id,
        title: record.title,
        when: record.when || '',
        revision: record.revision || 1,
        scope: record.scope,
        body: record.body,
      };
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
        },
        required: ['id', 'title', 'scope'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `memory · archived${scopeLabel(value)} "${value.title}" · ${value.id}` }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const found = locate(scope, args.id);
      if (!found) throw new Error(`没有 ${args.id} 这条记忆`);
      const dropped = forget(scope, args.id);
      if (!dropped) throw new Error(`没有 ${args.id} 这条记忆`);
      return { id: dropped.id, title: dropped.title, scope: found.scope.key === 'global' ? 'global' : 'project' };
    },
  }), 'lite-memory: memory_forget');

  /** 「保留」「✕」按钮与统计都挂在 WebServer 上；没有该服务时工具照常可用。 */
  const mountRoute = (holder) => {
    const webServer = holder.webServer ?? holder;
    if (!webServer || typeof webServer.register !== 'function' || typeof webServer.getOrigin !== 'function') return;
    holder.effect(() => webServer.register({ kind: 'prefix', path: REMOTE_PATH, handler: keepHandler(webServer) }), 'lite-memory: keep route');
  };
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (scope) => mountRoute(scope));
  else mountRoute(ctx);

  /**
   * 命中才提示：用户消息进来时只查一次（只读，不动 hits），命中就把标题挂到本步的
   * 运行时上下文里；模型要看正文仍然自己调 memory_read。没命中时这段是空字符串。
   */
  const getService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);
  const prompt = getService('systemPrompt');
  if (prompt && typeof prompt.context === 'function') {
    ctx.effect(() => prompt.context({
      name: 'lite-memory:hint',
      order: 30,
      interpolate: false,
      text: () => {
        try {
          if (hintState.size === 0) return '';
          const agents = getService('agents');
          const agent = typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : undefined;
          console.log(`[lite-memory] hint render ${agent?.id ? 'ok' : 'no-agent'}`);
          const state = hintState.get(String(agent?.id ?? ''));
          if (!state || !state.items.length) return '';
          return renderHint(state.items);
        } catch {
          return '';
        }
      },
    }), 'lite-memory: hint context');
  }

  if (typeof ctx.on === 'function') ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      const sessionId = String(payload?.agent?.id ?? '');
      const text = newestUserText(payload?.messages).slice(0, HINT_QUERY_CHARS);
      if (!sessionId || !text) return decision;
      const previous = hintState.get(sessionId);
      if (previous && previous.text === text) return decision;
      const items = peek(scopeOf(cwdOf({ agent: payload.agent })), text, 3);
      if (items.length === 0) {
        hintState.delete(sessionId);
      } else {
        hintState.set(sessionId, { text, items, at: Date.now() });
        console.log(`[lite-memory] hint ${items.map((item) => item.id).join(',')}`);
      }
    } catch {
      /* 提示只是锦上添花，坏了就当没命中 */
    }
    return decision;
  });

  if (typeof ctx.on === 'function') ctx.on('agent/disposed', (payload) => {
    const sessionId = String(payload?.agent?.id ?? '');
    if (sessionId) hintState.delete(sessionId);
  });

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
