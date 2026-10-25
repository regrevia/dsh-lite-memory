import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-'));
process.env.DSH_HOME = home;

const { apply } = await import('../index.js');
const store = await import('../store.js');

const cwd = '/tmp/contract-project';
const tools = {};
let route = null;
const webServer = {
  getOrigin: () => 'http://127.0.0.1:52345',
  register: ({ path: prefix, handler }) => {
    assert.equal(prefix, '/lite-memory');
    route = handler;
    return () => {};
  },
};
const ctx = {
  tools: {
    register(definition) {
      tools[definition.name] = definition;
      return () => {};
    },
  },
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(deps, callback) {
    if (deps.includes('webServer')) callback({ webServer, effect: (fn) => fn() });
  },
};
apply(ctx);

const call = (name, args, execution = { agent: { cwd } }) => tools[name].execute(args, execution);

// 工具契约：五个工具都在，render 拿得到 (args, value)。
assert.deepEqual(Object.keys(tools).sort(), ['memory_forget', 'memory_read', 'memory_save', 'memory_search', 'memory_suggest']);
assert.equal(tools.memory_save.parameters.properties.scope.enum.includes('global'), true);
assert.equal(tools.memory_save.parameters.properties.id.type, 'string');
assert.equal(tools.memory_suggest.parameters.properties.scope, undefined);

// 保存 → 结果行来自真实返回值，而不是入参。
const saved = await call('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '- 顺序：tag → push → publish' });
assert.equal(saved.merged, false);
assert.equal(saved.scope, 'project');
const savedBlock = tools.memory_save.output.render({ title: '发布顺序' }, saved);
assert.equal(Array.isArray(savedBlock), true);
assert.equal(savedBlock[0].type, 'text');
assert.match(savedBlock[0].text, /^memory · saved "发布顺序" — 发版前要按顺序做的事$/);
assert.equal(savedBlock[0].text.includes('undefined'), false);

// 检索：命中数、字数、前缀都来自真实条目。
const found = await call('memory_search', { query: '上次发布顺序是什么' });
assert.equal(found.count, 1);
assert.ok(found.chars > 0);
const searchBlock = tools.memory_search.output.render({ query: 'x' }, found);
assert.match(searchBlock[0].text, /^memory · 命中 1 条 · 引用 \d+ 字\n- mem_/);
assert.equal(searchBlock[0].text.includes('undefined'), false);
const missBlock = tools.memory_search.output.render({}, { count: 0, chars: 0, text: '' });
assert.equal(missBlock[0].text, 'memory · 没有命中');

// 读正文：官方契约要 [{ type:'text', text: body }]，不是字符串数组。
const detail = await call('memory_read', { id: saved.id });
assert.match(detail.body, /publish/);
const readBlock = tools.memory_read.output.render({ id: saved.id }, detail);
assert.equal(readBlock.length, 1);
assert.equal(typeof readBlock[0].text, 'string');
assert.match(readBlock[0].text, /publish/);
assert.match(readBlock[0].text, /「发布顺序」/);

// 同一个标题再存：合并，入口不变。
const again = await call('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '- 例外：只改文档时不发版' });
assert.equal(again.merged, true);
assert.equal(again.id, saved.id);
assert.match(tools.memory_save.output.render({}, again)[0].text, /^memory · merged "发布顺序"/);

// 建议 → 按钮保留：草稿里的 when 一路带进正式条目。
const suggested = await call('memory_suggest', { title: '发布前跑文案检查', summary: '交付前的文案检查步骤', when: '发布前', body: '- 命令：node scripts/lint.mjs' });
assert.equal(suggested.asked, true);
assert.match(tools.memory_suggest.output.render({}, suggested)[0].text, /^memory · suggested "发布前跑文案检查"$/);
const kept = await post('/lite-memory/keep', { op: 'keep', title: '发布前跑文案检查', cwd });
assert.equal(kept.status, 200);
assert.equal(kept.body.ok, true);
const scope = store.scopeOf(cwd);
const keptEntry = store.loadIndex(scope).entries.find((item) => item.title === '发布前跑文案检查');
assert.ok(keptEntry);
assert.equal(keptEntry.when, '发布前');
assert.match(store.readEntry(scope, keptEntry.id).body, /lint\.mjs/);

// 点「✕」：按完整标题归档，进 archive/，记录也留着。
const dropped = await post('/lite-memory/undo', { op: 'undo', title: '发布前跑文案检查', cwd });
assert.equal(dropped.status, 200);
assert.equal(store.loadIndex(scope).entries.some((item) => item.title === '发布前跑文案检查'), false);
assert.ok(fs.existsSync(path.join(scope.dir, 'archive', `${dropped.body.id}.json`)));

// 同名但前置条件不同：按钮拒绝猜，返回 409 而不是删错。
await call('memory_save', { title: '构建耗时', summary: '本机构建要几分钟', when: 'macOS' });
await call('memory_save', { title: '构建耗时', summary: '本机构建要几分钟', when: 'CI' });
const ambiguous = await post('/lite-memory/undo', { op: 'undo', title: '构建耗时', cwd });
assert.equal(ambiguous.status, 409);
assert.equal(store.loadIndex(scope).entries.filter((item) => item.title === '构建耗时').length, 2);

// 全局条目：结果行带 [全局]，按钮也只动全局层。
const globalSaved = await call('memory_save', { title: '回复用中文', summary: '所有项目的中文回复约定', scope: 'global' });
assert.equal(globalSaved.scope, 'global');
assert.match(tools.memory_save.output.render({}, globalSaved)[0].text, /\[全局\] "回复用中文"/);
const globalDropped = await post('/lite-memory/undo', { op: 'undo', title: '回复用中文', cwd, scope: 'global' });
assert.equal(globalDropped.status, 200);
assert.equal(store.loadIndex(store.globalScope()).entries.length, 0);

// 路由边界：外部 Origin 拒绝，非 POST 拒绝。
const forbidden = await post('/lite-memory/undo', { op: 'undo', title: '发布顺序', cwd }, { origin: 'http://evil.test' });
assert.equal(forbidden.status, 403);
const wrongMethod = await post('/lite-memory/undo', { op: 'undo', title: '发布顺序', cwd }, { method: 'GET' });
assert.equal(wrongMethod.status, 405);

fs.rmSync(home, { recursive: true, force: true });
console.log('contract: tool → render → button 链路 ok');

async function post(url, payload, options = {}) {
  const raw = JSON.stringify(payload);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = options.method ?? 'POST';
  req.url = url;
  req.headers = { origin: options.origin ?? webServer.getOrigin(), 'content-type': 'application/json' };
  const res = {
    status: 0,
    body: '',
    writeHead(code) {
      this.status = code;
    },
    end(text) {
      this.body = text;
    },
  };
  await route(req, res);
  res.body = res.body ? JSON.parse(res.body) : null;
  return res;
}
