import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-contract-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');

const ORIGIN = 'http://127.0.0.1:60402';
const defs = new Map();
let route = null;

const webServer = { getOrigin: () => ORIGIN, register: (entry) => { route = entry; return () => {}; } };
const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; };
let currentAgent = null;
const subscriptions = new Map();
const promptContexts = [];
const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
  effect,
  inject: (deps, callback) => { if (deps.includes('webServer')) callback({ webServer, effect }); return () => {}; },
  get: (name) => {
    if (name === 'systemPrompt') return { context: (entry) => { promptContexts.push(entry); return () => {}; } };
    if (name === 'agents') return { currentInitiator: () => currentAgent };
    return undefined;
  },
  on: (event, handler) => { subscriptions.set(event, handler); return () => {}; },
};
apply(ctx);

const cwd = path.join(os.tmpdir(), 'lite-memory-contract-project');
fs.mkdirSync(cwd, { recursive: true });

const exec = (name, args) => defs.get(name).execute(args, { agent: { cwd, session: { id: 'session-contract', header: { cwd } } } });
const render = (name, args, value) => defs.get(name).output.render(args, value)[0].text;

function call(pathname, payload, options = {}) {
  const req = new EventEmitter();
  req.method = options.method ?? 'POST';
  req.url = pathname;
  req.headers = { origin: options.origin ?? ORIGIN };
  req.destroy = () => {};
  const res = {
    status: 0,
    text: '',
    writeHead(status) { this.status = status; },
    end(body) { this.text = body; this.finish(); },
  };
  const done = new Promise((resolve) => { res.finish = () => resolve(res); });
  route.handler(req, res);
  if (req.method === 'POST') {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }
  return done.then((value) => ({ status: value.status, body: JSON.parse(value.text || '{}') }));
}

const json = (body) => JSON.parse(body);

// ── tool contract ────────────────────────────────────────────────────────────
const names = ['memory_save', 'memory_suggest', 'memory_search', 'memory_read', 'memory_forget'];
assert.deepEqual([...defs.keys()].sort(), [...names].sort());
for (const name of names) {
  const def = defs.get(name);
  assert.equal(def.parameters.type, 'object');
  assert.equal(def.parameters.additionalProperties, false);
  assert.equal(typeof def.output.render, 'function');
  assert.equal(typeof def.output.schema, 'object');
  assert.ok(def.parameters.required.length >= 1);
}

const saveParams = defs.get('memory_save').parameters.properties;
assert.deepEqual(saveParams.resolution.enum, ['distinct']);
assert.equal(saveParams.id.type, 'string');
assert.deepEqual(saveParams.scope.enum, ['project', 'global']);
assert.equal(defs.get('memory_suggest').parameters.properties.scope, undefined);
assert.equal(defs.get('memory_suggest').parameters.properties.resolution, undefined);

// ── save → render, then update ───────────────────────────────────────────────
const saved = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步' });
assert.equal(saved.needsResolution, false);
assert.equal(saved.merged, false);
assert.equal(saved.scope, 'project');
assert.equal(typeof saved.id, 'string');
assert.match(render('memory_save', {}, saved), /^memory · saved "发布顺序" · mem_[a-z0-9]+ · 第 1 版$/);

const merged = await exec('memory_save', { title: '发布顺序', summary: '发版前要按顺序做的事', body: '第一步\n第二步' });
assert.equal(merged.merged, true);
assert.equal(merged.id, saved.id);
assert.equal(merged.revision, 2);
assert.match(render('memory_save', {}, merged), /^memory · merged "发布顺序" · mem_[a-z0-9]+ · 第 2 版$/);

const patch = await exec('memory_save', { id: saved.id, title: '发布顺序', summary: '发版前要按顺序做的事', when: '发版当天' });
assert.equal(patch.when, '发版当天');
assert.match(render('memory_save', {}, patch), /（发版当天）/);

// ── similar title asks before overwriting ────────────────────────────────────
const probe = await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '另一条' });
assert.equal(probe.needsResolution, true);
assert.equal(probe.id, '');
assert.equal(probe.revision, 0);
assert.ok(probe.similarIds.length > 0);
const probeText = render('memory_save', {}, probe);
assert.match(probeText.split('\n')[0], /^memory · 需要确认：「发布顺序是啥」与已有条目相近$/);
assert.match(probeText, /要更新它，用 id 重存/);
assert.match(probeText, new RegExp(saved.id));
const distinct = await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '另一条', resolution: 'distinct' });
assert.equal(distinct.needsResolution, false);
assert.equal(distinct.merged, false);
assert.notEqual(distinct.id, saved.id);

// ── search / read / forget ───────────────────────────────────────────────────
const hits = await exec('memory_search', { query: '发布流程' });
assert.ok(hits.count >= 1);
assert.ok(hits.chars > 0);
const hitText = render('memory_search', {}, hits);
assert.match(hitText, new RegExp(`^memory · 命中 ${hits.count} 条 · 引用 ${hits.chars} 字\\n- mem_`));
assert.match(hitText, /第 3 版/);
const miss = await exec('memory_search', { query: '完全没有出现过的主题' });
assert.equal(miss.count, 0);
assert.equal(render('memory_search', {}, miss), 'memory · 没有命中');

const read = await exec('memory_read', { id: saved.id });
assert.equal(read.body, '第一步\n第二步');
assert.equal(read.revision, 3);
assert.match(render('memory_read', {}, read), new RegExp(`^memory · 「发布顺序」（发版当天） · ${saved.id} · 第 3 版`));

const archived = await exec('memory_forget', { id: distinct.id });
assert.equal(archived.id, distinct.id);
assert.match(render('memory_forget', {}, archived), new RegExp(`^memory · archived "发布顺序是啥" · ${distinct.id}$`));
assert.equal(await exec('memory_save', { title: '发布顺序是啥', summary: '发版前要按顺序做的事', body: '第三条' }).then((v) => v.merged), false);

// ── suggestion → keep → replay → reject ──────────────────────────────────────
const suggested = await exec('memory_suggest', { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint', body: 'node ui-copy-lint.mjs', when: '发布前' });
assert.equal(suggested.asked, true);
assert.match(suggested.id, /^sug_[a-z0-9]+$/);
assert.match(render('memory_suggest', {}, suggested), /^memory · suggested "发布前跑文案检查" · sug_[a-z0-9]+$/);

const duplicate = await exec('memory_suggest', { title: '发布前跑文案检查', summary: '发版前先跑 ui 文案 lint' });
assert.equal(duplicate.asked, false);
assert.match(render('memory_suggest', {}, duplicate), /^memory · skipped\n48 小时内已经建议过一条$/);

const kept = await call('/lite-memory/keep', { op: 'keep', candidateId: suggested.id, operationId: 'op_contract', cwd });
assert.equal(kept.status, 200);
assert.equal(kept.body.ok, true);
assert.equal(kept.body.mode, 'created');
const stored = store.search(store.scopeOf(cwd), '发布前跑文案检查')[0];
assert.equal(stored.when, '发布前');
assert.equal(store.readEntry(store.scopeOf(cwd), stored.id).body, 'node ui-copy-lint.mjs');

const replay = await call('/lite-memory/keep', { op: 'keep', candidateId: suggested.id, operationId: 'op_contract', cwd });
assert.equal(replay.status, 200);
assert.equal(replay.body.replay, true);
assert.equal(replay.body.id, kept.body.id);
const reused = await call('/lite-memory/keep', { op: 'keep', candidateId: suggested.id, operationId: 'op_contract_other', cwd });
assert.equal(reused.status, 404);
assert.equal(reused.body.ok, false);

const scope = store.scopeOf(cwd);
const reset = store.loadIndex(scope);
reset.lastSuggestedAt = '';
store.saveIndex(scope, reset);
const another = await exec('memory_suggest', { title: '另一条待确认建议', summary: '用来测试拒绝的候选' });
assert.equal(another.asked, true);
const rejected = await call('/lite-memory/reject', { op: 'reject', candidateId: another.id, cwd });
assert.equal(rejected.status, 200);
assert.equal(rejected.body.ok, true);

// ── undo by id; old title-based payloads are refused ─────────────────────────
const undone = await call('/lite-memory/undo', { op: 'undo', id: kept.body.id, cwd });
assert.equal(undone.status, 200);
assert.equal(undone.body.mode, 'archived');
assert.equal(store.loadIndex(store.scopeOf(cwd)).entries.some((entry) => entry.id === kept.body.id), false);
const byTitle = await call('/lite-memory/undo', { op: 'undo', title: '发布顺序', cwd });
assert.equal(byTitle.status, 400);
const missing = await call('/lite-memory/undo', { op: 'undo', id: 'mem_000000000000', cwd });
assert.equal(missing.status, 404);

// ── route guards ─────────────────────────────────────────────────────────────
assert.equal((await call('/lite-memory/keep', { candidateId: 'sug_000000', cwd }, { origin: 'http://evil.example' })).status, 403);
assert.equal((await call('/lite-memory/keep', { candidateId: 'sug_000000' })).status, 400);
assert.equal((await call('/lite-memory/keep', { cwd })).status, 400);
assert.equal((await call('/lite-memory/undo', { cwd })).status, 400);
assert.equal((await call('/lite-memory/unknown', { cwd })).status, 404);
assert.equal((await call('/lite-memory/keep', {}, { method: 'GET' })).status, 405);

// ── global layer ─────────────────────────────────────────────────────────────
const global = await exec('memory_save', { title: '回复用中文', summary: '用户要求回复用中文', scope: 'global' });
assert.equal(global.scope, 'global');
assert.match(render('memory_save', {}, global), /^memory · saved \[全局\] "回复用中文" · mem_[a-z0-9]+ · 第 1 版$/);
const globalSearch = await exec('memory_search', { query: '回复用中文' });
assert.equal(globalSearch.count, 1);
assert.match(render('memory_search', {}, globalSearch), /\[全局\] mem_/);
assert.equal(typeof globalThis.__liteMemoryStats, 'function');
const stats = globalThis.__liteMemoryStats(cwd);
assert.ok(stats.count >= 1);

// ── 引用条：会话读过哪几条，点开能拿到正文 ───────────────────────────────────
const cited = await exec('memory_save', { title: '引用测试', summary: '底部引用条要能点开正文', body: '引用正文第一行' });
await exec('memory_read', { id: cited.id });
const cites = await call('/lite-memory/citations', { sessionId: 'session-contract' });
assert.equal(cites.status, 200);
assert.ok(cites.body.items.some((item) => item.id === cited.id && item.title === '引用测试'));
assert.equal(cites.body.items.some((item) => 'path' in item), false);
const opened = await call('/lite-memory/body', { sessionId: 'session-contract', id: cited.id });
assert.equal(opened.status, 200);
assert.match(opened.body.body, /引用正文第一行/);
assert.equal((await call('/lite-memory/body', { sessionId: 'session-contract', id: 'mem_999999999999' })).status, 404);
assert.equal((await call('/lite-memory/citations', {})).status, 400);
assert.equal((await call('/lite-memory/citations', {}, { origin: 'http://evil.example' })).status, 403);
assert.notEqual((await call('/lite-memory/citations', { sessionId: 'session-contract' }, { origin: 'dsh-app://app' })).status, 403);
assert.notEqual((await call('/lite-memory/keep', { candidateId: 'sug_000000', cwd }, { origin: 'dsh-app://app' })).status, 403);
assert.equal((await call('/lite-memory/citations', {}, { method: 'GET' })).status, 405);

// ── 自动提示：只在这句话跟已有记忆有关时出现，且不改命中计数 ─────────────────
const hinted = await exec('memory_save', { title: 'Chrome 弹钥匙串窗口要带 mock keychain', summary: '临时 profile 起 Chrome 会弹钥匙串窗口', when: '用 Chrome 抓页面时' });
currentAgent = { id: 'session-contract', cwd };
const preStep = subscriptions.get('agent/pre-step');
assert.equal(typeof preStep, 'function');
const pass = async () => ({ kind: 'enter', messages: [] });
const hitsBefore = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hinted.id).hits;
await preStep({ agent: currentAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '又弹钥匙串窗口了，怎么弄' }] }], turn: 2, step: 0 }, pass);
assert.equal(promptContexts.length, 1);
assert.equal(promptContexts[0].name, 'lite-memory:hint');
const hintText = promptContexts[0].text();
assert.match(hintText, new RegExp(hinted.id));
assert.match(hintText, /需要细节用 memory_read/);
const hitsAfter = store.loadIndex(store.scopeOf(cwd)).entries.find((item) => item.id === hinted.id).hits;
assert.equal(hitsAfter, hitsBefore);
await preStep({ agent: currentAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '把这个按钮的圆角改小一点' }] }], turn: 3, step: 0 }, pass);
assert.equal(promptContexts[0].text(), '');
assert.equal(subscriptions.has('agent/disposed'), true);

console.log('contract.test.mjs: all passed');
