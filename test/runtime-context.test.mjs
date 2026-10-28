import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-memory-runtime-'));
const { apply } = await import('../index.js');
const store = await import('../store.js');
const state = await import('../state.js');

const effect = (fn) => {
  const dispose = fn();
  return typeof dispose === 'function' ? dispose : () => {};
};

function boot(mode = 'adaptive') {
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
  apply(ctx, { mode });
  const provider = promptContexts.find((entry) => entry.name === 'lite-memory:recall');
  /* CI 冷启动偶尔超过召回耗时上限，逻辑断言不该被「这轮先不注入」判失败。 */
  globalThis.__liteMemoryRecall?.setDeadlineMs?.(5000);
  assert.ok(provider, 'recall provider registered');
  const exec = (name, args, agent) => defs.get(name).execute(args, { agent });
  const preStep = (payload, decision) => handlers.get('agent/pre-step').at(-1)(payload, async () => decision);
  return { defs, provider, exec, preStep, text: (agent, signal) => provider.text({ agent, signal }), debug: globalThis.__liteMemoryRecall };
}

const signal = () => new AbortController().signal;
let seq = 0;
const human = (body) => {
  seq += 1;
  return { role: 'user', id: `msg-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text: body }] };
};
const enter = (...messages) => ({ kind: 'enter', messages });
const mkdir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `lite-memory-runtime-${label}-`));
const makeAgent = (id, dir) => ({ id, cwd: dir, session: { id: `session-${id}`, header: { cwd: dir } } });

const save = (scope, fields) => {
  const result = store.upsert(scope, {
    applicability: fields.applicability ?? ((fields.conditions || []).length ? 'conditional' : 'all_in_scope'),
    body: `正文：${fields.title}`,
    resolution: 'distinct',
    ...fields,
    summary: fields.summary ?? `${fields.title}的摘要`,
  });
  assert.equal(result.ok !== false, true, result.reason);
  return { ...result, id: result.record?.id ?? result.id };
};

const enable = (scope, defaults) => {
  const turned = store.setEvolution(scope, true, { operationId: `op-on-${Math.random().toString(16).slice(2)}` });
  assert.equal(turned.ok, true, turned.reason);
  if (defaults) {
    const applied = store.setTaskDefault(scope, defaults);
    assert.equal(applied.ok, true, applied.reason);
  }
};

const seedRule = (scope, { title, body, summary, conditions = [], learning = { state: 'active' } }) => {
  const saved = save(scope, { title, body, summary, tags: ['实验'] });
  state.transact(scope, {}, (draft) => {
    const row = draft.entries.find((entry) => entry.id === saved.id);
    row.origin = 'project_evolution';
    row.current.conditions = conditions;
    row.maintenance.learning = { ...learning };
    return { changed: true };
  });
  return saved.id;
};

/* R01：自进化关闭时，普通条件记忆照常按当前任务召回，且不会注入实验正文。 */
{
  const dir = mkdir('normal-off');
  const scope = store.scopeOf(dir);
  save(scope, {
    title: '数据库连接池排查顺序',
    body: '先看连接数上限，再看慢查询和泄漏。',
    conditions: [{ key: 'taskKind', value: 'code' }],
    tags: ['数据库'],
  });
  const runtime = boot();
  const agent = makeAgent('r01', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 'r01' }, enter(human('排查 PostgreSQL 连接池报错')));
  const text = runtime.text(agent, sig);
  assert.match(text, /数据库连接池排查顺序/);
  const win = runtime.debug.windowOf(agent);
  assert.equal(win.experiment, null);
  assert.ok(win.runtime && win.runtime.task, 'runtime context exists');
  assert.equal(win.runtime.task.kind, 'code');
  assert.equal(win.runtime.experimental, false);
}

/* R02：明确撤销先于延续；换任务后旧栏目规则不进入本轮。 */
{
  const dir = mkdir('revoke');
  const scope = store.scopeOf(dir);
  enable(scope, { seriesId: '口播', taskKind: 'content' });
  seedRule(scope, {
    title: '口播开头先给结论',
    body: '开场三句内给结论。',
    summary: '口播开头规则',
    conditions: [{ key: 'seriesId', value: '口播' }],
  });
  const runtime = boot();
  const agent = makeAgent('r02', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 'r02' }, enter(human('先不做口播，排查 PostgreSQL 连接池故障')));
  const text = runtime.text(agent, sig);
  assert.doesNotMatch(text, /口播开头先给结论|口播开头规则/);
  const win = runtime.debug.windowOf(agent);
  assert.equal(win.runtime.task.kind, 'code');
  assert.equal(win.runtime.task.seriesId, '');
  assert.ok(win.experiment, 'experiment window is bound to the request');
  assert.equal(win.experiment.decision.kind, 'rules');
  assert.equal(win.experiment.experimentParts, null);
}

/* R03：普通卡片与实验规则共用 3 条 / 1200 字节预算，先到先得、不截断。 */
{
  const dir = mkdir('budget');
  const scope = store.scopeOf(dir);
  enable(scope, { seriesId: '口播', taskKind: 'content' });
  for (let index = 0; index < 4; index += 1) {
    save(scope, {
      title: `口播节奏规范 ${index}`,
      body: `第 ${index} 条正文，说明节奏和停顿。`,
      conditions: [{ key: 'seriesId', value: '口播' }],
      tags: ['口播'],
    });
  }
  for (let index = 0; index < 4; index += 1) {
    seedRule(scope, {
      title: `口播实验规则 ${index}`,
      body: `实验正文 ${index}，开场结论。`,
      summary: `实验规则 ${index}`,
      conditions: [{ key: 'seriesId', value: '口播' }],
    });
  }
  const runtime = boot();
  const agent = makeAgent('r03', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 'r03' }, enter(human('这期口播开头怎么改')));
  const text = runtime.text(agent, sig);
  const win = runtime.debug.windowOf(agent);
  const auto = win.autoBudget;
  assert.ok(auto, 'shared budget exists');
  assert.ok(auto.cards <= 3, `cards ${auto.cards} over cap`);
  assert.ok(auto.cardBytes <= 1200, `bytes ${auto.cardBytes} over cap`);
  assert.ok(auto.experimentBytes <= 1200, 'experiment bytes over cap');
  assert.ok(auto.cardBytes <= 1200);
  assert.ok(Buffer.byteLength(text) <= 1300, 'rendered text exceeds budget');
  assert.equal(auto.totalBytes, Buffer.byteLength(text), '最终交付字节与预算账本一致');
  const held = runtime.debug.preparedOf(agent);
  assert.equal(auto.cards, (auto.normalCards || 0) + (auto.experimentCards || 0), '卡片账本内部一致');
  assert.equal(auto.normalCards || 0, (held?.cards || []).length, '普通卡片数与预算账本一致');
  const heads = new Set(text.split('\n').filter((line) => /口播(节奏规范|实验规则)/.test(line)).map((line) => line.trim()));
  assert.ok(heads.size <= 3, `too many cards: ${heads.size}`);
}

/* R04：普通开关关闭时不再召回，但已有数据仍可被管理面读取。 */
{
  const dir = mkdir('off');
  const scope = store.scopeOf(dir);
  const saved = save(scope, { title: '普通偏好', body: '回复用中文。', tags: ['偏好'] });
  store.setMemoryEnabled(scope, false);
  const runtime = boot();
  const agent = makeAgent('r04', dir);
  const sig = signal();
  await runtime.preStep({ agent, signal: sig, turn: 'r04' }, enter(human('以后回复用什么语言')));
  assert.equal(runtime.text(agent, sig), '');
  const index = store.loadIndex(scope);
  assert.ok(index.entries.some((entry) => entry.id === saved.id));
}

console.log('runtime-context: all passed');
