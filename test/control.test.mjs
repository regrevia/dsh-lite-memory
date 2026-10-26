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
  const saved = await runtime.exec('memory_save', { title: '关闭后写入', summary: '应当拒绝', body: '不该落盘' }, agent);
  assert.equal(saved.changed, false);
  assert.equal(saved.reason, 'memory_disabled');
  assert.equal(saved.id, '');
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
  assert.equal(run.ok, false);
  assert.equal(run.code, 'memory_disabled');
  assert.equal(store.controlStatus(scope).enabled, false);
}

/* C03：关一个项目不影响另一个；重新打开记忆后自进化仍保持关闭。 */
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
  assert.equal(store.evolutionStatus(scopeB).configuredEnabled, false);
  toggle(scopeB, true);
  assert.equal(store.evolutionStatus(scopeB).enabled, false);
  assert.equal(store.setEvolution(scopeB, true, { operationId: 'evo-b-again' }).ok, true);
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

/* C05：关闭保留候选、试用、结果与整理回执；重开记忆后自进化仍是关闭。 */
{
  const dir = mkdir('preserve');
  const scope = scopeOf(dir);
  const id = seedRule(scope, '口播开头');
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-preserve' }).ok, true);
  const before = store.learningSnapshot(scope);
  assert.equal(before.counts.active, 1);
  assert.equal(toggle(scope, false).ok, true);
  const closed = store.learningSnapshot(scope);
  assert.equal(closed.enabled, false);
  assert.equal(closed.rules.length, before.rules.length);
  assert.equal(closed.counts.active, 1);
  assert.equal(toggle(scope, true).ok, true);
  const reopened = store.learningSnapshot(scope);
  assert.equal(reopened.enabled, false);
  assert.equal(reopened.counts.active, 1);
  assert.equal(store.evolutionStatus(scope).configuredEnabled, false);
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-resume' }).ok, true);
  assert.equal(store.learningSnapshot(scope).counts.active, 1);
  assert.ok(id);
}

/* C06：关闭期间管理面写操作一律拒绝，只读快照不写盘。 */
{
  const dir = mkdir('managed-off');
  const scope = scopeOf(dir);
  const id = seedRule(scope, '口播开头');
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-managed' }).ok, true);
  toggle(scope, false);
  const file = state.stateFiles(scope).current;
  const before = fs.readFileSync(file);
  const snapshot = store.learningSnapshot(scope);
  const rule = snapshot.rules[0];
  assert.equal(rule.id, id);
  assert.equal(Buffer.compare(before, fs.readFileSync(file)), 0);
  for (const action of ['pin', 'pause', 'resume', 'delete', 'undo', 'adopt', 'edit']) {
    let result;
    if (action === 'pin') result = store.pinLearningRule(scope, id, { pinned: true, expectedRevision: rule.revision });
    if (action === 'pause') result = store.pauseLearningRules(scope, [id], { operationId: 'pause-off' });
    if (action === 'resume') result = store.resumeLearningRule(scope, id);
    if (action === 'delete') result = store.removeLearningRule(scope, id, { expectedRevision: rule.revision });
    if (action === 'undo') result = store.undoLearningChange(scope, id, { expectedRevision: rule.revision });
    if (action === 'adopt') result = store.adoptLearningRule(scope, id, { expectedRevision: rule.revision });
    if (action === 'edit') result = store.editLearningRule(scope, id, { expectedRevision: rule.revision, body: '改过的正文' });
    assert.equal(result.ok, false, action);
    assert.equal(result.code, 'memory_disabled', action);
  }
  assert.equal(Buffer.compare(before, fs.readFileSync(file)), 0);
}

/* C07：采纳把候选转为生效；编辑只保存并留上一版，不改状态以外的东西。 */
{
  const dir = mkdir('adopt');
  const scope = scopeOf(dir);
  const id = seedRule(scope, '口播开头');
  const first = store.learningSnapshot(scope).rules[0];
  const edited = store.editLearningRule(scope, id, { expectedRevision: first.revision, body: '开头两句内给结论。', title: '口播结论前置' });
  assert.equal(edited.ok, true);
  const afterEdit = store.learningSnapshot(scope).rules[0];
  assert.equal(afterEdit.state, 'trial');
  assert.equal(afterEdit.body, '开头两句内给结论。');
  assert.equal(afterEdit.title, '口播结论前置');
  assert.equal(afterEdit.learning.versions.length, 1);
  const adopted = store.adoptLearningRule(scope, id, { expectedRevision: afterEdit.revision });
  assert.equal(adopted.ok, true);
  const afterAdopt = store.learningSnapshot(scope).rules[0];
  assert.equal(afterAdopt.state, 'active');
  assert.equal(afterAdopt.body, '开头两句内给结论。');
  assert.equal(afterAdopt.title, '口播结论前置');
}

/* C07b：只改标题不动正文时保留生效状态与学习依据。 */
{
  const dir = mkdir('title-only');
  const scope = scopeOf(dir);
  const id = seedRule(scope, '口播开头');
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === id);
    row.maintenance.learning = { state: 'active', evidence: [{ text: '三次口播都先改开头' }] };
    return { changed: true };
  });
  const first = store.learningSnapshot(scope).rules[0];
  const edited = store.editLearningRule(scope, id, { expectedRevision: first.revision, title: '口播开头重命名' });
  assert.equal(edited.ok, true);
  const after = store.learningSnapshot(scope).rules[0];
  assert.equal(after.state, 'active');
  assert.equal(after.learning.evidence.length, 1);
  assert.equal(after.title, '口播开头重命名');
}

/* C08：关闭保留已消耗额度与默认绑定，重开后仍按原额度限额。 */
{
  const dir = mkdir('preserve-quota');
  const scope = scopeOf(dir);
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-quota' }).ok, true);
  const defaults = { taskKind: 'video', seriesId: '口播' };
  assert.equal(store.saveTaskState(scope, { version: 1, sessions: {}, episodes: {}, defaults, revision: 1 }, { operationId: 'defaults' }).ok, true);
  assert.equal(store.beginLearningAttempt(scope, { episodeId: 'ep-preserve', operationId: 'a1' }).ok, true);
  assert.equal(store.beginLearningAttempt(scope, { episodeId: 'ep-preserve', operationId: 'a2' }).ok, true);
  assert.equal(store.beginLearningAttempt(scope, { episodeId: 'ep-preserve', operationId: 'a3' }).ok, false);
  toggle(scope, false);
  toggle(scope, true);
  assert.deepEqual(store.taskState(scope).defaults, { ...defaults, confirmedBy: 'user', confirmedAt: '' });
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-quota-again' }).ok, true);
  const limited = store.beginLearningAttempt(scope, { episodeId: 'ep-preserve', operationId: 'a4' });
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'episode_limit');
}

/* C09：同一项目两个会话都已准备内容，关闭后两边都立即失效。 */
{
  const dir = mkdir('two-sessions');
  const scope = scopeOf(dir);
  seedRule(scope, '口播开头');
  assert.equal(store.setEvolution(scope, true, { operationId: 'evo-two' }).ok, true);
  const runtime = boot();
  const a1 = makeAgent('two-1', dir);
  const a2 = makeAgent('two-2', dir);
  const sig = new AbortController().signal;
  await runtime.preStep({ agent: a1, signal: sig, turn: 't1' }, enter(human('这期口播开头怎么改')));
  await runtime.preStep({ agent: a2, signal: sig, turn: 't1' }, enter(human('这期口播开头怎么改')));
  assert.match(runtime.text(a1, sig), /口播开头/);
  assert.match(runtime.text(a2, sig), /口播开头/);
  toggle(scope, false);
  assert.equal(runtime.text(a1, sig), '');
  assert.equal(runtime.text(a2, sig), '');
  assert.equal(runtime.debug.preparedOf(a1).text, '');
  assert.equal(runtime.debug.preparedOf(a2).text, '');
}

console.log('control.test.mjs: all passed');
