import {
  scopeOf,
  globalScope,
  upsert,
  search,
  readEntry,
  forget,
  renderIndex,
  loadIndex,
  suggestionGate,
  noteSuggestion,
  findSuggestion,
  normalizeDraft,
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
 * 「保留」和「✕」的唯一入口。
 * 定位只认完整标题 + 作用域；同名不止一条就拒绝，绝不猜。
 */
function keepHandler(webServer) {
  return async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: '只接受 POST' });
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && origin !== webServer.getOrigin()) {
      return sendJson(res, 403, { ok: false, reason: '来源不符' });
    }
    const pathname = String(req.url || '').split('?')[0];
    const isUndo = pathname === REMOTE_PATH + '/undo';
    const isKeep = pathname === REMOTE_PATH + '/keep';
    if (!isUndo && !isKeep) return sendJson(res, 404, { ok: false, reason: '未知操作' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '请求无法解析' });
    }
    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    if (cwd.length === 0) return sendJson(res, 400, { ok: false, reason: '请求不完整' });
    const scope = scopeOf(cwd);
    const wantsGlobal = body.scope === 'global';

    if (body.op === 'undo' || isUndo) {
      const sources = wantsGlobal ? [globalScope()] : [scope];
      let found = null;
      for (const source of sources) {
        const matches = loadIndex(source).entries.filter((item) => item.title === body.title);
        if (matches.length > 1) return sendJson(res, 409, { ok: false, reason: '同名条目不止一条，请按 id 指定' });
        if (matches.length === 1) found = { source, record: matches[0] };
      }
      if (!found) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
      try {
        forget(found.source, found.record.id);
        return sendJson(res, 200, { ok: true, id: found.record.id, title: found.record.title });
      } catch (error) {
        return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '归档失败' });
      }
    }

    const draft = findSuggestion(scope, typeof body.suggestionId === 'string' && body.suggestionId ? body.suggestionId : String(body.title || ''));
    if (!draft) return sendJson(res, 404, { ok: false, reason: '没有待保留的建议' });
    try {
      const saved = upsert(scope, draft);
      return sendJson(res, 200, { ok: true, id: saved.record.id, title: saved.record.title });
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '保存失败' });
    }
  };
}

const SAVE_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '要更新的记忆 id（来自搜索结果或相近提示）。同一件事更新时用它，别另建一条' },
    title: { type: 'string', description: `标题：名词短语，用户一眼能认出是哪件事，不超过 ${LIMITS.titleChars} 字。它就是这条记忆的身份` },
    summary: { type: 'string', description: `一句话说清要记的内容本身——用户只看这一行决定留不留，名词短语，不超过 ${LIMITS.summaryChars} 字` },
    body: { type: 'string', description: '正文 markdown。只写指针与要点，不抄录长文档' },
    when: { type: 'string', description: `前置条件或适用场景（「在哪台机器 / 哪个环境 / 什么情况下」），不超过 ${LIMITS.whenChars} 字。同一标题但前置条件不同，会存成两条，不合并` },
    kind: { type: 'string', enum: ['preference', 'convention', 'procedure', 'pointer', 'pitfall', 'credential_hint', 'note'], description: '条目类型' },
    tags: { type: 'array', items: { type: 'string' }, description: '最多 5 个标签' },
    scope: { type: 'string', enum: ['project', 'global'], description: '存哪一层：默认 project（只在这个项目生效）；用户说「以后所有项目都这样」才用 global' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
};

const SUGGEST_PARAMS = {
  ...SAVE_PARAMS,
  properties: Object.fromEntries(Object.entries(SAVE_PARAMS.properties).filter(([key]) => key !== 'scope' && key !== 'id')),
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
  properties: { id: { type: 'string', description: '要移入归档的记忆 id' } },
  required: ['id'],
  additionalProperties: false,
};

export function apply(ctx) {
  const tools = ctx.tools;

  ctx.effect(() => tools.register({
    name: 'memory_save',
    description: `保存一条记忆。用户明确说「记住」时直接调用；用户自己的话已经是长期规则（「以后都这样」「别再 X」）时也直接调用，不要先问。更新同一件事时带 id：身份只看标题、旧标题和前置条件，像不像不授权覆盖。没带 id 且标题跟已有条目不同，就新增一条，并在 similar 里报出最接近的候选——它其实就是同一条时，用那个 id 再存一次。正文合并只在同一 Markdown 章节内覆盖同名键，旧版本留在 versions 里。前置条件不同的同一标题是两条。${NOTES}`,
    parameters: SAVE_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          merged: { type: 'boolean' },
          scope: { type: 'string' },
          similar: { type: 'string' },
          similarId: { type: 'string' },
        },
        required: ['id', 'title', 'summary', 'merged', 'scope'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.merged ? 'memory · merged' : 'memory · saved'}${value.scope === 'global' ? ' [全局]' : ''} "${value.title}"${value.summary ? ` — ${value.summary}` : ''}${value.similar ? ` · 相近：${value.similar}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = args.scope === 'global' ? globalScope() : scopeOf(cwdOf(execution));
      const saved = upsert(scope, args);
      return {
        id: saved.record.id,
        title: saved.record.title,
        summary: saved.record.summary,
        merged: saved.merged,
        scope: scope.key === 'global' ? 'global' : 'project',
        ...(saved.similar ? { similar: saved.similar.title, similarId: saved.similar.id } : {}),
      };
    },
  }), 'lite-memory: memory_save');

  ctx.effect(() => tools.register({
    name: 'memory_suggest',
    description: `对一条用户没说、但跨会话还有用的经验提出保存建议。调用后对话里出现一个「保留」按钮，用户点了才进正式记忆。不要用问句征询「要不要记」，那要用户打字。一次对话最多建议一条，48 小时内每个项目一条。建议草稿与正式保存走同一套校验，凭据不会落盘；待确认草稿 48 小时过期。返回已有相近条目时，改用 memory_save 更新，不要再建议。${NOTES}`,
    parameters: SUGGEST_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          asked: { type: 'boolean' },
          title: { type: 'string' },
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['asked'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.asked
          ? `memory · suggested "${value.title}"`
          : `memory · skipped${value.reason ? `\n${value.reason}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const gate = suggestionGate(scope, args);
      if (!gate.ok) return { asked: false, reason: gate.reason };
      const noted = noteSuggestion(scope, args);
      return { asked: true, title: noted.title, id: noted.id };
    },
  }), 'lite-memory: memory_suggest');

  ctx.effect(() => tools.register({
    name: 'memory_search',
    description: `按需检索已有记忆：先搜，命中再 memory_read 读正文。用户提到「记住了什么 / 上次 / 规范 / 约定 / 路径 / 凭据怎么取」时先查这里。跨项目的通用条目以 [全局] 开头。中文长句可以直接当查询。`,
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
      const rendered = renderIndex(hits);
      return { count: hits.length, chars: rendered.chars, text: rendered.text };
    },
  }), 'lite-memory: memory_search');

  ctx.effect(() => tools.register({
    name: 'memory_read',
    description: '读一条记忆的正文。搜索结果里只有一行摘要，需要细节时按 id 读。',
    parameters: READ_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['id', 'title', 'body'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `memory · 「${value.title}」\n${value.body}` }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const record = readEntry(scope, args.id);
      if (!record) throw new Error(`没有 ${args.id} 这条记忆`);
      return { id: record.id, title: record.title, body: record.body };
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
        },
        required: ['id', 'title'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `memory · archived "${value.title}"` }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const dropped = forget(scope, args.id);
      if (!dropped) throw new Error(`没有 ${args.id} 这条记忆`);
      return { id: dropped.id, title: dropped.title };
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
