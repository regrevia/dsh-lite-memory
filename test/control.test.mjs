import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-control-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');
const state = await import('../state.js');

const effect = (fn) => {
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};

function boot() {
  const defs = new Map();
  const handlers = new Map();
  const promptContexts = [];
  const ctx = {
    tools: { register: (def) => { defs.set(def.name, def); return () => {}; } },
    effect,
    inject: () => () => {},
    get: (name) => (name === 'systemPrompt'
      ? { context: (entry) => { promptContexts.push(entry); return () => {}; } }
      : name === 'agents' ? { currentInitiator: () => null } : undefined),
    on: (event, handler) => {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };
  apply(ctx, { mode: 'adaptive' });
  const provider = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
  const exec = (name, args, agent) => defs.get(name).execute(args, { agent });
  const preStep = (payload, decision) => handlers.get('agent/pre-step').at(-1)(payload, async () => decision);
  return { exec, preStep, text: (agent, signal) => provider.text({ agent, signal }), debug: globalThis.__liteMemoryRecall };
}

let seq = 0;
const human = (body) => { seq += 1; return { role: 'user', id: `msg-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text: body }] }; };
const enter = (...messages) => ({ kind: 'enter', messages });
const mkdir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `lite-memory-control-${label}-`));
const makeAgent = (id, dir) => ({ id, cwd: dir, session: { id: `session-${id}`, header: { cwd: dir } } });
const save = (scope, fields) => store.upsert(scope, {
  applicability: 'all_in_scope',
  body: `正文：${fields.title}`,
  resolution: 'distinct',
  ...fields,
  summary: fields.summary ?? `${fields.title}的摘要`,
});
const seedRule = (scope, title) => {
  const saved = save(scope, { title, tags: ['口播'] });
  const id = saved.record?.id ?? saved.id;
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === id);
    row.origin = 'project_evolution';
    row.current.conditions = [{ key: 'seriesId', value: '口播' }];
    row.maintenance.learning = { state: 'active' };
    return { changed: true };
  });
  return id;
};
const scopeOf = (dir) => store.scopeOf(dir);
const toggle = (scope, enabled) => store.setMemoryEnabled(scope, enabled, { operationId: `op-${Math.random().toString(16).slice(2)}` });

/* C01：总开关关闭后，自动注入、全局召回、检索、读取、写入、学习全部停。 */
{
  const dir = mkdir('off');
  const scope = scopeOf(dir);
  const globalSaved = save(store.globalScope(), { title: '全局写作偏好', tags: ['写作'] });
  const globalId = globalSaved.record?.id ?? globalSaved.id;
  save(scope, { title: '项目构建约定', tags: ['构建'] });
  seedRule(scope, '口播开头');
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-on' }).ok, true);
  assert.equal(toggle(scope, false).ok, true);
  assert.equal(store.controlStatus(scope).enabled, false);

  const runtime = boot();
  const agent = makeAgent('a-off', dir);
  const sig = new AbortController().signal;
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('按全局写作偏好来修构建脚本')));
  assert.equal(runtime.text(agent, sig), '');
  assert.equal(runtime.debug.preparedOf(agent), null);

  const found = await runtime.exec('memory_search', { query: '写作 构建 口播开头' }, agent);
  assert.equal(found.status, 'memory_disabled');
  assert.equal(found.count, 0);
  assert.ok(globalId);
  assert.equal((await runtime.exec('memory_read', { id: globalId }, agent)).status, 'memory_disabled');
  assert.equal((await runtime.exec('memory_forget', { id: globalId, mode: 'archive' }, agent)).mode, 'memory_disabled');
  const suggested = await runtime.exec('memory_suggest', { title: '新偏好', summary: '一条偏好' }, agent);
  assert.equal(suggested.asked, false);
}

/* C02：关闭期间所有写入入口都拒绝，自进化不能绕过总开关打开。 */
{
  const dir = mkdir('write');
  const scope = scopeOf(dir);
  assert.equal(toggle(scope, false).ok, true);
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-blocked' }).ok, false);
  const saved = store.saveEntry(scope, { title: '一条项目规范', summary: '普通摘要', body: '正文', kind: 'convention', scope: 'project', durability: 'durable' });
  assert.equal(saved.reasonCode, 'memory_disabled');
  const task = store.saveTaskState(scope, { version: 1, sessions: {}, episodes: {}, defaults: null, revision: 1 }, { operationId: 'task-blocked' });
  assert.equal(task.ok, false);
  const committed = store.commitLearning(scope, { title: '学习规则', summary: '摘要', body: '正文' }, {}, { operationId: 'learn-blocked' });
  assert.equal(committed.ok, false);
  const run = store.setEvolution(scope, false, { operationId: 'evo-off' });
  assert.equal(run.ok, true);
  assert.equal(store.controlStatus(scope).enabled, false);
}

/* C03：关一个项目不影响另一个；重新打开恢复原来的自进化设置。 */
{
  const dirA = mkdir('iso-a');
  const dirB = mkdir('iso-b');
  const scopeA = scopeOf(dirA);
  const scopeB = scopeOf(dirB);
  save(scopeB, { title: 'B 项目构建约定', tags: ['构建', '脚本'] });
  seedRule(scopeB, '口播开头');
  assert.equal(store.setEvolution(scopeB, true, { operationId: 'evo-b' }).ok, true);
  assert.equal(toggle(scopeA, false).ok, true);
  assert.equal(store.evolutionStatus(scopeB).enabled, true);
  assert.equal(store.controlStatus(scopeB).enabled, true);

  const runtime = boot();
  const agentB = makeAgent('b-live', dirB);
  const sigB = new AbortController().signal;
  await runtime.preStep({ agent: agentB, signal: sigB, turn: 't1' }, enter(human('按项目构建约定改脚本')));
  assert.match(runtime.text(agentB, sigB), /B 项目构建约定/);

  toggle(scopeB, false);
  assert.equal(store.evolutionStatus(scopeB).enabled, false);
  assert.equal(store.evolutionStatus(scopeB).configuredEnabled, true);
  toggle(scopeB, true);
  assert.equal(store.evolutionStatus(scopeB).enabled, true);
}

/* C04：切换总开关让旧任务上下文立即失效，不拿关闭前的绑定继续注入。 */
{
  const dir = mkdir('stale');
  const scope = scopeOf(dir);
  seedRule(scope, '口播开头');
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-stale' }).ok, true);
  const runtime = boot();
  const agent = makeAgent('a-stale', dir);
  const sig = new AbortController().signal;
  await runtime.preStep({ agent, signal: sig, turn: 't1' }, enter(human('这期口播开头怎么改')));
  const held = runtime.debug.windowOf(agent).experiment;
  assert.ok(held && held.contextId);
  toggle(scope, false);
  toggle(scope, true);
  const stale = await runtime.exec('memory_search', { query: '口播开头', contextId: held.contextId }, agent);
  assert.equal(stale.status !== 'ok', true);
  assert.equal((await runtime.exec('memory_search', { query: '口播开头' }, agent)).status, 'ok');
}

console.log('control.test.mjs: all passed');
