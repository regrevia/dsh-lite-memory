import {
  scopeOf,
  upsert,
  search,
  readEntry,
  forget,
  renderIndex,
  loadIndex,
  suggestionGate,
  noteSuggestion,
  findSuggestion,
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

/** 「保留」和「✕」的唯一入口：保留只认已经建议过的那条，删除只按标题找已有条目。 */
function keepHandler(webServer) {
  return async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: '只接受 POST' });
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && origin !== webServer.getOrigin()) {
      return sendJson(res, 403, { ok: false, reason: '来源不符' });
    }
    const pathname = String(req.url || '').split('?')[0];
    const known = pathname === REMOTE_PATH + '/keep' || pathname === REMOTE_PATH + '/undo';
    if (!known) return sendJson(res, 404, { ok: false, reason: '未知操作' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '请求无法解析' });
    }
    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    const title = typeof body.title === 'string' ? body.title : '';
    if (cwd.length === 0 || title.length === 0) return sendJson(res, 400, { ok: false, reason: '请求不完整' });
    const scope = scopeOf(cwd);
    if (body.op === 'undo' || pathname === REMOTE_PATH + '/undo') {
      const record = loadIndex(scope).entries.find((item) => item.title === title);
      if (!record) return sendJson(res, 404, { ok: false, reason: '没有这条记忆' });
      try {
        forget(scope, record.id);
        return sendJson(res, 200, { ok: true, title: record.title, id: record.id });
      } catch (error) {
        return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '删除失败' });
      }
    }
    const draft = findSuggestion(scope, title);
    if (!draft) return sendJson(res, 404, { ok: false, reason: '没有待保留的建议' });
    try {
      const saved = upsert(scope, draft);
      return sendJson(res, 200, { ok: true, title: saved.record.title, id: saved.record.id });
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: error instanceof Error ? error.message : '保存失败' });
    }
  };
}

const SAVE_PARAMS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: `标题：名词短语，用户一眼能认出是哪件事，不超过 ${LIMITS.titleChars} 字` },
    summary: { type: 'string', description: `一句话说清要记的内容本身——用户只看这一行决定留不留，名词短语，不超过 ${LIMITS.summaryChars} 字` },
    body: { type: 'string', description: '正文 markdown。只写指针与要点，不抄录长文档' },
    kind: { type: 'string', enum: ['preference', 'convention', 'procedure', 'pointer', 'pitfall', 'credential_hint', 'note'], description: '条目类型' },
    tags: { type: 'array', items: { type: 'string' }, description: '最多 5 个标签' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
};

const SUGGEST_PARAMS = SAVE_PARAMS;

const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要查的主题；用用户原话里的词' },
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

function text(blocks) {
  return blocks.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)));
}

export function apply(ctx) {
  const tools = ctx.tools;

  ctx.effect(() => tools.register({
    name: 'memory_save',
    description: `保存一条记忆。用户明确说「记住」时直接调用；用户自己的话已经是长期规则（「以后都这样」「别再 X」）时也直接调用，不要先问。用户点了「保留」或发「保留记忆「X」」时，用那条建议的内容调用。${NOTES}`,
    parameters: SAVE_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          merged: { type: 'boolean' },
        },
        required: ['id', 'title', 'summary', 'merged'],
        additionalProperties: false,
      },
      render: (value) => [{
        type: 'text',
        text: `${value.merged ? 'memory · merged' : 'memory · saved'} "${value.title}"${value.summary ? ` — ${value.summary}` : ''}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const saved = upsert(scope, args);
      return { id: saved.record.id, title: saved.record.title, summary: saved.record.summary, merged: saved.merged };
    },
  }), 'lite-memory: memory_save');

  ctx.effect(() => tools.register({
    name: 'memory_suggest',
    description: `对一条用户没说、但跨会话还有用的经验提出保存建议。调用后对话里出现一个「保留」按钮，用户点了才保存。不要用问句征询「要不要记」，那要用户打字；按钮不打扰对话。一次对话最多建议一条，问自己「下次会话还得靠它吗」，不确定就别建议。${NOTES}`,
    parameters: SUGGEST_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          asked: { type: 'boolean' },
          title: { type: 'string' },
          summary: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['asked', 'title', 'summary'],
        additionalProperties: false,
      },
      render: (value) => [{
        type: 'text',
        text: value.asked
          ? `memory · keep? "${value.title}"${value.summary ? ` — ${value.summary}` : ''}`
          : 'memory · skipped',
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const gate = suggestionGate(scope, args.title);
      const summary = String(args.summary ?? '');
      if (!gate.ok) return { asked: false, title: String(args.title ?? ''), summary, reason: gate.reason };
      noteSuggestion(scope, args, 'asked');
      return { asked: true, title: String(args.title ?? ''), summary };
    },
  }), 'lite-memory: memory_suggest');

  ctx.effect(() => tools.register({
    name: 'memory_search',
    description: `按关键词检索已有记忆，返回标题与一句话摘要（最多 4 条）。用户提到「记住过 / 上次 / 规范 / 约定 / 路径 / 凭据怎么取」时先查这里。命中后再用 memory_read 取正文。${NOTES}`,
    parameters: SEARCH_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          chars: { type: 'integer' },
          index: { type: 'string' },
        },
        required: ['count', 'chars', 'index'],
        additionalProperties: false,
      },
      render: (value) => [{
        type: 'text',
        text: value.count === 0 ? 'memory · no hits' : `memory · ${value.count} hits\n${value.index}`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const hits = search(scope, args.query, args.limit ?? 4);
      const rendered = renderIndex(hits);
      return { count: hits.length, chars: rendered.chars, index: rendered.text };
    },
  }), 'lite-memory: memory_search');

  ctx.effect(() => tools.register({
    name: 'memory_read',
    description: '读取一条记忆的正文。只在摘要不足以回答时才调用。',
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
      render: (value) => text([{ type: 'text', text: value.body }]),
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const { record, body } = readEntry(scope, args.id);
      return { id: record.id, title: record.title, body };
    },
  }), 'lite-memory: memory_read');

  ctx.effect(() => tools.register({
    name: 'memory_forget',
    description: '把一条记忆移入归档。用户说「别记这个 / 删掉那条」时调用；归档不删除文件。',
    parameters: FORGET_PARAMS,
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' } },
        required: ['id', 'title'],
        additionalProperties: false,
      },
      render: (value) => [{
        type: 'text',
        text: `memory · dropped "${value.title}"`,
      }],
    },
    execute: async (args, execution) => {
      const scope = scopeOf(cwdOf(execution));
      const record = forget(scope, args.id);
      return { id: record.id, title: record.title };
    },
  }), 'lite-memory: memory_forget');

  /** 「保留」走同源路由：点击只写盘，不产生消息，也不打断对话。 */
  const mountRoute = (holder) => {
    const webServer = typeof holder.get === 'function' ? holder.get('webServer', false) : holder.webServer;
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
